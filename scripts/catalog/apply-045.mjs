/**
 * 把 045「成员按授权物流市场查看物流在途 v1」应用到一个 catalog 库。
 *
 * 045 只做四件事：
 *   1. 新表 account_access_market（账号的物流市场范围，与仓库范围独立）；
 *   2. 成员物流读取守卫 require_shipment_read / access_member_markets；
 *   3. 货票列表、详情、人工修正索引/历史、读取状态按授权市场收窄（管理员口径不变）；
 *   4. 账号管理 RPC 读写物流市场；成员权限摘要补 canViewShipment / shipmentMarkets。
 *
 * 模式（默认绝不改目标库）：
 *   --rollback（默认）：事务内安装两次 → 结构/行为探针 → ROLLBACK
 *   --commit          ：安装 → 回读 → 事务内探针 → COMMIT
 *   安全闸门：目标库名等于现役库名时 --commit 必须显式 --allow-live-commit。
 *
 * 用法：
 *   node scripts/catalog/apply-045.mjs --rollback --run-id run-20261026T211500Z-11a22b33
 *   node scripts/catalog/apply-045.mjs --commit --allow-live-commit --run-id run-20261026T211500Z-11a22b33
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(path.join(REPO_ROOT, 'package.json'));
const pg = require('pg');

const DEFAULT_RUN_ID = 'run-20261026T211500Z-11a22b33';
const SQL_FILE = 'db/catalog/045_member_logistics_markets.sql';
const APP_ROLE = 'ice_p0_02_app_runner';
const ADMIN_PROFILE_ID = '11111111-1111-4111-8111-111111111101';
const MEMBER_PROFILE_ID = 'b6c8c63b-ad58-42f7-97f7-baa0b7e79b90';
const EVIDENCE_DIR = path.join(REPO_ROOT, '.local', 'catalog', 'member-logistics-markets-v1-20261118');

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

function readRun(runId) {
  const runRoot = path.join(REPO_ROOT, '.local', 'catalog', runId);
  const instance = JSON.parse(fs.readFileSync(path.join(runRoot, 'instance', 'catalog-instance.json'), 'utf8'));
  const ownerUrl = `postgres://${instance.bootstrapUser}:${instance.bootstrapPassword}@${instance.host}:${instance.port}/${instance.dbName}`;
  return { runRoot, instance, ownerUrl };
}

function databaseNameOf(url) {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
}

function check(results, name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail === undefined ? '' : ` :: ${JSON.stringify(detail).slice(0, 400)}`}`);
}

function searchPathLocked(proconfig) {
  return Array.isArray(proconfig)
    && proconfig.some((entry) => /^search_path=(?:''|"")?$/.test(String(entry).replace(/\s/g, '').toLowerCase()));
}

const functionStateSql = `SELECT p.proname,
  pg_get_function_identity_arguments(p.oid) AS identity_args,
  p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner_name,
  position('require_shipment_read()' in p.prosrc) AS shipment_guard,
  position('access_member_markets()' in p.prosrc) AS market_filter,
  pg_catalog.has_function_privilege($1, p.oid, 'EXECUTE') AS app_exec,
  pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='catalog' AND p.proname=$2
 ORDER BY identity_args`;

const countsSql = `SELECT
  (SELECT count(*) FROM catalog.catalog_item)::int AS items,
  (SELECT count(*) FROM catalog.shipment)::int AS shipments,
  (SELECT count(*) FROM catalog.shipment_item)::int AS shipment_items,
  (SELECT count(*) FROM catalog.audit_event)::int AS audit_events,
  (SELECT count(*) FROM catalog.inventory_audit)::int AS inventory_audits,
  (SELECT count(*) FROM public.profiles)::int AS profiles,
  (SELECT count(*) FROM catalog.access_role)::int AS access_roles`;

/** 045 之前表可能不存在：单独读取，缺失按 0（不把「未安装」当成失败）。 */
async function readCounts(owner) {
  const row = (await owner.query(countsSql)).rows[0];
  let accessMarkets = 0;
  try {
    accessMarkets = Number((await owner.query(
      'SELECT count(*)::int AS n FROM catalog.account_access_market')).rows[0].n);
  } catch {
    accessMarkets = 0;
  }
  return { ...row, access_markets: accessMarkets };
}

async function install(owner, sql) {
  await owner.query(sql);
  await owner.query('RESET ROLE; RESET ALL');
}

async function callJson(owner, spec, params = []) {
  const placeholders = params.map((_, index) => `$${index + 1}`).join(', ');
  const sql = params.length > 0 ? `SELECT ${spec}(${placeholders}) AS r` : `SELECT ${spec}() AS r`;
  const rows = (await owner.query(sql, params)).rows;
  return rows[0]?.r ?? null;
}

async function asRole(owner, role, profileId, fn) {
  await owner.query(`SET LOCAL ROLE ${role}`);
  if (profileId) await owner.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [profileId]);
  try {
    return await fn();
  } finally {
    await owner.query('RESET ROLE; RESET ALL');
  }
}

async function expectFailureAs(owner, role, profileId, spec, params = []) {
  await owner.query('SAVEPOINT probe_fail');
  await owner.query(`SET LOCAL ROLE ${role}`);
  if (profileId) await owner.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [profileId]);
  let message = null;
  try {
    await callJson(owner, spec, params);
  } catch (error) {
    message = error.message;
  } finally {
    await owner.query('ROLLBACK TO SAVEPOINT probe_fail');
    await owner.query('RELEASE SAVEPOINT probe_fail');
    await owner.query('RESET ROLE; RESET ALL');
  }
  return message;
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  const run = readRun(args['run-id'] ?? DEFAULT_RUN_ID);
  const targetUrl = args['database-url'] ?? run.ownerUrl;
  const liveName = run.instance.dbName;
  const targetName = databaseNameOf(targetUrl);
  const commit = args.commit === true;
  if (commit && targetName === liveName && args['allow-live-commit'] !== true) {
    throw new Error('CATALOG_SQL_INCREMENT_LIVE_COMMIT_DENIED: add --allow-live-commit for the live database');
  }
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const sql = fs.readFileSync(path.join(REPO_ROOT, SQL_FILE), 'utf8');
  const results = [];
  const owner = new pg.Client({ connectionString: targetUrl });
  await owner.connect();
  const evidence = {
    mode: commit ? 'commit' : 'rollback',
    targetDatabase: targetName,
    sqlFile: SQL_FILE,
    sqlSha256: crypto.createHash('sha256').update(sql).digest('hex'),
    finishedAt: null,
  };
  try {
    const countsBefore = await readCounts(owner);
    evidence.countsBefore = countsBefore;

    await owner.query('BEGIN');
    await install(owner, sql);
    await install(owner, sql);
    check(results, '045 安装两次均成功（幂等，无报错）', true, { applications: 2 });

    // 1. 表与权限
    const table = (await owner.query(
      `SELECT c.relrowsecurity,c.relforcerowsecurity,
        (SELECT count(*)::int FROM pg_policies WHERE schemaname='catalog' AND tablename='account_access_market') AS policies
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='catalog' AND c.relname='account_access_market'`)).rows[0];
    const tableAcl = (await owner.query(
      `SELECT pg_catalog.has_table_privilege($1,'catalog.account_access_market','SELECT') AS app_select,
              pg_catalog.has_table_privilege($1,'catalog.account_access_market','INSERT') AS app_insert`,
      [APP_ROLE])).rows[0];
    check(results, 'account_access_market：强制 RLS，两条策略，app 角色无直接表权限',
      table?.relrowsecurity === true && table?.relforcerowsecurity === true
      && Number(table?.policies) === 2 && tableAcl?.app_select === false && tableAcl?.app_insert === false,
      { table, tableAcl });

    // 2. 函数结构/权限
    const guards = (await owner.query(functionStateSql, [APP_ROLE, 'require_shipment_read'])).rows;
    const listFn = (await owner.query(functionStateSql, [APP_ROLE, 'read_shipment_list'])).rows;
    const detailFn = (await owner.query(functionStateSql, [APP_ROLE, 'read_shipment_detail'])).rows;
    const manualFn = (await owner.query(functionStateSql, [APP_ROLE, 'read_shipment_manual_index'])).rows;
    const historyFn = (await owner.query(functionStateSql, [APP_ROLE, 'read_shipment_manual_history'])).rows;
    const statusFn = (await owner.query(functionStateSql, [APP_ROLE, 'read_shipment_source_status'])).rows;
    const optionsFn = (await owner.query(functionStateSql, [APP_ROLE, 'read_access_market_options'])).rows;
    const createFn = (await owner.query(functionStateSql, [APP_ROLE, 'create_access_account'])).rows;
    const updateFn = (await owner.query(functionStateSql, [APP_ROLE, 'update_access_account'])).rows;
    check(results, '物流读取函数全部换成成员守卫：SECURITY DEFINER、search_path 锁定、属主为 owner、app 可执行、public 不可执行',
      guards.length === 1 && [listFn, detailFn, manualFn, historyFn, statusFn, optionsFn, createFn, updateFn]
        .every((rows) => rows.length === 1 && rows[0].prosecdef === true && searchPathLocked(rows[0].proconfig)
          && rows[0].owner_name === 'ice_p0_02_owner' && rows[0].app_exec === true && rows[0].public_exec === false),
      {
        guard: guards.length, list: listFn.length, detail: detailFn.length, manual: manualFn.length,
        history: historyFn.length, status: statusFn.length, options: optionsFn.length,
        create: createFn.length, update: updateFn.length,
      });
    const oldCreateCount = (await owner.query(
      `SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='catalog' AND p.proname='create_access_account'
         AND pg_get_function_identity_arguments(p.oid)='text, text, text, uuid, uuid[], boolean'`)).rows[0].n;
    check(results, '列表/详情/人工索引/人工历史都带市场过滤；旧的无市场参数建号/改号函数已移除',
      listFn[0]?.market_filter > 0 && detailFn[0]?.market_filter > 0 && manualFn[0]?.market_filter > 0
      && historyFn[0]?.market_filter > 0 && listFn[0]?.shipment_guard > 0 && detailFn[0]?.shipment_guard > 0
      && createFn[0]?.identity_args?.includes('text[]') && updateFn[0]?.identity_args?.includes('text[]')
      && Number(oldCreateCount) === 0,
      { list: listFn[0]?.market_filter, detail: detailFn[0]?.market_filter, manual: manualFn[0]?.market_filter });

    // 3. 成员无授权：列表被拒
    const latest = (await owner.query(
      'SELECT catalog.shipment_latest_success_snapshot(catalog.shipment_current_source_key()) AS id')).rows[0].id;
    const vietnamCount = Number((await owner.query(
      `SELECT count(*)::int AS n FROM catalog.shipment s
       WHERE s.market='越南' AND ($1::uuid IS NULL OR s.last_seen_snapshot_id=$1)`, [latest])).rows[0].n);
    const thaiTicket = (await owner.query(
      `SELECT s.id FROM catalog.shipment s WHERE s.market='泰国'
       ORDER BY s.ticket_no LIMIT 1`)).rows[0]?.id;

    await owner.query('SAVEPOINT member_probe');
    await owner.query('DELETE FROM catalog.account_access_market WHERE profile_id=$1', [MEMBER_PROFILE_ID]);
    const deniedList = await expectFailureAs(owner, APP_ROLE, MEMBER_PROFILE_ID, 'catalog.read_shipment_list',
      [null, null, null, null, false, 20, 0]);
    check(results, '未授予物流市场：列表守卫拒绝（CATALOG_FORBIDDEN），看不到任何货票',
      deniedList === 'CATALOG_FORBIDDEN', { error: deniedList });

    const accessOff = await asRole(owner, APP_ROLE, MEMBER_PROFILE_ID,
      async () => callJson(owner, 'catalog.read_my_inventory_access'));
    check(results, '未授予物流市场：权限摘要 canViewShipment=false、市场清单为空',
      accessOff?.canViewShipment === false && (accessOff?.shipmentMarkets ?? []).length === 0,
      { canViewShipment: accessOff?.canViewShipment, markets: accessOff?.shipmentMarkets });

    // 4. 授予越南：列表/详情/索引只含越南
    await owner.query(
      `INSERT INTO catalog.account_access_market(profile_id,market) VALUES($1,'越南')
       ON CONFLICT DO NOTHING`, [MEMBER_PROFILE_ID]);
    const accessOn = await asRole(owner, APP_ROLE, MEMBER_PROFILE_ID,
      async () => callJson(owner, 'catalog.read_my_inventory_access'));
    check(results, '授予越南后：权限摘要 canViewShipment=true、shipmentMarkets=[越南]',
      accessOn?.canViewShipment === true && JSON.stringify(accessOn?.shipmentMarkets) === JSON.stringify(['越南']),
      { canViewShipment: accessOn?.canViewShipment, markets: accessOn?.shipmentMarkets });

    const memberList = await asRole(owner, APP_ROLE, MEMBER_PROFILE_ID,
      async () => callJson(owner, 'catalog.read_shipment_list', [null, null, null, null, false, 100, 0]));
    const memberRows = memberList?.rows ?? [];
    check(results, '成员列表：计数、市场清单与分页行都只含越南，计数与数据库一致',
      memberRows.length > 0 && Number(memberList?.counts?.total) === vietnamCount
      && Number(memberList?.total) === vietnamCount
      && memberRows.every((row) => row.market === '越南')
      && (memberList?.markets ?? []).every((row) => row.market === '越南'),
      { dbVietnam: vietnamCount, memberTotal: memberList?.total, counts: memberList?.counts, markets: memberList?.markets });

    const memberStatus = await asRole(owner, APP_ROLE, MEMBER_PROFILE_ID,
      async () => callJson(owner, 'catalog.read_shipment_source_status'));
    check(results, '成员读取状态：保留上次成功时间/最近尝试，不返回跨市场票数或错误正文',
      Boolean(memberStatus?.lastSuccess?.readAt)
      && memberStatus?.lastSuccess?.ticketCount === undefined
      && memberStatus?.lastAttempt?.errorMessage === undefined,
      { lastSuccess: memberStatus?.lastSuccess, lastAttempt: memberStatus?.lastAttempt });

    const memberIndex = await asRole(owner, APP_ROLE, MEMBER_PROFILE_ID,
      async () => callJson(owner, 'catalog.read_shipment_manual_index'));
    const allShipmentMarket = new Map((await owner.query(
      'SELECT id, market FROM catalog.shipment')).rows.map((row) => [row.id, row.market]));
    check(results, '成员人工修正索引：只含越南票（与列表同一范围；历史票也按市场收窄）',
      (memberIndex?.shipments ?? []).length > 0
      && (memberIndex?.shipments ?? []).every((row) => allShipmentMarket.get(row.shipmentId) === '越南')
      && (memberIndex?.items ?? []).every((row) => allShipmentMarket.get(row.shipmentId) === '越南'),
      { shipments: (memberIndex?.shipments ?? []).length, items: (memberIndex?.items ?? []).length });

    const vnTicket = memberRows[0]?.shipmentId;
    const memberDetail = vnTicket ? await asRole(owner, APP_ROLE, MEMBER_PROFILE_ID,
      async () => callJson(owner, 'catalog.read_shipment_detail', [vnTicket])) : null;
    check(results, '成员详情：能打开授权市场的票，且票面市场为越南',
      Boolean(memberDetail?.shipment?.shipmentId) && memberDetail?.shipment?.market === '越南',
      { ticket: memberDetail?.shipment?.ticketNo, market: memberDetail?.shipment?.market });

    const memberThaiDetail = thaiTicket ? await asRole(owner, APP_ROLE, MEMBER_PROFILE_ID,
      async () => callJson(owner, 'catalog.read_shipment_detail', [thaiTicket])) : null;
    check(results, '成员打开未授权市场（泰国）的货票直链：返回 NULL，不暴露票面',
      memberThaiDetail === null, { ticket: thaiTicket });

    const adminThaiDetail = thaiTicket ? await asRole(owner, APP_ROLE, ADMIN_PROFILE_ID,
      async () => callJson(owner, 'catalog.read_shipment_detail', [thaiTicket])) : null;
    check(results, '管理员同一张泰国票仍可读取（管理员口径未被收窄）',
      Boolean(adminThaiDetail?.shipment?.shipmentId) && adminThaiDetail?.shipment?.market === '泰国',
      { ticket: adminThaiDetail?.shipment?.ticketNo });

    // 5. 管理员账号读写物流市场 + 只认真实市场
    const marketOptions = await asRole(owner, APP_ROLE, ADMIN_PROFILE_ID,
      async () => callJson(owner, 'catalog.read_access_market_options'));
    check(results, '管理员物流市场选项：来自飞书物流表的真实市场（含越南），带票数',
      (marketOptions?.markets ?? []).some((row) => row.market === '越南' && Number(row.ticketCount) > 0)
      && (marketOptions?.markets ?? []).length >= 2,
      marketOptions?.markets);

    const sanitized = (await owner.query(
      "SELECT catalog.access_market_list(ARRAY['越南','不存在市场',' 越南 ']) AS r")).rows[0].r;
    check(results, '市场入库前只保留物流表真实存在的值（去空白/去重/丢弃未知市场）',
      JSON.stringify(sanitized) === JSON.stringify(['越南']), { sanitized });

    const roleId = (await owner.query(
      'SELECT access_role_id AS id FROM catalog.account_access WHERE profile_id=$1',
      [MEMBER_PROFILE_ID])).rows[0].id;
    const warehouseIds = (await owner.query(
      "SELECT coalesce(array_agg(warehouse_id),'{}'::uuid[]) AS ids FROM catalog.account_access_warehouse WHERE profile_id=$1",
      [MEMBER_PROFILE_ID])).rows[0].ids;
    await asRole(owner, APP_ROLE, ADMIN_PROFILE_ID, async () => callJson(owner,
      'catalog.update_access_account',
      [MEMBER_PROFILE_ID, '验收成员V1', roleId, true, warehouseIds, ['越南', '菲律宾']]));
    const savedAccount = await asRole(owner, APP_ROLE, ADMIN_PROFILE_ID,
      async () => callJson(owner, 'catalog.read_access_account', [MEMBER_PROFILE_ID]));
    check(results, '管理员保存账号物流市场：回读为越南+菲律宾，仓库授权未受影响',
      JSON.stringify(savedAccount?.logisticsMarkets) === JSON.stringify(['菲律宾', '越南'])
      && (savedAccount?.warehouses ?? []).length > 0,
      { markets: savedAccount?.logisticsMarkets, warehouses: (savedAccount?.warehouses ?? []).length });

    const rowAfterSave = await asRole(owner, APP_ROLE, ADMIN_PROFILE_ID,
      async () => callJson(owner, 'catalog.access_account_rows', [null, null, null, 100, 0]));
    const memberRow = (rowAfterSave?.accounts ?? []).find((row) => row.profileId === MEMBER_PROFILE_ID);
    check(results, '账号列表带物流市场列（角色/仓库范围字段保持原样）',
      JSON.stringify(memberRow?.logisticsMarkets) === JSON.stringify(['菲律宾', '越南'])
      && typeof memberRow?.warehouseCount === 'number',
      { markets: memberRow?.logisticsMarkets });

    const auditRow = (await owner.query(
      `SELECT detail FROM catalog.inventory_audit WHERE action='access_account_updated'
       ORDER BY at DESC LIMIT 1`)).rows[0];
    check(results, '改账号范围留痕含物流市场前后值',
      JSON.stringify(auditRow?.detail?.after?.logisticsMarkets) === JSON.stringify(['菲律宾', '越南'])
      && Array.isArray(auditRow?.detail?.before?.logisticsMarkets),
      { after: auditRow?.detail?.after?.logisticsMarkets });

    // 建号（带市场）在事务内验证后回滚
    const newAuth = crypto.randomUUID();
    const roleRow = (await owner.query(
      "SELECT id FROM catalog.access_role WHERE preset_key='ops' LIMIT 1")).rows[0];
    const created = await asRole(owner, APP_ROLE, ADMIN_PROFILE_ID, async () => callJson(owner,
      'catalog.create_access_account',
      [newAuth, `probe-${newAuth.slice(0, 8)}@catalog.test`, '物流市场探针', roleRow.id, [], true, ['越南']]));
    const createdDetail = await asRole(owner, APP_ROLE, ADMIN_PROFILE_ID,
      async () => callJson(owner, 'catalog.read_access_account', [created?.profileId]));
    check(results, '新建账号可同时落物流市场（越南），登录账号与仓库范围按原规则',
      created?.ok === true && JSON.stringify(createdDetail?.logisticsMarkets) === JSON.stringify(['越南'])
      && createdDetail?.isActive === true,
      { profileId: created?.profileId, markets: createdDetail?.logisticsMarkets });

    // 停用账号后市场授权仍在但读取被拒
    await owner.query('UPDATE public.profiles SET is_active=false WHERE id=$1', [MEMBER_PROFILE_ID]);
    const inactiveDenied = await expectFailureAs(owner, APP_ROLE, MEMBER_PROFILE_ID, 'catalog.read_shipment_list',
      [null, null, null, null, false, 20, 0]);
    check(results, '停用成员：即使仍有物流市场授权也不能读取（CATALOG_FORBIDDEN）',
      inactiveDenied === 'CATALOG_FORBIDDEN', { error: inactiveDenied });

    // 货值/改票/绑定仍限管理员
    const valueDenied = await expectFailureAs(owner, APP_ROLE, MEMBER_PROFILE_ID,
      'catalog.read_shipment_market_summary', ['越南']);
    const vnItemId = vnTicket ? (await owner.query(
      'SELECT id FROM catalog.shipment_item WHERE shipment_id=$1 LIMIT 1', [vnTicket])).rows[0]?.id : null;
    const associationDenied = await expectFailureAs(owner, APP_ROLE, MEMBER_PROFILE_ID,
      'catalog.update_shipment_item_association', [vnItemId ?? crypto.randomUUID(), null, 1, 'probe']);
    check(results, '成员仍不能读货值汇总、不能改商品绑定（管理员写入口未放开）',
      valueDenied === 'CATALOG_FORBIDDEN' && associationDenied === 'CATALOG_FORBIDDEN',
      { value: valueDenied, association: associationDenied });

    // 探针回滚：不留下市场授权/账号/审计/建号探针
    await owner.query('ROLLBACK TO SAVEPOINT member_probe');
    await owner.query('RELEASE SAVEPOINT member_probe');

    const countsAfterProbe = await readCounts(owner);
    evidence.countsAfterProbe = countsAfterProbe;
    check(results, '探针回滚后业务行数与安装前一致（未写业务数据）',
      JSON.stringify(countsBefore) === JSON.stringify(countsAfterProbe),
      { before: countsBefore, after: countsAfterProbe });

    if (commit) {
      await owner.query('COMMIT');
      await owner.query('BEGIN');
      const postList = (await owner.query(functionStateSql, [APP_ROLE, 'read_shipment_list'])).rows[0];
      const postDetail = (await owner.query(functionStateSql, [APP_ROLE, 'read_shipment_detail'])).rows[0];
      const postTable = (await owner.query(
        "SELECT to_regclass('catalog.account_access_market') IS NOT NULL AS present")).rows[0].present;
      const postOptions = await asRole(owner, APP_ROLE, ADMIN_PROFILE_ID,
        async () => callJson(owner, 'catalog.read_access_market_options'));
      const postMember = await asRole(owner, APP_ROLE, MEMBER_PROFILE_ID,
        async () => callJson(owner, 'catalog.read_my_inventory_access'));
      const countsAfter = await readCounts(owner);
      await owner.query('ROLLBACK');
      evidence.afterCommit = {
        table: postTable,
        listGuard: postList?.shipment_guard > 0,
        detailGuard: postDetail?.shipment_guard > 0,
        markets: (postOptions?.markets ?? []).map((row) => row.market),
        memberCanViewShipment: postMember?.canViewShipment,
        memberMarkets: postMember?.shipmentMarkets,
        accessMarkets: countsAfter.access_markets,
      };
      check(results, '提交后回读：表/守卫/市场选项在位，成员原有授权未被改动（默认无物流市场）',
        postTable === true && postList?.shipment_guard > 0 && postDetail?.shipment_guard > 0
        && (postOptions?.markets ?? []).length >= 2
        && postMember?.canViewShipment === false
        && Number(countsAfter.access_markets) === Number(countsBefore.access_markets),
        evidence.afterCommit);
    } else {
      await owner.query('ROLLBACK');
      const countsAfterRollback = await readCounts(owner);
      check(results, 'rollback 后业务行数不变', JSON.stringify(countsBefore) === JSON.stringify(countsAfterRollback));
    }

    evidence.results = results;
    evidence.passed = results.every((item) => item.ok);
    evidence.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(EVIDENCE_DIR, commit ? 'apply-045-commit.json' : 'apply-045.json'),
      `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(`\n${evidence.passed ? 'ALL PASS' : 'HAS FAILURES'} :: ${evidence.mode} :: ${targetName}`
      + ` :: checks=${results.length} fail=${results.filter((item) => !item.ok).length}`);
    if (!evidence.passed) process.exitCode = 1;
  } catch (error) {
    try { await owner.query('ROLLBACK'); } catch { /* ignore */ }
    evidence.error = { message: error.message, code: error.code, stack: String(error.stack).slice(0, 2000) };
    evidence.results = results;
    evidence.passed = false;
    evidence.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(EVIDENCE_DIR, commit ? 'apply-045-commit.json' : 'apply-045.json'),
      `${JSON.stringify(evidence, null, 2)}\n`);
    console.error('[apply-045] failed:', error.message);
    process.exitCode = 1;
  } finally {
    await owner.end().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
