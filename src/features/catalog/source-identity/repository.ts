import 'server-only';
import { withAppDb, type DbIdentity } from '@/lib/database/app-db';
import type { IdentityAction, IdentityMutationResult, IdentityWorkspaceDto, SourceScopeDto } from './types';
import { canonicalJson, digest } from './key-codec';

export interface SourceEvidenceServerMetadata {
  evidenceId: string; scopeId: string; sha256: string; size: number; format: string; storageHandle: string;
}
export function sourceIdentityIntent(identity: DbIdentity, scopeId: string, action: IdentityAction, payload: unknown): string {
  return digest(canonicalJson(['iceos-source-request-v1', identity.profileUserId, scopeId, action, payload]));
}
const unknown = () => new Error('IDENTITY_REQUEST_OUTCOME_UNKNOWN');
export const sourceIdentityRepository = {
  scopes(identity: DbIdentity): Promise<SourceScopeDto[]> {
    return withAppDb(identity, async (client) => (await client.query<{ result: SourceScopeDto[] }>('SELECT catalog.identity_scopes() AS result')).rows[0].result);
  },
  workspace(identity: DbIdentity, scopeId: string): Promise<IdentityWorkspaceDto> {
    return withAppDb(identity, async (client) => (await client.query<{ result: IdentityWorkspaceDto }>('SELECT catalog.identity_read($1) AS result', [scopeId])).rows[0].result);
  },
  receipt(identity: DbIdentity, requestId: string, scopeId: string, action: IdentityAction, intent: string): Promise<IdentityMutationResult | null> {
    return withAppDb(identity, async (client) => (await client.query<{ result: IdentityMutationResult | null }>(
      'SELECT catalog.identity_receipt($1,$2,$3,$4) AS result', [requestId, scopeId, action, intent])).rows[0].result);
  },
  async mutate(identity: DbIdentity, requestId: string, scopeId: string, action: IdentityAction, payload: unknown): Promise<IdentityMutationResult> {
    const intent = sourceIdentityIntent(identity, scopeId, action, payload);
    try {
      return await withAppDb(identity, async (client) => (await client.query<{ result: IdentityMutationResult }>(
        'SELECT catalog.identity_mutate($1,$2,$3,$4,$5::jsonb) AS result', [requestId, scopeId, action, intent, JSON.stringify(payload)])).rows[0].result);
    } catch (original) {
      // A real COMMIT may have succeeded before transport lost its acknowledgement.
      // Re-authenticated SQL checks current scope permission, actor and full intent.
      try { const receipt = await this.receipt(identity, requestId, scopeId, action, intent); if (receipt) return receipt; } catch { /* unresolved remains unknown */ }
      const code = original && typeof original === 'object' && 'code' in original ? String(original.code) : '';
      if (!code || code.startsWith('08') || ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', '57P01', '57P02', '57P03'].includes(code)) throw unknown();
      throw original;
    }
  },
  evidence(identity: DbIdentity, evidenceId: string): Promise<SourceEvidenceServerMetadata> {
    return withAppDb(identity, async (client) => (await client.query<{ result: SourceEvidenceServerMetadata }>(
      'SELECT catalog.identity_read_evidence($1) AS result', [evidenceId])).rows[0].result);
  },
  evidenceExport(identity: DbIdentity, evidenceId: string): Promise<unknown> {
    return withAppDb(identity, async (client) => (await client.query<{ result: unknown }>(
      'SELECT catalog.identity_evidence_export($1) AS result', [evidenceId])).rows[0].result);
  },
};
