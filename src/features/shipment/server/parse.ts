import {
  ShipmentSourceError,
  SHIPMENT_SOURCE_KEY,
  type ParsedShipmentItem,
  type ParsedShipmentSnapshot,
  type ParsedShipmentTicket,
  type ShipmentReceiptBasis,
  type ShipmentSourceCollection,
  type ShipmentSourceHeader,
  type ShipmentSourceMergedRange,
  type ShipmentStatusClass,
} from '../types';

/**
 * 飞书「物流情况表」Sheet1 的解析：表头定位 → 一票多明细分组 → 运输进度/到货口径。
 *
 * 外部数据只在这里解析一次，之后全靠明确类型。真实口径见
 * docs/tasks/shipment-in-transit-v1.md §1；任何结构不符都抛 ShipmentSourceError，
 * 不把半份数据当成成功读取。
 *
 * 用户 2026-11-01 第二次确认的填表方式（本轮纠正 R3）：
 * - G「物流情况」只写运输进度，**独立展示，不参与到货判断**；
 * - H「预计到货时间」写到货/分批/上架（预计日期、时间待定、已到 N 件余 M 件未到、
 *   已到货待上架、已到货上架、按运单/按商品逐条写）；**到货判断只看 H**。
 */

/** 表头同义词：字段键 → 可接受的表头原文（去空格后精确匹配）。 */
const HEADER_FIELDS: Array<{ field: string; labels: string[] }> = [
  { field: 'product', labels: ['产品', '产品名称', '品名', '商品'] },
  { field: 'qty', labels: ['数量', '发货数量', '在途数量'] },
  { field: 'market', labels: ['国家', '目的市场', '市场'] },
  { field: 'customs', labels: ['报关方式', '报关'] },
  { field: 'waybill', labels: ['运单号', '提单号'] },
  { field: 'po', labels: ['采购单号', '采购订单号'] },
  { field: 'status', labels: ['物流情况', '物流状态'] },
  { field: 'eta', labels: ['预计到货时间', '预计到仓', '预计到货'] },
  { field: 'vessel', labels: ['船名', '船名/航次'] },
  { field: 'dispatch', labels: ['发出时间', '发货时间'] },
  // 本版来源没有这一列；若将来加列（逐条累计到货数量），自动按来源数量口径计算。
  { field: 'received', labels: ['累计到货量', '累计到货', '到货数量'] },
];

const REQUIRED_FIELDS = ['product', 'qty', 'market'] as const;

/** 票级字段（首行填写、其余行留空）；非首行出现内容时只作该明细的来源备注，不覆盖票级值。 */
const TICKET_FIELDS = ['market', 'customs', 'waybill', 'po', 'status', 'eta', 'vessel', 'dispatch'] as const;

const FIELD_LABEL: Record<string, string> = {
  product: '产品',
  qty: '数量',
  market: '国家',
  customs: '报关方式',
  waybill: '运单号',
  po: '采购单号',
  status: '物流情况',
  eta: '预计到货时间',
  vessel: '船名',
  dispatch: '发出时间',
  received: '累计到货量',
};

export function excelColumnLetter(index: number): string {
  let value = index;
  let name = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  return String(value).trim();
}

/** 表头定位：按表头原文匹配字段，不按列位置写死；缺必填列直接失败。 */
export function resolveShipmentHeaders(firstRow: Array<unknown>): ShipmentSourceHeader[] {
  const claimed = new Map<string, string>();
  const headers: ShipmentSourceHeader[] = firstRow.map((cell, index) => {
    const header = cellText(cell);
    const key = header.replace(/\s+/g, '');
    const match = HEADER_FIELDS.find((entry) => entry.labels.includes(key));
    if (!match) return { column: excelColumnLetter(index + 1), header, field: null };
    if (claimed.has(match.field)) {
      throw new ShipmentSourceError(
        'SOURCE_HEADER_MISMATCH',
        `表头「${header}」与「${claimed.get(match.field)}」重复指向字段 ${match.field}`,
      );
    }
    claimed.set(match.field, header);
    return { column: excelColumnLetter(index + 1), header, field: match.field };
  });
  const missing = REQUIRED_FIELDS.filter((field) => !claimed.has(field));
  if (missing.length > 0) {
    throw new ShipmentSourceError(
      'SOURCE_HEADER_MISMATCH',
      `缺少必需列：${missing.map((field) => FIELD_LABEL[field]).join('、')}`,
    );
  }
  return headers;
}

/** 最后一行非空数据（1 基）。全部为空时返回表头行 1。 */
export function computeLastNonEmptyRow(values: Array<Array<string | number | null>>): number {
  for (let index = values.length - 1; index >= 1; index -= 1) {
    const row = values[index] ?? [];
    if (row.some((cell) => cellText(cell) !== '')) return index + 1;
  }
  return Math.min(values.length, 1);
}

/**
 * 品名规范化：NFKC（全半角/兼容字符统一）→ 去掉全部空白 → 小写。
 * 只用于身份键与“明确唯一”匹配，不改变展示原文；数据库端用等价 SQL 表达式。
 */
export function normalizeProductName(raw: string): string {
  return raw.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

interface WaybillSplit {
  raw: string;
  tokens: string[];
}

/** 运单号原文切分（换行 / 斜杠 / 逗号 / 顿号 / 空白）；保留原文供页面展示。 */
export function splitWaybills(raw: string | null): WaybillSplit {
  const text = (raw ?? '').trim();
  const tokens = text
    .split(/[\s/／,，、;；|]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return { raw: text, tokens };
}

/**
 * 弱身份签名：市场 + 报关方式 + 规范化品名集合（去重排序）。
 * 用于「采购单号/运单号都为空」的票身份键与补号时的唯一匹配证据。
 */
export function shipmentFallbackSignature(
  market: string | null | undefined,
  customsMethod: string | null | undefined,
  productNameNorms: readonly string[],
): string {
  const names = [...new Set(productNameNorms.map((name) => name.trim()).filter(Boolean))].sort();
  return `${(market ?? '').trim()}|${(customsMethod ?? '').trim()}|${names.join(',')}`;
}

/* ------------------------------------------------------------------ *
 * H 列到货口径（本轮纠正 R3）
 * ------------------------------------------------------------------ */

/** 已上架（整票）的纯状态写法（去日期/空白/标点后比较）。 */
const PURE_SHELVED = new Set([
  '已到货上架', '已上架', '到货上架', '已到货并上架', '已到货并全部上架',
  '已全部到货上架', '已到货已上架', '全部到货上架',
]);

/** 已到货但尚未上架的纯状态写法。 */
const PURE_AWAITING = new Set([
  '已到货待上架', '已到货待安排上架', '待上架', '到货待上架', '已到待上架',
  '已到货待上架入库',
]);

/** 只写到货、没写上架的纯状态写法：按“已到货待上架”处理（未结束在途）。 */
const PURE_ARRIVED = new Set(['已到货', '已到', '已到齐', '已全部到货', '全部到货']);

/** H 某一行是否在说到货/上架（用于确定“H 有没有到货信息”）。 */
const ARRIVAL_MARKER = /已到货|已上架|到货上架|待上架|已到(?![港仓])|未到|到齐/;

/** 分批/部分到货的写法（数量待核，不猜）。 */
const PARTIAL_MARKER = /未到|分批|部分到货|部分未到|已到\s*\d+\s*件|已到\s*\d+|余\s*\d+\s*件|到货\s*\d+\s*件/;

/** 运输进度/预计时间的证据（H 没有到货信息时，用来判断“在途”而不是“状态未提供”）。 */
const TRANSIT_EVIDENCE =
  /已发出|已离港|已出境|未离港|待装柜|待装船|装柜|装船|拆柜|清关|报关|提柜|派送|转运|查验|离港|到港|到仓|预计|已转|运输|发出/;

function stripDates(text: string): string {
  return text
    .replace(/\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?/g, '')
    .replace(/\d{1,2}\.\d{1,2}/g, '')
    .replace(/\d{1,2}\/\d{1,2}/g, '');
}

/** 去掉日期、空白与中文标点：用于判断某一行是不是“纯状态”。 */
function pureLineText(line: string): string {
  return stripDates(line).replace(/[\s，,。；;：:（）()、]/g, '');
}

function arrivalLinesOf(arrivalText: string | null): string[] {
  return (arrivalText ?? '')
    .split(/[\r\n;；]+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

type ArrivalLineKind = 'shelved' | 'awaiting' | 'partial' | 'other';

function classifyArrivalLine(line: string): ArrivalLineKind {
  if (PARTIAL_MARKER.test(line)) return 'partial';
  const pure = pureLineText(line);
  if (PURE_SHELVED.has(pure)) return 'shelved';
  if (PURE_AWAITING.has(pure)) return 'awaiting';
  if (PURE_ARRIVED.has(pure)) return 'awaiting';
  // 带品名/运单号/其他限定语：只说明某商品或某运单，不能当作整票已到。
  if (ARRIVAL_MARKER.test(line)) return 'partial';
  return 'other';
}

export interface ArrivalClassification {
  statusClass: ShipmentStatusClass;
  receivedBasis: ShipmentReceiptBasis;
}

/**
 * 到货判断（只看 H；G 仅作为“运输进度”，独立展示）：
 * - H 没有任何到货信息 → G 非空且不含到货/上架标记时按「运输中」；H 有预计/待定/运输进度也按在途；
 *   G/H 都空（只有运单号也算）→ 状态未提供；
 * - H 有到货信息：所有行都是纯状态时按整票判断（全上架=已到货上架；
 *   有已到未上架=已到货待上架）；任一行带品名/运单号/分批/未到 = 部分到货待核。
 * 绝不从自由文本里抽数字充当逐条到货数量。
 */
export function classifyShipmentArrival(
  transportText: string | null,
  arrivalText: string | null,
): ArrivalClassification {
  const lines = arrivalLinesOf(arrivalText);
  const arrivalKinds = lines.map(classifyArrivalLine);
  const hasArrivalInfo = arrivalKinds.some((kind) => kind !== 'other');
  if (hasArrivalInfo) {
    const everyLineIsPure = arrivalKinds.every((kind) => kind === 'shelved' || kind === 'awaiting');
    if (!everyLineIsPure) return { statusClass: 'partial', receivedBasis: 'pending' };
    if (arrivalKinds.every((kind) => kind === 'shelved')) {
      return { statusClass: 'arrived', receivedBasis: 'status_arrived_full' };
    }
    return { statusClass: 'arrived_pending_shelving', receivedBasis: 'status_awaiting_shelving_zero' };
  }
  // G「物流情况」只写运输进度：非空且不含到货/上架标记（也没有“未到”等线索）→ 运输中。
  // 例：POKNZX027080 G=`11/3 排队送往拆派仓`、H 空 → 运输中（不再因为缺少运输关键词词表而判未知）。
  const transport = (transportText ?? '').trim();
  if (transport !== '' && !ARRIVAL_MARKER.test(transport)) {
    return { statusClass: 'in_transit', receivedBasis: 'status_in_transit_zero' };
  }
  const transitEvidence = TRANSIT_EVIDENCE.test(transportText ?? '') || TRANSIT_EVIDENCE.test(arrivalText ?? '');
  if (transitEvidence) {
    return { statusClass: 'in_transit', receivedBasis: 'status_in_transit_zero' };
  }
  return { statusClass: 'unknown', receivedBasis: 'pending' };
}

/* ------------------------------------------------------------------ *
 * H 列「按商品点名」的到货归属（第八轮）
 *
 * 例：POKNZX026710 H=`三酸喷雾：已到货上架`，只对命中的 WM0098 明细生效；
 * 同票未点名的 WM0094 保持待核，不整票归零。**不解析自由文本里的数字**。
 * ------------------------------------------------------------------ */

/** 商品点名行：`限定语：状态`（全/半角冒号）。 */
function labelledArrivalLine(line: string): { label: string; state: string } | null {
  const match = /^(.+?)\s*[：:]\s*(.+)$/.exec(line);
  if (!match) return null;
  const label = match[1].trim();
  const state = match[2].trim();
  if (label === '' || state === '') return null;
  return { label, state };
}

/** 点名行里的「状态」部分是否是可识别的到货/上架结论。 */
function labelledArrivalKind(state: string): 'shelved' | 'awaiting' | 'partial' | null {
  if (PARTIAL_MARKER.test(state)) return 'partial';
  const pure = pureLineText(state);
  if (PURE_SHELVED.has(pure)) return 'shelved';
  if (PURE_AWAITING.has(pure) || PURE_ARRIVED.has(pure)) return 'awaiting';
  if (ARRIVAL_MARKER.test(state)) return 'partial';
  return null;
}

/** needle 是否是 haystack 的子序列（按字符顺序出现，不要求连续）。 */
function isSubsequence(needle: string, haystack: string): boolean {
  if (needle.length === 0) return false;
  let index = 0;
  for (const char of haystack) {
    if (char === needle[index]) index += 1;
    if (index === needle.length) return true;
  }
  return false;
}

/** 去掉常见品牌前后缀后的商品核心词（只用于点名匹配，不改展示原文）。 */
function productNameCore(normalized: string): string {
  return normalized
    .replace(/^(icelerskin|icelerskin|chic\.peak|chicpeak|ice)/, '')
    .replace(/(\d+(?:\.\d+)?(?:ml|g|mg|kg|片|件|瓶|支|袋|盒|只))+$/g, '');
}

/**
 * 把 H 的点名行归属到明细：返回 明细下标 → 来源到货依据。
 *
 * 保守规则（§3.2）：
 * - H 有整票纯状态行（shelved/awaiting）→ 不逐商品覆盖（返回空 Map，维持票级判断）；
 * - 否则逐行 `限定语：状态`：限定语（长度>=2）是明细规范化品名的**子序列**，或明细名包含限定语/核心词；
 * - 命中明细恰好 1 条才归属（多条命中视为歧义，不归属）；
 * - 点名行状态 shelved→status_arrived_full；awaiting→status_awaiting_shelving_zero；
 *   partial/数字/未到 → pending；未命中的明细保持 null（沿用票级依据）。
 */
export function attributeItemArrival(
  arrivalText: string | null,
  items: readonly ParsedShipmentItem[],
): Map<number, ShipmentReceiptBasis> {
  const result = new Map<number, ShipmentReceiptBasis>();
  const lines = arrivalLinesOf(arrivalText);
  if (lines.length === 0 || items.length === 0) return result;
  const kinds = lines.map(classifyArrivalLine);
  // H 有整票纯状态行时按票级判断，不做逐商品覆盖。
  if (kinds.some((kind) => kind === 'shelved' || kind === 'awaiting')) return result;

  for (const line of lines) {
    const labelled = labelledArrivalLine(line);
    if (!labelled) continue;
    const kind = labelledArrivalKind(labelled.state);
    if (kind === null) continue;
    const labelNorm = normalizeProductName(labelled.label);
    if (labelNorm.length < 2) continue;
    const matches: number[] = [];
    items.forEach((item, index) => {
      const itemNorm = item.productNameNorm;
      const core = productNameCore(itemNorm);
      const hit = itemNorm.includes(labelNorm)
        || isSubsequence(labelNorm, itemNorm)
        || (core !== '' && (core.includes(labelNorm) || labelNorm.includes(core)));
      if (hit) matches.push(index);
    });
    if (matches.length !== 1) continue; // 0 条或歧义（多条）都不归属，不猜
    const basis: ShipmentReceiptBasis = kind === 'shelved'
      ? 'status_arrived_full'
      : kind === 'awaiting'
        ? 'status_awaiting_shelving_zero'
        : 'pending';
    result.set(matches[0], basis);
  }
  return result;
}

function parsePositiveInteger(raw: string, rowNumber: number): number {
  if (!/^\d+$/.test(raw)) {
    throw new ShipmentSourceError('SOURCE_GRID_INVALID', `第 ${rowNumber} 行「数量」不是正整数：${JSON.stringify(raw)}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ShipmentSourceError('SOURCE_GRID_INVALID', `第 ${rowNumber} 行「数量」必须为正整数`);
  }
  return value;
}

function optionalText(raw: string): string | null {
  return raw === '' ? null : raw;
}

/**
 * 解析入口：把一个已读取的网格转换成票/明细结构。
 *
 * 分组：`国家` 非空的行为新票首行；同一票内票级字段取首行，其后行若另写票级内容，只记录到该明细的来源备注。
 * 身份键：票 key 依次用 采购单号 → 首张运单号 → 国家|报关方式|品名集合；明细 key 用 规范化品名#出现序号。
 * 注意：这里的 key 只是“本次来源编号派生键”，内部身份由数据库 UUID 承担（见合同 §1.3）。
 */
export function parseShipmentSnapshot(raw: {
  collection: ShipmentSourceCollection;
  values: Array<Array<string | number | null>>;
  merges: ShipmentSourceMergedRange[];
}): ParsedShipmentSnapshot {
  const { collection, values } = raw;
  if (!Array.isArray(values) || values.length < 2) {
    throw new ShipmentSourceError('SOURCE_EMPTY', '读到的表格没有数据行');
  }
  const headerRow = values[0] ?? [];
  const headers = resolveShipmentHeaders(headerRow);
  const fieldIndex = new Map<string, number>();
  headers.forEach((header, index) => {
    if (header.field) fieldIndex.set(header.field, index);
  });
  const cellOf = (row: Array<unknown>, field: string): string => {
    const index = fieldIndex.get(field);
    return index === undefined ? '' : cellText(row[index]);
  };

  const dataRows = values.slice(1);
  const lastNonEmptyRow = computeLastNonEmptyRow(values);
  // 合并单元格索引（1 基行列）：飞书只把值放在合并区左上角，其余行读到空。
  // 同一票的运单号/采购单号/报关方式等常被合并成一格横跨多行；国家列却可能被拆成
  // 两个相邻单元格（第十三轮真实样本 9258750：运单 47–62 行合并，国家 47–55 / 56–62 两格）。
  const mergeByCell = new Map<string, ShipmentSourceMergedRange>();
  for (const merge of raw.merges) {
    for (let row = merge.startRow + 1; row <= merge.endRow + 1; row += 1) {
      for (let column = merge.startColumn + 1; column <= merge.endColumn + 1; column += 1) {
        mergeByCell.set(`${column}:${row}`, merge);
      }
    }
  }
  /** 该行某票级字段是否被「本票更早一行开始」的合并区覆盖；返回合并区起始行与该格原文。 */
  const mergedTicketField = (
    field: string,
    rowNumber: number,
    currentStart: number,
  ): { startRow: number; value: string } | null => {
    const column = fieldIndex.get(field);
    if (column === undefined) return null;
    const merge = mergeByCell.get(`${column + 1}:${rowNumber}`);
    if (!merge) return null;
    const startRow = merge.startRow + 1;
    if (startRow >= rowNumber || startRow < currentStart) return null;
    return { startRow, value: cellText(values[startRow - 1]?.[column]) };
  };
  /** 新票首行若落在更早开始的合并区里（例如同一运单号跨多个采购单），沿用合并格原文。 */
  const mergedValueAt = (field: string, rowNumber: number): string => {
    const column = fieldIndex.get(field);
    if (column === undefined) return '';
    const merge = mergeByCell.get(`${column + 1}:${rowNumber}`);
    if (!merge || merge.startRow + 1 >= rowNumber) return '';
    return cellText(values[merge.startRow]?.[column]);
  };

  type Draft = {
    sourceRowStart: number;
    sourceRowEnd: number;
    fields: Record<string, string>;
    items: ParsedShipmentItem[];
    occurrence: Map<string, number>;
  };
  const drafts: Draft[] = [];
  let current: Draft | null = null;

  for (let offset = 0; offset < dataRows.length; offset += 1) {
    const rowNumber = offset + 2;
    if (rowNumber > lastNonEmptyRow) break;
    const row = dataRows[offset] ?? [];
    const productName = cellOf(row, 'product');
    const qtyText = cellOf(row, 'qty');
    if (productName === '' && qtyText === '') continue; // 空行：不是票，也不是明细

    const market = cellOf(row, 'market');
    // 国家非空通常是新票首行；但运单号/采购单号单元格明确跨行覆盖本行、市场一致、
    // 且本行没有写出不同的采购单号时，这是同一票被拆成两个国家单元格，按一票处理。
    let continuesTicket = false;
    if (market !== '' && current !== null) {
      const waybillMerge = mergedTicketField('waybill', rowNumber, current.sourceRowStart);
      const poMerge = mergedTicketField('po', rowNumber, current.sourceRowStart);
      const ownPo = cellOf(row, 'po');
      const poConflict = ownPo !== '' && ownPo !== current.fields.po;
      const waybillContinues = waybillMerge !== null
        && waybillMerge.value !== ''
        && waybillMerge.value === current.fields.waybill;
      const poContinues = poMerge !== null
        && poMerge.value !== ''
        && poMerge.value === current.fields.purchaseOrder;
      continuesTicket = market === current.fields.market
        && !poConflict
        && (waybillContinues || poContinues);
    }
    if (market !== '' && !continuesTicket) {
      // 国家非空 = 新票首行；票级字段只取首行，其余行留空（原表合并单元格语义）。
      const fields: Record<string, string> = {};
      for (const field of TICKET_FIELDS) {
        const own = cellOf(row, field);
        fields[field] = own !== '' ? own : mergedValueAt(field, rowNumber);
      }
      current = { sourceRowStart: rowNumber, sourceRowEnd: rowNumber, fields, items: [], occurrence: new Map() };
      drafts.push(current);
    } else if (current === null) {
      throw new ShipmentSourceError(
        'SOURCE_GRID_INVALID',
        `第 ${rowNumber} 行有产品但没有起始票（缺少「国家」），无法确定属于哪一票`,
      );
    }

    if (productName === '') {
      throw new ShipmentSourceError('SOURCE_GRID_INVALID', `第 ${rowNumber} 行缺少产品名称`);
    }
    const shippedQuantity = parsePositiveInteger(qtyText, rowNumber);
    const normName = normalizeProductName(productName);
    const occurrence = current.occurrence.get(normName) ?? 0;
    current.occurrence.set(normName, occurrence + 1);
    const itemKey = `${normName}#${occurrence}`;

    // 非首行另写的票级内容：保留为来源备注，不覆盖票级值，也不猜是新票。
    const notes: string[] = [];
    if (rowNumber !== current.sourceRowStart) {
      for (const field of TICKET_FIELDS) {
        const value = cellOf(row, field);
        if (value !== '' && value !== current.fields[field]) {
          notes.push(`${FIELD_LABEL[field]}：${value}`);
        }
      }
    }
    const receivedText = cellOf(row, 'received');
    // 本版来源没有「累计到货量」列；若将来加列，数字按来源数量口径采用，非数字只作备注，不猜。
    const sourceReceivedQuantity = /^\d+$/.test(receivedText) ? Number(receivedText) : null;
    const receivedNote = receivedText !== '' && sourceReceivedQuantity === null
      ? `来源累计到货原文：${receivedText}`
      : null;

    current.items.push({
      itemKey,
      productNameRaw: productName,
      productNameNorm: normName,
      shippedQuantity,
      sourceReceivedQuantity,
      // 逐商品点名归属在票级分类之后统一计算（见 attributeItemArrival）。
      sourceReceiptBasis: null,
      sourceRow: rowNumber,
      sourceNote: [receivedNote, ...notes].filter(Boolean).join('；') || null,
    });
    current.sourceRowEnd = rowNumber;
  }

  if (drafts.length === 0) {
    throw new ShipmentSourceError('SOURCE_EMPTY', '表头有，但没有可识别的票和明细');
  }

  const tickets: ParsedShipmentTicket[] = [];
  const seenTicketKeys = new Map<string, number>();
  for (const draft of drafts) {
    const purchaseOrder = optionalText(draft.fields.po ?? '');
    const waybills = splitWaybills(draft.fields.waybill ?? '');
    const market = optionalText(draft.fields.market ?? '');
    const customsMethod = optionalText(draft.fields.customs ?? '');
    const transportText = optionalText(draft.fields.status ?? '');
    const arrivalText = optionalText(draft.fields.eta ?? '');

    const productNameNorms = draft.items.map((item) => item.productNameNorm);
    const ticketKey = purchaseOrder
      ? `PO:${purchaseOrder}`
      : waybills.tokens[0]
        ? `WB:${waybills.tokens[0]}`
        : `FB:${shipmentFallbackSignature(market, customsMethod, productNameNorms)}`;
    const ticketNo = purchaseOrder
      ?? waybills.tokens[0]
      ?? `无单号·${market ?? '未知市场'}·行${draft.sourceRowStart}`;

    const duplicate = seenTicketKeys.get(ticketKey);
    if (duplicate !== undefined) {
      throw new ShipmentSourceError(
        'SOURCE_GRID_INVALID',
        `第 ${draft.sourceRowStart} 行与第 ${duplicate} 行都没有可区分的采购单号/运单号（或编号重复）；`
        + `请先在原表给其中一票补上单号，避免两票被并成一票`,
      );
    }
    seenTicketKeys.set(ticketKey, draft.sourceRowStart);

    const { statusClass, receivedBasis } = classifyShipmentArrival(transportText, arrivalText);
    // H 按商品点名（「某商品：已到货上架」）只作用于命中的明细；未命中保持票级依据。
    const attribution = attributeItemArrival(arrivalText, draft.items);
    if (attribution.size > 0) {
      draft.items.forEach((item, index) => {
        const basis = attribution.get(index);
        if (basis !== undefined) item.sourceReceiptBasis = basis;
      });
    }

    tickets.push({
      ticketKey,
      ticketNo,
      sourceRowStart: draft.sourceRowStart,
      sourceRowEnd: draft.sourceRowEnd,
      market,
      customsMethod,
      waybillsText: waybills.raw === '' ? null : waybills.raw,
      purchaseOrder,
      transportText,
      arrivalText,
      vessel: optionalText(draft.fields.vessel ?? ''),
      dispatchedText: optionalText(draft.fields.dispatch ?? ''),
      statusClass,
      receivedBasis,
      items: draft.items,
    });
  }

  return {
    sourceKey: SHIPMENT_SOURCE_KEY,
    collection: { ...collection, headers, lastNonEmptyRow },
    tickets,
    raw: { values, merges: raw.merges },
  };
}
