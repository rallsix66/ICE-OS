import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SHIPMENT_PAGE_SIZE,
  UNKNOWN_MARKET_TOKEN,
  absentSummaryText,
  arrivalColumnText,
  buildShipmentDetailHref,
  buildShipmentListHref,
  changedFieldsText,
  classifyShipmentReadFailure,
  firstWaybill,
  formatQuantity,
  formatSourceTime,
  formatTimestamp,
  identityPending,
  manualCorrectionPreview,
  manualRevisionActionLabel,
  manualStatusFromReceiptBasis,
  manualStatusLabel,
  manualStatusTone,
  marketOptionValue,
  marketText,
  normalizeShipmentLimit,
  parseIncludeAbsent,
  parseShipmentSearchParams,
  productSummaryDisplay,
  productSearchSpecText,
  purchaseOrderText,
  receiptBasisLabel,
  receivedDisplay,
  refreshResultText,
  remainingDisplay,
  shipmentPageNumbers,
  shipmentPageRange,
  shipmentLiveStamp,
  shipmentReadFailureText,
  shipmentSourceStatusDisplay,
  shipmentStatusLabel,
  shipmentStatusTone,
  sourceFieldText,
  statusCountsText,
  summaryExcludedText,
  summaryProductQuantityText,
  summaryProductValueText,
  summaryTotalText,
  ticketTitle,
  transportColumnText,
  waybillsText,
} from './model';
import type { ShipmentListRowDto, ShipmentSourceStatusDto } from './types';

const SHIPMENT_ID = '6f1f2b8e-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
const PRODUCT_ID = '0b7c2d1e-9f8a-4b6c-8d2e-5f4a3b2c1d0e';

function listRow(overrides: Partial<ShipmentListRowDto> = {}): ShipmentListRowDto {
  return {
    shipmentId: SHIPMENT_ID,
    market: '马来西亚',
    purchaseOrder: 'POKNZX027385',
    waybillsText: null,
    ticketNo: 'POKNZX027385',
    itemCount: 1,
    productSummary: ['三酸喷雾'],
    statusClass: 'in_transit',
    effectiveStatusClass: 'in_transit',
    manualCorrectionCount: 0,
    manualReviewCount: 0,
    transportText: '10/30 已拆柜，待安排派送',
    arrivalText: '预计 11/05 到仓',
    quantityPending: false,
    identityStatus: 'confirmed',
    identityNote: null,
    presentInLatestRead: true,
    lastSeenAt: '2026-11-01T06:00:00.000Z',
    ...overrides,
  };
}

describe('parseShipmentSearchParams', () => {
  it('空参数用默认值（全部市场/全部状态/第 1 页/每页 50/不含本次未见/无详情/无定位明细）', () => {
    expect(parseShipmentSearchParams(new URLSearchParams())).toEqual({
      view: 'list',
      market: 'all',
      status: 'all',
      q: '',
      product: '',
      includeAbsent: false,
      page: 1,
      limit: DEFAULT_SHIPMENT_PAGE_SIZE,
      ticket: '',
      item: '',
      review: false,
    });
  });

  it('item 只接受 UUID（来源汇总点进明细用），非法值丢弃', () => {
    expect(parseShipmentSearchParams(new URLSearchParams(`item=${SHIPMENT_ID}`)).item).toBe(SHIPMENT_ID);
    expect(parseShipmentSearchParams(new URLSearchParams('item=not-a-uuid')).item).toBe('');
    expect(parseShipmentSearchParams(new URLSearchParams('item=')).item).toBe('');
  });

  it('limit 只接受 20/50/100，其它回默认 50', () => {
    expect(parseShipmentSearchParams(new URLSearchParams('limit=20')).limit).toBe(20);
    expect(parseShipmentSearchParams(new URLSearchParams('limit=100')).limit).toBe(100);
    expect(parseShipmentSearchParams(new URLSearchParams('limit=0')).limit).toBe(50);
    expect(parseShipmentSearchParams(new URLSearchParams('limit=999')).limit).toBe(50);
    expect(normalizeShipmentLimit(30)).toBe(50);
  });

  it('page 小于 1 / 非数字回 1', () => {
    expect(parseShipmentSearchParams(new URLSearchParams('page=0')).page).toBe(1);
    expect(parseShipmentSearchParams(new URLSearchParams('page=-3')).page).toBe(1);
    expect(parseShipmentSearchParams(new URLSearchParams('page=4')).page).toBe(4);
    expect(parseShipmentSearchParams(new URLSearchParams('page=2.9')).page).toBe(2);
  });

  it('业务状态只接受 5 类，其它回 all', () => {
    for (const status of ['in_transit', 'partial', 'arrived_pending_shelving', 'arrived', 'unknown']) {
      expect(parseShipmentSearchParams(new URLSearchParams(`status=${status}`)).status).toBe(status);
    }
    expect(parseShipmentSearchParams(new URLSearchParams('status=bogus')).status).toBe('all');
  });

  it('includeAbsent 只认 absent=1/true/yes', () => {
    expect(parseShipmentSearchParams(new URLSearchParams('absent=1')).includeAbsent).toBe(true);
    expect(parseShipmentSearchParams(new URLSearchParams('absent=true')).includeAbsent).toBe(true);
    expect(parseShipmentSearchParams(new URLSearchParams('absent=0')).includeAbsent).toBe(false);
    expect(parseShipmentSearchParams(new URLSearchParams('absent=')).includeAbsent).toBe(false);
    expect(parseIncludeAbsent('YES')).toBe(true);
    expect(parseIncludeAbsent('no')).toBe(false);
  });

  it('product/ticket 必须是 UUID，非法值丢弃', () => {
    const ok = parseShipmentSearchParams(new URLSearchParams(`product=${PRODUCT_ID}&ticket=${SHIPMENT_ID}`));
    expect(ok.product).toBe(PRODUCT_ID);
    expect(ok.ticket).toBe(SHIPMENT_ID);
    const bad = parseShipmentSearchParams(new URLSearchParams('product=abc&ticket=1'));
    expect(bad.product).toBe('');
    expect(bad.ticket).toBe('');
  });

  it('市场保留来源原文（含未给国家的哨兵），all 表示不筛', () => {
    expect(parseShipmentSearchParams(new URLSearchParams('market=all')).market).toBe('all');
    expect(parseShipmentSearchParams(new URLSearchParams('market=马来西亚')).market).toBe('马来西亚');
    expect(parseShipmentSearchParams(new URLSearchParams(`market=${UNKNOWN_MARKET_TOKEN}`)).market).toBe(UNKNOWN_MARKET_TOKEN);
    expect(marketText(null)).toBe('未提供');
    expect(marketOptionValue(null)).toBe(UNKNOWN_MARKET_TOKEN);
  });
});

describe('链接往返', () => {
  it('列表链接只带非默认值，解析回来一致（含 absent=1）', () => {
    const href = buildShipmentListHref({
      market: '菲律宾',
      status: 'partial',
      q: '88035',
      product: PRODUCT_ID,
      includeAbsent: true,
      page: 3,
      limit: 20,
    });
    expect(href).toContain('absent=1');
    const parsed = parseShipmentSearchParams(new URLSearchParams(href.split('?')[1]));
    expect(parsed).toMatchObject({
      market: '菲律宾',
      status: 'partial',
      q: '88035',
      product: PRODUCT_ID,
      includeAbsent: true,
      page: 3,
      limit: 20,
      ticket: '',
    });
  });

  it('默认筛选不写空参数；详情链接保留筛选与 absent', () => {
    const base = { market: 'all', status: 'all' as const, q: '', product: '', includeAbsent: false, page: 1, limit: 50 };
    expect(buildShipmentListHref(base)).toBe('/dashboard/in-transit');
    const detail = buildShipmentDetailHref({ ...base, includeAbsent: true }, SHIPMENT_ID);
    expect(detail).toBe(`/dashboard/in-transit?absent=1&ticket=${SHIPMENT_ID}`);
    expect(buildShipmentDetailHref(base, 'not-a-uuid')).toBe('/dashboard/in-transit');
  });
});

describe('业务状态 5 类', () => {
  it('标签与语气固定（含第 5 类颜色 purple）', () => {
    expect(shipmentStatusLabel('in_transit')).toBe('运输在途');
    expect(shipmentStatusLabel('partial')).toBe('部分到货待核');
    expect(shipmentStatusLabel('arrived_pending_shelving')).toBe('已到货待上架');
    expect(shipmentStatusLabel('arrived')).toBe('已到货上架');
    expect(shipmentStatusLabel('unknown')).toBe('状态未提供待核');
    expect(shipmentStatusTone('arrived_pending_shelving')).toBe('purple');
    expect(shipmentStatusTone('arrived')).toBe('green');
    expect(shipmentStatusTone('partial')).toBe('amber');
    expect(shipmentStatusTone(null)).toBe('neutral');
  });

  it('计数行显示 5 类真实计数', () => {
    const text = statusCountsText({
      total: 37,
      inTransit: 33,
      partial: 3,
      arrivedPendingShelving: 0,
      arrived: 0,
      unknown: 1,
    });
    expect(text).toBe('运输在途 33 · 部分到货待核 3 · 已到货待上架 0 · 已到货上架 0 · 状态未提供待核 1');
  });

  it('身份待核 / 本次来源未见提示', () => {
    expect(identityPending('pending')).toBe(true);
    expect(identityPending('confirmed')).toBe(false);
    expect(absentSummaryText(2, 5)).toBe('本次来源未见 2 票 / 5 明细（已退出当前列表，历史保留）');
    expect(absentSummaryText(0, 0)).toBeNull();
  });
});

describe('列表单元格', () => {
  it('商品摘要只显示名称，最多 3 条 +「等 n 项」，不带数量', () => {
    const row = listRow({ itemCount: 5, productSummary: ['A 产品', 'B 产品', 'C 产品'] });
    expect(productSummaryDisplay(row)).toEqual({ primary: 'A 产品、B 产品、C 产品', more: '等 2 项' });
    expect(productSummaryDisplay(listRow())).toEqual({ primary: '三酸喷雾', more: null });
    expect(productSummaryDisplay(listRow({ itemCount: 0, productSummary: [] })).primary).toBe('—');
  });

  it('采购单号未提供写「未提供」，绝不用运单号顶替', () => {
    expect(purchaseOrderText(null)).toBe('未提供');
    expect(purchaseOrderText('  ')).toBe('未提供');
    expect(purchaseOrderText('POKNZX027385')).toBe('POKNZX027385');
  });

  it('运单号保留原文（多张换行/分隔），空写「未提供」；首张用于标题', () => {
    expect(waybillsText('88036324\n88036325/88036326')).toBe('88036324\n88036325/88036326');
    expect(waybillsText(null)).toBe('未提供');
    expect(firstWaybill('88036324\n88036325')).toBe('88036324');
    expect(firstWaybill('88036324/88036325/88036326')).toBe('88036324');
    expect(firstWaybill(null)).toBe('');
  });

  it('详情标题：采购单号 → 第一张运单号 → 无单号货票', () => {
    expect(ticketTitle('POKNZX027385', '88036324')).toBe('POKNZX027385');
    expect(ticketTitle(null, '88036324/88036325')).toBe('88036324');
    expect(ticketTitle('', '')).toBe('无单号货票');
  });

  it('预计到仓列显示 H 原文，空显示「—」', () => {
    expect(arrivalColumnText('已到货，待上架')).toBe('已到货，待上架');
    expect(arrivalColumnText('88035694已到105件，余40件未到')).toBe('88035694已到105件，余40件未到');
    expect(arrivalColumnText(null)).toBe('—');
    expect(arrivalColumnText('  ')).toBe('—');
  });

  it('业务状态列显示 G 原文（trim 首尾空白），空/只有空白/null 写「未填写」', () => {
    expect(transportColumnText('清关中')).toBe('清关中');
    expect(transportColumnText('派送中')).toBe('派送中');
    expect(transportColumnText('10/30 已拆柜，待安排派送（已到港，等待清关）')).toBe('10/30 已拆柜，待安排派送（已到港，等待清关）');
    expect(transportColumnText(' 清关中 ')).toBe('清关中');
    expect(transportColumnText('')).toBe('未填写');
    expect(transportColumnText('   ')).toBe('未填写');
    expect(transportColumnText(null)).toBe('未填写');
    expect(transportColumnText(undefined)).toBe('未填写');
  });
});

describe('数量口径（未知不写 0）', () => {
  it('剩余在途：known 显示数字；pending 显示未提供 + 待核', () => {
    expect(remainingDisplay({ remainingState: 'known', remainingQuantity: 1050 })).toEqual({
      text: '1,050',
      pending: false,
      tone: 'neutral',
    });
    expect(remainingDisplay({ remainingState: 'known', remainingQuantity: 0 }).text).toBe('0');
    expect(remainingDisplay({ remainingState: 'pending', remainingQuantity: null })).toEqual({
      text: '未提供',
      pending: true,
      tone: 'amber',
    });
    expect(remainingDisplay({ remainingState: 'known', remainingQuantity: null }).text).toBe('未提供');
  });

  it('累计到货：已到待上架按未结束在途（0、非待核）；pending 标待核', () => {
    expect(receivedDisplay({ receivedQuantity: 105, receiptBasis: 'status_arrived_full' })).toEqual({
      text: '105',
      pending: false,
      tone: 'neutral',
    });
    expect(receivedDisplay({ receivedQuantity: 0, receiptBasis: 'status_awaiting_shelving_zero' })).toEqual({
      text: '0',
      pending: false,
      tone: 'neutral',
    });
    expect(receivedDisplay({ receivedQuantity: null, receiptBasis: 'pending' })).toEqual({
      text: '未提供',
      pending: true,
      tone: 'amber',
    });
  });

  it('到货依据标签（含已到待上架）', () => {
    expect(receiptBasisLabel('status_awaiting_shelving_zero')).toBe('整票已到但未上架，按未结束在途计');
    expect(receiptBasisLabel('status_arrived_full')).toBe('已到货上架（整票或点名商品），按到货量计');
    expect(receiptBasisLabel('status_in_transit_zero')).toBe('按运输中状态计为未到货');
    expect(receiptBasisLabel('pending')).toBe('来源未提供到货数量，待核');
  });

  it('来源未给单位/SKU 时如实显示「来源未提供」', () => {
    expect(sourceFieldText(null)).toBe('来源未提供');
    expect(sourceFieldText('  ')).toBe('来源未提供');
  });

  it('数量千分位；缺失不写 0', () => {
    expect(formatQuantity(1234567)).toBe('1,234,567');
    expect(formatQuantity(0)).toBe('0');
    expect(formatQuantity(null)).toBe('');
  });
});

describe('时间格式化（Asia/Shanghai）', () => {
  it('ISO → 上海时间 YYYY-MM-DD HH:mm', () => {
    expect(formatTimestamp('2026-10-30T09:48:51.000Z')).toBe('2026-10-30 17:48');
    expect(formatTimestamp('2026-11-01T00:00:00+08:00')).toBe('2026-11-01 00:00');
  });

  it('来源时间缺失/无效显示「—」', () => {
    expect(formatSourceTime(null)).toBe('—');
    expect(formatSourceTime('not-a-date')).toBe('—');
  });
});

describe('来源读取状态', () => {
  const status: ShipmentSourceStatusDto = {
    sourceKey: 'feishu_logistics_sheet',
    docTitle: '物流情况表',
    sheetTitle: 'Sheet1',
    lastSuccess: {
      snapshotId: 'a'.repeat(36),
      readAt: '2026-11-01T06:00:00.000Z',
      documentEditedAt: '2026-10-30T09:48:51.000Z',
      revision: 1836,
      ticketCount: 37,
      itemCount: 86,
    },
    lastAttempt: {
      snapshotId: 'b'.repeat(36),
      readAt: '2026-11-01T07:30:00.000Z',
      status: 'failed',
      errorCode: 'SOURCE_CLI_TIMEOUT',
      errorMessage: 'lark-cli timeout',
    },
    autoReader: null,
  };

  it('成功读取时间、票/明细、来源更新与 revision 分开显示', () => {
    const display = shipmentSourceStatusDisplay(status);
    expect(display.lastSuccessText).toBe('最近成功读取 2026-11-01 14:00');
    expect(display.lastSuccessDetail).toBe('37 票 / 86 明细 · 来源更新 2026-10-30 17:48 · revision 1836');
    expect(display.attemptText).toContain('本次读取失败：来源读取超时');
    expect(display.tone).toBe('red');
  });

  it('没有成功记录时明确写「还没有成功读取」', () => {
    const display = shipmentSourceStatusDisplay({ ...status, lastSuccess: null, lastAttempt: null });
    expect(display.lastSuccessText).toBe('还没有成功读取');
    expect(display.attemptText).toBe('本次还没有读取记录');
  });

  it('物流页读取失败只留一句：原因 + 当前展示的旧数据时间（成功不显示）', () => {
    expect(shipmentReadFailureText(status)).toBe('飞书读取超时，当前显示 14:00 的数据');
    expect(shipmentReadFailureText({ ...status, lastSuccess: null })).toBe('飞书读取超时，暂无成功数据');
    expect(shipmentReadFailureText({ ...status, lastAttempt: { ...status.lastAttempt!, errorCode: 'SOURCE_CLI_FAILED', errorMessage: '授权已失效' } }))
      .toBe('飞书读取失败，当前显示 14:00 的数据');
    expect(shipmentReadFailureText({ ...status, lastAttempt: { ...status.lastAttempt!, status: 'success' } })).toBeNull();
  });

  it('自动读取状态：运行中/间隔/最近结果/下次计划与失败原因', () => {
    const reader: NonNullable<ShipmentSourceStatusDto['autoReader']> = {
      enabled: true,
      intervalMinutes: 10,
      nextRunAt: '2026-11-03T02:10:00.000Z',
      lastStartedAt: '2026-11-03T02:00:00.000Z',
      lastFinishedAt: '2026-11-03T02:00:20.000Z',
      lastResult: 'success',
      lastReadAt: '2026-11-03T02:00:20.000Z',
      lastTicketCount: 41,
      lastItemCount: 90,
      lastErrorCode: null,
      lastErrorMessage: null,
      heartbeatAt: '2026-11-03T02:01:00.000Z',
      runnerPid: 1234,
      workerOnline: true,
      running: false,
      leaseOwner: null,
    };
    const running = shipmentSourceStatusDisplay({ ...status, autoReader: reader });
    expect(running.autoReaderText).toContain('自动读取：运行中 · 每 10 分钟');
    expect(running.autoReaderText).toContain('最近自动读取 2026-11-03 10:00');
    expect(running.autoReaderText).toContain('下次计划 2026-11-03 10:10');
    expect(running.autoReaderFailed).toBe(false);

    const failedReader = shipmentSourceStatusDisplay({
      ...status,
      autoReader: { ...reader, lastResult: 'failed', lastErrorCode: 'SOURCE_CLI_FAILED',
        lastErrorMessage: '授权已失效', lastFinishedAt: '2026-11-03T02:20:00.000Z', nextRunAt: null },
    });
    expect(failedReader.autoReaderText).toContain('最近自动读取失败：来源读取失败');
    expect(failedReader.autoReaderText).toContain('2026-11-03 10:20');
    expect(failedReader.autoReaderFailed).toBe(true);

    const offline = shipmentSourceStatusDisplay({ ...status, autoReader: { ...reader, workerOnline: false } });
    expect(offline.autoReaderText).toContain('已启用，后台任务未运行');

    const disabled = shipmentSourceStatusDisplay({ ...status, autoReader: { ...reader, enabled: false } });
    expect(disabled.autoReaderText).toBe('自动读取：已停用 · 每 10 分钟');

    const missing = shipmentSourceStatusDisplay(status);
    expect(missing.autoReaderText).toBe('自动读取：状态读取失败（不影响手动刷新）');
  });

  it('刷新结果：成功给计数；有本次未见时追加；失败只给原因', () => {
    const ok = refreshResultText({
      ok: true,
      readAt: '2026-11-01T08:00:00.000Z',
      ticketCount: 37,
      itemCount: 86,
      createdTickets: 35,
      updatedTickets: 1,
      unchangedTickets: 1,
      createdItems: 83,
      updatedItems: 1,
      revisionsAdded: 2,
      associationsPreserved: 12,
      absentTickets: 0,
      absentItems: 0,
      adoptedAssociations: 3,
      errorCode: null,
      errorMessage: null,
    });
    expect(ok).toBe('本次读取成功 · 票 37 / 明细 86 · 新增 35 / 更新 1 / 未变 1 · 采用已确认对应 3 条');

    const withAbsent = refreshResultText({
      ok: true,
      readAt: '2026-11-01T08:00:00.000Z',
      ticketCount: 36,
      itemCount: 85,
      createdTickets: 0,
      updatedTickets: 0,
      unchangedTickets: 36,
      createdItems: 0,
      updatedItems: 0,
      revisionsAdded: 0,
      associationsPreserved: 12,
      absentTickets: 1,
      absentItems: 1,
      errorCode: null,
      errorMessage: null,
    });
    expect(withAbsent).toBe('本次读取成功 · 票 36 / 明细 85 · 新增 0 / 更新 0 / 未变 36 · 本次未见 1 票 / 1 明细');

    const failed = refreshResultText({
      ok: false,
      readAt: '2026-11-01T08:05:00.000Z',
      ticketCount: 0,
      itemCount: 0,
      createdTickets: 0,
      updatedTickets: 0,
      unchangedTickets: 0,
      createdItems: 0,
      updatedItems: 0,
      revisionsAdded: 0,
      associationsPreserved: 0,
      absentTickets: 0,
      absentItems: 0,
      errorCode: 'SOURCE_HEADER_MISMATCH',
      errorMessage: 'header mismatch',
    });
    expect(failed).toBe('本次读取失败：来源表头与约定不一致');
  });
});

describe('变更记录字段翻译', () => {
  it('运输进度/到货说明/身份状态等字段转中文', () => {
    expect(changedFieldsText(['transportText', 'arrivalText', 'identityStatus'])).toBe('运输进度、到货与上架说明、身份状态');
    expect(changedFieldsText(['purchaseOrder', 'waybillsText'])).toBe('采购单号、运单号');
    expect(changedFieldsText([])).toBe('无字段变化');
    // 已不存在的旧字段不再冒充中文标签。
    expect(changedFieldsText(['statusText'])).toBe('statusText');
  });
});

describe('读取失败分类', () => {
  it('无权限/功能未就绪/网络失败分开', () => {
    expect(classifyShipmentReadFailure(new Error('SHIPMENT_FORBIDDEN: 无权'))).toBe('forbidden');
    expect(classifyShipmentReadFailure(Object.assign(new Error('x'), { code: '42883' }))).toBe('unavailable');
    expect(classifyShipmentReadFailure(new Error('socket hang up'))).toBe('read_failed');
  });
});

describe('分页', () => {
  it('页数/区间/页码列表；空结果第 1 页显示 0–0', () => {
    expect(shipmentPageRange(37, 50, 1)).toMatchObject({ from: 1, to: 37, page: 1, pageCount: 1 });
    expect(shipmentPageRange(0, 50, 1)).toMatchObject({ from: 0, to: 0, page: 1, pageCount: 1 });
    expect(shipmentPageRange(120, 20, 2)).toMatchObject({ from: 21, to: 40, page: 2, pageCount: 6 });
    expect(shipmentPageRange(120, 20, 99)).toMatchObject({ from: 101, to: 120, page: 6 });
    expect(shipmentPageNumbers(4, 10)).toEqual([1, 2, 3, 4, 5, 6, 'gap', 10]);
  });
});

describe('关联搜索候选规格（独立列优先、名称补充）', () => {
  it('商品库独立规格优先于名称；名称有规格时补充；都没有返回 null', () => {
    expect(productSearchSpecText({ specification: '120g/瓶', nameCn: 'ICE LERSKIN 三酸净化喷雾' }))
      .toBe('120g/瓶');
    expect(productSearchSpecText({ specification: '200ml/瓶', nameCn: '示例名称100ml' }))
      .toBe('200ml/瓶');
    expect(productSearchSpecText({ specification: null, nameCn: 'CHIC PEAK 唇泥 P06- 1.8g' }))
      .toBe('1.8g');
    expect(productSearchSpecText({ specification: '', nameCn: 'CHICPEAK 按压唇冻 #03' }))
      .toBeNull();
  });
});

describe('在途汇总展示（第七轮）', () => {
  const status: ShipmentSourceStatusDto = {
    sourceKey: 'feishu_logistics_sheet',
    docTitle: null,
    sheetTitle: null,
    lastSuccess: {
      snapshotId: 'snap-1',
      readAt: '2026-11-04T01:39:56.863Z',
      documentEditedAt: null,
      revision: 1945,
      ticketCount: 42,
      itemCount: 106,
    },
    lastAttempt: null,
    autoReader: null,
  };

  it('已能算出的货值：有值格式化；无已计价明细不写 ¥0', () => {
    expect(summaryTotalText({ totalValueCny: '15338.16', pricedItemCount: 2 })).toBe('¥15,338.16');
    expect(summaryTotalText({ totalValueCny: '0', pricedItemCount: 1 })).toBe('¥0.00');
    expect(summaryTotalText({ totalValueCny: null, pricedItemCount: 0 })).toBe('暂无可计算货值');
    expect(summaryTotalText({ totalValueCny: null, pricedItemCount: 1 })).toBe('—');
  });

  it('商品数量：数量全部待核显示「待核」，不显示 0', () => {
    expect(summaryProductQuantityText({ remainingQuantity: 0, quantityKnownItemCount: 0 })).toBe('待核');
    expect(summaryProductQuantityText({ remainingQuantity: 1080, quantityKnownItemCount: 1 })).toBe('1,080');
    expect(summaryProductValueText({ valueCny: null })).toBe('未计入');
    expect(summaryProductValueText({ valueCny: '0' })).toBe('¥0.00');
  });

  it('未计入数量与原因分解；0 条时明确全部已计入', () => {
    expect(summaryExcludedText({ excludedItemCount: 0, excludedByReason: { unbound: 0, quantityPending: 0, priceMissing: 0, reviewPending: 0 } }))
      .toBe('未计入 0 条（全部当前明细已计入）');
    expect(summaryExcludedText({
      excludedItemCount: 16,
      excludedByReason: { unbound: 0, quantityPending: 16, priceMissing: 0, reviewPending: 0 },
    })).toBe('未计入 16 条（待复核 0 · 数量待核 16 · 缺单价 0 · 未关联商品 0）');
  });

  it('自动更新探测戳随成功快照/自动读取变化', () => {
    expect(shipmentLiveStamp(status)).toBe('snap-1|2026-11-04T01:39:56.863Z||');
    expect(shipmentLiveStamp({
      ...status,
      lastSuccess: null,
      autoReader: {
        enabled: true,
        intervalMinutes: 10,
        nextRunAt: '2026-11-04T01:49:56.863Z',
        lastStartedAt: '2026-11-04T01:39:50.104Z',
        lastFinishedAt: '2026-11-04T01:39:56.863Z',
        lastResult: 'unchanged',
        lastReadAt: '2026-11-04T01:39:56.863Z',
        lastTicketCount: 42,
        lastItemCount: 106,
        lastErrorCode: null,
        lastErrorMessage: null,
        heartbeatAt: '2026-11-04T01:47:00.000Z',
        runnerPid: 1,
        workerOnline: true,
        running: false,
        leaseOwner: null,
      },
    })).toBe('||2026-11-04T01:39:56.863Z|unchanged');
  });
});

describe('详情 item 定位参数（第八轮）', () => {
  const ITEM_ID = '9c415964-f708-4ec9-ae07-b828d69c81f9';
  const base = { market: 'all', status: 'all' as const, q: '', product: '', includeAbsent: false, page: 1, limit: 50 };

  it('详情链接带 item；不带时无 item；列表链接从不输出 item', () => {
    const withItem = buildShipmentDetailHref(base, SHIPMENT_ID, ITEM_ID);
    expect(withItem).toBe(`/dashboard/in-transit?ticket=${SHIPMENT_ID}&item=${ITEM_ID}`);
    const parsed = parseShipmentSearchParams(new URLSearchParams(withItem.split('?')[1]));
    expect(parsed.item).toBe(ITEM_ID);
    expect(parsed.ticket).toBe(SHIPMENT_ID);

    expect(buildShipmentDetailHref(base, SHIPMENT_ID)).toBe(`/dashboard/in-transit?ticket=${SHIPMENT_ID}`);
    expect(buildShipmentDetailHref(base, SHIPMENT_ID, 'not-a-uuid')).toBe(`/dashboard/in-transit?ticket=${SHIPMENT_ID}`);
    expect(buildShipmentListHref(base)).toBe('/dashboard/in-transit');
  });
});

describe('人工修正在途：状态标签与默认值', () => {
  it('5 个状态的中文标签与语气', () => {
    expect(manualStatusLabel('in_transit')).toBe('运输中');
    expect(manualStatusLabel('arrived_pending_shelving')).toBe('已到货待上架');
    expect(manualStatusLabel('fully_shelved')).toBe('全部已上架');
    expect(manualStatusLabel('partial_shelved')).toBe('分批上架');
    expect(manualStatusLabel('unknown')).toBe('状态未知');
    expect(manualStatusLabel(null)).toBe('状态未知');
    expect(manualStatusTone('fully_shelved')).toBe('green');
    expect(manualStatusTone('partial_shelved')).toBe('amber');
    expect(manualStatusTone('arrived_pending_shelving')).toBe('purple');
    expect(manualStatusTone('in_transit')).toBe('blue');
  });

  it('弹窗默认状态按原表到货依据映射（pending → 状态未知）', () => {
    expect(manualStatusFromReceiptBasis('status_in_transit_zero')).toBe('in_transit');
    expect(manualStatusFromReceiptBasis('status_awaiting_shelving_zero')).toBe('arrived_pending_shelving');
    expect(manualStatusFromReceiptBasis('status_arrived_full')).toBe('fully_shelved');
    expect(manualStatusFromReceiptBasis('source_quantity')).toBe('partial_shelved');
    expect(manualStatusFromReceiptBasis('pending')).toBe('unknown');
    expect(manualStatusFromReceiptBasis('manual_correction')).toBe('unknown');
    expect(manualStatusFromReceiptBasis(null)).toBe('unknown');
  });

  it('人工修正记录动作标签', () => {
    expect(manualRevisionActionLabel('apply')).toBe('人工修正');
    expect(manualRevisionActionLabel('restore')).toBe('恢复按原表判断');
  });

  it('到货依据含人工修正', () => {
    expect(receiptBasisLabel('manual_correction')).toBe('人工修正在途（不按原表）');
  });
});

describe('人工修正在途：预览与算式', () => {
  const base = {
    shippedQuantity: 80000,
    cumulativeShelvedText: '',
    cartonQuantity: 80 as number | null,
    inputMode: 'quantity' as const,
  };

  it('运输中 / 已到货待上架：累计 0，剩余=发货量', () => {
    for (const status of ['in_transit', 'arrived_pending_shelving'] as const) {
      const preview = manualCorrectionPreview({ ...base, status });
      expect(preview.ok).toBe(true);
      expect(preview.receivedQuantity).toBe(0);
      expect(preview.remainingQuantity).toBe(80000);
      expect(preview.formulaLines).toEqual(['累计到货 = 0', '剩余在途 = 发货量 80,000 − 0 = 80,000']);
      expect(preview.boxConversion).toBeNull();
    }
  });

  it('全部已上架：累计=发货量，剩余 0', () => {
    const preview = manualCorrectionPreview({ ...base, status: 'fully_shelved' });
    expect(preview.ok).toBe(true);
    expect(preview.receivedQuantity).toBe(80000);
    expect(preview.remainingQuantity).toBe(0);
    expect(preview.formulaLines).toEqual(['累计到货 = 发货量 = 80,000', '剩余在途 = 0']);
  });

  it('状态未知：累计/剩余都未知（不写 0）', () => {
    const preview = manualCorrectionPreview({ ...base, status: 'unknown' });
    expect(preview.ok).toBe(true);
    expect(preview.receivedQuantity).toBeNull();
    expect(preview.remainingQuantity).toBeNull();
    expect(preview.formulaLines).toEqual(['累计到货未提供', '剩余在途待核']);
  });

  it('分批上架按商品数量：累计替换不累加，剩余=发货量−累计', () => {
    const preview = manualCorrectionPreview({ ...base, status: 'partial_shelved', cumulativeShelvedText: '3200' });
    expect(preview.ok).toBe(true);
    expect(preview.receivedQuantity).toBe(3200);
    expect(preview.remainingQuantity).toBe(76800);
    expect(preview.formulaLines).toEqual(['累计已上架 = 3,200', '剩余在途 = 80,000 − 3,200 = 76,800']);
    expect(preview.boxConversion).toBeNull();
  });

  it('分批上架按箱：箱数 × 装箱数 = 商品数量（40/127/105/833/728 箱）', () => {
    const cases: Array<{ boxes: string; quantity: number; remaining: number }> = [
      { boxes: '40', quantity: 3200, remaining: 76800 },
      { boxes: '127', quantity: 10160, remaining: 69840 },
      { boxes: '105', quantity: 8400, remaining: 71600 },
      { boxes: '833', quantity: 66640, remaining: 13360 },
      { boxes: '728', quantity: 58240, remaining: 21760 },
    ];
    for (const entry of cases) {
      const preview = manualCorrectionPreview({
        ...base,
        status: 'partial_shelved',
        inputMode: 'boxes',
        cumulativeShelvedText: entry.boxes,
      });
      expect(preview.ok).toBe(true);
      expect(preview.receivedQuantity).toBe(entry.quantity);
      expect(preview.remainingQuantity).toBe(entry.remaining);
      expect(preview.boxConversion).toEqual({
        boxes: Number(entry.boxes),
        cartonQuantity: 80,
        quantity: entry.quantity,
      });
      expect(preview.formulaLines[0]).toBe(`箱数 × 装箱数 = ${entry.boxes} × 80 = ${formatQuantity(entry.quantity)}`);
      expect(preview.formulaLines[1]).toBe(`剩余在途 = 80,000 − ${formatQuantity(entry.quantity)} = ${formatQuantity(entry.remaining)}`);
    }
  });

  it('输入非法时 ok=false 且数量为 null（不写 0）', () => {
    const cases: Array<{ input: Parameters<typeof manualCorrectionPreview>[0]; reason: string }> = [
      { input: { ...base, status: 'partial_shelved', cumulativeShelvedText: '' }, reason: 'empty' },
      { input: { ...base, status: 'partial_shelved', cumulativeShelvedText: 'abc' }, reason: 'text' },
      { input: { ...base, status: 'partial_shelved', cumulativeShelvedText: '-5' }, reason: 'negative' },
      { input: { ...base, status: 'partial_shelved', cumulativeShelvedText: '1.5' }, reason: 'decimal' },
      { input: { ...base, status: 'partial_shelved', cumulativeShelvedText: '80001' }, reason: 'over' },
      { input: { ...base, status: 'partial_shelved', inputMode: 'boxes', cartonQuantity: null, cumulativeShelvedText: '10' }, reason: 'no-carton' },
      { input: { ...base, status: 'partial_shelved', inputMode: 'boxes', cartonQuantity: 0, cumulativeShelvedText: '10' }, reason: 'zero-carton' },
      { input: { ...base, status: 'partial_shelved', inputMode: 'boxes', cumulativeShelvedText: '1001' }, reason: 'boxes-over' },
      { input: { ...base, shippedQuantity: 0, status: 'in_transit' }, reason: 'bad-shipped' },
    ];
    for (const entry of cases) {
      const preview = manualCorrectionPreview(entry.input);
      expect(preview.ok, entry.reason).toBe(false);
      expect(preview.receivedQuantity, entry.reason).toBeNull();
      expect(preview.remainingQuantity, entry.reason).toBeNull();
      expect(preview.error && preview.error.length > 0, entry.reason).toBe(true);
      expect(preview.formulaLines, entry.reason).toEqual([]);
    }
  });

  it('千分位/空格输入可接受；累计等于发货量时剩余 0', () => {
    const preview = manualCorrectionPreview({ ...base, status: 'partial_shelved', cumulativeShelvedText: ' 80,000 ' });
    expect(preview.ok).toBe(true);
    expect(preview.receivedQuantity).toBe(80000);
    expect(preview.remainingQuantity).toBe(0);
  });

  it('没有装箱数时提示改填商品数量', () => {
    const preview = manualCorrectionPreview({
      ...base,
      status: 'partial_shelved',
      inputMode: 'boxes',
      cartonQuantity: null,
      cumulativeShelvedText: '40',
    });
    expect(preview.error).toBe('该商品没有商品库装箱数量，请直接填商品数量');
  });
});
