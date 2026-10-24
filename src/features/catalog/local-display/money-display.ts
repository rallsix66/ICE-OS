/**
 * 显示层人民币格式化（Lead 维护，跨列表/详情共用）。
 *
 * 只改“怎么显示”，不改底层 Decimal、计算与存储：
 * - 估算货值：千分位 + 固定 2 位小数（half-up 字符串取整，不经浮点）。
 * - 采用进货价：千分位 + 保留原有小数位（不补零、不四舍五入丢精度）。
 * - 原值始终以原始字符串保留在数据/技术说明层，可追溯。
 */

type ParsedDecimal = { negative: boolean; whole: string; frac: string };

/** BigInt 构造器写法：项目 tsconfig target 低于 ES2020，不能使用 BigInt 字面量。 */
const HUNDRED = BigInt(100);
const TWO = BigInt(2);
const TEN = BigInt(10);

function parseDecimal(raw: string | null | undefined): ParsedDecimal | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
  const negative = text.startsWith('-');
  const body = negative ? text.slice(1) : text;
  const [whole, frac = ''] = body.split('.');
  return { negative, whole, frac };
}

function groupThousands(digits: string): string {
  const trimmed = digits.replace(/^0+(?=\d)/, '');
  return trimmed.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 千分位 + 固定 2 位小数；非法输入返回 null（调用方显示缺值文案，不猜补）。 */
export function formatCnyValue(raw: string | null | undefined): string | null {
  const parsed = parseDecimal(raw);
  if (!parsed) return null;
  // 整数原值（无小数位）不能多拼前导 '0'，否则分母为 1 时会放大 10 倍。
  const digits = parsed.frac ? `${parsed.whole}${parsed.frac}` : parsed.whole;
  const numerator = BigInt(digits);
  const denominator = TEN ** BigInt(parsed.frac.length);
  const scaledCents = numerator * HUNDRED;
  let cents = scaledCents / denominator;
  const remainder = scaledCents % denominator;
  if (remainder * TWO >= denominator) cents += BigInt(1);
  const wholeOut = cents / HUNDRED;
  const fracOut = (cents % HUNDRED).toString().padStart(2, '0');
  const sign = parsed.negative && cents !== BigInt(0) ? '-' : '';
  return `¥${sign}${groupThousands(wholeOut.toString())}.${fracOut}`;
}

/** 千分位 + 保留原小数位；非法输入返回 null。 */
export function formatCnyPrice(raw: string | null | undefined): string | null {
  const parsed = parseDecimal(raw);
  if (!parsed) return null;
  const fracOut = parsed.frac ? `.${parsed.frac}` : '';
  const sign = parsed.negative ? '-' : '';
  return `¥${sign}${groupThousands(parsed.whole)}${fracOut}`;
}
