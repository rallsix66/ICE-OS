import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  accountIdentityLabel,
  buildConfirmBatch,
  buildConfirmMappingsIntent,
  buildDisableMappingIntent,
  buildInventoryDetailHref,
  buildInventoryDetailScopeHref,
  buildInventoryListHref,
  buildManualSyncIntent,
  buildRecheckMappingIntent,
  buildSettingsIntent,
  buildSyncQueueHref,
  buildSyncUrl,
  classifyActionError,
  classifyReadFailure,
  compareStableText,
  confirmMappingsIntentText,
  confirmOutcomeMessage,
  currentMappingStatusLabel,
  detailTotalsDisplay,
  disableMappingOutcomeMessage,
  emptyMappingDraft,
  errorCodeLabel,
  formatQuantity,
  formatTimestamp,
  groupRowsByUnit,
  historyRowDisplay,
  inventoryPageRange,
  inventoryScopeLabel,
  intervalDisplay,
  isActiveRunStatus,
  itemRowStatusDisplay,
  listCoverageDisplay,
  listEmptyStateText,
  listMappingLabel,
  manualSyncBlockedReason,
  manualSyncIntentText,
  mappingQueueOffset,
  mappingQueuePageRange,
  mappingDraftForQueueItem,
  mappingRowKey,
  mappingSuggestionDisplay,
  marketOptionLabel,
  marketOptionsForUi,
  marketsDisplay,
  normalizeIntervalInput,
  normalizePageNumber,
  parseInventorySearchParams,
  parseSyncSearchParams,
  pendingActionLabel,
  pendingBlocksWrites,
  pendingPanelDisplay,
  pendingRecoveryKey,
  quantityHeaderDisplay,
  readPendingConfirmPayload,
  readPendingMappingActionPayload,
  readPendingSettingsPayload,
  reconcileKindFromPendingAction,
  reconcileStateDisplay,
  recheckMappingIntentText,
  recheckOutcomeMessage,
  resolveScopeChange,
  runStatusDisplay,
  runWarehouseStatusLabel,
  scopeDisplay,
  scopedWarningsDisplay,
  selectedScopeWarehouseIds,
  settingsIntentText,
  settingsOutcomeMessage,
  sha256Hex,
  summarizeWarehouseCounts,
  triggerLabel,
  validateMappingDraft,
  verificationBadge,
  verificationNotice,
  warehouseStateLabel,
  warehouseSuccessRows,
} from '@/features/inventory/model';
import {
  normalizeItemDetail,
  normalizeList,
  normalizeMappingQueue,
  normalizeOverview,
  normalizePendingActions,
  normalizeRunDetail,
} from '@/features/inventory/normalize';
import type {
  InventoryItemDetailDto,
  InventoryItemWarehouseDto,
  InventoryListItemDto,
  InventoryMappingQueueItemDto,
  InventoryOverviewDto,
  InventoryScopeDto,
} from '@/features/inventory/types';

const ITEM_A = '11111111-1111-4111-8111-111111111111';
const WH_A = '33333333-3333-4333-8333-333333333333';
const WH_B = '44444444-4444-4444-8444-444444444444';
const MAPPING_A = '55555555-5555-4555-8555-555555555555';

function listItem(overrides: Partial<InventoryListItemDto> = {}): InventoryListItemDto {
  return {
    itemId: ITEM_A,
    iceCode: 'LS101295',
    nameCn: '测试商品',
    gtin: '6974674957332',
    market: 'PH',
    knownSubtotal: 1028,
    unitConflict: false,
    unitGroups: [{ unit: '件', knownSubtotal: 1028, rowCount: 2 }],
    coveredWarehouseCount: 2,
    scopeWarehouseCount: 2,
    notMappedWarehouses: [],
    unseenWarehouses: [],
    failedWarehouses: [],
    lastObservedAt: '2026-10-25T10:00:00.000Z',
    mapped: true,
    ...overrides,
  };
}

function detailRow(overrides: Partial<InventoryItemWarehouseDto> = {}): InventoryItemWarehouseDto {
  return {
    warehouseId: WH_A,
    warehouseName: '菲律宾新创启辰仓',
    externalId: 'ph-1',
    market: 'PH',
    externalSku: '6974674957332',
    unit: '件',
    onHand: 3122,
    orderLocked: 0,
    warehouseAvailable: 3122,
    activityReserved: 0,
    inTransit: 0,
    gtin: '6974674957332',
    observedAt: '2026-10-25T10:00:00.000Z',
    batchId: 'batch-1',
    excelRow: 2,
    itemRevision: 3,
    status: 'current',
    ...overrides,
  };
}

function detail(overrides: Partial<InventoryItemDetailDto> = {}): InventoryItemDetailDto {
  return {
    item: { id: ITEM_A, iceCode: 'WM0026', nameCn: '测试商品', gtin: null },
    scopeMode: 'filtered',
    warehouses: [detailRow()],
    totals: { byUnit: [{ unit: '件', knownSubtotal: 3122, rowCount: 1 }], knownSubtotal: 3122, unitConflict: false },
    history: [],
    mapping: [],
    scopedWarnings: [],
    ...overrides,
  };
}

function overview(overrides: Partial<InventoryOverviewDto> = {}): InventoryOverviewDto {
  const scope: InventoryScopeDto = {
    id: 'scope-1',
    version: 1,
    warehouseIds: [WH_A],
    labels: ['菲律宾新创启辰仓'],
    warehouseCount: 1,
    empty: false,
    lastAllSuccessAt: '2026-10-25T10:00:00.000Z',
  };
  return {
    account: { label: 'laiguoyong@KNZX019402', status: 'active', lastLoginOkAt: '2026-10-25T09:00:00.000Z' },
    warehouses: [
      { id: WH_A, externalId: 'ph-1', name: '菲律宾新创启辰仓', status: 'confirmed', market: 'PH' },
      { id: WH_B, externalId: 'vn-1', name: '越南青林湾仓库', status: 'confirmed', market: 'VN' },
    ],
    scope,
    settings: { enabled: true, intervalMinutes: 60, nextRunAt: null, configVersion: 2, planAnchorAt: null },
    worker: { online: true, lastSeenAt: '2026-10-25T10:00:00.000Z', host: 'host', pid: 1 },
    lastRun: null,
    runs: [],
    warehouseState: [],
    scopeLastAllSuccessAt: '2026-10-25T10:00:00.000Z',
    unmappedCount: 1,
    mappingQueueTotal: 3,
    marketOptions: [{ market: 'PH', warehouseNames: ['菲律宾新创启辰仓'], warehouseCount: 1 }],
    pendingAction: null,
    discoveredWarehouses: [],
    ...overrides,
  };
}

describe('时间/数量/状态显示', () => {
  it('确定性时间格式（上海）与非法值不编造', () => {
    expect(formatTimestamp('2026-10-25T02:30:00.000Z')).toBe('2026-10-25 10:30');
    expect(formatTimestamp('not-a-date')).toBe('');
    expect(formatTimestamp(null)).toBe('');
  });

  it('整数数量千分位，null 不当 0', () => {
    expect(formatQuantity(2056)).toBe('2,056');
    expect(formatQuantity(0)).toBe('0');
    expect(formatQuantity(-1234)).toBe('-1,234');
    expect(formatQuantity(null)).toBe('');
  });

  it('任务状态/触发方式/逐仓结果/错误码中文映射', () => {
    expect(runStatusDisplay('partial').tone).toBe('amber');
    expect(runStatusDisplay('success').active).toBe(false);
    expect(isActiveRunStatus('publishing')).toBe(true);
    expect(triggerLabel('manual')).toBe('手动触发');
    expect(runWarehouseStatusLabel('blocked')).toContain('阻断');
    expect(errorCodeLabel('INVENTORY_SCOPE_EMPTY')).toContain('参与仓库为空');
    expect(errorCodeLabel('INVENTORY_PENDING_RECOVERY_REQUIRED')).toContain('未完成原请求');
    expect(summarizeWarehouseCounts({ published: 2, failed: 1, blocked: 1 })).toContain('发布 2 仓');
  });

  it('账号身份/仓库状态/范围文案把失败与空范围说清楚', () => {
    expect(accountIdentityLabel('mismatch')).toContain('不一致');
    const failed = warehouseStateLabel({ lastSuccessAt: '2026-10-25T02:00:00.000Z', lastRunStatus: 'failed', failed: true, stale: true });
    expect(failed.label).toContain('失败');
    expect(failed.note).toContain('保留');
    const empty = scopeDisplay({ empty: true, warehouseCount: 0, version: 2 });
    expect(empty.empty).toBe(true);
    expect(empty.label).toContain('已停止发布');
    expect(empty.notice).toContain('回退旧范围');
    const normal = scopeDisplay({ empty: false, warehouseCount: 2, version: 1 });
    expect(normal.label).toBe('参与仓库 2 个');
  });

  it('每仓进度只按当前范围 warehouseIds 排序，并标记失败/旧值', () => {
    const rows = warehouseSuccessRows(overview({
      warehouseState: [{ warehouseId: WH_A, name: '菲律宾新创启辰仓', lastSuccessAt: '2026-10-20T02:00:00.000Z', lastPublishAt: null, lastRunStatus: 'failed', stale: true, failed: true, lastErrorCode: 'INVENTORY_PUBLISH_FAILED' }],
    }));
    expect(rows.map((row) => row.warehouseId)).toEqual([WH_A]);
    expect(rows[0].failed).toBe(true);
  });
});

describe('频率输入', () => {
  it('分钟/小时合法转换', () => {
    expect(normalizeIntervalInput('30', 'minutes')).toMatchObject({ ok: true, minutes: 30 });
    expect(normalizeIntervalInput('2', 'hours')).toMatchObject({ ok: true, minutes: 120 });
  });

  it('越界/非整数/空值给可读原因', () => {
    expect(normalizeIntervalInput('4', 'minutes').reason).toContain('不能小于');
    expect(normalizeIntervalInput('25', 'hours').reason).toContain('超过');
    expect(normalizeIntervalInput('1.5', 'minutes').ok).toBe(false);
    expect(normalizeIntervalInput('', 'minutes').reason).toContain('请填写');
  });

  it('保存值显示', () => {
    expect(intervalDisplay(120).display).toBe('每 2 小时（120 分钟）');
    expect(intervalDisplay(45).display).toBe('每 45 分钟');
  });
});

describe('库存页 query 与详情上下文（R1）', () => {
  it('解析搜索/仓库/市场/分页/详情/全仓', () => {
    const query = parseInventorySearchParams(new URLSearchParams(`q=wm0026&warehouse=${WH_A}&market=PH&page=3&item=${ITEM_A}&all=1`));
    expect(query).toMatchObject({ q: 'wm0026', warehouse: WH_A, market: 'PH', page: 3, item: ITEM_A, allWarehouses: true });
  });

  it('非法 uuid/市场/页码回退为安全值，超长搜索裁剪', () => {
    const query = parseInventorySearchParams(new URLSearchParams(`warehouse=hack&market=<script>&page=-5&item=nope&q=${'a'.repeat(200)}`));
    expect(query.warehouse).toBe('all');
    expect(query.market).toBe('all');
    expect(query.page).toBe(1);
    expect(query.item).toBe('');
    expect(query.allWarehouses).toBe(false);
    expect(query.q.length).toBe(120);
  });

  it('列表/详情链接保留同一筛选上下文；detail 默认不带 all', () => {
    const query = parseInventorySearchParams(new URLSearchParams(`q=ls&warehouse=${WH_A}&market=PH&page=2&item=${ITEM_A}`));
    expect(buildInventoryListHref(query)).toBe(`/dashboard/inventory?q=ls&warehouse=${WH_A}&market=PH&page=2`);
    expect(buildInventoryDetailHref(query)).toBe(`/dashboard/inventory?q=ls&warehouse=${WH_A}&market=PH&page=2&item=${ITEM_A}`);
    expect(buildInventoryDetailHref(query, { allWarehouses: true })).toContain('all=1');
    expect(buildInventoryDetailScopeHref(query, false)).not.toContain('all=1');
  });

  it('详情视角文案：默认沿用筛选，全仓显式', () => {
    expect(inventoryScopeLabel({ scopeMode: 'filtered', warehouseName: '菲律宾新创启辰仓', market: 'PH' })).toContain('沿用列表筛选');
    expect(inventoryScopeLabel({ scopeMode: 'all', market: 'PH' })).toContain('全仓');
  });

  it('分页范围/页码计算不越界', () => {
    expect(normalizePageNumber(-3)).toBe(1);
    const range = inventoryPageRange(120, 50, 3);
    expect(range).toMatchObject({ from: 101, to: 120, page: 3, pageCount: 3, hasPrev: true, hasNext: false });
    expect(inventoryPageRange(0, 50, 9)).toMatchObject({ from: 0, to: 0, page: 1, pageCount: 1 });
  });
});

describe('同步页 query（任务 + 对应搜索/分页）', () => {
  it('解析与构造保留 run/mapQ/mapPage', () => {
    const query = parseSyncSearchParams(new URLSearchParams(`run=${MAPPING_A}&mapQ=6973&mapPage=2`));
    expect(query).toEqual({ run: MAPPING_A, mapQ: '6973', mapPage: 2 });
    expect(buildSyncUrl(query)).toContain('/dashboard/sync?run=');
    expect(buildSyncUrl(query)).toContain('mapQ=6973');
    expect(buildSyncQueueHref(query, 3)).toContain('mapPage=3');
  });

  it('非法 run 丢弃、页码兜底', () => {
    expect(parseSyncSearchParams(new URLSearchParams('run=x&mapPage=0')).run).toBe('');
    expect(parseSyncSearchParams(new URLSearchParams('mapPage=0')).mapPage).toBe(1);
  });

  it('对应队列分页', () => {
    expect(mappingQueueOffset(3)).toBe(40);
    expect(mappingQueuePageRange(45, 3)).toMatchObject({ from: 41, to: 45, page: 3, pageCount: 3, hasPrev: true, hasNext: false });
  });
});

describe('范围：未修改 / 改变 / 明确清空（R7）', () => {
  it('勾选未变 → 未修改范围（scopeProvided=false）', () => {
    expect(resolveScopeChange({ savedWarehouseIds: [WH_A, WH_B], draftWarehouseIds: [WH_B, WH_A] })).toMatchObject({
      kind: 'unchanged',
      scopeProvided: false,
      warehouseIds: [],
    });
  });

  it('勾选变化 → 提交新范围', () => {
    expect(resolveScopeChange({ savedWarehouseIds: [WH_A], draftWarehouseIds: [WH_A, WH_B] })).toMatchObject({
      kind: 'changed',
      scopeProvided: true,
      warehouseIds: [WH_A, WH_B],
    });
  });

  it('全部取消 → 需二次确认的明确清空', () => {
    const cleared = resolveScopeChange({ savedWarehouseIds: [WH_A], draftWarehouseIds: [] });
    expect(cleared.kind).toBe('cleared');
    expect(cleared.scopeProvided).toBe(true);
    expect(cleared.warehouseIds).toEqual([]);
    expect(cleared.requiresConfirm).toBe(true);
    expect(resolveScopeChange({ savedWarehouseIds: [], draftWarehouseIds: [] }).kind).toBe('unchanged');
  });

  it('空范围阻断立即同步并给原因；登录失效也有明确原因', () => {
    expect(manualSyncBlockedReason({ scopeEmpty: true, accountStatus: 'active' })).toContain('参与仓库为空');
    expect(manualSyncBlockedReason({ scopeEmpty: false, accountStatus: 'needs_login' })).toContain('登录已失效');
    expect(manualSyncBlockedReason({ scopeEmpty: false, accountStatus: 'active' })).toBeNull();
  });

  it('范围初值优先用 warehouseIds，旧 labels 回退匹配', () => {
    expect(selectedScopeWarehouseIds(overview())).toEqual([WH_A]);
    const legacy = overview({
      scope: { id: '', version: 0, warehouseIds: [], labels: ['越南青林湾仓库'], warehouseCount: 1, empty: false, lastAllSuccessAt: null },
    });
    expect(selectedScopeWarehouseIds(legacy)).toEqual([WH_B]);
  });

  it('保存结果文案区分未修改/清空，且清空后无全绿表述', () => {
    const cleared = settingsOutcomeMessage({
      enabled: true,
      intervalMinutes: 60,
      warehouseCount: 0,
      scopeProvided: true,
      scopeEmpty: true,
      nextRunAt: '2026-10-26T02:00:00.000Z',
    });
    expect(cleared).toContain('已停止发布');
    expect(cleared).not.toContain('全部成功');
    const unchanged = settingsOutcomeMessage({
      enabled: true,
      intervalMinutes: 60,
      warehouseCount: 2,
      scopeProvided: false,
      scopeEmpty: false,
    });
    expect(unchanged).toContain('范围未修改');
  });
});

describe('市场选项（服务端证据优先）', () => {
  it('资源排序用确定性比较（不依赖 locale/ICU，避免 hydration 文本不一致）', () => {
    expect(compareStableText('a', 'b')).toBeLessThan(0);
    expect(compareStableText('b', 'a')).toBeGreaterThan(0);
    expect(compareStableText('同', '同')).toBe(0);
    expect(compareStableText(null, 'a')).toBeLessThan(0);
    // 中文码点排序在 Node 与浏览器一致（不调用 localeCompare）。
    const names = ['菲律宾仓', '越南仓', '印尼仓', 'DEE仓'];
    const sorted = [...names].sort(compareStableText);
    expect(sorted).toEqual(['DEE仓', '印尼仓', '菲律宾仓', '越南仓']);
  });

  it('市场选项排序确定', () => {
    const options = marketOptionsForUi([
      { market: 'VN', warehouseNames: [], warehouseCount: 0 },
      { market: 'ID', warehouseNames: [], warehouseCount: 0 },
      { market: 'PH', warehouseNames: [], warehouseCount: 0 },
    ]);
    expect(options.map((option) => option.market)).toEqual(['ID', 'PH', 'VN']);
  });

  it('排序/去重/去空，不生成当前页商品选项', () => {
    const options = marketOptionsForUi([
      { market: 'VN', warehouseNames: ['越南青林湾仓库', '越南青林湾仓库'], warehouseCount: 1 },
      { market: 'PH', warehouseNames: ['菲律宾新创启辰仓'], warehouseCount: 1 },
      { market: '', warehouseNames: [], warehouseCount: 0 },
    ]);
    expect(options.map((option) => option.market)).toEqual(['PH', 'VN']);
    expect(options[1].warehouseNames).toEqual(['越南青林湾仓库']);
    expect(marketOptionLabel(options[0])).toContain('PH（1 仓');
  });
});

describe('列表覆盖/缺口展示（R1）', () => {
  it('齐全时显示完整合计；有缺口时只显示已知小计', () => {
    const complete = listCoverageDisplay(listItem());
    expect(complete).toMatchObject({ complete: true, subtotalLabel: '多仓合计', subtotalText: '1,028' });
    const partial = listCoverageDisplay(listItem({
      coveredWarehouseCount: 1,
      scopeWarehouseCount: 2,
      unseenWarehouses: [{ warehouseId: WH_B, name: '越南青林湾仓库', lastKnownQty: 4139, lastKnownAt: '2026-10-20T02:00:00.000Z' }],
    }));
    expect(partial.complete).toBe(false);
    expect(partial.gapText).toContain('本次未见');
    expect(partial.gapText).toContain('4,139');
  });

  it('失败仓标旧时间；未对应仓单独列出；多单位不合计', () => {
    const failed = listCoverageDisplay(listItem({
      coveredWarehouseCount: 1,
      scopeWarehouseCount: 2,
      failedWarehouses: [{ warehouseId: WH_B, name: '越南青林湾仓库', lastSuccessAt: '2026-10-20T02:00:00.000Z' }],
    }));
    expect(failed.gapText).toContain('失败沿用旧值');
    expect(failed.gapText).toContain('2026-10-20 10:00');

    const unitConflict = listCoverageDisplay(listItem({
      unitConflict: true,
      knownSubtotal: null,
      unitGroups: [{ unit: '件', knownSubtotal: 1, rowCount: 1 }, { unit: '箱', knownSubtotal: 2, rowCount: 1 }],
    }));
    expect(unitConflict.subtotalText).toBe('单位不一致');
    expect(unitConflict.complete).toBe(false);
  });

  it('对应状态标签：未对应/部分缺值/已对应', () => {
    expect(listMappingLabel(listItem({ mapped: false, scopeWarehouseCount: 1, notMappedWarehouses: [{ warehouseId: '', name: '仓' }] })).label).toBe('未对应');
    expect(listMappingLabel(listItem({ notMappedWarehouses: [{ warehouseId: '', name: '仓' }] })).label).toBe('部分仓缺值');
    expect(listMappingLabel(listItem()).label).toBe('已对应');
  });

  it('空态区分读取失败/筛选无结果/没有记录', () => {
    expect(listEmptyStateText({ total: 0, hasFilters: false, readFailed: true }).title).toContain('读取失败');
    expect(listEmptyStateText({ total: 0, hasFilters: true }).title).toContain('没有符合条件');
    expect(listEmptyStateText({ total: 0, hasFilters: false }).title).toContain('还没有库存记录');
  });

  it('尚无批次的商品显示“尚未同步/未对应”，不显示 0 库存', () => {
    const notMapped = listCoverageDisplay(listItem({
      mapped: false,
      hasCurrentData: false,
      knownSubtotal: null,
      unitGroups: [],
      coveredWarehouseCount: 0,
      notMappedWarehouses: [{ warehouseId: WH_A, name: '仓A' }],
      scopeWarehouseCount: 2,
    }));
    expect(notMapped.subtotalLabel).toBe('未对应');
    expect(notMapped.subtotalText).toContain('未对应');
    expect(notMapped.gapText).toContain('不显示为 0');

    const noBatch = listCoverageDisplay(listItem({
      mapped: true,
      hasCurrentData: false,
      knownSubtotal: null,
      unitGroups: [],
      coveredWarehouseCount: 0,
      notMappedWarehouses: [],
      scopeWarehouseCount: 2,
    }));
    expect(noBatch.subtotalLabel).toContain('尚未同步');
    expect(noBatch.subtotalText).toContain('尚无当前库存');
    expect(noBatch.gapText).toContain('不显示为 0');
  });
});

describe('详情行/合计展示（R1：逐仓×SKU，不 LIMIT 1）', () => {
  it('服务端 totals 直接展示；多单位不可合计', () => {
    const single = detailTotalsDisplay(detail());
    expect(single.subtotalText).toBe('3,122');
    expect(single.gapText).toContain('缺口：无');
    const conflict = detailTotalsDisplay(detail({
      totals: {
        byUnit: [{ unit: '件', knownSubtotal: 3122, rowCount: 1 }, { unit: '箱', knownSubtotal: 10, rowCount: 1 }],
        knownSubtotal: null,
        unitConflict: true,
      },
    }));
    expect(conflict.unitConflict).toBe(true);
    expect(conflict.subtotalText).toBe('单位不一致');
    expect(conflict.unitGroupsText).toContain('单位分组');
  });

  it('同仓两 SKU 两行都展示，且缺口分开标本次未见/未对应/失败', () => {
    const rows = [
      detailRow({ externalSku: 'sku-1', onHand: 3122 }),
      detailRow({ externalSku: 'sku-2', onHand: 4139, warehouseId: WH_B }),
      detailRow({ externalSku: 'sku-3', status: 'unseen', onHand: null, lastKnownQty: 39, lastKnownAt: '2026-10-20T02:00:00.000Z' }),
      detailRow({ externalSku: 'sku-4', status: 'not_mapped', onHand: 5 }),
      detailRow({ externalSku: 'sku-5', status: 'stale', failed: true, onHand: 23, observedAt: '2026-10-20T02:00:00.000Z' }),
    ];
    const totals = detailTotalsDisplay(detail({
      warehouses: rows,
      totals: { byUnit: [{ unit: '件', knownSubtotal: 7261, rowCount: 2 }], knownSubtotal: 7261, unitConflict: false },
    }));
    expect(totals.coverageText).toContain('2/2');
    expect(totals.gapText).toContain('本次未见');
    expect(totals.gapText).toContain('未对应');
    expect(totals.gapText).toContain('失败沿用旧值');
    expect(groupRowsByUnit(rows)).toHaveLength(1);
  });

  it('行状态显示：真实 0、本次未见（上次已知）、失败旧值、未对应', () => {
    expect(itemRowStatusDisplay(detailRow({ onHand: 0 })).quantityText).toContain('0');
    const unseen = itemRowStatusDisplay(detailRow({ status: 'unseen', onHand: null, lastKnownQty: 4139, lastKnownAt: '2026-10-20T02:00:00.000Z' }));
    expect(unseen.label).toContain('本次未见');
    expect(unseen.note).toContain('4,139');
    expect(unseen.note).toContain('不计入本次合计');
    const stale = itemRowStatusDisplay(detailRow({ status: 'stale', failed: true, onHand: 23, observedAt: '2026-10-20T02:00:00.000Z', lastErrorCode: 'INVENTORY_PUBLISH_FAILED' }));
    expect(stale.label).toContain('失败沿用旧值');
    expect(stale.note).toContain('2026-10-20 10:00');
    const unmapped = itemRowStatusDisplay(detailRow({ status: 'not_mapped', onHand: 5 }));
    expect(unmapped.label).toBe('未对应');
    expect(unmapped.note).toContain('不计入');
  });

  it('历史行显示 SKU/单位/资料版本与状态；告警翻译', () => {
    const display = historyRowDisplay({
      batchId: 'b',
      warehouseName: '仓',
      runId: 'r',
      publishedAt: '2026-10-25T02:00:00.000Z',
      onHand: 10,
      previousOnHand: 8,
      externalSku: 'sku',
      unit: '件',
      itemRevision: 3,
      rowStatus: 'adopted',
    }, 0);
    expect(display.changeText).toBe('8 → 10');
    expect(display.sourceText).toContain('sku');
    expect(display.sourceText).toContain('第 3 版');
    expect(scopedWarningsDisplay(['not_seen', 'publish_failed_keep_previous'])).toHaveLength(2);
  });
});

describe('商品对应 R2：草稿校验与批量只作用于勾选行', () => {
  const queueItem: InventoryMappingQueueItemDto = {
    externalSku: '6973517482611',
    warehouseId: WH_A,
    warehouseExternalId: 'ph-1',
    warehouseName: '菲律宾新创启辰仓',
    market: 'PH',
    rowCount: 2,
    latestRunAt: '2026-10-25T10:00:00.000Z',
    suggestion: null,
    candidateId: null,
    currentMapping: null,
  };

  it('没有建议时可手动选择确认；建议只展示出处不自动提交', () => {
    const noSuggestion = mappingSuggestionDisplay(queueItem);
    expect(noSuggestion.hasSuggestion).toBe(false);
    expect(noSuggestion.evidenceText).toContain('手动搜索');
    const withSuggestion = mappingSuggestionDisplay({
      ...queueItem,
      suggestion: { itemId: ITEM_A, iceCode: 'LS101295', nameCn: '商品', evidence: '样表第 2 行', source: 'bs_sample_export' },
    });
    expect(withSuggestion.hasSuggestion).toBe(true);
    expect(withSuggestion.evidenceText).toContain('样表第 2 行');
    expect(withSuggestion.sourceText).toContain('冻结样表');
  });

  it('草稿必填项：目标商品/单位（无默认件）/理由/仓库', () => {
    const draft = emptyMappingDraft('ph-1::sku', 'sku');
    expect(draft.unit).toBe('');
    const invalid = validateMappingDraft(draft);
    expect(invalid.ok).toBe(false);
    expect(invalid.errors.join('；')).toContain('目标商品');
    expect(invalid.errors.join('；')).toContain('单位');
    expect(invalid.errors.join('；')).toContain('理由');
    expect(invalid.errors.join('；')).toContain('仓库');
    expect(invalid.payload).toEqual([]);

    const valid = validateMappingDraft({
      ...draft,
      itemId: ITEM_A,
      unit: '件',
      reason: '已核对包装',
      warehouseExternalIds: ['ph-1', 'vn-1'],
    });
    expect(valid.ok).toBe(true);
    expect(valid.payload).toHaveLength(2);
    expect(valid.payload[0]).toMatchObject({ externalSku: 'sku', warehouseExternalId: 'ph-1', unit: '件', reason: '已核对包装' });
  });

  it('换绑必须带旧版本；批量未勾选整批拒绝；只提交勾选行', () => {
    const rebindRequireVersion = validateMappingDraft({ ...emptyMappingDraft('ph-1::sku', 'sku'), itemId: ITEM_A, unit: '件', reason: '换绑', warehouseExternalIds: ['ph-1'], expectedVersion: null }, { requireVersion: true });
    expect(rebindRequireVersion.ok).toBe(false);
    expect(rebindRequireVersion.errors.join('；')).toContain('旧版本');

    expect(buildConfirmBatch({ selectedRowKeys: [], drafts: [] }).ok).toBe(false);

    const completeA = { ...emptyMappingDraft('ph-1::sku-a', 'sku-a'), itemId: ITEM_A, unit: '件', reason: 'ok', warehouseExternalIds: ['ph-1'] };
    const incompleteB = emptyMappingDraft('vn-1::sku-b', 'sku-b');
    const batch = buildConfirmBatch({ selectedRowKeys: ['ph-1::sku-a'], drafts: [completeA, incompleteB] });
    expect(batch.ok).toBe(true);
    expect(batch.entries).toHaveLength(1);
    expect(batch.entries[0].externalSku).toBe('sku-a');

    const withIncompleteSelected = buildConfirmBatch({ selectedRowKeys: ['ph-1::sku-a', 'vn-1::sku-b'], drafts: [completeA, incompleteB] });
    expect(withIncompleteSelected.ok).toBe(false);
    expect(withIncompleteSelected.incompleteRowKeys).toEqual(['vn-1::sku-b']);
  });

  it('同 SKU 两仓按行身份隔离：只选一仓不会命中另一仓草稿（W1 反例）', () => {
    const phItem: InventoryMappingQueueItemDto = {
      ...queueItem,
      warehouseId: WH_A,
      warehouseExternalId: 'ph-1',
      warehouseName: '菲律宾新创启辰仓',
    };
    const vnItem: InventoryMappingQueueItemDto = {
      ...queueItem,
      warehouseId: WH_B,
      warehouseExternalId: 'vn-1',
      warehouseName: '越南青林湾仓',
    };
    expect(mappingRowKey(phItem.warehouseExternalId, phItem.externalSku)).not.toBe(mappingRowKey(vnItem.warehouseExternalId, vnItem.externalSku));

    const phDraft = { ...mappingDraftForQueueItem(phItem), itemId: ITEM_A, unit: '件', reason: 'PH 验证' };
    const plan = buildConfirmBatch({ selectedRowKeys: [mappingRowKey(phItem.warehouseExternalId, phItem.externalSku)], drafts: [phDraft] });
    expect(plan.ok).toBe(true);
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]).toMatchObject({ externalSku: phItem.externalSku, warehouseExternalId: 'ph-1' });

    // 选择另一仓但没有其草稿 → 必须点名缺内容，不能拿同 SKU 的 PH 草稿顶替。
    const cross = buildConfirmBatch({ selectedRowKeys: [mappingRowKey(vnItem.warehouseExternalId, vnItem.externalSku)], drafts: [phDraft] });
    expect(cross.ok).toBe(false);
    expect(cross.incompleteRowKeys).toEqual([mappingRowKey('vn-1', vnItem.externalSku)]);
  });

  it('队列草稿带 currentMapping.version；验证标记进入 payload 与 intent', () => {
    const current = {
      ...queueItem,
      currentMapping: { id: MAPPING_A, status: 'disabled', version: 7, itemId: ITEM_A, unit: '件' },
      mappingStatus: 'disabled',
      verification: true,
      unitUnconfirmed: true,
      reason: '验证数据，业务包装单位待确认',
    };
    const draft = mappingDraftForQueueItem(current);
    expect(draft.expectedVersion).toBe(7);
    expect(draft.verification).toBe(true);
    expect(draft.warehouseExternalIds).toEqual(['ph-1']);

    const validated = validateMappingDraft({ ...draft, itemId: ITEM_A, unit: '件', reason: '验证数据，业务包装单位待确认' }, { requireVersion: true });
    expect(validated.ok).toBe(true);
    expect(validated.payload[0].expectedVersion).toBe(7);
    expect(validated.payload[0].verification).toBe(true);
    const withoutVerification = confirmMappingsIntentText(validated.payload.map((entry) => ({ ...entry, verification: false })));
    expect(confirmMappingsIntentText(validated.payload)).not.toBe(withoutVerification);
    expect(verificationBadge(current)).toContain('验证数据');
  });

  it('结果文案：跳过原因可读，不冒充已计入', () => {
    const message = confirmOutcomeMessage(1, [{ externalSku: 'sku', reason: 'INVENTORY_UNIT_CONFLICT' }]);
    expect(message).toContain('1 条');
    expect(message).toContain('单位');
    expect(message).toContain('不会自动换算');
    expect(recheckOutcomeMessage()).toContain('立即退出');
    expect(disableMappingOutcomeMessage()).toContain('停用');
    expect(currentMappingStatusLabel('recheck')).toContain('已停止归集');
  });
});

describe('F2 覆盖/缺口/市场/历史版本（v3 新 DTO）', () => {
  it('列表 5/7：四类缺口分别说明，不出现“缺口：无”；验证数据不当正式合计', () => {
    const item = listItem({
      coverage: { scopeWarehouses: 7, coveredWarehouses: 5 },
      coveredWarehouseCount: 5,
      scopeWarehouseCount: 7,
      notMappedWarehouses: [
        { warehouseId: WH_A, externalId: 'ph-1', name: '菲律宾新创启辰仓', reason: 'unmapped_source', sourceRowCount: 2, sourceSkus: ['6973517482611', 'ICEWM0026'] },
        { warehouseId: WH_B, externalId: 'th-1', name: 'DEE泰国仓', reason: 'no_source', sourceRowCount: 0, sourceSkus: [] },
      ],
      unseenWarehouses: [{ warehouseId: 'w3', externalId: 'my-1', name: 'MY仓', reason: 'unseen', lastKnownQty: 674 }],
      failedWarehouses: [{ warehouseId: 'w4', externalId: 'vn-1', name: '越南青林湾仓', reason: 'failed', lastSuccessAt: '2026-10-26T03:29:45.675Z' }],
      markets: ['VN', 'ID', 'MY', 'PH'],
      hasUnknownMarket: true,
      verificationOnly: true,
      unitUnconfirmed: true,
    });
    const coverage = listCoverageDisplay(item);
    expect(coverage.coverageText).toBe('覆盖 5/7 仓');
    expect(coverage.gapText).not.toContain('缺口：无');
    expect(coverage.gapText).toContain('有来源但未对应');
    expect(coverage.gapText).toContain('没有该 SKU 的来源记录');
    expect(coverage.gapText).toContain('本次未见');
    expect(coverage.gapText).toContain('失败沿用旧值');
    expect(coverage.complete).toBe(false);
    expect(coverage.subtotalLabel).toBe('验证数据小计');
    expect(verificationNotice(true, true)).toContain('业务包装单位待确认');
    expect(verificationNotice(false, false)).toBeNull();
  });

  it('市场：多已知市场给集合，未知单独提示；单市场筛选保留市场', () => {
    const multi = marketsDisplay(['VN', 'ID', 'MY', 'PH'], true, 'all');
    expect(multi.text).toContain('VN');
    expect(multi.text).toContain('PH');
    expect(multi.text).toContain('部分仓市场待确认');
    expect(multi.text).not.toBe('市场待确认');
    const single = marketsDisplay(['VN', 'ID', 'MY', 'PH'], true, 'ID');
    expect(single.text).toContain('ID');
    expect(single.text).toContain('部分仓市场待确认');
    expect(marketsDisplay([], true, 'all').text).toBe('部分仓市场待确认');
    expect(marketsDisplay([], false, 'all').text).toBe('市场待确认');
  });

  it('详情按同一范围列出所有仓（含空 rows 原因）；5/7 不缩成 5/5 全绿', () => {
    const detail = {
      item: { id: ITEM_A, iceCode: 'LS101295', nameCn: '海茴香焕肤水', gtin: '6974674957332' },
      scopeMode: 'filtered' as const,
      warehouses: [
        { warehouseId: WH_A, warehouseName: '越南青林湾仓', externalId: 'vn-1', market: 'VN', externalSku: '6974674957332', unit: '件', onHand: 899, orderLocked: null, warehouseAvailable: null, activityReserved: null, inTransit: null, gtin: null, observedAt: '2026-10-26T03:31:13.035Z', batchId: 'b1', status: 'current' as const },
        { warehouseId: WH_B, warehouseName: '菲律宾新创启辰仓', externalId: 'ph-1', market: 'PH', externalSku: '6974674957332', unit: '件', onHand: 129, orderLocked: null, warehouseAvailable: null, activityReserved: null, inTransit: null, gtin: null, observedAt: '2026-10-26T03:31:13.035Z', batchId: 'b1', status: 'current' as const },
        { warehouseId: 'w3', warehouseName: 'DEE泰国仓', externalId: 'th-1', market: 'TH', externalSku: '6974674957332', unit: null, onHand: null, orderLocked: null, warehouseAvailable: null, activityReserved: null, inTransit: null, gtin: null, observedAt: null, batchId: null, status: 'not_mapped' as const, reason: 'unmapped_source', sourceRowCount: 3, sourceSkus: ['6974674957332'] },
        { warehouseId: 'w4', warehouseName: 'MY仓', externalId: 'my-1', market: 'MY', externalSku: '6974674957332', unit: null, onHand: null, orderLocked: null, warehouseAvailable: null, activityReserved: null, inTransit: null, gtin: null, observedAt: null, batchId: null, status: 'not_mapped' as const, reason: 'no_source' },
      ],
      totals: { byUnit: [{ unit: '件', knownSubtotal: 1028, rowCount: 2 }], knownSubtotal: 1028, unitConflict: false, warehouseCount: 2, lastObservedAt: '2026-10-26T03:31:13.035Z' },
      coverage: { scopeWarehouses: 7, coveredWarehouses: 5 },
      markets: ['VN', 'PH', 'TH', 'MY'],
      hasUnknownMarket: true,
      verificationOnly: true,
      unitUnconfirmed: true,
      itemRevisionMissing: 2,
      history: [],
      mapping: [],
    };
    const totals = detailTotalsDisplay(detail);
    expect(totals.coverageText).toBe('有当前值 5/7 仓');
    expect(totals.gapText).not.toContain('缺口：无');
    expect(totals.gapText).toContain('有来源但未对应');
    expect(totals.gapText).toContain('没有该 SKU 的来源记录');
    expect(totals.gapText).toContain('验证数据');
    expect(totals.label).toBe('验证数据小计');
    const notMapped = itemRowStatusDisplay(detail.warehouses[2]);
    expect(notMapped.note).toContain('有来源但未对应');
    expect(notMapped.note).toContain('来源 3 行');
    const noSource = itemRowStatusDisplay(detail.warehouses[3]);
    expect(noSource.note).toContain('没有该 SKU 的来源记录');
  });

  it('历史 itemRevision=null 显示“当时资料版本缺失”；数量变化不称销量', () => {
    const display = historyRowDisplay({
      batchId: 'b1', runId: 'r1', warehouseName: '越南青林湾仓', externalSku: '757577407113', unit: '件',
      onHand: 83022, previousOnHand: 83025, observationAt: '2026-10-26T03:29:45.675Z', publishedAt: '2026-10-26T03:31:13.035Z',
      rowStatus: 'adopted', itemRevision: null,
    }, 0);
    expect(display.sourceText).toContain('当时资料版本缺失');
    expect(display.sourceText).not.toContain('资料第');
    expect(display.changeText).toBe('83,025 → 83,022');
    expect(display.changeText).not.toContain('销量');
    expect(display.rowStatusLabel).toContain('已采用');
  });

  it('normalize 接收 v3 字段：list coverage/notMapped 原因、detail 全范围仓与 markets', () => {
    const list = normalizeList({
      total: 1, offset: 0, limit: 50, items: [{
        itemId: ITEM_A, iceCode: 'LS101295', nameCn: '海茴香焕肤水',
        coveredWarehouseCount: 5, scopeWarehouseCount: 7,
        coverage: { scopeWarehouses: 7, coveredWarehouses: 5 },
        notMappedWarehouses: [{ warehouseId: WH_A, externalId: 'ph-1', name: 'PH仓', reason: 'unmapped_source', sourceRowCount: 2, sourceSkus: ['6974674957332'] }],
        markets: ['VN', 'ID', 'PH'], hasUnknownMarket: true, verificationOnly: true, unitUnconfirmed: true, itemRevisionMissing: 3,
        unitGroups: [{ unit: '件', knownSubtotal: 1028, rowCount: 2 }], knownSubtotal: 1028,
      }],
      scope: { warehouseCount: 7, lastAllSuccessAt: null, empty: false },
    });
    const item = list.items[0];
    expect(item.coverage).toEqual({ scopeWarehouses: 7, coveredWarehouses: 5 });
    expect(item.notMappedWarehouses[0]).toMatchObject({ reason: 'unmapped_source', sourceRowCount: 2, sourceSkus: ['6974674957332'] });
    expect(item.markets).toEqual(['VN', 'ID', 'PH']);
    expect(item.hasUnknownMarket).toBe(true);
    expect(item.verificationOnly).toBe(true);
    expect(item.unitUnconfirmed).toBe(true);
    expect(item.itemRevisionMissing).toBe(3);
    expect(listCoverageDisplay(item).coverageText).toBe('覆盖 5/7 仓');

    const detail = normalizeItemDetail({
      item: { id: ITEM_A, iceCode: 'LS101295', nameCn: '海茴香焕肤水' },
      scopeMode: 'filtered',
      coverage: { scopeWarehouses: 7, coveredWarehouses: 5 },
      markets: ['VN', 'PH'], hasUnknownMarket: true, verificationOnly: true, unitUnconfirmed: true, itemRevisionMissing: 2,
      warehouses: [
        { warehouseId: WH_A, warehouseName: '越南青林湾仓', externalId: 'vn-1', market: 'VN', status: 'current', rows: [{ externalSku: '6974674957332', unit: '件', onHand: 899, status: 'current', itemRevision: null }] },
        { warehouseId: 'w3', warehouseName: 'DEE泰国仓', externalId: 'th-1', market: 'TH', status: 'not_mapped', reason: 'unmapped_source', sourceRowCount: 3, sourceSkus: ['6974674957332'], rows: [] },
        { warehouseId: 'w4', warehouseName: 'MY仓', externalId: 'my-1', market: 'MY', status: 'failed', reason: 'failed', lastSuccessAt: '2026-10-26T03:29:45.675Z', rows: [] },
      ],
      totals: { byUnit: [{ unit: '件', knownSubtotal: 899, rowCount: 1 }], knownSubtotal: 899, unitConflict: false, warehouseCount: 1 },
      history: [],
      mapping: [],
    });
    expect(detail.warehouses.map((row) => row.warehouseName)).toEqual(['越南青林湾仓', 'DEE泰国仓', 'MY仓']);
    const empty = detail.warehouses.filter((row) => row.onHand === null);
    expect(empty.length).toBeGreaterThanOrEqual(2);
    expect(empty[0].reason).toBe('unmapped_source');
    expect(empty[0].sourceRowCount).toBe(3);
    expect(detail.coverage).toEqual({ scopeWarehouses: 7, coveredWarehouses: 5 });
    expect(detail.markets).toEqual(['VN', 'PH']);
    expect(detail.hasUnknownMarket).toBe(true);
    expect(detail.verificationOnly).toBe(true);
    expect(detail.itemRevisionMissing).toBe(2);
  });
});

describe('R5 pending 状态机与动作错误分类', () => {
  it('pending 存在即锁新写；本人文案点名原操作，他人只显示忙碌', () => {
    const pending = { requestId: MAPPING_A, action: 'confirm_inventory_mapping', createdAt: '2026-10-25T02:00:00.000Z', payload: { mappings: [] }, intent: 'a'.repeat(64) };
    expect(pendingBlocksWrites(null)).toBe(false);
    expect(pendingBlocksWrites(pending)).toBe(true);
    const panel = pendingPanelDisplay(pending);
    expect(panel.locked).toBe(true);
    expect(panel.title).toContain('商品对应');
    expect(pendingActionLabel('request_inventory_manual_sync')).toBe('立即同步');

    const foreign = { requestId: null, action: 'confirm_inventory_mapping', createdAt: '2026-10-25T02:00:00.000Z', payload: {}, foreign: true };
    expect(pendingBlocksWrites(foreign)).toBe(true);
    const foreignPanel = pendingPanelDisplay(foreign);
    expect(foreignPanel.title).toContain('另一位管理员');
    expect(foreignPanel.detail).toContain('不显示 requestId');
    expect(pendingRecoveryKey(foreign)).not.toBe(pendingRecoveryKey(pending));
  });

  it('核对四态：只有明确未找到才提供重试；解锁失败保留原请求', () => {
    const found = reconcileStateDisplay('found');
    expect(found.canRetry).toBe(false);
    expect(found.dismissPending).toBe(true);
    const notFound = reconcileStateDisplay('not_found');
    expect(notFound.canRetry).toBe(true);
    expect(notFound.nextStep).toContain('requestId');
    const failed = reconcileStateDisplay('failed');
    expect(failed.canRetry).toBe(false);
    expect(failed.dismissPending).toBe(false);
    expect(failed.nextStep).toContain('保留原请求');
    const unlockFailed = reconcileStateDisplay('found_unlock_failed');
    expect(unlockFailed.canRetry).toBe(false);
    expect(unlockFailed.dismissPending).toBe(false);
    expect(unlockFailed.title).toContain('恢复锁未解除');
    expect(unlockFailed.nextStep).toContain('不要发起新的写操作');
  });

  it('pending payload 原样读回（settings/confirm/disable）', () => {
    expect(readPendingSettingsPayload({ enabled: true, intervalMinutes: 30, scopeProvided: true, warehouseIds: [WH_A] })).toMatchObject({
      enabled: true,
      intervalMinutes: 30,
      scopeProvided: true,
      warehouseIds: [WH_A],
    });
    expect(readPendingConfirmPayload({ mappings: [{ externalSku: 'sku', warehouseExternalId: 'ph-1', itemId: ITEM_A, unit: '件', reason: 'r', expectedVersion: null }] })?.mappings).toHaveLength(1);
    expect(readPendingMappingActionPayload({ mappingId: MAPPING_A, expectedVersion: 2, reason: '停用' })).toMatchObject({ mappingId: MAPPING_A, expectedVersion: 2 });
    expect(reconcileKindFromPendingAction('disable_inventory_mapping')).toBe('disable');
  });

  it('错误分类：pending 码/确定失败/连接中断（未知）分开', () => {
    const pendingError = Object.assign(new Error('INVENTORY_PENDING_RECOVERY_REQUIRED'), { code: 'P0001' });
    const pendingClassified = classifyActionError(pendingError);
    expect(pendingClassified.code).toBe('INVENTORY_PENDING_RECOVERY_REQUIRED');
    expect(pendingClassified.outcomeUnknown).toBe(false);
    expect(pendingClassified.definite).toBe(false);

    const conflict = classifyActionError(new Error('INVENTORY_MAPPING_VERSION_CONFLICT'));
    expect(conflict.definite).toBe(true);

    const network = classifyActionError(new Error('Connection terminated unexpectedly'));
    expect(network.outcomeUnknown).toBe(true);
    expect(network.definite).toBe(false);
  });

  it('读取失败分类：无权限/未就绪/一般失败', () => {
    expect(classifyReadFailure(Object.assign(new Error('denied'), { code: '42501' }))).toBe('forbidden');
    expect(classifyReadFailure(new Error('function catalog.read_inventory_list() does not exist'))).toBe('unavailable');
    expect(classifyReadFailure(new Error('boom'))).toBe('read_failed');
  });
});

describe('幂等 intent（sha256 64 hex）', () => {
  it('纯 TS SHA-256 与 node:crypto 一致', () => {
    for (const input of ['', 'abc', 'inventory.settings.v2|enabled=true', '中文载荷']) {
      expect(sha256Hex(input)).toBe(createHash('sha256').update(input, 'utf8').digest('hex'));
    }
  });

  it('设置 intent 区分“未改范围/明确清空”，并排序仓库', () => {
    const unchanged = settingsIntentText({ enabled: true, intervalMinutes: 60, scopeProvided: false, warehouseIds: [] });
    const cleared = settingsIntentText({ enabled: true, intervalMinutes: 60, scopeProvided: true, warehouseIds: [] });
    expect(unchanged).not.toBe(cleared);
    // v4 结构化编码：字段是 JSON 键值，仍能区分“未改范围/明确清空”。
    expect(unchanged).toContain('"scopeProvided":false');
    expect(cleared).toContain('"scopeProvided":true');
    expect(unchanged).toContain('inventory.settings.v4|');
    const a = settingsIntentText({ enabled: true, intervalMinutes: 60, scopeProvided: true, warehouseIds: [WH_A, WH_B] });
    const b = settingsIntentText({ enabled: true, intervalMinutes: 60, scopeProvided: true, warehouseIds: [WH_B, WH_A] });
    expect(a).toBe(b);
    expect(buildSettingsIntent({ enabled: false, intervalMinutes: 30, scopeProvided: false, warehouseIds: [] })).toMatch(/^[a-f0-9]{64}$/);
  });

  it('确认 intent 含仓库/单位/理由/旧版本；顺序无关', () => {
    const input = {
      externalSku: 'sku',
      warehouseExternalId: 'ph-1',
      itemId: ITEM_A,
      unit: '件',
      reason: '核对',
      expectedVersion: 2,
    };
    const text = buildConfirmMappingsIntent([input]);
    expect(buildConfirmMappingsIntent([{ ...input }])).toBe(text);
    expect(buildConfirmMappingsIntent([input])).toMatch(/^[a-f0-9]{64}$/);
    expect(confirmOutcomeMessage(0, [])).toContain('0 条');
    expect(manualSyncIntentText()).toContain('manual_sync');
    expect(buildManualSyncIntent()).toMatch(/^[a-f0-9]{64}$/);
  });

  it('停用/重核 intent 必须含理由与版本', () => {
    expect(recheckMappingIntentText({ mappingId: MAPPING_A, expectedVersion: 2, reason: '重核' })).toContain('重核');
    expect(buildRecheckMappingIntent({ mappingId: MAPPING_A, expectedVersion: 2, reason: '重核' })).toMatch(/^[a-f0-9]{64}$/);
    expect(buildDisableMappingIntent({ mappingId: MAPPING_A, expectedVersion: 2, reason: '停用' })).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('normalize：契约 JSON → 页面 DTO（含别名/缺省）', () => {
  it('overview 新增字段（scope/marketOptions/pending/discovered）', () => {
    const normalized = normalizeOverview({
      account: { label: 'acct', status: 'active' },
      warehouses: [{ id: WH_A, externalId: 'ph-1', name: '菲律宾仓', status: 'confirmed', market: 'PH' }],
      scope: { id: 's', version: 2, warehouseIds: [WH_A], labels: ['菲律宾仓'], warehouseCount: 1, empty: false, lastAllSuccessAt: null },
      settings: { enabled: true, intervalMinutes: 60, scopeEmpty: true },
      marketOptions: [{ market: 'PH', warehouseNames: ['菲律宾仓'], warehouseCount: 1 }],
      pendingAction: { requestId: MAPPING_A, action: 'disable_inventory_mapping', createdAt: '2026-10-25T02:00:00.000Z', payload: { mappingId: MAPPING_A } },
      discoveredWarehouses: [{ externalId: 'new-1', name: '新仓', status: 'candidate' }],
      mappingQueueTotal: 7,
      unmappedCount: 7,
    });
    expect(normalized.settings.scopeEmpty).toBe(true);
    expect(normalized.settings.scopeWarehouseCount).toBe(1);
    expect(normalized.marketOptions[0].market).toBe('PH');
    expect(normalized.pendingAction?.requestId).toBe(MAPPING_A);
    expect(normalized.discoveredWarehouses[0].name).toBe('新仓');
    expect(normalized.mappingQueueTotal).toBe(7);
  });

  it('list 别名兼容（warehouseNames/unmappedWarehouses/unitGroups）', () => {
    const list = normalizeList({
      total: 1,
      offset: 0,
      limit: 50,
      items: [{
        itemId: ITEM_A,
        iceCode: 'WM0026',
        nameCn: '商品',
        knownSubtotal: 7261,
        unitConflict: false,
        warehouseCount: 2,
        warehouseNames: ['仓A', '仓B'],
        unknownWarehouses: ['账号级默认'],
        unseen_warehouses: [{ warehouseName: '仓B', lastKnownQty: 4139, lastKnownAt: '2026-10-20T02:00:00.000Z' }],
        failed_warehouses: [{ warehouseName: '仓C', lastSuccessAt: '2026-10-19T02:00:00.000Z' }],
      }],
      scope: { warehouseCount: 2, lastAllSuccessAt: null, empty: false },
      marketOptions: [{ market: 'PH', warehouseNames: ['仓A'], warehouseCount: 1 }],
    });
    const item = list.items[0];
    expect(item.unitGroups).toEqual([]);
    expect(item.notMappedWarehouses[0].name).toBe('账号级默认');
    expect(item.unseenWarehouses[0].lastKnownQty).toBe(4139);
    expect(item.failedWarehouses[0].lastSuccessAt).toBe('2026-10-19T02:00:00.000Z');
    expect(item.mapped).toBe(false);
    expect(list.marketOptions?.[0].market).toBe('PH');
  });

  it('item detail 行状态别名（no_current→本次未见）与 totals 兜底', () => {
    const normalized = normalizeItemDetail({
      item: { id: ITEM_A, iceCode: 'WM0026', nameCn: '商品' },
      warehouses: [
        { warehouseName: '菲律宾仓', externalSku: 'sku-1', unit: '件', onHand: 3122, status: 'current' },
        { warehouseName: '菲律宾仓', externalSku: 'sku-2', unit: '件', onHand: 4139, status: 'current' },
        { warehouseName: '菲律宾仓', externalSku: 'sku-3', unit: '件', previousOnHand: 39, status: 'no_current' },
      ],
    });
    expect(normalized.warehouses[2].status).toBe('unseen');
    expect(normalized.warehouses[2].lastKnownQty).toBe(39);
    expect(normalized.totals.knownSubtotal).toBe(7261);
    expect(normalized.totals.unitConflict).toBe(false);
  });

  it('mapping queue 按 (SKU×仓库) 对返回，含建议出处/候选状态', () => {
    const queue = normalizeMappingQueue({
      total: 1,
      offset: 0,
      limit: 20,
      items: [{
        externalSku: 'sku-1',
        warehouseId: WH_A,
        warehouseExternalId: 'ph-1',
        warehouseName: '菲律宾仓',
        market: 'PH',
        occurrences: 2,
        latestRunAt: '2026-10-25T02:00:00.000Z',
        suggestion: { itemId: ITEM_A, iceCode: 'LS101295', nameCn: '商品', evidence: '样表', source: 'bs_sample_export' },
        candidateStatus: 'pending',
        mappingStatus: null,
      }],
    });
    const item = queue.items[0];
    expect(item.warehouseExternalId).toBe('ph-1');
    expect(item.rowCount).toBe(2);
    expect(item.suggestion?.source).toBe('bs_sample_export');
    expect(item.currentMapping).toBeNull();
  });

  it('item detail 展开“每仓多 SKU”为多行，不丢同仓第二个 SKU；unseen 保留上次已知', () => {
    const normalized = normalizeItemDetail({
      item: { itemId: ITEM_A, iceCode: 'WM0026', nameCn: '商品' },
      warehouses: [
        {
          warehouseId: WH_A,
          name: '菲律宾仓',
          market: 'PH',
          status: 'current',
          stale: false,
          rows: [
            { externalSku: 'sku-1', unit: '件', onHand: 3122, observedAt: '2026-10-25T02:00:00.000Z', batchId: 'b', excelRow: 2, itemRevision: 3 },
            { externalSku: 'sku-2', unit: '件', onHand: 4139, observedAt: '2026-10-25T02:00:00.000Z', batchId: 'b', excelRow: 3, itemRevision: 3 },
          ],
        },
        { warehouseId: WH_B, name: '越南仓', status: 'unseen', stale: false, lastKnownQty: 39, lastErrorCode: null },
      ],
      totals: { byUnit: [{ unit: '件', subtotal: 7261, rowCount: 2 }], knownSubtotal: 7261, unitConflict: false },
      scope: { allWarehouses: false },
    });
    expect(normalized.warehouses).toHaveLength(3);
    expect(normalized.warehouses.filter((row) => row.status === 'current')).toHaveLength(2);
    expect(normalized.warehouses[2].status).toBe('unseen');
    expect(normalized.warehouses[2].lastKnownQty).toBe(39);
    expect(normalized.warehouses[2].externalSku).toBe('');
    expect(normalized.totals.knownSubtotal).toBe(7261);
    expect(normalized.totals.byUnit[0].knownSubtotal).toBe(7261);
  });

  it('run detail 读取扁平身份/文件校验(对象表头)/groups 坏行', () => {
    const run = normalizeRunDetail({
      id: MAPPING_A,
      status: 'partial',
      triggerKind: 'manual',
      plannedFor: null,
      startedAt: null,
      finishedAt: null,
      errorCode: 'INVENTORY_WAREHOUSE_BLOCKED',
      observationAt: '2026-10-25T02:00:00.000Z',
      accountIdentityStatus: 'verified',
      accountIdentityLabel: 'acct',
      fileValidation: { blocked: false, headerOk: true, quantityHeader: { on_hand: '现有库存' }, comboRowCount: 1 },
      warehouseDiscovery: [{ externalId: 'new', name: '新仓' }],
      warehouses: [{ warehouseId: WH_A, externalId: 'ph-1', name: '菲律宾仓', status: 'blocked', rows: 10, reason: null }],
      groups: [{ warehouseExternalId: 'ph-1', rowCount: 10, okRowCount: 8, blocked: true, blockedReason: '数量非法' }],
    });
    expect(run.accountIdentity?.status).toBe('verified');
    expect(run.fileValidation?.missingColumns).toEqual([]);
    expect(quantityHeaderDisplay(run.fileValidation?.quantityHeader)).toContain('现有库存');
    expect(run.warehouseDiscovery?.[0].name).toBe('新仓');
    expect(run.warehouses?.[0].invalidRows).toBe(2);
    expect(run.warehouses?.[0].reason).toBe('数量非法');
  });

  it('pending actions 数组/对象两种形状', () => {
    expect(normalizePendingActions([{ request_id: MAPPING_A, action: 'request_inventory_manual_sync', created_at: null, payload: {} }])[0].requestId).toBe(MAPPING_A);
    expect(normalizePendingActions({ items: [{ requestId: MAPPING_A, action: 'x', payload: { enabled: true } }] })[0].payload).toEqual({ enabled: true });
    expect(normalizePendingActions([])).toEqual([]);
  });

  it('overview 真实键：settings 无 scopeEmpty、marketOptions.warehouses、warehouseState.latestRunStatus', () => {
    const normalized = normalizeOverview({
      account: { label: 'acct', status: 'needs_login', accountKey: 'k', externalAccountCode: 'KNZX019402' },
      scope: {
        id: 's', version: 3, warehouseIds: [WH_A, WH_B], labels: ['仓A', '仓B'], warehouseCount: 2,
        empty: false, lastAllSuccessAt: null,
        warehouses: [
          { id: WH_A, externalId: 'ph-1', name: '仓A', market: 'PH', status: 'confirmed' },
          { id: WH_B, externalId: 'vn-1', name: '仓B', market: 'VN', status: 'confirmed' },
        ],
      },
      settings: { enabled: false, intervalMinutes: 60, nextRunAt: null, planAnchorAt: null, configVersion: 3, scopeId: 's' },
      warehouses: [
        { id: WH_A, externalId: 'ph-1', name: '仓A', market: 'PH', status: 'confirmed' },
        { id: WH_B, externalId: 'vn-1', name: '仓B', market: 'VN', status: 'confirmed' },
      ],
      warehouseState: [{ warehouseId: WH_A, externalId: 'ph-1', name: '仓A', market: 'PH', warehouseStatus: 'confirmed', latestRunStatus: 'needs_login', failed: true, stale: false, lastSuccessAt: null, lastPublishAt: null, lastErrorCode: 'LOGIN_REQUIRED' }],
      marketOptions: [{ market: 'PH', warehouseCount: 1, warehouses: [{ id: WH_A, externalId: 'ph-1', name: '仓A' }] }],
      candidates: { pending: 430 },
      mappings: { confirmed: 0, recheck: 0, disabled: 0, accountLevelIgnored: 0 },
      unmappedCount: 0,
    });
    expect(normalized.settings.scopeWarehouseCount).toBe(2);
    expect(normalized.settings.scopeEmpty).toBe(false);
    expect(normalized.scope.warehouseIds).toEqual([WH_A, WH_B]);
    expect(normalized.marketOptions[0].warehouseNames).toEqual(['仓A']);
    expect(normalized.warehouseState[0].lastRunStatus).toBe('needs_login');
    expect(normalized.warehouseState[0].failed).toBe(true);
    expect(normalized.mappingQueueTotal).toBe(0);
    expect(warehouseStateLabel(normalized.warehouseState[0]).label).toContain('失败');
  });

  it('空 fileValidation {} 不冒充“校验通过”；blocked/headerOk 结构可读', () => {
    const unknownRun = normalizeRunDetail({ id: MAPPING_A, status: 'needs_login', triggerKind: 'manual', fileValidation: {} });
    expect(unknownRun.fileValidation).toBeNull();
    const okRun = normalizeRunDetail({ id: MAPPING_A, status: 'success', triggerKind: 'manual', fileValidation: { blocked: false, headerOk: true } });
    expect(okRun.fileValidation?.status).toBe('ok');
    const blockedRun = normalizeRunDetail({ id: MAPPING_A, status: 'failed', triggerKind: 'manual', fileValidation: { blocked: true, missingColumns: ['现有库存'], quantityHeader: { on_hand: '现有库存' } } });
    expect(blockedRun.fileValidation?.status).toBe('blocked');
    expect(quantityHeaderDisplay(blockedRun.fileValidation?.quantityHeader)).toContain('现有库存');
  });
});

describe('未接入来源', () => {
  it('三个来源只显示未接入', async () => {
    const { NOT_CONNECTED_SOURCES, domesticStateLabel } = await import('@/features/inventory/model');
    expect(NOT_CONNECTED_SOURCES).toHaveLength(3);
    expect(domesticStateLabel('not_connected')).toBe('未接入');
  });
});
