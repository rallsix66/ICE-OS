import 'server-only';
import { withAppDb, type DbIdentity } from '@/lib/database/app-db';
import { hashCanonical, projectSafeObservationFields } from './field-projection';
import type { NewItemAction, NewItemMutationResult, NewItemWorkspaceDto, ProductEvidenceMetadata, SensitiveHistoryDto } from './types';
import type { SourceScopeDto } from '../source-identity/types';

export function newItemIntent(identity: DbIdentity, scopeId: string, action: NewItemAction, payload: unknown): string {
  return hashCanonical(['iceos-new-item-request-v1', identity.profileUserId, scopeId, action, payload]);
}
export function uncertainCommit(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  return !code || code.startsWith('08') || ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', '57P01', '57P02', '57P03'].includes(code);
}
export const newItemRepository = {
  scopes(identity: DbIdentity): Promise<SourceScopeDto[]> {
    return withAppDb(identity, async (c) => (await c.query<{ result: SourceScopeDto[] }>('SELECT catalog.identity_scopes() AS result')).rows[0].result);
  },
  read(identity: DbIdentity, scopeId: string, observationId: string | null = null): Promise<NewItemWorkspaceDto> {
    return withAppDb(identity, async (c) => {
      const result = (await c.query<{ result: NewItemWorkspaceDto }>('SELECT catalog.new_item_read($1,$2,$3) AS result', [scopeId, observationId, 'safe'])).rows[0].result;
      return { ...result, observations: result.observations.map((observation) => ({ ...observation, fields: projectSafeObservationFields(observation.fields, observation.observationId) })) };
    });
  },
  history(identity: DbIdentity, scopeId: string, observationId: string | null): Promise<SensitiveHistoryDto> {
    return withAppDb(identity, async (c) => (await c.query<{ result: SensitiveHistoryDto }>('SELECT catalog.new_item_read($1,$2,$3) AS result', [scopeId, observationId, 'sensitive_history'])).rows[0].result);
  },
  receipt(identity: DbIdentity, requestId: string, scopeId: string, action: NewItemAction, intent: string): Promise<NewItemMutationResult | null> {
    return withAppDb(identity, async (c) => (await c.query<{ result: NewItemMutationResult | null }>('SELECT catalog.new_item_receipt($1,$2,$3,$4) AS result', [requestId, scopeId, action, intent])).rows[0].result);
  },
  async mutate(identity: DbIdentity, requestId: string, scopeId: string, action: NewItemAction, payload: unknown): Promise<NewItemMutationResult> {
    const intent = newItemIntent(identity, scopeId, action, payload);
    try {
      return await withAppDb(identity, async (c) => (await c.query<{ result: NewItemMutationResult }>(
        'SELECT catalog.new_item_mutate($1,$2,$3,$4,$5::jsonb) AS result', [requestId, scopeId, action, intent, JSON.stringify(payload)])).rows[0].result);
    } catch (original) {
      try { const result = await this.receipt(identity, requestId, scopeId, action, intent); if (result) return result; } catch { /* current denial cannot prove rollback */ }
      if (uncertainCommit(original)) throw new Error('REQUEST_OUTCOME_UNKNOWN');
      throw original;
    }
  },
  evidence(identity: DbIdentity, id: string): Promise<ProductEvidenceMetadata> {
    return withAppDb(identity, async (c) => (await c.query<{ result: ProductEvidenceMetadata }>('SELECT catalog.new_item_read_evidence($1) AS result', [id])).rows[0].result);
  },
  evidenceExport(identity: DbIdentity, id: string): Promise<unknown> {
    return withAppDb(identity, async (c) => (await c.query<{ result: unknown }>('SELECT catalog.new_item_evidence_export($1) AS result', [id])).rows[0].result);
  },
};
