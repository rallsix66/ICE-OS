import 'server-only';

import type { FieldObservation } from '../types';
import { requireCatalogAdmin } from '../authorization';
import { CATALOG_FIELD_LABELS } from '../local-display/field-labels';
import { newItemEnabled, requireNewItemActor } from '../new-item/authorization';
import { newItemRepository } from '../new-item/repository';
import { FIELD_GROUPS, ISSUE_KIND_LABELS } from '../product-source/contract';
import { SOURCE_PROFILE, readPendingSourceCodeCandidates, type PendingSourceCodeCandidate } from '../product-source/service';
import { resolveSpecification } from '../specification';
import { sourceIdentityEnabled, requireSourceIdentityActor } from '../source-identity/authorization';
import { sourceIdentityRepository } from '../source-identity/repository';
import { classifyCatalogReadFailure } from './entry-state';
import type {
  NewItemModuleFacts,
  NewItemObservationFact,
  ProductSourceIssueFact,
  ProductSourceModuleFacts,
  SourceIdentityModuleFacts,
  SourceIdentityRecordFact,
  SourceScopeFact,
} from './issue-index';
import { readProductSourceIssueRows, type ProductSourceIssueRow } from './repository';

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

/* ------------------------------------------------------------------ *
 * 飞书商品资料：来源待核对事项（每日入口的「待处理」投影）
 * ------------------------------------------------------------------ */

function positiveIntArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const result: number[] = [];
  for (const entry of value) {
    const parsed = typeof entry === 'number' ? entry : Number(entry);
    if (Number.isInteger(parsed) && parsed > 0) result.push(parsed);
  }
  return result;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/** 待处理页使用的业务字段名：去掉“字符串”等技术注释，缺码字段统一称“正式货号”。 */
const ISSUE_FIELD_LABEL_OVERRIDES: Record<string, string> = {
  iceCode: '正式货号',
};

function issueFieldLabel(key: string): string {
  return ISSUE_FIELD_LABEL_OVERRIDES[key] ?? CATALOG_FIELD_LABELS[key] ?? '其他资料字段';
}

/** 从既有 issue detail 中取问题字段的中文标签（不猜测、不自行解析来源值）。 */
function productSourceFieldLabels(detail: Record<string, unknown>): string[] {
  const keys = new Set<string>();
  if (typeof detail.fieldKey === 'string') keys.add(detail.fieldKey);
  for (const key of stringArray(detail.fieldKeys)) keys.add(key);
  if (Array.isArray(detail.fields)) {
    for (const entry of detail.fields) {
      if (typeof entry === 'string') {
        keys.add(entry);
        continue;
      }
      if (entry && typeof entry === 'object') {
        const fieldKey = (entry as Record<string, unknown>).fieldKey;
        if (typeof fieldKey === 'string') keys.add(fieldKey);
      }
    }
  }
  const labels = new Set<string>();
  for (const key of keys) labels.add(issueFieldLabel(key));
  if (typeof detail.group === 'string') {
    const groupFields = FIELD_GROUPS[detail.group as keyof typeof FIELD_GROUPS];
    if (groupFields) {
      for (const key of groupFields) labels.add(issueFieldLabel(key));
    }
  }
  return [...labels];
}

/** 同号多行的逐字段差异：只投影既有 detail.fields 的行号与来源原值，不猜、不合并。 */
function productSourceDuplicateFields(detail: Record<string, unknown>): NonNullable<ProductSourceIssueFact['duplicate']> | null {
  if (!Array.isArray(detail.fields)) return null;
  const fields: NonNullable<ProductSourceIssueFact['duplicate']>['fields'] = [];
  for (const entry of detail.fields) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const fieldKey = typeof record.fieldKey === 'string' ? record.fieldKey : null;
    if (!fieldKey || !Array.isArray(record.values)) continue;
    const values: Array<{ rowNumber: number; value: string; empty: boolean }> = [];
    for (const value of record.values) {
      if (!value || typeof value !== 'object') continue;
      const item = value as Record<string, unknown>;
      const rowNumber = typeof item.rowNumber === 'number' ? item.rowNumber : Number(item.rowNumber);
      if (!Number.isInteger(rowNumber) || rowNumber <= 0) continue;
      const state = typeof item.state === 'string' ? item.state : '';
      const raw = typeof item.raw === 'string' ? item.raw : item.raw == null ? '' : String(item.raw);
      const empty = state === 'explicit_empty' || state === 'explicit_null' || raw.trim() === '';
      values.push({ rowNumber, value: raw.trim(), empty });
    }
    if (values.length > 0) fields.push({ fieldLabel: issueFieldLabel(fieldKey), values });
  }
  return fields.length > 0 ? { fields } : null;
}

function toProductSourceIssueFact(
  row: ProductSourceIssueRow,
  pendingCodeCandidates: Map<string, PendingSourceCodeCandidate>,
): ProductSourceIssueFact {
  const rowNumbers = positiveIntArray(row.detail.rowNumbers);
  const pendingCode = row.detail.pendingCode === true;
  const candidate = row.itemId ? (pendingCodeCandidates.get(row.itemId) ?? null) : null;
  // 规格：商品「规格」字段优先；缺失时从标准名称提取；都没有才显示「规格未填写」。
  const specificationText = resolveSpecification({
    specificationText: row.specificationRaw,
    nameCn: row.nameCn,
  }).text;
  return {
    issueId: row.issueId,
    iceCode: row.iceCode,
    nameCn: row.nameCn,
    kind: row.issueKind,
    kindLabel: (ISSUE_KIND_LABELS as Readonly<Record<string, string>>)[row.issueKind] ?? '来源待核对',
    itemId: row.itemId,
    itemRevision: row.itemRevision,
    specificationText,
    rows: rowNumbers.length > 0 ? rowNumbers : positiveIntArray(row.detail.rows),
    fieldLabels: productSourceFieldLabels(row.detail),
    duplicate: row.issueKind === 'duplicate_code_inconsistent' ? productSourceDuplicateFields(row.detail) : null,
    pendingCode,
    sourceCodeCandidate: candidate
      && (pendingCode || row.issueKind === 'missing_code' || row.issueKind === 'missing_code_candidate')
      ? {
        sourceCode: candidate.sourceCode,
        rowNumbers: candidate.rowNumbers,
        capturedAtDisplay: candidate.capturedAtDisplay,
      }
      : null,
  };
}

/**
 * 飞书商品资料待核对事项：只读既有 open 事项，投影为「待处理」事项。
 * - 来源表未安装（42P01/42P02）→ disabled，不写成 0 项；
 * - 无权限/未启用/读取失败 → 分别标记，仍不写成 0 项；
 * - 只读：不关闭事项、不标记已处理、不改写商品资料。
 */
export async function readProductSourceModuleFacts(): Promise<ModuleRead<ProductSourceModuleFacts>> {
  let identity;
  try {
    identity = await requireCatalogAdmin();
  } catch (error) {
    const kind = classifyCatalogReadFailure(error);
    return {
      ...emptyRead<ProductSourceModuleFacts>(kind === 'unavailable' ? 'unavailable' : kind === 'forbidden' ? 'forbidden' : 'read_failed'),
      failureKind: kind,
    };
  }
  let rows: ProductSourceIssueRow[];
  try {
    rows = await readProductSourceIssueRows(identity);
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code ?? '')
      : '';
    if (code === '42P01' || code === '42P02') return emptyRead<ProductSourceModuleFacts>('disabled');
    const kind = classifyCatalogReadFailure(error);
    return {
      ...emptyRead<ProductSourceModuleFacts>(kind === 'unavailable' ? 'unavailable' : kind === 'forbidden' ? 'forbidden' : 'read_failed'),
      failureKind: kind,
    };
  }
  // 最新待应用快照已读到的候选货号：只读接到原商品，不写事项、不要求先采用整批。
  // 读取失败只影响候选展示，不影响既有事项清单。
  const pendingCandidates = await readPendingSourceCodeCandidates().catch(() => new Map<string, PendingSourceCodeCandidate>());
  // 同一商品已有 item 级缺号待办时，不再重复显示同商品的 batch 级缺码候选事项。
  const itemLevelMissing = new Set(
    rows
      .filter((row) => row.issueKind === 'missing_code' && row.itemId)
      .map((row) => row.itemId as string),
  );
  const visibleRows = rows.filter((row) => !(
    row.issueKind === 'missing_code_candidate'
    && row.itemId !== null
    && itemLevelMissing.has(row.itemId)
  ));
  return {
    status: 'covered',
    facts: {
      sourceLabel: `${SOURCE_PROFILE.displayName} · ${SOURCE_PROFILE.sheetName}`,
      sourceHref: SOURCE_PROFILE.sourceUrl,
      issues: visibleRows.map((row) => toProductSourceIssueFact(row, pendingCandidates)),
    },
    readScopeCount: 1,
    deniedScopeCount: 0,
    failedScopeCount: 0,
  };
}
