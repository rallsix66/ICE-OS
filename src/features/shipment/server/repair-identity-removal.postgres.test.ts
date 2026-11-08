/* eslint-disable @typescript-eslint/no-explicit-any -- 受控副本证据脚本：直接按 026 的 jsonb 结构取值；DTO 形状由 normalize.ts 单测与 verify-026 覆盖 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { parseShipmentSnapshot } from './parse';
import { planShipmentIdentities } from './identity';
import { normalizeIdentityIndex } from './normalize';
import type {
  IngestShipmentTicket,
  ParsedShipmentSnapshot,
  ParsedShipmentTicket,
  ShipmentIdentityIndexRow,
  ShipmentSourceCollection,
  ShipmentSourceMergedRange,
} from '../types';

/**
 * 026 第二轮受控副本验证（R1 身份延续 / R2 来源移除 / 新到货口径）。
 *
 * 只在**克隆库**里写业务数据（模板克隆现役库，结束清理），使用真实模块：
 *   - parse.ts（按 H 判定到货、G 只作运输进度）；
 *   - identity.ts（planShipmentIdentities，纯函数）；
 *   - 026 的 app RPC（app 角色 + 启用中管理员 JWT，真实写路径）。
 * 证据写到 .local/shipment-v1-repair-20261101/backend/。
 *
 * 名字含 .postgres.test.ts：默认 `npm test` 会排除，需显式运行：
 *   node node_modules/vitest/vitest.mjs run src/features/shipment/server/repair-identity-removal.postgres.test.ts
 */

const REPO_ROOT = process.cwd();
const RUN_ID = 'run-20261026T211500Z-11a22b33';
const INSTANCE_ROOT = path.join(REPO_ROOT, '.local', 'catalog', RUN_ID, 'instance');
const EVIDENCE_DIR = path.join(REPO_ROOT, '.local', 'shipment-v1-repair-20261101', 'backend');
/** 第三轮追加：证据单独落文件，保留第二轮 53 断言的原始 JSON 不被覆盖。 */
const EVIDENCE_FILE = process.env.SHIPMENT_EVIDENCE_FILE ?? 'repair-identity-removal-round3.postgres.json';
const PAYLOAD_FILE = path.join(REPO_ROOT, '.local', 'shipment-v1-20261030', 'ingest-payload.json');
const ADMIN_PROFILE_ID = '11111111-1111-4111-8111-111111111101';
const CLONE_DB = `iceos_shipment_repair_${Date.now().toString(36)}`;
const GUARD_TABLES = [
  'catalog.inventory_batch',
  'catalog.inventory_batch_row',
  'catalog.inventory_sku_mapping',
  'catalog.inventory_current',
  'catalog.inventory_warehouse',
  'catalog.inventory_variant',
  'catalog.inventory_request',
  'catalog.item_revision',
  'catalog.item_current',
  'catalog.catalog_item',
  'catalog.catalog_item_code',
  'catalog.domestic_review_decision',
  'catalog.inventory_sync_run',
];
const SHIPMENT_TABLES = [
  'catalog.shipment_source_snapshot',
  'catalog.shipment',
  'catalog.shipment_item',
  'catalog.shipment_revision',
  'catalog.shipment_item_revision',
  'catalog.shipment_item_association_revision',
];

type Grid = Array<Array<string | number | null>>;
type Json = Record<string, any>;

const evidence: {
  cloneDb: string;
  runId: string;
  steps: Array<{ name: string; detail: unknown }>;
  asserts: Array<{ name: string; ok: boolean; detail: unknown }>;
  guardBefore?: Record<string, { rows: number; hash: string }>;
  guardAfter?: Record<string, { rows: number; hash: string }>;
  shipmentCounts?: Record<string, { rows: number; hash: string }>;
} = { cloneDb: CLONE_DB, runId: RUN_ID, steps: [], asserts: [] };

function record(name: string, detail: unknown): void {
  evidence.steps.push({ name, detail: JSON.parse(JSON.stringify(detail ?? null)) });
}

function assertThat(name: string, condition: boolean, detail: unknown = null): void {
  evidence.asserts.push({ name, ok: Boolean(condition), detail });
  expect(condition, `${name} :: ${JSON.stringify(detail)}`).toBe(true);
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function cloneGrid(values: Grid): Grid {
  return values.map((row) => [...row]);
}

function setCell(grid: Grid, rowNumber: number, column: number, value: string): void {
  const row = grid[rowNumber - 1];
  expect(row, `第 ${rowNumber} 行不存在`).toBeTruthy();
  row[column] = value;
}

function removeRows(grid: Grid, rowNumbers: number[]): void {
  for (const rowNumber of [...rowNumbers].sort((a, b) => b - a)) grid.splice(rowNumber - 1, 1);
}

let pg: any;
let admin: any;
let owner: any;
let app: any;
let adminUrl = '';
let sourcePayload: {
  collection: ShipmentSourceCollection;
  raw: { values: Grid; merges: ShipmentSourceMergedRange[] };
};
let collectionBase: ShipmentSourceCollection;
let grid: Grid;
let revision = 1900;
let lastHash = '';
// 真实来源数据会变（票/明细数、个别票号可能消失）：基线规模在第一次入库后记录，后续断言用它推算。
let baselineTickets = 0;
let baselineItems = 0;
/** 本轮“无 WB 改 PO → 身份待核”场景是否成立（真实来源里该票可能已变化）。 */
let manualPendingScenarioActive = false;

async function asAdminApp<T>(fn: (client: any) => Promise<T>): Promise<T> {
  await app.query('BEGIN');
  try {
    await app.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`, [ADMIN_PROFILE_ID]);
    const value = await fn(app);
    await app.query('COMMIT');
    return value;
  } catch (error) {
    await app.query('ROLLBACK');
    throw error;
  }
}

async function readIndex(): Promise<ShipmentIdentityIndexRow[]> {
  const raw = await asAdminApp(async (client) => {
    const result = await client.query('SELECT catalog.read_shipment_identity_index() AS r');
    return result.rows[0].r;
  });
  return normalizeIdentityIndex(raw);
}

async function parseGrid(values: Grid, readAt: string): Promise<{ parsed: ParsedShipmentSnapshot; hash: string }> {
  revision += 1;
  const parsed = parseShipmentSnapshot({
    collection: {
      ...collectionBase,
      revision,
      readStartedAt: readAt,
      readFinishedAt: readAt,
    },
    values,
    merges: sourcePayload.raw.merges,
  });
  const hash = sha256(JSON.stringify({ revision, values, merges: sourcePayload.raw.merges, parserVersion: 'repair-v1' }));
  return { parsed, hash };
}

async function planTickets(tickets: ParsedShipmentTicket[]): Promise<IngestShipmentTicket[]> {
  const index = await readIndex();
  const identities = planShipmentIdentities(index, tickets);
  return tickets.map((ticket, position) => ({
    ...ticket,
    matchedShipmentId: identities[position].matchedShipmentId,
    identityStatus: identities[position].identityStatus,
    identityNote: identities[position].identityNote,
  }));
}

async function ingest(values: Grid, readAt: string, hashOverride?: string): Promise<Json> {
  const { parsed, hash } = await parseGrid(values, readAt);
  const tickets = await planTickets(parsed.tickets);
  const snapshot = {
    sourceKey: parsed.sourceKey,
    collection: { ...parsed.collection, rawContentHash: hashOverride ?? hash },
    tickets,
    raw: parsed.raw,
  };
  lastHash = hashOverride ?? hash;
  const result = await asAdminApp(async (client) => {
    const res = await client.query('SELECT catalog.ingest_shipment_snapshot($1::jsonb) AS r', [
      JSON.stringify(snapshot),
    ]);
    return res.rows[0].r;
  });
  record('ingest', {
    readAt,
    hash: lastHash,
    ticketCount: result.ticketCount,
    itemCount: result.itemCount,
    unchanged: result.unchanged,
    createdTickets: result.createdTickets,
    updatedTickets: result.updatedTickets,
    unchangedTickets: result.unchangedTickets,
    createdItems: result.createdItems,
    updatedItems: result.updatedItems,
    revisionsAdded: result.revisionsAdded,
    absentTickets: result.absentTickets,
    absentItems: result.absentItems,
    plan: tickets
      .filter((ticket) => ticket.identityStatus === 'pending' || ticket.matchedShipmentId !== null)
      .map((ticket) => ({
        ticketKey: ticket.ticketKey,
        matched: ticket.matchedShipmentId,
        identityStatus: ticket.identityStatus,
        note: ticket.identityNote,
      })),
  });
  return result;
}

async function list(params: {
  market?: string | null;
  status?: string | null;
  search?: string | null;
  product?: string | null;
  includeAbsent?: boolean;
  limit?: number;
  offset?: number;
}): Promise<Json> {
  const raw = await asAdminApp(async (client) => {
    const result = await client.query(
      'SELECT catalog.read_shipment_list($1,$2,$3,$4,$5,$6,$7) AS r',
      [
        params.market ?? null,
        params.status ?? null,
        params.search ?? null,
        params.product ?? null,
        params.includeAbsent === true,
        params.limit ?? 100,
        params.offset ?? 0,
      ],
    );
    return result.rows[0].r;
  });
  return raw;
}

async function detail(shipmentId: string): Promise<Json> {
  return asAdminApp(async (client) => {
    const result = await client.query('SELECT catalog.read_shipment_detail($1) AS r', [shipmentId]);
    return result.rows[0].r;
  });
}

async function productLinks(itemId: string): Promise<Json> {
  return asAdminApp(async (client) => {
    const result = await client.query('SELECT catalog.read_product_shipment_links($1,$2) AS r', [itemId, 50]);
    return result.rows[0].r;
  });
}

async function sourceStatus(): Promise<Json> {
  return asAdminApp(async (client) => {
    const result = await client.query('SELECT catalog.read_shipment_source_status() AS r');
    return result.rows[0].r;
  });
}

async function tableDigest(client: any, table: string): Promise<{ rows: number; hash: string }> {
  const row = (await client.query(
    `SELECT count(*) AS n, coalesce(md5(string_agg(md5(t::text), '' ORDER BY md5(t::text))), '') AS h
     FROM ${table} t`)).rows[0];
  return { rows: Number(row.n), hash: row.h };
}

async function digests(client: any, tables: string[]): Promise<Record<string, { rows: number; hash: string }>> {
  const out: Record<string, { rows: number; hash: string }> = {};
  for (const table of tables) out[table] = await tableDigest(client, table);
  return out;
}

beforeAll(async () => {
  ({ default: pg } = await import('pg'));
  const instance = JSON.parse(fs.readFileSync(path.join(INSTANCE_ROOT, 'catalog-instance.json'), 'utf8'));
  const env = JSON.parse(fs.readFileSync(path.join(INSTANCE_ROOT, 'env.catalog.json'), 'utf8'));
  adminUrl = `postgres://${instance.bootstrapUser}:${instance.bootstrapPassword}`
    + `@${instance.host}:${instance.port}/postgres`;
  const ownerUrl = `postgres://${instance.bootstrapUser}:${instance.bootstrapPassword}`
    + `@${instance.host}:${instance.port}/${CLONE_DB}`;
  const appUrl = new URL(env.P0_02_APP_DATABASE_URL);
  appUrl.pathname = `/${CLONE_DB}`;

  admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${CLONE_DB}"`);
  // 模板克隆偶尔会撞上正式库的瞬时连接（PG 要求模板库无会话）；重试两次再报错。
  for (let attempt = 1; ; attempt += 1) {
    try {
      await admin.query(`CREATE DATABASE "${CLONE_DB}" TEMPLATE "${instance.dbName}"`);
      break;
    } catch (error) {
      if (attempt >= 3) throw error;
      await new Promise((resolve) => { setTimeout(resolve, 1500); });
    }
  }
  await admin.end();

  owner = new pg.Client({ connectionString: ownerUrl });
  await owner.connect();
  // 克隆库继承现役库的 029 结构（source_* NOT NULL 等），因此这里按 026 → 029 重放，
  // 保证 ingest core 与解析口径是新版本（第八轮后该测试仍可重复运行）。
  for (const file of ['db/catalog/026_shipment_in_transit.sql', 'db/catalog/029_shipment_in_transit_correction.sql']) {
    await owner.query(fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'));
    await owner.query('RESET ROLE; RESET ALL');
  }
  // 基线从“空 shipment 表”开始：只清克隆库的 shipment* 业务数据（正式库不动）。
  await owner.query(`TRUNCATE TABLE
    catalog.shipment_item_association_revision, catalog.shipment_item_revision,
    catalog.shipment_revision, catalog.shipment_item, catalog.shipment,
    catalog.shipment_source_snapshot CASCADE`);

  app = new pg.Client({ connectionString: appUrl.toString() });
  await app.connect();

  sourcePayload = JSON.parse(fs.readFileSync(PAYLOAD_FILE, 'utf8')) as {
    collection: ShipmentSourceCollection;
    raw: { values: Grid; merges: ShipmentSourceMergedRange[] };
  };
  collectionBase = sourcePayload.collection;
  grid = cloneGrid(sourcePayload.raw.values);
  evidence.guardBefore = await digests(owner, GUARD_TABLES);
}, 240_000);

afterAll(async () => {
  try {
    if (app) await app.end();
    if (owner) await owner.end();
    if (adminUrl !== '') {
      const cleanup = new pg.Client({ connectionString: adminUrl });
      await cleanup.connect();
      await cleanup.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',
        [CLONE_DB],
      );
      await cleanup.query(`DROP DATABASE IF EXISTS "${CLONE_DB}"`);
      await cleanup.end();
    }
  } catch {
    // 清理失败不影响已经产出的证据；库名记录在证据 JSON 里，可手动 DROP。
  }
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(EVIDENCE_DIR, EVIDENCE_FILE),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
}, 120_000);

describe('货票在途第二轮：身份延续 / 来源移除 / 到货口径（受控副本）', () => {
  it('基线入库：真实最新网格（票/明细数由本次解析结果决定，不写死）', { timeout: 120_000 }, async () => {
    const result = await ingest(grid, '2026-11-01T18:30:00.000Z');
    baselineTickets = result.ticketCount;
    baselineItems = result.itemCount;
    record('基线规模', { tickets: baselineTickets, items: baselineItems });
    assertThat('基线入库新建票数 = 本次解析票数', result.createdTickets === baselineTickets,
      result.createdTickets);
    assertThat('基线入库新建明细数 = 本次解析明细数', result.createdItems === baselineItems,
      result.createdItems);
    assertThat('基线没有本次来源未见', result.absentTickets === 0 && result.absentItems === 0,
      { absentTickets: result.absentTickets, absentItems: result.absentItems });

    const rows = await list({ limit: 100 });
    assertThat('基线列表票数 = 基线票数', rows.total === baselineTickets && rows.rows.length === baselineTickets,
      { total: rows.total, baselineTickets });
    assertThat('基线计数等于基线票数且 5 类齐全',
      rows.counts.total === baselineTickets && typeof rows.counts.arrivedPendingShelving === 'number',
      rows.counts);
    const classes = rows.rows.reduce((acc: Record<string, number>, row: Json) => {
      acc[row.statusClass] = (acc[row.statusClass] ?? 0) + 1;
      return acc;
    }, {});
    record('基线状态分布', classes);
    assertThat('基线状态分类只落在 5 类内',
      Object.keys(classes).every((key) => [
        'in_transit', 'partial', 'arrived_pending_shelving', 'arrived', 'unknown',
      ].includes(key)), classes);
    assertThat('列表行只给商品名称摘要（不带数量）',
      rows.rows.every((row: Json) => Array.isArray(row.productSummary)
        && row.productSummary.every((name: Json) => typeof name === 'string')), rows.rows[0]);
    assertThat('列表行都标 presentInLatestRead=true',
      rows.rows.every((row: Json) => row.presentInLatestRead === true), null);
    evidence.shipmentCounts = await digests(owner, SHIPMENT_TABLES);
  });

  it('补采购单号：弱身份原票沿用原 UUID、明细与关联保留、修订记录编号变化', { timeout: 120_000 }, async () => {
    const before = await list({ limit: 100 });
    const weakRow = before.rows.find((row: Json) => !row.purchaseOrder && !row.waybillsText);
    expect(weakRow, '来源里应有弱身份票').toBeTruthy();
    const beforeDetail = await detail(weakRow.shipmentId);
    record('补PO前', {
      shipmentId: weakRow.shipmentId,
      ticketKey: beforeDetail.shipment.ticketKey,
      revision: beforeDetail.shipment.revision,
      itemRevisions: beforeDetail.items.map((item: Json) => [item.itemKey, item.revision]),
    });

    setCell(grid, beforeDetail.shipment.sourceRowStart, 5, 'POKNZX029900');
    const result = await ingest(grid, '2026-11-01T18:40:00.000Z');
    assertThat('补采购单号不新建票（票数不变）', result.createdTickets === 0, result.createdTickets);
    assertThat('补采购单号更新 1 票', result.updatedTickets === 1, result.updatedTickets);

    const after = await list({ limit: 100 });
    assertThat('补采购单号后票数不变', after.total === baselineTickets, { total: after.total, baselineTickets });
    const row = after.rows.find((entry: Json) => entry.purchaseOrder === 'POKNZX029900');
    assertThat('补的采购单号出现在原 UUID 上', row?.shipmentId === weakRow.shipmentId,
      { expected: weakRow.shipmentId, actual: row?.shipmentId ?? null });
    const afterDetail = await detail(weakRow.shipmentId);
    assertThat('票修订 +1', afterDetail.shipment.revision === beforeDetail.shipment.revision + 1,
      { before: beforeDetail.shipment.revision, after: afterDetail.shipment.revision });
    assertThat('修订历史显示采购单号变化',
      afterDetail.revisions.some((entry: Json) => entry.changedFields
        .some((field: string) => field.includes('采购单号'))),
      afterDetail.revisions.slice(0, 2));
    assertThat('明细数不变、明细修订不变',
      afterDetail.items.length === beforeDetail.items.length
      && afterDetail.items.every((item: Json) => {
        const previous = beforeDetail.items.find((entry: Json) => entry.itemKey === item.itemKey);
        return previous && previous.revision === item.revision;
      }), afterDetail.items.map((item: Json) => [item.itemKey, item.revision]));
  });

  it('改采购单号（运单号不变）：沿用原票、人工关联保留、历史可见编号变化', { timeout: 120_000 }, async () => {
    const before = await list({ search: 'POKNZX027080', limit: 10 });
    expect(before.rows.length).toBe(1);
    const target = before.rows[0];
    const beforeDetail = await detail(target.shipmentId);
    const item = beforeDetail.items[0];
    const productRow = (await owner.query(
      `SELECT c.item_id FROM catalog.catalog_item_code c WHERE c.ice_code='LS101501' LIMIT 1`)).rows[0];
    expect(productRow, '克隆库应存在 LS101501 商品').toBeTruthy();
    const association = await asAdminApp(async (client) => {
      const result = await client.query(
        'SELECT catalog.update_shipment_item_association($1,$2,$3,$4) AS r',
        [item.itemId, productRow.item_id, item.revision, '受控副本：改号前人工关联'],
      );
      return result.rows[0].r;
    });
    assertThat('受控副本人工关联成功', association.ok === true && association.associationStatus === 'manual',
      association);

    setCell(grid, beforeDetail.shipment.sourceRowStart, 5, 'POKNZX029901');
    const result = await ingest(grid, '2026-11-01T18:50:00.000Z');
    assertThat('改采购单号不新建票', result.createdTickets === 0, result.createdTickets);

    const after = await list({ search: 'POKNZX029901', limit: 10 });
    assertThat('改后的采购单号落在原 UUID 上',
      after.rows.length === 1 && after.rows[0].shipmentId === target.shipmentId,
      { expected: target.shipmentId, rows: after.rows.map((row: Json) => row.shipmentId) });
    const afterDetail = await detail(target.shipmentId);
    const afterItem = afterDetail.items.find((entry: Json) => entry.itemId === item.itemId);
    assertThat('人工关联保留（同明细同商品）',
      afterItem?.product?.itemId === productRow.item_id && afterItem?.associationStatus === 'manual',
      { product: afterItem?.product ?? null, status: afterItem?.associationStatus });
    assertThat('明细修订未因改号变化（关联版本保持）',
      afterItem?.revision === association.revision,
      { associationRevision: association.revision, itemRevision: afterItem?.revision });
    assertThat('票修订历史记录采购单号变化',
      afterDetail.revisions.some((entry: Json) => entry.changedFields
        .some((field: string) => field.includes('采购单号'))),
      afterDetail.revisions.slice(0, 3));
    const rowCount = (await owner.query(
      `SELECT count(*) AS n FROM catalog.shipment
       WHERE purchase_order IN ('POKNZX027080','POKNZX029901')`)).rows[0];
    assertThat('该票在库里只有一行（没有重复建票）', Number(rowCount.n) === 1, Number(rowCount.n));
  });

  it('弱身份票补运单号：沿用原 UUID', { timeout: 120_000 }, async () => {
    const before = await list({ limit: 100 });
    const weak = before.rows.find((row: Json) => !row.purchaseOrder && !row.waybillsText);
    expect(weak, '来源里仍应有一张弱身份票').toBeTruthy();
    const beforeDetail = await detail(weak.shipmentId);

    setCell(grid, beforeDetail.shipment.sourceRowStart, 4, '8809999999');
    const result = await ingest(grid, '2026-11-01T19:00:00.000Z');
    assertThat('补运单号不新建票', result.createdTickets === 0, result.createdTickets);
    const after = await list({ search: '8809999999', limit: 10 });
    assertThat('补的运单号落在原 UUID 上',
      after.rows.length === 1 && after.rows[0].shipmentId === weak.shipmentId,
      { expected: weak.shipmentId, rows: after.rows.map((row: Json) => row.shipmentId) });
  });

  it('无运单号改采购单号：新建并标身份待核，原票本次来源未见（不静默合并）', { timeout: 120_000 }, async () => {
    const before = await list({ search: 'GLACZ-20261022009862', limit: 10 });
    // 真实来源会变：该票已不存在（已改号/移除）时本场景不成立，记录并跳过，不伪造数据。
    if (before.rows.length !== 1) {
      manualPendingScenarioActive = false;
      record('无WB改PO场景', { skipped: true, reason: '来源里已没有 GLACZ-20261022009862 这一票' });
      assertThat('无 WB 改 PO 场景：来源已无该票，按跳过记录', true, { skipped: true });
      return;
    }
    manualPendingScenarioActive = true;
    const oldRow = before.rows[0];
    const beforeDetail = await detail(oldRow.shipmentId);
    // 场景前提：该票必须“无运单号”，否则改采购单号会按运单号强匹配（不是弱证据改号）。
    if (beforeDetail.shipment.waybillsText) {
      manualPendingScenarioActive = false;
      record('无WB改PO场景', {
        skipped: true,
        reason: '该票现在有运单号，改号会按运单号匹配，不属于“弱证据改号”场景',
        waybillsText: beforeDetail.shipment.waybillsText,
      });
      assertThat('无 WB 改 PO 场景：该票有运单号，按跳过记录', true, { skipped: true });
      return;
    }
    // 改号前先人工关联一件商品：后面要验证旧票历史/关联在待核期间不被清掉。
    const productRow = (await owner.query(
      `SELECT c.item_id FROM catalog.catalog_item_code c WHERE c.ice_code='LS101501' LIMIT 1`)).rows[0];
    expect(productRow, '克隆库应存在 LS101501 商品').toBeTruthy();
    const pendingOldItem = beforeDetail.items[0];
    const association = await asAdminApp(async (client) => {
      const result = await client.query(
        'SELECT catalog.update_shipment_item_association($1,$2,$3,$4) AS r',
        [pendingOldItem.itemId, productRow.item_id, pendingOldItem.revision, '受控副本：无 WB 改 PO 前人工关联'],
      );
      return result.rows[0].r;
    });
    assertThat('无 WB 改 PO 前人工关联成功', association.ok === true, association);

    setCell(grid, beforeDetail.shipment.sourceRowStart, 5, 'GLACZ-20261022999999');
    const result = await ingest(grid, '2026-11-01T19:10:00.000Z');
    assertThat('改号无法确认时新建 1 票（不合并）', result.createdTickets === 1, result.createdTickets);
    assertThat('新建 2 条明细', result.createdItems === 2, result.createdItems);
    assertThat('本次来源未见 1 票', result.absentTickets === 1, result.absentTickets);

    const current = await list({ search: 'GLACZ-20261022999999', limit: 10 });
    const newRow = current.rows[0];
    assertThat('新行 = 身份待核', newRow?.identityStatus === 'pending', newRow?.identityStatus);
    assertThat('待核说明列出原候选', (newRow?.identityNote ?? '').includes('GLACZ-20261022009862'),
      newRow?.identityNote);
    assertThat('新行与原票 UUID 不同', newRow?.shipmentId !== oldRow.shipmentId,
      { oldRow: oldRow.shipmentId, newRow: newRow?.shipmentId ?? null });

    const defaultList = await list({ search: 'GLACZ-20261022009862', limit: 10 });
    assertThat('旧票默认列表不可见', defaultList.rows.length === 0, defaultList.total);
    const withAbsent = await list({ search: 'GLACZ-20261022009862', includeAbsent: true, limit: 10 });
    assertThat('包含本次来源未见时旧票可见且标记 presentInLatestRead=false',
      withAbsent.rows.length === 1 && withAbsent.rows[0].presentInLatestRead === false
      && withAbsent.rows[0].shipmentId === oldRow.shipmentId,
      withAbsent.rows.map((row: Json) => [row.shipmentId, row.presentInLatestRead]));
    const oldDetail = await detail(oldRow.shipmentId);
    assertThat('旧票（本次来源未见）详情：当前明细为空、missingItems 保留原两条数量',
      oldDetail.shipment.presentInLatestRead === false
      && oldDetail.items.length === 0
      && oldDetail.shipment.itemCount === 0
      && oldDetail.missingItems.length === 2
      && oldDetail.missingItems.every((item: Json) => typeof item.shippedQuantity === 'number'
        && item.shippedQuantity > 0 && typeof item.lastSeenAt === 'string' && item.lastSeenAt !== ''),
      {
        itemCount: oldDetail.shipment.itemCount,
        items: oldDetail.items.length,
        missingItems: oldDetail.missingItems.length,
        present: oldDetail.shipment.presentInLatestRead,
      });
  });

  it('身份待核连续流程：同内容重读 + 只改 G 仍保留待核/UUID/候选说明，不新增票，旧关联与历史保留', { timeout: 120_000 }, async () => {
    if (!manualPendingScenarioActive) {
      record('身份待核连续流程', { skipped: true, reason: '上游“无 WB 改 PO”场景在本次真实来源里不成立' });
      assertThat('身份待核连续流程：上游场景不成立，按跳过记录', true, { skipped: true });
      return;
    }
    const pendingBefore = (await list({ search: 'GLACZ-20261022999999', limit: 10 })).rows[0];
    expect(pendingBefore, '应有待核新行').toBeTruthy();
    assertThat('连续流程起点：待核行已存在且带候选说明',
      pendingBefore.identityStatus === 'pending'
      && typeof pendingBefore.identityNote === 'string' && pendingBefore.identityNote.length > 0,
      { status: pendingBefore.identityStatus, note: pendingBefore.identityNote });
    const pendingId = pendingBefore.shipmentId;
    const pendingNote = pendingBefore.identityNote;

    // 1) 同内容刷新：只证明“仍在读这一行”，不能解除待核。
    const sameContent = await ingest(grid, '2026-11-01T19:11:00.000Z');
    assertThat('同内容重读不新建票/明细', sameContent.createdTickets === 0 && sameContent.createdItems === 0,
      { createdTickets: sameContent.createdTickets, createdItems: sameContent.createdItems });
    const afterSame = (await list({ search: 'GLACZ-20261022999999', limit: 10 })).rows[0];
    assertThat('同内容重读沿用同一 UUID 且仍是待核、说明不变',
      afterSame?.shipmentId === pendingId && afterSame?.identityStatus === 'pending'
      && afterSame?.identityNote === pendingNote,
      { id: afterSame?.shipmentId, status: afterSame?.identityStatus, note: afterSame?.identityNote });

    // 2) 只更新 G（物流情况）：没有任何身份依据，不得自动 confirmed / 清空说明。
    const pendingDetail = await detail(pendingId);
    setCell(grid, pendingDetail.shipment.sourceRowStart, 6, '11/01 派送中');
    const gOnly = await ingest(grid, '2026-11-01T19:12:00.000Z');
    assertThat('只改 G 不新建票/明细', gOnly.createdTickets === 0 && gOnly.createdItems === 0,
      { createdTickets: gOnly.createdTickets, createdItems: gOnly.createdItems });
    const afterG = (await list({ search: 'GLACZ-20261022999999', limit: 10 })).rows[0];
    assertThat('只改 G 后仍同一 UUID、仍待核、候选说明原样保留',
      afterG?.shipmentId === pendingId && afterG?.identityStatus === 'pending'
      && afterG?.identityNote === pendingNote,
      { id: afterG?.shipmentId, status: afterG?.identityStatus, note: afterG?.identityNote });
    assertThat('待核说明仍指向原候选采购单号',
      (afterG?.identityNote ?? '').includes('GLACZ-20261022009862'), afterG?.identityNote);
    const rowsWithNewPo = await list({ search: 'GLACZ-20261022999999', limit: 10 });
    assertThat('改号目标没有新增第二票', rowsWithNewPo.total === 1, rowsWithNewPo.total);
    const pendingAfterDetail = await detail(pendingId);
    assertThat('只改 G 确实生效（运输进度原文已更新）',
      (pendingAfterDetail.shipment.transportText ?? '').includes('派送中'),
      pendingAfterDetail.shipment.transportText);

    // 3) 旧票（本次来源未见）的人工关联与历史仍在。
    const oldRow = (await list({ search: 'GLACZ-20261022009862', includeAbsent: true, limit: 10 })).rows[0];
    expect(oldRow, '旧票应仍可见（包含本次来源未见）').toBeTruthy();
    const productRow = (await owner.query(
      `SELECT c.item_id FROM catalog.catalog_item_code c WHERE c.ice_code='LS101501' LIMIT 1`)).rows[0];
    const oldDetail = await detail(oldRow.shipmentId);
    const manualItem = oldDetail.missingItems.find((item: Json) => item.product?.itemId === productRow.item_id);
    assertThat('旧票仍标本次来源未见', oldDetail.shipment.presentInLatestRead === false,
      oldDetail.shipment.presentInLatestRead);
    assertThat('旧票历史明细保留原人工关联 LS101501',
      manualItem?.associationStatus === 'manual', { status: manualItem?.associationStatus ?? null });
    assertThat('旧票保留编号变化历史',
      Array.isArray(oldDetail.revisions) && oldDetail.revisions.length > 0,
      oldDetail.revisions?.length ?? null);
  });

  it('来源移除：列表/计数/搜索/商品筛选/相关货票一致；详情保留历史明细与原数量', { timeout: 180_000 }, async () => {
    const before = await list({ includeAbsent: true, limit: 100 });
    const candidates = before.rows.filter((row: Json) => row.presentInLatestRead && row.itemCount >= 4);
    expect(candidates.length, '应有可移除的整票').toBeGreaterThan(0);
    const removeTicket = candidates[0];
    const removeTicketDetail = await detail(removeTicket.shipmentId);
    const itemHost = before.rows.find((row: Json) => row.presentInLatestRead
      && row.shipmentId !== removeTicket.shipmentId && row.itemCount >= 3);
    expect(itemHost, '应有可移除单条明细的票').toBeTruthy();
    const itemHostDetail = await detail(itemHost.shipmentId);

    // 用解析结果拿到该票第二条明细的来源行号（detail DTO 不暴露行号）。
    const { parsed: currentParsed } = await parseGrid(grid, '2026-11-01T19:15:00.000Z');
    const itemHostParsed = currentParsed.tickets.find(
      (ticket) => ticket.ticketKey === itemHostDetail.shipment.ticketKey,
    );
    expect(itemHostParsed, '应能在解析结果里找到该票').toBeTruthy();
    const missingParsedItem = itemHostParsed!.items[1];
    const missingDetailItem = itemHostDetail.items[1];

    record('移除对象', {
      ticket: {
        shipmentId: removeTicket.shipmentId,
        ticketNo: removeTicket.ticketNo,
        rows: [removeTicketDetail.shipment.sourceRowStart, removeTicketDetail.shipment.sourceRowEnd],
        itemCount: removeTicketDetail.items.length,
      },
      item: {
        shipmentId: itemHost.shipmentId,
        itemId: missingDetailItem.itemId,
        itemKey: missingDetailItem.itemKey,
        shippedQuantity: missingDetailItem.shippedQuantity,
        sourceRow: missingParsedItem.sourceRow,
      },
    });

    const ticketRows = Array.from(
      { length: removeTicketDetail.shipment.sourceRowEnd - removeTicketDetail.shipment.sourceRowStart + 1 },
      (_, index) => removeTicketDetail.shipment.sourceRowStart + index,
    );
    removeRows(grid, [...ticketRows, missingParsedItem.sourceRow]);

    const result = await ingest(grid, '2026-11-01T19:20:00.000Z');
    // 基线规模 + 移除前的缺席计数推算（真实来源数据会变，不写死 2/36）。
    const expectedTickets = before.total - 1;
    const expectedAbsentTickets = before.absentTickets + 1;
    const expectedAbsentItems = before.absentItems + removeTicketDetail.items.length + 1;
    assertThat(`移除后读取到 ${expectedTickets} 票`,
      result.ticketCount === expectedTickets
      && result.unchangedTickets + result.createdTickets + result.updatedTickets === expectedTickets,
      result);
    assertThat(`移除 1 票 + 1 明细后 absentTickets=${expectedAbsentTickets}、absentItems=${expectedAbsentItems}`,
      result.absentTickets === expectedAbsentTickets && result.absentItems === expectedAbsentItems,
      { absentTickets: result.absentTickets, absentItems: result.absentItems });

    const current = await list({ limit: 100 });
    assertThat(`默认列表 ${expectedTickets} 票且不含被移除票`,
      current.total === expectedTickets
      && !current.rows.some((row: Json) => row.shipmentId === removeTicket.shipmentId),
      { total: current.total });
    assertThat(`默认列表计数 ${expectedTickets}`, current.counts.total === expectedTickets, current.counts);
    assertThat(`计数只落在 5 类且合计 ${expectedTickets}`,
      current.counts.inTransit + current.counts.partial + current.counts.arrivedPendingShelving
        + current.counts.arrived + current.counts.unknown === expectedTickets, current.counts);

    const searchRemoved = await list({ search: removeTicket.ticketNo, limit: 10 });
    assertThat('关键词搜索不再命中被移除票', searchRemoved.total === 0, searchRemoved.total);
    const searchRemovedAbsent = await list({ search: removeTicket.ticketNo, includeAbsent: true, limit: 10 });
    assertThat('包含历史行时能查到被移除票且标本次未见',
      searchRemovedAbsent.rows.length === 1 && searchRemovedAbsent.rows[0].presentInLatestRead === false,
      searchRemovedAbsent.rows.map((row: Json) => [row.shipmentId, row.presentInLatestRead]));

    // 被移除票的首条明细可能未关联商品；两处断言都保留，未关联时按“跳过但登记”处理，保证断言条数稳定。
    const removedProductId = removeTicketDetail.items[0]?.product?.itemId ?? null;
    const filtered = removedProductId ? await list({ product: removedProductId, limit: 100 }) : null;
    assertThat('商品筛选不再命中被移除票（明细未关联商品时跳过）',
      removedProductId === null || !filtered!.rows.some((row: Json) => row.shipmentId === removeTicket.shipmentId),
      { removedProductId, total: filtered?.total ?? null });
    const links = removedProductId ? await productLinks(removedProductId) : null;
    assertThat('相关货票不再命中被移除票（明细未关联商品时跳过）',
      removedProductId === null || !links!.rows.some((row: Json) => row.shipmentId === removeTicket.shipmentId),
      { removedProductId, total: links?.total ?? null });

    const currentHost = await detail(itemHost.shipmentId);
    assertThat('当前明细不再包含被移除的明细',
      !currentHost.items.some((item: Json) => item.itemId === missingDetailItem.itemId),
      currentHost.items.map((item: Json) => item.itemKey));
    const missing = currentHost.missingItems.find((item: Json) => item.itemId === missingDetailItem.itemId);
    assertThat('missingItems 保留被移除明细与原发货量',
      missing !== undefined && missing.shippedQuantity === missingDetailItem.shippedQuantity
      && missing.remainingState === missingDetailItem.remainingState,
      missing ?? null);
    assertThat('单明细移除票：items 少一条、itemCount 与当前明细一致、latestReadAt=本次成功快照时间',
      currentHost.items.length === itemHostDetail.items.length - 1
      && currentHost.shipment.itemCount === currentHost.items.length
      && new Date(currentHost.latestReadAt).toISOString() === '2026-11-01T19:20:00.000Z',
      {
        items: currentHost.items.length,
        itemCount: currentHost.shipment.itemCount,
        latestReadAt: currentHost.latestReadAt,
      });

    const absentDetail = await detail(removeTicket.shipmentId);
    assertThat('整票本次未见：items=[]、itemCount=0、missingItems=该票全部明细（含原数量与 lastSeenAt）、presentInLatestRead=false、latestReadAt=本次成功快照时间',
      absentDetail.shipment.presentInLatestRead === false
      && absentDetail.shipment.itemCount === 0
      && absentDetail.items.length === 0
      && absentDetail.missingItems.length === removeTicketDetail.items.length
      && absentDetail.missingItems.every((item: Json) => {
        const before = removeTicketDetail.items.find((entry: Json) => entry.itemId === item.itemId);
        return before !== undefined && before.shippedQuantity === item.shippedQuantity
          && typeof item.lastSeenAt === 'string' && item.lastSeenAt !== '';
      })
      && new Date(absentDetail.latestReadAt).toISOString() === '2026-11-01T19:20:00.000Z',
      {
        itemCount: absentDetail.shipment.itemCount,
        items: absentDetail.items.length,
        missingItems: absentDetail.missingItems.length,
        beforeCount: removeTicketDetail.items.length,
        latestReadAt: absentDetail.latestReadAt,
      });

    const absentRows = await list({ includeAbsent: true, limit: 100 });
    assertThat(`包含历史行时 ${expectedTickets + expectedAbsentTickets} 行、标记 ${expectedAbsentTickets} 行本次未见`,
      absentRows.total === expectedTickets + expectedAbsentTickets
      && absentRows.rows.filter((row: Json) => row.presentInLatestRead === false).length === expectedAbsentTickets,
      { total: absentRows.total });

    const repeated = await ingest(grid, '2026-11-01T19:25:00.000Z', lastHash);
    assertThat('同内容重复读取返回 unchanged 且不改变退出状态',
      repeated.unchanged === true && repeated.absentTickets === expectedAbsentTickets
      && repeated.absentItems === expectedAbsentItems,
      { unchanged: repeated.unchanged, absentTickets: repeated.absentTickets, absentItems: repeated.absentItems });
    const afterRepeat = await list({ limit: 100 });
    assertThat('重复读取后当前列表仍是预期票数', afterRepeat.total === expectedTickets, afterRepeat.total);

    const statusBefore = await sourceStatus();
    const failure = await asAdminApp(async (client) => {
      const res = await client.query('SELECT catalog.record_shipment_read_failure($1::jsonb) AS r', [
        JSON.stringify({
          sourceKey: 'feishu_logistics_sheet',
          readAt: '2026-11-01T19:30:00.000Z',
          errorCode: 'SOURCE_CLI_FAILED',
          errorMessage: '受控副本：失败读取不改变退出状态',
        }),
      ]);
      return res.rows[0].r;
    });
    const statusAfter = await sourceStatus();
    assertThat('失败读取只写失败快照',
      failure.ok === true && statusAfter.lastAttempt.status === 'failed'
      && statusAfter.lastSuccess.snapshotId === statusBefore.lastSuccess.snapshotId,
      { lastSuccessBefore: statusBefore.lastSuccess.snapshotId, lastAfter: statusAfter.lastSuccess.snapshotId });
    const afterFailure = await list({ limit: 100 });
    assertThat('失败读取后当前列表仍是预期票数（不误使整批退出）', afterFailure.total === expectedTickets, afterFailure.total);
  });

  it('ingest 前后未写库存/商品/映射/国内决定表', { timeout: 120_000 }, async () => {
    evidence.guardAfter = await digests(owner, GUARD_TABLES);
    const changed = GUARD_TABLES.filter((table) => (
      evidence.guardBefore![table].rows !== evidence.guardAfter![table].rows
      || evidence.guardBefore![table].hash !== evidence.guardAfter![table].hash
    ));
    assertThat('13 张库存/商品/映射/国内决定表行数与内容哈希不变', changed.length === 0, changed);
    const shipmentDigests = await digests(owner, SHIPMENT_TABLES);
    record('shipment 表最终计数', shipmentDigests);
    assertThat('写入只落在 shipment* 表（票/明细有数据）',
      shipmentDigests['catalog.shipment'].rows > 0 && shipmentDigests['catalog.shipment_item'].rows > 0,
      shipmentDigests);
  });
});
