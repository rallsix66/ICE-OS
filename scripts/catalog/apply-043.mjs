/**
 * 把 043「权限设置 v1」应用到一个 catalog 库。
 *
 * 043 只做三件事：新增 3 张权限表（角色 / 账号角色 / 账号仓库范围）、新增管理员读写 RPC、
 * 把既有只读函数的入口守卫换成 require_inventory_read() 并在 scope 处交集成员被授予的仓库。
 * 不改 001-042，不写业务数据行；唯一的数据写入是两条预置角色（负责人 / 运营）。
 *
 * 模式（默认绝不改目标库）：
 *   --rollback（默认）：事务内安装 → 结构/守卫/行为探针 → ROLLBACK
 *   --commit          ：安装 → 回读 → 真实数据探针 → COMMIT
 *   安全闸门：目标库名等于现役库名时 --commit 必须显式 --allow-live-commit。
 *
 * 用法：
 *   node scripts/catalog/apply-043.mjs --rollback --run-id run-20261026T211500Z-11a22b33
 *   node scripts/catalog/apply-043.mjs --rollback --database-url postgres://.../clone
 *   node scripts/catalog/apply-043.mjs --commit --allow-live-commit --run-id run-20261026T211500Z-11a22b33
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
const SQL_FILE = 'db/catalog/043_permissions_v1.sql';
const APP_ROLE = 'ice_p0_02_app_runner';
const ADMIN_PROFILE_ID = '11111111-1111-4111-8111-111111111101';
const OPERATOR_PROFILE_ID = '11111111-1111-4111-8111-111111111104';
const EVIDENCE_DIR = path.join(REPO_ROOT, '.local', 'catalog', 'permissions-v1-20261117');
const PATCHED_FUNCTIONS = [
  'read_inventory_warehouse_states',
  'read_inventory_warehouse_rows',
  'read_inventory_product_summary',
  'read_inventory_item',
  'read_inventory_snapshot_batches',
  'read_inventory_snapshot_rows',
  'inventory_scope_payload',
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
  pg_get_function_result(p.oid) AS result_type,
  p.prosecdef, p.proconfig, p.provolatile,
  pg_get_userbyid(p.proowner) AS owner_name,
  encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') AS body_sha256,
  position('require_inventory_read' in p.prosrc) AS uses_read_guard,
  position('require_admin' in p.prosrc) AS uses_admin_guard,
  pg_catalog.has_function_privilege($1, p.oid, 'EXECUTE') AS app_exec,
  pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='catalog' AND p.proname=$2
 ORDER BY identity_args`;

const accessTablesSql = `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
  (SELECT count(*) FROM pg_policy pol WHERE pol.polrelid=c.oid) AS policies,
  pg_catalog.has_table_privilege($1,c.oid,'SELECT') AS app_select,
  pg_catalog.has_table_privilege($1,c.oid,'INSERT') AS app_insert
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='catalog' AND c.relname IN ('access_role','account_access','account_access_warehouse')
 ORDER BY c.relname`;

const countsSql = `SELECT
  (SELECT count(*) FROM catalog.catalog_item)::int AS items,
  (SELECT count(*) FROM catalog.item_revision)::int AS revisions,
  (SELECT count(*) FROM catalog.inventory_batch)::int AS inventory_batches,
  (SELECT count(*) FROM catalog.inventory_batch_row)::int AS inventory_batch_rows,
  (SELECT count(*) FROM catalog.inventory_sku_mapping)::int AS sku_mappings,
  (SELECT count(*) FROM catalog.shipment)::int AS shipments,
  (SELECT count(*) FROM catalog.audit_event)::int AS audit_events,
  (SELECT count(*) FROM catalog.inventory_audit)::int AS inventory_audits,
  (SELECT count(*) FROM public.profiles)::int AS profiles`;

async function install(owner, sql) {
  await owner.query(sql);
  await owner.query('RESET ROLE; RESET ALL');
}

async function asProfile(owner, profileId, fn) {
  await owner.query(`SET LOCAL ROLE ${APP_ROLE}`);
  await owner.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [profileId]);
  try {
    return await fn();
  } finally {
    await owner.query('RESET ROLE; RESET ALL');
  }
}

async function callJson(owner, spec, params) {
  const placeholders = params.map((_, index) => `$${index + 1}`).join(', ');
  const sql = params.length > 0 ? `SELECT ${spec}(${placeholders}) AS r` : `SELECT ${spec}() AS r`;
  const rows = (await owner.query(sql, params)).rows;
  return rows[0]?.r ?? null;
}

async function readAs(owner, profileId, spec, params = []) {
  return asProfile(owner, profileId, async () => callJson(owner, spec, params));
}

async function expectFailure(owner, profileId, spec, params) {
  await owner.query('SAVEPOINT probe_fail');
  await owner.query(`SET LOCAL ROLE ${APP_ROLE}`);
  await owner.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [profileId]);
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
    const beforeGuard = {};
    for (const name of PATCHED_FUNCTIONS) {
      beforeGuard[name] = (await owner.query(functionStateSql, [APP_ROLE, name])).rows
        .map((row) => ({ args: row.identity_args, readGuard: row.uses_read_guard > 0 }));
    }
    evidence.beforeGuard = beforeGuard;

    await owner.query('BEGIN');
    await install(owner, sql);
    await install(owner, sql);
    check(results, '043 安装两次均成功（幂等，无报错）', true, { applications: 2 });

    // 1. 表结构
    const tables = (await owner.query(accessTablesSql, [APP_ROLE])).rows;
    evidence.tables = tables;
    check(results, '三张权限表存在、启用并强制 RLS、各 2 条策略、运行角色无直接表权限',
      tables.length === 3
      && tables.every((row) => row.relrowsecurity && row.relforcerowsecurity && Number(row.policies) === 2
        && row.app_select === false && row.app_insert === false),
      tables);

    // 2. 预置角色
    const presets = (await owner.query(
      `SELECT name,preset_key,can_view_inventory,can_view_amount FROM catalog.access_role
        WHERE preset_key IS NOT NULL ORDER BY preset_key`)).rows;
    evidence.presets = presets;
    check(results, '预置角色：负责人（含金额）与运营（不含金额）各一条，均可查看库存',
      presets.length === 2
      && presets.every((row) => row.can_view_inventory === true)
      && presets.find((row) => row.preset_key === 'lead')?.can_view_amount === true
      && presets.find((row) => row.preset_key === 'ops')?.can_view_amount === false,
      presets);

    // 3. 函数结构与守卫替换
    for (const name of PATCHED_FUNCTIONS) {
      const rows = (await owner.query(functionStateSql, [APP_ROLE, name])).rows;
      const adminOnly = name === 'inventory_scope_payload';
      check(results, `043 守卫/结构：${name}（${adminOnly ? '内部 helper，不对 app 开放' : 'require_inventory_read'}）`,
        rows.length === 1 && rows[0].prosecdef === true && searchPathLocked(rows[0].proconfig)
        && rows[0].owner_name === 'ice_p0_02_owner' && rows[0].public_exec === false
        && (adminOnly ? rows[0].app_exec === false : rows[0].app_exec === true)
        && (adminOnly || (rows[0].uses_read_guard > 0 && rows[0].uses_admin_guard === 0)),
        rows.map((row) => ({ args: row.identity_args, readGuard: row.uses_read_guard, adminGuard: row.uses_admin_guard })));
    }

    // 4. 未授权成员（operator 尚无范围）读库存被拒
    const denyNoAccess = await expectFailure(owner, OPERATOR_PROFILE_ID,
      'catalog.read_inventory_warehouse_rows', [null, null, null]);
    check(results, '未授予库存查看的成员读取被拒（CATALOG_FORBIDDEN）',
      denyNoAccess === 'CATALOG_FORBIDDEN', { error: denyNoAccess });

    // 5. 管理员读口径不变（与安装前对比行数）
    const adminRowsBefore = evidence.adminRowsBefore = await readAs(owner, ADMIN_PROFILE_ID,
      'catalog.read_inventory_warehouse_rows', [null, null, null]);
    check(results, '管理员仓库明细：仓库数 = 7 个参与仓、行数与 scope 计数自洽',
      adminRowsBefore?.scope?.warehouseCount === 7
      && adminRowsBefore.rows.length === adminRowsBefore.total
      && adminRowsBefore.scope.empty === false,
      { total: adminRowsBefore?.total, warehouses: adminRowsBefore?.scope?.warehouseCount });

    // 6. 授予运营一个仓（50455 越南青林湾），成员读到的就是这一个仓
    const grantedWarehouse = (await owner.query(
      "SELECT id,external_name FROM catalog.inventory_warehouse WHERE external_warehouse_id='50455'")).rows[0];
    const opsRoleId = presets.find((row) => row.preset_key === 'ops')?.preset_key
      ? (await owner.query("SELECT id FROM catalog.access_role WHERE preset_key='ops'")).rows[0].id : null;
    await owner.query('SAVEPOINT seed_member');
    await owner.query(
      `INSERT INTO catalog.account_access(profile_id,access_role_id,created_by,updated_by)
       VALUES($1,$2,$3,$3)
       ON CONFLICT (profile_id) DO UPDATE SET access_role_id=excluded.access_role_id`,
      [OPERATOR_PROFILE_ID, opsRoleId, ADMIN_PROFILE_ID]);
    await owner.query(
      `INSERT INTO catalog.account_access_warehouse(profile_id,warehouse_id) VALUES($1,$2)
       ON CONFLICT DO NOTHING`, [OPERATOR_PROFILE_ID, grantedWarehouse.id]);

    const member = await readAs(owner, OPERATOR_PROFILE_ID, 'catalog.read_my_inventory_access');
    evidence.memberAccess = member;
    check(results, '成员权限摘要：可看库存、不可看金额、范围只剩 1 个仓',
      member?.isAdmin === false && member.canViewInventory === true && member.canViewAmount === false
      && member.warehouseCount === 1 && member.scopeEmpty === false
      && member.warehouses[0]?.id === grantedWarehouse.id,
      member);

    const memberRows = await readAs(owner, OPERATOR_PROFILE_ID, 'catalog.read_inventory_warehouse_rows', [null, null, null]);
    evidence.memberRows = { total: memberRows?.total, warehouses: memberRows?.scope?.warehouseCount };
    check(results, '成员仓库明细：只返回被授予仓的行，scope 计数为 1，不含其它仓',
      memberRows?.scope?.warehouseCount === 1 && memberRows.rows.length > 0
      && memberRows.rows.every((row) => row.warehouseId === grantedWarehouse.id),
      { total: memberRows?.total, warehouses: memberRows?.scope?.warehouseCount });

    const memberStates = await readAs(owner, OPERATOR_PROFILE_ID, 'catalog.read_inventory_warehouse_states');
    check(results, '成员逐仓读取状态：只含被授予仓',
      Array.isArray(memberStates) && memberStates.length === 1
      && memberStates[0].warehouseId === grantedWarehouse.id,
      Array.isArray(memberStates) ? memberStates.length : memberStates);

    const memberSummary = await readAs(owner, OPERATOR_PROFILE_ID, 'catalog.read_inventory_product_summary',
      [null, null, null, 200, 0]);
    const summaryWarehouses = (memberSummary?.warehouses ?? []).map((row) => row.warehouseId ?? row.id);
    evidence.memberSummary = { total: memberSummary?.total, warehouses: summaryWarehouses };
    check(results, '成员商品汇总：仓库列表只含被授予仓',
      Array.isArray(summaryWarehouses) && summaryWarehouses.length === 1
      && summaryWarehouses[0] === grantedWarehouse.id,
      summaryWarehouses);

    // 7. 越范围直接访问被拒（显式指定其它仓）
    const otherWarehouse = (await owner.query(
      "SELECT id FROM catalog.inventory_warehouse WHERE external_warehouse_id='56673'")).rows[0];
    const otherItem = (await owner.query(
      `SELECT br.item_id FROM catalog.inventory_batch_row br
        JOIN catalog.inventory_batch b ON b.id=br.batch_id
       WHERE b.warehouse_id=$1 AND br.item_id IS NOT NULL LIMIT 1`, [otherWarehouse.id])).rows[0];
    const deniedRows = await expectFailure(owner, OPERATOR_PROFILE_ID,
      'catalog.read_inventory_warehouse_rows', [null, otherWarehouse.id, null]);
    check(results, '越范围：成员直接指定未授权仓库读取被拒（INVENTORY_WAREHOUSE_UNKNOWN）',
      deniedRows === 'INVENTORY_WAREHOUSE_UNKNOWN', { error: deniedRows });

    const deniedBatches = await expectFailure(owner, OPERATOR_PROFILE_ID,
      'catalog.read_inventory_snapshot_batches', [otherWarehouse.id, 50, 0]);
    check(results, '越范围：成员直接读未授权仓的历史批次被拒',
      deniedBatches === 'INVENTORY_WAREHOUSE_UNKNOWN', { error: deniedBatches });

    const deniedItem = await expectFailure(owner, OPERATOR_PROFILE_ID,
      'catalog.read_inventory_item', [otherItem?.item_id, otherWarehouse.id, null, false]);
    check(results, '越范围：成员带未授权仓库读商品详情被拒',
      deniedItem === 'INVENTORY_WAREHOUSE_UNKNOWN', { error: deniedItem });

    // 成员读同一商品详情（不带仓库筛选）时，范围里没有该仓 → 不返回该仓数量
    const scopedItem = otherItem?.item_id ? await readAs(owner, OPERATOR_PROFILE_ID,
      'catalog.read_inventory_item', [otherItem.item_id, null, null, false]) : null;
    const itemWarehouses = (scopedItem?.warehouses ?? []).map((row) => row.warehouseId);
    check(results, '同一商品详情：成员只看到被授予仓，不含未授权仓',
      Boolean(scopedItem) && itemWarehouses.every((id) => id === grantedWarehouse.id),
      { warehouses: itemWarehouses });

    // 8. 授权范围内历史快照可读
    const batchRow = (await owner.query(
      'SELECT id FROM catalog.inventory_batch WHERE warehouse_id=$1 ORDER BY observation_at DESC LIMIT 1',
      [grantedWarehouse.id])).rows[0];
    const memberBatches = await readAs(owner, OPERATOR_PROFILE_ID, 'catalog.read_inventory_snapshot_batches',
      [grantedWarehouse.id, 5, 0]);
    const memberBatchRows = batchRow ? await readAs(owner, OPERATOR_PROFILE_ID, 'catalog.read_inventory_snapshot_rows',
      [grantedWarehouse.id, batchRow.id, null, 5, 0]) : null;
    evidence.memberSnapshot = { batches: memberBatches?.batchTotal, rowsOk: memberBatchRows?.ok, rows: memberBatchRows?.rows?.length };
    check(results, '授权范围内历史快照：批次列表与单批明细均可读',
      memberBatches?.warehouseId === grantedWarehouse.id && (memberBatches?.batches ?? []).length > 0
      && memberBatchRows?.ok === true && (memberBatchRows?.rows ?? []).length > 0,
      evidence.memberSnapshot);

    // 9. 停用后立即失去读取能力
    await owner.query('UPDATE public.profiles p SET is_active=false WHERE p.id=$1', [OPERATOR_PROFILE_ID]);
    const denyInactive = await expectFailure(owner, OPERATOR_PROFILE_ID,
      'catalog.read_inventory_warehouse_rows', [null, null, null]);
    const inactiveAccess = await readAs(owner, OPERATOR_PROFILE_ID, 'catalog.read_my_inventory_access');
    check(results, '停用后：成员读取被拒，权限摘要标记未登录/无权限',
      denyInactive === 'CATALOG_FORBIDDEN' && inactiveAccess?.signedIn === false,
      { error: denyInactive, access: inactiveAccess });
    await owner.query('UPDATE public.profiles p SET is_active=true WHERE p.id=$1', [OPERATOR_PROFILE_ID]);

    // 10. 金额权限改角色即生效（角色是唯一来源）
    await owner.query("UPDATE catalog.access_role r SET can_view_amount=true WHERE r.preset_key='ops'");
    const amountOn = await readAs(owner, OPERATOR_PROFILE_ID, 'catalog.read_my_inventory_access');
    check(results, '修改角色金额权限后立即生效（canViewAmount=true）',
      amountOn?.canViewAmount === true && amountOn?.canViewInventory === true, amountOn);
    await owner.query("UPDATE catalog.access_role r SET can_view_amount=false WHERE r.preset_key='ops'");

    // 11. 管理员读写 RPC 真实可用（建角色 / 建号 / 改范围 / 停用）
    const created = await readAs(owner, ADMIN_PROFILE_ID, 'catalog.save_access_role',
      [null, '验收角色A', '本包探针', true, false]);
    const roleId = created?.role?.roleId ?? null;
    evidence.createdRole = created;
    check(results, '管理员新增角色成功并返回角色 ID',
      created?.ok === true && typeof roleId === 'string', created);
    const duplicateName = await expectFailure(owner, ADMIN_PROFILE_ID, 'catalog.save_access_role',
      [null, '验收角色A', null, true, false]);
    check(results, '角色重名被拒（唯一索引），不写第二份',
      /duplicate key|access_role_name_unique/i.test(String(duplicateName)), { error: duplicateName });
    const updatedRole = await readAs(owner, ADMIN_PROFILE_ID, 'catalog.save_access_role',
      [roleId, '验收角色A', '改过金额权限', true, true]);
    check(results, '管理员编辑角色金额权限成功', updatedRole?.role?.canViewAmount === true, updatedRole?.role);

    const roleList = await readAs(owner, ADMIN_PROFILE_ID, 'catalog.read_access_roles');
    check(results, '角色列表含新角色与账号数', Array.isArray(roleList?.roles)
      && roleList.roles.some((row) => row.roleId === roleId && row.accountCount === 0), roleList?.roles?.length);

    const options = await readAs(owner, ADMIN_PROFILE_ID, 'catalog.read_access_warehouse_options');
    check(results, '仓库选项只列 7 个参与仓（excluded 不出现）',
      Array.isArray(options?.warehouses) && options.warehouses.length === 7
      && options.warehouses.every((row) => row.marketKey), { count: options?.warehouses?.length });

    const accountsPage = await readAs(owner, ADMIN_PROFILE_ID, 'catalog.access_account_rows',
      [null, null, null, 20, 0]);
    evidence.accountsPage = { total: accountsPage?.total, sample: accountsPage?.accounts?.[0] };
    check(results, '账号列表：含管理员只读行、管理员标记 isSystemAdmin=true',
      accountsPage?.total >= 3 && accountsPage.accounts.some((row) => row.isSystemAdmin === true),
      { total: accountsPage?.total });

    const failedCreate = await expectFailure(owner, ADMIN_PROFILE_ID, 'catalog.create_access_account',
      ['', null, '缺失认证账号', roleId, [], true]);
    check(results, '建号缺认证账号被拒（ACCESS_ACCOUNT_AUTH_USER_REQUIRED）',
      failedCreate === 'ACCESS_ACCOUNT_AUTH_USER_REQUIRED', { error: failedCreate });

    const newAuthId = `probe-${crypto.randomUUID()}`;
    const createdAccount = await readAs(owner, ADMIN_PROFILE_ID, 'catalog.create_access_account',
      [newAuthId, 'probe@catalog.test', '验收成员', roleId, [grantedWarehouse.id], true]);
    const newProfileId = createdAccount?.profileId ?? null;
    const createdDetail = newProfileId
      ? await readAs(owner, ADMIN_PROFILE_ID, 'catalog.read_access_account', [newProfileId]) : null;
    evidence.createdAccount = { created: createdAccount, detail: createdDetail };
    check(results, '建号成功：profiles/映射/角色/仓库范围一次写入并回读一致',
      createdAccount?.ok === true && createdDetail?.email === 'probe@catalog.test'
      && createdDetail.displayName === '验收成员' && createdDetail.isActive === true
      && createdDetail.warehouses.length === 1 && createdDetail.warehouses[0].warehouseId === grantedWarehouse.id,
      { created: createdAccount, detail: createdDetail && { ...createdDetail, warehouses: createdDetail.warehouses.length } });

    const newMemberRows = await readAs(owner, newProfileId, 'catalog.read_inventory_warehouse_rows', [null, null, null]);
    check(results, '新建成员立即可按范围读取（1 个仓）',
      newMemberRows?.scope?.warehouseCount === 1 && newMemberRows.rows.length > 0
      && newMemberRows.rows.every((row) => row.warehouseId === grantedWarehouse.id),
      { total: newMemberRows?.total, warehouses: newMemberRows?.scope?.warehouseCount });

    const movedScope = await readAs(owner, ADMIN_PROFILE_ID, 'catalog.update_access_account',
      [newProfileId, '验收成员', roleId, true, [otherWarehouse.id]]);
    const movedRows = await readAs(owner, newProfileId, 'catalog.read_inventory_warehouse_rows', [null, null, null]);
    check(results, '改仓库范围后立即生效：原仓不可见、新仓可见',
      movedScope?.ok === true && movedRows?.scope?.warehouseCount === 1
      && movedRows.rows.every((row) => row.warehouseId === otherWarehouse.id)
      && movedRows.rows.length > 0,
      { total: movedRows?.total, warehouse: movedRows?.rows?.[0]?.warehouseId });

    const disabled = await readAs(owner, ADMIN_PROFILE_ID, 'catalog.set_access_account_active', [newProfileId, false]);
    const disabledRead = await expectFailure(owner, newProfileId, 'catalog.read_inventory_warehouse_rows', [null, null, null]);
    check(results, '停用后不能继续读取（CATALOG_FORBIDDEN）',
      disabled?.ok === true && disabled.isActive === false && disabledRead === 'CATALOG_FORBIDDEN',
      { disabled, error: disabledRead });

    const adminTarget = await expectFailure(owner, ADMIN_PROFILE_ID, 'catalog.set_access_account_active',
      [ADMIN_PROFILE_ID, false]);
    check(results, '管理员账号不可停用（ACCESS_ADMIN_ACCOUNT_IMMUTABLE）',
      adminTarget === 'ACCESS_ADMIN_ACCOUNT_IMMUTABLE', { error: adminTarget });

    const adminMutations = await expectFailure(owner, OPERATOR_PROFILE_ID, 'catalog.save_access_role',
      [null, '越权角色', null, true, false]);
    check(results, '成员不能调用管理员 RPC（CATALOG_FORBIDDEN）',
      adminMutations === 'CATALOG_FORBIDDEN', { error: adminMutations });

    // 12. 审计留痕
    const audits = (await owner.query(
      `SELECT action,entity_ref,detail FROM catalog.inventory_audit
        WHERE action LIKE 'access_%' ORDER BY at DESC LIMIT 20`)).rows;
    evidence.accessAudits = audits.map((row) => ({ action: row.action, entity: row.entity_ref }));
    check(results, '角色/账号写操作写入 inventory_audit（access_role_* / access_account_*）',
      audits.some((row) => row.action === 'access_role_created')
      && audits.some((row) => row.action === 'access_account_created')
      && audits.some((row) => row.action === 'access_account_updated')
      && audits.some((row) => row.action === 'access_account_disabled'),
      evidence.accessAudits);

    // 探针全部在 SAVEPOINT 内构造，先回滚，保证只读校验不受影响
    await owner.query('ROLLBACK TO SAVEPOINT seed_member');
    await owner.query('RELEASE SAVEPOINT seed_member');

    const countsAfterProbe = (await owner.query(countsSql)).rows[0];
    evidence.countsAfterProbe = countsAfterProbe;
    check(results, '探针回滚后业务行数与安装前一致（未写业务数据）',
      JSON.stringify(countsBefore) === JSON.stringify(countsAfterProbe),
      { before: countsBefore, after: countsAfterProbe });

    if (commit) {
      await owner.query('COMMIT');
      // 提交后新事务回读：表与函数存在、app 可执行、预置角色在位。
      await owner.query('BEGIN');
      const after = (await owner.query(accessTablesSql, [APP_ROLE])).rows;
      const roles = (await owner.query('SELECT count(*)::int AS n FROM catalog.access_role')).rows[0].n;
      const guards = {};
      for (const name of PATCHED_FUNCTIONS) {
        const rows = (await owner.query(functionStateSql, [APP_ROLE, name])).rows;
        guards[name] = rows.map((row) => ({ args: row.identity_args, readGuard: row.uses_read_guard > 0, app: row.app_exec }));
      }
      await owner.query('ROLLBACK');
      evidence.afterCommit = { tables: after.length, roles, guards };
      check(results, '提交后回读：3 张表、预置角色 2 条、7 个函数带新守卫（内部 helper 不对 app 开放）',
        after.length === 3 && roles === 2
        && PATCHED_FUNCTIONS.every((name) => guards[name].length === 1
          && (name === 'inventory_scope_payload'
            ? guards[name][0].app === false
            : guards[name][0].app === true && guards[name][0].readGuard === true)),
        { roles, tables: after.length, guards });
    } else {
      await owner.query('ROLLBACK');
      const afterTables = (await owner.query(
        `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='catalog' AND c.relname IN ('access_role','account_access','account_access_warehouse')`)).rows[0].n;
      check(results, 'rollback 后不留下新表（未半安装）', afterTables === 0, { tables: afterTables });
      const countsAfterRollback = (await owner.query(countsSql)).rows[0];
      check(results, 'rollback 后业务行数不变', JSON.stringify(countsBefore) === JSON.stringify(countsAfterRollback));
    }

    evidence.results = results;
    evidence.passed = results.every((item) => item.ok);
    evidence.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(EVIDENCE_DIR, commit ? 'apply-043-commit.json' : 'apply-043.json'),
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
    fs.writeFileSync(path.join(EVIDENCE_DIR, commit ? 'apply-043-commit.json' : 'apply-043.json'),
      `${JSON.stringify(evidence, null, 2)}\n`);
    console.error('[apply-043] failed:', error.message);
    process.exitCode = 1;
  } finally {
    await owner.end().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
