/**
 * 把 044「权限设置 v1 首轮补修」应用到一个 catalog 库。
 *
 * 044 只修正 043 的三处行为并补两个函数：
 *   1. inventory_scope_payload() 只在有登录成员身份时收窄，后台任务继续按同步配置领取参与仓；
 *   2. read_inventory_item() 对成员不再下发绑定（mapping）与候选（candidates）；
 *   3. read_member_item_amounts()：含金额权限的成员按授权仓商品取采用成本；
 *   4. record_access_password_reset()：普通成员密码重置留痕（不含密码/哈希）。
 *
 * 模式（默认绝不改目标库）：
 *   --rollback（默认）：事务内安装两次 → 结构/行为探针 → ROLLBACK
 *   --commit          ：安装 → 回读 → 事务内探针 → COMMIT
 *   安全闸门：目标库名等于现役库名时 --commit 必须显式 --allow-live-commit。
 *
 * 用法：
 *   node scripts/catalog/apply-044.mjs --rollback --run-id run-20261026T211500Z-11a22b33
 *   node scripts/catalog/apply-044.mjs --commit --allow-live-commit --run-id run-20261026T211500Z-11a22b33
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
const SQL_FILE = 'db/catalog/044_permissions_v1_fixes.sql';
const APP_ROLE = 'ice_p0_02_app_runner';
const SYNC_ROLE = 'ice_p0_02_sync_runner';
const ADMIN_PROFILE_ID = '11111111-1111-4111-8111-111111111101';
const OPERATOR_PROFILE_ID = '11111111-1111-4111-8111-111111111104';
const EVIDENCE_DIR = path.join(REPO_ROOT, '.local', 'catalog', 'permissions-v1-20261117');

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
  encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') AS body_sha256,
  position('access_profile_id() IS NOT NULL' in p.prosrc) AS scope_guard_fixed,
  position('catalog.is_admin() AND m.account_id=v_aid' in p.prosrc) AS mapping_gated,
  position('catalog.is_admin() AND c.account_id=v_aid' in p.prosrc) AS candidates_gated,
  pg_catalog.has_function_privilege($1, p.oid, 'EXECUTE') AS app_exec,
  pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='catalog' AND p.proname=$2
 ORDER BY identity_args`;

const countsSql = `SELECT
  (SELECT count(*) FROM catalog.catalog_item)::int AS items,
  (SELECT count(*) FROM catalog.inventory_batch)::int AS inventory_batches,
  (SELECT count(*) FROM catalog.inventory_batch_row)::int AS inventory_batch_rows,
  (SELECT count(*) FROM catalog.inventory_sku_mapping)::int AS sku_mappings,
  (SELECT count(*) FROM catalog.audit_event)::int AS audit_events,
  (SELECT count(*) FROM catalog.inventory_audit)::int AS inventory_audits,
  (SELECT count(*) FROM public.profiles)::int AS profiles,
  (SELECT count(*) FROM catalog.access_role)::int AS access_roles`;

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
    const account = (await owner.query(
      `SELECT a.id FROM catalog.inventory_source_account a
        JOIN catalog.inventory_sync_settings s ON s.account_id=a.id
       ORDER BY a.created_at LIMIT 1`)).rows[0];
    if (!account) throw new Error('INVENTORY_ACCOUNT_MISSING');

    await owner.query('BEGIN');
    await install(owner, sql);
    await install(owner, sql);
    check(results, '044 安装两次均成功（幂等，无报错）', true, { applications: 2 });

    // 1. 函数结构与修正标记
    const scope = (await owner.query(functionStateSql, [APP_ROLE, 'inventory_scope_payload'])).rows;
    check(results, 'inventory_scope_payload：守卫只在有成员身份时收窄（结构未破）',
      scope.length === 1 && scope[0].prosecdef === true && searchPathLocked(scope[0].proconfig)
      && scope[0].owner_name === 'ice_p0_02_owner' && scope[0].public_exec === false
      && scope[0].scope_guard_fixed > 0,
      scope.map((row) => ({ app: row.app_exec, fixed: row.scope_guard_fixed })));

    const itemFn = (await owner.query(functionStateSql, [APP_ROLE, 'read_inventory_item'])).rows;
    check(results, 'read_inventory_item：成员绑定/候选已加管理员条件，app 仍可执行',
      itemFn.length === 1 && itemFn[0].mapping_gated > 0 && itemFn[0].candidates_gated > 0
      && itemFn[0].app_exec === true,
      itemFn.map((row) => ({ app: row.app_exec, map: row.mapping_gated, cand: row.candidates_gated })));

    const amountFn = (await owner.query(functionStateSql, [APP_ROLE, 'read_member_item_amounts'])).rows;
    const resetFn = (await owner.query(functionStateSql, [APP_ROLE, 'record_access_password_reset'])).rows;
    check(results, '新增成员金额/密码留痕函数：SECURITY DEFINER、search_path 锁定、属主为 owner、app 可执行、public 不可执行',
      amountFn.length === 1 && resetFn.length === 1
      && [...amountFn, ...resetFn].every((row) => row.prosecdef === true && searchPathLocked(row.proconfig)
        && row.owner_name === 'ice_p0_02_owner' && row.app_exec === true && row.public_exec === false),
      { amount: amountFn.length, reset: resetFn.length });

    const amountPolicy = (await owner.query(
      `SELECT policyname,qual FROM pg_policies
        WHERE schemaname='catalog_private' AND tablename='item_financial_revision'
          AND policyname='member_amount_definer_owner'`)).rows;
    check(results, '金额表补仅属主 SELECT 策略（成员金额函数以属主身份读采用价）',
      amountPolicy.length === 1 && String(amountPolicy[0].qual).includes('ice_p0_02_owner'),
      amountPolicy);

    // 2. 后台范围：无登录身份时不再收窄（真实 claim 路径）
    const noIdentityScope = await asRole(owner, 'ice_p0_02_owner', null, async () => callJson(owner,
      'catalog.inventory_scope_payload', [account.id]));
    const noIdentityCount = (noIdentityScope?.warehouseIds ?? []).length;
    check(results, '无登录身份读取范围：返回同步配置的参与仓（不是空清单）',
      noIdentityCount === 7 && noIdentityScope?.empty === false, { warehouses: noIdentityCount });

    // 真实领取：不开新事务；临时把 next_run_at 提到现在，领取后回滚到 savepoint。
    await owner.query('SAVEPOINT claim_probe');
    await owner.query('UPDATE catalog.inventory_sync_settings SET next_run_at=now() WHERE account_id=$1', [account.id]);
    const canSetSyncRole = (await owner.query(
      "SELECT pg_has_role(current_user,$1,'member') AS ok", [SYNC_ROLE])).rows[0]?.ok === true;
    const claim = await asRole(owner, canSetSyncRole ? SYNC_ROLE : 'ice_p0_02_owner', null,
      async () => callJson(owner, 'catalog.claim_inventory_run', ['apply-044-probe', 120]));
    evidence.claimProbe = { usedRole: canSetSyncRole ? SYNC_ROLE : 'ice_p0_02_owner', warehouses: (claim?.warehouses ?? []).length, runId: claim?.runId ?? null, reason: claim?.reason ?? null };
    check(results, '后台领取任务：拿到 7 个仓与一个真实 runId（不再 SCOPE_EMPTY）',
      Number(claim?.warehouseCount ?? (claim?.warehouses ?? []).length) === 7 && claim?.scopeEmpty === false
      && typeof claim?.runId === 'string',
      evidence.claimProbe);
    await owner.query('ROLLBACK TO SAVEPOINT claim_probe');
    await owner.query('RELEASE SAVEPOINT claim_probe');
    await owner.query('RESET ROLE; RESET ALL');

    // 3. 成员范围仍按授权收窄
    const granted = (await owner.query(
      "SELECT id,external_name,external_warehouse_id FROM catalog.inventory_warehouse WHERE external_warehouse_id='50455'")).rows[0];
    const other = (await owner.query(
      "SELECT id FROM catalog.inventory_warehouse WHERE external_warehouse_id='56673'")).rows[0];
    const roleRow = (await owner.query("SELECT id FROM catalog.access_role WHERE preset_key='ops'")).rows[0]
      ?? (await owner.query('SELECT id FROM catalog.access_role ORDER BY created_at LIMIT 1')).rows[0];
    await owner.query('SAVEPOINT seed_member');
    await owner.query(
      `INSERT INTO catalog.account_access(profile_id,access_role_id,created_by,updated_by)
       VALUES($1,$2,$3,$3)
       ON CONFLICT (profile_id) DO UPDATE SET access_role_id=excluded.access_role_id`,
      [OPERATOR_PROFILE_ID, roleRow.id, ADMIN_PROFILE_ID]);
    await owner.query('DELETE FROM catalog.account_access_warehouse WHERE profile_id=$1', [OPERATOR_PROFILE_ID]);
    await owner.query('INSERT INTO catalog.account_access_warehouse(profile_id,warehouse_id) VALUES($1,$2)',
      [OPERATOR_PROFILE_ID, granted.id]);

    const memberRows = await asRole(owner, APP_ROLE, OPERATOR_PROFILE_ID,
      async () => callJson(owner, 'catalog.read_inventory_warehouse_rows', [null, null, null]));
    check(results, '成员范围仍收窄：只返回 1 个被授予仓，行都属该仓',
      memberRows?.scope?.warehouseCount === 1 && (memberRows?.rows ?? []).length > 0
      && memberRows.rows.every((row) => row.warehouseId === granted.id),
      { total: memberRows?.total, warehouses: memberRows?.scope?.warehouseCount });

    // 4. 成员金额：按授权仓商品取采用成本
    const amountsOff = await expectFailureAs(owner, APP_ROLE, OPERATOR_PROFILE_ID,
      'catalog.read_member_item_amounts');
    check(results, '无金额权限：成员金额函数拒绝（CATALOG_FORBIDDEN），读不到成本',
      amountsOff === 'CATALOG_FORBIDDEN', { error: amountsOff });

    await owner.query("UPDATE catalog.access_role SET can_view_amount=true WHERE id=$1", [roleRow.id]);
    const memberAmounts = await asRole(owner, APP_ROLE, OPERATOR_PROFILE_ID,
      async () => callJson(owner, 'catalog.read_member_item_amounts'));
    const memberItems = Object.keys(memberAmounts ?? {});
    const scopedItems = (await owner.query(
      `SELECT DISTINCT e.item_id::text AS item_id FROM catalog.inventory_effective_rows($1,ARRAY[$2]::uuid[]) e
        WHERE e.item_id IS NOT NULL`, [account.id, granted.id])).rows.map((row) => row.item_id);
    check(results, '金额权限打开：返回授权仓内商品成本，且不含范围外商品',
      memberItems.length > 0 && memberItems.every((item) => scopedItems.includes(item)),
      { returned: memberItems.length, scoped: scopedItems.length });

    const sampleItem = memberItems[0];
    const adminAmounts = await asRole(owner, APP_ROLE, ADMIN_PROFILE_ID,
      async () => callJson(owner, 'catalog.read_baseline_item_amounts_map'));
    const amountMatches = sampleItem ? JSON.stringify(memberAmounts[sampleItem]) === JSON.stringify(adminAmounts[sampleItem]) : false;
    check(results, '成员成本与管理员同一商品完全一致（同一采用价版本）',
      amountMatches, { item: sampleItem, member: memberAmounts[sampleItem]?.cost?.raw ?? null, admin: adminAmounts[sampleItem]?.cost?.raw ?? null });

    // 5. 成员商品详情：绑定/候选不下发，仓库/历史仍限于授权范围
    const detailItem = sampleItem ? await asRole(owner, APP_ROLE, OPERATOR_PROFILE_ID,
      async () => callJson(owner, 'catalog.read_inventory_item', [sampleItem, null, null, false])) : null;
    const detailWarehouses = (detailItem?.warehouses ?? []).map((row) => row.warehouseId);
    const historyNames = new Set((detailItem?.history ?? []).map((row) => row.warehouseName));
    check(results, '成员商品详情：绑定/候评为空，仓库只剩授权仓，历史不出其它仓',
      Boolean(detailItem) && (detailItem.mapping ?? []).length === 0
      && (detailItem.candidates ?? []).length === 0
      && detailWarehouses.length > 0 && detailWarehouses.every((id) => id === granted.id)
      && [...historyNames].every((name) => name === granted.external_name),
      { warehouses: detailWarehouses.length, history: historyNames.size });

    // 6. 密码重置留痕：普通成员可记；管理员账号不可重置
    const resetAuditBefore = (await owner.query(
      "SELECT count(*)::int AS n FROM catalog.inventory_audit WHERE action='access_account_password_reset'")).rows[0].n;
    const recorded = await asRole(owner, APP_ROLE, ADMIN_PROFILE_ID,
      async () => callJson(owner, 'catalog.record_access_password_reset', [OPERATOR_PROFILE_ID]));
    const resetAudit = (await owner.query(
      `SELECT actor_id,action,entity_ref,detail,at FROM catalog.inventory_audit
        WHERE action='access_account_password_reset' ORDER BY at DESC LIMIT 1`)).rows[0];
    check(results, '普通成员密码重置留痕：记录操作者/目标/时间，detail 不含密码或哈希',
      recorded?.ok === true && resetAudit?.actor_id === ADMIN_PROFILE_ID
      && resetAudit?.entity_ref === `access_account:${OPERATOR_PROFILE_ID}`
      && resetAudit?.detail?.profileId === OPERATOR_PROFILE_ID
      && !/password_hash|\bhash\b/i.test(JSON.stringify(resetAudit?.detail ?? {}))
      && Number((await owner.query(
        "SELECT count(*)::int AS n FROM catalog.inventory_audit WHERE action='access_account_password_reset'")).rows[0].n)
        === Number(resetAuditBefore) + 1,
      { actor: resetAudit?.actor_id, entity: resetAudit?.entity_ref, detail: resetAudit?.detail });

    const adminResetDenied = await expectFailureAs(owner, APP_ROLE, ADMIN_PROFILE_ID,
      'catalog.record_access_password_reset', [ADMIN_PROFILE_ID]);
    check(results, '管理员账号密码重置被拒（ACCESS_ADMIN_ACCOUNT_IMMUTABLE）',
      adminResetDenied === 'ACCESS_ADMIN_ACCOUNT_IMMUTABLE', { error: adminResetDenied });

    // 探针回滚：不留下成员授权/角色改动/审计/claim 任务
    await owner.query('ROLLBACK TO SAVEPOINT seed_member');
    await owner.query('RELEASE SAVEPOINT seed_member');

    const countsAfterProbe = (await owner.query(countsSql)).rows[0];
    evidence.countsAfterProbe = countsAfterProbe;
    check(results, '探针回滚后业务行数与安装前一致（未写业务数据）',
      JSON.stringify(countsBefore) === JSON.stringify(countsAfterProbe),
      { before: countsBefore, after: countsAfterProbe });

    if (commit) {
      await owner.query('COMMIT');
      await owner.query('BEGIN');
      const post = (await owner.query(functionStateSql, [APP_ROLE, 'inventory_scope_payload'])).rows[0];
      const postAmount = (await owner.query(functionStateSql, [APP_ROLE, 'read_member_item_amounts'])).rows[0];
      const postReset = (await owner.query(functionStateSql, [APP_ROLE, 'record_access_password_reset'])).rows[0];
      const postClaimScope = await callJson(owner, 'catalog.inventory_scope_payload', [account.id]);
      const roles = (await owner.query('SELECT count(*)::int AS n FROM catalog.access_role')).rows[0].n;
      await owner.query('ROLLBACK');
      evidence.afterCommit = {
        scopeGuardFixed: post?.scope_guard_fixed > 0,
        amountFn: Boolean(postAmount),
        resetFn: Boolean(postReset),
        roles,
        warehouseIds: (postClaimScope?.warehouseIds ?? []).length,
      };
      check(results, '提交后回读：修正生效、函数在位、角色未丢、后台范围仍为 7 仓',
        post?.scope_guard_fixed > 0 && Boolean(postAmount) && Boolean(postReset)
        && Number(roles) === Number(countsBefore.access_roles)
        && (postClaimScope?.warehouseIds ?? []).length === 7,
        evidence.afterCommit);
    } else {
      await owner.query('ROLLBACK');
      const countsAfterRollback = (await owner.query(countsSql)).rows[0];
      check(results, 'rollback 后业务行数不变', JSON.stringify(countsBefore) === JSON.stringify(countsAfterRollback));
    }

    evidence.results = results;
    evidence.passed = results.every((item) => item.ok);
    evidence.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(EVIDENCE_DIR, commit ? 'apply-044-commit.json' : 'apply-044.json'),
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
    fs.writeFileSync(path.join(EVIDENCE_DIR, commit ? 'apply-044-commit.json' : 'apply-044.json'),
      `${JSON.stringify(evidence, null, 2)}\n`);
    console.error('[apply-044] failed:', error.message);
    process.exitCode = 1;
  } finally {
    await owner.end().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
