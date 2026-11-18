/**
 * 把 046「成员物流在途 v1 补修」应用到一个 catalog 库。
 *
 * 046 只修两处：
 *   1. read_shipment_manual_index() 恢复 030 的冲突字段（manualConflictCount / shippedQuantity /
 *      manualShippedQuantity / previousConfirmedShelvedQuantity / manualConflict），保留 045 的市场过滤；
 *   2. update_access_account() 审计 before.isActive 改为保存前的数据库值。
 *
 * 模式（默认绝不改目标库）：
 *   --rollback（默认）：事务内安装两次 → 结构/行为探针（含冲突样例、启停审计）→ ROLLBACK
 *   --commit          ：安装 → 回读 → 事务内探针 → COMMIT
 *   安全闸门：目标库名等于现役库名时 --commit 必须显式 --allow-live-commit。
 *
 * 用法：
 *   node scripts/catalog/apply-046.mjs --rollback --run-id run-20261026T211500Z-11a22b33
 *   node scripts/catalog/apply-046.mjs --commit --allow-live-commit --run-id run-20261026T211500Z-11a22b33
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
const SQL_FILE = 'db/catalog/046_member_logistics_markets_fixes.sql';
const APP_ROLE = 'ice_p0_02_app_runner';
const ADMIN_PROFILE_ID = '11111111-1111-4111-8111-111111111101';
const MEMBER_PROFILE_ID = 'b6c8c63b-ad58-42f7-97f7-baa0b7e79b90';
const COST_PRODUCT_ID = '92799bd6-3e8b-4cbc-9fa7-7a4c8beb3293'; // LS101311，采用成本 2.2
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
  position('manualConflictCount' in p.prosrc) AS conflict_count,
  position('previousConfirmedShelvedQuantity' in p.prosrc) AS shelved_field,
  position('''isActive'',p.is_active' in p.prosrc) AS audit_before_fixed,
  pg_catalog.has_function_privilege($1, p.oid, 'EXECUTE') AS app_exec,
  pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='catalog' AND p.proname=$2
 ORDER BY identity_args`;

const countsSql = `SELECT
  (SELECT count(*) FROM catalog.catalog_item)::int AS items,
  (SELECT count(*) FROM catalog.shipment)::int AS shipments,
  (SELECT count(*) FROM catalog.shipment_item)::int AS shipment_items,
  (SELECT count(*) FROM catalog.inventory_audit)::int AS inventory_audits,
  (SELECT count(*) FROM catalog.account_access_market)::int AS access_markets`;

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
    const countsBefore = (await owner.query(countsSql)).rows[0];
    evidence.countsBefore = countsBefore;

    await owner.query('BEGIN');
    await install(owner, sql);
    await install(owner, sql);
    check(results, '046 安装两次均成功（幂等，无报错）', true, { applications: 2 });

    // 1. 结构：冲突字段恢复 + 市场过滤仍在 + 审计取值修正
    const manualFn = (await owner.query(functionStateSql, [APP_ROLE, 'read_shipment_manual_index'])).rows[0];
    const updateFn = (await owner.query(functionStateSql, [APP_ROLE, 'update_access_account'])).rows[0];
    check(results, '人工索引恢复冲突字段，且保留成员守卫/市场过滤；函数权限不变',
      manualFn?.shipment_guard > 0 && manualFn?.market_filter > 0 && manualFn?.conflict_count > 0
      && manualFn?.shelved_field > 0 && manualFn?.prosecdef === true && searchPathLocked(manualFn?.proconfig)
      && manualFn?.owner_name === 'ice_p0_02_owner' && manualFn?.app_exec === true && manualFn?.public_exec === false,
      { guard: manualFn?.shipment_guard, market: manualFn?.market_filter, conflicts: manualFn?.conflict_count, shelved: manualFn?.shelved_field });
    check(results, '账号保存审计 before.isActive 已取保存前的数据库值',
      updateFn?.audit_before_fixed > 0 && updateFn?.app_exec === true && updateFn?.public_exec === false,
      { fixed: updateFn?.audit_before_fixed });

    // 2. 隔离样例：人工全部上架后来源调高发货量 → 冲突可见、差额不计货值
    const latest = (await owner.query(
      'SELECT catalog.shipment_latest_success_snapshot(catalog.shipment_current_source_key()) AS id')).rows[0].id;
    const sourceKey = (await owner.query('SELECT catalog.shipment_current_source_key() AS key')).rows[0].key;
    const cost = (await owner.query(
      `SELECT (f.payload->'cost'->>'raw')::numeric AS raw
       FROM catalog.item_current c
       JOIN catalog_private.item_financial_revision f
         ON f.item_id=c.item_id AND f.financial_revision=c.financial_revision
       WHERE c.item_id=$1`, [COST_PRODUCT_ID])).rows[0];
    if (!latest || !sourceKey || !cost) throw new Error('CONFLICT_SAMPLE_BASELINE_MISSING');

    await owner.query('SAVEPOINT conflict_sample');
    const sample = (await owner.query(
      `INSERT INTO catalog.shipment(source_key,ticket_key,ticket_no,market,customs_method,waybills_text,
         purchase_order,transport_text,arrival_text,status_class,received_basis,source_row_start,source_row_end,
         first_seen_snapshot_id,last_seen_snapshot_id,identity_status)
       VALUES($1,$2,$3,'越南','一般贸易','TEST-WAYBILL-046','TEST-CONFLICT-046','冲突样例：已人工确认全部上架',
         '待复核','partial','source_quantity',1,1,$4,$4,'confirmed')
       RETURNING id`, [sourceKey, `test-conflict-046-${crypto.randomUUID()}`, 'TEST-CONFLICT-046', latest])).rows[0].id;
    await owner.query(
      `INSERT INTO catalog.shipment_item(shipment_id,source_key,item_key,product_name_raw,product_name_norm,
         shipped_quantity,received_quantity,receipt_basis,source_note,source_sku,product_id,association_status,
         association_method,sort_index,revision,last_seen_snapshot_id,source_receipt_basis)
       VALUES($1,$2,'test-normal-046','冲突样例正常明细','冲突样例正常明细',10,0,'status_in_transit_zero',
         '正常明细，计入货值','TEST-SKU-046-A',$3,'manual','manual_selected',0,1,$4,'status_in_transit_zero')`,
      [sample, sourceKey, COST_PRODUCT_ID, latest]);
    const conflictItem = (await owner.query(
      `INSERT INTO catalog.shipment_item(shipment_id,source_key,item_key,product_name_raw,product_name_norm,
         shipped_quantity,received_quantity,receipt_basis,source_note,source_sku,product_id,association_status,
         association_method,sort_index,revision,last_seen_snapshot_id,
         source_received_quantity,source_receipt_basis,manual_status,manual_shelved_quantity,
         manual_actor_id,manual_actor_name,manual_at,manual_revision,manual_shipped_quantity)
       VALUES($1,$2,'test-conflict-046','冲突样例冲突明细','冲突样例冲突明细',150,100,'manual_correction',
         '人工确认全部上架后来源调高发货量','TEST-SKU-046-B',$3,'manual','manual_selected',1,1,$4,
         100,'pending','fully_shelved',NULL,$5,'冲突样例',$6,1,100)
       RETURNING id`, [sample, sourceKey, COST_PRODUCT_ID, latest, ADMIN_PROFILE_ID, new Date()])).rows[0].id;

    const index = await asRole(owner, APP_ROLE, ADMIN_PROFILE_ID,
      async () => callJson(owner, 'catalog.read_shipment_manual_index'));
    const shipmentState = (index?.shipments ?? []).find((row) => row.shipmentId === sample);
    const conflictState = (index?.items ?? []).find((row) => row.itemId === conflictItem);
    check(results, '冲突样例：管理员索引返回原发货量 100、现发货量 150、已确认上架量 100、冲突标记 true',
      shipmentState?.manualConflictCount === 1
      && conflictState?.shippedQuantity === 150
      && conflictState?.manualShippedQuantity === 100
      && conflictState?.previousConfirmedShelvedQuantity === 100
      && conflictState?.manualConflict === true,
      {
        conflictCount: shipmentState?.manualConflictCount,
        shipped: conflictState?.shippedQuantity,
        manualShipped: conflictState?.manualShippedQuantity,
        confirmedShelved: conflictState?.previousConfirmedShelvedQuantity,
        conflict: conflictState?.manualConflict,
      });

    // 与页面同一口径：冲突明细整条不计入单票货值；本样例应只剩正常明细 10 × 2.2 = 22。
    const value = (await owner.query(
      `SELECT coalesce(sum((i.shipped_quantity-i.received_quantity) *
         (CASE WHEN i.manual_status='fully_shelved' AND i.shipped_quantity IS DISTINCT FROM i.manual_shipped_quantity
           THEN 0 ELSE 1 END)),0)::numeric AS counted_quantity,
        coalesce(sum(CASE WHEN i.manual_status='fully_shelved' AND i.shipped_quantity IS DISTINCT FROM i.manual_shipped_quantity
          THEN 0 ELSE (i.shipped_quantity-i.received_quantity) END),0)::numeric * $2::numeric AS value_cny
       FROM catalog.shipment_item i WHERE i.shipment_id=$1`, [sample, cost.raw])).rows[0];
    check(results, '冲突差额不计入单票货值：样例货值只含正常明细 10 × 2.2 = ¥22（冲突的 50 件不计）',
      Number(value.counted_quantity) === 10 && Number(value.value_cny) === 22,
      { countedQuantity: value.counted_quantity, valueCny: value.value_cny, conflictDifferenceUnits: 50 });

    // 成员过滤仍在：只授予越南时能看到样例；清空授权被拒
    await owner.query(
      `INSERT INTO catalog.account_access_market(profile_id,market) VALUES($1,'越南')
       ON CONFLICT DO NOTHING`, [MEMBER_PROFILE_ID]);
    const memberIndex = await asRole(owner, APP_ROLE, MEMBER_PROFILE_ID,
      async () => callJson(owner, 'catalog.read_shipment_manual_index'));
    const memberConflict = (memberIndex?.items ?? []).find((row) => row.itemId === conflictItem);
    check(results, '补修保留市场过滤：成员（仅越南）能看到越南样例的冲突字段，冲突标记一致',
      memberConflict?.manualConflict === true && memberConflict?.manualShippedQuantity === 100,
      { conflict: memberConflict?.manualConflict, manualShipped: memberConflict?.manualShippedQuantity });

    await owner.query('DELETE FROM catalog.account_access_market WHERE profile_id=$1', [MEMBER_PROFILE_ID]);
    const denied = await expectFailureAs(owner, APP_ROLE, MEMBER_PROFILE_ID, 'catalog.read_shipment_manual_index');
    check(results, '没有物流授权时成员仍被拒绝（CATALOG_FORBIDDEN）', denied === 'CATALOG_FORBIDDEN', { error: denied });
    await owner.query('ROLLBACK TO SAVEPOINT conflict_sample');
    await owner.query('RELEASE SAVEPOINT conflict_sample');

    // 3. 启停审计：启用 → 停用，再停用 → 启用；before/after 都取真实数据库值
    const roleId = (await owner.query(
      'SELECT access_role_id AS id FROM catalog.account_access WHERE profile_id=$1',
      [MEMBER_PROFILE_ID])).rows[0].id;
    const warehouseIds = (await owner.query(
      "SELECT coalesce(array_agg(warehouse_id),'{}'::uuid[]) AS ids FROM catalog.account_access_warehouse WHERE profile_id=$1",
      [MEMBER_PROFILE_ID])).rows[0].ids;
    const markets = (await owner.query(
      'SELECT coalesce(array_agg(market),\'{}\'::text[]) AS keys FROM catalog.account_access_market WHERE profile_id=$1',
      [MEMBER_PROFILE_ID])).rows[0].keys;
    await owner.query('SAVEPOINT audit_sample');
    await owner.query('UPDATE public.profiles SET is_active=true WHERE id=$1', [MEMBER_PROFILE_ID]);
    const auditBefore = Number((await owner.query(
      "SELECT count(*)::int AS n FROM catalog.inventory_audit WHERE action='access_account_updated'")).rows[0].n);

    // 同一事务里 now() 固定，用唯一姓名区分两次审计行（而不是按时间取最后一条）。
    await asRole(owner, APP_ROLE, ADMIN_PROFILE_ID, async () => callJson(owner,
      'catalog.update_access_account',
      [MEMBER_PROFILE_ID, '审计样例停用', roleId, false, warehouseIds, markets]));
    const disabledAudit = (await owner.query(
      `SELECT detail FROM catalog.inventory_audit
       WHERE action='access_account_updated' AND detail->'after'->>'displayName'='审计样例停用'
       ORDER BY ctid DESC LIMIT 1`)).rows[0];
    await asRole(owner, APP_ROLE, ADMIN_PROFILE_ID, async () => callJson(owner,
      'catalog.update_access_account',
      [MEMBER_PROFILE_ID, '审计样例启用', roleId, true, warehouseIds, markets]));
    const enabledAudit = (await owner.query(
      `SELECT detail FROM catalog.inventory_audit
       WHERE action='access_account_updated' AND detail->'after'->>'displayName'='审计样例启用'
       ORDER BY ctid DESC LIMIT 1`)).rows[0];
    const auditCount = Number((await owner.query(
      "SELECT count(*)::int AS n FROM catalog.inventory_audit WHERE action='access_account_updated'")).rows[0].n);

    check(results, '启用 → 停用：审计 before.isActive=true、after.isActive=false（不是表单新值）',
      disabledAudit?.detail?.before?.isActive === true && disabledAudit?.detail?.after?.isActive === false,
      { before: disabledAudit?.detail?.before?.isActive, after: disabledAudit?.detail?.after?.isActive });
    check(results, '停用 → 启用：审计 before.isActive=false、after.isActive=true',
      enabledAudit?.detail?.before?.isActive === false && enabledAudit?.detail?.after?.isActive === true,
      { before: enabledAudit?.detail?.before?.isActive, after: enabledAudit?.detail?.after?.isActive });
    check(results, '两次保存各写一条审计（数量从 N 到 N+2），仓库与物流市场未丢',
      auditCount === auditBefore + 2
      && JSON.stringify(enabledAudit?.detail?.after?.logisticsMarkets) === JSON.stringify([...markets].sort()),
      { auditBefore, auditCount, markets: enabledAudit?.detail?.after?.logisticsMarkets });
    await owner.query('ROLLBACK TO SAVEPOINT audit_sample');
    await owner.query('RELEASE SAVEPOINT audit_sample');

    const countsAfterProbe = (await owner.query(countsSql)).rows[0];
    evidence.countsAfterProbe = countsAfterProbe;
    check(results, '探针与样例回滚后业务行数与安装前一致（未留下样例/审计）',
      JSON.stringify(countsBefore) === JSON.stringify(countsAfterProbe),
      { before: countsBefore, after: countsAfterProbe });

    if (commit) {
      await owner.query('COMMIT');
      await owner.query('BEGIN');
      const postManual = (await owner.query(functionStateSql, [APP_ROLE, 'read_shipment_manual_index'])).rows[0];
      const postUpdate = (await owner.query(functionStateSql, [APP_ROLE, 'update_access_account'])).rows[0];
      const postMember = await asRole(owner, APP_ROLE, MEMBER_PROFILE_ID,
        async () => callJson(owner, 'catalog.read_my_inventory_access'));
      await owner.query('ROLLBACK');
      evidence.afterCommit = {
        conflicts: postManual?.conflict_count > 0,
        marketFilter: postManual?.market_filter > 0,
        auditFixed: postUpdate?.audit_before_fixed > 0,
        memberCanViewShipment: postMember?.canViewShipment,
        memberMarkets: postMember?.shipmentMarkets,
      };
      check(results, '提交后回读：冲突字段/市场过滤/审计修正都在位，成员原有越南授权未变',
        postManual?.conflict_count > 0 && postManual?.market_filter > 0
        && postUpdate?.audit_before_fixed > 0 && postMember?.canViewShipment === true
        && JSON.stringify(postMember?.shipmentMarkets) === JSON.stringify(['越南']),
        evidence.afterCommit);
    } else {
      await owner.query('ROLLBACK');
      const countsAfterRollback = (await owner.query(countsSql)).rows[0];
      check(results, 'rollback 后业务行数不变', JSON.stringify(countsBefore) === JSON.stringify(countsAfterRollback));
    }

    evidence.results = results;
    evidence.passed = results.every((item) => item.ok);
    evidence.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(EVIDENCE_DIR, commit ? 'apply-046-commit.json' : 'apply-046.json'),
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
    fs.writeFileSync(path.join(EVIDENCE_DIR, commit ? 'apply-046-commit.json' : 'apply-046.json'),
      `${JSON.stringify(evidence, null, 2)}\n`);
    console.error('[apply-046] failed:', error.message);
    process.exitCode = 1;
  } finally {
    await owner.end().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
