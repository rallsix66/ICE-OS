/**
 * 只读核对原请求回执（V4-04，纯决策函数）。
 *
 * 硬约束：
 * - 只读：本模块只依赖读操作（readReceipt / readOriginKind / readScopedReceipt），
 *   接口里没有、也不允许出现任何写入或重发方法，因此结构上不可能再次提交。
 * - “原请求已保存”只能来自可对应到该 requestId 的真实回执：
 *   - 基线商品：catalog.audit_event(request_id + actor_id) 且 action/商品/版本/intent_sha256 全部一致；
 *   - scoped 新品：catalog.new_item_request(request_id + scope + action + intent) 的真实回执。
 * - 不得用“出现了 expectedRevision+1”替代回执；不得仅凭同商品/同操作者/同种类推断成功。
 * - 没找到回执（no_receipt）不等于“未提交”，不自动重发、不生成新 requestId。
 * - 回执存在但范围/意图不一致返回 scope_mismatch，不猜测、不认领。
 */
import { appendNonPriceRevisionSchema, assignInitialCodeSchema } from './schema';
import type { CatalogRequestKind, CatalogRequestOutcome } from './types';

export type CatalogRequestOutcomeInput =
  | ({ kind: 'initial_code' } & ReturnType<typeof assignInitialCodeSchema.parse>)
  | ({ kind: 'nonprice_revision' } & ReturnType<typeof appendNonPriceRevisionSchema.parse>);

/** catalog.audit_event 中按 request_id + actor_id 读到的回执（只读投影）。 */
export interface CatalogRequestReceipt {
  action: string;
  itemId: string | null;
  /** 服务端写入时保存的原意图哈希；必须与本次请求的完整输入重算结果一致。 */
  intentSha256: string | null;
  result: unknown;
}

/** scoped 新品的真实请求回执（catalog.new_item_request，由 RPC 校验 actor/scope/action/intent）。 */
export interface CatalogScopedReceipt {
  itemId: string | null;
  result: unknown;
}

/** 只读依赖：实现方只能提供读操作。 */
export interface CatalogRequestOutcomeDeps {
  actorId: string;
  /** 由服务端用本次完整入参重新计算的 audit_event intent_sha256；客户端不能自报。 */
  expectedBaselineIntent: string;
  readReceipt: (requestId: string) => Promise<CatalogRequestReceipt | null>;
  readOriginKind: (itemId: string) => Promise<'baseline' | 'new_item' | null>;
  readScopedReceipt: (input: CatalogRequestOutcomeInput) => Promise<CatalogScopedReceipt | null>;
}

export const REQUEST_ACTION_BY_KIND: Record<CatalogRequestKind, string> = {
  initial_code: 'assign_initial_code',
  nonprice_revision: 'append_nonprice_revision',
};

/** 中文业务动作名；不把内部 action key 回传客户端。 */
export const REQUEST_ACTION_LABEL: Record<CatalogRequestKind, string> = {
  initial_code: '首次货号分配',
  nonprice_revision: '非价格资料修订',
};

const UUID_PATTERN = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;

export function isCatalogRequestKind(value: unknown): value is CatalogRequestKind {
  return value === 'initial_code' || value === 'nonprice_revision';
}

/**
 * 严格校验客户端入参；完整原意图（fields/code/reason/expectedRevision）全部进入校验，
 * 非法输入直接拒绝（不查库、不泄露任何状态）。
 */
export function parseRequestOutcomeInput(input: unknown): CatalogRequestOutcomeInput {
  if (typeof input !== 'object' || input === null) throw new Error('CATALOG_INVALID_INPUT');
  const raw = input as Record<string, unknown>;
  const kind = raw.kind;
  if (!isCatalogRequestKind(kind)) throw new Error('CATALOG_INVALID_INPUT');
  const rest = { ...raw };
  delete rest.kind;
  const parsed = kind === 'initial_code'
    ? assignInitialCodeSchema.safeParse(rest)
    : appendNonPriceRevisionSchema.safeParse(rest);
  if (!parsed.success) throw new Error('CATALOG_INVALID_INPUT');
  if (typeof parsed.data.itemId !== 'string' || !UUID_PATTERN.test(parsed.data.itemId)) throw new Error('CATALOG_INVALID_INPUT');
  if (typeof parsed.data.requestId !== 'string' || !UUID_PATTERN.test(parsed.data.requestId)) throw new Error('CATALOG_INVALID_INPUT');
  return { kind, ...parsed.data } as CatalogRequestOutcomeInput;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : null;
}

/** 回执存储结果里的落库版本；不可解析时为 null（不能猜）。 */
export function appliedRevisionFromReceipt(receipt: { result: unknown }): number | null {
  if (typeof receipt.result !== 'object' || receipt.result === null) return null;
  return positiveInteger((receipt.result as { revision?: unknown }).revision);
}

function applied(kind: CatalogRequestKind, revision: number): CatalogRequestOutcome {
  return { status: 'applied', revision, actionLabel: REQUEST_ACTION_LABEL[kind] };
}

function noReceipt(): CatalogRequestOutcome {
  return { status: 'no_receipt', revision: null, actionLabel: null };
}

function scopeMismatch(): CatalogRequestOutcome {
  return { status: 'scope_mismatch', revision: null, actionLabel: null };
}

function receiptMatchesBaseline(
  receipt: CatalogRequestReceipt,
  input: CatalogRequestOutcomeInput,
  expectedAction: string,
  expectedIntent: string,
): boolean {
  if (receipt.action !== expectedAction) return false;
  if (receipt.itemId !== input.itemId) return false;
  if (!receipt.intentSha256 || receipt.intentSha256 !== expectedIntent) return false;
  return appliedRevisionFromReceipt(receipt) === input.expectedRevision + 1;
}

/**
 * 决策：先区分基线/scoped；两者都只认与 requestId 对应的真实回执。
 * 全程只读，不重发、不写任何表。
 */
export async function resolveCatalogRequestOutcome(
  deps: CatalogRequestOutcomeDeps,
  input: CatalogRequestOutcomeInput,
): Promise<CatalogRequestOutcome> {
  const expectedAction = REQUEST_ACTION_BY_KIND[input.kind];
  const originKind = await deps.readOriginKind(input.itemId);

  if (originKind === 'new_item') {
    /* scoped 写入只在 catalog.new_item_request 留回执；RPC 已按 request+scope+action+intent 核对，
       这里再要求落库商品与版本 = expectedRevision+1，防止另一请求的回执被认领。 */
    const scoped = await deps.readScopedReceipt(input);
    if (!scoped) return noReceipt();
    if (scoped.itemId !== null && scoped.itemId !== input.itemId) return scopeMismatch();
    const revision = appliedRevisionFromReceipt(scoped);
    if (revision === null || revision !== input.expectedRevision + 1) return scopeMismatch();
    return applied(input.kind, revision);
  }

  const receipt = await deps.readReceipt(input.requestId);
  if (!receipt) return noReceipt();
  if (!receiptMatchesBaseline(receipt, input, expectedAction, deps.expectedBaselineIntent)) return scopeMismatch();
  return applied(input.kind, input.expectedRevision + 1);
}
