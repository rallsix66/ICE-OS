/**
 * 商品更新回执的「唯一一套数字」文案（纯函数，无 server-only / 无 IO）。
 *
 * 页面只在数据库回执 counts 存在时调用它渲染一套数字；
 * 服务端 message 只作状态说明，不再内嵌任何计数，避免出现第二套数字。
 */
export interface ReceiptSentenceCounts {
  unchanged: number;
  needsReview: number;
  failed: number;
  missing: number;
}

export interface ReceiptSentenceInput {
  /** 数据库回执计数；缺失时为 null/undefined，调用方不渲染数字。 */
  counts: ReceiptSentenceCounts | null | undefined;
  /** 实际写入的商品数；缺失时显示「—」，不得用 created+updated 估算。 */
  writtenItems: number | null | undefined;
  /** 实际写入中仍为 needs_review 的条数；为 0/缺失时省略该分句。 */
  writtenNeedsReview?: number | null;
  /** 数据库实际回执状态：partial 时页面先说明「已确认的变更已写入，待核对字段保留原值」。 */
  status?: string | null;
}

/**
 * 部分完成时固定的一句：已确认的字段确实写入了（含只写入名称、其它字段待核对的商品），
 * 未确认的字段保持原值，不回滚已写入部分。
 */
export const PARTIAL_WRITTEN_NOTICE = '已确认的变更已写入，待核对字段保留原值。';

function finiteNumberOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * 生成单句真实回执，例如：
 * `已写入 7 款，其中 6 款已写入确认字段、另有字段待核对；无变化 26 款；待核对 101 款；失败 0 款。`
 *
 * 所有数字全部来自参数（唯一来源是数据库回执），本函数不写死任何业务样例；
 * `writtenItems` 含「部分字段已写入、其余字段待核对」的商品，因此同一款商品可以
 * 已经更新名称、同时又出现在 writtenNeedsReview 里。
 */
export function receiptSentence(input: ReceiptSentenceInput): string | null {
  const { counts } = input;
  if (!counts) return null;
  const written = finiteNumberOrNull(input.writtenItems);
  const writtenNeedsReview = finiteNumberOrNull(input.writtenNeedsReview);
  let sentence = `已写入 ${written === null ? '—' : written} 款`;
  if (writtenNeedsReview !== null && writtenNeedsReview > 0) {
    sentence += `，其中 ${writtenNeedsReview} 款已写入确认字段、另有字段待核对`;
  }
  sentence += `；无变化 ${counts.unchanged} 款；待核对 ${counts.needsReview} 款；失败 ${counts.failed} 款`;
  if (counts.missing > 0) sentence += `；本次未见 ${counts.missing} 款`;
  return `${sentence}。`;
}
