/**
 * 「操作记录」页面模型（纯函数：URL 解析、分页、动作文案、已保存依据的展示投影）。
 *
 * 原则：
 * - 这里只把服务端 042 只读函数返回的**已保存字段**翻成中文，不做任何当前值反推；
 * - 历史行没有保存的内容显示「历史未保存 / 未提供」，不补 0、不猜；
 * - 字段差异按新旧版本字段键并集展示：新增 / 修改 / 删除；
 * - 记录账号 = 记录行上的 actor_id 显示名，不推断具体操作人。
 */
import { receiptSentence } from '@/features/catalog/product-source/receipt-copy';
import { manualStatusLabel } from '@/features/shipment/model';
import type { OperationCategory, OperationCategoryFilter, OperationRecordDto } from './types';

export const OPERATION_PAGE_SIZE = 50;
export const OPERATION_MAX_SEARCH_LENGTH = 80;
export const OPERATION_ITEM_CHUNK = 20;
const SHANGHAI_OFFSET = '+08:00';
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OperationQueryState {
  category: OperationCategoryFilter;
  /** '' = 全部账号 */
  actor: string;
  /** 'YYYY-MM-DD'（+08 自然日），'' = 不限 */
  from: string;
  to: string;
  q: string;
  page: number;
}

export const DEFAULT_OPERATION_QUERY: OperationQueryState = {
  category: 'all',
  actor: '',
  from: '',
  to: '',
  q: '',
  page: 1,
};

export const OPERATION_CATEGORY_OPTIONS: Array<{ value: OperationCategoryFilter; label: string }> = [
  { value: 'all', label: '全部业务' },
  { value: 'catalog', label: '商品资料' },
  { value: 'inventory', label: '库存对应' },
  { value: 'shipment', label: '物流' },
];

export function operationCategoryLabel(category: OperationCategory): string {
  if (category === 'catalog') return '商品资料';
  if (category === 'inventory') return '库存对应';
  return '物流';
}

/**
 * 类别标签上的计数：查询失败/日期无效时传 null → 显示「—」（没读到 ≠ 0 条）；
 * 成功查询且确实为 0 → 显示「0 条」。
 */
export function operationCategoryCountLabel(count: number | null): string {
  if (count === null) return '—';
  const safe = Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0;
  return `${safe} 条`;
}

/** 「全部业务」= 其他筛选条件下三类计数之和；任一类缺失视为没读到（null）。 */
export function operationCategoryTotal(
  counts: Partial<Record<OperationCategory, number>> | null | undefined,
): number | null {
  if (!counts) return null;
  const values = [counts.catalog, counts.inventory, counts.shipment];
  if (values.some((value) => typeof value !== 'number' || !Number.isFinite(value))) return null;
  return (values as number[]).reduce((sum, value) => sum + Math.max(0, Math.trunc(value)), 0);
}

function validDateValue(value: string): string {
  if (!DATE_PATTERN.test(value)) return '';
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toISOString().slice(0, 10) === value ? value : '';
}

function normalizePage(raw: number): number {
  if (!Number.isFinite(raw)) return 1;
  return Math.max(1, Math.min(Math.trunc(raw), 100000));
}

export function parseOperationSearchParams(params: URLSearchParams): OperationQueryState {
  const categoryRaw = (params.get('cat') ?? '').trim().toLowerCase();
  const category: OperationCategoryFilter = categoryRaw === 'catalog' || categoryRaw === 'inventory' || categoryRaw === 'shipment'
    ? categoryRaw
    : 'all';
  const actorRaw = (params.get('actor') ?? '').trim();
  return {
    category,
    actor: UUID_PATTERN.test(actorRaw) ? actorRaw : '',
    from: validDateValue((params.get('from') ?? '').trim()),
    to: validDateValue((params.get('to') ?? '').trim()),
    q: (params.get('q') ?? '').trim().slice(0, OPERATION_MAX_SEARCH_LENGTH),
    page: normalizePage(Number(params.get('page') ?? '1')),
  };
}

/**
 * 日期筛选边界：start 为当日 00:00(+08)，end 为结束日的次日 00:00(+08)（不含）。
 * 开始晚于结束时返回 invalid=true，页面提示后不查询。
 */
export function operationDateBounds(state: Pick<OperationQueryState, 'from' | 'to'>): {
  from: string | null;
  to: string | null;
  invalid: boolean;
} {
  const invalid = Boolean(state.from && state.to && state.from > state.to);
  if (invalid) return { from: null, to: null, invalid: true };
  const from = state.from ? `${state.from}T00:00:00${SHANGHAI_OFFSET}` : null;
  let to: string | null = null;
  if (state.to) {
    const next = new Date(`${state.to}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    to = `${next.toISOString().slice(0, 10)}T00:00:00${SHANGHAI_OFFSET}`;
  }
  return { from, to, invalid: false };
}

/** 由当前状态构造 URL；省略默认值，便于复制与返回。 */
export function buildOperationHref(state: OperationQueryState, patch: Partial<OperationQueryState> = {}): string {
  const next = { ...state, ...patch };
  const params = new URLSearchParams();
  if (next.category !== 'all') params.set('cat', next.category);
  if (next.actor) params.set('actor', next.actor);
  if (next.from) params.set('from', next.from);
  if (next.to) params.set('to', next.to);
  if (next.q) params.set('q', next.q);
  if (next.page > 1) params.set('page', String(next.page));
  const query = params.toString();
  return query ? `/dashboard/operations?${query}` : '/dashboard/operations';
}

export interface OperationPageRange {
  from: number;
  to: number;
  total: number;
  page: number;
  pageCount: number;
  hasPrev: boolean;
  hasNext: boolean;
}

export function operationPageRange(total: number, limit: number, page: number): OperationPageRange {
  const size = Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : OPERATION_PAGE_SIZE;
  const safeTotal = Number.isFinite(total) && total > 0 ? Math.trunc(total) : 0;
  const pageCount = Math.max(1, Math.ceil(safeTotal / size));
  const current = Math.min(normalizePage(page), pageCount);
  return {
    from: safeTotal === 0 ? 0 : (current - 1) * size + 1,
    to: safeTotal === 0 ? 0 : Math.min(current * size, safeTotal),
    total: safeTotal,
    page: current,
    pageCount,
    hasPrev: current > 1,
    hasNext: current < pageCount,
  };
}

/* ------------------------------------------------------------------ *
 * 动作与结果文案
 * ------------------------------------------------------------------ */

const ACTION_LABELS: Record<string, string> = {
  source_batch_applied: '来源资料采用',
  assign_source_code: '补录正式货号',
  assign_initial_code: '初始补录货号',
  correct_test_source_code: '纠正测试货号',
  resolve_source_issue: '关闭来源缺货号事项',
  duplicate_source_decision: '选择来源资料行',
  duplicate_source_decision_revoked: '撤销来源行选择',
  field_decision: '来源字段人工口径',
  source_field_decision_revoked: '撤销字段人工口径',
  item_revision: '商品资料修改',
  item_baseline: '商品资料首版',
  inventory_confirm: '确认商品对应',
  inventory_rebind: '更换绑定（换绑商品对应）',
  recheck_inventory_mapping: '重核商品对应',
  disable_inventory_mapping: '停用商品对应',
  replace_inventory_mapping: '更换绑定（原 SKU 替换）',
  domestic_review_decision: '国内复核采用商品对应',
  shipment_association_manual: '人工关联商品',
  shipment_association_cleared: '清除商品关联',
  shipment_manual_correction: '人工修正数量/状态',
  shipment_manual_restore: '恢复按原表判断',
  shipment_grouping_decision: '分合票人工决定',
  shipment_grouping_revoked: '撤销分合票人工决定',
};

export function operationActionLabel(action: string): string {
  return ACTION_LABELS[action] ?? '业务处理';
}

export function operationActionTone(action: string): 'neutral' | 'green' | 'amber' | 'red' | 'blue' {
  if (action === 'shipment_grouping_revoked' || action === 'correct_test_source_code') return 'amber';
  if (action === 'source_field_decision_revoked' || action === 'duplicate_source_decision_revoked') return 'amber';
  if (action === 'disable_inventory_mapping' || action === 'shipment_association_cleared') return 'red';
  if (action === 'source_batch_applied' || action === 'item_baseline' || action === 'item_revision') return 'blue';
  if (action === 'inventory_rebind' || action === 'replace_inventory_mapping' || action === 'domestic_review_decision') return 'green';
  return 'neutral';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}
function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
/** 数字/布尔也转成展示文本（用于历史行里的 version、数量等数值字段）。 */
function asText(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? '是' : '否';
  return asString(value);
}

const MANUAL_STATUS_VALUES = ['in_transit', 'arrived_pending_shelving', 'fully_shelved', 'partial_shelved', 'unknown'] as const;
type ManualStatusValue = typeof MANUAL_STATUS_VALUES[number];

/** 人工修正状态：只接受物流页已有的 5 个值；其它值原样显示，不猜含义。 */
function manualStatusText(value: string | null): string {
  if (!value) return '未记录';
  return (MANUAL_STATUS_VALUES as readonly string[]).includes(value)
    ? manualStatusLabel(value as ManualStatusValue)
    : value;
}

function detailOf(record: OperationRecordDto): Record<string, unknown> {
  return asRecord(record.detail) ?? {};
}

/** 已保存的原始值显示：空值如实写「未填写」，缺失写空。 */
export function operationRawText(raw: unknown, emptyText = '未填写'): string {
  if (raw === null || raw === undefined) return emptyText;
  if (typeof raw === 'string') return raw.trim() === '' ? emptyText : raw;
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  return JSON.stringify(raw);
}

function actorRecordName(record: OperationRecordDto): string {
  return record.actorName ?? '未记录账号';
}

const FIELD_LABELS: Record<string, string> = {
  nameCn: '中文名称',
  englishName: '英文名称',
  iceCode: '正式货号',
  barcode: '商品条码',
  specification: '规格',
  factory: '生产工厂',
  sourceDate: '来源日期',
  sourceNote: '来源备注',
  unitVolume: '单瓶立方',
  unitWeight: '单件重量',
  cartonWidth: '箱宽',
  cartonHeight: '箱高',
  cartonLength: '箱长',
  cartonVolume: '箱体积',
  cartonWeight: '箱重',
  cartonQuantity: '装箱数量',
  shippingDays: '运输时间',
  shelfLifeDays: '保质期',
  factoryLeadDays: '工厂交期',
  width: '宽',
  height: '高',
  length: '长',
  liquid: '是否液体',
  imageRef: '图片引用',
};

export function operationFieldLabel(fieldKey: string): string {
  return FIELD_LABELS[fieldKey] ?? fieldKey;
}

const GROUPING_KIND_LABELS: Record<string, string> = {
  split: '拆票复核',
  merge: '合票复核',
};

/** 与物流在途页同一套决定文案（shipment/grouping.ts）；这里只做展示，不重复机制说明。 */
const GROUPING_DECISION_LABELS: Record<string, string> = {
  split_confirmed: '确实拆开',
  keep_one: '仍是一票',
  merge_confirmed: '确实合成一票',
  keep_separate: '仍然分开',
  restored: '恢复按飞书判断',
};

const FIELD_ACTION_LABELS: Record<string, string> = {
  defer: '暂不处理',
  override: '人工覆盖',
  interpret: '人工解释',
  restore: '恢复来源值',
};

/** 记录的「结果」一句话：只用已保存的计数/状态/前值。 */
export function operationResultText(record: OperationRecordDto): string {
  const detail = detailOf(record);
  switch (record.action) {
    case 'source_batch_applied': {
      const counts = asRecord(detail.counts) ?? {};
      const results = asArray(detail.results).map((entry) => asRecord(entry)).filter(Boolean) as Array<Record<string, unknown>>;
      const writtenItems = results.filter((entry) => asText(entry.itemRevision) !== null).length;
      const writtenNeedsReview = results.filter((entry) => (
        asString(entry.action) === 'needs_review' && asText(entry.itemRevision) !== null)).length;
      const sentence = receiptSentence({
        counts: {
          unchanged: asNumber(counts.unchanged) ?? 0,
          needsReview: asNumber(counts.needsReview) ?? 0,
          failed: asNumber(counts.failed) ?? 0,
          missing: asNumber(counts.missing) ?? 0,
        },
        writtenItems,
        writtenNeedsReview,
        status: asString(detail.status),
      });
      return sentence ?? '本批结果没有保存数量。';
    }
    case 'assign_source_code':
    case 'assign_initial_code':
    case 'correct_test_source_code': {
      const result = asRecord(detail.result) ?? {};
      const code = asString(result.iceCode) ?? record.iceCode;
      const removed = asString(result.removedCode);
      if (record.action === 'correct_test_source_code') {
        return removed
          ? `撤销测试货号 ${removed}，该商品恢复为「货号待确认」。`
          : '撤销测试货号，该商品恢复为「货号待确认」。';
      }
      return code ? `写入正式货号 ${code}（商品版本 ${asText(result.revision) ?? '未保存'}）。` : '已写入货号（结果未保存货号值）。';
    }
    case 'resolve_source_issue': {
      const result = asRecord(detail.result) ?? {};
      const kind = asString(result.issueKind) ?? '来源事项';
      const sourceKey = asString(result.sourceKey);
      return `关闭来源事项（${kind}${sourceKey ? `，${sourceKey}` : ''}）。`;
    }
    case 'duplicate_source_decision': {
      const state = asString(detail.state);
      const row = asNumber(detail.chosenRowNumber);
      if (state === 'superseded' || state === 'revoked') {
        const at = formatOperationTime(asString(detail.supersededAt));
        return `这条来源行选择${at ? `已于 ${at} 被撤销` : '已被撤销'}；原决定仍保留在这里。`;
      }
      return row ? `已选择来源第 ${row} 行资料，后续更新按这一行采用。` : '已保存来源资料行选择。';
    }
    case 'duplicate_source_decision_revoked': {
      const row = asNumber(detail.chosenRowNumber);
      const known = detail.revokedByAccount === true;
      if (!known) return row ? `原来源第 ${row} 行选择已被后续选择替代。` : '原来源行选择已被后续选择替代。';
      return row ? `撤销来源第 ${row} 行选择；同号多行重新回到待处理。` : '撤销来源行选择；同号多行重新回到待处理。';
    }
    case 'field_decision': {
      const action = asString(detail.action) ?? '';
      const field = operationFieldLabel(asString(detail.fieldKey) ?? '');
      const state = asString(detail.state);
      const label = FIELD_ACTION_LABELS[action] ?? '人工处理';
      const revokedAt = formatOperationTime(asString(detail.revokedAt));
      return `${label}：${field}${state === 'revoked' ? `（已于 ${revokedAt || '未保存时间'} 撤销）` : ''}。`;
    }
    case 'source_field_decision_revoked': {
      const field = operationFieldLabel(asString(detail.fieldKey) ?? '');
      const note = asString(detail.revokedNote);
      return `撤销「${field}」的人工口径${note ? `：${note}` : '，恢复按来源值解释'}。`;
    }
    case 'item_baseline':
      return '建立商品资料首版；没有上一版本，无法对比前值。';
    case 'item_revision': {
      const revision = asNumber(detail.revision);
      const reason = asString(detail.reason);
      const changes = asArray(detail.changes);
      const added = changes.filter((entry) => asString(asRecord(entry)?.changeKind) === 'added').length;
      const removed = changes.filter((entry) => asString(asRecord(entry)?.changeKind) === 'removed').length;
      const modified = changes.length - added - removed;
      const parts: string[] = [];
      if (modified > 0) parts.push(`修改 ${modified} 项`);
      if (added > 0) parts.push(`新增 ${added} 项`);
      if (removed > 0) parts.push(`删除 ${removed} 项`);
      const changeText = parts.length > 0 ? `：${parts.join('，')}` : '：字段值与上一版一致';
      return `商品资料第 ${revision ?? '—'} 版${changeText}${reason ? `（${reason}）` : ''}。`;
    }
    case 'inventory_confirm':
    case 'inventory_rebind': {
      const items = asArray(detail.items).map((entry) => asRecord(entry)).filter(Boolean) as Array<Record<string, unknown>>;
      const rebinds = items.filter((item) => (asNumber(item.version) ?? 1) > 1).length;
      const applied = asNumber(detail.applied);
      const skippedCount = asArray(detail.skipped).length;
      const effective = items.some((item) => asString(item.effectiveAt) === 'next_batch') ? '下一批起生效' : '立即生效';
      const parts = [`本次确认 ${applied ?? items.length} 条商品对应`];
      if (rebinds > 0) parts.push(`其中 ${rebinds} 条换了商品`);
      if (skippedCount > 0) parts.push(`跳过 ${skippedCount} 条`);
      return `${parts.join('，')}；${effective}。`;
    }
    case 'recheck_inventory_mapping':
      return '已发起重核；该对应退出当前库存汇总，等人工确认后由下一次完整批次采用。';
    case 'disable_inventory_mapping':
      return '已停用该商品对应；历史批次数量保留，不再计入当前汇总。';
    case 'replace_inventory_mapping': {
      const oldSku = asString(detail.oldExternalSku);
      const newSku = asString(detail.newExternalSku);
      return `已按原 SKU 替换：${oldSku ?? '原 SKU'} → ${newSku ?? '新 SKU'}；历史数量保留，新关系等下一批采用。`;
    }
    case 'domestic_review_decision': {
      const previous = asString(detail.previousReviewState);
      const next = asString(detail.reviewState);
      return `国内复核采用商品对应${previous || next ? `：${previous ?? '未记录'} → ${next ?? '未记录'}` : ''}。`;
    }
    case 'shipment_association_manual':
      return associationResult(record, '关联');
    case 'shipment_association_cleared':
      return associationResult(record, '清除');
    case 'shipment_manual_correction': {
      const status = manualStatusText(asString(detail.manualStatus));
      const shelved = asText(detail.manualShelvedQuantity);
      const remaining = asText(detail.remainingQuantity);
      return `人工修正：状态「${status}」；累计已上架 ${shelved ?? '未填写'}；剩余 ${remaining ?? '未保存'}。`;
    }
    case 'shipment_manual_restore': {
      const received = asText(detail.receivedQuantity);
      const remaining = asText(detail.remainingQuantity);
      return `恢复按原表判断：累计到货 ${received ?? '未保存'}；剩余 ${remaining ?? '未保存'}。`;
    }
    case 'shipment_grouping_decision': {
      const kind = GROUPING_KIND_LABELS[asString(detail.kind) ?? ''] ?? '分合票复核';
      const decision = GROUPING_DECISION_LABELS[asString(detail.decision) ?? ''] ?? asString(detail.decision) ?? '未记录';
      return `${kind}结论：${decision}。`;
    }
    case 'shipment_grouping_revoked': {
      const kind = GROUPING_KIND_LABELS[asString(detail.kind) ?? ''] ?? '分合票复核';
      return `已撤销${kind}的人工分组，恢复按飞书判断。`;
    }
    default:
      return '已保存业务处理记录。';
  }
}

function associationResult(record: OperationRecordDto, verb: '关联' | '清除'): string {
  const detail = detailOf(record);
  const items = asArray(detail.items).length;
  const reason = asString(detail.reason);
  const base = `已${verb} ${items} 条明细的商品关联`;
  return `${base}${reason ? `（${reason}）` : ''}。`;
}

/* ------------------------------------------------------------------ *
 * 展开后的依据（事实 / 变化 / 明细 / 票 / 入口 / 来源信息）
 * ------------------------------------------------------------------ */

export interface OperationFact { label: string; value: string }

export type OperationChangeKind = 'added' | 'removed' | 'modified';

export interface OperationChange {
  field: string;
  /** 展示文本：已移除 / 未填写 / 历史未保存 / 原值。 */
  before: string;
  after: string;
  kind: OperationChangeKind;
}

export interface OperationItemView {
  key: string;
  title: string;
  meta: string;
  note: string | null;
  changes: OperationChange[];
  productHref: string | null;
  inventoryHref: string | null;
  ticketHref: string | null;
}

export interface OperationTicketView { ticketNo: string; meta: string; href: string | null }
export interface OperationEntryLink { label: string; href: string }

export interface OperationDetailView {
  resultText: string;
  facts: OperationFact[];
  changes: OperationChange[];
  items: OperationItemView[];
  tickets: OperationTicketView[];
  links: OperationEntryLink[];
  notes: string[];
  /** 批次号、快照哈希、请求号等，默认折叠。 */
  sources: OperationFact[];
}

export function operationProductHref(itemId: string | null | undefined): string | null {
  return itemId && UUID_PATTERN.test(itemId) ? `/dashboard/catalog/${itemId}` : null;
}

export function operationTicketHref(record: Pick<OperationRecordDto, 'ticketId' | 'ticketNo'>): string | null {
  if (record.ticketId && UUID_PATTERN.test(record.ticketId)) {
    return `/dashboard/in-transit?ticket=${record.ticketId}`;
  }
  if (record.ticketNo) return `/dashboard/in-transit?q=${encodeURIComponent(record.ticketNo)}`;
  return null;
}

/**
 * 历史修订字段差异：SQL 已按新旧字段键并集给出 changeKind + beforePresent/afterPresent。
 * 删除 → after 显示「已移除」；新增 → before 显示「历史未保存」；两端都有键但为空 →「未填写」。
 */
function revisionChange(raw: Record<string, unknown>): OperationChange {
  const kindRaw = asString(raw.changeKind);
  const kind: OperationChangeKind = kindRaw === 'added' || kindRaw === 'removed' ? kindRaw : 'modified';
  const beforePresent = raw.beforePresent !== false;
  const afterPresent = raw.afterPresent !== false;
  if (kind === 'removed') {
    return {
      field: operationFieldLabel(String(raw.fieldKey ?? '')),
      before: operationRawText(raw.beforeRaw),
      after: '已移除',
      kind,
    };
  }
  if (kind === 'added') {
    return {
      field: operationFieldLabel(String(raw.fieldKey ?? '')),
      before: beforePresent ? operationRawText(raw.beforeRaw) : '历史未保存',
      after: afterPresent ? operationRawText(raw.afterRaw) : '已移除',
      kind,
    };
  }
  return {
    field: operationFieldLabel(String(raw.fieldKey ?? '')),
    before: beforePresent ? operationRawText(raw.beforeRaw) : '历史未保存',
    after: afterPresent ? operationRawText(raw.afterRaw) : '已移除',
    kind,
  };
}

/** 批次回执里的变化：回执没有保存字段是否存在，只用保存的 beforeRaw/afterRaw 如实展示。 */
function receiptChange(raw: Record<string, unknown>): OperationChange {
  const kindRaw = asString(raw.kind);
  const beforeRaw = raw.beforeRaw;
  const afterRaw = raw.afterRaw;
  const kind: OperationChangeKind = kindRaw === 'initial_baseline' || beforeRaw === null || beforeRaw === undefined
    ? 'added'
    : afterRaw === null || afterRaw === undefined
      ? 'removed'
      : 'modified';
  return {
    field: operationFieldLabel(String(raw.fieldKey ?? '')),
    before: kind === 'added' ? '历史未保存' : operationRawText(beforeRaw),
    after: kind === 'removed' ? '已移除' : operationRawText(afterRaw),
    kind,
  };
}

function comparisonChanges(
  fieldDifferences: unknown[],
  chosenRow: number | null,
): OperationChange[] {
  return fieldDifferences.map((entry) => {
    const diff = asRecord(entry) ?? {};
    const values = asArray(diff.values).map((value) => asRecord(value)).filter(Boolean) as Array<Record<string, unknown>>;
    return {
      field: operationFieldLabel(String(diff.fieldKey ?? '')),
      before: values.map((value) => `第${asText(value.rowNumber) ?? '?'}行 ${operationRawText(value.raw)}`).join(' / ') || '未保存',
      after: chosenRow === null ? '已保存来源行选择' : `采用第 ${chosenRow} 行`,
      kind: 'modified' as const,
    };
  });
}

function itemChange(field: string, before: string | null, after: string | null): OperationChange | null {
  if (!before && !after) return null;
  return {
    field,
    before: before ?? '历史未保存',
    after: after ?? '未记录',
    kind: 'modified',
  };
}

/** 展开内容：只读已保存依据；明细不截断（页面按 20 条一段展开）。 */
export function operationDetailView(record: OperationRecordDto): OperationDetailView {
  const detail = detailOf(record);
  const facts: OperationFact[] = [];
  const changes: OperationChange[] = [];
  const items: OperationItemView[] = [];
  const tickets: OperationTicketView[] = [];
  const notes: string[] = [];
  const links: OperationEntryLink[] = [];
  const sources: OperationFact[] = [];
  const productHref = operationProductHref(record.itemId);

  switch (record.action) {
    case 'source_batch_applied': {
      const counts = asRecord(detail.counts) ?? {};
      const results = asArray(detail.results).map((entry) => asRecord(entry)).filter(Boolean) as Array<Record<string, unknown>>;
      facts.push({ label: '批次状态', value: asString(detail.status) === 'partial' ? '部分完成（已写入确认字段，其余保留原值）' : asString(detail.status) === 'applied' ? '已采用' : (asString(detail.status) ?? '未保存') });
      if (asNumber(counts.businessRows) !== null) facts.push({ label: '本批业务行', value: String(counts.businessRows) });
      facts.push({ label: '采用时间', value: formatOperationTime(asString(detail.receivedAt) ?? record.at) || '未保存' });
      facts.push({ label: '采集时间', value: formatOperationTime(asString(detail.capturedAt)) || '未保存' });
      for (const entry of results) {
        const code = asString(entry.iceCode);
        const name = asString(entry.nameCn);
        const entryItemId = asString(entry.itemId);
        const entryChanges = asArray(entry.changes).map((change) => asRecord(change)).filter(Boolean).map((change) => receiptChange(change!));
        const reason = asString(entry.reasonText);
        const needsReview = asString(entry.action) === 'needs_review';
        items.push({
          key: `${entryItemId ?? code ?? name ?? 'item'}`,
          title: name ?? code ?? '商品',
          meta: [code, needsReview ? '待人工核对' : null, reason].filter(Boolean).join(' · '),
          note: needsReview ? '本批保留了原值，未采用待核对字段。' : null,
          changes: entryChanges,
          productHref: operationProductHref(entryItemId),
          inventoryHref: null,
          ticketHref: null,
        });
      }
      links.push({ label: '打开来源资料处理页', href: '/dashboard/catalog/sources' });
      notes.push('明细只列本批真正写入或失败的商品；「无变化 / 待核对」是计数，不是逐款操作。');
      notes.push('本页已保存本批全部写入明细，不再跳转到最新批次结果。');
      if (asString(detail.batchId)) sources.push({ label: '批次号', value: asString(detail.batchId)! });
      if (asString(detail.snapshotKey)) sources.push({ label: '快照哈希', value: asString(detail.snapshotKey)! });
      if (asString(detail.origin)) sources.push({ label: '来源类型', value: asString(detail.origin)! });
      break;
    }
    case 'assign_source_code':
    case 'assign_initial_code':
    case 'correct_test_source_code': {
      const result = asRecord(detail.result) ?? {};
      facts.push({ label: '商品版本', value: asText(result.revision) ?? '未保存' });
      facts.push({ label: '当前正式货号', value: asString(detail.currentCode) ?? '未提供' });
      if (asString(result.removedCode)) facts.push({ label: '撤销的货号', value: asString(result.removedCode)! });
      if (result.pendingCode === true || asString(result.pendingCode) === 'true') facts.push({ label: '货号状态', value: '已恢复为待确认' });
      if (asString(detail.requestId)) sources.push({ label: '请求号', value: asString(detail.requestId)! });
      break;
    }
    case 'resolve_source_issue': {
      const result = asRecord(detail.result) ?? {};
      facts.push({ label: '事项类型', value: asString(result.issueKind) ?? '未保存' });
      facts.push({ label: '来源行', value: asString(result.sourceKey) ?? '未保存' });
      facts.push({ label: '处理结果', value: asString(result.reviewState) ?? '未保存' });
      break;
    }
    case 'duplicate_source_decision': {
      facts.push({ label: '决定时间', value: formatOperationTime(record.at) || '未保存' });
      facts.push({ label: '来源行号', value: asArray(detail.rows).map((row) => String(row)).join(' / ') || '未保存' });
      facts.push({ label: '选择的来源行', value: asNumber(detail.chosenRowNumber) === null ? '未保存' : `第 ${asNumber(detail.chosenRowNumber)} 行` });
      facts.push({ label: '该行名称', value: asString(detail.chosenRowName) ?? '未保存' });
      facts.push({ label: '该行商品条码', value: asString(detail.chosenRowBarcode) ?? '未填写' });
      const state = asString(detail.state);
      facts.push({ label: '当前状态', value: state === 'superseded' ? '已被后续操作撤销' : state === 'active' ? '生效中' : (state ?? '未保存') });
      changes.push(...comparisonChanges(asArray(detail.fieldDifferences), asNumber(detail.chosenRowNumber)));
      if (state === 'superseded') {
        const at = formatOperationTime(asString(detail.supersededAt));
        notes.push(`这条选择${at ? `已于 ${at}` : ''}被撤销；原决定仍保留在这里，撤销作为独立记录显示。`);
      }
      break;
    }
    case 'duplicate_source_decision_revoked': {
      facts.push({ label: '原决定时间', value: formatOperationTime(asString(detail.decidedAt)) || '未保存' });
      facts.push({ label: '原选择来源行', value: asNumber(detail.chosenRowNumber) === null ? '未保存' : `第 ${asNumber(detail.chosenRowNumber)} 行` });
      facts.push({ label: '撤销时间', value: formatOperationTime(asString(detail.supersededAt) ?? record.at) || '未保存' });
      if (detail.revokedByAccount === false) facts.push({ label: '撤销账号', value: '历史未保存' });
      const note = asString(detail.note);
      if (note) notes.push(`已保存说明：${note}`);
      notes.push('原决定仍保留在它发生的时间；本条是后续撤销，不重复计算原选择。');
      if (asString(detail.requestId)) sources.push({ label: '请求号', value: asString(detail.requestId)! });
      break;
    }
    case 'field_decision': {
      facts.push({ label: '字段', value: operationFieldLabel(asString(detail.fieldKey) ?? '未保存') });
      facts.push({ label: '处理方式', value: FIELD_ACTION_LABELS[asString(detail.action) ?? ''] ?? '未保存' });
      facts.push({ label: '决定时间', value: formatOperationTime(asString(detail.decidedAt) ?? record.at) || '未保存' });
      facts.push({ label: '决定状态', value: asString(detail.state) === 'active' ? '生效中' : asString(detail.state) === 'revoked' ? '已撤销' : (asString(detail.state) ?? '未保存') });
      if (asString(detail.rule)) facts.push({ label: '采用口径', value: asString(detail.rule)! });
      if (asString(detail.valueRaw)) facts.push({ label: '人工值', value: asString(detail.valueRaw)! });
      if (asString(detail.reason)) notes.push(asString(detail.reason)!);
      if (asString(detail.note)) notes.push(asString(detail.note)!);
      if (asString(detail.revokedAt)) {
        notes.push(`这条决定已于 ${formatOperationTime(asString(detail.revokedAt)) || '未保存时间'} 被撤销，撤销有独立记录。`);
      }
      notes.push('该决定行只保存决定本身；覆盖前的本地值没有保存，不能从当前商品资料反推。');
      break;
    }
    case 'source_field_decision_revoked': {
      facts.push({ label: '原决定时间', value: formatOperationTime(asString(detail.decidedAt)) || '未保存' });
      facts.push({ label: '原处理方式', value: FIELD_ACTION_LABELS[asString(detail.originalAction) ?? ''] ?? '人工处理' });
      facts.push({ label: '字段', value: operationFieldLabel(asString(detail.fieldKey) ?? '未保存') });
      if (asString(detail.valueRaw)) facts.push({ label: '原人工值', value: asString(detail.valueRaw)! });
      if (asString(detail.rule)) facts.push({ label: '原采用口径', value: asString(detail.rule)! });
      facts.push({ label: '撤销时间', value: formatOperationTime(asString(detail.revokedAt) ?? record.at) || '未保存' });
      const note = asString(detail.revokedNote);
      if (note) notes.push(`已保存撤销说明：${note}`);
      if (asString(detail.reason)) notes.push(`原决定理由：${asString(detail.reason)}`);
      notes.push('原决定仍保留在它发生的时间；本条是后续撤销，不把撤销时间写回原决定。');
      if (asString(detail.requestId)) sources.push({ label: '请求号', value: asString(detail.requestId)! });
      break;
    }
    case 'item_baseline':
    case 'item_revision': {
      const revision = asNumber(detail.revision);
      const previous = asNumber(detail.previousRevision);
      const declared = asNumber(detail.declaredPreviousRevision);
      facts.push({ label: '版本', value: revision === null ? '未保存' : `第 ${revision} 版` });
      facts.push({ label: '上一版本', value: previous === null ? '无（首版）' : `第 ${previous} 版` });
      if (asString(detail.reason)) facts.push({ label: '修订原因', value: asString(detail.reason)! });
      changes.push(...asArray(detail.changes).map((change) => asRecord(change)).filter(Boolean).map((change) => revisionChange(change!)));
      if (asString(detail.evidenceRef)) sources.push({ label: '来源证据', value: asString(detail.evidenceRef)! });
      if (previous === null) {
        notes.push(declared !== null
          ? `声明上一版为第 ${declared} 版，但历史里找不到该版本，因此没有前值可对比。`
          : '首版没有上一版本，因此没有前值可对比。');
      } else if (changes.length === 0) {
        notes.push('该版本与上一版保存的字段值一致，没有字段级差异。');
      }
      break;
    }
    case 'inventory_confirm':
    case 'inventory_rebind': {
      const rawItems = asArray(detail.items).map((entry) => asRecord(entry)).filter(Boolean) as Array<Record<string, unknown>>;
      facts.push({ label: '本次确认', value: `${asNumber(detail.applied) ?? rawItems.length} 条` });
      if (asArray(detail.skipped).length > 0) facts.push({ label: '跳过', value: `${asArray(detail.skipped).length} 条` });
      for (const item of rawItems) {
        const version = asNumber(item.version);
        const previousIce = asString(item.previousIceCode);
        const previousName = asString(item.previousNameCn);
        const changed = version !== null && version > 1;
        const change = changed
          ? itemChange('商品对应',
            `原商品 ${previousIce ?? '历史未保存'}${previousName ? `（${previousName}）` : ''}`,
            `现商品 ${asString(item.iceCode) ?? '未记录'}${asString(item.nameCn) ? `（${asString(item.nameCn)}）` : ''}`)
          : null;
        items.push({
          key: asString(item.mappingId) ?? String(item.externalSku),
          title: asString(item.nameCn) ?? asString(item.iceCode) ?? '商品',
          meta: [
            asString(item.externalSku) ? `来源 SKU ${asString(item.externalSku)}` : null,
            asString(item.warehouseName),
            asString(item.unit) ? `单位 ${asString(item.unit)}` : null,
            version === null ? null : `对应第 ${version} 版`,
          ].filter(Boolean).join(' · '),
          note: null,
          changes: change ? [change] : [],
          productHref: operationProductHref(asString(item.itemId)),
          inventoryHref: asString(item.externalSku)
            ? `/dashboard/inventory?q=${encodeURIComponent(asString(item.externalSku)!)}&source=overseas`
            : null,
          ticketHref: null,
        });
      }
      notes.push('「上一版商品」取被替代的对应行（仍保存在历史里），不是当前商品资料。');
      break;
    }
    case 'recheck_inventory_mapping':
    case 'disable_inventory_mapping': {
      facts.push({ label: '来源 SKU', value: asString(detail.externalSku) ?? '未保存' });
      facts.push({ label: '对应版本', value: asText(detail.mappingVersion) ?? '未保存' });
      facts.push({ label: '当前状态', value: asString(detail.mappingStatus) ?? '未保存' });
      if (asString(detail.note)) notes.push(asString(detail.note)!);
      if (asString(detail.mappingId)) sources.push({ label: '对应记录号', value: asString(detail.mappingId)! });
      break;
    }
    case 'replace_inventory_mapping': {
      const oldSku = asString(detail.oldExternalSku);
      const newSku = asString(detail.newExternalSku);
      facts.push({ label: '原来源 SKU', value: oldSku ?? '未保存' });
      facts.push({ label: '新来源 SKU', value: newSku ?? '未保存' });
      facts.push({ label: '新对应版本', value: asText(detail.newVersion) ?? '未保存' });
      facts.push({ label: '生效方式', value: asString(detail.effectiveAt) === 'next_batch' ? '下一批起生效' : (asString(detail.effectiveAt) ?? '未保存') });
      if (asString(detail.mappingStatus)) facts.push({ label: '新对应状态', value: asString(detail.mappingStatus)! });
      if (asString(detail.unit)) facts.push({ label: '单位', value: asString(detail.unit)! });
      if (asString(detail.note)) notes.push(asString(detail.note)!);
      const change = (oldSku || newSku)
        ? itemChange('绑定的来源 SKU', oldSku ? `原 SKU ${oldSku}` : null, newSku ? `新 SKU ${newSku}` : null)
        : null;
      if (change) changes.push(change);
      if (newSku) {
        links.push({
          label: '在商品库存查看新来源 SKU',
          href: `/dashboard/inventory?q=${encodeURIComponent(newSku)}&source=overseas`,
        });
      }
      for (const [label, value] of [
        ['原对应记录号', detail.oldMappingId],
        ['新对应记录号', detail.newMappingId],
        ['仓库标识', detail.warehouseId],
      ] as const) {
        if (asString(value)) sources.push({ label, value: asString(value)! });
      }
      break;
    }
    case 'domestic_review_decision': {
      facts.push({ label: '复核前状态', value: asString(detail.previousReviewState) ?? '未记录' });
      facts.push({ label: '复核后状态', value: asString(detail.reviewState) ?? '未记录' });
      facts.push({ label: '生效方式', value: asString(detail.effectiveAt) === 'immediate' ? '立即生效' : (asString(detail.effectiveAt) ?? '未保存') });
      facts.push({ label: '国内来源行', value: asString(detail.sourceRowId) ?? '未保存' });
      for (const [label, value] of [
        ['数据集', detail.datasetId],
        ['观测记录', detail.observationId],
      ] as const) {
        if (asString(value)) sources.push({ label, value: asString(value)! });
      }
      break;
    }
    case 'shipment_association_manual':
    case 'shipment_association_cleared': {
      const rawItems = asArray(detail.items).map((entry) => asRecord(entry)).filter(Boolean) as Array<Record<string, unknown>>;
      if (asString(detail.reason)) notes.push(asString(detail.reason)!);
      for (const item of rawItems) {
        const productId = asString(item.productId);
        const previousIce = asString(item.previousIceCode);
        const currentIce = asString(item.iceCode);
        const change = previousIce
          ? itemChange('商品', `原商品 ${previousIce}${asString(item.previousNameCn) ? `（${asString(item.previousNameCn)}）` : ''}`, `现商品 ${currentIce ?? '未关联'}`)
          : null;
        items.push({
          key: asString(item.itemId) ?? String(item.productNameRaw),
          title: asString(item.productNameRaw) ?? '货票明细',
          meta: [
            asString(item.sourceSku) ? `来源 SKU ${asString(item.sourceSku)}` : null,
            currentIce ?? (productId ? null : '未关联商品'),
            asString(item.nameCn),
          ].filter(Boolean).join(' · '),
          note: null,
          changes: change ? [change] : [],
          productHref: operationProductHref(productId),
          inventoryHref: null,
          ticketHref: null,
        });
      }
      notes.push('同一次保存的同一票明细合并为一条记录；搜索其中任一货号都能找到它。');
      break;
    }
    case 'shipment_manual_correction':
    case 'shipment_manual_restore': {
      facts.push({ label: '记录名称', value: asString(detail.actorName) ?? actorRecordName(record) });
      facts.push({ label: '修正版本', value: asText(detail.revision) ?? '未保存' });
      facts.push({ label: '修正前状态', value: manualStatusText(asString(detail.previousManualStatus)) });
      facts.push({ label: '保存后状态', value: manualStatusText(asString(detail.manualStatus)) });
      facts.push({ label: '累计到货', value: asText(detail.receivedQuantity) ?? '未保存' });
      facts.push({ label: '剩余', value: asText(detail.remainingQuantity) ?? '未保存' });
      facts.push({ label: '累计已上架', value: asText(detail.manualShelvedQuantity) ?? '未提供' });
      if (asString(detail.note)) notes.push(asString(detail.note)!);
      notes.push('「修正前状态」取人工修正历史行的 previous_*；未人工修正时显示「未记录」。');
      break;
    }
    case 'shipment_grouping_decision':
    case 'shipment_grouping_revoked': {
      facts.push({ label: '复核类型', value: GROUPING_KIND_LABELS[asString(detail.kind) ?? ''] ?? '分合票复核' });
      if (asString(detail.decision)) facts.push({ label: '人工决定', value: GROUPING_DECISION_LABELS[asString(detail.decision) ?? ''] ?? asString(detail.decision)! });
      if (asString(detail.resolvedAt)) facts.push({ label: '处理时间', value: formatOperationTime(asString(detail.resolvedAt)) || '未保存' });
      if (asString(detail.revokedAt)) facts.push({ label: '撤销时间', value: formatOperationTime(asString(detail.revokedAt)) || '未保存' });
      if (asString(detail.resolutionNote)) notes.push(asString(detail.resolutionNote)!);
      for (const ticket of asArray(detail.tickets).map((entry) => asRecord(entry)).filter(Boolean)) {
        const ticketNo = asString(ticket!.ticketNo) ?? '无单号';
        tickets.push({
          ticketNo,
          meta: [
            asString(ticket!.market),
            asString(ticket!.purchaseOrder) ? `采购单 ${asString(ticket!.purchaseOrder)}` : null,
            asNumber(ticket!.itemCount) === null ? null : `${asNumber(ticket!.itemCount)} 条明细`,
          ].filter(Boolean).join(' · '),
          href: `/dashboard/in-transit?q=${encodeURIComponent(ticketNo)}`,
        });
      }
      const affected = asArray(detail.affectedProducts).map((entry) => asString(entry)).filter(Boolean) as string[];
      if (affected.length > 0) notes.push(`涉及商品：${affected.slice(0, 12).join('、')}${affected.length > 12 ? ` 等 ${affected.length} 款` : ''}`);
      notes.push('分合票决定无法反查具体操作人；记录账号只代表写入时使用的账号。');
      if (asString(detail.fromSnapshotId)) sources.push({ label: '对比前快照', value: asString(detail.fromSnapshotId)! });
      if (asString(detail.toSnapshotId)) sources.push({ label: '对比后快照', value: asString(detail.toSnapshotId)! });
      break;
    }
    default:
      break;
  }

  if (productHref) links.push({ label: '查看该商品资料', href: productHref });
  if (record.ticketNo) {
    const href = operationTicketHref(record);
    if (href) links.push({ label: record.ticketId ? '打开该货票详情' : '在物流在途搜索该货票', href });
  }
  if (record.externalSku && !items.some((item) => item.inventoryHref)) {
    links.push({
      label: '在商品库存查看该来源 SKU',
      href: `/dashboard/inventory?q=${encodeURIComponent(record.externalSku)}&source=overseas`,
    });
  }
  return {
    resultText: operationResultText(record),
    facts,
    changes,
    items,
    tickets,
    links,
    notes,
    sources,
  };
}

const SHANGHAI_TIME_ZONE = 'Asia/Shanghai';
const shanghaiFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: SHANGHAI_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** ISO → 'YYYY-MM-DD HH:mm:ss'（上海时间）；无效/缺失返回空串，不编造时间。 */
export function formatOperationTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return '';
  const parts = shanghaiFormatter.formatToParts(new Date(timestamp));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  const date = `${value('year')}-${value('month')}-${value('day')}`;
  const time = `${value('hour')}:${value('minute')}:${value('second')}`;
  if (!value('year') || !value('hour')) return '';
  return `${date} ${time}`;
}

/** 记录账号显示（只写账号；不推断具体操作人）。 */
export function operationActorText(record: OperationRecordDto): string {
  return actorRecordName(record);
}

/** 拆成 20 条一段，供页面分段展开；不丢任何明细。 */
export function operationItemChunks<T>(items: T[], size = OPERATION_ITEM_CHUNK): T[][] {
  const chunkSize = size > 0 ? Math.trunc(size) : OPERATION_ITEM_CHUNK;
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }
  return chunks;
}
