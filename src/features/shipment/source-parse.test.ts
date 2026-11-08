import { describe, expect, it } from 'vitest';

import {
  classifyShipmentArrival,
  computeLastNonEmptyRow,
  normalizeProductName,
  parseShipmentSnapshot,
  resolveShipmentHeaders,
  shipmentFallbackSignature,
  splitWaybills,
} from './server/parse';
import { ShipmentSourceError, SHIPMENT_SOURCE_KEY, type ShipmentSourceCollection } from './types';

function collection(overrides: Partial<ShipmentSourceCollection> = {}): ShipmentSourceCollection {
  return {
    sourceKey: SHIPMENT_SOURCE_KEY,
    url: 'https://example.feishu.cn/wiki/node?sheet=b42d8b',
    docTitle: '物流情况表',
    docToken: 'token',
    documentEditedAt: '2026-10-30T09:48:51Z',
    sheetId: 'b42d8b',
    sheetTitle: 'Sheet1',
    revision: 1836,
    readStartedAt: '2026-11-01T00:00:00.000Z',
    readFinishedAt: '2026-11-01T00:00:02.000Z',
    readBy: null,
    gridRows: 2,
    readRows: 2,
    lastNonEmptyRow: 1,
    headers: [],
    merges: [],
    rawContentHash: 'hash',
    ...overrides,
  };
}

const HEADER = ['产品', '数量', '国家', '报关方式', '运单号', '采购单号', '物流情况', '预计到货时间', '船名', '发出时间'];

function ticketRows(): Array<Array<string | number | null>> {
  return [
    HEADER,
    // 一票三明细：票级字段只在首行；G=运输进度
    ['产品A', 100, '菲律宾', '喜运达双清', 'WB-1', 'PO-1', '10/30 已离港', null, 'SHIP-1', null],
    ['产品B', 60, null, null, null, null, null, null, null, null],
    ['产品B', 40, null, null, null, null, null, null, null, null],
    // 单行票：靠运单号识别
    ['产品C', 7, '泰国', '百世正报', 'WB-2', null, '10/29 清关中', null, null, null],
    // H 写整票已上架：G 为空
    ['产品D', 5, '越南', '晟邦', 'WB-3', null, null, '已到货上架', null, null],
    // H 只说明某张运单已到：部分到货
    ['产品E', 9, '越南', '晟邦', 'WB-4', null, '已到货上架', '88035152 已到货，待上架', null, null],
    // 无状态
    ['产品F', 3, '马来西亚', '飞越双清', null, null, null, null, null, null],
    // 空行
    [null, null, null, null, null, null, null, null, null, null],
  ];
}

describe('shipment source parse', () => {
  it('按表头名称定位并分组：国家非空=新票，票级字段只取首行', () => {
    const parsed = parseShipmentSnapshot({ collection: collection(), values: ticketRows(), merges: [] });
    expect(parsed.tickets).toHaveLength(5);
    const first = parsed.tickets[0]!;
    expect(first.ticketKey).toBe('PO:PO-1');
    expect(first.ticketNo).toBe('PO-1');
    expect(first.market).toBe('菲律宾');
    expect(first.transportText).toBe('10/30 已离港');
    expect(first.arrivalText).toBeNull();
    expect(first.items).toHaveLength(3);
    expect(first.items.map((item) => item.shippedQuantity)).toEqual([100, 60, 40]);
    expect(parsed.tickets[1]!.ticketKey).toBe('WB:WB-2');
    expect(parsed.tickets[4]!.ticketKey.startsWith('FB:马来西亚|飞越双清|')).toBe(true);
    expect(parsed.tickets[4]!.ticketNo).toBe('无单号·马来西亚·行8');
    expect(parsed.collection.lastNonEmptyRow).toBe(8);
  });

  it('同票重复品名按出现序号区分，不合并、不累加', () => {
    const parsed = parseShipmentSnapshot({ collection: collection(), values: ticketRows(), merges: [] });
    const items = parsed.tickets[0]!.items;
    expect(items.map((item) => item.itemKey)).toEqual(['产品a#0', '产品b#0', '产品b#1']);
    expect(items[1]!.shippedQuantity).toBe(60);
    expect(items[2]!.shippedQuantity).toBe(40);
  });

  it('到货口径只按 H：H=整票已上架→arrived；H=某运单已到→partial；无状态→unknown；G=已离港→in_transit', () => {
    const parsed = parseShipmentSnapshot({ collection: collection(), values: ticketRows(), merges: [] });
    const byTicket = new Map(parsed.tickets.map((ticket) => [ticket.ticketNo, ticket]));
    expect(byTicket.get('PO-1')).toMatchObject({ statusClass: 'in_transit', receivedBasis: 'status_in_transit_zero' });
    expect(byTicket.get('WB-3')).toMatchObject({ statusClass: 'arrived', receivedBasis: 'status_arrived_full' });
    expect(byTicket.get('WB-4')).toMatchObject({ statusClass: 'partial', receivedBasis: 'pending' });
    expect(byTicket.get('无单号·马来西亚·行8')).toMatchObject({ statusClass: 'unknown', receivedBasis: 'pending' });
  });

  it('本版来源没有到货数量列：sourceReceivedQuantity 为 null，不把缺失写成 0', () => {
    const parsed = parseShipmentSnapshot({ collection: collection(), values: ticketRows(), merges: [] });
    for (const ticket of parsed.tickets) {
      for (const item of ticket.items) expect(item.sourceReceivedQuantity).toBeNull();
    }
  });

  it('表头重排仍能定位；缺必填列报 SOURCE_HEADER_MISMATCH', () => {
    const reordered = [
      ['数量', '国家', '产品', '运单号'],
      [12, '泰国', '产品A', 'WB-9'],
    ];
    const parsed = parseShipmentSnapshot({ collection: collection(), values: reordered, merges: [] });
    expect(parsed.tickets[0]!.items[0]!.shippedQuantity).toBe(12);
    expect(() =>
      parseShipmentSnapshot({ collection: collection(), values: [['数量', '国家'], [1, '泰国']], merges: [] }),
    ).toThrowError(ShipmentSourceError);
    expect(resolveShipmentHeaders(['产品', '数量', '国家'])).toHaveLength(3);
  });

  it('数量非正整数、产品无、无起始票都报网格错误，不发布半份数据', () => {
    const badQty = [HEADER, ['产品A', 'abc', '泰国', null, null, null, null, null, null, null]];
    expect(() => parseShipmentSnapshot({ collection: collection(), values: badQty, merges: [] })).toThrow(/数量/);
    const noMarket = [HEADER, ['产品A', 5, null, null, null, null, null, null, null, null]];
    expect(() => parseShipmentSnapshot({ collection: collection(), values: noMarket, merges: [] })).toThrow(/缺少「国家」/);
    const noProduct = [HEADER, [null, 5, '泰国', null, null, null, null, null, null, null]];
    expect(() => parseShipmentSnapshot({ collection: collection(), values: noProduct, merges: [] })).toThrow(/缺少产品名称/);
  });

  it('同一票标识重复时拒绝，不合并成一张票（提示补单号）', () => {
    const duplicated = [
      HEADER,
      ['产品A', 1, '泰国', null, 'WB-1', 'PO-1', null, null, null, null],
      ['产品B', 1, '泰国', null, 'WB-2', 'PO-1', null, null, null, null],
    ];
    expect(() => parseShipmentSnapshot({ collection: collection(), values: duplicated, merges: [] }))
      .toThrow(/补上单号/);
  });

  it('品名规范化、弱身份签名与运单号切分', () => {
    expect(normalizeProductName('  ICE LERSKIN\u3000护发精油-无花果 ')).toBe('icelerskin护发精油-无花果');
    expect(normalizeProductName('ＣＨＩＣ.PEAK 唇泥')).toBe('chic.peak唇泥');
    expect(computeLastNonEmptyRow([HEADER, ['a', 1], [null, null], [null, null]])).toBe(2);
    expect(shipmentFallbackSignature(' 泰国 ', '百世正报', ['b', 'a', 'a']))
      .toBe(shipmentFallbackSignature('泰国', '百世正报', ['a', 'b']));
    expect(shipmentFallbackSignature('泰国', '百世正报', ['a']))
      .not.toBe(shipmentFallbackSignature('越南', '百世正报', ['a']));
    expect(splitWaybills('88036324/88036325\n88035152').tokens).toEqual(['88036324', '88036325', '88035152']);
    expect(splitWaybills(null)).toEqual({ raw: '', tokens: [] });
  });
});

describe('到货判断只依据 H（G 只作为在途证据，不干扰到货）', () => {
  it('H=整票已到货上架 → arrived（即使 G 仍写清关中）', () => {
    expect(classifyShipmentArrival('10/30 清关中', '已到货上架'))
      .toEqual({ statusClass: 'arrived', receivedBasis: 'status_arrived_full' });
    expect(classifyShipmentArrival('10/30 已拆柜，待安排派送', '10/30 已到货上架'))
      .toEqual({ statusClass: 'arrived', receivedBasis: 'status_arrived_full' });
    expect(classifyShipmentArrival('10/30 清关中', '已上架'))
      .toEqual({ statusClass: 'arrived', receivedBasis: 'status_arrived_full' });
  });

  it('H=整票已到未上架 → arrived_pending_shelving，按未结束在途计', () => {
    expect(classifyShipmentArrival(null, '已到货，待上架'))
      .toEqual({ statusClass: 'arrived_pending_shelving', receivedBasis: 'status_awaiting_shelving_zero' });
    expect(classifyShipmentArrival('10/29 已离港', '已到货'))
      .toEqual({ statusClass: 'arrived_pending_shelving', receivedBasis: 'status_awaiting_shelving_zero' });
    expect(classifyShipmentArrival(null, '已到货，待上架\n已到货上架'))
      .toEqual({ statusClass: 'arrived_pending_shelving', receivedBasis: 'status_awaiting_shelving_zero' });
  });

  it('分批/部分/某商品或某运单已到 → partial（数量待核，不猜）', () => {
    expect(classifyShipmentArrival(null, '88035694已到105件，余40件未到'))
      .toEqual({ statusClass: 'partial', receivedBasis: 'pending' });
    expect(classifyShipmentArrival(null, '三酸喷雾：已到货上架'))
      .toEqual({ statusClass: 'partial', receivedBasis: 'pending' });
    expect(classifyShipmentArrival(null, '88036324/88036325 已到货上架\n88035152 已到货，待上架'))
      .toEqual({ statusClass: 'partial', receivedBasis: 'pending' });
    expect(classifyShipmentArrival(null, '已到货上架\n88035948 待装柜'))
      .toEqual({ statusClass: 'partial', receivedBasis: 'pending' });
  });

  it('H 为空或只有预计日期/进度 → 不当作到货，按 G 的运输进度在途', () => {
    expect(classifyShipmentArrival('10/30 已离港', null))
      .toEqual({ statusClass: 'in_transit', receivedBasis: 'status_in_transit_zero' });
    expect(classifyShipmentArrival(null, '预计11.3号到港'))
      .toEqual({ statusClass: 'in_transit', receivedBasis: 'status_in_transit_zero' });
    expect(classifyShipmentArrival('7/3 FDA查验', '时间待定'))
      .toEqual({ statusClass: 'in_transit', receivedBasis: 'status_in_transit_zero' });
    expect(classifyShipmentArrival('88035696 10/29已转胡志明127件', null))
      .toEqual({ statusClass: 'in_transit', receivedBasis: 'status_in_transit_zero' });
  });

  it('两列都没有可判断内容 → unknown，累计到货/剩余在途待核', () => {
    expect(classifyShipmentArrival(null, null)).toEqual({ statusClass: 'unknown', receivedBasis: 'pending' });
    expect(classifyShipmentArrival('  ', '时间待定')).toEqual({ statusClass: 'unknown', receivedBasis: 'pending' });
  });

  it('已到港/到港 只是运输进度，不等于到货', () => {
    expect(classifyShipmentArrival('10/30 预计11.3号到港', null))
      .toEqual({ statusClass: 'in_transit', receivedBasis: 'status_in_transit_zero' });
    expect(classifyShipmentArrival(null, '11.3到港'))
      .toEqual({ statusClass: 'in_transit', receivedBasis: 'status_in_transit_zero' });
  });
});

describe('第八轮：G 运输进度与 H 按商品点名（真实票口径）', () => {
  it('G 非空且不含到货标记 → 运输中（POKNZX027080 11/3 排队送往拆派仓）', () => {
    expect(classifyShipmentArrival('11/3 排队送往拆派仓', null))
      .toEqual({ statusClass: 'in_transit', receivedBasis: 'status_in_transit_zero' });
    expect(classifyShipmentArrival('10/28 转运广西', null))
      .toEqual({ statusClass: 'in_transit', receivedBasis: 'status_in_transit_zero' });
  });

  it('G/H 都空（只有运单号）仍为状态未提供，不因有运单号判在途', () => {
    expect(classifyShipmentArrival(null, null))
      .toEqual({ statusClass: 'unknown', receivedBasis: 'pending' });
    expect(classifyShipmentArrival('', null))
      .toEqual({ statusClass: 'unknown', receivedBasis: 'pending' });
  });

  function twoItemRows(arrivalText: string | null, transportText: string | null): Array<Array<string | number | null>> {
    return [
      HEADER,
      ['ICELERSKIN三酸净化喷雾120ml', 14000, '泰国', '纵贯线线海运双清', '9062755', 'POKNZX026710',
        transportText, arrivalText, null, null],
      ['ICELERSKIN乙醇酸爽肤水200ml', 11440, null, null, null, null, null, null, null, null],
    ];
  }

  it('H 按商品点名：唯一命中该明细才归属，同票未点名明细保持待核（POKNZX026710）', () => {
    const parsed = parseShipmentSnapshot({
      collection: collection(),
      values: twoItemRows('三酸喷雾：已到货上架', null),
      merges: [],
    });
    const ticket = parsed.tickets[0]!;
    // 票级仍是 partial（只有某个商品点名到货，不等于整票已到）。
    expect(ticket).toMatchObject({ statusClass: 'partial', receivedBasis: 'pending' });
    expect(ticket.items[0]!.sourceReceiptBasis).toBe('status_arrived_full');
    expect(ticket.items[1]!.sourceReceiptBasis).toBeNull();
  });

  it('H 点名「已到货」→ 该明细按已到货待上架（累计到货 0），不整票归零', () => {
    const parsed = parseShipmentSnapshot({
      collection: collection(),
      values: twoItemRows('三酸净化喷雾：已到货，待上架', null),
      merges: [],
    });
    expect(parsed.tickets[0]!.items[0]!.sourceReceiptBasis).toBe('status_awaiting_shelving_zero');
    expect(parsed.tickets[0]!.items[1]!.sourceReceiptBasis).toBeNull();
  });

  it('H 只有运单号/数字行（POKNZX027084）→ 维持票级 partial，全部明细不归属', () => {
    const parsed = parseShipmentSnapshot({
      collection: collection(),
      values: [
        HEADER,
        ['ICELERSKIN乙醇酸爽肤水200ml', 80000, '越南', '晟邦', '88035691/88035692', 'POKNZX027084',
          '88035696 10/31 127件已到胡志明，待派送',
          '88035691/88035692 已到货上架\n88035694已到105件，余40件未到', null, null],
      ],
      merges: [],
    });
    const ticket = parsed.tickets[0]!;
    expect(ticket).toMatchObject({ statusClass: 'partial', receivedBasis: 'pending' });
    expect(ticket.items[0]!.sourceReceiptBasis).toBeNull();
  });

  it('H 有整票纯状态行时不做逐商品覆盖', () => {
    const parsed = parseShipmentSnapshot({
      collection: collection(),
      values: [
        HEADER,
        ['产品A', 10, '泰国', '普货', 'WB-1', null, null, '已到货上架', null, null],
        ['产品B', 5, null, null, null, null, null, null, null, null],
      ],
      merges: [],
    });
    const ticket = parsed.tickets[0]!;
    expect(ticket).toMatchObject({ statusClass: 'arrived', receivedBasis: 'status_arrived_full' });
    expect(ticket.items.every((item) => item.sourceReceiptBasis === null)).toBe(true);
  });

  it('点名行匹配到多条明细时不归属（保守，不猜）', () => {
    const parsed = parseShipmentSnapshot({
      collection: collection(),
      values: [
        HEADER,
        ['ICELERSKIN乙醇酸爽肤水200ml', 10, '越南', '晟邦', 'WB-1', null, null, '爽肤水：已到货上架', null, null],
        ['ICELERSKIN乙醇酸爽肤水300ml', 5, null, null, null, null, null, null, null, null],
      ],
      merges: [],
    });
    expect(parsed.tickets[0]!.items.every((item) => item.sourceReceiptBasis === null)).toBe(true);
  });
});

describe('第十二轮：运单号单元格跨行合并时按一票读（真实 9258750 两次快照）', () => {
  const MERGED_TICKET_COLUMNS = [3, 4, 5, 6, 7, 8]; // D 报关方式 ~ I 船名

  /** 与 2026-11-06 13:52 快照同结构：47–62 行是一票，国家列拆成两格。 */
  function waybillSplitRows(): Array<Array<string | number | null>> {
    const rows: Array<Array<string | number | null>> = [HEADER];
    for (let index = 1; index <= 9; index += 1) {
      rows.push([
        `CHIC PEAK 唇泥 P0${index}- 1.8g`,
        3600,
        index === 1 ? '泰国' : null,
        index === 1 ? '纵贯线国际物流' : null,
        index === 1 ? '9258750' : null,
        null,
        index === 1 ? '11/3 已发出' : null,
        null,
        null,
        null,
      ]);
    }
    const blushes = [1080, 1080, 3240, 540, 270, 270, 270];
    blushes.forEach((quantity, index) => {
      rows.push([
        `WM0057 CHIC PEAK 腮红4.8g-M0${[1, 2, 3, 5, 6, 7, 8][index]}`,
        quantity,
        index === 0 ? '泰国' : null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
      ]);
    });
    return rows;
  }

  const waybillMerges = MERGED_TICKET_COLUMNS.map((column) => ({
    startRow: 1, endRow: 16, startColumn: column, endColumn: column,
  }));

  it('13:52：运单格跨 47–62 行、国家列两格但市场一致 → 一票 16 条明细', () => {
    const merges = [
      ...waybillMerges,
      { startRow: 1, endRow: 9, startColumn: 2, endColumn: 2 }, // 国家 47–55
      { startRow: 10, endRow: 16, startColumn: 2, endColumn: 2 }, // 国家 56–62
    ];
    const parsed = parseShipmentSnapshot({ collection: collection(), values: waybillSplitRows(), merges });
    expect(parsed.tickets).toHaveLength(1);
    const ticket = parsed.tickets[0]!;
    expect(ticket.ticketKey).toBe('WB:9258750');
    expect(ticket.ticketNo).toBe('9258750');
    expect(ticket.market).toBe('泰国');
    expect(ticket.sourceRowStart).toBe(2);
    expect(ticket.sourceRowEnd).toBe(17);
    expect(ticket.items).toHaveLength(16);
    expect(ticket.items.map((item) => item.shippedQuantity)).toEqual([
      3600, 3600, 3600, 3600, 3600, 3600, 3600, 3600, 3600, 1080, 1080, 3240, 540, 270, 270, 270,
    ]);
  });

  it('14:02：国家列也合并 → 同样一票 16 条明细', () => {
    const merges = [
      ...waybillMerges,
      { startRow: 1, endRow: 16, startColumn: 2, endColumn: 2 },
    ];
    const parsed = parseShipmentSnapshot({ collection: collection(), values: waybillSplitRows(), merges });
    expect(parsed.tickets).toHaveLength(1);
    expect(parsed.tickets[0]!.items).toHaveLength(16);
  });

  it('没有合并区时不把两个国家单元格猜成一票（仍按两票）', () => {
    const parsed = parseShipmentSnapshot({ collection: collection(), values: waybillSplitRows(), merges: [] });
    expect(parsed.tickets).toHaveLength(2);
    expect(parsed.tickets[0]!.items).toHaveLength(9);
    expect(parsed.tickets[1]!.items).toHaveLength(7);
  });

  it('同一运单号跨行但第二段写了不同采购单 → 仍分开，并沿用合并格里的运单号', () => {
    const rows = waybillSplitRows();
    rows[10]![5] = 'PO-SECOND';
    const merges = [
      ...waybillMerges,
      { startRow: 1, endRow: 9, startColumn: 2, endColumn: 2 },
      { startRow: 10, endRow: 16, startColumn: 2, endColumn: 2 },
    ];
    const parsed = parseShipmentSnapshot({ collection: collection(), values: rows, merges });
    expect(parsed.tickets).toHaveLength(2);
    expect(parsed.tickets[1]).toMatchObject({
      ticketKey: 'PO:PO-SECOND',
      purchaseOrder: 'PO-SECOND',
      waybillsText: '9258750',
    });
    expect(parsed.tickets[1]!.items).toHaveLength(7);
  });
});
