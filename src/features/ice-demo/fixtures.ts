import type { DemoData, DemoLog, DemoMapping, DemoProduct, DemoSnapshot, Market } from './types';

export const DEMO_NOW = '2026-10-13T16:00:00+08:00';
export const MARKETS: { id: Market; name: string; short: string; color: string }[] = [
  { id: 'CN', name: '中国', short: '国内', color: '#5368d7' },
  { id: 'TH', name: '泰国', short: '泰国', color: '#5266d7' },
  { id: 'PH', name: '菲律宾', short: '菲律宾', color: '#e4ab5a' },
  { id: 'MY', name: '马来西亚', short: '马来西亚', color: '#77a491' },
  { id: 'VN', name: '越南', short: '越南', color: '#9c90c4' },
  { id: 'ID', name: '印度尼西亚', short: '印尼', color: '#83a6c8' },
];

export const MAPPING_LABELS = {
  unmatched: '未匹配', pending: '待确认', confirmed: '已确认', review: '重新核对', disabled: '停用',
} as const;

const products: DemoProduct[] = [
  { id: 'p1', code: 'ICE-1001', barcode: '0690123400001', name: '稻萃柔润洁面', foreignName: '稻萃柔润洁面乳', englishName: 'Rice Gentle Cleanser', specification: '120 g', unit: '支', category: '面部清洁', color: '#e9e4d4', unitCost: 18.5, costVersion: 'COST-DEMO-01' },
  { id: 'p2', code: 'ICE-1002', barcode: '6901234000022', name: '水光保湿精华', foreignName: '水光保湿精华液', englishName: 'Hydrating Glow Serum', specification: '30 ml', unit: '瓶', category: '精华护理', color: '#e3e8f1', unitCost: 32, costVersion: 'COST-DEMO-01' },
  { id: 'p3', code: 'ICE-1003', barcode: '6901234000039', name: '轻盈防晒乳', foreignName: '轻盈防晒乳液', englishName: 'Daily UV Milk', specification: '50 ml', unit: '瓶', category: '日间防护', color: '#f6e8c7', unitCost: null, costVersion: '待补充' },
  { id: 'p4', code: 'ICE-1004', barcode: '6901234000046', name: '植萃修护面膜', foreignName: '植萃修护面膜单片装', englishName: 'Botanical Repair Mask', specification: '25 ml × 1', unit: '片', category: '面膜护理', color: '#e0eade', unitCost: 12, costVersion: 'COST-DEMO-01' },
  { id: 'p5', code: 'ICE-1005', barcode: '6901234000053', name: '柔润身体乳', foreignName: '柔润保湿身体乳', englishName: 'Soft Moisture Body Lotion', specification: '250 ml', unit: '瓶', category: '身体护理', color: '#eee0db', unitCost: 26, costVersion: 'COST-DEMO-01' },
  { id: 'p6', code: 'ICE-1006', barcode: '6901234000060', name: '焕亮护理套组', foreignName: '焕亮日常护理套组', englishName: 'Bright Daily Care Set', specification: '3 件装', unit: '套', category: '组合套装', color: '#e9e1ef', unitCost: 45, costVersion: 'COST-DEMO-01' },
];

const inventorySeeds: [string, Market, number, number][] = [
  ['p1', 'CN', 2400, 2280], ['p1', 'TH', 240, 216], ['p1', 'PH', 460, 440], ['p1', 'MY', 320, 300],
  ['p2', 'CN', 1800, 1760], ['p2', 'TH', 720, 700], ['p2', 'VN', 28, 20], ['p2', 'ID', 460, 444],
  ['p3', 'CN', 1600, 1500], ['p3', 'TH', 480, 450], ['p3', 'PH', 380, 360],
  ['p4', 'CN', 5200, 5000], ['p4', 'MY', 1800, 1780], ['p4', 'VN', 820, 800],
  ['p5', 'CN', 920, 900], ['p5', 'PH', 68, 60], ['p5', 'ID', 260, 250],
  ['p6', 'CN', 600, 580], ['p6', 'MY', 120, 116], ['p6', 'ID', 180, 174],
];

function warehouse(market: Market) {
  return market === 'CN' ? '华东演示中心仓' : `${MARKETS.find((entry) => entry.id === market)?.short ?? market}演示仓`;
}

const mappings: DemoMapping[] = inventorySeeds.map(([productId, market]) => ({
  id: `map-${productId}-${market}`, productId, candidateProductId: productId, variantId: `variant-${productId}-${market}`,
  source: market === 'CN' ? '聚水潭' : 'BigSeller', account: market === 'CN' ? 'JST-DEMO' : `BS-DEMO-${market}`,
  market, warehouse: warehouse(market), externalSku: `${market}-${productId.replace('p', 'DEMO-0')}`,
  status: 'confirmed', version: 1,
}));

const extraMappings: DemoMapping[] = [
  { id: 'map-pending', productId: null, candidateProductId: 'p2', variantId: 'candidate-p2-PH', source: 'BigSeller', account: 'BS-DEMO-PH', market: 'PH', warehouse: warehouse('PH'), externalSku: 'PH-GLOW-NEW', status: 'pending', version: 1 },
  { id: 'map-review', productId: 'p3', candidateProductId: 'p3', variantId: 'variant-p3-VN', source: 'BigSeller', account: 'BS-DEMO-VN', market: 'VN', warehouse: warehouse('VN'), externalSku: 'VN-UV-REPACK', status: 'review', version: 3 },
  { id: 'map-unmatched', productId: null, candidateProductId: 'p4', variantId: 'candidate-p4-ID', source: 'BigSeller', account: 'BS-DEMO-ID', market: 'ID', warehouse: warehouse('ID'), externalSku: 'ID-BOTANICAL-X', status: 'unmatched', version: 1 },
  { id: 'map-disabled', productId: 'p5', candidateProductId: 'p5', variantId: 'variant-p5-MY-old', source: 'BigSeller', account: 'BS-DEMO-MY', market: 'MY', warehouse: warehouse('MY'), externalSku: 'MY-BODY-OLD', status: 'disabled', version: 2 },
];

const snapshots: DemoSnapshot[] = inventorySeeds.map(([productId, market, current, available]) => {
  const mapping = mappings.find((entry) => entry.id === `map-${productId}-${market}`)!;
  const stale = market === 'ID';
  return {
    id: `snap-${productId}-${market}`, mappingId: mapping.id, resolvedProductId: productId,
    mappingStatus: 'confirmed', mappingVersion: 1, source: mapping.source, market,
    warehouse: mapping.warehouse, externalSku: mapping.externalSku, current, available, locked: current - available,
    sourceTransit: productId === 'p1' && market === 'TH' ? 100 : 0,
    batchId: market === 'CN' ? 'JST-DEMO-1013-01' : `BS-DEMO-${market}-${stale ? '1010' : '1013'}-01`,
    capturedAt: stale ? '2026-10-10T09:00:00+08:00' : '2026-10-13T09:00:00+08:00',
    isLatest: true, freshness: stale ? 'stale' : 'fresh', completeness: 'complete',
  };
});

for (const [index, mapping] of extraMappings.entries()) {
  snapshots.push({
    id: `snap-extra-${index}`, mappingId: mapping.id, resolvedProductId: null,
    mappingStatus: mapping.status, mappingVersion: mapping.version, source: mapping.source, market: mapping.market,
    warehouse: mapping.warehouse, externalSku: mapping.externalSku, current: [84, 65, 42, 18][index],
    available: [80, 60, 40, 16][index], locked: [4, 5, 2, 2][index], sourceTransit: 0,
    batchId: `BS-DEMO-${mapping.market}-${mapping.market === 'ID' ? '1010' : '1013'}-01`, capturedAt: mapping.market === 'ID' ? '2026-10-10T09:00:00+08:00' : '2026-10-13T09:00:00+08:00',
    isLatest: true, freshness: mapping.market === 'ID' ? 'stale' : 'fresh', completeness: 'complete',
  });
}

const history: DemoSnapshot[] = snapshots.slice(0, 20).map((snapshot) => ({
  ...snapshot, id: `${snapshot.id}-history`, isLatest: false,
  batchId: `${snapshot.source === '聚水潭' ? 'JST' : 'BS'}-DEMO-${snapshot.market}-0928-01`,
  capturedAt: '2026-09-28T09:00:00+08:00',
  current: snapshot.resolvedProductId === 'p4' ? snapshot.current : (snapshot.current ?? 0) + 120,
  available: snapshot.resolvedProductId === 'p4' ? snapshot.available : (snapshot.available ?? 0) + 120,
}));

const logs: DemoLog[] = [
  { id: 'log-1', at: '2026-10-13T10:00:00+08:00', actor: '林悦 · 演示运营', action: '更新货票备注', source: '飞书', market: 'TH', productCode: 'ICE-1001', barcode: '0690123400001', externalSku: 'TH-DEMO-01', shipment: 'DEMO-TH-1013', batchId: 'FEISHU-DEMO-v3', detail: '预计下午派送；业务状态仍为运输中。', session: false },
  { id: 'log-2', at: '2026-10-13T09:00:00+08:00', actor: '系统 · 演示', action: '发布完整快照', source: 'BigSeller', market: 'TH', productCode: 'ICE-1001', barcode: '0690123400001', externalSku: 'TH-DEMO-01', shipment: '', batchId: 'BS-DEMO-TH-1013-01', detail: '保留实物、锁定、可售、来源在途四个独立字段。', session: false },
  { id: 'log-3', at: '2026-10-13T08:40:00+08:00', actor: '陈安 · 演示管理员', action: '提交映射候选', source: '人工', market: 'PH', productCode: 'ICE-1002', barcode: '6901234000022', externalSku: 'PH-GLOW-NEW', shipment: '', batchId: '', detail: '候选仅用于审核，84件未归集到已确认商品。', session: false },
  { id: 'log-4', at: '2026-10-13T08:30:00+08:00', actor: '系统 · 演示', action: '同步失败保留旧值', source: 'BigSeller', market: 'ID', productCode: 'ICE-1005', barcode: '6901234000053', externalSku: 'ID-DEMO-05', shipment: '', batchId: 'BS-DEMO-ID-1013-FAILED', detail: '分页不完整，失败批次未发布；保留10月10日成功快照。', session: false },
  { id: 'log-5', at: '2026-10-12T16:30:00+08:00', actor: '陈安 · 演示管理员', action: '映射重新核对', source: '人工', market: 'VN', productCode: 'ICE-1003', barcode: '6901234000039', externalSku: 'VN-UV-REPACK', shipment: '', batchId: '', detail: '来源规格变更，映射v3进入重核；未确认数量单独保留。', session: false },
  { id: 'log-6', at: '2026-10-12T15:00:00+08:00', actor: '系统 · 演示', action: '物流等待绑定', source: '喜运达', market: 'VN', productCode: 'ICE-1002', barcode: '6901234000022', externalSku: 'VN-DEMO-02', shipment: 'DEMO-VN-1015', batchId: 'XYD-DEMO-1012', detail: '缺少来源账号，不能按运单号自动绑定货票。', session: false },
];

function demoTracking(id: string): { at: string; text: string }[] {
  const events: Record<string, { at: string; text: string }[]> = {
    'shipment-th': [{ at: '2026-10-11 09:20', text: '已发运' }, { at: '2026-10-12 14:30', text: '清关完成' }, { at: '2026-10-13 12:10', text: '承运商已签收' }],
    'shipment-ph': [{ at: '2026-10-11 09:00', text: '抵达目的港' }, { at: '2026-10-13 11:00', text: '清关处理中' }],
    'shipment-th-partial': [{ at: '2026-10-12 14:00', text: '清关完成' }, { at: '2026-10-13 10:30', text: '首批派送完成，其余待派送' }],
    'shipment-th-done': [{ at: '2026-10-08 09:00', text: '派送中' }, { at: '2026-10-09 10:00', text: '承运商已签收' }],
    'shipment-my': [{ at: '2026-10-12 08:00', text: '已发运' }],
    'shipment-id-done': [{ at: '2026-10-10 08:00', text: '承运商已签收' }],
  };
  return events[id] ?? [];
}

/** Entire dataset is invented. No production names, identifiers, or credentials. */
export function createDemoData(): DemoData {
  return {
    products: products.map((entry) => ({ ...entry })),
    mappings: [...mappings, ...extraMappings].map((entry) => ({ ...entry })),
    snapshots: [...snapshots, ...history].map((entry) => ({ ...entry })),
    shipments: [
      { id: 'shipment-th', trackingEvents: demoTracking('shipment-th'), number: 'DEMO-TH-1013', productId: 'p1', market: 'TH', warehouse: warehouse('TH'), quantity: 100, receivedQuantity: 0, feishuStatus: '运输中', waybill: 'DEMO-XYD-TH-001', account: 'XYD-DEMO-A', binding: 'confirmed', eta: '2026-10-13', note: '虚构100件货；收货状态与库存快照分开观察。' },
      { id: 'shipment-ph', trackingEvents: demoTracking('shipment-ph'), number: 'DEMO-PH-1018', productId: 'p3', market: 'PH', warehouse: warehouse('PH'), quantity: 200, receivedQuantity: 0, feishuStatus: '清关中', waybill: 'DEMO-XYD-PH-002', account: 'XYD-DEMO-A', binding: 'confirmed', eta: '2026-10-18', note: '单位成本待补充，在途数量可见，货值不填0。' },
      { id: 'shipment-vn', trackingEvents: demoTracking('shipment-vn'), number: 'DEMO-VN-1015', productId: 'p2', market: 'VN', warehouse: warehouse('VN'), quantity: 120, receivedQuantity: 0, feishuStatus: '运输中', waybill: 'DEMO-XYD-VN-003', account: '', binding: 'pending', eta: '2026-10-15', note: '物流账号缺失；飞书在途事实保留，API记录待绑定。' },
      { id: 'shipment-th-partial', trackingEvents: demoTracking('shipment-th-partial'), number: 'DEMO-TH-1016', productId: 'p2', market: 'TH', warehouse: warehouse('TH'), quantity: 60, receivedQuantity: 20, feishuStatus: '部分到货', waybill: 'DEMO-XYD-TH-004', account: 'XYD-DEMO-A', binding: 'confirmed', eta: '2026-10-16', note: '60瓶已到20瓶，剩余40瓶；飞书到货不累加BigSeller库存。' },
      { id: 'shipment-th-done', trackingEvents: demoTracking('shipment-th-done'), number: 'DEMO-TH-1009', productId: 'p3', market: 'TH', warehouse: warehouse('TH'), quantity: 80, receivedQuantity: 80, feishuStatus: '已到货上架', waybill: 'DEMO-XYD-TH-005', account: 'XYD-DEMO-A', binding: 'confirmed', eta: '2026-10-09', note: '完成货票保留历史；本票不再计入运输在途。' },
      { id: 'shipment-my', trackingEvents: demoTracking('shipment-my'), number: 'DEMO-MY-1025', productId: 'p6', market: 'MY', warehouse: warehouse('MY'), quantity: 90, receivedQuantity: 0, feishuStatus: '运输中', waybill: 'DEMO-XYD-MY-006', account: 'XYD-DEMO-A', binding: 'confirmed', eta: '2026-10-25', note: '演示远期到货，用于区分全部物流与未来7天到货。' },
      { id: 'shipment-id-done', trackingEvents: demoTracking('shipment-id-done'), number: 'DEMO-ID-1010', productId: 'p2', market: 'ID', warehouse: warehouse('ID'), quantity: 50, receivedQuantity: 50, feishuStatus: '已到货上架', waybill: 'DEMO-XYD-ID-007', account: 'XYD-DEMO-A', binding: 'confirmed', eta: '2026-10-10', note: '在途已结束，库存仍按印尼最后成功快照显示。' },
    ],
    logs: logs.map((entry) => ({ ...entry })),
  };
}
