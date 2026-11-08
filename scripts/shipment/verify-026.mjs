/**
 * 026 货票在途 v1（第二轮合同）隔离库契约验证。
 *
 * 用法：
 *   node scripts/shipment/verify-026.mjs [--run-id run-20261026T211500Z-11a22b33]
 *
 * 做法：模板克隆现役库 → 应用 026（两次，证明幂等）→ 清空克隆库 shipment* 业务数据 →
 *      用 app 角色 + 启用中管理员 JWT 走真实 RPC（合成受控数据，只进克隆库）。
 * 覆盖：函数/权限安装、5 类状态与 5 种到货依据、幂等、修订、剩余在途口径、身份待核与续接、
 *      来源移除（默认/包含历史、计数、搜索、详情 missingItems）、失败快照、商品关联、
 *      身份索引、库存保护、app 权限负向。
 *
 * 证据：.local/shipment-v1-repair-20261101/backend/verify-026-<时间戳>.json
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOCAL_ROOT = path.join(REPO_ROOT, '.local');
const DEFAULT_RUN_ID = 'run-20261026T211500Z-11a22b33';
const EVIDENCE_DIR = path.join(LOCAL_ROOT, 'shipment-v1-repair-20261101', 'backend');
const SQL_FILE = 'db/catalog/026_shipment_in_transit.sql';
const ADMIN_PROFILE_ID = '11111111-1111-4111-8111-111111111101';
const APP_ROLE = 'ice_p0_02_app_runner';
const TABLES = [
  'shipment_source_snapshot', 'shipment', 'shipment_item',
  'shipment_revision', 'shipment_item_revision', 'shipment_item_association_revision',
];
const FUNCTIONS = [
  ['read_shipment_source_status', ''],
  ['read_shipment_list', 'p_market text, p_status text, p_search text, p_product uuid, p_include_absent boolean, p_limit integer, p_offset integer'],
  ['read_shipment_detail', 'p_shipment_id uuid'],
  ['read_product_shipment_links', 'p_item_id uuid, p_limit integer'],
  ['read_shipment_identity_index', ''],
  ['search_products_for_shipment', 'p_search text, p_limit integer'],
  ['ingest_shipment_snapshot', 'p_snapshot jsonb'],
  ['record_shipment_read_failure', 'p_error jsonb'],
  ['update_shipment_item_association', 'p_item_id uuid, p_product_id uuid, p_expected_revision integer, p_reason text'],
];
const GUARD_TABLES = [
  'catalog.inventory_batch',
  'catalog.inventory_batch_row',
  'catalog.inventory_sku_mapping',
  'catalog.inventory_current',
  'catalog.item_revision',
  'catalog.item_current',
  'catalog.catalog_item',
  'catalog.catalog_item_code',
  'catalog.domestic_review_decision',
  'catalog.inventory_request',
];

function readArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else { args[key] = next; i += 1; }
  }
  return args;
}

const results = [];
function check(name, condition, detail) {
  results.push({ name, ok: Boolean(condition), detail });
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${name}${detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`}`);
  if (!condition) throw new Error(`VERIFY_FAILED:${name}`);
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/* ------------------------------------------------------------------ *
 * 合成受控快照（虚构数据，只进克隆库）
 * ------------------------------------------------------------------ */

function makeItem(name, shipped, sourceReceivedQuantity = null, sourceRow = 2, note = null) {
  return {
    itemKey: `${name}#0`,
    productNameRaw: name,
    productNameNorm: `verify-${name}`,
    shippedQuantity: shipped,
    sourceReceivedQuantity,
    sourceRow,
    sourceNote: note,
  };
}

function makeTicket(params) {
  return {
    ticketKey: params.ticketKey,
    ticketNo: params.ticketNo,
    sourceRowStart: params.sourceRowStart,
    sourceRowEnd: params.sourceRowEnd,
    market: params.market,
    customsMethod: '普货',
    waybillsText: params.waybillsText ?? null,
    purchaseOrder: params.purchaseOrder ?? null,
    transportText: params.transportText ?? null,
    arrivalText: params.arrivalText ?? null,
    vessel: null,
    dispatchedText: null,
    statusClass: params.statusClass,
    receivedBasis: params.receivedBasis,
    items: params.items,
    matchedShipmentId: params.matchedShipmentId ?? null,
    identityStatus: params.identityStatus ?? 'confirmed',
    identityNote: params.identityNote ?? null,
  };
}

function baseTickets() {
  return [
    makeTicket({
      ticketKey: 'PO:VERIFYPO001', ticketNo: 'VERIFYPO001', sourceRowStart: 2, sourceRowEnd: 3,
      market: 'MY', purchaseOrder: 'VERIFYPO001', waybillsText: 'VW001',
      transportText: '10/30 已拆柜，待安排派送', arrivalText: null,
      statusClass: 'in_transit', receivedBasis: 'status_in_transit_zero',
      items: [
        makeItem('受控产品甲', 100, 60, 2),
        makeItem('受控产品乙', 30, null, 3, '物流情况：已拆柜'),
      ],
    }),
    makeTicket({
      ticketKey: 'WB:VERIFYWB001', ticketNo: 'VERIFYWB001', sourceRowStart: 4, sourceRowEnd: 4,
      market: 'TH', waybillsText: 'VERIFYWB001',
      transportText: null, arrivalText: '已到货上架',
      statusClass: 'arrived', receivedBasis: 'status_arrived_full',
      items: [makeItem('受控产品丙', 50, null, 4)],
    }),
    makeTicket({
      ticketKey: 'FB:PH|普货|verify-受控产品丁', ticketNo: '无单号·PH·行5',
      sourceRowStart: 5, sourceRowEnd: 5,
      market: 'PH', transportText: null, arrivalText: null,
      statusClass: 'unknown', receivedBasis: 'pending',
      items: [makeItem('受控产品丁', 10, null, 5)],
    }),
    makeTicket({
      ticketKey: 'PO:VERIFYPO002', ticketNo: 'VERIFYPO002', sourceRowStart: 6, sourceRowEnd: 6,
      market: 'TH', purchaseOrder: 'VERIFYPO002', waybillsText: 'VW002',
      transportText: '10/30 清关中', arrivalText: '已到货，待上架',
      statusClass: 'arrived_pending_shelving', receivedBasis: 'status_awaiting_shelving_zero',
      items: [makeItem('受控产品戊', 20, null, 6)],
    }),
  ];
}

function buildSnapshot({ revision, readFinishedAt, tickets }) {
  const values = [
    ['产品', '数量', '国家', '报关方式', '运单号', '采购单号', '物流情况', '预计到货时间', '船名', '发出时间'],
    ...tickets.flatMap((row) => row.items.map((entry) => [
      entry.productNameRaw, entry.shippedQuantity, row.market, null, null, null, null, null, null, null,
    ])),
  ];
  const hash = sha256(JSON.stringify({ revision, values, parserVersion: 'verify-026' }));
  return {
    sourceKey: 'feishu_logistics_sheet',
    collection: {
      sourceKey: 'feishu_logistics_sheet',
      url: 'https://example.invalid/wiki/verify',
      docTitle: '物流情况表（隔离验证）',
      docToken: 'VERIFYDOC0001',
      documentEditedAt: '2026-11-01T16:19:17.000Z',
      sheetId: 'b42d8b',
      sheetTitle: 'Sheet1',
      revision,
      readStartedAt: readFinishedAt,
      readFinishedAt,
      readBy: null,
      gridRows: values.length,
      readRows: values.length,
      lastNonEmptyRow: values.length,
      headers: [],
      merges: [],
      rawContentHash: hash,
    },
    tickets,
    raw: { values, merges: [] },
  };
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function main() {
  const args = readArgs(process.argv.slice(2));
  const runId = args['run-id'] ?? DEFAULT_RUN_ID;
  const instanceRoot = path.join(LOCAL_ROOT, 'catalog', runId, 'instance');
  const instance = JSON.parse(fs.readFileSync(path.join(instanceRoot, 'catalog-instance.json'), 'utf8'));
  const env = JSON.parse(fs.readFileSync(path.join(instanceRoot, 'env.catalog.json'), 'utf8'));
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const cloneDb = `iceos_shipment_verify_${stamp}`;
  const adminUrl = `postgres://${instance.bootstrapUser}:${instance.bootstrapPassword}`
    + `@${instance.host}:${instance.port}/postgres`;
  const ownerUrl = `postgres://${instance.bootstrapUser}:${instance.bootstrapPassword}`
    + `@${instance.host}:${instance.port}/${cloneDb}`;
  const appUrl = new URL(env.P0_02_APP_DATABASE_URL);
  appUrl.pathname = `/${cloneDb}`;

  const { default: pg } = await import('pg');
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${cloneDb}"`);
    await admin.query(`CREATE DATABASE "${cloneDb}" TEMPLATE "${instance.dbName}"`);
  } finally {
    await admin.end();
  }
  console.log(`clone ready: ${cloneDb}`);

  const owner = new pg.Client({ connectionString: ownerUrl });
  await owner.connect();
  const app = new pg.Client({ connectionString: appUrl.toString() });
  await app.connect();

  const evidence = { runId, cloneDb, checks: results };
  const sqlText = fs.readFileSync(path.join(REPO_ROOT, SQL_FILE), 'utf8');

  async function asAdminApp(fn) {
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

  async function ingest(snapshot) {
    return asAdminApp(async (client) => {
      const res = await client.query('SELECT catalog.ingest_shipment_snapshot($1::jsonb) AS r', [
        JSON.stringify(snapshot),
      ]);
      return res.rows[0].r;
    });
  }

  async function list(params = {}) {
    return asAdminApp(async (client) => {
      const res = await client.query('SELECT catalog.read_shipment_list($1,$2,$3,$4,$5,$6,$7) AS r', [
        params.market ?? null, params.status ?? null, params.search ?? null, params.product ?? null,
        params.includeAbsent === true, params.limit ?? 100, params.offset ?? 0,
      ]);
      return res.rows[0].r;
    });
  }

  async function detail(shipmentId) {
    return asAdminApp(async (client) => {
      const res = await client.query('SELECT catalog.read_shipment_detail($1) AS r', [shipmentId]);
      return res.rows[0].r;
    });
  }

  async function sourceStatus() {
    return asAdminApp(async (client) => {
      const res = await client.query('SELECT catalog.read_shipment_source_status() AS r');
      return res.rows[0].r;
    });
  }

  async function tableDigest(table) {
    const row = (await owner.query(
      `SELECT count(*) AS n, coalesce(md5(string_agg(md5(t::text), '' ORDER BY md5(t::text))), '') AS h
       FROM ${table} t`)).rows[0];
    return { rows: Number(row.n), hash: row.h };
  }

  try {
    // ---- 0. 应用 026 两次（幂等）并清空克隆库 shipment* 业务数据 -----------
    await owner.query(sqlText);
    await owner.query('RESET ROLE; RESET ALL');
    await owner.query(sqlText);
    await owner.query('RESET ROLE; RESET ALL');
    evidence.applied = { file: SQL_FILE, applications: 2, idempotent: true };
    await owner.query(`TRUNCATE TABLE
      catalog.shipment_item_association_revision, catalog.shipment_item_revision,
      catalog.shipment_revision, catalog.shipment_item, catalog.shipment,
      catalog.shipment_source_snapshot CASCADE`);

    const allFunctions = (await owner.query(
      `SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args, p.prosecdef,
              p.proconfig, pg_catalog.has_function_privilege($1, p.oid, 'EXECUTE') AS app_exec
       FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='catalog' AND p.proname = ANY($2::text[])`, [APP_ROLE, FUNCTIONS.map(([name]) => name)])).rows;
    evidence.functions = allFunctions;
    check('9 个 RPC 存在、SECURITY DEFINER、search_path 锁定、app 可执行',
      FUNCTIONS.every(([name, signature]) => allFunctions.some((row) => row.proname === name
        && row.args === signature
        && row.prosecdef === true
        && Array.isArray(row.proconfig)
        && row.proconfig.some((entry) => /^search_path=(?:''|"")$/
          .test(String(entry).replace(/\s/g, '').toLowerCase()))
        && row.app_exec === true)),
      allFunctions.map((row) => [row.proname, row.args, row.app_exec]));
    check('旧的 6 参 read_shipment_list 已被移除',
      !allFunctions.some((row) => row.proname === 'read_shipment_list' && !row.args.includes('p_include_absent')),
      allFunctions.filter((row) => row.proname === 'read_shipment_list').map((row) => row.args));

    const tableState = (await owner.query(
      `SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS force_rls,
              pg_catalog.has_table_privilege($1, c.oid, 'SELECT') AS app_select
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='catalog' AND c.relname = ANY($2::text[]) ORDER BY c.relname`,
      [APP_ROLE, TABLES])).rows;
    const schemaVersion = (await owner.query('SELECT version FROM catalog.inventory_schema_state')).rows[0];
    check('6 张表 FORCE RLS 且 app 不能直接读写表',
      tableState.length === TABLES.length
      && tableState.every((row) => row.rls && row.force_rls && !row.app_select), tableState);
    check('inventory_schema_state.version 仍为 6', Number(schemaVersion.version) === 6, schemaVersion);

    const guardBefore = {};
    for (const table of GUARD_TABLES) guardBefore[table] = await tableDigest(table);

    // ---- 1. 基线入库：4 票 / 5 明细 ---------------------------------------
    let tickets = baseTickets();
    const snapshot1 = buildSnapshot({ revision: 2001, readFinishedAt: '2026-11-01T20:00:00.000Z', tickets });
    const ingest1 = await ingest(snapshot1);
    evidence.ingest1 = ingest1;
    check('基线入库新建 4 票 / 5 明细', ingest1.createdTickets === 4 && ingest1.createdItems === 5
      && ingest1.absentTickets === 0 && ingest1.absentItems === 0, ingest1);

    const list1 = await list();
    evidence.list1 = list1;
    check('列表 4 票、每行带 presentInLatestRead 与名称摘要',
      list1.total === 4 && list1.rows.length === 4
      && list1.rows.every((row) => row.presentInLatestRead === true)
      && list1.rows.every((row) => Array.isArray(row.productSummary)
        && row.productSummary.every((name) => typeof name === 'string')),
      { total: list1.total, counts: list1.counts });
    check('计数只落在 5 类且合计 4',
      list1.counts.inTransit + list1.counts.partial + list1.counts.arrivedPendingShelving
        + list1.counts.arrived + list1.counts.unknown === 4, list1.counts);

    // ---- 2. 剩余在途口径（5 种到货依据） -----------------------------------
    const rowA = list1.rows.find((row) => row.purchaseOrder === 'VERIFYPO001');
    const detailA = await detail(rowA.shipmentId);
    const [itemA1, itemA2] = detailA.items;
    check('received=60 / shipped=100 → 剩余 40（来源数量口径）',
      itemA1.receivedQuantity === 60 && itemA1.remainingQuantity === 40
      && itemA1.receiptBasis === 'source_quantity', itemA1);
    check('in_transit 且无来源到货数量 → received=0 / remaining=shipped',
      itemA2.receivedQuantity === 0 && itemA2.remainingQuantity === 30, itemA2);
    const rowB = list1.rows.find((row) => row.purchaseOrder === null && row.waybillsText === 'VERIFYWB001');
    const detailB = await detail(rowB.shipmentId);
    check('arrived → received=shipped（剩余 0）',
      detailB.items[0].receivedQuantity === 50 && detailB.items[0].remainingQuantity === 0
      && detailB.shipment.statusClass === 'arrived', detailB.items[0]);
    const rowD = list1.rows.find((row) => row.purchaseOrder === 'VERIFYPO002');
    const detailD = await detail(rowD.shipmentId);
    check('arrived_pending_shelving → 累计到货 0、仍计在途',
      detailD.shipment.statusClass === 'arrived_pending_shelving'
      && detailD.items[0].receiptBasis === 'status_awaiting_shelving_zero'
      && detailD.items[0].receivedQuantity === 0 && detailD.items[0].remainingQuantity === 20,
      { statusClass: detailD.shipment.statusClass, item: detailD.items[0] });
    const rowC = list1.rows.find((row) => row.market === 'PH');
    const detailC = await detail(rowC.shipmentId);
    check('unknown → received=null、remaining=null、state=pending（不写 0）',
      detailC.items[0].receivedQuantity === null && detailC.items[0].remainingQuantity === null
      && detailC.items[0].remainingState === 'pending', detailC.items[0]);

    // ---- 3. 同内容重复读取：unchanged，当前范围不变 ------------------------
    const snapshot1b = {
      ...snapshot1,
      collection: {
        ...snapshot1.collection,
        readStartedAt: '2026-11-01T20:05:00.000Z',
        readFinishedAt: '2026-11-01T20:05:00.000Z',
      },
    };
    const ingest2 = await ingest(snapshot1b);
    const list2 = await list();
    check('同内容重复读取 unchanged=true、0 修订、absent=0',
      ingest2.unchanged === true && ingest2.revisionsAdded === 0
      && ingest2.absentTickets === 0 && ingest2.absentItems === 0, ingest2);
    check('重复读取后当前列表仍是 4 票（未误使整批退出）', list2.total === 4, list2.total);

    // ---- 4. 明细数量/票状态变化 → 同票同明细更新、各 +1 修订 ----------------
    tickets = baseTickets();
    tickets[0].statusClass = 'partial';
    tickets[0].receivedBasis = 'pending';
    tickets[0].items[0].shippedQuantity = 120;
    const ingest3 = await ingest(
      buildSnapshot({ revision: 2002, readFinishedAt: '2026-11-01T20:10:00.000Z', tickets }),
    );
    evidence.ingest3 = ingest3;
    const detailA3 = await detail(rowA.shipmentId);
    const itemA1b = detailA3.items.find((entry) => entry.productNameRaw === '受控产品甲');
    // 票状态转 partial/pending 后两条明细的到货依据都变：1 票 + 2 明细 = 3 条新修订。
    check('变化后：票修订+1、明细各 +1（到货依据变化）、shipped 120、remaining 60',
      ingest3.updatedTickets === 1 && ingest3.updatedItems === 2 && ingest3.revisionsAdded === 3
      && detailA3.shipment.revision === 2 && itemA1b.revision === 2
      && itemA1b.shippedQuantity === 120 && itemA1b.remainingQuantity === 60,
      { ingest: ingest3, revision: detailA3.shipment.revision, item: itemA1b });
    check('变更记录含业务状态与发货量变化',
      detailA3.revisions.some((row) => row.changedFields.some((field) => field.includes('业务状态')))
      && detailA3.revisions.some((row) => row.changedFields.some((field) => field.includes('发货量'))),
      detailA3.revisions.map((row) => row.changedFields));

    // ---- 5. 身份待核：pending 透传；续接后回到 confirmed -------------------
    tickets.push(makeTicket({
      ticketKey: 'PO:VERIFYPO003', ticketNo: 'VERIFYPO003', sourceRowStart: 7, sourceRowEnd: 7,
      market: 'MY', purchaseOrder: 'VERIFYPO003', transportText: '10/30 已发出', arrivalText: null,
      statusClass: 'in_transit', receivedBasis: 'status_in_transit_zero',
      identityStatus: 'pending', identityNote: '采购单号变化且双方都没有运单号，无法唯一确认',
      items: [makeItem('受控产品己', 5, null, 7)],
    }));
    const ingest4 = await ingest(
      buildSnapshot({ revision: 2003, readFinishedAt: '2026-11-01T20:20:00.000Z', tickets }),
    );
    const list4 = await list();
    const pendingRow = list4.rows.find((row) => row.purchaseOrder === 'VERIFYPO003');
    evidence.identityPending = pendingRow;
    check('identityStatus=pending 透传到列表且带说明',
      ingest4.createdTickets === 1 && pendingRow.identityStatus === 'pending'
      && (pendingRow.identityNote ?? '').includes('无法唯一确认'), pendingRow);

    tickets = tickets.map((entry) => (entry.ticketKey === 'PO:VERIFYPO003'
      ? { ...entry, identityStatus: 'confirmed', identityNote: null, matchedShipmentId: pendingRow.shipmentId }
      : entry));
    await ingest(buildSnapshot({ revision: 2004, readFinishedAt: '2026-11-01T20:25:00.000Z', tickets }));
    const confirmedRow = (await list()).rows.find((row) => row.purchaseOrder === 'VERIFYPO003');
    check('续接后 identityStatus 回到 confirmed（同一 UUID）',
      confirmedRow.shipmentId === pendingRow.shipmentId && confirmedRow.identityStatus === 'confirmed',
      { before: pendingRow.identityStatus, after: confirmedRow.identityStatus });

    // ---- 6. 身份索引：含历史行与规范品名集合 ------------------------------
    const index = await asAdminApp(async (client) => {
      const res = await client.query('SELECT catalog.read_shipment_identity_index() AS r');
      return res.rows[0].r;
    });
    evidence.identityIndex = index;
    check('身份索引返回全部票且带规范品名集合',
      Array.isArray(index) && index.length === 5
      && index.every((row) => Array.isArray(row.productNameNorms))
      && index.some((row) => row.shipmentId === rowA.shipmentId && row.productNameNorms.length === 2),
      { count: index.length });

    // ---- 7. 来源移除：移除 1 票 + 1 明细 ----------------------------------
    const ticketB = (await list()).rows.find((row) => row.waybillsText === 'VERIFYWB001');
    const ticketBDetailBefore = await detail(ticketB.shipmentId);
    const ticketBSource = tickets.find((entry) => entry.waybillsText === 'VERIFYWB001');
    if (!ticketBSource) throw new Error('VERIFY_SETUP_FAILED:找不到要移除的票');
    tickets = tickets
      .filter((entry) => entry.ticketKey !== ticketBSource.ticketKey)
      .map((entry) => (entry.ticketKey === 'PO:VERIFYPO001'
        ? { ...entry, items: entry.items.filter((line) => line.productNameRaw !== '受控产品乙') }
        : entry));
    const ingest6 = await ingest(
      buildSnapshot({ revision: 2005, readFinishedAt: '2026-11-01T20:30:00.000Z', tickets }),
    );
    evidence.ingest6 = ingest6;
    check('移除 1 票 + 1 明细：absentTickets=1、absentItems=2',
      ingest6.absentTickets === 1 && ingest6.absentItems === 2, ingest6);

    const list6 = await list();
    const list6Absent = await list({ includeAbsent: true });
    evidence.list6 = list6;
    evidence.list6Absent = list6Absent;
    check('默认列表 4 票、不含被移除票',
      list6.total === 4 && !list6.rows.some((row) => row.shipmentId === ticketB.shipmentId),
      { total: list6.total, counts: list6.counts });
    check('包含历史行时 5 票、被移除票标 presentInLatestRead=false',
      list6Absent.total === 5
      && list6Absent.rows.filter((row) => row.presentInLatestRead === false).length === 1,
      { total: list6Absent.total });
    check('关键词搜索默认不再命中被移除票（包含历史行才命中）',
      (await list({ search: 'VERIFYWB001' })).total === 0
      && (await list({ search: 'VERIFYWB001', includeAbsent: true })).total === 1, null);

    const detailA6 = await detail(rowA.shipmentId);
    check('详情当前明细只剩 1 条、missingItems 保留被移除明细与原数量',
      detailA6.items.length === 1 && detailA6.shipment.itemCount === 1
      && detailA6.missingItems.length === 1
      && detailA6.missingItems[0].shippedQuantity === 30
      && detailA6.missingItems[0].remainingState === 'pending', detailA6.missingItems);
    const detailB6 = await detail(ticketB.shipmentId);
    check('整票本次未见：items=[]、itemCount=0、missingItems=该票全部明细（含原数量与 lastSeenAt）、presentInLatestRead=false、latestReadAt=本次成功快照时间',
      detailB6.shipment.presentInLatestRead === false
      && detailB6.shipment.itemCount === 0
      && detailB6.items.length === 0
      && detailB6.missingItems.length === ticketBDetailBefore.items.length
      && detailB6.missingItems.every((item) => {
        const before = ticketBDetailBefore.items.find((entry) => entry.itemId === item.itemId);
        return before !== undefined && before.shippedQuantity === item.shippedQuantity
          && typeof item.lastSeenAt === 'string' && item.lastSeenAt !== '';
      })
      && new Date(detailB6.latestReadAt).toISOString() === '2026-11-01T20:30:00.000Z',
      {
        itemCount: detailB6.shipment.itemCount,
        items: detailB6.items.length,
        missingItems: detailB6.missingItems.length,
        beforeCount: ticketBDetailBefore.items.length,
        latestReadAt: detailB6.latestReadAt,
      });
    check('单明细移除票：items 少一条、missingItems 有该条、latestReadAt 与整票退出场景一致',
      detailA6.items.length === 1 && detailA6.missingItems.length === 1
      && new Date(detailA6.latestReadAt).toISOString() === '2026-11-01T20:30:00.000Z',
      { items: detailA6.items.length, missingItems: detailA6.missingItems.length, latestReadAt: detailA6.latestReadAt });

    // 同内容重复读取与失败读取都不能让现有票退出。
    const snapshot6b = buildSnapshot({ revision: 2005, readFinishedAt: '2026-11-01T20:35:00.000Z', tickets });
    const ingest7 = await ingest({
      ...snapshot6b,
      collection: {
        ...snapshot6b.collection,
        readStartedAt: '2026-11-01T20:35:00.000Z',
        readFinishedAt: '2026-11-01T20:35:00.000Z',
      },
    });
    check('移除后同内容重复读取 unchanged 且 absent 不变',
      ingest7.unchanged === true && ingest7.absentTickets === 1 && ingest7.absentItems === 2, ingest7);
    const statusBefore = await sourceStatus();
    const failure = await asAdminApp(async (client) => {
      const res = await client.query('SELECT catalog.record_shipment_read_failure($1::jsonb) AS r', [
        JSON.stringify({
          sourceKey: 'feishu_logistics_sheet',
          readAt: '2026-11-01T20:40:00.000Z',
          errorCode: 'SOURCE_CLI_FAILED',
          errorMessage: '受控失败：不写业务数据',
        }),
      ]);
      return res.rows[0].r;
    });
    const statusAfter = await sourceStatus();
    const listAfterFailure = await list();
    evidence.failure = { failure, statusBefore, statusAfter };
    check('失败快照：lastAttempt=failed、lastSuccess 不变、当前列表不变',
      failure.ok === true && statusAfter.lastAttempt.status === 'failed'
      && statusAfter.lastSuccess.snapshotId === statusBefore.lastSuccess.snapshotId
      && listAfterFailure.total === 4, { lastSuccess: statusAfter.lastSuccess.snapshotId });

    // ---- 8. 商品关联：保存 / 冲突 / 重复读取保留 --------------------------
    const productRow = (await owner.query(
      `SELECT c.item_id, c.ice_code FROM catalog.catalog_item_code c ORDER BY c.ice_code LIMIT 1`)).rows[0];
    const itemA = detailA6.items[0];
    const association = await asAdminApp(async (client) => {
      const res = await client.query('SELECT catalog.update_shipment_item_association($1,$2,$3,$4) AS r',
        [itemA.itemId, productRow.item_id, itemA.revision, '隔离验证：人工关联']);
      return res.rows[0].r;
    });
    evidence.association = association;
    check('人工关联保存：manual、revision+1',
      association.ok === true && association.associationStatus === 'manual'
      && association.revision === itemA.revision + 1, association);
    const detailA7 = await detail(rowA.shipmentId);
    check('详情返回关联 ICE 货号',
      detailA7.items[0].product?.itemId === productRow.item_id
      && detailA7.items[0].product?.iceCode === productRow.ice_code, detailA7.items[0].product);
    const conflict = await asAdminApp(async (client) => {
      const res = await client.query('SELECT catalog.update_shipment_item_association($1,$2,$3,$4) AS r',
        [itemA.itemId, null, itemA.revision, '隔离验证：过期版本']);
      return res.rows[0].r;
    });
    const afterConflict = await detail(rowA.shipmentId);
    check('错 expected_revision：结构化冲突且未改数据',
      conflict.ok === false && conflict.errorCode === 'SHIPMENT_REVISION_CONFLICT'
      && afterConflict.items[0].product?.itemId === productRow.item_id, conflict);
    await ingest(buildSnapshot({ revision: 2006, readFinishedAt: '2026-11-01T20:50:00.000Z', tickets }));
    const afterReingest = await detail(rowA.shipmentId);
    check('再次读取后人工关联保留',
      afterReingest.items[0].product?.itemId === productRow.item_id
      && afterReingest.items[0].associationStatus === 'manual', afterReingest.items[0].product);

    // ---- 9. 权限负向：app 直连表 / 未授权函数 / 无 JWT --------------------
    const denials = await asAdminApp(async (client) => {
      const attempts = [
        ['insert_shipment', 'INSERT INTO catalog.shipment(id) VALUES(gen_random_uuid())'],
        ['select_shipment', 'SELECT * FROM catalog.shipment'],
        ['helper_function', `SELECT catalog.shipment_display_value('status_class','"arrived"'::jsonb)`],
      ];
      const out = {};
      for (const [name, sql] of attempts) {
        await client.query('SAVEPOINT perm');
        try {
          await client.query(sql);
          out[name] = { denied: false };
        } catch (error) {
          out[name] = { denied: true, code: error.code };
        }
        await client.query('ROLLBACK TO SAVEPOINT perm');
      }
      return out;
    });
    evidence.denials = denials;
    check('app 不能直接读写表、不能执行未授权辅助函数',
      denials.insert_shipment.denied && denials.select_shipment.denied && denials.helper_function.denied,
      denials);
    const anonymous = await (async () => {
      await app.query('BEGIN');
      try {
        await app.query(`SELECT set_config('request.jwt.claim.sub','',true)`);
        await app.query('SELECT catalog.read_shipment_list(NULL,NULL,NULL,NULL,false,10,0)');
        await app.query('ROLLBACK');
        return { denied: false };
      } catch (error) {
        await app.query('ROLLBACK');
        return { denied: true, code: error.code };
      }
    })();
    check('app 无管理员 JWT 时读取函数拒绝（require_admin）', anonymous.denied === true, anonymous);

    // ---- 10. 库存/商品/映射/国内决定表未被写入 ---------------------------
    const guardAfter = {};
    for (const table of GUARD_TABLES) guardAfter[table] = await tableDigest(table);
    const changed = GUARD_TABLES.filter((table) => (
      guardBefore[table].rows !== guardAfter[table].rows
      || guardBefore[table].hash !== guardAfter[table].hash
    ));
    evidence.guard = { before: guardBefore, after: guardAfter, changed };
    check('10 张库存/商品/映射/国内决定表行数与内容哈希不变', changed.length === 0, changed);

    const failed = results.filter((row) => !row.ok);
    evidence.summary = { total: results.length, failed: failed.length };
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    const evidenceFile = path.join(EVIDENCE_DIR, `verify-026-${stamp}.json`);
    fs.writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(`\n证据：${evidenceFile}`);
    console.log(`结果：${results.length - failed.length}/${results.length} 通过；克隆库 ${cloneDb}（保留）`);
    if (failed.length > 0) process.exitCode = 1;
  } finally {
    await app.end();
    await owner.end();
  }
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
