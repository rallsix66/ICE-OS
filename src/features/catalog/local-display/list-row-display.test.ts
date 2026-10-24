import { describe, expect, it } from 'vitest';
import type { CatalogListClientRow } from './list-client-types';
import { formatAdoptedUnitCostCell, formatEstimatedValueCell, formatInventoryCell } from './list-row-display';

function row(overrides: Partial<CatalogListClientRow> = {}): CatalogListClientRow {
  return {
    itemId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    itemRevision: 1,
    sourceSearchTokens: [],
    iceCode: 'WM0001',
    nameCn: '测试',
    newProductConfirmed: false,
    humanChoices: { bigseller: 1, jushuitan: 0 },
    specificationText: '100ml',
    englishName: 'Test',
    barcodeText: '690',
    unitText: '瓶',
    categoryText: '护肤',
    adoptedUnitCost: { state: 'priced', amountCny: '5.18', evidenceRef: 'e', sourceRow: 1 },
    materialStatus: '资料已承接',
    inventoryProjectionByWarehouse: { all: 'all\0' },
    bsSample: {
      confirmedOnHandTotal: '10',
      confirmedLineCount: 1,
      warehouseScopes: {
        菲越: {
          confirmedOnHandTotal: '10',
          confirmedLineCount: 1,
          estimatedValueCny: '51.80',
          valuationState: 'valued',
          valuationReason: null,
        },
      },
      estimatedValueCny: '51.80',
      valuationState: 'valued',
      valuationReason: null,
    },
    ...overrides,
  };
}

describe('list row display cells', () => {
  it('shows valued inventory and estimate for all warehouses', () => {
    expect(formatInventoryCell(row(), 'all')).toBe('10');
    expect(formatEstimatedValueCell(row(), 'all')).toBe('¥51.80');
  });

  it('scopes warehouse-specific valuation', () => {
    const scoped = row({
      bsSample: {
        ...row().bsSample,
        warehouseScopes: {
          菲越: row().bsSample.warehouseScopes.菲越,
          泰国: {
            confirmedOnHandTotal: null,
            confirmedLineCount: 0,
            estimatedValueCny: null,
            valuationState: 'no_warehouse_line',
            valuationReason: '本仓无对应 BS 样表行（不当作 0）',
          },
        },
      },
    });
    expect(formatInventoryCell(scoped, '泰国')).toBe('本仓无对应');
    expect(formatEstimatedValueCell(scoped, '泰国')).toBe('本仓无对应');
  });

  it('distinguishes missing price and zero inventory', () => {
    const missingPrice = row({
      adoptedUnitCost: { state: 'missing', reason: '缺进货价' },
      bsSample: {
        ...row().bsSample,
        estimatedValueCny: null,
        valuationState: 'no_price',
        valuationReason: '缺进货价',
      },
    });
    expect(formatEstimatedValueCell(missingPrice, 'all')).toBe('缺进货价');

    const zeroStock = row({
      bsSample: {
        ...row().bsSample,
        confirmedOnHandTotal: '0',
        estimatedValueCny: '0.00',
        valuationState: 'valued',
        warehouseScopes: {
          菲越: {
            confirmedOnHandTotal: '0',
            confirmedLineCount: 1,
            estimatedValueCny: '0.00',
            valuationState: 'valued',
            valuationReason: null,
          },
        },
      },
    });
    expect(formatInventoryCell(zeroStock, 'all')).toBe('0');
    expect(formatEstimatedValueCell(zeroStock, 'all')).toBe('¥0.00');
  });

  it('shows projection status when display unavailable', () => {
    expect(formatInventoryCell(row(), 'all', 'not_imported')).toBe('样表未导入');
    expect(formatEstimatedValueCell(row(), 'all', 'read_failed')).toBe('样表读取失败');
    expect(formatEstimatedValueCell(row(), 'all', 'forbidden')).toBe('样表无权限');
  });

  it('distinguishes no confirmed BS lines from real zero stock', () => {
    const noConfirmed = row({
      bsSample: {
        ...row().bsSample,
        confirmedOnHandTotal: null,
        confirmedLineCount: 0,
            warehouseScopes: {},
        estimatedValueCny: null,
        valuationState: 'no_inventory',
        valuationReason: '无已确认 BS 样表库存行',
      },
    });
    expect(formatInventoryCell(noConfirmed, 'all')).toBe('无已确认库存');
    expect(formatEstimatedValueCell(noConfirmed, 'all')).toContain('无已确认');

    const zeroAll = row({
      bsSample: {
        ...row().bsSample,
        confirmedOnHandTotal: '0',
        confirmedLineCount: 1,
        warehouseScopes: {
          菲越: {
            confirmedOnHandTotal: '0',
            confirmedLineCount: 1,
            estimatedValueCny: '0.00',
            valuationState: 'valued',
            valuationReason: null,
          },
        },
        estimatedValueCny: '0.00',
        valuationState: 'valued',
        valuationReason: null,
      },
    });
    expect(formatInventoryCell(zeroAll, 'all')).toBe('0');
    expect(formatInventoryCell(zeroAll, '菲越')).toBe('0');
    expect(formatEstimatedValueCell(zeroAll, '菲越')).toBe('¥0.00');
  });

  it('groups estimated value with thousands separators and fixed 2 decimals, inventory stays raw', () => {
    const largeValue = row({
      bsSample: {
        ...row().bsSample,
        confirmedOnHandTotal: '7355',
        confirmedLineCount: 1,
        estimatedValueCny: '21623.7',
        valuationState: 'valued',
        valuationReason: null,
        warehouseScopes: {
          菲越: {
            confirmedOnHandTotal: '4946',
            confirmedLineCount: 1,
            estimatedValueCny: '14541.24',
            valuationState: 'valued',
            valuationReason: null,
          },
        },
      },
    });
    expect(formatInventoryCell(largeValue, 'all')).toBe('7355');
    expect(formatEstimatedValueCell(largeValue, 'all')).toBe('¥21,623.70');
    expect(formatInventoryCell(largeValue, '菲越')).toBe('4946');
    expect(formatEstimatedValueCell(largeValue, '菲越')).toBe('¥14,541.24');
  });

  it('keeps adopted unit price precision while adding thousands separators', () => {
    const priced = (amountCny: string) => row({ adoptedUnitCost: { state: 'priced', amountCny, evidenceRef: 'e', sourceRow: 1 } });
    expect(formatAdoptedUnitCostCell(priced('5.18').adoptedUnitCost)).toBe('¥5.18');
    expect(formatAdoptedUnitCostCell(priced('4.4').adoptedUnitCost)).toBe('¥4.4');
    expect(formatAdoptedUnitCostCell(priced('1200.5').adoptedUnitCost)).toBe('¥1,200.5');
    expect(formatAdoptedUnitCostCell(null)).toBe('—');
    expect(formatAdoptedUnitCostCell({ state: 'missing', reason: '当前资料无可用数值进货价' })).toBe('成本待补充');
    expect(formatAdoptedUnitCostCell({ state: 'parse_failed', reason: '进货价解析失败' })).toBe('成本待补充');
  });
});
