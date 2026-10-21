import type { FieldObservation, PreparedFinancial } from '../types';

export type AdoptedUnitCost =
  | { state: 'priced'; amountCny: string; evidenceRef: string; sourceRow: number | null }
  | { state: 'missing'; reason: string }
  | { state: 'parse_failed'; reason: string };

function readCost(cost: FieldObservation): string | null {
  if (cost.state !== 'observed' || cost.meaning === 'explicit_null') return null;
  if (cost.meaning === 'explicit_empty') return null;
  const raw = cost.raw.trim();
  if (!raw || raw === '--') return null;
  if (!/^\d+(\.\d+)?$/.test(raw)) return null;
  return raw;
}

/** Current adopted CNY unit cost from published financial revision; does not rewrite frozen unknown flags. */
export function adoptedUnitCostFromFinancial(financial: PreparedFinancial | null | undefined): AdoptedUnitCost {
  if (!financial) return { state: 'missing', reason: '无已承接的采用价格版本' };
  const amount = readCost(financial.cost);
  if (!amount) {
    if (financial.cost.state === 'parse_failed' || financial.cost.state === 'not_read') {
      return { state: 'parse_failed', reason: financial.cost.reason ?? '进货价解析失败' };
    }
    return { state: 'missing', reason: '当前资料无可用数值进货价' };
  }
  return { state: 'priced', amountCny: amount, evidenceRef: financial.cost.evidenceRef, sourceRow: financial.sourceRow };
}
