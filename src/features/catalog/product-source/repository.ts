import 'server-only';
import { createHash } from 'node:crypto';
import { withAppDb, type DbIdentity } from '@/lib/database/app-db';
import { SOURCE_PROFILE_KEY, type SourceCell } from './contract';
import type {
  ApplyReceipt,
  SourceBatchInput,
  SourceIssueDecisionContext,
  SourceIssueRowContext,
  SourceItemStateRaw,
  SourceManualDecisionsRaw,
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
          'SELECT catalog.apply_product_source_batch_v2($1,$2,$3::jsonb,$4::jsonb,$5::jsonb) AS result',
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
  /** 036：当前生效的字段级决定 + 同号多行选择（只读）。 */
  manualDecisions(identity: DbIdentity, profileKey: string): Promise<SourceManualDecisionsRaw> {
    return withAppDb(identity, async (client) => {
      const result = await client.query<{ result: SourceManualDecisionsRaw | null }>(
        'SELECT catalog.read_product_source_manual_decisions($1) AS result',
        [profileKey],
      );
      const value = result.rows[0]?.result;
      return {
        fieldDecisions: Array.isArray(value?.fieldDecisions) ? value.fieldDecisions : [],
        duplicateDecisions: Array.isArray(value?.duplicateDecisions) ? value.duplicateDecisions : [],
      };
    });
  },
  /**
   * 036 人工决定动作的只读上下文：事项本身 + 同批次同货号全部未删除来源行。
   * 行号/哈希/字段只在服务端用于校验与内容指纹，不进入页面 DTO。
   */
  issueDecisionContext(identity: DbIdentity, issueId: string): Promise<SourceIssueDecisionContext | null> {
    return withAppDb(identity, async (client) => {
      const result = await client.query<{
        id: string;
        batch_id: string;
        snapshot_key: string;
        source_key: string;
        issue_kind: string;
        item_id: string | null;
        detail: Record<string, unknown> | null;
        review_state: SourceIssueDecisionContext['reviewState'];
        collection: Record<string, unknown> | null;
        rows: Array<{
          rowNumber: number;
          rowSha256: string | null;
          cells: Record<string, string> | null;
          fields: Record<string, SourceCell> | null;
        }> | null;
      }>(
        `SELECT i.id, i.batch_id, b.snapshot_key, b.collection, i.source_key, i.issue_kind, i.item_id,
                i.detail, i.review_state,
                (SELECT jsonb_agg(jsonb_build_object(
                          'rowNumber', r.row_number,
                          'rowSha256', r.row_sha256,
                          'cells', r.cells,
                          'fields', r.fields) ORDER BY r.row_number)
                 FROM catalog.product_source_row r
                 WHERE r.batch_id = i.batch_id
                   AND r.is_empty = false
                   AND i.source_key LIKE 'code:%'
                   AND r.ice_code_raw = split_part(i.source_key, ':', 2)) AS rows
         FROM catalog.product_source_issue i
         JOIN catalog.product_source_batch b ON b.id = i.batch_id
         JOIN catalog.product_source_profile p ON p.id = b.profile_id
         WHERE i.id = $1 AND p.profile_key = $2`,
        [issueId, SOURCE_PROFILE_KEY],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        issueId: row.id,
        batchId: row.batch_id,
        snapshotKey: row.snapshot_key,
        sourceKey: row.source_key,
        issueKind: row.issue_kind,
        itemId: row.item_id,
        detail: row.detail ?? {},
        reviewState: row.review_state,
        collection: row.collection ?? {},
        rows: (row.rows ?? []).map((entry) => ({
          rowNumber: Number(entry.rowNumber),
          rowSha256: entry.rowSha256 ?? null,
          cells: (entry.cells ?? {}) as Record<string, string>,
          fields: (entry.fields ?? {}) as Record<string, SourceCell>,
        })) satisfies SourceIssueRowContext[],
      };
    });
  },
  /** 036：登记字段级“暂不处理/人工口径”（登记后由数据库关闭当前同类事项）。 */
  async setFieldDecision(
    identity: DbIdentity,
    requestId: string,
    issueId: string,
    action: 'defer' | 'override',
    value: string | null,
    reason: string,
    note: string | null,
  ): Promise<unknown> {
    const actionName = action === 'defer' ? 'defer_source_field' : 'override_source_field';
    const intent = sourceIntent(identity, actionName, { issueId, action, value, reason, note });
    return withAppDb(identity, async (client) => {
      const result = await client.query<{ result: unknown }>(
        'SELECT catalog.set_product_source_field_decision($1,$2,$3,$4,$5,$6,$7) AS result',
        [requestId, intent, issueId, action, value, reason, note],
      );
      return result.rows[0]!.result;
    });
  },
  /** 036：恢复字段级决定（下次读取/应用重新提示）。 */
  async revokeFieldDecision(identity: DbIdentity, requestId: string, decisionId: string, note: string | null): Promise<unknown> {
    const intent = sourceIntent(identity, 'restore_source_field', { decisionId, note });
    return withAppDb(identity, async (client) => {
      const result = await client.query<{ result: unknown }>(
        'SELECT catalog.revoke_product_source_field_decision($1,$2,$3,$4) AS result',
        [requestId, intent, decisionId, note],
      );
      return result.rows[0]!.result;
    });
  },
  /** 036：保存同号多行人工选择（按内容指纹沿用，不按行号）。 */
  async decideDuplicate(
    identity: DbIdentity,
    requestId: string,
    issueId: string,
    chosenRowNumber: number,
    chosenRowSha256: string,
    basisSha256: string,
    evidenceRowSha256: string | null,
    note: string | null,
  ): Promise<unknown> {
    const intent = sourceIntent(identity, 'decide_duplicate_source_row', {
      issueId,
      chosenRowNumber,
      chosenRowSha256,
      basisSha256,
      evidenceRowSha256,
      note,
    });
    return withAppDb(identity, async (client) => {
      const result = await client.query<{ result: unknown }>(
        'SELECT catalog.decide_product_source_duplicate_row($1,$2,$3,$4,$5,$6,$7,$8) AS result',
        [requestId, intent, issueId, chosenRowNumber, chosenRowSha256, basisSha256, evidenceRowSha256, note],
      );
      return result.rows[0]!.result;
    });
  },
  /** 036：撤销同号多行人工选择（下次读取/应用重新提示）。 */
  async revokeDuplicateDecision(identity: DbIdentity, requestId: string, decisionId: string, note: string | null): Promise<unknown> {
    const intent = sourceIntent(identity, 'restore_duplicate_source_decision', { decisionId, note });
    return withAppDb(identity, async (client) => {
      const result = await client.query<{ result: unknown }>(
        'SELECT catalog.revoke_product_source_duplicate_decision($1,$2,$3,$4) AS result',
        [requestId, intent, decisionId, note],
      );
      return result.rows[0]!.result;
    });
  },
};
