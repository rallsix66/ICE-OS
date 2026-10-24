import { describe, expect, it } from 'vitest';
import { warehouseScopeView, type InventoryRowSlice } from './warehouse-valuation';

const ITEM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FINANCIAL = { cost: { state: 'observed', meaning: 'value', raw: '2.94' } } as never;

function slice(overrides: Partial<InventoryRowSlice>): InventoryRowSlice {
  return {
    itemId: ITEM,
    warehouse: 'PH-彩妆日均万单简简单单仓',
    onHand: '10',
    selectionState: 'confirmed',
    ...overrides,
  };
}

describe('warehouseScopeView empty and zero states', () => {
  it('does not turn an unconfirmed line into confirmed zero stock', () => {
    const view = warehouseScopeView([
      slice({ warehouse: '菲律宾-新创启辰自建仓' }),
      slice({ selectionState: 'unselected', onHand: '8' }),
    ], ITEM, 'PH-彩妆日均万单简简单单仓', FINANCIAL, true, false);
    expect(view.valuationState).toBe('no_inventory');
    expect(view.confirmedOnHandTotal).toBeNull();
    expect(view.confirmedLineCount).toBe(0);
    expect(view.valuationReason).toContain('无已确认');
  });

  it('keeps a confirmed zero row as real zero stock', () => {
    const view = warehouseScopeView([
      slice({ warehouse: '印尼-DEE仓库', onHand: '0', selectionState: 'confirmed' }),
    ], ITEM, '印尼-DEE仓库', FINANCIAL, true, false);
    expect(view.valuationState).toBe('valued');
    expect(view.confirmedOnHandTotal).toBe('0');
    expect(view.estimatedValueCny).toBe('0');
    expect(view.confirmedLineCount).toBe(1);
  });

  it('distinguishes a warehouse with no BS line from a zero-stock warehouse', () => {
    const view = warehouseScopeView([
      slice({ warehouse: '菲律宾-新创启辰自建仓', onHand: '10' }),
    ], ITEM, 'PH-彩妆日均万单简简单单仓', FINANCIAL, true, false);
    expect(view.valuationState).toBe('no_warehouse_line');
    expect(view.confirmedOnHandTotal).toBeNull();
    expect(view.valuationReason).toContain('本仓无对应');
  });

  it('all scope with only unselected rows is not confirmed zero', () => {
    const view = warehouseScopeView([
      slice({ warehouse: '喜运达MY仓', selectionState: 'unselected', onHand: '6' }),
    ], ITEM, undefined, FINANCIAL, true, false);
    expect(view.valuationState).toBe('no_inventory');
    expect(view.confirmedOnHandTotal).toBeNull();
    expect(view.confirmedLineCount).toBe(0);
  });

  it('keeps no-amount permission distinct while preserving confirmed quantity', () => {
    const view = warehouseScopeView([
      slice({ warehouse: '菲律宾-新创启辰自建仓', onHand: '10' }),
    ], ITEM, '菲律宾-新创启辰自建仓', null, false, false);
    expect(view.valuationState).toBe('not_applicable');
    expect(view.confirmedOnHandTotal).toBe('10');
    expect(view.estimatedValueCny).toBeNull();
  });
});
