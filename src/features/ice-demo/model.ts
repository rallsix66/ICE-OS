import { DEMO_NOW } from './fixtures';
import type { DemoData, DemoFilters, DemoLog, DemoMapping, DemoProduct, DemoRole, DemoSnapshot, LogFilters, Market, ScenarioFacts, ScenarioId, Valuation } from './types';

export function getScenarioFacts(id: ScenarioId): ScenarioFacts {
  const base = {
    id, current: 240, available: 216, locked: 24, sourceTransit: 100, remainingInTransit: 100,
    pendingReceipt: 0, feishuStatus: '运输中', receiptEvidence: null,
    capturedAt: '2026-10-13T09:00:00+08:00', batchId: 'BS-DEMO-TH-1013-01',
  };
  if (id === 'arrived') return { ...base, label: '飞书到货', description: '飞书确认100件到货，仅结束在途；海外仍显示上一份240件快照。', remainingInTransit: 0, pendingReceipt: 100, feishuStatus: '已到货上架', combinedQuantity: null };
  if (id === 'snapshot') return { ...base, label: '新快照核对', description: '完整新批次记录340件。收货单 DEMO-RCPT-100 已关联此票与该批次，不凭库存增量推断。', current: 340, available: 310, locked: 30, sourceTransit: 0, remainingInTransit: 0, feishuStatus: '已到货上架', receiptEvidence: 'DEMO-RCPT-100 → DEMO-TH-1013 → BS-DEMO-TH-1013-02', combinedQuantity: 340, capturedAt: '2026-10-13T15:00:00+08:00', batchId: 'BS-DEMO-TH-1013-02' };
  if (id === 'reverse') return { ...base, label: '库存先到', description: '快照340件、飞书仍有100件在途；收货证据缺失，两个来源不能直接合计。', current: 340, available: 310, locked: 30, combinedQuantity: null, capturedAt: '2026-10-13T15:00:00+08:00', batchId: 'BS-DEMO-TH-1013-02' };
  return { ...base, label: '运输中', description: '旧海外快照240件与本票100件在途分开显示；国内数据未对齐，不提供跨阶段总货值。', combinedQuantity: null };
}

/** A scenario switches observation fixtures, never executes a stock adjustment. */
export function getScenarioData(data: DemoData, scenario: ScenarioId): DemoData {
  const facts = getScenarioFacts(scenario);
  const newBatch = scenario === 'snapshot' || scenario === 'reverse';
  const snapshots = data.snapshots.map((row) => {
    if (!row.isLatest || row.market !== 'TH') return row;
    const batch = { ...row, capturedAt: facts.capturedAt, batchId: facts.batchId };
    return row.id === 'snap-p1-TH' ? { ...batch, current: facts.current, available: facts.available, locked: facts.locked, sourceTransit: facts.sourceTransit } : batch;
  });
  if (newBatch) snapshots.push(...data.snapshots.filter((row) => row.isLatest && row.market === 'TH').map((row) => ({ ...row, id: `${row.id}-before-arrival`, isLatest: false })));
  return {
    ...data, snapshots,
    shipments: data.shipments.map((row) => row.id === 'shipment-th' ? { ...row, receivedQuantity: row.quantity - facts.remainingInTransit, feishuStatus: facts.feishuStatus } : row),
  };
}

export function latestSnapshots(data: DemoData, market: Market | 'all' = 'all'): DemoSnapshot[] {
  return data.snapshots.filter((row) => row.isLatest && row.completeness === 'complete' && (market === 'all' || row.market === market));
}

export function confirmedSnapshots(data: DemoData, productId?: string, market: Market | 'all' = 'all'): DemoSnapshot[] {
  return latestSnapshots(data, market).filter((row) => isSnapshotAttributable(row, data.mappings) && (!productId || row.resolvedProductId === productId));
}

export function isSnapshotAttributable(row: DemoSnapshot, mappings: DemoMapping[]): boolean {
  const mapping = mappings.find((entry) => entry.id === row.mappingId);
  return row.mappingStatus === 'confirmed' && row.resolvedProductId !== null && !!mapping && mapping.status === 'confirmed' && mapping.version === row.mappingVersion && mapping.productId === row.resolvedProductId;
}

export function remainingInTransit(quantity: number, receivedQuantity: number): number {
  if (!Number.isFinite(quantity) || !Number.isFinite(receivedQuantity) || quantity < 0 || receivedQuantity < 0 || receivedQuantity > quantity) throw new Error('到货数量必须在0与发货数量之间');
  return quantity - receivedQuantity;
}

export function calculateValuation(rows: DemoSnapshot[], products: DemoProduct[], mappings?: DemoMapping[]): Valuation {
  const result: Valuation = { knownValue: 0, totalQuantity: 0, valuedQuantity: 0, missingCostQuantity: 0, unmappedQuantity: 0, unknownRows: 0, coverage: null };
  for (const row of rows) {
    if (row.completeness !== 'complete') continue;
    if (row.current === null || !Number.isFinite(row.current) || row.current < 0) { result.unknownRows += 1; continue; }
    result.totalQuantity += row.current;
    const product = products.find((entry) => entry.id === row.resolvedProductId);
    if (row.mappingStatus !== 'confirmed' || !product || (mappings && !isSnapshotAttributable(row, mappings))) { result.unmappedQuantity += row.current; continue; }
    if (product.unitCost === null || !Number.isFinite(product.unitCost) || product.unitCost < 0) { result.missingCostQuantity += row.current; continue; }
    result.knownValue += row.current * product.unitCost;
    result.valuedQuantity += row.current;
  }
  result.knownValue = Math.round(result.knownValue * 100) / 100;
  result.coverage = result.totalQuantity === 0 ? null : result.valuedQuantity / result.totalQuantity;
  return result;
}

export function shipmentValuation(data: DemoData): Valuation {
  const rows = data.shipments.map((shipment): DemoSnapshot => ({
    id: shipment.id, mappingId: '', resolvedProductId: shipment.productId, mappingStatus: 'confirmed', mappingVersion: 1,
    source: 'BigSeller', market: shipment.market, warehouse: shipment.warehouse, externalSku: '',
    current: remainingInTransit(shipment.quantity, shipment.receivedQuantity), available: null, locked: null,
    sourceTransit: null, batchId: '', capturedAt: DEMO_NOW, isLatest: true, freshness: 'fresh', completeness: 'complete',
  }));
  return calculateValuation(rows, data.products);
}

export function getProductMetrics(data: DemoData, productId: string) {
  const rows = confirmedSnapshots(data, productId);
  const sum = (selectedRows: DemoSnapshot[], field: 'current' | 'available'): number | null => selectedRows.length === 0 || selectedRows.some((row) => row[field] === null) ? null : selectedRows.reduce((total, row) => total + (row[field] ?? 0), 0);
  return {
    domestic: sum(rows.filter((row) => row.market === 'CN'), 'current'), overseas: sum(rows.filter((row) => row.market !== 'CN'), 'current'),
    available: sum(rows, 'available'),
    transit: data.shipments.filter((row) => row.productId === productId).reduce((total, row) => total + remainingInTransit(row.quantity, row.receivedQuantity), 0),
    byMarket: Object.fromEntries((['CN', 'TH', 'PH', 'MY', 'VN', 'ID'] as const).map((market) => [market, sum(rows.filter((row) => row.market === market), 'current')])) as Record<Market, number | null>,
    valuation: calculateValuation(rows, data.products, data.mappings),
  };
}

export function filterProducts(data: DemoData, filters: DemoFilters): DemoProduct[] {
  const query = filters.query.trim().toLocaleLowerCase();
  return data.products.filter((product) => {
    const mappings = data.mappings.filter((row) => row.productId === product.id || row.candidateProductId === product.id);
    const rows = confirmedSnapshots(data, product.id, filters.market);
    const searchable = [product.code, product.barcode, product.name, product.englishName, ...mappings.map((row) => row.externalSku)].join(' ').toLocaleLowerCase();
    if (query && !searchable.includes(query)) return false;
    if (filters.market !== 'all' && !mappings.some((row) => row.market === filters.market)) return false;
    if (filters.exception === 'cost' && product.unitCost !== null) return false;
    if (filters.exception === 'mapping' && !mappings.some((row) => (filters.market === 'all' || row.market === filters.market) && (row.status !== 'confirmed' || latestSnapshots(data).some((snapshot) => snapshot.mappingId === row.id && !isSnapshotAttributable(snapshot, data.mappings))))) return false;
    if (filters.exception === 'stale' && !rows.some((row) => row.freshness === 'stale')) return false;
    if (filters.exception === 'low' && !rows.some((row) => row.market !== 'CN' && row.available !== null && row.available < 100)) return false;
    return true;
  });
}

export function filterLogs(logs: DemoLog[], filters: LogFilters): DemoLog[] {
  const query = filters.query.trim().toLocaleLowerCase();
  return logs.filter((entry) => {
    const day = entry.at.slice(0, 10);
    if (filters.market !== 'all' && entry.market !== filters.market) return false;
    if (filters.actor && entry.actor !== filters.actor) return false;
    if (filters.from && day < filters.from) return false;
    if (filters.to && day > filters.to) return false;
    return !query || [entry.actor, entry.at, entry.action, entry.productCode, entry.barcode, entry.externalSku, entry.shipment, entry.batchId, entry.detail].join(' ').toLocaleLowerCase().includes(query);
  }).sort((a, b) => b.at.localeCompare(a.at));
}

export function canViewAmounts(role: DemoRole): boolean { return role !== 'operator'; }
export function canManageMappings(role: DemoRole): boolean { return role === 'admin'; }

/** Local demo authorization only. Never claim this is a server security boundary. */
export function changeMapping(data: DemoData, mappingId: string, action: 'confirm' | 'review', role: DemoRole): { data: DemoData; error: string | null } {
  if (!canManageMappings(role)) return { data, error: '此演示角色不能确认或重新核对映射，请切换管理员视角。' };
  const mapping = data.mappings.find((row) => row.id === mappingId);
  if (!mapping) return { data, error: '映射记录不存在。' };
  if (mapping.status === 'disabled') return { data, error: '停用映射不能在此演示中重新启用。' };
  if (action === 'review' && mapping.status !== 'confirmed') return { data, error: '只有已确认映射可以标记重新核对。' };
  if (action === 'confirm' && mapping.status === 'confirmed') return { data, error: '此映射已经确认，无需重复操作。' };
  const product = data.products.find((entry) => entry.id === (mapping.productId ?? mapping.candidateProductId));
  if (!product) return { data, error: '缺少明确商品候选，不能确认。' };
  const nextVersion = mapping.version + 1;
  const log: DemoLog = {
    id: `session-map-${data.logs.length + 1}`, at: DEMO_NOW, actor: '陈安 · 演示管理员', action: action === 'confirm' ? '确认商品映射' : '映射重新核对',
    source: '本地演示', market: mapping.market, productCode: product.code, barcode: product.barcode,
    externalSku: mapping.externalSku, shipment: '', batchId: '',
    detail: `映射 v${mapping.version} → v${nextVersion}；历史快照不改写，旧版本暂不参与当前商品归集，等待新快照。`, session: true,
  };
  return {
    data: { ...data, mappings: data.mappings.map((row) => row.id === mappingId ? { ...row, productId: product.id, status: action === 'confirm' ? 'confirmed' : 'review', version: nextVersion } : row), logs: [log, ...data.logs] },
    error: null,
  };
}
