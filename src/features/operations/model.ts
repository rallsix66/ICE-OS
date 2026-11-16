/**
 * 「操作记录」页面模型（纯函数：URL 解析、分页、动作文案、已保存依据的展示投影）。
 *
 * 原则：
 * - 这里只把服务端 042 只读函数返回的**已保存字段**翻成中文，不做任何当前值反推；
 * - 历史行没有保存的内容显示「未保存 / 未提供」，不补 0、不猜；
 * - 记录账号 = 记录行上的 actor_id 显示名，不推断具体操作人。
 */
import { receiptSentence } from '@/features/catalog/product-source/receipt-copy';
import { manualStatusLabel } from '@/features/shipment/model';
import type { OperationCategory, OperationCategoryFilter, OperationRecordDto } from './types';

export const OPERATION_PAGE_SIZE = 50;
export const OPERATION_MAX_SEARCH_LENGTH = 80;
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

/** 类别标签上的计数文案：真实 0 显示 0 条（不隐藏、不写「—」）。 */
export function operationCategoryCountLabel(count: number): string {
  const safe = Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0;
  return `${safe} 条`;
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
  field_decision: '来源字段人工口径',
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

/** 已保存的原始值显示：空值如实写「未填写」，缺失写「未提供」。 */
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
        return '这条选择已撤销；没有真实人工确认，同号多行重新回到待处理。';
      }
      return row ? `已选择来源第 ${row} 行资料，后续更新按这一行采用。` : '已保存来源资料行选择。';
    }
    case 'field_decision': {
      const action = asString(detail.action) ?? '';
      const field = operationFieldLabel(asString(detail.fieldKey) ?? '');
      const state = asString(detail.state);
      const label = FIELD_ACTION_LABELS[action] ?? '人工处理';
      return `${label}：${field}${state === 'revoked' ? '（该决定已撤销）' : ''}。`;
    }
    case 'item_baseline':
      return '建立商品资料首版；没有上一版本，无法对比前值。';
    case 'item_revision': {
      const revision = asNumber(detail.revision);
      const reason = asString(detail.reason);
      return `商品资料第 ${revision ?? '—'} 版${reason ? `：${reason}` : ''}。`;
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
    case 'replace_inventory_mapping':
      return '已按原 SKU 替换更换绑定；历史数量保留，新关系等下一批采用。';
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
 * 展开后的依据（事实 / 变化 / 明细 / 票 / 入口）
 * ------------------------------------------------------------------ */

export interface OperationFact { label: string; value: string }
export interface OperationChange { scope: string; field: string; before: string; after: string }
export interface OperationItemView {
  key: string;
  title: string;
  meta: string;
  change: string | null;
  productHref: string | null;
  inventoryHref: string | null;
}
export interface OperationTicketView { ticketNo: string; meta: string; href: string | null }
export interface OperationEntryLink { label: string; href: string }
export interface OperationDetailView {
  facts: OperationFact[];
  changes: OperationChange[];
  items: OperationItemView[];
  tickets: OperationTicketView[];
  links: OperationEntryLink[];
  notes: string[];
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

function changeRows(
  rawList: unknown,
  scope: string,
): OperationChange[] {
  return asArray(rawList).map((entry) => asRecord(entry)).filter(Boolean).map((entry) => ({
    scope,
    field: operationFieldLabel(String(entry!.fieldKey ?? '')),
    before: asString(entry!.beforeRaw) ?? '未填写',
    after: asString(entry!.afterRaw) ?? '未填写',
  }));
}

/** 展开内容：只读已保存依据；长列表截断并标注总数。 */
export function operationDetailView(record: OperationRecordDto, maxItems = 40): OperationDetailView {
  const detail = detailOf(record);
  const facts: OperationFact[] = [];
  const changes: OperationChange[] = [];
  const items: OperationItemView[] = [];
  const tickets: OperationTicketView[] = [];
  const notes: string[] = [];
  const links: OperationEntryLink[] = [];
  const productHref = operationProductHref(record.itemId);
  if (productHref) links.push({ label: '查看该商品资料', href: productHref });

  switch (record.action) {
    case 'source_batch_applied': {
      const counts = asRecord(detail.counts) ?? {};
      const results = asArray(detail.results).map((entry) => asRecord(entry)).filter(Boolean) as Array<Record<string, unknown>>;
      facts.push({ label: '批次', value: asString(detail.batchId) ?? '未保存' });
      facts.push({ label: '批次状态', value: asString(detail.status) === 'partial' ? '部分完成（已写入确认字段，其余保留原值）' : asString(detail.status) === 'applied' ? '已采用' : (asString(detail.status) ?? '未保存') });
      facts.push({ label: '来源快照', value: asString(detail.snapshotKey) ?? '未保存' });
      facts.push({ label: '采集时间', value: formatOperationTime(asString(detail.capturedAt)) || '未保存' });
      facts.push({ label: '采用时间', value: formatOperationTime(asString(detail.receivedAt) ?? record.at) || '未保存' });
      if (asNumber(counts.businessRows) !== null) facts.push({ label: '本批业务行', value: String(counts.businessRows) });
      facts.push({ label: '本批写入商品', value: `${results.length} 款（明细如下）` });
      const shown = results.slice(0, maxItems);
      for (const entry of shown) {
        const code = asString(entry.iceCode);
        const name = asString(entry.nameCn);
        const entryItemId = asString(entry.itemId);
        const entryChanges = changeRows(entry.changes, `${code ?? ''} ${name ?? ''}`.trim() || '商品');
        if (entryChanges.length === 0) {
          entryChanges.push({ scope: `${code ?? ''} ${name ?? ''}`.trim() || '商品', field: '本批结果', before: '—', after: asString(entry.reasonText) ?? '未保存' });
        }
        changes.push(...entryChanges);
        items.push({
          key: `${entryItemId ?? code ?? name ?? 'item'}:${entryChanges.length}`,
          title: name ?? code ?? '商品',
          meta: [code, asString(entry.reasonText)].filter(Boolean).join(' · '),
          change: asString(entry.reasonText),
          productHref: operationProductHref(entryItemId),
          inventoryHref: null,
        });
      }
      if (results.length > shown.length) notes.push(`本批共 ${results.length} 款写入，这里显示前 ${shown.length} 款。`);
      links.push({ label: '查看来源批次与采用记录', href: '/dashboard/catalog/sources' });
      links.push({ label: '查看本批更新结果', href: '/dashboard/sync?panel=product-update' });
      notes.push('「无变化 / 待核对」的款数来自本批回执计数；明细只列真正写入或失败的款。');
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
      if (asString(detail.requestId)) facts.push({ label: '请求号', value: asString(detail.requestId)! });
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
      facts.push({ label: '来源行号', value: asArray(detail.rows).map((row) => String(row)).join(' / ') || '未保存' });
      facts.push({ label: '选择的来源行', value: asText(detail.chosenRowNumber) ?? '未保存' });
      facts.push({ label: '该行名称', value: asString(detail.chosenRowName) ?? '未保存' });
      facts.push({ label: '该行商品条码', value: asString(detail.chosenRowBarcode) ?? '未填写' });
      facts.push({ label: '决定状态', value: asString(detail.state) === 'superseded' ? '已撤销' : (asString(detail.state) ?? '未保存') });
      if (asString(detail.supersededAt)) facts.push({ label: '撤销时间', value: formatOperationTime(asString(detail.supersededAt)) || '未保存' });
      if (asString(detail.note)) notes.push(asString(detail.note)!);
      for (const diff of asArray(detail.fieldDifferences).map((entry) => asRecord(entry)).filter(Boolean)) {
        const field = operationFieldLabel(String(diff!.fieldKey ?? ''));
        const values = asArray(diff!.values).map((entry) => asRecord(entry)).filter(Boolean) as Array<Record<string, unknown>>;
        changes.push({
          scope: '两份资料逐行对照',
          field,
          before: values.map((value) => `第${value.rowNumber ?? '?'}行 ${asString(value.raw) ?? '未填写'}`).join(' / ') || '未保存',
          after: '以上为来源原值',
        });
      }
      break;
    }
    case 'field_decision': {
      facts.push({ label: '字段', value: operationFieldLabel(asString(detail.fieldKey) ?? '未保存') });
      facts.push({ label: '处理方式', value: FIELD_ACTION_LABELS[asString(detail.action) ?? ''] ?? '未保存' });
      facts.push({ label: '决定状态', value: asString(detail.state) === 'active' ? '生效中' : asString(detail.state) === 'revoked' ? '已撤销' : (asString(detail.state) ?? '未保存') });
      if (asString(detail.rule)) facts.push({ label: '采用口径', value: asString(detail.rule)! });
      if (asString(detail.valueRaw)) facts.push({ label: '人工值', value: asString(detail.valueRaw)! });
      if (asString(detail.reason)) notes.push(asString(detail.reason)!);
      if (asString(detail.revokedAt)) facts.push({ label: '撤销时间', value: formatOperationTime(asString(detail.revokedAt)) || '未保存' });
      notes.push('该决定行只保存决定本身；覆盖前的本地值没有保存，不能从当前商品资料反推。');
      break;
    }
    case 'item_baseline':
    case 'item_revision': {
      const revision = asNumber(detail.revision);
      const previous = asNumber(detail.previousRevision);
      facts.push({ label: '版本', value: revision === null ? '未保存' : `第 ${revision} 版` });
      facts.push({ label: '上一版本', value: previous === null ? '无（首版）' : `第 ${previous} 版` });
      if (asString(detail.reason)) facts.push({ label: '修订原因', value: asString(detail.reason)! });
      if (asString(detail.barcode)) facts.push({ label: '商品条码', value: asString(detail.barcode)! });
      if (asString(detail.evidenceRef)) notes.push(`来源证据：${asString(detail.evidenceRef)}`);
      changes.push(...changeRows(detail.changes, record.iceCode ?? '商品资料'));
      if (asString(detail.previousRevision) === null || previous === null) notes.push('首版没有上一版本，因此没有前值可对比。');
      else if (changes.length === 0) notes.push('该版本与上一版保存的字段值一致，没有字段级差异。');
      break;
    }
    case 'inventory_confirm':
    case 'inventory_rebind': {
      const rawItems = asArray(detail.items).map((entry) => asRecord(entry)).filter(Boolean) as Array<Record<string, unknown>>;
      facts.push({ label: '本次确认', value: `${asNumber(detail.applied) ?? rawItems.length} 条` });
      if (asArray(detail.skipped).length > 0) facts.push({ label: '跳过', value: `${asArray(detail.skipped).length} 条` });
      for (const item of rawItems.slice(0, maxItems)) {
        const version = asNumber(item.version);
        const previousIce = asString(item.previousIceCode);
        const previousName = asString(item.previousNameCn);
        const changed = version !== null && version > 1;
        items.push({
          key: asString(item.mappingId) ?? String(item.externalSku),
          title: asString(item.nameCn) ?? asString(item.iceCode) ?? '商品',
          meta: [
            asString(item.externalSku) ? `来源 SKU ${asString(item.externalSku)}` : null,
            asString(item.warehouseName),
            asString(item.unit) ? `单位 ${asString(item.unit)}` : null,
            version === null ? null : `对应第 ${version} 版`,
          ].filter(Boolean).join(' · '),
          change: changed
            ? `原商品 ${previousIce ?? '未保存'}${previousName ? `（${previousName}）` : ''} → 现商品 ${asString(item.iceCode) ?? '未保存'}`
            : null,
          productHref: operationProductHref(asString(item.itemId)),
          inventoryHref: asString(item.externalSku)
            ? `/dashboard/inventory?q=${encodeURIComponent(asString(item.externalSku)!)}&source=overseas`
            : null,
        });
      }
      if (rawItems.length > maxItems) notes.push(`本次共 ${rawItems.length} 条对应，这里显示前 ${maxItems} 条。`);
      notes.push('「上一版商品」取被替代的对应行（仍保存在历史里），不是当前商品资料。');
      break;
    }
    case 'recheck_inventory_mapping':
    case 'disable_inventory_mapping':
    case 'replace_inventory_mapping': {
      facts.push({ label: '来源 SKU', value: asString(detail.externalSku) ?? '未保存' });
      facts.push({ label: '对应版本', value: asText(detail.mappingVersion) ?? '未保存' });
      facts.push({ label: '当前状态', value: asString(detail.mappingStatus) ?? '未保存' });
      if (asString(detail.note)) notes.push(asString(detail.note)!);
      break;
    }
    case 'domestic_review_decision': {
      facts.push({ label: '复核前状态', value: asString(detail.previousReviewState) ?? '未记录' });
      facts.push({ label: '复核后状态', value: asString(detail.reviewState) ?? '未记录' });
      facts.push({ label: '生效方式', value: asString(detail.effectiveAt) === 'immediate' ? '立即生效' : (asString(detail.effectiveAt) ?? '未保存') });
      facts.push({ label: '国内来源行', value: asString(detail.sourceRowId) ?? '未保存' });
      facts.push({ label: '数据集', value: asString(detail.datasetId) ?? '未保存' });
      break;
    }
    case 'shipment_association_manual':
    case 'shipment_association_cleared': {
      const rawItems = asArray(detail.items).map((entry) => asRecord(entry)).filter(Boolean) as Array<Record<string, unknown>>;
      if (asString(detail.reason)) notes.push(asString(detail.reason)!);
      for (const item of rawItems.slice(0, maxItems)) {
        const productId = asString(item.productId);
        const previousIce = asString(item.previousIceCode);
        items.push({
          key: asString(item.itemId) ?? String(item.productNameRaw),
          title: asString(item.productNameRaw) ?? '货票明细',
          meta: [
            asString(item.sourceSku) ? `来源 SKU ${asString(item.sourceSku)}` : null,
            asString(item.iceCode) ?? (productId ? null : '未关联商品'),
            asString(item.nameCn),
          ].filter(Boolean).join(' · '),
          change: previousIce ? `原商品 ${previousIce} → 现商品 ${asString(item.iceCode) ?? '未关联'}` : null,
          productHref: operationProductHref(productId),
          inventoryHref: null,
        });
      }
      if (rawItems.length > maxItems) notes.push(`本次共 ${rawItems.length} 条明细，这里显示前 ${maxItems} 条。`);
      notes.push('同一次保存的同一票明细合并为一条记录。');
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
      notes.push('「修正前状态」取人工修正历史行的 previous_*；未人工修正时显示「未人工修正」。');
      break;
    }
    case 'shipment_grouping_decision':
    case 'shipment_grouping_revoked': {
      facts.push({ label: '复核类型', value: GROUPING_KIND_LABELS[asString(detail.kind) ?? ''] ?? '分合票复核' });
      if (asString(detail.decision)) facts.push({ label: '人工决定', value: GROUPING_DECISION_LABELS[asString(detail.decision) ?? ''] ?? asString(detail.decision)! });
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
      break;
    }
    default:
      break;
  }

  if (record.ticketNo) {
    const href = operationTicketHref(record);
    if (href) links.push({ label: record.ticketId ? '打开该货票详情' : `在物流在途搜索该货票`, href });
  }
  if (record.externalSku && !items.some((item) => item.inventoryHref)) {
    links.push({
      label: '在商品库存查看该来源 SKU',
      href: `/dashboard/inventory?q=${encodeURIComponent(record.externalSku)}&source=overseas`,
    });
  }
  return { facts, changes, items, tickets, links, notes };
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
