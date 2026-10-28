import 'server-only';
import { createHash } from 'node:crypto';
import { withAppDb, type DbIdentity } from '@/lib/database/app-db';
import type {
  ApplyReceipt,
  SourceBatchInput,
  SourceItemStateRaw,
  SourceOverviewRaw,
  SourcePlanInput,
  SourceProfileInput,
  StoredRequestIntent,
} from './server-types';

export const PRODUCT_SOURCE_APPLY_ACTION = 'apply_product_source_batch';

/** Same canonical hash contract as the existing new-item/source-identity intents. */
export function sourceIntent(identity: DbIdentity, action: string, payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(['iceos-product-source-request-v1', identity.profileUserId, action, payload])).digest('hex');
}

function uncertainCommit(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  return !code || code.startsWith('08') || ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', '57P01', '57P02', '57P03'].includes(code);
}

export const productSourceRepository = {
  overview(identity: DbIdentity, profileKey: string): Promise<SourceOverviewRaw> {
    return withAppDb(identity, async (client) => {
      const result = await client.query<{ result: SourceOverviewRaw }>('SELECT catalog.read_product_source_overview($1) AS result', [profileKey]);
      return result.rows[0]!.result;
    });
  },
  itemState(identity: DbIdentity, itemId: string): Promise<SourceItemStateRaw | null> {
    return withAppDb(identity, async (client) => {
      const result = await client.query<{ result: SourceItemStateRaw | null }>('SELECT catalog.read_product_source_item_state($1) AS result', [itemId]);
      return result.rows[0]?.result ?? null;
    });
  },
  /** 提交前置记录：保留原请求及完整意图，供“提交结果未知”时按原样核对。 */
  recordIntent(
    identity: DbIdentity,
    requestId: string,
    action: string,
    intent: string,
    profileKey: string,
    snapshotKey: string,
    payload: unknown,
  ): Promise<{ recorded: boolean }> {
    return withAppDb(identity, async (client) => {
      const result = await client.query<{ result: { recorded: boolean } }>(
        `SELECT catalog.record_product_source_request_intent($1,$2,$3,$4,$5,$6::jsonb) AS result`,
        [requestId, intent, action, profileKey, snapshotKey, JSON.stringify(payload)],
      );
      return result.rows[0]!.result;
    });
  },
  readIntent(identity: DbIdentity, requestId: string): Promise<StoredRequestIntent | null> {
    return withAppDb(identity, async (client) => {
      const result = await client.query<{ result: StoredRequestIntent | null }>(
        'SELECT catalog.read_product_source_request_intent($1) AS result',
        [requestId],
      );
      return result.rows[0]?.result ?? null;
    });
  },
  /** 按 requestId 取真实回执（不要求 intent 一致；只用于核对，不用于重放不同意图）。 */
  receiptByRequest(identity: DbIdentity, requestId: string, action: string): Promise<ApplyReceipt | null> {
    return withAppDb(identity, async (client) => {
      const result = await client.query<{ result: ApplyReceipt }>(
        `SELECT result FROM catalog.product_source_request
         WHERE request_id=$1 AND action=$2 AND actor_id=$3`,
        [requestId, action, identity.profileUserId],
      );
      return result.rows[0]?.result ?? null;
    });
  },
  async applyWithIntent(
    identity: DbIdentity,
    requestId: string,
    intent: string,
    profile: SourceProfileInput,
    batch: SourceBatchInput,
    plan: SourcePlanInput,
  ): Promise<ApplyReceipt> {
    try {
      return await withAppDb(identity, async (client) => {
        const result = await client.query<{ result: ApplyReceipt }>(
          'SELECT catalog.apply_product_source_batch($1,$2,$3::jsonb,$4::jsonb,$5::jsonb) AS result',
          [requestId, intent, JSON.stringify(profile), JSON.stringify(batch), JSON.stringify(plan)],
        );
        return result.rows[0]!.result;
      });
    } catch (original) {
      // 超时/连接不确定：只按原 requestId + intent 核对真实回执，绝不重放。
      try {
        const persisted = await this.receipt(identity, requestId, intent, PRODUCT_SOURCE_APPLY_ACTION);
        if (persisted) return persisted;
      } catch { /* 回执读取失败仍属未知，交由调用方保留原请求 */ }
      if (uncertainCommit(original)) throw new Error('CATALOG_REQUEST_OUTCOME_UNKNOWN');
      throw original;
    }
  },
  receipt(identity: DbIdentity, requestId: string, intent: string, action: string): Promise<ApplyReceipt | null> {
    return withAppDb(identity, async (client) => {
      const result = await client.query<{ result: ApplyReceipt }>(
        `SELECT result FROM catalog.product_source_request
         WHERE request_id=$1 AND intent_sha256=$2 AND action=$3 AND actor_id=$4`,
        [requestId, intent, action, identity.profileUserId],
      );
      return result.rows[0]?.result ?? null;
    });
  },
  async apply(
    identity: DbIdentity,
    requestId: string,
    profile: SourceProfileInput,
    batch: SourceBatchInput,
    plan: SourcePlanInput,
  ): Promise<ApplyReceipt> {
    const intent = sourceIntent(identity, PRODUCT_SOURCE_APPLY_ACTION, { profile, batch: batch.snapshotKey, plan });
    return this.applyWithIntent(identity, requestId, intent, profile, batch, plan);
  },
  async resolveIssue(identity: DbIdentity, requestId: string, issueId: string, resolution: 'resolved' | 'ignored', note: string): Promise<unknown> {
    const intent = sourceIntent(identity, 'resolve_product_source_issue', { issueId, resolution, note });
    return withAppDb(identity, async (client) => {
      const result = await client.query<{ result: unknown }>(
        'SELECT catalog.resolve_product_source_issue($1,$2,$3,$4,$5) AS result',
        [requestId, intent, issueId, resolution, note],
      );
      return result.rows[0]!.result;
    });
  },
  async assignCode(identity: DbIdentity, requestId: string, itemId: string, expectedRevision: number, code: string, reason: string, evidence: string): Promise<unknown> {
    const intent = sourceIntent(identity, 'assign_product_source_code', { itemId, expectedRevision, code });
    return withAppDb(identity, async (client) => {
      const result = await client.query<{ result: unknown }>(
        'SELECT catalog.assign_product_source_code($1,$2,$3,$4,$5,$6,$7) AS result',
        [requestId, intent, itemId, expectedRevision, code, reason, evidence],
      );
      return result.rows[0]!.result;
    });
  },
};
