import 'server-only';

import { CATALOG_FIELD_LABELS, fieldBusinessValue } from './local-display/field-labels';
import { getCatalogAmounts, getCatalogDetailAudit, getCatalogDetailCore, getCatalogDetailHistoryDisplay, getCatalogDetailRevision } from './service';
import type { CatalogRevisionChange } from './types';

type SourceKey = 'bigseller' | 'jushuitan';

export type CatalogSourceRecordDto = {
  sourceSku: string | null;
  sourceName: string | null;
  /** 该条来源记录自己的仓库；缺失时 null，界面显示“未提供”，不得回填当前筛选仓。 */
  sourceWarehouse: string | null;
  confirmation: 'confirmed' | 'pending' | 'ignored' | 'rejected' | 'outside' | 'other_item';
  confirmationLabel: string;
  /** 本批是否真正采用该条来源作为当前商品的已确认对应。 */
  adoptedInBatch: boolean;
  differences: Array<{ fieldLabel: string; adopted: string; source: string }>;
  /** 已有核对提示（来自既有冲突标记），不是新匹配算法，也不等于“已核对一致”。 */
  reviewNotes: string[];
  sourcePriceRows: Array<{ label: string; value: string }>;
};

export type CatalogSourceSystemDto = {
  key: SourceKey;
  label: string;
  records: CatalogSourceRecordDto[];
  /**
   * 该系统与本批库存的关系说明。只在系统级显示一次，避免每条记录重复解释。
   * 资料对应（已采用）不等于库存已计入：BS 是否计入仍以已确认的库存行为准，
   * JST 只表示资料对应，国内库存尚未接入。
   */
  inventoryNote: string;
};

export type CatalogSourceViewDto = {
  item: { iceCode: string | null; nameCn: string; revision: number };
  historical: boolean;
  /** 当前资料是否保存了可核对的来源对应记录。 */
  sourceRecorded: boolean;
  sourceNote: string | null;
  systems: CatalogSourceSystemDto[];
  differences: Array<{ fieldLabel: string; adopted: string; source: string }>;
  price: {
    state: 'available' | 'missing' | 'no_permission' | 'read_failed' | 'historical';
    adoptedCost: string | null;
    adoptedOperatingPrice: string | null;
    note: string;
  };
  historicalFacts: {
    reasonLabel: string;
    recordedAtDisplay: string;
    actorLabel: string | null;
    changedFields: CatalogRevisionChange[];
  } | null;
  currentReferenceAvailable: boolean;
};

const SYSTEM_LABELS: Record<SourceKey, string> = {
  bigseller: 'BigSeller（BS）',
  jushuitan: '聚水潭（JST）',
};

/**
 * V6-02：把“本批已采用对应”和“库存已计入”分开。
 * - BS 是否计入库存沿用现有已确认库存事实，不由资料对应状态推断；
 * - JST 只表示其作为本批商品对应，国内库存尚未接入，不能据此声称已计入库存。
 */
const SYSTEM_INVENTORY_NOTES: Record<SourceKey, string> = {
  bigseller: 'BS 记录是否计入库存，以库存明细中已确认的 BS 样表行为准；资料对应本身不增加库存。',
  jushuitan: 'JST 记录只表示本批资料对应；国内库存尚未接入，不据此计入库存。',
};

const CONFIRMATION_LABELS: Record<CatalogSourceRecordDto['confirmation'], string> = {
  confirmed: '本批已采用对应',
  pending: '待核对',
  ignored: '已忽略',
  rejected: '已拒绝',
  outside: '本批未采用',
  other_item: '已对应其他商品',
};

/**
 * 既有冲突/提示标记只做业务翻译，不展示内部编码。
 * 这些提示来自已保存记录；来源视图不新增匹配、确认或库存归属规则。
 */
const REVIEW_NOTE_LABELS: Record<string, string> = {
  SOURCE_IDENTITY_UNVERIFIED: '来源身份尚未核实',
  SOURCE_SKU_REPEATED_REVIEW_SCOPE: '同一来源编码在本批重复出现，需按版本核对',
  BARCODE_SHARED_REVIEW_VERSION: '条码与其他记录共用，需按版本核对',
  EXISTING_CHOICE_OTHER_ITEM: '已有选择指向其他商品',
  PRESERVED_IGNORED: '原记录已忽略并保留',
  PRESERVED_REJECTED: '原记录已拒绝并保留',
  PRESERVED_OUTSIDE_RULES: '原记录在本批匹配规则外',
  MANY_TO_ONE: '多条来源记录指向同一商品',
  NAME_ONLY_HINT: '仅名称相似，未作为确认依据',
  UNMATCHED: '来源尚未建立对应',
  OUTSIDE_MATCH_POLICY: '本批匹配规则外',
  SPECIFICATION_DIFF_REVIEW_VERSION_OR_PACKAGING: '规格与已采用值不同，可能涉及版本或包装差异',
  PACKAGING_DIFFERENCE_REQUIRES_REVIEW: '包装与已采用值不同，需要核对',
};

function reviewNotesFor(candidate: { conflicts?: string[] }): string[] {
  const labels = (candidate.conflicts ?? [])
    .map((code) => REVIEW_NOTE_LABELS[code] ?? (/^[A-Z][A-Z0-9_]*$/.test(code) ? '已有核对提示' : code))
    .filter(Boolean);
  return [...new Set(labels)];
}

function observedText(field: { state: string; raw?: unknown } | undefined | null): string | null {
  if (!field || field.state !== 'observed') return null;
  const raw = field.raw;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function scopeWarehouse(scope: Record<string, unknown>): string | null {
  const value = scope.warehouse as { state?: string; raw?: unknown; canonical?: unknown } | undefined;
  if (!value || value.state !== 'known') return null;
  const text = typeof value.canonical === 'string' ? value.canonical : typeof value.raw === 'string' ? value.raw : '';
  return text.trim() || null;
}

function confirmationFor(selectedItemId: string | null, reviewState: string | null, currentItemId: string): CatalogSourceRecordDto['confirmation'] {
  if (selectedItemId === currentItemId) return 'confirmed';
  if (selectedItemId && selectedItemId !== currentItemId) return 'other_item';
  if (reviewState === 'ignored') return 'ignored';
  if (reviewState === 'rejected') return 'rejected';
  if (reviewState === 'outside_rules') return 'outside';
  return 'pending';
}

const STATUS_RANK: Record<CatalogSourceRecordDto['confirmation'], number> = {
  confirmed: 0, pending: 1, outside: 2, other_item: 3, ignored: 4, rejected: 5,
};

function priceLabelForColumn(column: string): string | null {
  if (column === 'I') return '来源成本价';
  if (column === 'J') return '来源运营价';
  if (column === 'Y') return '来源其他价格';
  return null;
}

function priceRowsFor(amounts: Record<string, unknown> | null): Array<{ label: string; value: string }> {
  if (!amounts) return [];
  const rows: Array<{ label: string; value: string }> = [];
  for (const [column, raw] of Object.entries(amounts)) {
    const label = priceLabelForColumn(column);
    if (!label) continue;
    const value = fieldBusinessValue(raw as never);
    if (value === '待补' || value === '未知') continue;
    rows.push({ label, value });
  }
  return rows;
}

/** 商品“数据来源”业务视图：只返回业务字段，不返回原始 JSON、UUID、键名或证据路径。 */
export async function getCatalogSourceView(itemId: string, revision = 0): Promise<CatalogSourceViewDto> {
  if (!/^[a-f\d-]{36}$/i.test(itemId)) throw new Error('CATALOG_INVALID_INPUT');
  if (!Number.isInteger(revision) || revision < 0) throw new Error('CATALOG_INVALID_INPUT');

  if (revision > 0) {
    const [historicalCore, history] = await Promise.all([
      getCatalogDetailRevision(itemId, revision),
      getCatalogDetailHistoryDisplay(itemId),
    ]);
    const row = history.find((entry) => entry.revision === revision);
    return {
      item: {
        iceCode: historicalCore.item.iceCode,
        nameCn: historicalCore.item.nameCn,
        revision,
      },
      historical: true,
      sourceRecorded: false,
      sourceNote: '该历史版本未保存来源对应关系。如需核对当前资料的来源，请由您明确选择“查看当前资料来源（不是该历史版本）”。',
      systems: [],
      differences: [],
      price: {
        state: 'historical',
        adoptedCost: null,
        adoptedOperatingPrice: null,
        note: '历史版本不读取当前价格或当前来源，避免把当前资料当成该版本的事实。',
      },
      historicalFacts: row ? {
        reasonLabel: row.display.reasonLabel,
        recordedAtDisplay: row.display.recordedAtDisplay,
        actorLabel: row.display.actorLabel,
        changedFields: row.display.changedFields,
      } : null,
      currentReferenceAvailable: true,
    };
  }

  const [core, audit] = await Promise.all([
    getCatalogDetailCore(itemId),
    getCatalogDetailAudit(itemId),
  ]);
  let amounts: Awaited<ReturnType<typeof getCatalogAmounts>> | null = null;
  let priceFailure: 'no_permission' | 'read_failed' | null = null;
  try {
    amounts = await getCatalogAmounts(itemId);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    priceFailure = /无权|权限|停用|登录|FORBIDDEN|DENIED|42501/i.test(message) ? 'no_permission' : 'read_failed';
  }
  const observationById = new Map(audit.observations.map((observation) => [observation.observationId, observation]));
  const amountByObservation = new Map((amounts?.observations ?? []).map((entry) => [entry.observationId, entry.amounts as Record<string, unknown> | null]));

  const recordsFor = (source: SourceKey): CatalogSourceRecordDto[] => audit.candidates[source].map((candidate) => {
    const observation = observationById.get(candidate.observationId);
    const reviewState = observation?.reviewState ?? candidate.reviewState;
    const confirmation = confirmationFor(observation?.selectedItemId ?? null, reviewState, core.item.itemId);
    const sourceWarehouse = observedText(observation?.fields.warehouse) ?? (observation ? scopeWarehouse(observation.scope) : null);
    const differences = audit.differences
      .filter((difference) => difference.observationId === candidate.observationId && difference.field !== 'restricted_amount')
      .map((difference) => ({
        fieldLabel: CATALOG_FIELD_LABELS[difference.field] ?? '其他资料字段',
        adopted: fieldBusinessValue(difference.adopted ?? undefined),
        source: fieldBusinessValue(difference.observed ?? undefined),
      }));
    const adoptedInBatch = confirmation === 'confirmed';
    return {
      sourceSku: candidate.sku ?? observedText(observation?.fields.sku) ?? null,
      sourceName: candidate.name ?? observedText(observation?.fields.name) ?? null,
      sourceWarehouse,
      confirmation,
      confirmationLabel: CONFIRMATION_LABELS[confirmation],
      adoptedInBatch,
      differences,
      reviewNotes: reviewNotesFor(candidate),
      sourcePriceRows: priceRowsFor(amountByObservation.get(candidate.observationId) ?? null),
    };
  }).sort((left, right) => STATUS_RANK[left.confirmation] - STATUS_RANK[right.confirmation]);

  const systems: CatalogSourceSystemDto[] = (['bigseller', 'jushuitan'] as const).map((key) => ({
    key,
    label: SYSTEM_LABELS[key],
    records: recordsFor(key),
    inventoryNote: SYSTEM_INVENTORY_NOTES[key],
  }));
  const allRecords = systems.flatMap((system) => system.records);
  const adoptedCost = amounts?.adopted ? fieldBusinessValue(amounts.adopted.cost) : null;
  const adoptedOperating = amounts?.adopted ? fieldBusinessValue(amounts.adopted.operatingPrice) : null;

  return {
    item: { iceCode: core.item.iceCode, nameCn: core.item.nameCn, revision: core.item.revision },
    historical: false,
    sourceRecorded: allRecords.length > 0,
    sourceNote: allRecords.length === 0
      ? '当前资料没有记录到来源对应；这不等于商品不存在，也不把缺失当作已确认。'
      : null,
    systems,
    differences: audit.differences
      .filter((difference) => difference.field !== 'restricted_amount')
      .map((difference) => ({
        fieldLabel: CATALOG_FIELD_LABELS[difference.field] ?? '其他资料字段',
        adopted: fieldBusinessValue(difference.adopted ?? undefined),
        source: fieldBusinessValue(difference.observed ?? undefined),
      })),
    price: {
      state: amounts ? 'available' : (priceFailure ?? 'no_permission'),
      adoptedCost: adoptedCost === '待补' ? null : adoptedCost,
      adoptedOperatingPrice: adoptedOperating === '待补' ? null : adoptedOperating,
      note: amounts
        ? '当前采用进货价为人民币 / 单品，不含运费不含税。来源价格口径未确认时不计入当前采用价或估值。'
        : priceFailure === 'read_failed'
          ? '价格读取失败；已加载的来源记录保留，不显示 0。可重试。'
          : '当前账号无价格查看权限；不显示 0，也不猜测来源价格。',
    },
    historicalFacts: null,
    currentReferenceAvailable: false,
  };
}
