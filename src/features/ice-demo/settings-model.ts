import { MARKETS } from './fixtures';
import { remainingInTransit } from './model';
import type { DemoAccess, DemoData, DemoPermissions, DemoRole, DemoShipment, DemoSourceConfig, ShipmentFilters } from './types';

export const ROLE_LABELS: Record<DemoRole, string> = { admin: '管理员', manager: '负责人', operator: '运营' };

export function createDemoPermissions(): DemoPermissions {
  return {
    admin: { markets: MARKETS.map((entry) => entry.id), viewAmounts: true, manageMappings: true },
    manager: { markets: ['TH', 'PH', 'MY'], viewAmounts: true, manageMappings: false },
    operator: { markets: ['TH'], viewAmounts: false, manageMappings: false },
  };
}

/** Demonstration projection only: all fixtures remain public browser data. */
export function scopeDemoData(data: DemoData, role: DemoRole, access: DemoAccess): DemoData {
  const allowed = new Set(access.markets);
  const mappings = data.mappings.filter((row) => allowed.has(row.market));
  const shipments = data.shipments.filter((row) => allowed.has(row.market));
  const productIds = new Set([
    ...mappings.flatMap((row) => [row.productId, row.candidateProductId]),
    ...shipments.map((row) => row.productId),
  ]);
  return {
    products: role === 'admin' ? data.products : data.products.filter((row) => productIds.has(row.id)),
    mappings,
    snapshots: data.snapshots.filter((row) => allowed.has(row.market)),
    shipments,
    logs: data.logs.filter((row) => allowed.has(row.market)),
  };
}

export function saveDemoAccess(permissions: DemoPermissions, target: DemoRole, next: DemoAccess, actor: DemoRole) {
  if (actor !== 'admin') return { permissions, error: '只有管理员可保存演示权限。' };
  if (next.markets.some((market) => !MARKETS.some((entry) => entry.id === market))) return { permissions, error: '市场参数无效。' };
  if (target === 'admin' && MARKETS.some((entry) => !next.markets.includes(entry.id))) return { permissions, error: '管理员保留完整市场和权限配置入口。' };
  if (target !== 'admin' && next.manageMappings) return { permissions, error: '负责人和运营不能获得商品映射确认权。' };
  return { permissions: { ...permissions, [target]: { ...next, markets: [...new Set(next.markets)] } }, error: null };
}

export function filterShipments(data: DemoData, filters: ShipmentFilters) {
  const query = filters.query.trim().toLocaleLowerCase();
  return data.shipments.filter((row) => {
    if (filters.market !== 'all' && row.market !== filters.market) return false;
    const remaining = remainingInTransit(row.quantity, row.receivedQuantity);
    if (filters.status === 'active' && remaining === 0) return false;
    if (filters.status === 'completed' && remaining !== 0) return false;
    if (filters.status === 'pending' && row.binding !== 'pending') return false;
    if (filters.status === 'soon' && (remaining === 0 || row.eta < '2026-10-13' || row.eta > '2026-10-19')) return false;
    const product = data.products.find((entry) => entry.id === row.productId);
    const skus = data.mappings.filter((entry) => entry.market === row.market && entry.productId === row.productId).map((entry) => entry.externalSku);
    return !query || [row.number, row.waybill, row.note, product?.code, product?.barcode, product?.name, ...skus].join(' ').toLocaleLowerCase().includes(query);
  }).sort((a, b) => a.eta.localeCompare(b.eta) || a.number.localeCompare(b.number));
}

export function createSourceConfigs(): DemoSourceConfig[] {
  return (['bigseller', 'jushuitan', 'feishu', 'golucky'] as const).map((id) => ({ id, enabled: true, cadence: 'manual', lastCheck: 'none' }));
}

export function latestTrackingEvent(shipment: DemoShipment) {
  if (shipment.binding !== 'confirmed') return undefined;
  return [...(shipment.trackingEvents ?? [])].sort((a, b) => a.at.localeCompare(b.at)).at(-1);
}

export function updateSourceConfig(configs: DemoSourceConfig[], next: DemoSourceConfig, role: DemoRole) {
  if (role !== 'admin') return { configs, error: '只有管理员可调整或检查演示来源。' };
  if (!configs.some((entry) => entry.id === next.id) || !['manual', 'hourly', 'daily'].includes(next.cadence)) return { configs, error: '来源或读取频率无效。' };
  return { configs: configs.map((entry) => entry.id === next.id ? { ...next } : entry), error: null };
}
