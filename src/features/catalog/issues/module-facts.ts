import 'server-only';

import type { FieldObservation } from '../types';
import { newItemEnabled, requireNewItemActor } from '../new-item/authorization';
import { newItemRepository } from '../new-item/repository';
import { sourceIdentityEnabled, requireSourceIdentityActor } from '../source-identity/authorization';
import { sourceIdentityRepository } from '../source-identity/repository';
import { classifyCatalogReadFailure } from './entry-state';
import type {
  NewItemModuleFacts,
  NewItemObservationFact,
  SourceIdentityModuleFacts,
  SourceIdentityRecordFact,
  SourceScopeFact,
} from './issue-index';

/**
 * 已启用模块的只读事实读取（R7）。
 *
 * - 只在 `newItemEnabled()` / `sourceIdentityEnabled()` 为真时才访问 N1A/N1C；
 * - 授权走模块既有入口（`requireNewItemActor` / `requireSourceIdentityActor` + 既有 RLS/RPC），
 *   逐范围读取；单个范围无权限或失败只影响该范围的覆盖，不把整页写成 0 项；
 * - 只读取既有 DTO 中已有字段：范围状态、记录状态、观测分类/复核状态/关联来源；不读金额，
 *   不把未授权范围的内容带出。
 */

export type ModuleReadStatus = 'covered' | 'partial' | 'forbidden' | 'unavailable' | 'read_failed' | 'disabled';

export type ModuleRead<T> = {
  status: ModuleReadStatus;
  facts: T | null;
  readScopeCount: number;
  deniedScopeCount: number;
  failedScopeCount: number;
  /** 失败分类（顶层失败时用于 coverage 文案）。 */
  failureKind?: 'forbidden' | 'unavailable' | 'read_failed';
};

function emptyRead<T>(status: ModuleReadStatus): ModuleRead<T> {
  return { status, facts: null, readScopeCount: 0, deniedScopeCount: 0, failedScopeCount: 0 };
}

function summarizeScopeReads(readScopeCount: number, deniedScopeCount: number, failedScopeCount: number): ModuleReadStatus {
  if (readScopeCount > 0) return deniedScopeCount + failedScopeCount > 0 ? 'partial' : 'covered';
  if (failedScopeCount > 0 && deniedScopeCount === 0) return 'read_failed';
  return 'forbidden';
}

function nameHintOf(fields: Record<string, FieldObservation> | undefined): string | null {
  const field = fields?.nameCn;
  if (!field || field.state !== 'observed') return null;
  if (field.meaning === 'explicit_empty' || field.meaning === 'explicit_null') return null;
  const raw = field.raw;
  return typeof raw === 'string' && raw.trim() !== '' ? raw : null;
}

/** N1C：逐范围读取既有新品工作区 DTO，只保留分类/复核/关联与名称摘要。 */
export async function readNewItemModuleFacts(): Promise<ModuleRead<NewItemModuleFacts>> {
  if (!newItemEnabled()) return emptyRead<NewItemModuleFacts>('disabled');
  let actor;
  try {
    actor = await requireNewItemActor();
  } catch (error) {
    const kind = classifyCatalogReadFailure(error);
    return { ...emptyRead<NewItemModuleFacts>(kind === 'unavailable' ? 'unavailable' : kind === 'forbidden' ? 'forbidden' : 'read_failed'), failureKind: kind };
  }
  let scopes;
  try {
    scopes = await newItemRepository.scopes(actor);
  } catch (error) {
    const kind = classifyCatalogReadFailure(error);
    return { ...emptyRead<NewItemModuleFacts>(kind === 'unavailable' ? 'unavailable' : kind === 'forbidden' ? 'forbidden' : 'read_failed'), failureKind: kind };
  }
  const facts: NewItemModuleFacts = { scopes: [], observations: [] };
  let readScopeCount = 0;
  let deniedScopeCount = 0;
  let failedScopeCount = 0;
  for (const scope of scopes) {
    try {
      const workspace = await newItemRepository.read(actor, scope.scopeId);
      if (!workspace.permissions.read) { deniedScopeCount += 1; continue; }
      readScopeCount += 1;
      const scopeFact: SourceScopeFact = {
        scopeId: workspace.scope.scopeId,
        displayName: workspace.scope.displayName,
        system: workspace.scope.system,
        scopeState: workspace.scope.scopeState,
      };
      facts.scopes.push(scopeFact);
      for (const observation of workspace.observations) {
        const observationFact: NewItemObservationFact = {
          observationId: observation.observationId,
          scopeId: scopeFact.scopeId,
          scopeDisplayName: scopeFact.displayName,
          recordPointer: observation.recordPointer,
          nameHint: nameHintOf(observation.fields),
          reviewState: observation.classification?.reviewState ?? null,
          classification: observation.classification?.classification ?? null,
          originItemId: observation.origin?.itemId ?? null,
        };
        facts.observations.push(observationFact);
      }
    } catch (error) {
      if (classifyCatalogReadFailure(error) === 'forbidden') deniedScopeCount += 1;
      else failedScopeCount += 1;
    }
  }
  return {
    status: summarizeScopeReads(readScopeCount, deniedScopeCount, failedScopeCount),
    facts,
    readScopeCount,
    deniedScopeCount,
    failedScopeCount,
  };
}

/** N1A：逐范围读取既有来源身份 DTO，只保留需要处理的记录状态与范围状态。 */
export async function readSourceIdentityModuleFacts(): Promise<ModuleRead<SourceIdentityModuleFacts>> {
  if (!sourceIdentityEnabled()) return emptyRead<SourceIdentityModuleFacts>('disabled');
  let actor;
  try {
    actor = await requireSourceIdentityActor();
  } catch (error) {
    const kind = classifyCatalogReadFailure(error);
    return { ...emptyRead<SourceIdentityModuleFacts>(kind === 'unavailable' ? 'unavailable' : kind === 'forbidden' ? 'forbidden' : 'read_failed'), failureKind: kind };
  }
  let scopes;
  try {
    scopes = await sourceIdentityRepository.scopes(actor);
  } catch (error) {
    const kind = classifyCatalogReadFailure(error);
    return { ...emptyRead<SourceIdentityModuleFacts>(kind === 'unavailable' ? 'unavailable' : kind === 'forbidden' ? 'forbidden' : 'read_failed'), failureKind: kind };
  }
  const facts: SourceIdentityModuleFacts = { scopes: [], records: [] };
  let readScopeCount = 0;
  let deniedScopeCount = 0;
  let failedScopeCount = 0;
  for (const scope of scopes) {
    try {
      const workspace = await sourceIdentityRepository.workspace(actor, scope.scopeId);
      if (!workspace.permissions.read) { deniedScopeCount += 1; continue; }
      readScopeCount += 1;
      const scopeFact: SourceScopeFact = {
        scopeId: workspace.scope.scopeId,
        displayName: workspace.scope.displayName,
        system: workspace.scope.system,
        scopeState: workspace.scope.scopeState,
      };
      facts.scopes.push(scopeFact);
      for (const record of workspace.records) {
        if (record.state !== 'review_required' && record.state !== 'suspended') continue;
        const recordFact: SourceIdentityRecordFact = {
          recordId: record.recordId,
          scopeId: scopeFact.scopeId,
          scopeDisplayName: scopeFact.displayName,
          state: record.state,
          revision: record.revision,
          entityKind: record.entityKind,
        };
        facts.records.push(recordFact);
      }
    } catch (error) {
      if (classifyCatalogReadFailure(error) === 'forbidden') deniedScopeCount += 1;
      else failedScopeCount += 1;
    }
  }
  return {
    status: summarizeScopeReads(readScopeCount, deniedScopeCount, failedScopeCount),
    facts,
    readScopeCount,
    deniedScopeCount,
    failedScopeCount,
  };
}
