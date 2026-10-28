import { describe, expect, it } from 'vitest';

import { buildInventoryCatalogSource, emptyInventoryView, type InventoryCatalogRaw } from './inventory-source';
import { clientRowAsDisplayRow, toCatalogListClientPayload, type CatalogListClientRow } from './list-client-types';
import { applyWarehouseScopeToDisplayRow } from './client-scope';
import { formatEstimatedValueCell, formatInventoryCell, formatSampleLabel } from './list-row-display';
import type { CatalogDisplayOverview, WarehouseScopeView } from './display-types';
import type { CatalogItemDto } from '../types';

const PH = '菲律宾-新创启辰自建仓';
const VN = '越南青林湾仓库';

const itemA = '11111111-1111-4111-8111-00000000000a';
const itemB = '11111111-1111-4111-8111-00000000000b';
const itemC = '11111111-1111-4111-8111-00000000000c';

function rawSource(): InventoryCatalogRaw {
  return {
    scope: { id: 'scope', version: 1, warehouseCount: 2, empty: false, lastAllSuccessAt: '2026-10-26T13:11:31.916Z' },
    warehouses: [
      { warehouseId: 'wh-vn', externalId: '50455', name: VN, market: 'VN', status: 'confirmed' },
      { warehouseId: 'wh-ph', externalId: '56519', name: PH, market: 'PH', status: 'confirmed' },
    ],
    readStates: [
      { warehouseId: 'wh-vn', lastSuccessAt: '2026-10-26T13:11:31.916Z', lastPublishAt: '2026-10-26T13:11:34Z', lastObservationAt: '2026-10-26T13:11:31.916Z', latestRunStatus: 'success', failed: false, stale: false, lastErrorCode: null },
      { warehouseId: 'wh-ph', lastSuccessAt: '2026-10-26T13:11:31.916Z', lastPublishAt: '2026-10-26T13:11:34Z', lastObservationAt: '2026-10-26T13:11:31.916Z', latestRunStatus: 'success', failed: false, stale: false, lastErrorCode: null },
    ],
    effectiveRows: [
      { itemId: itemA, warehouseId: 'wh-vn', warehouseExternalId: '50455', warehouseName: VN, market: 'VN', externalSku: '697000000001', unit: '个', onHand: 10, orderLocked: 0, warehouseAvailable: 10, activityReserved: 0, inTransit: 0, gtin: null, observedAt: '2026-10-26T13:11:31.916Z', batchId: 'b1', excelRow: 5, itemRevision: 1, mappingId: 'map-a-vn', verification: false, unitConfirmed: true },
      { itemId: itemA, warehouseId: 'wh-ph', warehouseExternalId: '56519', warehouseName: PH, market: 'PH', externalSku: '757577983013', unit: '个', onHand: 3, orderLocked: 0, warehouseAvailable: 3, activityReserved: 0, inTransit: 0, gtin: null, observedAt: '2026-10-26T13:11:31.916Z', batchId: 'b2', excelRow: 440, itemRevision: 1, mappingId: 'map-a-ph-1', verification: false, unitConfirmed: true },
      { itemId: itemA, warehouseId: 'wh-ph', warehouseExternalId: '56519', warehouseName: PH, market: 'PH', externalSku: 'ICEWM0026', unit: '个', onHand: 4, orderLocked: 0, warehouseAvailable: 4, activityReserved: 0, inTransit: 0, gtin: null, observedAt: '2026-10-26T13:11:31.916Z', batchId: 'b2', excelRow: 446, itemRevision: 1, mappingId: 'map-a-ph-2', verification: false, unitConfirmed: true },
      { itemId: itemB, warehouseId: 'wh-vn', warehouseExternalId: '50455', warehouseName: VN, market: 'VN', externalSku: '697000000002', unit: '个', onHand: 0, orderLocked: 0, warehouseAvailable: 0, activityReserved: 0, inTransit: 0, gtin: null, observedAt: '2026-10-26T13:11:31.916Z', batchId: 'b1', excelRow: 6, itemRevision: 1, mappingId: 'map-b-vn', verification: true, unitConfirmed: false },
    ],
    mappings: [
      { itemId: itemA, warehouseId: 'wh-vn', externalSku: '697000000001', unit: '个', version: 1, verification: false, unitConfirmed: true },
      { itemId: itemA, warehouseId: 'wh-ph', externalSku: '757577983013', unit: '个', version: 1, verification: false, unitConfirmed: true },
      { itemId: itemA, warehouseId: 'wh-ph', externalSku: 'ICEWM0026', unit: '个', version: 1, verification: false, unitConfirmed: true },
      { itemId: itemB, warehouseId: 'wh-vn', externalSku: '697000000002', unit: '个', version: 1, verification: true, unitConfirmed: false },
    ],
    candidates: [
      { itemId: itemC, warehouseId: 'wh-ph', externalSku: 'WM0001', status: 'pending' },
      { itemId: itemB, warehouseId: 'wh-ph', externalSku: 'ICEWM0027', status: 'pending' },
    ],
    latestRun: { runId: 'run-1', exportFinishedAt: '2026-10-26T13:11:31.916Z' },
    sourceRows: [
      { warehouseExternalId: '56519', externalSku: 'WM0001', excelRow: 590, productName: '待核商品', onHand: 0 },
      { warehouseExternalId: '56519', externalSku: 'ICEWM0027', excelRow: 564, productName: '待核来源', onHand: 0 },
      { warehouseExternalId: '50455', externalSku: 'UNKNOWN-SKU', excelRow: 700, productName: '不在商品库', onHand: 5 },
    ],
  };
}

describe('unified inventory source (catalog list)', () => {
  it('sums single-code lines, keeps multi-code groups pending and never adds them', () => {
    const source = buildInventoryCatalogSource(rawSource());
    const viewA = source.byItem.get(itemA)!;
    expect(viewA.knownSubtotal).toBe('10');
    expect(viewA.knownSubtotalComplete).toBe(false);
    expect(viewA.hasPendingTotal).toBe(true);
    expect(viewA.pendingTotalWarehouses).toHaveLength(1);
    expect(viewA.pendingTotalWarehouses[0].rows.map((row) => `${row.externalSku}=${row.onHand}`)).toEqual(['757577983013=3', 'ICEWM0026=4']);
    expect(viewA.warehouseScopes[PH].pendingTotal).toBe(true);
    expect(viewA.warehouseScopes[PH].confirmedOnHandTotal).toBeNull();
    expect(viewA.warehouseScopes[VN].confirmedOnHandTotal).toBe('10');
  });

  it('keeps real zero, gap reasons and verification flags distinct from 0/unknown', () => {
    const source = buildInventoryCatalogSource(rawSource());
    const viewB = source.byItem.get(itemB)!;
    expect(viewB.knownSubtotal).toBe('0');
    expect(viewB.knownSubtotalComplete).toBe(false);
    expect(viewB.verificationOnly).toBe(true);
    expect(viewB.unitUnconfirmed).toBe(true);
    const viewC = source.byItem.get(itemC)!;
    expect(viewC.hasCurrentData).toBe(false);
    expect(viewC.warehouseScopes[PH].inventoryState).toBe('unmapped_source');
    expect(viewC.warehouseScopes[PH].pendingSourceRowCount).toBe(1);
    expect(viewC.warehouseScopes[VN].inventoryState).toBe('no_source');
  });

  it('marks ordinary single-code warehouses current (not pending_total) and keeps coverage scoped', () => {
    const source = buildInventoryCatalogSource(rawSource());
    const viewA = source.byItem.get(itemA)!;
    expect(viewA.warehouseScopes[VN].inventoryState).toBe('current');
    expect(viewA.warehouseScopes[VN].pendingTotal).toBe(false);
    expect(viewA.warehouseScopes[VN].knownSubtotalComplete).toBe(true);
    expect(viewA.warehouseScopes[PH].inventoryState).toBe('pending_total');

    const display = clientRowAsDisplayRow(clientRow(itemA, viewA));
    const scoped = applyWarehouseScopeToDisplayRow(display, VN);
    expect(scoped.inventory.coveredWarehouseCount).toBe(1);
    expect(scoped.inventory.scopeWarehouseCount).toBe(1);
    expect(scoped.inventory.knownSubtotal).toBe('10');
    expect(scoped.inventory.knownSubtotalComplete).toBe(true);

    const viewB = source.byItem.get(itemB)!;
    expect(viewB.warehouseScopes[VN].inventoryState).toBe('current');
    expect(viewB.warehouseScopes[PH].inventoryState).toBe('unmapped_source');
    expect(viewB.warehouseScopes[PH].pendingSourceRowCount).toBe(1);
    expect(viewB.warehouseScopes[VN].knownSubtotalComplete).toBe(true);
  });

  it('keeps the old observation time when a warehouse fails and does not replace it with a newer run time', () => {
    const raw = rawSource();
    raw.latestRun = { runId: 'run-newer', exportFinishedAt: '2026-10-27T03:00:00.000Z' };
    raw.readStates = raw.readStates.map((state) => state.warehouseId === 'wh-vn'
      ? { ...state, failed: true, latestRunStatus: 'failed', lastSuccessAt: '2026-10-26T13:11:31.916Z', lastObservationAt: '2026-10-26T13:11:31.916Z' }
      : state);
    const source = buildInventoryCatalogSource(raw);
    const viewA = source.byItem.get(itemA)!;
    expect(viewA.warehouseScopes[VN].inventoryState).toBe('failed');
    expect(viewA.warehouseScopes[VN].lastObservedAt).toBe('2026-10-26T13:11:31.916Z');
    expect(viewA.lastObservedAt).toBe('2026-10-26T13:11:31.916Z');
    expect(source.observationAt).toBe('2026-10-26T13:11:31.916Z');
  });

  it('formats list cells: pending total, zero, incomplete and gap labels', () => {
    const source = buildInventoryCatalogSource(rawSource());
    const rowA = clientRow(itemA, source.byItem.get(itemA)!);
    expect(formatInventoryCell(rowA, VN)).toBe('10');
    expect(formatInventoryCell(rowA, PH)).toBe('合计待核对');
    const rowB = clientRow(itemB, source.byItem.get(itemB)!);
    expect(formatInventoryCell(rowB, VN)).toBe('0');
    expect(formatInventoryCell(rowB, PH)).toBe('来源待核对');
    const rowC = clientRow(itemC, source.byItem.get(itemC)!);
    expect(formatInventoryCell(rowC, PH)).toBe('来源待核对');
  });

  it('never multiplies old prices into a current value', () => {
    expect(formatEstimatedValueCell(undefined, undefined)).toBe('暂未计算');
    expect(formatEstimatedValueCell(undefined, undefined, 'forbidden')).toBe('—');
  });

  it('formats the source label from the export observation time, never fabricates one', () => {
    expect(formatSampleLabel(null)).toBe('BigSeller 库存');
    expect(formatSampleLabel('2026-10-26T13:11:31.916Z')).toContain('BigSeller 库存 · 最近来源 2026-10-26');
  });

  it('warehouse scope projection changes only the current warehouse numbers', () => {
    const source = buildInventoryCatalogSource(rawSource());
    const display = clientRowAsDisplayRow(clientRow(itemA, source.byItem.get(itemA)!));
    const scoped = applyWarehouseScopeToDisplayRow(display, PH);
    expect(scoped.inventory.hasPendingTotal).toBe(true);
    expect(scoped.inventory.knownSubtotal).toBeNull();
    const scopedVn = applyWarehouseScopeToDisplayRow(display, VN);
    expect(scopedVn.inventory.knownSubtotal).toBe('10');
  });

  it('client payload carries inventory views and drift tokens but not line rows', () => {
    const source = buildInventoryCatalogSource(rawSource());
    const item = catalogItem(itemA);
    const displayRows = [{
      item,
      specificationText: '—',
      adoptedUnitCost: null,
      materialStatus: '资料已承接',
      inventory: source.byItem.get(itemA)!,
      bsSample: {
        exportLabel: source.sourceLabel,
        lastObservedAt: source.observationAt,
        confirmedOnHandTotal: '10',
        confirmedLineCount: 3,
        warehouseOnHand: {},
        warehouseScopes: source.byItem.get(itemA)!.warehouseScopes,
        inventoryProjectionByWarehouse: source.byItem.get(itemA)!.inventoryProjectionByWarehouse,
        estimatedValueCny: null,
        valuationState: 'not_computed' as const,
        valuationReason: '暂未计算',
        hasCurrentData: true,
        hasPendingTotal: true,
        knownSubtotalComplete: false,
        pendingTotalWarehouses: source.byItem.get(itemA)!.pendingTotalWarehouses,
        coveredWarehouseCount: 2,
        scopeWarehouseCount: 2,
      },
    }];
    const overview: CatalogDisplayOverview = {
      basisDocumentSha256: 'basis',
      exportLabel: source.sourceLabel,
      warehouseOptions: source.warehouseOptions,
      rows: displayRows,
      warehouseCoverage: source.warehouseCoverage,
      coverage: {
        pricedItemCount: 0,
        valuedItemCount: 0,
        missingPriceIceCodes: [],
        bsConfirmedLines: source.lineCount,
        bsUnselectedLines: 0,
        inventoryLineCount: source.lineCount,
        coveredItemCount: 1,
        pendingTotalItemCount: 1,
        pendingSourceRowCount: 0,
      },
    };
    const payload = toCatalogListClientPayload(overview);
    expect(payload.rows).toHaveLength(1);
    expect(payload.rows[0].inventory).not.toHaveProperty('lines');
    expect(payload.rows[0].inventory.warehouseScopes[PH].pendingTotal).toBe(true);
    expect(payload.rows[0].inventoryProjectionByWarehouse.all).toBe(source.byItem.get(itemA)!.inventoryProjectionByWarehouse.all);
  });

  it('empty inventory view is explicit, not zero', () => {
    const empty = emptyInventoryView(null);
    expect(empty.hasCurrentData).toBe(false);
    expect(empty.knownSubtotal).toBeNull();
    expect(empty.lines).toHaveLength(0);
  });
});

function catalogItem(itemId: string): CatalogItemDto {
  return {
    itemId,
    revision: 1,
    iceCode: 'WM0026',
    codeState: 'coded',
    newProductConfirmed: false,
    nameCn: 'ICE LERSKIN双色泥膜',
    specification: { state: 'not_read', raw: null, reason: '', evidenceRef: '' } as CatalogItemDto['specification'],
    barcodeRefs: [],
    fields: {},
    humanChoices: { bigseller: 0, jushuitan: 0 },
    sourceRecordId: null,
    sourceIdentityVerified: false,
    relationshipUsable: false,
    provenanceRefs: [],
  };
}

function clientRow(itemId: string, view: ReturnType<typeof buildInventoryCatalogSource>['byItem'] extends Map<string, infer V> ? V : never): CatalogListClientRow {
  const listView: Record<string, unknown> = { ...view };
  delete listView.lines;
  return {
    itemId,
    itemRevision: 1,
    iceCode: 'WM0026',
    nameCn: 'ICE LERSKIN双色泥膜',
    newProductConfirmed: false,
    humanChoices: { bigseller: 0, jushuitan: 0 },
    specificationText: '—',
    englishName: null,
    barcodeText: null,
    unitText: null,
    categoryText: null,
    sourceSearchTokens: [],
    adoptedUnitCost: null,
    materialStatus: '资料已承接',
    inventory: listView as unknown as CatalogListClientRow['inventory'],
    inventoryProjectionByWarehouse: view.inventoryProjectionByWarehouse,
  };
}

// keep the type helper referenced for readability of fixtures
export type TestWarehouseScope = WarehouseScopeView;
