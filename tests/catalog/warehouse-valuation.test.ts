import { describe, expect, it } from 'vitest';
import { formatMoney, multiplyMoneyByQuantity, parseMoney } from '@/features/catalog/local-display/decimal';
import { warehouseScopeView } from '@/features/catalog/local-display/warehouse-valuation';
import type { PreparedFinancial } from '@/features/catalog/types';

const itemId = '11111111-1111-4111-8111-111111111199';
const financial = (cost: string): PreparedFinancial => ({
  cost: { state: 'observed', meaning: 'value', raw: cost, evidenceRef: 'fixture' },
  operatingPrice: { state: 'observed', meaning: 'value', raw: '0', evidenceRef: 'fixture' },
  sourceRow: 1,
  versions: [],
  currency: 'unknown',
  unit: 'unknown',
  tax: 'unknown',
  freight: 'unknown',
  valuationAuthorized: false,
  rawRef: 'fixture',
});

const rows = [
  { itemId, warehouse: 'WH-A', onHand: '10', selectionState: 'confirmed' },
  { itemId, warehouse: 'WH-B', onHand: '5', selectionState: 'confirmed' },
  { itemId, warehouse: 'WH-C', onHand: '0', selectionState: 'confirmed' },
];

describe('warehouseScopeView', () => {
  it('uses all warehouses for full scope with priced valuation', () => {
    const all = warehouseScopeView(rows, itemId, undefined, financial('5.18'), true, false);
    expect(all.confirmedOnHandTotal).toBe('15');
    expect(all.valuationState).toBe('valued');
    expect(all.estimatedValueCny).toBe('77.7');
  });

  it('scopes quantity, zero inventory, missing warehouse, and switch back to all', () => {
    const whA = warehouseScopeView(rows, itemId, 'WH-A', financial('5.18'), true, false);
    expect(whA.confirmedOnHandTotal).toBe('10');
    expect(whA.estimatedValueCny).toBe('51.8');
    const zero = warehouseScopeView(rows, itemId, 'WH-C', financial('5.18'), true, false);
    expect(zero.confirmedOnHandTotal).toBe('0');
    expect(zero.valuationState).toBe('valued');
    expect(zero.estimatedValueCny).toBe('0');
    const missing = warehouseScopeView(rows, itemId, 'WH-Z', financial('5.18'), true, false);
    expect(missing.valuationState).toBe('no_warehouse_line');
    expect(missing.confirmedOnHandTotal).toBeNull();
    const backAll = warehouseScopeView(rows, itemId, undefined, financial('5.18'), true, false);
    expect(backAll.estimatedValueCny).toBe('77.7');
  });

  it('marks missing price and unparsable quantity', () => {
    const noPrice = warehouseScopeView(rows, itemId, 'WH-A', null, true, false);
    expect(noPrice.valuationState).toBe('no_price');
    const badQty = warehouseScopeView([{ itemId, warehouse: 'WH-A', onHand: 'x', selectionState: 'confirmed' }], itemId, undefined, financial('5.18'), true, false);
    expect(badQty.valuationState).toBe('no_inventory');
    expect(badQty.confirmedOnHandTotal).toBeNull();
  });

  it('multiplies with fixed-scale integer math', () => {
    const price = parseMoney('5.18')!;
    expect(formatMoney(multiplyMoneyByQuantity(price, BigInt(10)))).toBe('51.8');
  });
});
