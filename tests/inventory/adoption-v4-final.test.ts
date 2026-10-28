/**
 * R1 v4 final display contract: “对应已确认” ≠ “库存已采用”.
 *
 * 服务端 gap/summary/detail 已把 adoptedSkus 改成只来自同一范围 inventory_effective_rows，
 * 并新增 pendingAdoptionSkus / pendingAdoptionWarehouses / hasPendingAdoptionWarehouses。
 * 这里锁住纯展示层：只有 adoptedSkus 能写“已计入合计”，confirmed mapping 只能写“等待采用”。
 * 用原始 JSON 形状输入（与 RPC 返回一致），避免测试替身与服务端字段名漂移。
 */
import { describe, it, expect } from 'vitest';
import {
  detailPendingSourceDisplay,
  detailTotalsDisplay,
  listCoverageDisplay,
  pendingAdoptionWarehousesText,
  pendingSourceWarehouseText,
  pendingSourceWarehousesText,
} from '../../src/features/inventory/model';
import { normalizeItemDetail, normalizeList } from '../../src/features/inventory/normalize';

const VN = {
  warehouseId: 'wh-vn',
  externalId: '50455',
  name: '越南青林湾仓库',
  sourceRowCount: 5,
  pendingSourceRowCount: 2,
  pendingSkus: ['6973517484967', '6973517482611'],
  mappedSkus: ['6974674957325', '6974674957332', '6974674957349', '6974674957356'],
  adoptedSkus: ['6974674957325'],
  pendingSourceRows: [
    { externalSku: '6973517484967', excelRow: 710, onHand: 23, mapped: false },
    { externalSku: '6973517482611', excelRow: 716, onHand: 247, mapped: false },
  ],
};

const VN_ADOPTION = {
  warehouseId: 'wh-vn',
  externalId: '50455',
  name: '越南青林湾仓库',
  adoptedSkus: ['6974674957325'],
  mappedSkus: ['6974674957325', '6974674957332', '6974674957349', '6974674957356'],
  pendingAdoptionSkus: ['6974674957332', '6974674957349', '6974674957356'],
};

function rawList(): unknown {
  return {
    total: 1,
    offset: 0,
    limit: 50,
    scope: { warehouseCount: 7, lastAllSuccessAt: '2026-10-26T03:31:13.035Z' },
    domestic: 'not_connected',
    inTransit: 'not_connected',
    items: [{
      itemId: 'item-ls101295',
      iceCode: 'LS101295',
      nameCn: 'ICE LERSKIN海茴香焕肤水',
      market: 'VN',
      knownSubtotal: 1028,
      unitConflict: false,
      unitGroups: [{ unit: '件', subtotal: 1028, rowCount: 2 }],
      warehouseCount: 5,
      scopeWarehouseCount: 7,
      coverage: { scopeWarehouses: 7, coveredWarehouses: 5 },
      hasCurrentData: true,
      notMappedWarehouses: [],
      unseenWarehouses: [],
      failedWarehouses: [],
      pendingSourceWarehouses: [VN],
      hasPendingSourceWarehouses: true,
      pendingAdoptionWarehouses: [VN_ADOPTION],
      hasPendingAdoptionWarehouses: true,
      markets: ['VN'],
      lastObservedAt: '2026-10-26T03:31:13.035Z',
      mapped: true,
      verificationOnly: true,
    }],
  };
}

function rawDetail(): unknown {
  return {
    item: { id: 'item-ls101295', iceCode: 'LS101295', nameCn: 'ICE LERSKIN海茴香焕肤水' },
    warehouses: [
      {
        warehouseId: VN.warehouseId,
        externalId: VN.externalId,
        name: VN.name,
        market: 'VN',
        status: 'current',
        reason: null,
        sourceRowCount: VN.sourceRowCount,
        pendingSourceRowCount: VN.pendingSourceRowCount,
        pendingSkus: VN.pendingSkus,
        mappedSkus: VN.mappedSkus,
        adoptedSkus: VN.adoptedSkus,
        pendingAdoptionSkus: VN_ADOPTION.pendingAdoptionSkus,
        pendingSourceRows: VN.pendingSourceRows,
        rows: [{
          excelRow: 711, externalSku: '6974674957325', unit: '件', onHand: 899,
          orderLocked: 0, warehouseAvailable: 899, observedAt: '2026-10-26T03:31:13.035Z',
          batchId: 'batch-1', itemRevision: 1,
        }],
      },
      {
        warehouseId: 'wh-unseen',
        externalId: '59999',
        name: '待发布仓',
        status: 'unseen',
        reason: 'unseen',
        sourceRowCount: 1,
        pendingSourceRowCount: 0,
        mappedSkus: ['9999999999999'],
        adoptedSkus: [],
        pendingAdoptionSkus: ['9999999999999'],
        pendingSourceRows: [],
        rows: [],
      },
    ],
    totals: {
      byUnit: [{ unit: '件', subtotal: 1028, rowCount: 1 }],
      knownSubtotal: 1028,
      unitConflict: false,
    },
    coverage: { scopeWarehouses: 7, coveredWarehouses: 1 },
    markets: ['VN'],
    pendingSourceWarehouses: [VN],
    hasPendingSourceWarehouses: true,
    pendingAdoptionWarehouses: [VN_ADOPTION, {
      warehouseId: 'wh-unseen',
      externalId: '59999',
      name: '待发布仓',
      adoptedSkus: [],
      mappedSkus: ['9999999999999'],
      pendingAdoptionSkus: ['9999999999999'],
    }],
    hasPendingAdoptionWarehouses: true,
    verificationOnly: true,
    unitUnconfirmed: true,
    history: [],
    mapping: [],
    scopedWarnings: ['部分仓对应已确认、等待下一次完整同步采用（尚未计入合计）'],
  };
}

describe('R1 v4 final: adoptedSkus 才是“已计入合计”', () => {
  it('同仓来源待确认的“已计入合计 SKU”只用 adoptedSkus，不把 confirmed mapping 写成已采用', () => {
    const text = pendingSourceWarehouseText(VN);
    expect(text).toContain('已计入合计 SKU 6974674957325');
    // 7332/349/356 已确认但未采用：不能出现在“已计入合计”集合里。
    expect(text).not.toContain('已采用 SKU');
    expect(text).not.toMatch(/已计入合计 SKU[^（]*6974674957332/);
    expect(text).toContain('待确认源行 6973517484967=23（原文件行 710）');
    const all = pendingSourceWarehousesText([VN]);
    expect(all).toContain('同仓还有来源待确认');
    expect(all).toContain('越南青林湾仓库');
  });

  it('列表新增“对应已确认、等待下一次完整同步采用”句，且合计/覆盖不受影响', () => {
    const list = normalizeList(rawList());
    const item = list.items[0];
    expect(item.knownSubtotal).toBe(1028);
    expect(item.hasPendingAdoptionWarehouses).toBe(true);
    expect(item.pendingAdoptionWarehouses?.[0]).toMatchObject({
      warehouseId: 'wh-vn',
      adoptedSkus: ['6974674957325'],
      mappedSkus: ['6974674957325', '6974674957332', '6974674957349', '6974674957356'],
      pendingAdoptionSkus: ['6974674957332', '6974674957349', '6974674957356'],
    });
    const sentence = pendingAdoptionWarehousesText(item.pendingAdoptionWarehouses);
    expect(sentence).toContain('对应已确认、等待下一次完整同步采用：越南青林湾仓库');
    expect(sentence).toContain('等待采用 SKU 6974674957332、6974674957349、6974674957356');
    expect(sentence).toContain('已计入合计 SKU 6974674957325');
    const display = listCoverageDisplay(item);
    expect(display.subtotalText).toBe('1,028');
    expect(display.gapText).toContain('对应已确认、等待下一次完整同步采用');
    expect(display.gapText).toContain('同仓还有来源待确认');
    expect(display.gapText).not.toContain('已采用 SKU');
  });

  it('列表/详情同一 summary 口径：pendingAdoptionWarehouses 与 hasPendingAdoptionWarehouses 一致', () => {
    const list = normalizeList(rawList());
    const detail = normalizeItemDetail(rawDetail());
    expect(detail.hasPendingAdoptionWarehouses).toBe(true);
    expect(detail.hasPendingAdoptionWarehouses).toBe(list.items[0].hasPendingAdoptionWarehouses);
    const listVn = (list.items[0].pendingAdoptionWarehouses ?? [])
      .find((entry) => entry.warehouseId === 'wh-vn');
    const detailVn = (detail.pendingAdoptionWarehouses ?? [])
      .find((entry) => entry.warehouseId === 'wh-vn');
    expect(detailVn).toEqual(listVn);
    const wh = detail.warehouses.find((row) => row.warehouseId === 'wh-vn');
    expect(wh?.status).toBe('current');
    expect(wh?.adoptedSkus).toEqual(['6974674957325']);
    expect(wh?.mappedSkus).toEqual(['6974674957325', '6974674957332', '6974674957349', '6974674957356']);
    expect(wh?.pendingAdoptionSkus).toEqual(['6974674957332', '6974674957349', '6974674957356']);
    // 只有 effective row 的 7325/899 进入本仓行，另外三条没有伪造数量行。
    expect(wh?.externalSku).toBe('6974674957325');
    expect(wh?.onHand).toBe(899);
    expect(detail.totals.knownSubtotal).toBe(1028);
  });

  it('详情等待采用分组包含“仅有待采用、无待确认来源行”的仓；合计区出同一句子', () => {
    const detail = normalizeItemDetail(rawDetail());
    const groups = detailPendingSourceDisplay(detail);
    const vnGroup = groups.find((group) => group.warehouseId === 'wh-vn');
    expect(vnGroup?.adoptedSkus).toEqual(['6974674957325']);
    expect(vnGroup?.pendingAdoptionSkus).toEqual(['6974674957332', '6974674957349', '6974674957356']);
    expect(vnGroup?.pendingSourceRows).toHaveLength(2);
    // unseen 仓只有“对应已确认等待采用”，也要出现在详情提示表里，不能被丢掉。
    const unseenGroup = groups.find((group) => group.warehouseId === 'wh-unseen');
    expect(unseenGroup).toBeTruthy();
    expect(unseenGroup?.adoptedSkus).toEqual([]);
    expect(unseenGroup?.pendingAdoptionSkus).toEqual(['9999999999999']);
    expect(unseenGroup?.pendingSourceRows).toEqual([]);
    const totals = detailTotalsDisplay(detail);
    expect(totals.subtotalText).toBe('1,028');
    expect(totals.gapText).toContain('对应已确认、等待下一次完整同步采用');
    expect(totals.gapText).not.toContain('已采用 SKU');
  });

  it('服务端只给 mappedSkus/adoptedSkus 时按契约派生 pendingAdoptionSkus（不改数量）', () => {
    const detail = normalizeItemDetail({
      ...(rawDetail() as Record<string, unknown>),
      pendingAdoptionWarehouses: [{
        warehouseId: VN.warehouseId,
        externalId: VN.externalId,
        name: VN.name,
        adoptedSkus: ['6974674957325'],
        mappedSkus: ['6974674957325', '6974674957332'],
      }],
    });
    expect(detail.pendingAdoptionWarehouses?.[0].pendingAdoptionSkus).toEqual(['6974674957332']);
    expect(detail.hasPendingAdoptionWarehouses).toBe(true);
    expect(detail.totals.knownSubtotal).toBe(1028);
  });
});
