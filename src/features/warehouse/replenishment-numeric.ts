import 'server-only';

export class WarehouseNumericError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WarehouseNumericError';
  }
}

/** 仓库补货参数专用：将 PG numeric / string 规范为有限 number，不用于金额字段。 */
export function parseReplenishmentDecimal(value: unknown, field: string): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new WarehouseNumericError(`补货参数 ${field} 无效`);
    }
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') {
      throw new WarehouseNumericError(`补货参数 ${field} 无效`);
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      throw new WarehouseNumericError(`补货参数 ${field} 无效`);
    }
    return parsed;
  }
  throw new WarehouseNumericError(`补货参数 ${field} 无效`);
}

/** 写后校验：与 PG 持久化后的数值比较（避免 numeric 字符串与 JS number 严格相等失败）。 */
export function replenishmentDecimalsEqual(expected: number, actual: number): boolean {
  if (Object.is(expected, actual)) return true;
  const e = parseReplenishmentDecimal(expected, 'expected');
  const a = parseReplenishmentDecimal(actual, 'actual');
  return Math.abs(e - a) <= 1e-9;
}
