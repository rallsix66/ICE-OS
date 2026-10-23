/**
 * Mirrors src/features/catalog/local-display warehouse valuation for perf fixture generation.
 */

const SCALE = 4;
const SCALE_FACTOR = 10n ** BigInt(SCALE);

function normalizeMoney(raw) {
  const trimmed = raw.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) throw new Error('DECIMAL_INVALID');
  const negative = trimmed.startsWith('-');
  const body = negative ? trimmed.slice(1) : trimmed;
  const [whole, frac = ''] = body.split('.');
  const padded = (frac + '0'.repeat(SCALE)).slice(0, SCALE);
  const value = BigInt(whole) * SCALE_FACTOR + BigInt(padded || '0');
  return negative ? -value : value;
}

export function parseQuantity(raw) {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (text === '' || text === '--') return null;
  if (!/^-?\d+$/.test(text)) return null;
  return BigInt(text);
}

export function parseMoney(raw) {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (text === '' || text === '--') return null;
  return normalizeMoney(text);
}

export function formatMoney(scaled) {
  const zero = 0n;
  const negative = scaled < zero;
  const abs = negative ? -scaled : scaled;
  const whole = abs / SCALE_FACTOR;
  const frac = abs % SCALE_FACTOR;
  const fracText = frac.toString().padStart(SCALE, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fracText ? `.${fracText}` : ''}`;
}

export function formatQuantity(qty) {
  return qty.toString();
}

export function multiplyMoneyByQuantity(priceScaled, qty) {
  return priceScaled * qty;
}

function readCost(cost) {
  if (!cost || cost.state !== 'observed' || cost.meaning === 'explicit_null' || cost.meaning === 'explicit_empty') return null;
  const raw = String(cost.raw ?? '').trim();
  if (!raw || raw === '--') return null;
  if (!/^\d+(\.\d+)?$/.test(raw)) return null;
  return raw;
}

export function adoptedUnitCostFromFinancial(financial) {
  if (!financial) return { state: 'missing', reason: '无已承接的采用价格版本' };
  const amount = readCost(financial.cost);
  if (!amount) {
    if (financial.cost?.state === 'parse_failed' || financial.cost?.state === 'not_read') {
      return { state: 'parse_failed', reason: financial.cost.reason ?? '进货价解析失败' };
    }
    return { state: 'missing', reason: '当前资料无可用数值进货价' };
  }
  return { state: 'priced', amountCny: amount };
}

export function sumConfirmedOnHand(rows, itemId, warehouse) {
  let total = null;
  for (const row of rows) {
    if (row.itemId !== itemId || row.selectionState !== 'confirmed') continue;
    if (warehouse && row.warehouse !== warehouse) continue;
    const qty = parseQuantity(row.onHand);
    if (qty === null) return null;
    total = (total ?? 0n) + qty;
  }
  return total;
}

export function warehouseScopeView(rows, itemId, warehouse, financial, amountAllowed, notCreatedBs) {
  const confirmedLineCount = rows.filter(
    (r) => r.itemId === itemId && r.selectionState === 'confirmed' && (!warehouse || r.warehouse === warehouse),
  ).length;
  const anyLine = warehouse
    ? rows.some((r) => r.itemId === itemId && r.warehouse === warehouse)
    : rows.some((r) => r.itemId === itemId);
  if (warehouse && !anyLine && rows.some((r) => r.itemId === itemId && r.selectionState === 'confirmed')) {
    return {
      confirmedOnHandTotal: null,
      estimatedValueCny: null,
      valuationState: 'no_warehouse_line',
      valuationReason: '本仓无对应 BS 样表行（不当作 0）',
      confirmedLineCount: 0,
    };
  }
  const adoptedUnitCost = amountAllowed ? adoptedUnitCostFromFinancial(financial) : null;
  const onHandTotal = sumConfirmedOnHand(rows, itemId, warehouse);
  if (notCreatedBs) {
    return {
      confirmedOnHandTotal: null,
      estimatedValueCny: null,
      valuationState: 'not_applicable',
      valuationReason: 'BS尚未建档（本批用户确认），不显示为库存0',
      confirmedLineCount,
    };
  }
  if (!amountAllowed) {
    return {
      confirmedOnHandTotal: onHandTotal === null ? null : formatQuantity(onHandTotal),
      estimatedValueCny: null,
      valuationState: 'not_applicable',
      valuationReason: '当前会话无金额读取权限',
      confirmedLineCount,
    };
  }
  if (adoptedUnitCost?.state !== 'priced') {
    return {
      confirmedOnHandTotal: onHandTotal === null ? null : formatQuantity(onHandTotal),
      estimatedValueCny: null,
      valuationState: 'no_price',
      valuationReason: adoptedUnitCost?.reason ?? '缺进货价',
      confirmedLineCount,
    };
  }
  if (onHandTotal === null) {
    return {
      confirmedOnHandTotal: null,
      estimatedValueCny: null,
      valuationState: 'no_inventory',
      valuationReason: confirmedLineCount ? '已选样表行存在无法解析的现有库存' : '无已确认 BS 样表库存行',
      confirmedLineCount,
    };
  }
  const price = parseMoney(adoptedUnitCost.amountCny);
  if (price === null) {
    return {
      confirmedOnHandTotal: formatQuantity(onHandTotal),
      estimatedValueCny: null,
      valuationState: 'no_price',
      valuationReason: '进货价解析失败',
      confirmedLineCount,
    };
  }
  return {
    confirmedOnHandTotal: formatQuantity(onHandTotal),
    estimatedValueCny: formatMoney(multiplyMoneyByQuantity(price, onHandTotal)),
    valuationState: 'valued',
    valuationReason: null,
    confirmedLineCount,
  };
}

export function parseInventoryRpcResult(raw) {
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!Array.isArray(parsed)) {
    throw new Error(`CATALOG_PERF_FIXTURE_INVENTORY_SHAPE:expected_array_got_${parsed === null ? 'null' : typeof parsed}`);
  }
  return parsed;
}

export function qtyField(raw) {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (text === '' || text === '--') return null;
  return text;
}

export function moneyDisplay(amountCny) {
  if (amountCny == null || amountCny === '') return null;
  return `¥${amountCny}`;
}
