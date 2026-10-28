import { describe, expect, it } from 'vitest';
import {
  buildDomesticCell,
  domesticIncludedInScope,
  domesticRowToWarehouseRow,
  filterDomesticRows,
  mergeProductSummary,
  mergeWarehouseRowsPage,
  summaryMarketColumns,
} from '@/features/inventory/dual-view';
import type {
  InventoryDomesticRowDto,
  InventoryDomesticSnapshotDto,
  InventoryProductSummaryDto,
  InventoryProductSummaryRowDto,
  InventoryWarehouseRowDto,
  InventoryWarehouseRowsDto,
} from '@/features/inventory/types';
import type { InventoryQueryState } from '@/features/inventory/model';
import {
  buildInventoryRowDetailHref,
  buildProductToWarehouseHref,
  DEFAULT_INVENTORY_QUERY,
  inventoryPageNumbers,
  marketsDisplay,
  parseInventorySearchParams,
  UNKNOWN_MARKET_TOKEN,
  warehouseRowLastKnownText,
} from '@/features/inventory/model';

function query(overrides: Partial<InventoryQueryState> = {}): InventoryQueryState {
  return { ...DEFAULT_INVENTORY_QUERY, ...overrides };
}

function domesticRow(overrides: Partial<InventoryDomesticRowDto> = {}): InventoryDomesticRowDto {
  return {
    source: 'domestic',
    legacyCandidateId: 'mc-1',
    itemId: '11111111-1111-4111-8111-111111111111',
    iceCode: 'WM0003',
    itemNameCn: 'ICELERSKIN乙醇酸爽肤水 100ml',
    externalSku: 'WM0003',
    sourceName: 'ICE LERSKIN 乙醇酸爽肤水 100ml',
    actualQty: 2375,
    availableQty: 2375,
    cloudAvailableText: null,
    rawActualText: '2375',
    rawAvailableText: '2375',
    unit: null,
    warehouseLabel: '国内 · 原表未注明仓库',
    sheet: 'Sheet1',
    excelRow: 740,
    fileDate: '2026-10-15',
    fileName: '商品资料_20261015165159_200874071_1.xlsx',
    frozenFileSha256: '9f42843af2bfe1828f07e8ac7c96c57b16d1c397026184ed893cc2ab9de563f8',
    reviewState: 'manual_selected',
    quantityState: 'ok',
    ...overrides,
  };
}

function domesticSnapshot(rows: InventoryDomesticRowDto[]): InventoryDomesticSnapshotDto {
  const selected = rows.filter((row) => row.reviewState === 'manual_selected');
  return {
    available: true,
    reason: null,
    releaseKey: 'p0-03-delivery-final-v2-20261020',
    sourceRecordsSha256: 'bcee12bcb555e73f50a3eabd504766ff3c401d2fb58e194ebb6c24441f6ba25d',
    recordCount: rows.length,
    selectedCount: selected.length,
    linkedSelectedCount: selected.filter((row) => row.itemId).length,
    linkedItemCount: new Set(selected.map((row) => row.itemId).filter(Boolean)).size,
    unlinkedSelectedCount: selected.filter((row) => !row.itemId).length,
    fileDates: [{ fileDate: '2026-10-15', fileName: '商品资料_20261015165159_200874071_1.xlsx', frozenFileSha256: 'f', recordCount: rows.length }],
    rows,
    cached: false,
  };
}

function overseasRow(overrides: Partial<InventoryWarehouseRowDto> = {}): InventoryWarehouseRowDto {
  return {
    source: 'bigseller',
    rowKey: 'bigseller:wh1:SKU1',
    warehouseId: 'wh1',
    warehouseExternalId: 'VN01',
    warehouseName: '越南青林湾仓库',
    market: 'VN',
    status: 'adopted',
    itemId: '22222222-2222-4222-8222-222222222222',
    iceCode: 'WM0026',
    itemName: '测试商品',
    sourceName: '测试商品来源名',
    externalSku: 'SKU1',
    gtin: '6977125082072',
    unit: '件',
    onHand: 1853,
    orderLocked: 0,
    warehouseAvailable: 1800,
    activityReserved: 0,
    inTransit: 0,
    observationAt: '2026-10-27T08:22:25.535Z',
    batchId: 'batch-1',
    excelRow: 12,
    mappingStatus: 'confirmed',
    itemRevision: 3,
    rawOnHand: '1853',
    note: null,
    ...overrides,
  };
}

function overseasRows(rows: InventoryWarehouseRowDto[]): InventoryWarehouseRowsDto {
  return {
    total: rows.length,
    offset: 0,
    limit: rows.length,
    rows,
    scope: { warehouseCount: 7, lastAllSuccessAt: '2026-10-27T08:22:25.535Z', empty: false },
    marketOptions: [{ market: 'VN', warehouseNames: ['越南青林湾仓库'], warehouseCount: 1 }],
    warehouses: [],
    counts: {
      adopted: rows.filter((row) => row.status === 'adopted').length,
      unmapped: rows.filter((row) => row.status === 'unmapped').length,
      pendingAdoption: rows.filter((row) => row.status === 'pending_adoption').length,
      inactive: rows.filter((row) => row.status === 'inactive').length,
    },
  };
}

function summaryRow(overrides: Partial<InventoryProductSummaryRowDto> = {}): InventoryProductSummaryRowDto {
  return {
    itemId: '22222222-2222-4222-8222-222222222222',
    iceCode: 'WM0026',
    nameCn: '测试商品',
    gtin: '6977125082072',
    market: 'VN',
    knownSubtotal: 1853,
    unitConflict: false,
    hasPendingTotal: false,
    unitGroups: [{ unit: '件', knownSubtotal: 1853, rowCount: 1 }],
    coveredWarehouseCount: 1,
    scopeWarehouseCount: 7,
    notMappedWarehouses: [],
    unseenWarehouses: [],
    failedWarehouses: [],
    markets: ['VN'],
    hasUnknownMarket: false,
    lastObservedAt: '2026-10-27T08:22:25.535Z',
    mapped: true,
    marketCells: [{ market: 'VN', onHand: 1853, skuCount: 1, warehouseCount: 1, hasPendingTotal: false }],
    overseasOnHand: 1853,
    overseasSkuCount: 1,
    domestic: null,
    ...overrides,
  };
}

function summaryDto(rows: InventoryProductSummaryRowDto[]): InventoryProductSummaryDto {
  return {
    total: rows.length,
    offset: 0,
    limit: 200,
    rows,
    scope: { warehouseCount: 7, lastAllSuccessAt: null, empty: false, marketFilter: null, warehouseFilter: null },
    marketOptions: [{ market: 'VN', warehouseNames: ['越南青林湾仓库'], warehouseCount: 1 }],
    warehouses: [],
    unmappedOverseasRows: 3,
    unmappedDomesticRows: 0,
    domesticAvailable: true,
    domesticReason: null,
  };
}

describe('仓库明细：国内行映射与合并', () => {
  it('已核对选择且关联商品 = adopted；未关联 = unmapped 并说明原因', () => {
    const adopted = domesticRowToWarehouseRow(domesticRow());
    expect(adopted.source).toBe('domestic');
    expect(adopted.status).toBe('adopted');
    expect(adopted.warehouseName).toBe('国内 · 原表未注明仓库');
    expect(adopted.onHand).toBe(2375);
    expect(adopted.observationAt).toBeNull();
    expect(adopted.fileDate).toBe('2026-10-15');

    const unmapped = domesticRowToWarehouseRow(domesticRow({ reviewState: 'pending', itemId: null }));
    expect(unmapped.status).toBe('unmapped');
    expect(unmapped.note).toContain('未纳入国内汇总');
  });

  it('数量缺失保持 null，不用可用数替代实际库存数', () => {
    const row = domesticRowToWarehouseRow(domesticRow({ actualQty: null, rawActualText: '', quantityState: 'missing' }));
    expect(row.onHand).toBeNull();
    expect(row.warehouseAvailable).toBe(2375);
    expect(row.note).toContain('不计入国内数量');
  });

  it('按仓/市场筛选时国内行不混入；搜索可按商品名/货号/SKU/来源名命中', () => {
    const rows = [domesticRow({ legacyCandidateId: 'a' }), domesticRow({ legacyCandidateId: 'b', iceCode: 'WM0099', externalSku: 'SY1WM0099', sourceName: '其它名字' })];
    expect(filterDomesticRows(rows, { q: '', warehouse: 'wh1', market: 'all' })).toHaveLength(0);
    expect(filterDomesticRows(rows, { q: '', warehouse: 'all', market: 'VN' })).toHaveLength(0);
    expect(filterDomesticRows(rows, { q: 'wm0099', warehouse: 'all', market: 'all' })).toHaveLength(1);
    expect(filterDomesticRows(rows, { q: '乙醇酸', warehouse: 'all', market: 'all' })).toHaveLength(2);
    expect(filterDomesticRows(rows, { q: '', warehouse: 'all', market: 'all' })).toHaveLength(2);
  });

  it('合并后按来源分层排序并统一切页；真实 0 与未对应行保留', () => {
    const overseas = overseasRows([
      overseasRow({ rowKey: 'bigseller:wh1:SKU1' }),
      overseasRow({ rowKey: 'bigseller:wh2:SKU0', warehouseId: 'wh2', warehouseName: '喜运达MY仓', market: 'MY', itemId: '33333333-3333-4333-8333-333333333333', iceCode: 'WM0003', externalSku: 'SKU0', onHand: 0 }),
      overseasRow({ rowKey: 'bigseller:wh3:SKUX', warehouseId: 'wh3', warehouseName: 'PH-彩妆仓', market: 'PH', status: 'unmapped', itemId: null, itemName: null, iceCode: null, sourceName: '未知来源名称', externalSku: 'SKUX', onHand: 12 }),
    ]);
    const domestic = domesticSnapshot([domesticRow(), domesticRow({ legacyCandidateId: 'c', reviewState: 'pending', itemId: null })]);
    const page = mergeWarehouseRowsPage({ query: query({ limit: 2 }), overseas, domestic });

    expect(page.total).toBe(5);
    expect(page.pageCount).toBe(3);
    expect(page.rows).toHaveLength(2);
    expect(page.counts.adopted).toBe(2);
    expect(page.counts.unmapped).toBe(1);
    expect(page.counts.domesticAdopted).toBe(1);
    expect(page.counts.domesticUnmapped).toBe(1);
    expect(page.domesticFileDates).toEqual(['2026-10-15']);
    // 海外行在前、国内行在后（不跨来源混排成同一时点）
    expect(page.rows.every((row) => row.source === 'bigseller')).toBe(true);
    const lastPage = mergeWarehouseRowsPage({ query: query({ limit: 2, page: 3 }), overseas, domestic });
    expect(lastPage.rows.some((row) => row.source === 'domestic')).toBe(true);
    // 无跨来源合计
    expect(Object.keys(page.counts).some((key) => key.includes('total'))).toBe(false);
  });

  it('只看国内来源时不返回海外行；来源范围=海外时不返回国内行', () => {
    const overseas = overseasRows([overseasRow()]);
    const domestic = domesticSnapshot([domesticRow()]);
    const domesticOnly = mergeWarehouseRowsPage({ query: query({ source: 'domestic' }), overseas, domestic });
    expect(domesticOnly.rows.every((row) => row.source === 'domestic')).toBe(true);
    const overseasOnly = mergeWarehouseRowsPage({ query: query({ source: 'overseas' }), overseas, domestic });
    expect(overseasOnly.rows.every((row) => row.source === 'bigseller')).toBe(true);
    expect(overseasOnly.domesticIncluded).toBe(false);
  });

  it('国内快照未读取时不做 0 处理，并保留原因', () => {
    const unavailable: InventoryDomesticSnapshotDto = { ...domesticSnapshot([]), available: false, reason: '国内表格快照文件校验失败' };
    const page = mergeWarehouseRowsPage({ query: query({ source: 'all' }), overseas: overseasRows([overseasRow()]), domestic: unavailable });
    expect(page.domesticIncluded).toBe(false);
    expect(page.domesticAvailable).toBe(false);
    expect(page.domesticReason).toContain('校验失败');
    expect(page.rows).toHaveLength(1);
  });
});

describe('商品汇总：市场格与国内格', () => {
  it('国内格只统计冻结有效选择；缺失数量不补 0 并标记异常', () => {
    expect(buildDomesticCell([])).toBeNull();
    const cell = buildDomesticCell([domesticRow(), domesticRow({ legacyCandidateId: 'b', actualQty: 25 })]);
    expect(cell?.onHand).toBe(2400);
    expect(cell?.rowCount).toBe(2);
    const anomaly = buildDomesticCell([domesticRow(), domesticRow({ legacyCandidateId: 'c', actualQty: null, quantityState: 'missing' })]);
    expect(anomaly?.onHand).toBe(2375);
    expect(anomaly?.hasQuantityAnomaly).toBe(true);
    const pendingOnly = buildDomesticCell([domesticRow({ reviewState: 'pending', itemId: null })]);
    expect(pendingOnly).toBeNull();
  });

  it('国内格合并到同商品行；只在国内出现的标准商品补一行且不伪造海外数量', () => {
    const domestic = domesticSnapshot([
      domesticRow({ itemId: '22222222-2222-4222-8222-222222222222', iceCode: 'WM0026', itemNameCn: '测试商品' }),
      domesticRow({ legacyCandidateId: 'x', itemId: '44444444-4444-4444-8444-444444444444', iceCode: 'WM0099', itemNameCn: '纯国内商品', externalSku: 'SY1WM0099', actualQty: 10 }),
    ]);
    const merged = mergeProductSummary({ query: query(), summary: summaryDto([summaryRow()]), domestic });
    expect(merged.total).toBe(2);
    expect(merged.domesticIncluded).toBe(true);
    expect(merged.domesticOnlyItems).toBe(1);
    const onlyDomestic = merged.rows.find((row) => row.iceCode === 'WM0099');
    expect(onlyDomestic?.overseasOnHand).toBeNull();
    expect(onlyDomestic?.marketCells).toHaveLength(0);
    expect(onlyDomestic?.domestic?.onHand).toBe(10);
    const matched = merged.rows.find((row) => row.iceCode === 'WM0026');
    expect(matched?.domestic?.onHand).toBe(2375);
    expect(matched?.overseasOnHand).toBe(1853);
  });

  it('来源范围=海外时不显示国内列；国内未读取时不伪造国内格', () => {
    const overseasOnly = mergeProductSummary({ query: query({ source: 'overseas' }), summary: summaryDto([summaryRow()]), domestic: domesticSnapshot([domesticRow()]) });
    expect(overseasOnly.domesticIncluded).toBe(false);
    expect(overseasOnly.rows[0]?.domestic).toBeNull();

    const unavailable = mergeProductSummary({
      query: query(),
      summary: summaryDto([summaryRow()]),
      domestic: { ...domesticSnapshot([domesticRow()]), available: false, reason: '读取失败' },
    });
    expect(unavailable.domesticIncluded).toBe(false);
    expect(unavailable.rows[0]?.domestic).toBeNull();
    expect(unavailable.domesticReason).toBe('读取失败');
  });

  it('市场列按完整筛选范围生成，未知市场单独成列', () => {
    const columns = summaryMarketColumns({
      marketCells: [{ market: 'VN' }, { market: 'MY' }, { market: null }],
      marketOptions: [{ market: 'VN' }],
    });
    expect(columns.map((column) => column.market)).toEqual(['MY', 'VN', null]);
    const filtered = summaryMarketColumns({
      marketCells: [{ market: 'VN' }, { market: 'MY' }],
      marketOptions: [{ market: 'VN' }, { market: 'MY' }],
      marketFilter: 'VN',
    });
    expect(filtered.map((column) => column.market)).toEqual(['VN']);
  });

  it('分页按合并后的完整集合切页', () => {
    const rows = Array.from({ length: 3 }, (_, index) => summaryRow({ itemId: `0000000${index}-0000-4000-8000-000000000000`, iceCode: `WM000${index}` }));
    const merged = mergeProductSummary({ query: query({ limit: 2, page: 2 }), summary: summaryDto(rows), domestic: null });
    expect(merged.total).toBe(3);
    expect(merged.rows).toHaveLength(1);
    expect(merged.page).toBe(2);
    expect(merged.hasPrev).toBe(true);
    expect(merged.hasNext).toBe(false);
  });
});

describe('URL 上下文（视图 / 来源范围 / 定位 / 展开行）', () => {
  it('解析并保留 view/source/focus/row', () => {
    const parsed = parseInventorySearchParams(new URLSearchParams({
      view: 'product',
      source: 'domestic',
      focus: '22222222-2222-4222-8222-222222222222',
      row: 'domestic:mc-1',
      q: 'WM0003',
      warehouse: 'all',
      market: 'all',
    }));
    expect(parsed.view).toBe('product');
    expect(parsed.source).toBe('domestic');
    expect(parsed.focus).toBe('22222222-2222-4222-8222-222222222222');
    expect(parsed.row).toBe('domestic:mc-1');
  });

  it('非法 view/source/row 回落到默认值', () => {
    const parsed = parseInventorySearchParams(new URLSearchParams({ view: 'matrix', source: 'x', row: '<script>' }));
    expect(parsed.view).toBe('warehouse');
    expect(parsed.source).toBe('all');
    expect(parsed.row).toBe('');
  });
});

describe('修复包 R1：来源范围约束商品集合、列与下钻', () => {
  it('仅国内商品汇总只保留有国内有效选择的商品，不混入海外-only 商品', () => {
    const domestic = domesticSnapshot([
      domesticRow({ itemId: '22222222-2222-4222-8222-222222222222', iceCode: 'WM0026', itemNameCn: '测试商品' }),
      domesticRow({ legacyCandidateId: 'x', itemId: '44444444-4444-4444-8444-444444444444', iceCode: 'WM0099', itemNameCn: '纯国内商品', externalSku: 'SY1WM0099' }),
    ]);
    const overseasOnly = summaryRow({ itemId: '55555555-5555-4555-8555-555555555555', iceCode: 'LS101311', nameCn: '只有海外的商品' });
    const merged = mergeProductSummary({ query: query({ source: 'domestic' }), summary: summaryDto([summaryRow(), overseasOnly]), domestic });
    expect(merged.total).toBe(2);
    expect(merged.rows.map((row) => row.iceCode).sort()).toEqual(['WM0026', 'WM0099']);
    expect(merged.marketColumns).toEqual([]);
    expect(merged.overseasItemCount).toBe(0);
    expect(merged.rows.every((row) => row.domestic !== null)).toBe(true);
  });

  it('仅国内时搜索按国内字段收窄，不展示其它国内商品', () => {
    const domestic = domesticSnapshot([
      domesticRow({ itemId: '22222222-2222-4222-8222-222222222222', iceCode: 'WM0026' }),
      domesticRow({ legacyCandidateId: 'x', itemId: '44444444-4444-4444-8444-444444444444', iceCode: 'WM0099', itemNameCn: '纯国内商品', externalSku: 'SY1WM0099' }),
    ]);
    const merged = mergeProductSummary({
      query: query({ source: 'domestic', q: 'wm0099' }),
      summary: summaryDto([summaryRow()]),
      domestic,
    });
    expect(merged.total).toBe(1);
    expect(merged.rows[0]?.iceCode).toBe('WM0099');
  });

  it('有仓库/市场下钻时国内行与国内列都不混入（国内快照无仓/市场维度）', () => {
    const domestic = domesticSnapshot([domesticRow()]);
    const warehousePage = mergeWarehouseRowsPage({
      query: query({ market: 'VN' }),
      overseas: overseasRows([overseasRow()]),
      domestic,
    });
    expect(warehousePage.domesticIncluded).toBe(false);
    expect(warehousePage.rows.every((row) => row.source === 'bigseller')).toBe(true);
    const merged = mergeProductSummary({ query: query({ market: 'VN' }), summary: summaryDto([summaryRow()]), domestic });
    expect(merged.domesticIncluded).toBe(false);
    expect(merged.rows[0]?.domestic).toBeNull();
  });

  it('详情国内范围复用同一判断：明确海外仓/市场（含未知市场）下钻不带国内', () => {
    // 仅国内可以；全部来源只在没有海外仓/市场筛选时分区显示国内。
    expect(domesticIncludedInScope({ source: 'domestic', warehouse: 'all', market: 'all' })).toBe(true);
    expect(domesticIncludedInScope({ source: 'all', warehouse: 'all', market: 'all' })).toBe(true);
    // 仅海外、明确海外仓、未知市场哨兵都不混入国内。
    expect(domesticIncludedInScope({ source: 'overseas', warehouse: 'all', market: 'all' })).toBe(false);
    expect(domesticIncludedInScope({ source: 'all', warehouse: 'wh-1', market: 'all' })).toBe(false);
    expect(domesticIncludedInScope({ source: 'all', warehouse: 'all', market: UNKNOWN_MARKET_TOKEN })).toBe(false);
  });

  it('仓库明细计数包含历史已采用/当前停用行，且不计入合计', () => {
    const page = mergeWarehouseRowsPage({
      query: query(),
      overseas: overseasRows([
        overseasRow({ rowKey: 'bigseller:wh1:SKU1' }),
        overseasRow({ rowKey: 'bigseller:wh1:SKU9', externalSku: 'SKU9', status: 'inactive', mappingStatus: 'disabled' }),
      ]),
      domestic: null,
    });
    expect(page.counts.inactive).toBe(1);
    expect(page.counts.adopted).toBe(1);
    expect(page.total).toBe(2);
  });

  it('未知市场格下钻使用 __unknown__ 哨兵，已知市场保留市场参数', () => {
    const item = { iceCode: 'WM0026', nameCn: '测试商品', itemId: '22222222-2222-4222-8222-222222222222' };
    const unknown = buildProductToWarehouseHref({ q: 'WM0026', warehouse: 'all', market: 'all', source: 'all' }, item, null);
    expect(unknown).toContain(`market=${encodeURIComponent('__unknown__')}`);
    expect(unknown).toContain('focus=');
    const known = buildProductToWarehouseHref({ q: 'WM0026', warehouse: 'all', market: 'all', source: 'all' }, item, 'VN');
    expect(known).toContain('market=VN');
    expect(known).not.toContain('__unknown__');
  });

  it('分页页码集合包含首末页并在当前页附近展开', () => {
    expect(inventoryPageNumbers(1, 31)).toEqual([1, 2, 3, 'gap', 31]);
    expect(inventoryPageNumbers(20, 31)).toEqual([1, 'gap', 18, 19, 20, 21, 22, 'gap', 31]);
    expect(inventoryPageNumbers(31, 31)).toEqual([1, 'gap', 29, 30, 31]);
    expect(inventoryPageNumbers(1, 1)).toEqual([1]);
  });

  it('行详情 URL 保留筛选/页码并带 row 与 item', () => {
    const href = buildInventoryRowDetailHref(
      query({ q: 'WM0026', source: 'domestic', view: 'warehouse', page: 2, market: 'all', warehouse: 'all' }),
      { rowKey: 'domestic:mc-1', itemId: '22222222-2222-4222-8222-222222222222' },
    );
    expect(href).toContain('q=WM0026');
    expect(href).toContain('source=domestic');
    expect(href).toContain('page=2');
    expect(href).toContain('row=domestic%3Amc-1');
    expect(href).toContain('item=22222222-2222-4222-8222-222222222222');
  });
});

describe('S1–S3 收尾：范围/计数/旧值说明', () => {
  it('未知市场筛选不生成 __unknown__ 列，只保留“市场待确认”业务列', () => {
    const columns = summaryMarketColumns({
      marketCells: [{ market: null }],
      marketOptions: [{ market: 'VN' }],
      marketFilter: '__unknown__',
    });
    expect(columns.map((column) => column.market)).toEqual([null]);
    expect(columns.map((column) => column.label)).toEqual(['市场待确认']);
    expect(columns.some((column) => String(column.key).includes('__unknown__'))).toBe(false);
  });

  it('市场展示不把内部哨兵当国家名（未知范围只写“市场待确认”）', () => {
    const unknownScope = marketsDisplay(['VN', 'MY'], true, '__unknown__');
    expect(unknownScope.text).toContain('市场待确认');
    expect(unknownScope.text).not.toContain('__unknown__');
    const knownScope = marketsDisplay(['VN', 'MY'], false, 'VN');
    expect(knownScope.text).toBe('VN');
  });

  it('国内商品数随搜索收窄（搜索后不再是全局 118）', () => {
    const domestic = domesticSnapshot([
      domesticRow({ itemId: '22222222-2222-4222-8222-222222222222', iceCode: 'WM0026' }),
      domesticRow({ legacyCandidateId: 'x', itemId: '44444444-4444-4444-8444-444444444444', iceCode: 'WM0099', itemNameCn: '纯国内商品', externalSku: 'SY1WM0099' }),
    ]);
    const all = mergeProductSummary({ query: query(), summary: summaryDto([summaryRow()]), domestic });
    expect(all.domesticItemCount).toBe(2);
    const searched = mergeProductSummary({ query: query({ q: 'WM0099' }), summary: summaryDto([summaryRow({ itemId: '44444444-4444-4444-8444-444444444444', iceCode: 'WM0099' })]), domestic });
    expect(searched.domesticItemCount).toBe(1);
    expect(searched.total).toBe(1);
  });

  it('只有历史旧值时显示旧量旧时间，本批有原数量时不重复', () => {
    const unseen = warehouseRowLastKnownText({
      source: 'bigseller',
      status: 'pending_adoption',
      onHand: null,
      lastKnownQty: 17,
      lastKnownAt: '2026-10-26T08:22:00.000Z',
    });
    expect(unseen).toContain('上次已知 17');
    expect(unseen).toContain('不计入');
    const hasBatchValue = warehouseRowLastKnownText({
      source: 'bigseller',
      status: 'inactive',
      onHand: 17,
      lastKnownQty: 17,
      lastKnownAt: '2026-10-26T08:22:00.000Z',
    });
    expect(hasBatchValue).toBeNull();
    const domestic = warehouseRowLastKnownText({
      source: 'domestic',
      status: 'pending_adoption',
      onHand: null,
      lastKnownQty: 1,
      lastKnownAt: null,
    });
    expect(domestic).toBeNull();
  });
});
