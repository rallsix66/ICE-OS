import { describe, expect, it } from 'vitest';

import { planShipmentIdentities } from './identity';
import type { ParsedShipmentTicket, ShipmentIdentityIndexRow } from '../types';

function makeTicket(params: {
  ticketKey: string;
  purchaseOrder?: string | null;
  waybillsText?: string | null;
  market?: string | null;
  customsMethod?: string | null;
  productNameNorms?: string[];
}): ParsedShipmentTicket {
  const norms = params.productNameNorms ?? ['icelerskin糖水200ml'];
  return {
    ticketKey: params.ticketKey,
    ticketNo: params.ticketKey,
    sourceRowStart: 2,
    sourceRowEnd: 2 + norms.length - 1,
    market: params.market ?? '泰国',
    customsMethod: params.customsMethod ?? '普货',
    waybillsText: params.waybillsText ?? null,
    purchaseOrder: params.purchaseOrder ?? null,
    transportText: null,
    arrivalText: null,
    vessel: null,
    dispatchedText: null,
    statusClass: 'in_transit',
    receivedBasis: 'status_in_transit_zero',
    items: norms.map((norm, index) => ({
      itemKey: `${norm}#0`,
      productNameRaw: norm,
      productNameNorm: norm,
      shippedQuantity: 10,
      sourceReceivedQuantity: null,
      sourceReceiptBasis: null,
      sourceRow: 2 + index,
      sourceNote: null,
    })),
  };
}

function makeRow(params: {
  shipmentId: string;
  purchaseOrder?: string | null;
  waybillsText?: string | null;
  market?: string | null;
  customsMethod?: string | null;
  productNameNorms?: string[];
  identityStatus?: 'confirmed' | 'pending';
  identityNote?: string | null;
}): ShipmentIdentityIndexRow {
  return {
    shipmentId: params.shipmentId,
    ticketKey: params.purchaseOrder ? `PO:${params.purchaseOrder}` : params.waybillsText
      ? `WB:${params.waybillsText.split(/[\s/]+/)[0]}` : 'FB:泰国|普货|icelerskin糖水200ml',
    purchaseOrder: params.purchaseOrder ?? null,
    waybillsText: params.waybillsText ?? null,
    market: params.market ?? '泰国',
    customsMethod: params.customsMethod ?? '普货',
    productNameNorms: params.productNameNorms ?? ['icelerskin糖水200ml'],
    identityStatus: params.identityStatus ?? 'confirmed',
    identityNote: params.identityNote ?? null,
  };
}

describe('planShipmentIdentities（合同 §1.3 身份延续）', () => {
  it('补采购单号：弱身份原票按 市场/报关方式/品名 唯一匹配，沿用原票', () => {
    const existing = [makeRow({ shipmentId: 'row-weak-1' })];
    const tickets = [makeTicket({ ticketKey: 'PO:POKNZX027999', purchaseOrder: 'POKNZX027999' })];

    const [plan] = planShipmentIdentities(existing, tickets);

    expect(plan).toEqual({
      matchedShipmentId: 'row-weak-1',
      identityStatus: 'confirmed',
      identityNote: null,
    });
  });

  it('修改采购单号（运单号不变）：按运单 token 唯一匹配，不新建票', () => {
    const existing = [makeRow({ shipmentId: 'row-1', purchaseOrder: 'POKNZX027080', waybillsText: '88035691' })];
    const tickets = [makeTicket({
      ticketKey: 'PO:POKNZX029999',
      purchaseOrder: 'POKNZX029999',
      waybillsText: '88035691/88035692',
    })];

    const [plan] = planShipmentIdentities(existing, tickets);

    expect(plan?.matchedShipmentId).toBe('row-1');
    expect(plan?.identityStatus).toBe('confirmed');
  });

  it('弱身份票补运单号：按弱签名唯一匹配，沿用原票', () => {
    const existing = [makeRow({ shipmentId: 'row-weak-2' })];
    const tickets = [makeTicket({ ticketKey: 'WB:GLLAN26102705874PHE', waybillsText: 'GLLAN26102705874PHE' })];

    const [plan] = planShipmentIdentities(existing, tickets);

    expect(plan?.matchedShipmentId).toBe('row-weak-2');
    expect(plan?.identityStatus).toBe('confirmed');
  });

  it('无运单号改采购单号：弱证据无法唯一确认 → 新建并标身份待核（不合并）', () => {
    const existing = [makeRow({ shipmentId: 'row-po-only', purchaseOrder: 'GLACZ-20261022009862' })];
    const tickets = [makeTicket({
      ticketKey: 'PO:GLACZ-20261022009999',
      purchaseOrder: 'GLACZ-20261022009999',
    })];

    const [plan] = planShipmentIdentities(existing, tickets);

    expect(plan?.matchedShipmentId).toBeNull();
    expect(plan?.identityStatus).toBe('pending');
    expect(plan?.identityNote).toContain('GLACZ-20261022009862');
    expect((plan?.identityNote ?? '').length).toBeLessThanOrEqual(500);
  });

  it('编号与内容都没变：按采购单号匹配，无待核说明', () => {
    const existing = [makeRow({ shipmentId: 'row-1', purchaseOrder: 'POKNZX027080', waybillsText: '88035691' })];
    const tickets = [makeTicket({
      ticketKey: 'PO:POKNZX027080',
      purchaseOrder: 'POKNZX027080',
      waybillsText: '88035691',
    })];

    const [plan] = planShipmentIdentities(existing, tickets);

    expect(plan).toEqual({ matchedShipmentId: 'row-1', identityStatus: 'confirmed', identityNote: null });
  });

  it('待核行被正常重读（编号/内容不变）：保留同一 UUID、pending 与原候选说明', () => {
    const note = '采购单号变化且双方都没有运单号，只能靠弱信号确认；已保留原票并新建本票：GLACZ-20261022009862（马来西亚）';
    const existing = [makeRow({
      shipmentId: 'row-pending-before',
      purchaseOrder: 'POKNZX027900',
      waybillsText: '88030001',
      identityStatus: 'pending',
      identityNote: note,
    })];
    const tickets = [makeTicket({
      ticketKey: 'PO:POKNZX027900',
      purchaseOrder: 'POKNZX027900',
      waybillsText: '88030001',
    })];

    const [plan] = planShipmentIdentities(existing, tickets);

    expect(plan?.matchedShipmentId).toBe('row-pending-before');
    expect(plan?.identityStatus).toBe('pending');
    expect(plan?.identityNote).toBe(note);
  });

  it('普通刷新只改变业务内容（G/H/数量）时，待核状态与说明不因“命中自己”而解除', () => {
    const note = '采购单号变化且双方都没有运单号；已保留原票并新建本票：GLACZ-20261022009862（马来西亚）';
    const existing = [makeRow({
      shipmentId: 'row-pending-self',
      purchaseOrder: 'GLACZ-20261022009999',
      identityStatus: 'pending',
      identityNote: note,
    })];
    const tickets = [makeTicket({
      ticketKey: 'PO:GLACZ-20261022009999',
      purchaseOrder: 'GLACZ-20261022009999',
    })];

    const [plan] = planShipmentIdentities(existing, tickets);

    expect(plan).toEqual({
      matchedShipmentId: 'row-pending-self', identityStatus: 'pending', identityNote: note,
    });
  });

  it('已确认行重读仍是 confirmed，没有待核说明', () => {
    const existing = [makeRow({
      shipmentId: 'row-1',
      purchaseOrder: 'POKNZX027080',
      waybillsText: '88035691',
      identityStatus: 'confirmed',
    })];
    const tickets = [makeTicket({
      ticketKey: 'PO:POKNZX027080',
      purchaseOrder: 'POKNZX027080',
      waybillsText: '88035691',
    })];

    const [plan] = planShipmentIdentities(existing, tickets);

    expect(plan).toEqual({ matchedShipmentId: 'row-1', identityStatus: 'confirmed', identityNote: null });
  });

  it('两张无编号原票同签名：候选多于 1 → 身份待核，不静默合并', () => {
    const existing = [
      makeRow({ shipmentId: 'row-weak-a' }),
      makeRow({ shipmentId: 'row-weak-b' }),
    ];
    const tickets = [makeTicket({ ticketKey: 'FB:泰国|普货|icelerskin糖水200ml' })];

    const [plan] = planShipmentIdentities(existing, tickets);

    expect(plan?.matchedShipmentId).toBeNull();
    expect(plan?.identityStatus).toBe('pending');
    expect((plan?.identityNote ?? '').length).toBeLessThanOrEqual(500);
  });

  it('同一原票不会被两张票同时匹配：第二张标待核且不占用原票', () => {
    const existing = [makeRow({ shipmentId: 'row-1', purchaseOrder: 'POKNZX027080', waybillsText: '88035691' })];
    const tickets = [
      makeTicket({ ticketKey: 'PO:POKNZX027080', purchaseOrder: 'POKNZX027080' }),
      makeTicket({ ticketKey: 'WB:88035691', waybillsText: '88035691' }),
    ];

    const plan = planShipmentIdentities(existing, tickets);

    expect(plan[0]).toEqual({ matchedShipmentId: 'row-1', identityStatus: 'confirmed', identityNote: null });
    expect(plan[1]?.matchedShipmentId).toBeNull();
    expect(plan[1]?.identityStatus).toBe('pending');
    expect(plan[1]?.identityNote).toContain('POKNZX027080');
  });

  it('完全没有候选：确认是新票（不因为同市场同商品就怀疑新票）', () => {
    const existing = [makeRow({
      shipmentId: 'row-1',
      purchaseOrder: 'POKNZX027001',
      waybillsText: '88010001',
    })];
    const tickets = [makeTicket({
      ticketKey: 'PO:POKNZX028001',
      purchaseOrder: 'POKNZX028001',
      waybillsText: '88020002',
    })];

    const [plan] = planShipmentIdentities(existing, tickets);

    expect(plan).toEqual({ matchedShipmentId: null, identityStatus: 'confirmed', identityNote: null });
  });

  it('结果与传入票同序（前一张匹配不影响后面票的顺序）', () => {
    const existing = [
      makeRow({ shipmentId: 'row-1', purchaseOrder: 'POKNZX027080', waybillsText: '88035691' }),
      makeRow({ shipmentId: 'row-weak-1' }),
    ];
    const tickets = [
      makeTicket({ ticketKey: 'PO:POKNZX027080', purchaseOrder: 'POKNZX027080' }),
      makeTicket({ ticketKey: 'FB:泰国|普货|icelerskin糖水200ml' }),
    ];

    const plan = planShipmentIdentities(existing, tickets);

    expect(plan.map((entry) => entry.matchedShipmentId)).toEqual(['row-1', 'row-weak-1']);
  });

  it('老弱票本次仍在 + 新带采购单号的同签名票：新票确认、旧票不被占用（反例 a）', () => {
    const existing = [makeRow({ shipmentId: 'row-weak-live' })];
    const tickets = [
      makeTicket({ ticketKey: 'FB:泰国|普货|icelerskin糖水200ml' }),
      makeTicket({ ticketKey: 'PO:POKNZX030001', purchaseOrder: 'POKNZX030001' }),
    ];

    const plan = planShipmentIdentities(existing, tickets);

    // 第 2 步已把弱身份原票交给第一条（本次仍以无编号行出现的原票）；
    // 第二条带编号的新票不能再拿它当补号目标，也不应标身份待核。
    expect(plan[0]).toEqual({ matchedShipmentId: 'row-weak-live', identityStatus: 'confirmed', identityNote: null });
    expect(plan[1]).toEqual({ matchedShipmentId: null, identityStatus: 'confirmed', identityNote: null });
  });

  it('有运单号的原票本次仍在 + 新无运单号的同签名采购单号票：新票确认（反例 b）', () => {
    const existing = [makeRow({
      shipmentId: 'row-with-waybill',
      purchaseOrder: 'POKNZX027080',
      waybillsText: '88035691',
    })];
    const tickets = [
      makeTicket({ ticketKey: 'PO:POKNZX027080', purchaseOrder: 'POKNZX027080', waybillsText: '88035691' }),
      makeTicket({ ticketKey: 'PO:POKNZX030002', purchaseOrder: 'POKNZX030002' }),
    ];

    const plan = planShipmentIdentities(existing, tickets);

    expect(plan[0]).toEqual({
      matchedShipmentId: 'row-with-waybill', identityStatus: 'confirmed', identityNote: null,
    });
    expect(plan[1]).toEqual({ matchedShipmentId: null, identityStatus: 'confirmed', identityNote: null });
  });
});
