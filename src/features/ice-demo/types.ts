export type Market = 'CN' | 'TH' | 'PH' | 'MY' | 'VN' | 'ID';
export type DemoRole = 'admin' | 'manager' | 'operator';
export type DemoView = 'overview' | 'inventory' | 'products' | 'logistics' | 'snapshots' | 'logs';
export type MappingStatus = 'unmatched' | 'pending' | 'confirmed' | 'review' | 'disabled';
export type ScenarioId = 'shipping' | 'arrived' | 'snapshot' | 'reverse';
export type InventorySource = '聚水潭' | 'BigSeller';

export interface DemoProduct {
  id: string;
  code: string;
  barcode: string;
  name: string;
  foreignName: string;
  englishName: string;
  specification: string;
  unit: string;
  category: string;
  color: string;
  unitCost: number | null;
  costVersion: string;
}

export interface DemoMapping {
  id: string;
  productId: string | null;
  candidateProductId: string | null;
  variantId: string;
  source: InventorySource;
  account: string;
  market: Market;
  warehouse: string;
  externalSku: string;
  status: MappingStatus;
  version: number;
}

/** Captured identity is immutable: today's mapping edits never rewrite history. */
export interface DemoSnapshot {
  id: string;
  mappingId: string;
  resolvedProductId: string | null;
  mappingStatus: MappingStatus;
  mappingVersion: number;
  source: InventorySource;
  market: Market;
  warehouse: string;
  externalSku: string;
  current: number | null;
  available: number | null;
  locked: number | null;
  sourceTransit: number | null;
  batchId: string;
  capturedAt: string;
  isLatest: boolean;
  freshness: 'fresh' | 'stale';
  completeness: 'complete' | 'failed';
}

export interface DemoShipment {
  id: string;
  number: string;
  productId: string;
  market: Market;
  warehouse: string;
  quantity: number;
  receivedQuantity: number;
  feishuStatus: string;
  waybill: string;
  account: string;
  binding: 'confirmed' | 'pending';
  eta: string;
  note: string;
}

export interface DemoLog {
  id: string;
  at: string;
  actor: string;
  action: string;
  source: string;
  market: Market;
  productCode: string;
  barcode: string;
  externalSku: string;
  shipment: string;
  batchId: string;
  detail: string;
  session: boolean;
}

export interface DemoData {
  products: DemoProduct[];
  mappings: DemoMapping[];
  snapshots: DemoSnapshot[];
  shipments: DemoShipment[];
  logs: DemoLog[];
}

export interface DemoFilters {
  query: string;
  market: Market | 'all';
  exception: 'all' | 'mapping' | 'cost' | 'stale' | 'low';
}

export interface LogFilters {
  query: string;
  actor: string;
  market: Market | 'all';
  from: string;
  to: string;
}

export interface Valuation {
  knownValue: number;
  totalQuantity: number;
  valuedQuantity: number;
  missingCostQuantity: number;
  unmappedQuantity: number;
  unknownRows: number;
  coverage: number | null;
}

export interface ScenarioFacts {
  id: ScenarioId;
  label: string;
  description: string;
  current: number;
  available: number;
  locked: number;
  sourceTransit: number;
  remainingInTransit: number;
  pendingReceipt: number;
  feishuStatus: string;
  receiptEvidence: string | null;
  combinedQuantity: number | null;
  capturedAt: string;
  batchId: string;
}
