/** Fixed-scale decimal helpers for money × quantity (no float accumulation). */

const SCALE = 4;
const SCALE_FACTOR = BigInt(10 ** SCALE);

function normalize(raw: string): bigint {
  const trimmed = raw.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) throw new Error('DECIMAL_INVALID');
  const negative = trimmed.startsWith('-');
  const body = negative ? trimmed.slice(1) : trimmed;
  const [whole, frac = ''] = body.split('.');
  const padded = (frac + '0'.repeat(SCALE)).slice(0, SCALE);
  const value = BigInt(whole) * SCALE_FACTOR + BigInt(padded || '0');
  return negative ? -value : value;
}

export function parseQuantity(raw: string | null | undefined): bigint | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (text === '' || text === '--') return null;
  if (!/^-?\d+$/.test(text)) return null;
  return BigInt(text);
}

export function parseMoney(raw: string | null | undefined): bigint | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (text === '' || text === '--') return null;
  return normalize(text);
}

export function formatMoney(scaled: bigint): string {
  const zero = BigInt(0);
  const negative = scaled < zero;
  const abs = negative ? -scaled : scaled;
  const whole = abs / SCALE_FACTOR;
  const frac = abs % SCALE_FACTOR;
  const fracText = frac.toString().padStart(SCALE, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fracText ? `.${fracText}` : ''}`;
}

export function multiplyMoneyByQuantity(priceScaled: bigint, qty: bigint): bigint {
  return priceScaled * qty;
}

export function formatQuantity(qty: bigint): string {
  return qty.toString();
}
