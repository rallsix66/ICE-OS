import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OverviewView } from './inventory-views';
import { createDemoData } from './fixtures';
import { canManageMappings, canViewAmounts, changeMapping, getOverviewInventory, getScenarioData } from './model';
import { createDemoPermissions, createSourceConfigs, filterShipments, latestTrackingEvent, saveDemoAccess, scopeDemoData, updateSourceConfig } from './settings-model';
import type { ShipmentFilters } from './types';

const ALL: ShipmentFilters = { market: 'all', status: 'all', query: '' };

describe('market-first logistics', () => {
  it('keeps carrier signature separate from the Feishu state and stock', () => {
    const data = createDemoData(); const shipment = data.shipments[0];
    expect(latestTrackingEvent(shipment)?.text).toBe('承运商已签收');
    expect(shipment.feishuStatus).toBe('运输中');
    expect(shipment.receivedQuantity).toBe(0);
    expect(data.snapshots.find((row) => row.id === 'snap-p1-TH')?.current).toBe(240);
    expect(latestTrackingEvent(data.shipments.find((row) => row.id === 'shipment-vn')!)).toBeUndefined();
  });
  it('shows all three Thai shipments together, including partial and completed ones', () => {
    expect(filterShipments(createDemoData(), { ...ALL, market: 'TH' }).map((row) => row.id)).toEqual(['shipment-th-done', 'shipment-th', 'shipment-th-partial']);
  });
  it('intersects status and market without falling back to another market', () => {
    expect(filterShipments(createDemoData(), { ...ALL, market: 'TH', status: 'active' }).map((row) => row.id)).toEqual(['shipment-th', 'shipment-th-partial']);
    expect(filterShipments(createDemoData(), { ...ALL, market: 'TH', status: 'pending' })).toEqual([]);
    expect(filterShipments(createDemoData(), { ...ALL, market: 'VN', status: 'pending' }).map((row) => row.id)).toEqual(['shipment-vn']);
  });
  it('keeps completed history separate and excludes it from upcoming shipments', () => {
    const data = createDemoData();
    expect(filterShipments(data, { ...ALL, status: 'completed' })).toHaveLength(2);
    expect(filterShipments(data, { ...ALL, status: 'soon' }).map((row) => row.id)).toEqual(['shipment-th', 'shipment-vn', 'shipment-th-partial', 'shipment-ph']);
  });
  it.each(['DEMO-TH-1016', 'DEMO-XYD-TH-004', 'TH-DEMO-02', '6901234000022', '水光保湿精华', '剩余40瓶'])('searches %s within the chosen market', (query) => {
    expect(filterShipments(createDemoData(), { ...ALL, market: 'TH', query }).map((row) => row.id)).toEqual(['shipment-th-partial']);
  });
  it('keeps source fixtures unchanged while sorting/filtering', () => {
    const data = createDemoData(); const before = structuredClone(data);
    filterShipments(data, { ...ALL, market: 'MY', query: 'not-found' });
    expect(data).toEqual(before);
  });
  it('reclassifies the sample shipment when the observed Feishu scenario changes', () => {
    const data = getScenarioData(createDemoData(), 'arrived');
    expect(filterShipments(data, { ...ALL, market: 'TH', status: 'completed' })).toHaveLength(2);
    expect(filterShipments(data, { ...ALL, market: 'TH', status: 'active' })).toHaveLength(1);
  });
});

describe('local permission settings actually affect the demonstration', () => {
  it('does not render a pending-only product as zero-value stock on the homepage', () => {
    const p = createDemoPermissions();
    const scoped = scopeDemoData(createDemoData(), 'operator', { ...p.operator, markets: ['PH'] });
    const html = renderToStaticMarkup(createElement(OverviewView, { data: { ...scoped, products: scoped.products.filter((row) => row.id === 'p2') }, showAmounts: true, onBrowse: () => {}, onNavigate: () => {}, onOpenProduct: () => {} }));
    const body = html.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1];
    expect(body).toBeDefined();
    expect(body).not.toContain('¥0');
    expect(body).toContain('—');
  });
  it('projects all five record families to the operator market', () => {
    const p = createDemoPermissions(); const scoped = scopeDemoData(createDemoData(), 'operator', p.operator);
    expect(scoped.shipments).toHaveLength(3);
    expect(scoped.mappings.every((row) => row.market === 'TH')).toBe(true);
    expect(scoped.snapshots.every((row) => row.market === 'TH')).toBe(true);
    expect(scoped.logs.every((row) => row.market === 'TH')).toBe(true);
    expect(scoped.products.map((row) => row.id)).toEqual(['p1', 'p2', 'p3']);
  });
  it('allows an administrator to change markets and amounts independently', () => {
    const p = createDemoPermissions();
    const result = saveDemoAccess(p, 'operator', { markets: ['PH'], viewAmounts: true, manageMappings: false }, 'admin');
    expect(result.error).toBeNull();
    expect(canViewAmounts('operator', result.permissions.operator)).toBe(true);
    expect(scopeDemoData(createDemoData(), 'operator', result.permissions.operator).shipments.map((row) => row.id)).toEqual(['shipment-ph']);
    expect(p.operator.markets).toEqual(['TH']);
  });
  it('empty market scope means no data, not all data or artificial zeros', () => {
    const access = { markets: [], viewAmounts: false, manageMappings: false };
    const scoped = scopeDemoData(createDemoData(), 'operator', access);
    expect(Object.values(scoped).every((rows) => rows.length === 0)).toBe(true);
    expect(getOverviewInventory(scoped)).toEqual({ domestic: null, overseas: null, overseasAvailable: null, transit: null });
  });
  it.each(['manager', 'operator'] as const)('does not let %s save permissions', (role) => {
    const p = createDemoPermissions(); const result = saveDemoAccess(p, 'operator', p.manager, role);
    expect(result.error).toBeTruthy(); expect(result.permissions).toBe(p);
  });
  it('rejects widening mapping confirmation beyond administrator', () => {
    const p = createDemoPermissions();
    expect(saveDemoAccess(p, 'manager', { ...p.manager, manageMappings: true }, 'admin').error).toBeTruthy();
    expect(canManageMappings('manager', { ...p.manager, manageMappings: true })).toBe(false);
  });
  it('can disable administrator mapping actions without losing the settings entry', () => {
    const p = createDemoPermissions(); const next = { ...p.admin, manageMappings: false };
    const result = saveDemoAccess(p, 'admin', next, 'admin');
    expect(result.error).toBeNull();
    expect(canManageMappings('admin', result.permissions.admin)).toBe(false);
    expect(changeMapping(createDemoData(), 'map-pending', 'confirm', 'admin', next).error).toBeTruthy();
    expect(saveDemoAccess(result.permissions, 'admin', p.admin, 'admin').error).toBeNull();
  });
  it('does not permit administrator scope removal or an out-of-scope mapping action', () => {
    const p = createDemoPermissions();
    expect(saveDemoAccess(p, 'admin', { ...p.admin, markets: [] }, 'admin').error).toBeTruthy();
    expect(changeMapping(createDemoData(), 'map-pending', 'confirm', 'admin', { ...p.admin, markets: ['TH'] }).error).toBeTruthy();
  });
  it('reset factory does not retain prior grants', () => {
    const first = createDemoPermissions(); first.operator.markets.push('PH');
    expect(createDemoPermissions().operator.markets).toEqual(['TH']);
  });
});

describe('source configuration is isolated from business observations', () => {
  it('saves local cadence/result without changing snapshots or shipments', () => {
    const data = createDemoData(); const before = structuredClone(data); const configs = createSourceConfigs();
    const result = updateSourceConfig(configs, { ...configs[0], cadence: 'daily', lastCheck: 'failed' }, 'admin');
    expect(result.error).toBeNull(); expect(result.configs[0].lastCheck).toBe('failed');
    expect(configs[0].lastCheck).toBe('none'); expect(data).toEqual(before);
    expect(createSourceConfigs()[0].cadence).toBe('manual');
  });
  it.each(['manager', 'operator'] as const)('source changes are rejected for %s', (role) => {
    const configs = createSourceConfigs();
    const result = updateSourceConfig(configs, { ...configs[0], enabled: false }, role);
    expect(result.error).toBeTruthy(); expect(result.configs).toBe(configs);
  });
  it('homepage inventory is derived from the same rows, not hardcoded display totals', () => {
    const data = createDemoData(); const shipping = getOverviewInventory(data); const arrived = getOverviewInventory(getScenarioData(data, 'arrived'));
    expect(arrived.overseas).toBe(shipping.overseas);
    expect(arrived.transit).toBe(shipping.transit! - 100);
    expect(getOverviewInventory(getScenarioData(data, 'snapshot')).overseas).toBe(shipping.overseas! + 100);
    expect(shipping.overseasAvailable).toBeLessThan(shipping.overseas!);
  });
});
