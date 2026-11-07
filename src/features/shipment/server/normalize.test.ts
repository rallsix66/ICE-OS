import { describe, expect, it } from 'vitest';

import {
  mergeManualDetail,
  mergeManualListRows,
  normalizeDetail,
  normalizeList,
  normalizeManualHistory,
  normalizeManualIndex,
  normalizeGroupingReviewDetail,
  normalizeGroupingReviews,
  normalizeManualResult,
  normalizeProductTransit,
  type ShipmentManualIndex,
} from './normalize';
import type { ShipmentListRowDto } from '../types';

/**
 * 第八轮归一化单测：029 的人工修正索引/历史/动作结果，以及列表/详情的人工字段合并。
 *
 * 断言重点：缺少人工字段时按“未人工修正”处理（source_* 与生效值一致）、
 * manual index/history 读取失败只降级这些字段、未知值保持 null 不写 0。
 */

function listRow(overrides: Partial<ShipmentListRowDto> = {}): ShipmentListRowDto {
  return {
    shipmentId: 'shipment-1',
    market: '泰国',
    purchaseOrder: 'POKNZX027080',
    waybillsText: '88035691',
    ticketNo: 'POKNZX027080',
    itemCount: 1,
    productSummary: ['ICELERSKIN乙醇酸爽肤水200ml'],
    statusClass: 'in_transit',
    effectiveStatusClass: 'in_transit',
    manualCorrectionCount: 0,
    manualReviewCount: 0,
    transportText: '11/3 排队送往拆派仓',
    arrivalText: null,
    quantityPending: false,
    identityStatus: 'confirmed',
    identityNote: null,
    presentInLatestRead: true,
    lastSeenAt: '2026-11-04T06:23:00.000Z',
    ...overrides,
  };
}

/** 026 详情 JSON 形状（不含 manual 字段）：用于验证默认值与合并。 */
function detailRaw(): Record<string, unknown> {
  return {
    shipment: {
      shipmentId: 'shipment-1',
      ticketNo: 'POKNZX027080',
      ticketKey: 'PO:POKNZX027080',
      market: '菲律宾',
      customsMethod: '百世正报',
      waybillsText: 'BSPHS2610121599842',
      purchaseOrder: 'POKNZX027080',
      statusClass: 'in_transit',
      transportText: '11/3 排队送往拆派仓',
      arrivalText: null,
      vessel: null,
      dispatchedText: null,
      itemCount: 1,
      quantityPending: false,
      identityStatus: 'confirmed',
      identityNote: null,
      presentInLatestRead: true,
      sourceRowStart: 9,
      sourceRowEnd: 9,
      firstSeenAt: '2026-11-01T09:00:00.000Z',
      lastSeenAt: '2026-11-04T06:23:00.000Z',
      revision: 2,
    },
    items: [{
      itemId: 'item-1',
      itemKey: 'icelerskin乙醇酸爽肤水200ml#0',
      productNameRaw: 'ICELERSKIN乙醇酸爽肤水200ml',
      productNameNorm: 'icelerskin乙醇酸爽肤水200ml',
      shippedQuantity: 57000,
      receivedQuantity: 0,
      receiptBasis: 'status_in_transit_zero',
      remainingQuantity: 57000,
      remainingState: 'known',
      unitText: null,
      sourceSku: null,
      sourceNote: null,
      product: { itemId: 'product-1', iceCode: 'LS101501', nameCn: 'ICE LERSKIN 7% 乙醇酸爽肤水' },
      associationStatus: 'manual',
      associationMethod: 'manual_selected',
      associatedAt: '2026-11-01T09:30:00.000Z',
      revision: 3,
    }],
    missingItems: [],
    revisions: [],
    latestReadAt: '2026-11-04T06:23:00.000Z',
    sourceStatus: {
      sourceKey: 'feishu_logistics_sheet',
      docTitle: '物流情况表',
      sheetTitle: 'Sheet1',
      lastSuccess: null,
      lastAttempt: null,
      autoReader: null,
    },
  };
}

describe('第八轮 manual 归一化', () => {
  it('normalizeManualIndex：票级有效状态/计数与明细人工字段', () => {
    const index = normalizeManualIndex({
      shipments: [{
        shipmentId: 'shipment-1',
        effectiveStatusClass: 'arrived',
        manualCorrectionCount: 1,
        manualReviewCount: 0,
        manualConflictCount: 0,
      }, { shipmentId: '', effectiveStatusClass: 'unknown' }],
      items: [{
        itemId: 'item-1',
        shipmentId: 'shipment-1',
        manualStatus: 'fully_shelved',
        manualShelvedQuantity: null,
        manualActorName: '张三',
        manualAt: '2026-11-04T06:30:00.000Z',
        manualRevision: 2,
        manualReviewNeeded: true,
        manualReviewNote: '原表到货说明/数量已更新，请复核人工修正',
        sourceReceivedQuantity: 0,
        sourceReceiptBasis: 'status_in_transit_zero',
        effectiveReceivedQuantity: 57000,
        effectiveRemainingQuantity: 0,
      }, { itemId: '', shipmentId: 'shipment-1' }],
    });
    expect(index.shipments).toEqual([{
      shipmentId: 'shipment-1',
      effectiveStatusClass: 'arrived',
      manualCorrectionCount: 1,
      manualReviewCount: 0,
      manualConflictCount: 0,
    }]);
    expect(index.items).toHaveLength(1);
    expect(index.items[0]).toMatchObject({
      manualStatus: 'fully_shelved',
      manualRevision: 2,
      manualReviewNeeded: true,
      sourceReceiptBasis: 'status_in_transit_zero',
      sourceReceivedQuantity: 0,
    });
  });

  it('normalizeManualIndex：非法人工状态/空结构不写 0、不抛错', () => {
    const index = normalizeManualIndex({
      shipments: [],
      items: [{ itemId: 'item-1', manualStatus: 'bogus', manualRevision: 'x' }],
    });
    expect(index.items[0]?.manualStatus).toBeNull();
    expect(index.items[0]?.manualRevision).toBe(0);
    expect(index.items[0]?.sourceReceivedQuantity).toBeNull();
    expect(normalizeManualIndex(null)).toEqual({ shipments: [], items: [] });
  });

  it('normalizeManualHistory：apply/restore 动作与未知值', () => {
    const history = normalizeManualHistory([{
      itemId: 'item-1',
      productNameRaw: 'ICELERSKIN乙醇酸爽肤水200ml',
      revision: 2,
      action: 'restore',
      manualStatus: null,
      manualShelvedQuantity: null,
      previousManualStatus: 'fully_shelved',
      previousManualShelvedQuantity: null,
      receivedQuantity: 0,
      remainingQuantity: 57000,
      actorName: '张三',
      note: null,
      recordedAt: '2026-11-04T06:40:00.000Z',
    }, {
      itemId: 'item-1',
      revision: 1,
      action: 'apply',
      receivedQuantity: null,
    }]);
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ action: 'restore', previousManualStatus: 'fully_shelved', remainingQuantity: 57000 });
    expect(history[1]).toMatchObject({ action: 'apply', receivedQuantity: null });
  });

  it('normalizeManualResult：成功与业务拒绝都保留结构化 errorCode', () => {
    const ok = normalizeManualResult({
      ok: true, itemId: 'item-1', manualStatus: 'partial_shelved', manualShelvedQuantity: 64000,
      receivedQuantity: 64000, remainingQuantity: 0, receiptBasis: 'manual_correction',
      manualRevision: 2, manualActorName: '张三', manualAt: '2026-11-04T06:30:00.000Z',
      reviewNeeded: false, errorCode: null, errorMessage: null,
    });
    expect(ok).toMatchObject({
      ok: true,
      manualStatus: 'partial_shelved',
      manualShelvedQuantity: 64000,
      receivedQuantity: 64000,
      remainingQuantity: 0,
      receiptBasis: 'manual_correction',
      manualRevision: 2,
    });

    const rejected = normalizeManualResult({
      ok: false, itemId: 'item-1', receivedQuantity: null, remainingQuantity: null,
      receiptBasis: 'pending', manualRevision: 1,
      errorCode: 'SHIPMENT_MANUAL_CONFLICT', errorMessage: '已被更新',
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.errorCode).toBe('SHIPMENT_MANUAL_CONFLICT');
    expect(rejected.receivedQuantity).toBeNull();
  });

  it('normalizeList / normalizeDetail：无人工字段时按未人工修正处理（source_* = 生效值）', () => {
    const list = normalizeList({
      total: 1, offset: 0, limit: 20, rows: [listRow()], counts: {}, markets: [],
      includeAbsent: false, absentTickets: 0, absentItems: 0, latestReadAt: null,
      sourceStatus: { sourceKey: 'feishu_logistics_sheet' },
    });
    expect(list.rows[0]).toMatchObject({
      effectiveStatusClass: 'in_transit', manualCorrectionCount: 0, manualReviewCount: 0,
    });

    const detail = normalizeDetail(detailRaw())!;
    expect(detail.shipment).toMatchObject({ effectiveStatusClass: 'in_transit', manualCorrectionCount: 0 });
    expect(detail.items[0]).toMatchObject({
      manualStatus: null,
      manualRevision: 0,
      manualReviewNeeded: false,
      sourceReceivedQuantity: 0,
      sourceReceiptBasis: 'status_in_transit_zero',
      receiptBasis: 'status_in_transit_zero',
    });
    expect(detail.manualRevisions).toEqual([]);
  });

  it('mergeManualListRows：按 shipmentId 合并有效状态与计数；index 缺失时原样返回', () => {
    const rows = [listRow(), listRow({ shipmentId: 'shipment-2' })];
    const index: ShipmentManualIndex = {
      shipments: [{
        shipmentId: 'shipment-1',
        effectiveStatusClass: 'arrived',
        manualCorrectionCount: 2,
        manualReviewCount: 1,
        manualConflictCount: 0,
      }],
      items: [],
    };
    const merged = mergeManualListRows(rows, index);
    expect(merged[0]).toMatchObject({
      effectiveStatusClass: 'arrived', manualCorrectionCount: 2, manualReviewCount: 1,
    });
    expect(merged[1]?.effectiveStatusClass).toBe('in_transit');
    expect(mergeManualListRows(rows, null)).toBe(rows);
  });

  it('mergeManualDetail：合并票级有效状态、明细人工字段与历史；index/history 缺失只降级', () => {
    const detail = normalizeDetail(detailRaw())!;
    const index: ShipmentManualIndex = {
      shipments: [{
        shipmentId: 'shipment-1',
        effectiveStatusClass: 'arrived',
        manualCorrectionCount: 1,
        manualReviewCount: 0,
        manualConflictCount: 0,
      }],
      items: [{
        itemId: 'item-1',
        shipmentId: 'shipment-1',
        manualStatus: 'fully_shelved',
        manualShelvedQuantity: null,
        manualShippedQuantity: 100,
        previousConfirmedShelvedQuantity: 100,
        manualConflict: false,
        manualActorName: '张三',
        manualAt: '2026-11-04T06:30:00.000Z',
        manualRevision: 1,
        manualReviewNeeded: false,
        manualReviewNote: null,
        sourceReceivedQuantity: 0,
        sourceReceiptBasis: 'status_in_transit_zero',
      }],
    };
    const history = normalizeManualHistory([{
      itemId: 'item-1', revision: 1, action: 'apply', actorName: '张三',
      manualStatus: 'fully_shelved', receivedQuantity: 57000, remainingQuantity: 0,
      recordedAt: '2026-11-04T06:30:00.000Z',
    }]);
    const merged = mergeManualDetail(detail, index, history);
    expect(merged.shipment.effectiveStatusClass).toBe('arrived');
    expect(merged.shipment.manualCorrectionCount).toBe(1);
    // 生效数量仍来自 026 详情（029 只改 received_quantity 列，不重复计算）。
    expect(merged.items[0]).toMatchObject({
      receivedQuantity: 0,
      remainingQuantity: 57000,
      manualStatus: 'fully_shelved',
      manualActorName: '张三',
      manualRevision: 1,
      sourceReceiptBasis: 'status_in_transit_zero',
    });
    expect(merged.manualRevisions).toHaveLength(1);

    const degraded = mergeManualDetail(detail, null, null);
    expect(degraded.shipment.effectiveStatusClass).toBe('in_transit');
    expect(degraded.items[0]?.manualStatus).toBeNull();
    expect(degraded.manualRevisions).toEqual([]);
  });
});

describe('032 商品在途逐条明细归一化', () => {
  it('normalizeProductTransit：items[] 逐条保留发货/采用累计/冲突/人工修正，未知保持 null', () => {
    const source = normalizeProductTransit({
      productId: 'product-1',
      latestReadAt: '2026-11-06T02:10:13.587Z',
      snapshotId: 'snap-1',
      tickets: [{
        shipmentId: 's-1',
        ticketNo: 'POKNZX099999',
        purchaseOrder: 'POKNZX099999',
        market: '越南',
        waybillsText: 'A\nB',
        statusClass: 'in_transit',
        effectiveStatusClass: 'partial',
        transportText: '',
        arrivalText: '三酸喷雾：已到货上架',
        ticketItemCount: 2,
        items: [
          { itemId: 'item-a', shippedQuantity: 100, receivedQuantity: 0, manualConflict: false, manualCorrected: false },
          { itemId: 'item-b', shippedQuantity: 50, receivedQuantity: null, manualConflict: true, manualCorrected: true },
        ],
      }],
    });

    expect(source.productId).toBe('product-1');
    expect(source.latestReadAt).toBe('2026-11-06T02:10:13.587Z');
    expect(source.snapshotId).toBe('snap-1');
    expect(source.tickets).toHaveLength(1);
    expect(source.tickets[0]).toMatchObject({
      shipmentId: 's-1',
      ticketNo: 'POKNZX099999',
      transportText: null,
      arrivalText: '三酸喷雾：已到货上架',
      ticketItemCount: 2,
      effectiveStatusClass: 'partial',
    });
    expect(source.tickets[0].items).toEqual([
      { itemId: 'item-a', shippedQuantity: 100, receivedQuantity: 0, manualConflict: false, manualCorrected: false },
      { itemId: 'item-b', shippedQuantity: 50, receivedQuantity: null, manualConflict: true, manualCorrected: true },
    ]);
  });

  it('normalizeProductTransit：缺 items 时不伪造数量，按空明细由构建层判待核', () => {
    const source = normalizeProductTransit({
      productId: 'product-1',
      snapshotId: 'snap-1',
      tickets: [{ shipmentId: 's-1', ticketNo: 'T-1' }],
    });
    expect(source.tickets[0].items).toEqual([]);
    expect(source.tickets[0].ticketItemCount).toBe(0);
  });
});

describe('第十四轮：已有人工决定补充市场/票号/运单号', () => {
  const evidence = {
    kind: 'split',
    previous: {
      snapshotId: 's-prev',
      tickets: [{
        ticketKey: 'WB:9258750', ticketNo: '9258750', market: '泰国',
        waybillsText: '9258750', purchaseOrder: null, sourceRowStart: 2, sourceRowEnd: 10,
        items: [{ productNameRaw: '商品A', productNameNorm: '商品a', shippedQuantity: 10 }],
      }],
    },
    current: {
      snapshotId: 's-cur',
      tickets: [{
        ticketKey: 'WB:9258750', ticketNo: '9258750', market: '泰国',
        waybillsText: '9258750', purchaseOrder: null, sourceRowStart: 2, sourceRowEnd: 3,
        items: [{ productNameRaw: '商品A', productNameNorm: '商品a', shippedQuantity: 10 }],
      }, {
        ticketKey: 'PO:POKNZX-B', ticketNo: 'POKNZX-B', market: '越南',
        waybillsText: '88000001', purchaseOrder: 'POKNZX-B', sourceRowStart: 11, sourceRowEnd: 12,
        items: [{ productNameRaw: '商品B', productNameNorm: '商品b', shippedQuantity: 20 }],
      }],
    },
    affectedProducts: ['商品a', '商品b'],
  };

  it('activeOverrides 带 market/ticketNo/waybillsText（缺失保持 null）', () => {
    const reviews = normalizeGroupingReviews({
      pending: [],
      activeOverrides: [{
        id: 'ov-1', reviewId: 'review-1', kind: 'merge', reviewKind: 'split',
        decision: 'keep_one', signature: 's', createdAt: '2026-11-07T00:00:00.000Z',
        market: '泰国', ticketNo: '9258750', waybillsText: '9258750',
      }, {
        id: 'ov-2', reviewId: 'review-2', kind: 'split', reviewKind: 'merge',
        decision: 'keep_separate', signature: 's2', createdAt: null,
      }],
    });
    expect(reviews.activeOverrides[0]).toMatchObject({
      market: '泰国', ticketNo: '9258750', waybillsText: '9258750',
    });
    expect(reviews.activeOverrides[1]).toMatchObject({
      market: null, ticketNo: null, waybillsText: null,
    });
  });

  it('单条复核读取返回 evidence（任意状态）；不存在返回 null', () => {
    const review = normalizeGroupingReviewDetail({
      id: 'review-1', kind: 'split', status: 'resolved', decision: 'keep_one',
      signature: 'sig', evidence, createdAt: '2026-11-07T00:00:00.000Z',
      resolvedAt: '2026-11-07T00:01:00.000Z', resolutionNote: '受控',
    });
    expect(review?.id).toBe('review-1');
    expect(review?.status).toBe('resolved');
    expect(review?.decision).toBe('keep_one');
    expect(review?.evidence.previous.tickets).toHaveLength(1);
    expect(review?.evidence.current.tickets).toHaveLength(2);
    expect(review?.evidence.current.tickets[1]?.purchaseOrder).toBe('POKNZX-B');
    expect(normalizeGroupingReviewDetail(null)).toBeNull();
    expect(normalizeGroupingReviewDetail({ kind: 'split' })).toBeNull();
  });
});
