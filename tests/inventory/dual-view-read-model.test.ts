import { describe, expect, it } from 'vitest';
import {
  normalizeProductSummary,
  normalizeProductSummaryRow,
  normalizeWarehouseReadStateV2,
  normalizeWarehouseRow,
  normalizeWarehouseRows,
  normalizeWarehouseStates,
} from '@/features/inventory/normalize';
import {
  marketCellQuantity,
  productOverseasTotalText,
  warehouseReadStateDisplay,
  warehouseRowQuantitySummary,
  warehouseRowStatusDisplay,
  warehouseRowTitleDisplay,
  warehouseRowsCountsText,
  warehouseSyncResultText,
} from '@/features/inventory/model';

/**
 * 商品库存双视图 v1（仓库明细 / 商品汇总 / 逐仓状态）的纯逻辑归一化回归。
 *
 * 只测 normalize.ts：DB 只读函数的真实返回由 `.local/inventory-sync-ui-v1-20261027/db-model/verify.mjs`
 * 对账，不在单测里连数据库。重点：
 * - 缺字段/缺数量保持 null，不转 0；真实 0 原样保留；
 * - 行状态只认 adopted / unmapped / pending_adoption；
 * - 批次缺失时行数为 0 且 lastBatchId=null（不是 0 库存）；
 * - 商品汇总的合计/缺口采信服务端字段，marketCells 结构完整。
 */
describe('normalizeWarehouseReadStateV2 / normalizeWarehouseStates', () => {
  it('别名归一：snake_case 与 camelCase 都接受，缺批次时 0 行 + lastBatchId=null', () => {
    const state = normalizeWarehouseReadStateV2({
      warehouse_id: 'wh-1',
      external_id: '50455',
      warehouse_name: '越南青林湾仓库',
      market: 'VN',
      warehouse_status: 'confirmed',
      last_success_at: '2026-10-27T08:22:25.535Z',
      last_batch_id: null,
      batch_rows: 0,
      adopted_rows: 0,
      unmapped_rows: 0,
      observation_at: null,
      published_at: null,
      failed: false,
      stale: false,
      last_error_code: null,
      latest_run_status: 'success',
      pending_mapping_rows: 0,
    });
    expect(state.warehouseId).toBe('wh-1');
    expect(state.externalId).toBe('50455');
    expect(state.name).toBe('越南青林湾仓库');
    expect(state.lastBatchId).toBeNull();
    expect(state.batchRows).toBe(0);
    expect(state.observationAt).toBeNull();
    expect(state.pendingMappingRows).toBe(0);
    expect(state.failed).toBe(false);
  });

  it('缺字段计数默认 0、pendingMappingRows 回退 unmappedRows、1/0 布尔可识别', () => {
    const state = normalizeWarehouseReadStateV2({
      warehouseId: 'wh-2',
      name: 'PH-彩妆日均万单简简单单仓',
      unmappedRows: 21,
      failed: 1,
      stale: 0,
    });
    expect(state.batchRows).toBe(0);
    expect(state.adoptedRows).toBe(0);
    expect(state.unmappedRows).toBe(21);
    expect(state.pendingMappingRows).toBe(21);
    expect(state.failed).toBe(true);
    expect(state.stale).toBe(false);
    expect(state.lastBatchId).toBeNull();
  });

  it('数组归一：过滤完全空对象，并兼容 { warehouses: [...] } 包装', () => {
    const states = normalizeWarehouseStates([
      { warehouseId: 'a', name: 'A', batchRows: 3 },
      {},
      null,
    ]);
    expect(states).toHaveLength(1);
    expect(states[0].batchRows).toBe(3);
    const wrapped = normalizeWarehouseStates({ warehouses: [{ warehouseId: 'b', name: 'B' }] });
    expect(wrapped).toHaveLength(1);
    expect(wrapped[0].warehouseId).toBe('b');
  });
});

describe('normalizeWarehouseRow', () => {
  const adoptedRaw = {
    source: 'bigseller',
    rowKey: 'bigseller:wh-1:757577983013',
    warehouseId: 'wh-1',
    warehouseExternalId: '50455',
    warehouseName: '越南青林湾仓库',
    market: 'VN',
    status: 'adopted',
    itemId: 'item-1',
    iceCode: 'WM0026',
    itemName: 'ICE LERSKIN双色泥膜',
    sourceName: 'ICE LERSKIN 黑白双色泥膜',
    externalSku: '757577983013',
    gtin: '757577983013',
    unit: '个',
    onHand: 0,
    orderLocked: 0,
    warehouseAvailable: 0,
    activityReserved: 0,
    inTransit: 4320,
    observationAt: '2026-10-27T08:22:25.535Z',
    batchId: 'batch-1',
    excelRow: 663,
    mappingStatus: 'confirmed',
    itemRevision: 1,
    rawOnHand: '0',
    note: null,
  };

  it('已采用行：真实 0 原样保留（不是缺失），来源原名/原始文本可用于展示', () => {
    const row = normalizeWarehouseRow(adoptedRaw);
    expect(row.status).toBe('adopted');
    expect(row.onHand).toBe(0);
    expect(row.warehouseAvailable).toBe(0);
    expect(row.inTransit).toBe(4320);
    expect(row.sourceName).toBe('ICE LERSKIN 黑白双色泥膜');
    expect(row.rawOnHand).toBe('0');
    expect(row.mappingStatus).toBe('confirmed');
    expect(row.rowKey).toBe('bigseller:wh-1:757577983013');
  });

  it('缺数量保持 null 不转 0；数字字符串可解析；缺 rowKey 时按 source+warehouse+sku 兜底', () => {
    const row = normalizeWarehouseRow({
      source: 'bigseller',
      warehouseName: '越南青林湾仓库',
      externalSku: 'A-1',
      onHand: null,
      warehouseAvailable: null,
      orderLocked: undefined,
    });
    expect(row.onHand).toBeNull();
    expect(row.warehouseAvailable).toBeNull();
    expect(row.orderLocked).toBeNull();
    expect(row.rowKey).toBe('bigseller::A-1');
    expect(row.iceCode).toBeNull();
    expect(row.itemName).toBeNull();
    expect(row.sourceName).toBeNull();
    expect(row.rawOnHand).toBeNull();
    expect(normalizeWarehouseRow({ externalSku: 'B', onHand: '12' }).onHand).toBe(12);
  });

  it('行状态映射：pending-adoption 别名、未知状态按有无标准商品回退', () => {
    expect(normalizeWarehouseRow({ status: 'pending-adoption', itemId: 'i' }).status).toBe('pending_adoption');
    expect(normalizeWarehouseRow({ status: 'pending', itemId: 'i' }).status).toBe('pending_adoption');
    expect(normalizeWarehouseRow({ status: 'mapped', itemId: 'i' }).status).toBe('adopted');
    expect(normalizeWarehouseRow({ status: 'weird' }).status).toBe('unmapped');
    expect(normalizeWarehouseRow({}).status).toBe('unmapped');
  });

  it('国内行：source=domestic 保留文件日期与云仓可用原文', () => {
    const row = normalizeWarehouseRow({
      source: 'domestic',
      warehouseName: '国内 · 原表未注明仓库',
      externalSku: 'JST-1',
      onHand: 2375,
      warehouseAvailable: 2000,
      status: 'adopted',
      fileDate: '2026-10-15',
      fileName: '商品资料_20261015165159_200874071_1.xlsx',
      cloudAvailableText: '1800',
    });
    expect(row.source).toBe('domestic');
    expect(row.market).toBeNull();
    expect(row.fileDate).toBe('2026-10-15');
    expect(row.cloudAvailableText).toBe('1800');
  });

  it('productName/name_cn/barcode 等别名归一', () => {
    const row = normalizeWarehouseRow({
      product_name: '来源原名',
      name_cn: '标准名',
      barcode: '6974674957349',
      external_sku: '6974674957349',
    });
    expect(row.sourceName).toBe('来源原名');
    expect(row.itemName).toBe('标准名');
    expect(row.gtin).toBe('6974674957349');
    expect(row.externalSku).toBe('6974674957349');
  });
});

describe('normalizeWarehouseRows', () => {
  it('counts 缺失时按行回退；total/offset/limit 结构完整；范围计数可回退去重仓数', () => {
    const dto = normalizeWarehouseRows({
      rows: [
        { status: 'adopted', warehouseId: 'w1', warehouseName: '仓1', externalSku: 's1' },
        { status: 'unmapped', warehouseId: 'w1', warehouseName: '仓1', externalSku: 's2' },
        { status: 'pending_adoption', warehouseId: 'w2', warehouseName: '仓2', externalSku: 's3' },
      ],
      scope: { lastAllSuccessAt: '2026-10-27T08:22:25.535Z' },
      marketOptions: [
        { market: 'VN', warehouseCount: 1, warehouses: [{ id: 'w1', name: '仓1' }] },
      ],
      warehouses: [{ warehouseId: 'w1', name: '仓1', batchRows: 2, adoptedRows: 1, unmappedRows: 1 }],
    });
    expect(dto.total).toBe(3);
    expect(dto.offset).toBe(0);
    expect(dto.limit).toBe(3);
    expect(dto.counts).toEqual({ adopted: 1, unmapped: 1, pendingAdoption: 1, inactive: 0 });
    expect(dto.scope.warehouseCount).toBe(2);
    expect(dto.scope.lastAllSuccessAt).toBe('2026-10-27T08:22:25.535Z');
    expect(dto.marketOptions).toHaveLength(1);
    expect(dto.marketOptions[0].market).toBe('VN');
    expect(dto.warehouses).toHaveLength(1);
    expect(dto.warehouses[0].batchRows).toBe(2);
  });

  it('空结果：rows=[] 且 counts 全 0（不是缺失）', () => {
    const dto = normalizeWarehouseRows({ rows: [], counts: { adopted: 0, unmapped: 0, pendingAdoption: 0 } });
    expect(dto.rows).toEqual([]);
    expect(dto.counts).toEqual({ adopted: 0, unmapped: 0, pendingAdoption: 0, inactive: 0 });
    expect(dto.scope.empty).toBe(true);
  });
});

describe('normalizeProductSummaryRow / normalizeProductSummary', () => {
  it('汇总行：marketCells/hasPendingTotal/overseasOnHand 采信服务端，不自己重算', () => {
    const row = normalizeProductSummaryRow({
      itemId: 'item-1',
      iceCode: 'WM0026',
      nameCn: 'ICE LERSKIN双色泥膜',
      knownSubtotal: 5646,
      unitConflict: false,
      hasPendingTotal: true,
      unitGroups: [{ unit: '个', knownSubtotal: 5646, rowCount: 5 }],
      markets: ['ID', 'MY', 'PH', 'TH', 'VN'],
      hasUnknownMarket: true,
      marketCells: [
        { market: 'PH', onHand: null, skuCount: 2, warehouseCount: 1, hasPendingTotal: true },
        { market: 'VN', onHand: 1857, skuCount: 1, warehouseCount: 1, hasPendingTotal: false },
        { market: null, onHand: 3117, skuCount: 1, warehouseCount: 1, hasPendingTotal: false },
      ],
      overseasOnHand: 5646,
      overseasSkuCount: 2,
      domestic: null,
    });
    expect(row.knownSubtotal).toBe(5646);
    expect(row.hasPendingTotal).toBe(true);
    expect(row.overseasOnHand).toBe(5646);
    expect(row.overseasSkuCount).toBe(2);
    expect(row.marketCells).toHaveLength(3);
    expect(row.marketCells[0].market).toBe('PH');
    expect(row.marketCells[0].onHand).toBeNull();
    expect(row.marketCells[0].hasPendingTotal).toBe(true);
    expect(row.marketCells[2].market).toBeNull();
    expect(row.marketCells[2].onHand).toBe(3117);
    expect(row.domestic).toBeNull();
  });

  it('overseasOnHand 缺失时回退 knownSubtotal；显式 null 保持 null（多单位不凑数）', () => {
    expect(normalizeProductSummaryRow({ knownSubtotal: 2358 }).overseasOnHand).toBe(2358);
    expect(normalizeProductSummaryRow({ knownSubtotal: null, overseasOnHand: null }).overseasOnHand).toBeNull();
    expect(normalizeProductSummaryRow({ knownSubtotal: 10, overseasOnHand: null }).overseasOnHand).toBeNull();
  });

  it('国内格（若页面层合并）可按结构归一；缺数量保持 null', () => {
    const row = normalizeProductSummaryRow({
      knownSubtotal: 0,
      domestic: {
        onHand: null,
        available: 2000,
        rowCount: 2,
        fileDates: ['2026-10-15', '2026-10-16'],
        hasQuantityAnomaly: true,
      },
    });
    expect(row.domestic).not.toBeNull();
    expect(row.domestic!.onHand).toBeNull();
    expect(row.domestic!.available).toBe(2000);
    expect(row.domestic!.rowCount).toBe(2);
    expect(row.domestic!.fileDates).toHaveLength(2);
    expect(row.domestic!.hasQuantityAnomaly).toBe(true);
  });

  it('汇总整体：分页字段、范围筛选、未对应海外行数与国内占位（不默认 available）', () => {
    const dto = normalizeProductSummary({
      total: 116,
      offset: 0,
      limit: 200,
      rows: [{ itemId: 'i1', iceCode: 'WM0043', knownSubtotal: 2358 }],
      scope: { warehouseCount: 7, lastAllSuccessAt: '2026-10-27T08:22:25.535Z', marketFilter: 'PH', warehouseFilter: null },
      marketOptions: [{ market: 'PH', warehouseCount: 2, warehouses: [{ id: 'w', name: '仓' }] }],
      warehouses: [{ warehouseId: 'w', name: '仓', batchRows: 21, adoptedRows: 0, unmappedRows: 21 }],
      unmappedOverseasRows: 220,
      unmappedDomesticRows: 0,
      domesticAvailable: false,
      domesticReason: null,
    });
    expect(dto.total).toBe(116);
    expect(dto.offset).toBe(0);
    expect(dto.limit).toBe(200);
    expect(dto.rows).toHaveLength(1);
    expect(dto.rows[0].overseasOnHand).toBe(2358);
    expect(dto.scope.marketFilter).toBe('PH');
    expect(dto.scope.warehouseFilter).toBeNull();
    expect(dto.unmappedOverseasRows).toBe(220);
    expect(dto.unmappedDomesticRows).toBe(0);
    expect(dto.domesticAvailable).toBe(false);
    expect(dto.domesticReason).toBeNull();
    expect(dto.warehouses[0].unmappedRows).toBe(21);
  });

  it('汇总整体缺字段时 domesticAvailable 不得默认 true', () => {
    const dto = normalizeProductSummary({ rows: [] });
    expect(dto.domesticAvailable).toBe(false);
    expect(dto.unmappedDomesticRows).toBe(0);
    expect(dto.domesticReason).toBeNull();
    expect(dto.unmappedOverseasRows).toBe(0);
  });
});

describe('双视图 DTO 与页面展示模型接线（model.ts 既有 helper）', () => {
  it('已采用行：名称主、ICE 货号/来源 SKU 辅；数量原样（含真实 0）', () => {
    const row = normalizeWarehouseRow({
      status: 'adopted',
      itemId: 'item-1',
      iceCode: 'WM0026',
      itemName: 'ICE LERSKIN双色泥膜',
      sourceName: 'ICE LERSKIN 黑白双色泥膜',
      externalSku: '757577983013',
      gtin: '757577983013',
      unit: '个',
      onHand: 0,
      warehouseAvailable: 12,
    });
    const title = warehouseRowTitleDisplay(row);
    expect(title.title).toBe('ICE LERSKIN双色泥膜');
    expect(title.pendingOwner).toBe(false);
    expect(title.subtitle).toContain('WM0026');
    expect(title.subtitle).toContain('来源 SKU 757577983013');
    expect(warehouseRowStatusDisplay(row).label).toBe('已计入库存');
    const quantity = warehouseRowQuantitySummary(row);
    expect(quantity.primary).toBe('0 个');
    expect(quantity.secondary).toBe('整仓可用 12 个');
  });

  it('未对应行：显示来源原名并标待确认归属；待采用行用对应状态文案', () => {
    const unmapped = normalizeWarehouseRow({
      status: 'unmapped',
      sourceName: 'ICE LERSKIN 护发精油套盒20m*4瓶(泰国特供版)',
      externalSku: '757577407359',
      onHand: null,
    });
    const title = warehouseRowTitleDisplay(unmapped);
    expect(title.title).toBe('ICE LERSKIN 护发精油套盒20m*4瓶(泰国特供版)');
    expect(title.pendingOwner).toBe(true);
    expect(title.subtitle).toContain('待确认归属');
    expect(warehouseRowStatusDisplay(unmapped).label).toBe('来源未对应（不计入）');

    const pending = normalizeWarehouseRow({
      status: 'pending_adoption',
      itemId: 'item-2',
      iceCode: 'WM9999',
      itemName: '标准名',
      externalSku: 'SKU-2',
    });
    expect(warehouseRowStatusDisplay(pending).label).toBe('已确认，待下一完整批次采用（不计入）');
    expect(warehouseRowStatusDisplay(pending).tone).toBe('blue');
  });

  it('逐仓状态/同步结果/行数说明文案可直接用于同步页', () => {
    const state = normalizeWarehouseReadStateV2({
      warehouseId: 'wh-1',
      name: 'PH-彩妆日均万单简简单单仓',
      batchRows: 21,
      adoptedRows: 0,
      unmappedRows: 21,
    });
    expect(warehouseSyncResultText(state)).toContain('21 条来源待对应');
    expect(warehouseReadStateDisplay(state).label).toContain('当前批次已发布');
    expect(warehouseRowsCountsText({ adopted: 430, unmapped: 220, pendingAdoption: 0 }))
      .toBe('已计入 430 行 · 来源未对应 220 行');
  });

  it('商品汇总：市场格待合计显示“待核对”，多单位不合计', () => {
    const row = normalizeProductSummaryRow({
      iceCode: 'WM0026',
      knownSubtotal: 5646,
      hasPendingTotal: true,
      unitConflict: false,
      marketCells: [
        { market: 'PH', onHand: null, skuCount: 2, warehouseCount: 1, hasPendingTotal: true },
        { market: 'VN', onHand: 1857, skuCount: 1, warehouseCount: 1, hasPendingTotal: false },
      ],
      overseasOnHand: 5646,
    });
    expect(marketCellQuantity(row.marketCells[0])).toBe('待核对');
    expect(marketCellQuantity(row.marketCells[1])).toBe('1,857');
    expect(productOverseasTotalText(row)).toBe('合计待核对');
    expect(productOverseasTotalText({ ...row, hasPendingTotal: false, unitConflict: false })).toBe('5,646');
    expect(productOverseasTotalText({ ...row, unitConflict: true })).toBe('多单位，不合计');
  });
});
