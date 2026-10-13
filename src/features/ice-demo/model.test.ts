import { describe, expect, it } from 'vitest';
import { createDemoData, DEMO_NOW, MAPPING_LABELS, MARKETS } from './fixtures';
import {
  calculateValuation, canManageMappings, canViewAmounts, changeMapping, confirmedSnapshots,
  filterLogs, filterProducts, getProductMetrics, getScenarioData, getScenarioFacts,
  isSnapshotAttributable, latestSnapshots, remainingInTransit, shipmentValuation,
} from './model';
import type { DemoData, DemoFilters, DemoMapping, DemoProduct, DemoSnapshot, LogFilters, ScenarioId } from './types';

function snapshot(data: DemoData, id = 'snap-p1-TH'): DemoSnapshot {
  const row = data.snapshots.find((entry) => entry.id === id);
  if (!row) throw new Error(`Missing fixture snapshot: ${id}`);
  return row;
}

function product(data: DemoData, id = 'p1'): DemoProduct {
  const row = data.products.find((entry) => entry.id === id);
  if (!row) throw new Error(`Missing fixture product: ${id}`);
  return row;
}

function mapping(data: DemoData, id = 'map-p1-TH'): DemoMapping {
  const row = data.mappings.find((entry) => entry.id === id);
  if (!row) throw new Error(`Missing fixture mapping: ${id}`);
  return row;
}

const PRODUCT_FILTERS: DemoFilters = { query: '', market: 'all', exception: 'all' };
const LOG_FILTERS: LogFilters = { query: '', actor: '', market: 'all', from: '', to: '' };

describe('ICE Demo fixtures and immutable observation scenarios', () => {
  it('has the five mapping states, six markets, and a leading-zero barcode as text', () => {
    const data = createDemoData();
    expect(new Set(data.mappings.map((row) => row.status))).toEqual(new Set(Object.keys(MAPPING_LABELS)));
    expect(MARKETS.map((entry) => entry.id)).toEqual(['CN', 'TH', 'PH', 'MY', 'VN', 'ID']);
    expect(product(data).barcode).toBe('0690123400001');
    expect(typeof product(data).barcode).toBe('string');
  });

  it('returns fresh arrays and records on reset without preserving local modifications', () => {
    const first = createDemoData();
    product(first).name = 'local edit';
    mapping(first).status = 'review';
    snapshot(first).current = 9999;
    first.logs.length = 0;
    const reset = createDemoData();
    expect(product(reset).name).toBe('稻萃柔润洁面');
    expect(mapping(reset).status).toBe('confirmed');
    expect(snapshot(reset).current).toBe(240);
    expect(reset.logs).toHaveLength(6);
  });

  const stages: { id: ScenarioId; current: number; transit: number; received: number; pending: number }[] = [
    { id: 'shipping', current: 240, transit: 100, received: 0, pending: 0 },
    { id: 'arrived', current: 240, transit: 0, received: 100, pending: 100 },
    { id: 'snapshot', current: 340, transit: 0, received: 100, pending: 0 },
  ];

  it.each(stages)('$id preserves the 240+100 → 240+0 → 340+0 source sequence', (stage) => {
    const data = createDemoData();
    const before = structuredClone(data);
    const facts = getScenarioFacts(stage.id);
    const derived = getScenarioData(data, stage.id);
    const shipment = derived.shipments.find((row) => row.id === 'shipment-th');
    expect(facts.current).toBe(stage.current);
    expect(facts.remainingInTransit).toBe(stage.transit);
    expect(facts.pendingReceipt).toBe(stage.pending);
    expect(snapshot(derived).current).toBe(stage.current);
    expect(shipment?.receivedQuantity).toBe(stage.received);
    expect(getProductMetrics(derived, 'p1').transit).toBe(stage.transit);
    expect(snapshot(derived, 'snap-p1-CN')).toEqual(snapshot(before, 'snap-p1-CN'));
    expect(data).toEqual(before);
  });

  it('does not add arrived goods to the old BigSeller snapshot or its valuation', () => {
    const data = createDemoData();
    const shipping = getProductMetrics(getScenarioData(data, 'shipping'), 'p1');
    const arrived = getProductMetrics(getScenarioData(data, 'arrived'), 'p1');
    expect(arrived.overseas).toBe(1020);
    expect(arrived.domestic).toBe(2400);
    expect(arrived.valuation).toEqual(shipping.valuation);
    expect(getScenarioFacts('arrived').combinedQuantity).toBeNull();
    expect(getScenarioFacts('arrived').receiptEvidence).toBeNull();
  });

  it('new full snapshot and explicit receipt evidence close the mock reconciliation', () => {
    const data = createDemoData();
    const derived = getScenarioData(data, 'snapshot');
    const facts = getScenarioFacts('snapshot');
    expect(facts.combinedQuantity).toBe(340);
    expect(facts.receiptEvidence).toContain('DEMO-RCPT-100');
    expect(facts.receiptEvidence).toContain(facts.batchId);
    expect(snapshot(derived).batchId).not.toBe(snapshot(data).batchId);
    expect(snapshot(derived).capturedAt).toBe('2026-10-13T15:00:00+08:00');
    expect(derived.snapshots.find((row) => row.id === 'snap-p1-TH-before-arrival')).toMatchObject({
      current: 240, isLatest: false, batchId: 'BS-DEMO-TH-1013-01',
    });
    expect(getProductMetrics(derived, 'p1').valuation.knownValue).toBe(65120);
  });

  it('reverse order keeps 340 stock and 100 business transit separate, never 440', () => {
    const data = getScenarioData(createDemoData(), 'reverse');
    const facts = getScenarioFacts('reverse');
    expect(snapshot(data).current).toBe(340);
    expect(getProductMetrics(data, 'p1').transit).toBe(100);
    expect(facts.feishuStatus).toBe('运输中');
    expect(facts.receiptEvidence).toBeNull();
    expect(facts.combinedQuantity).toBeNull();
    expect(facts.combinedQuantity).not.toBe(440);
    expect(facts.combinedQuantity).not.toBe(340);
  });
});

describe('physical, available, and transit are different quantities', () => {
  it('values 240 physical units, not 216 available units or another 100 source-transit units', () => {
    const data = createDemoData();
    const result = calculateValuation([snapshot(data)], data.products, data.mappings);
    expect(result.knownValue).toBe(4440);
    expect(result.totalQuantity).toBe(240);
    expect(result.valuedQuantity).toBe(240);
    expect(result.coverage).toBe(1);
    expect(snapshot(data)).toMatchObject({ current: 240, available: 216, locked: 24, sourceTransit: 100 });
  });

  it('changes to available/locked/sourceTransit do not alter physical valuation', () => {
    const data = createDemoData();
    const row = snapshot(data);
    const changed = { ...row, available: 1, locked: 239, sourceTransit: 9000 };
    expect(calculateValuation([changed], data.products, data.mappings)).toEqual(
      calculateValuation([row], data.products, data.mappings),
    );
  });

  it('current product metrics keep available separate and exclude BigSeller source-transit from business transit', () => {
    const metrics = getProductMetrics(createDemoData(), 'p1');
    expect(metrics.domestic).toBe(2400);
    expect(metrics.overseas).toBe(1020);
    expect(metrics.available).toBe(3236);
    expect(metrics.transit).toBe(100);
    expect(metrics.valuation.knownValue).toBe(63270);
  });

  it('a market with no product snapshot is unknown rather than a fabricated zero', () => {
    const metrics = getProductMetrics(createDemoData(), 'p1');
    expect(metrics.byMarket.TH).toBe(240);
    expect(metrics.byMarket.VN).toBeNull();
    expect(metrics.byMarket.ID).toBeNull();
  });

  it('unknown physical stock cannot fall back to available stock in product totals', () => {
    const data = createDemoData();
    snapshot(data).current = null;
    const metrics = getProductMetrics(data, 'p1');
    expect(metrics.byMarket.TH).toBeNull();
    expect(metrics.overseas).toBeNull();
    expect(metrics.available).toBe(3236);
    expect(metrics.valuation.unknownRows).toBe(1);
  });

  it('an explicit zero physical observation remains zero rather than unknown', () => {
    const data = createDemoData();
    snapshot(data).current = 0;
    expect(getProductMetrics(data, 'p1').byMarket.TH).toBe(0);
    expect(getProductMetrics(data, 'p1').valuation.unknownRows).toBe(0);
  });

  it.each([
    { quantity: 100, received: 0, expected: 100 },
    { quantity: 100, received: 60, expected: 40 },
    { quantity: 100, received: 100, expected: 0 },
    { quantity: 0, received: 0, expected: 0 },
  ])('computes remaining business quantity for $quantity/$received', ({ quantity, received, expected }) => {
    expect(remainingInTransit(quantity, received)).toBe(expected);
    expect(remainingInTransit(quantity, received)).toBe(expected);
  });

  it.each([
    [100, 101], [100, -1], [-1, 0], [Number.NaN, 0], [100, Number.POSITIVE_INFINITY],
  ])('rejects invalid shipment/received quantities %s/%s', (quantity, received) => {
    expect(() => remainingInTransit(quantity, received)).toThrow('到货数量');
  });

  it('partial receipt changes only business transit, not the snapshot or its batch time', () => {
    const data = createDemoData();
    const initialSnapshot = structuredClone(snapshot(data));
    const partial = {
      ...data,
      shipments: data.shipments.map((row) => row.id === 'shipment-th' ? { ...row, receivedQuantity: 60 } : row),
    };
    expect(getProductMetrics(partial, 'p1').transit).toBe(40);
    expect(snapshot(partial)).toEqual(initialSnapshot);
  });
});

describe('valuation coverage must expose missing cost and missing identity', () => {
  it('keeps known, missing-cost, and unconfirmed quantities in separate buckets', () => {
    const data = createDemoData();
    const rows = [snapshot(data), snapshot(data, 'snap-p3-TH'), snapshot(data, 'snap-extra-0')];
    const result = calculateValuation(rows, data.products, data.mappings);
    expect(result).toMatchObject({
      knownValue: 4440, totalQuantity: 804, valuedQuantity: 240,
      missingCostQuantity: 480, unmappedQuantity: 84, unknownRows: 0,
    });
    expect(result.coverage).toBeCloseTo(240 / 804);
    expect(product(data, 'p3').unitCost).toBeNull();
  });

  it('all missing-cost inventory has zero valued coverage, not a completed zero-cost valuation', () => {
    const data = createDemoData();
    const result = calculateValuation([snapshot(data, 'snap-p3-TH')], data.products, data.mappings);
    expect(result.valuedQuantity).toBe(0);
    expect(result.missingCostQuantity).toBe(480);
    expect(result.coverage).toBe(0);
  });

  it('an explicit zero unit cost is valid, unlike missing cost', () => {
    const data = createDemoData();
    const zeroCost = data.products.map((row) => row.id === 'p1' ? { ...row, unitCost: 0 } : row);
    const result = calculateValuation([snapshot(data)], zeroCost, data.mappings);
    expect(result).toMatchObject({ knownValue: 0, valuedQuantity: 240, missingCostQuantity: 0, coverage: 1 });
  });

  it.each([null, Number.NaN, Number.POSITIVE_INFINITY, -1])('does not interpret unknown/invalid physical %s as zero stock', (current) => {
    const data = createDemoData();
    const result = calculateValuation([{ ...snapshot(data), current }], data.products, data.mappings);
    expect(result.unknownRows).toBe(1);
    expect(result.valuedQuantity).toBe(0);
    expect(result.coverage).toBeNull();
  });

  it('clear zero quantity remains known, without fake 100 percent coverage for an empty denominator', () => {
    const data = createDemoData();
    const result = calculateValuation([{ ...snapshot(data), current: 0 }], data.products, data.mappings);
    expect(result.unknownRows).toBe(0);
    expect(result.totalQuantity).toBe(0);
    expect(result.coverage).toBeNull();
  });

  it('in-transit valuation retains the unpriced shipment instead of silently dropping its coverage gap', () => {
    const data = createDemoData();
    expect(shipmentValuation(data)).toMatchObject({
      knownValue: 11020, totalQuantity: 550, valuedQuantity: 350, missingCostQuantity: 200,
    });
    expect(shipmentValuation(data).coverage).toBeCloseTo(350 / 550);
    expect(shipmentValuation(getScenarioData(data, 'snapshot'))).toMatchObject({
      knownValue: 9170, totalQuantity: 450, valuedQuantity: 250, missingCostQuantity: 200,
    });
  });
});

describe('current snapshot projection and failed-batch preservation', () => {
  it('every current complete warehouse batch has one batch ID, capture time, and freshness', () => {
    const rows = latestSnapshots(createDemoData());
    const scopes = new Map<string, DemoSnapshot[]>();
    for (const row of rows) {
      const key = `${row.source}|${row.market}|${row.warehouse}`;
      scopes.set(key, [...(scopes.get(key) ?? []), row]);
    }
    expect(scopes.size).toBe(6);
    for (const [scope, currentRows] of scopes) {
      expect(new Set(currentRows.map((row) => row.batchId)).size, scope).toBe(1);
      expect(new Set(currentRows.map((row) => row.capturedAt)).size, scope).toBe(1);
      expect(new Set(currentRows.map((row) => row.freshness)).size, scope).toBe(1);
    }
    expect(rows.filter((row) => row.market === 'ID').every((row) => row.batchId === 'BS-DEMO-ID-1010-01')).toBe(true);
  });

  it.each(['snapshot', 'reverse'] as const)('%s publishes the complete Thai scope, not one SKU stitched into an older batch', (scenario) => {
    const data = createDemoData();
    const originalThaiRows = latestSnapshots(data, 'TH');
    const derived = getScenarioData(data, scenario);
    const nextThaiRows = latestSnapshots(derived, 'TH');
    expect(originalThaiRows).toHaveLength(3);
    expect(nextThaiRows).toHaveLength(originalThaiRows.length);
    expect(new Set(nextThaiRows.map((row) => row.batchId))).toEqual(new Set(['BS-DEMO-TH-1013-02']));
    expect(new Set(nextThaiRows.map((row) => row.capturedAt))).toEqual(new Set(['2026-10-13T15:00:00+08:00']));
    for (const original of originalThaiRows) {
      const retained = derived.snapshots.find((row) => row.id === `${original.id}-before-arrival`);
      expect(retained).toEqual({ ...original, id: `${original.id}-before-arrival`, isLatest: false });
      if (original.id !== 'snap-p1-TH') {
        const current = nextThaiRows.find((row) => row.id === original.id);
        expect(current).toMatchObject({ current: original.current, available: original.available, locked: original.locked });
      }
    }
    expect(derived.snapshots.filter((row) => row.market !== 'TH')).toEqual(data.snapshots.filter((row) => row.market !== 'TH'));
    expect(derived.snapshots.filter((row) => row.id.endsWith('-history'))).toEqual(data.snapshots.filter((row) => row.id.endsWith('-history')));
  });

  it('excludes historical observations, so a new complete batch is not added to the old batch', () => {
    const data = getScenarioData(createDemoData(), 'snapshot');
    const p1ThaiRows = latestSnapshots(data, 'TH').filter((row) => row.resolvedProductId === 'p1');
    expect(p1ThaiRows).toHaveLength(1);
    expect(p1ThaiRows[0]).toMatchObject({ current: 340, batchId: 'BS-DEMO-TH-1013-02' });
    expect(confirmedSnapshots(data, 'p1', 'TH')).toEqual(p1ThaiRows);
  });

  it('keeps the old complete snapshot and time when a newer failed observation is present', () => {
    const data = createDemoData();
    const previous = snapshot(data, 'snap-p5-ID');
    const failed: DemoSnapshot = {
      ...previous, id: 'failed-later', batchId: 'BS-DEMO-ID-1013-FAILED',
      current: null, available: null, completeness: 'failed', capturedAt: DEMO_NOW, isLatest: true,
    };
    const before = structuredClone(data);
    const withFailure = { ...data, snapshots: [...data.snapshots, failed] };
    const current = latestSnapshots(withFailure, 'ID').filter((row) => row.resolvedProductId === 'p5');
    expect(current).toEqual([previous]);
    expect(current[0]).toMatchObject({ current: 260, capturedAt: '2026-10-10T09:00:00+08:00', freshness: 'stale' });
    expect(getProductMetrics(withFailure, 'p5')).toEqual(getProductMetrics(data, 'p5'));
    expect(data).toEqual(before);
  });

  it('first failed observation does not create a published zero-stock row', () => {
    const data = createDemoData();
    const failed = { ...snapshot(data), current: null, completeness: 'failed' as const };
    expect(latestSnapshots({ ...data, snapshots: [failed] })).toEqual([]);
    expect(calculateValuation([failed], data.products, data.mappings).coverage).toBeNull();
  });

  it('filters a specific market before current inventory aggregation', () => {
    const data = createDemoData();
    expect(latestSnapshots(data, 'CN')).toHaveLength(6);
    expect(latestSnapshots(data, 'CN').every((row) => row.market === 'CN' && row.source === '聚水潭')).toBe(true);
    expect(latestSnapshots(data, 'TH').every((row) => row.market === 'TH' && row.source === 'BigSeller')).toBe(true);
  });

  it.each(['unmatched', 'pending', 'review', 'disabled'] as const)('a current %s mapping blocks automatic attribution despite an old confirmed snapshot', (status) => {
    const data = createDemoData();
    mapping(data).status = status;
    expect(snapshot(data).mappingStatus).toBe('confirmed');
    expect(isSnapshotAttributable(snapshot(data), data.mappings)).toBe(false);
    expect(confirmedSnapshots(data, 'p1', 'TH')).toEqual([]);
    expect(calculateValuation([snapshot(data)], data.products, data.mappings).unmappedQuantity).toBe(240);
  });

  it('refuses missing, changed-product, or old-version mapping evidence', () => {
    const data = createDemoData();
    const row = snapshot(data);
    expect(isSnapshotAttributable(row, [])).toBe(false);
    expect(isSnapshotAttributable(row, [{ ...mapping(data), productId: 'p2' }])).toBe(false);
    expect(isSnapshotAttributable(row, [{ ...mapping(data), version: 2 }])).toBe(false);
    expect(isSnapshotAttributable({ ...row, resolvedProductId: null }, data.mappings)).toBe(false);
    expect(isSnapshotAttributable({ ...row, mappingStatus: 'pending' }, data.mappings)).toBe(false);
  });
});

describe('product search, exception filters, and log traceability', () => {
  it.each(['ICE-1001', '0690123400001', ' th-demo-01 ', 'rice gentle'])('finds one product using %s', (query) => {
    expect(filterProducts(createDemoData(), { ...PRODUCT_FILTERS, query }).map((row) => row.id)).toEqual(['p1']);
  });

  it('searches candidate SKUs without falsely aggregating their unconfirmed stock', () => {
    const data = createDemoData();
    expect(filterProducts(data, { ...PRODUCT_FILTERS, query: 'PH-GLOW-NEW' }).map((row) => row.id)).toEqual(['p2']);
    expect(confirmedSnapshots(data, 'p2').some((row) => row.externalSku === 'PH-GLOW-NEW')).toBe(false);
  });

  it('supports empty-result recovery and combines market with the text query', () => {
    const data = createDemoData();
    expect(filterProducts(data, { ...PRODUCT_FILTERS, query: 'not-a-demo-product' })).toEqual([]);
    expect(filterProducts(data, { ...PRODUCT_FILTERS, query: 'ICE-1001', market: 'VN' })).toEqual([]);
    expect(filterProducts(data, PRODUCT_FILTERS)).toEqual(data.products);
  });

  it.each([
    { exception: 'cost' as const, ids: ['p3'] },
    { exception: 'mapping' as const, ids: ['p2', 'p3', 'p4', 'p5'] },
    { exception: 'stale' as const, ids: ['p2', 'p5', 'p6'] },
    { exception: 'low' as const, ids: ['p2', 'p5'] },
  ])('returns the actual $exception exceptions', ({ exception, ids }) => {
    expect(filterProducts(createDemoData(), { ...PRODUCT_FILTERS, exception }).map((row) => row.id)).toEqual(ids);
  });

  it('market filtering does not borrow another market’s stale or pending-mapping exception', () => {
    const data = createDemoData();
    expect(filterProducts(data, { ...PRODUCT_FILTERS, market: 'VN', exception: 'stale' })).toEqual([]);
    expect(filterProducts(data, { ...PRODUCT_FILTERS, market: 'TH', exception: 'mapping' })).toEqual([]);
    expect(filterProducts(data, { ...PRODUCT_FILTERS, market: 'PH', exception: 'mapping' }).map((row) => row.id)).toEqual(['p2']);
  });

  it.each(['DEMO-TH-1013', '0690123400001', 'TH-DEMO-01', 'BS-DEMO-TH-1013-01'])('log search traces %s', (query) => {
    const rows = filterLogs(createDemoData().logs, { ...LOG_FILTERS, query });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.productCode === 'ICE-1001')).toBe(true);
  });

  it('log filters combine actor, market, and inclusive date range without mutating log order', () => {
    const data = createDemoData();
    const before = structuredClone(data.logs);
    const result = filterLogs(data.logs, {
      ...LOG_FILTERS, actor: '陈安 · 演示管理员', market: 'VN', from: '2026-10-12', to: '2026-10-12',
    });
    expect(result.map((row) => row.id)).toEqual(['log-5']);
    expect(filterLogs(data.logs, { ...LOG_FILTERS, from: '2026-10-14' })).toEqual([]);
    expect(data.logs).toEqual(before);
  });
});

describe('local mapping actions and role demonstrations, not real security', () => {
  it.each([
    { role: 'admin' as const, amount: true, manage: true },
    { role: 'manager' as const, amount: true, manage: false },
    { role: 'operator' as const, amount: false, manage: false },
  ])('$role has the explicit demo capabilities', ({ role, amount, manage }) => {
    expect(canViewAmounts(role)).toBe(amount);
    expect(canManageMappings(role)).toBe(manage);
  });

  it.each(['manager', 'operator'] as const)('%s cannot confirm or recheck mappings or create a success log', (role) => {
    const data = createDemoData();
    const before = structuredClone(data);
    for (const action of ['confirm', 'review'] as const) {
      const result = changeMapping(data, 'map-pending', action, role);
      expect(result.error).toContain('不能确认');
      expect(result.data).toBe(data);
      expect(result.data.logs).toHaveLength(6);
    }
    expect(data).toEqual(before);
  });

  it('confirms an explicit candidate, increments the mapping version, and appends a traceable local log only', () => {
    const data = createDemoData();
    const before = structuredClone(data);
    const result = changeMapping(data, 'map-pending', 'confirm', 'admin');
    expect(result.error).toBeNull();
    expect(mapping(result.data, 'map-pending')).toMatchObject({ productId: 'p2', status: 'confirmed', version: 2 });
    expect(result.data.snapshots).toEqual(before.snapshots);
    expect(result.data.shipments).toEqual(before.shipments);
    expect(result.data.logs).toHaveLength(before.logs.length + 1);
    expect(result.data.logs[0]).toMatchObject({
      at: DEMO_NOW, action: '确认商品映射', source: '本地演示', market: 'PH',
      productCode: 'ICE-1002', externalSku: 'PH-GLOW-NEW', session: true,
    });
    expect(result.data.logs[0].detail).toContain('v1 → v2');
    expect(result.data.logs.slice(1)).toEqual(before.logs);
    expect(confirmedSnapshots(result.data, 'p2').some((row) => row.mappingId === 'map-pending')).toBe(false);
    expect(data).toEqual(before);
  });

  it('recheck removes current automatic attribution but preserves the captured snapshot identity', () => {
    const data = createDemoData();
    const original = structuredClone(snapshot(data));
    const result = changeMapping(data, 'map-p1-TH', 'review', 'admin');
    expect(result.error).toBeNull();
    expect(mapping(result.data)).toMatchObject({ status: 'review', version: 2 });
    expect(snapshot(result.data)).toEqual(original);
    expect(confirmedSnapshots(result.data, 'p1', 'TH')).toEqual([]);
    expect(calculateValuation([snapshot(result.data)], result.data.products, result.data.mappings)).toMatchObject({
      knownValue: 0, valuedQuantity: 0, unmappedQuantity: 240, coverage: 0,
    });
    expect(result.data.logs[0]).toMatchObject({ action: '映射重新核对', productCode: 'ICE-1001', session: true });
  });

  it('reconfirming a revised mapping does not rewrite an older captured mapping version', () => {
    const data = createDemoData();
    const reviewed = changeMapping(data, 'map-p1-TH', 'review', 'admin').data;
    const reconfirmed = changeMapping(reviewed, 'map-p1-TH', 'confirm', 'admin');
    expect(reconfirmed.error).toBeNull();
    expect(mapping(reconfirmed.data)).toMatchObject({ status: 'confirmed', version: 3 });
    expect(snapshot(reconfirmed.data).mappingVersion).toBe(1);
    expect(confirmedSnapshots(reconfirmed.data, 'p1', 'TH')).toEqual([]);
    expect(reconfirmed.data.logs).toHaveLength(8);
    expect(new Set(reconfirmed.data.logs.map((row) => row.id)).size).toBe(8);
  });

  it.each([
    { id: 'missing', action: 'confirm' as const, error: '不存在' },
    { id: 'map-disabled', action: 'confirm' as const, error: '停用' },
    { id: 'map-p1-TH', action: 'confirm' as const, error: '已经确认' },
    { id: 'map-pending', action: 'review' as const, error: '只有已确认' },
  ])('rejects $action for $id without mutations or success logs', ({ id, action, error }) => {
    const data = createDemoData();
    const before = structuredClone(data);
    const result = changeMapping(data, id, action, 'admin');
    expect(result.error).toContain(error);
    expect(result.data).toBe(data);
    expect(data).toEqual(before);
  });

  it('does not confirm a source mapping when no explicit product candidate exists', () => {
    const data = createDemoData();
    const row = mapping(data, 'map-unmatched');
    row.candidateProductId = null;
    const before = structuredClone(data);
    const result = changeMapping(data, row.id, 'confirm', 'admin');
    expect(result.error).toContain('缺少明确商品候选');
    expect(result.data).toEqual(before);
  });
});
