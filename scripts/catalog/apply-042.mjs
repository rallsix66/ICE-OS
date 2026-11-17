/**
 * 把 042「操作记录只读汇合」应用到一个 catalog 库。
 *
 * 042 只新增一个只读函数（不建表、不改 001-041、不写任何业务数据）：
 *   catalog.read_operation_records(text,uuid,timestamptz,timestamptz,text,int,int) -> jsonb
 *   = 商品资料 / 库存对应 / 物流 三类已保存的人工处理记录，按时间倒序分页 + 分类计数 + 账号清单。
 *
 * 模式（默认绝不改目标库）：
 *   --rollback（默认）：事务内安装 → 结构/权限/真实数据探针 → ROLLBACK
 *   --commit          ：安装 → 回读 → 真实数据探针 → COMMIT
 *   安全闸门：目标库名等于现役库名时 --commit 必须显式 --allow-live-commit。
 *
 * 用法：
 *   node scripts/catalog/apply-042.mjs --rollback --run-id run-20261026T211500Z-11a22b33
 *   node scripts/catalog/apply-042.mjs --commit --allow-live-commit --run-id run-20261026T211500Z-11a22b33
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
const SQL_FILE = 'db/catalog/042_operation_records.sql';
const FUNCTION = 'read_operation_records';
const APP_ROLE = 'ice_p0_02_app_runner';
const ADMIN_PROFILE_ID = '11111111-1111-4111-8111-111111111101';
const EVIDENCE_DIR = path.join(REPO_ROOT, '.local', 'catalog', 'operations-log-r2-20261117');

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
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail === undefined ? '' : ` :: ${JSON.stringify(detail).slice(0, 500)}`}`);
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
  pg_catalog.has_function_privilege($1, p.oid, 'EXECUTE') AS app_exec,
  pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='catalog' AND p.proname=$2
 ORDER BY identity_args`;

const countsSql = `SELECT
  (SELECT count(*) FROM catalog.audit_event)::int AS audit_events,
  (SELECT count(*) FROM catalog.item_revision)::int AS item_revisions,
  (SELECT count(*) FROM catalog.product_source_batch)::int AS source_batches,
  (SELECT count(*) FROM catalog.product_source_duplicate_decision)::int AS duplicate_decisions,
  (SELECT count(*) FROM catalog.product_source_field_decision)::int AS field_decisions,
  (SELECT count(*) FROM catalog.inventory_audit)::int AS inventory_audits,
  (SELECT count(*) FROM catalog.inventory_sku_mapping)::int AS sku_mappings,
  (SELECT count(*) FROM catalog.shipment_item_association_revision)::int AS association_revisions,
  (SELECT count(*) FROM catalog.shipment_item_manual_revision)::int AS manual_revisions,
  (SELECT count(*) FROM catalog.shipment_grouping_review)::int AS grouping_reviews,
  (SELECT count(*) FROM catalog.shipment_grouping_override)::int AS grouping_overrides`;

async function install(owner, sql) {
  await owner.query(sql);
  await owner.query('RESET ROLE; RESET ALL');
}

async function asApp(owner, fn) {
  await owner.query(`SET LOCAL ROLE ${APP_ROLE}`);
  await owner.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [ADMIN_PROFILE_ID]);
  try {
    return await fn();
  } finally {
    await owner.query('RESET ROLE; RESET ALL');
  }
}

async function readRecords(owner, params) {
  return asApp(owner, async () => (await owner.query(
    'SELECT catalog.read_operation_records($1::text,$2::uuid,$3::timestamptz,$4::timestamptz,$5::text,$6::integer,$7::integer) AS r',
    params)).rows[0]?.r ?? null);
}

/** 独立重算（不调用被测函数）：三类记录应出现的条数。 */
const expectedSql = `SELECT
  (SELECT count(*) FROM catalog.product_source_batch b WHERE b.status IN ('applied','partial'))::int
  + (SELECT count(*) FROM catalog.audit_event a WHERE a.action IN ('assign_source_code','assign_initial_code','correct_test_source_code')
      OR (a.action='resolve_source_issue' AND coalesce(a.result->>'issueKind','') LIKE 'missing%'))::int
  + (SELECT count(*) FROM catalog.product_source_duplicate_decision)::int
  + (SELECT count(*) FROM catalog.product_source_duplicate_decision d
      WHERE d.state='superseded' AND d.superseded_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM catalog.audit_event a2
          WHERE a2.action='restore_duplicate_source_decision'
            AND (a2.result->>'decisionId'=d.id::text OR a2.result->>'revokedDecisionId'=d.id::text)))::int
  + (SELECT count(*) FROM catalog.product_source_field_decision)::int
  + (SELECT count(*) FROM catalog.product_source_field_decision f WHERE f.revoked_at IS NOT NULL)::int
  + (SELECT count(*) FROM catalog.item_revision r
      WHERE NOT EXISTS (SELECT 1 FROM catalog.product_source_batch b2
        WHERE b2.snapshot_key IS NOT NULL AND r.evidence_ref LIKE 'product-source:'||b2.snapshot_key||'%')
        AND NOT EXISTS (SELECT 1 FROM catalog.audit_event a3
          WHERE a3.item_id=r.item_id
            AND a3.action IN ('assign_source_code','assign_initial_code','correct_test_source_code')
            AND (a3.result->>'revision') ~ '^[0-9]+$' AND (a3.result->>'revision')::int=r.revision))::int
  + (SELECT count(*) FROM catalog.inventory_audit a WHERE a.action='confirm_inventory_mapping')::int
  + (SELECT count(*) FROM catalog.inventory_audit a
      WHERE a.action IN ('recheck_inventory_mapping','disable_inventory_mapping','replace_inventory_mapping'))::int
  + (SELECT count(*) FROM catalog.inventory_audit a WHERE a.action='apply_domestic_review_decision')::int
  + (SELECT count(*) FROM (
      SELECT 1 FROM catalog.shipment_item_association_revision r
      JOIN catalog.shipment_item i ON i.id=r.item_id
      JOIN catalog.shipment s ON s.id=i.shipment_id
      WHERE r.method IN ('manual_selected','manual_cleared')
      GROUP BY r.recorded_at,r.actor_id,r.method,s.id))::int
  + (SELECT count(*) FROM catalog.shipment_item_manual_revision)::int
  + (SELECT count(*) FROM catalog.shipment_grouping_review g
      WHERE g.status='resolved' AND g.resolved_at IS NOT NULL AND g.resolved_by IS NOT NULL)::int
  + (SELECT count(*) FROM catalog.shipment_grouping_override o
      WHERE o.active=false AND o.revoked_at IS NOT NULL)::int AS expected_total`;

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
    const expected = (await owner.query(expectedSql)).rows[0]?.expected_total ?? null;
    evidence.expectedTotal = expected;
    const beforeFunctions = (await owner.query(functionStateSql, [APP_ROLE, FUNCTION])).rows
      .map((row) => row.identity_args).sort();
    evidence.functionsBefore = beforeFunctions;

    await owner.query('BEGIN');
    await install(owner, sql);
    const first = (await owner.query(functionStateSql, [APP_ROLE, FUNCTION])).rows;
    await install(owner, sql);
    const second = (await owner.query(functionStateSql, [APP_ROLE, FUNCTION])).rows;
    evidence.install = second[0] ? {
      identityArgs: second[0].identity_args,
      resultType: second[0].result_type,
      prosecdef: second[0].prosecdef,
      proconfig: second[0].proconfig,
      provolatile: second[0].provolatile,
      owner: second[0].owner_name,
      bodySha256: second[0].body_sha256,
      appExec: second[0].app_exec,
      publicExec: second[0].public_exec,
    } : null;
    check(results, '042 安装两次均成功（幂等，无报错）', true, { applications: 2 });
    check(results, '只读函数仅一个重载（text,uuid,timestamptz,timestamptz,text,int,int）',
      second.length === 1 && second[0].identity_args
        === 'p_category text, p_actor uuid, p_from timestamp with time zone, p_to timestamp with time zone, p_search text, p_limit integer, p_offset integer',
      second.map((row) => row.identity_args));
    check(results, 'SECURITY DEFINER + search_path 锁定为空 + STABLE',
      second[0]?.prosecdef === true && searchPathLocked(second[0]?.proconfig) && second[0]?.provolatile === 's',
      { proconfig: second[0]?.proconfig, provolatile: second[0]?.provolatile });
    check(results, '属主 ice_p0_02_owner / app 可执行 / PUBLIC 不可执行',
      second[0]?.owner_name === 'ice_p0_02_owner' && second[0]?.app_exec === true && second[0]?.public_exec === false,
      { owner: second[0]?.owner_name, app: second[0]?.app_exec, public: second[0]?.public_exec });
    check(results, '两次安装函数体哈希一致（幂等）', first[0]?.body_sha256 === second[0]?.body_sha256);

    // 未登录 / 非管理员不能读：不带 request.jwt.claim.sub 时 require_admin 拒绝。
    await owner.query(`SET LOCAL ROLE ${APP_ROLE}`);
    await owner.query('SAVEPOINT forbidden_probe');
    let forbidden = null;
    try {
      await owner.query('SELECT catalog.read_operation_records(NULL,NULL,NULL,NULL,NULL,10,0)');
    } catch (error) {
      forbidden = error.message;
    }
    await owner.query('ROLLBACK TO SAVEPOINT forbidden_probe');
    await owner.query('RESET ROLE; RESET ALL');
    check(results, '未登录（无管理员身份）读取被拒绝 CATALOG_FORBIDDEN', forbidden === 'CATALOG_FORBIDDEN', { error: forbidden });

    // 全量：总数、分类计数、排序、必填字段、id 唯一
    const page1 = await readRecords(owner, ['all', null, null, null, null, 200, 0]);
    const page2 = await readRecords(owner, ['all', null, null, null, null, 200, 200]);
    const allRows = [...(page1?.rows ?? []), ...(page2?.rows ?? [])];
    evidence.all = { total: page1?.total, fetched: allRows.length, offset: page1?.offset, limit: page1?.limit };
    check(results, '全量总数 = 独立重算条数，且能分两页取全',
      page1?.ok === true && page1.total === expected && allRows.length === expected
      && new Set(allRows.map((row) => row.id)).size === expected,
      { total: page1?.total, expected, fetched: allRows.length });
    check(results, '分类计数之和 = 总数（catalog/inventory/shipment）',
      Number(page1?.categoryCounts?.catalog ?? 0) + Number(page1?.categoryCounts?.inventory ?? 0)
      + Number(page1?.categoryCounts?.shipment ?? 0) === page1?.total,
      page1?.categoryCounts);
    check(results, '按时间倒序（相邻两条 at 不递增）',
      allRows.every((row, index) => index === 0 || Date.parse(allRows[index - 1].at) >= Date.parse(row.at)));
    check(results, '每条都有时间/类别/动作/业务对象/详情，id 唯一',
      allRows.every((row) => row.at && row.category && row.action && row.objectKind
        && row.objectTitle && row.detail && typeof row.detail === 'object'));
    check(results, '记录账号经 profiles 解析为显示名（不返回 UUID 作为姓名）',
      allRows.every((row) => row.actorId === null || typeof row.actorName === 'string')
      && (page1?.actors ?? []).every((actor) => typeof actor.name === 'string' && actor.name.length > 0),
      page1?.actors);

    // 三类各取一条真实样例，与原始记录逐字段核对。
    const batchRow = allRows.find((row) => row.action === 'source_batch_applied');
    const batchSource = batchRow ? (await owner.query(
      `SELECT b.status,b.counts,a.recorded_at,a.result->'counts' AS audit_counts
         FROM catalog.product_source_batch b
         LEFT JOIN LATERAL (SELECT a2.* FROM catalog.audit_event a2
           WHERE a2.action='apply_product_source_batch' AND a2.result->>'batchId'=b.id::text
           ORDER BY a2.recorded_at DESC LIMIT 1) a ON true
        WHERE b.id=$1`, [batchRow.batchId])).rows[0] : null;
    evidence.batch = { row: batchRow && { id: batchRow.id, at: batchRow.at, title: batchRow.objectTitle, batchId: batchRow.batchId, counts: batchRow.detail?.counts, results: batchRow.detail?.results?.length }, source: batchSource };
    check(results, '来源采用记录：时间/状态/counts 与批次+审计回执一致，明细只含已写入行',
      Boolean(batchRow) && batchSource
      && Date.parse(batchRow.at) === new Date(batchSource.recorded_at).getTime()
      && JSON.stringify(batchRow.detail.counts) === JSON.stringify(batchSource.audit_counts)
      && (batchRow.detail.results ?? []).every((entry) => entry.itemRevision != null || entry.action === 'failed'));

    const rebindRow = allRows.find((row) => row.action === 'inventory_rebind');
    const rebindItem = rebindRow?.detail?.items?.[0] ?? null;
    const rebindSource = rebindItem ? (await owner.query(
      `SELECT m.version,m.external_sku,m.item_id AS new_item,
              pm.item_id AS old_item,
              (SELECT cc.ice_code FROM catalog.catalog_item_code cc WHERE cc.item_id=m.item_id LIMIT 1) AS new_code,
              (SELECT cc.ice_code FROM catalog.catalog_item_code cc WHERE cc.item_id=pm.item_id LIMIT 1) AS old_code,
              w.external_name
         FROM catalog.inventory_sku_mapping m
         JOIN catalog.inventory_sku_mapping pm ON pm.id=m.supersedes_id
         JOIN catalog.inventory_warehouse w ON w.id=m.warehouse_id
        WHERE m.id=$1`, [rebindItem.mappingId])).rows[0] : null;
    evidence.rebind = { item: rebindItem, source: rebindSource };
    check(results, '换绑记录：版本/来源 SKU/新旧商品与对应行历史一致（前值取被替代行）',
      Boolean(rebindItem) && Boolean(rebindSource)
      && rebindItem.version === rebindSource.version
      && rebindItem.externalSku === rebindSource.external_sku
      && rebindItem.itemId === rebindSource.new_item
      && rebindItem.iceCode === rebindSource.new_code
      && rebindItem.previousItemId === rebindSource.old_item
      && rebindItem.previousIceCode === rebindSource.old_code
      && rebindItem.warehouseName === rebindSource.external_name);

    const manualRow = allRows.find((row) => row.action === 'shipment_manual_correction');
    const manualSource = manualRow ? (await owner.query(
      `SELECT m.action,m.manual_status,m.previous_manual_status,m.received_quantity,m.remaining_quantity,m.recorded_at,s.ticket_no
         FROM catalog.shipment_item_manual_revision m
         JOIN catalog.shipment_item i ON i.id=m.item_id
         JOIN catalog.shipment s ON s.id=i.shipment_id
        WHERE m.item_id=$1 AND m.revision=$2`, [manualRow.detail.itemId, manualRow.detail.revision])).rows[0] : null;
    evidence.manual = { row: manualRow && { at: manualRow.at, ticketNo: manualRow.ticketNo, detail: manualRow.detail }, source: manualSource };
    const manualChecks = {
      atEq: Date.parse(manualRow.at) === new Date(manualSource.recorded_at).getTime(),
      ticketEq: manualRow.ticketNo === manualSource.ticket_no,
      actionEq: manualRow.detail.action === manualSource.action,
      prevEq: manualRow.detail.previousManualStatus === manualSource.previous_manual_status,
      recvEq: manualRow.detail.receivedQuantity === manualSource.received_quantity,
      remEq: manualRow.detail.remainingQuantity === manualSource.remaining_quantity,
      source: manualSource,
    };
    check(results, '人工修正记录：票号/动作/状态/数量与前值都取历史行',
      Boolean(manualRow) && Boolean(manualSource)
      && Object.values(manualChecks).filter((value) => typeof value === 'boolean').every(Boolean),
      manualChecks);

    const groupingRow = allRows.find((row) => row.action === 'shipment_grouping_decision');
    const groupingSource = groupingRow ? (await owner.query(
      `SELECT kind,decision,resolved_at,jsonb_array_length(coalesce(evidence->'affectedProducts','[]'::jsonb)) AS products
         FROM catalog.shipment_grouping_review WHERE id=$1`, [groupingRow.id.replace('grp:', '')])).rows[0] : null;
    evidence.grouping = { row: groupingRow && { at: groupingRow.at, title: groupingRow.objectTitle, detail: groupingRow.detail }, source: groupingSource };
    check(results, '分合票决定：类型/决定/时间/受影响商品数与复核行一致',
      Boolean(groupingRow) && Boolean(groupingSource)
      && groupingRow.detail.kind === groupingSource.kind
      && groupingRow.detail.decision === groupingSource.decision
      && Date.parse(groupingRow.at) === new Date(groupingSource.resolved_at).getTime()
      && (groupingRow.detail.affectedProducts ?? []).length === groupingSource.products);

    // 首版修订没有前值：不把当前值当作前值。
    const baselineRow = allRows.find((row) => row.action === 'item_baseline');
    check(results, '商品资料首版：previousRevision 为空、不生成前后值',
      Boolean(baselineRow) && baselineRow.detail.previousRevision === null
      && Array.isArray(baselineRow.detail.changes) && baselineRow.detail.changes.length === 0,
      baselineRow && { at: baselineRow.at, detail: baselineRow.detail });

    // 来源资料行选择：撤销状态与备注来自历史行。
    const dupRow = allRows.find((row) => row.action === 'duplicate_source_decision');
    const dupSource = dupRow ? (await owner.query(
      'SELECT state,chosen_row_number,note,superseded_at FROM catalog.product_source_duplicate_decision WHERE id=$1',
      [dupRow.id.replace('dup:', '')])).rows[0] : null;
    check(results, '来源资料选择：选择行/撤销状态/备注与历史行一致',
      Boolean(dupRow) && Boolean(dupSource)
      && dupRow.detail.state === dupSource.state
      && dupRow.detail.chosenRowNumber === dupSource.chosen_row_number
      && dupRow.detail.note === dupSource.note
      && Date.parse(dupRow.detail.supersededAt) === new Date(dupSource.superseded_at).getTime());

    // 筛选：类别 / 账号 / 日期（Asia/Shanghai 边界）/ 关键词 / 无结果 / 分页
    const cat = await readRecords(owner, ['shipment', null, null, null, null, 50, 0]);
    check(results, '业务类别筛选：只返回该类，总数与分类计数一致',
      cat?.ok === true && (cat.rows ?? []).every((row) => row.category === 'shipment')
      && cat.total === page1.categoryCounts.shipment,
      { total: cat?.total, expected: page1?.categoryCounts?.shipment });

    const actor = await readRecords(owner, ['all', ADMIN_PROFILE_ID, null, null, null, 50, 0]);
    check(results, '记录账号筛选：按 actor_id 过滤，条数与账号清单一致',
      actor?.ok === true && actor.total === page1.actors[0]?.count
      && (actor.rows ?? []).every((row) => row.actorId === ADMIN_PROFILE_ID),
      { total: actor?.total });

    // 2026-11-10 00:00–24:00 (+08)：场决定 14:44:50+08 应命中；11-11 的不应命中。
    const fromIso = '2026-11-09T16:00:00.000Z';
    const toIso = '2026-11-10T16:00:00.000Z';
    const day = await readRecords(owner, ['all', null, fromIso, toIso, null, 200, 0]);
    const dayRows = day?.rows ?? [];
    check(results, '日期筛选按 +08 自然日：命中 11-10 的 14:44(+08) 记录，不混入 11-11',
      day?.ok === true && dayRows.length > 0
      && dayRows.every((row) => Date.parse(row.at) >= Date.parse(fromIso) && Date.parse(row.at) < Date.parse(toIso))
      && dayRows.some((row) => row.action === 'field_decision'),
      { total: day?.total });

    const byCode = await readRecords(owner, ['all', null, null, null, 'WM0073', 50, 0]);
    check(results, '关键词按货号搜索：命中商品修订/批次/库存对应',
      byCode?.ok === true && byCode.total > 0
      && (byCode.rows ?? []).some((row) => row.action === 'source_batch_applied')
      && (byCode.rows ?? []).some((row) => row.action === 'item_baseline' || row.action === 'inventory_confirm'),
      { total: byCode?.total, actions: (byCode?.rows ?? []).map((row) => row.action) });

    const byTicket = await readRecords(owner, ['all', null, null, null, 'POKNZX027675', 50, 0]);
    check(results, '关键词按货票号搜索：命中人工关联（同一次保存合并为一条）',
      byTicket?.ok === true && byTicket.total >= 1
      && (byTicket.rows ?? []).some((row) => row.action === 'shipment_association_manual'),
      { total: byTicket?.total });

    const none = await readRecords(owner, ['all', null, null, null, '__NO_SUCH_BUSINESS_ID__', 50, 0]);
    check(results, '无结果：total=0、rows=[]、三个分类计数都为真实 0',
      none?.ok === true && none.total === 0 && Array.isArray(none.rows) && none.rows.length === 0
      && Object.keys(none.categoryCounts ?? {}).length === 3
      && Object.values(none.categoryCounts).every((value) => value === 0),
      none && { total: none.total, counts: none.categoryCounts });

    const paging = await readRecords(owner, ['all', null, null, null, null, 20, 20]);
    check(results, '分页：offset 20 / limit 20 与第一页不重复，总数不变',
      paging?.ok === true && paging.total === page1.total && paging.offset === 20
      && (paging.rows ?? []).length === Math.min(20, page1.total - 20)
      && (paging.rows ?? []).every((row) => !(page1.rows ?? []).slice(0, 20).some((first) => first.id === row.id)),
      { total: paging?.total, rows: paging?.rows?.length, offset: paging?.offset });

    const overflow = await readRecords(owner, ['all', null, null, null, null, 20, 100000]);
    check(results, '页码超出末页：返回空页但保留真实总数（页面据此回退页码）',
      overflow?.ok === true && overflow.total === page1.total && (overflow.rows ?? []).length === 0,
      { total: overflow?.total, rows: overflow?.rows?.length });

    // R1：字段键并集比较 —— WM0073 第 3 版删除了整个 barcode 键，仍要显示“已移除”。
    const wm0073Rev3 = allRows.find((row) => row.action === 'item_revision'
      && row.iceCode === 'WM0073' && row.detail.revision === 3);
    const barcodeRemoved = wm0073Rev3?.detail.changes?.find((change) => change.fieldKey === 'barcode');
    evidence.wm0073 = wm0073Rev3 && { at: wm0073Rev3.at, detail: wm0073Rev3.detail };
    check(results, 'R1 删除字段：WM0073 第 3 版显示商品条码 757577407359 → 已移除，上一版解析为第 2 版',
      Boolean(wm0073Rev3) && wm0073Rev3.detail.previousRevision === 2
      && barcodeRemoved?.changeKind === 'removed'
      && barcodeRemoved?.beforeRaw === '757577407359' && barcodeRemoved?.afterRaw == null,
      wm0073Rev3 && { previousRevision: wm0073Rev3.detail.previousRevision, barcodeRemoved });
    check(results, 'R1 首版判断：所有 item_baseline 都没有解析到上一版本，且不生成前后值',
      allRows.filter((row) => row.action === 'item_baseline').length === 126
      && allRows.filter((row) => row.action === 'item_baseline')
        .every((row) => row.detail.previousRevision === null && (row.detail.changes ?? []).length === 0),
      { baselines: allRows.filter((row) => row.action === 'item_baseline').length });

    // R2：同一次关联涉及 7 款商品，搜索其中任意一款都能找到同一条记录（一条操作、7 条明细）。
    const associationId = 'sar:131a88e4-4db7-4c15-9f4e-0791d2c59220:2:7:';
    const sevenCodes = ['WM0057', 'WM0058', 'WM0059', 'WM0061', 'WM0089', 'WM0090', 'WM0091'];
    const sevenHits = {};
    for (const code of sevenCodes) {
      const hit = await readRecords(owner, ['all', null, null, null, code, 200, 0]);
      const row = (hit?.rows ?? []).find((entry) => entry.id.startsWith(associationId));
      sevenHits[code] = row ? { at: row.at, items: row.detail.items?.length } : null;
    }
    evidence.sevenCodeSearch = sevenHits;
    check(results, 'R2 搜索覆盖同次操作全部商品：七款货号分别搜索都命中同一条人工关联（7 条明细）',
      sevenCodes.every((code) => sevenHits[code]?.items === 7)
      && new Set(sevenCodes.map((code) => JSON.stringify(sevenHits[code]))).size === 1,
      sevenHits);
    const assocRow = allRows.find((row) => row.id.startsWith(associationId));
    const assocCodes = [...new Set((assocRow?.detail.items ?? []).map((item) => item.iceCode))].sort();
    check(results, 'R2 关联记录明细保留七款不同商品（不是只取一个货号/名称）',
      assocCodes.length === 7 && sevenCodes.slice().sort().every((code) => assocCodes.includes(code)),
      assocCodes);

    // R3：历史批次 4173 写入 94 款，SQL 返回全部明细；第 41 款 WM0054 及其字段变化可达。
    const bigBatch = allRows.find((row) => row.action === 'source_batch_applied'
      && row.batchId === '4173cf60-dd81-4b1b-a0f2-f84674f0ac99');
    const wm0054 = bigBatch?.detail.results?.find((entry) => entry.iceCode === 'WM0054');
    evidence.bigBatch = bigBatch && { at: bigBatch.at, resultRowCount: bigBatch.detail.resultRowCount, results: bigBatch.detail.results?.length, wm0054 };
    check(results, 'R3 历史批次明细完整：4173 共 94 款全部返回，第 41 款 WM0054 含字段变化',
      Boolean(bigBatch) && bigBatch.detail.resultRowCount === 94 && bigBatch.detail.results.length === 94
      && wm0054?.itemRevision === 2
      && wm0054?.changes?.some((change) => change.fieldKey === 'factory'
        && change.beforeRaw == null && change.afterRaw === '广州圣宝兰生物科技有限公司'),
      bigBatch && { resultRowCount: bigBatch.detail.resultRowCount, wm0054: wm0054?.iceCode });
    check(results, 'R3 明细顺序稳定（按货号），WM0054 位于第 41 款',
      Boolean(bigBatch) && bigBatch.detail.results[40]?.iceCode === 'WM0054',
      bigBatch && bigBatch.detail.results.slice(38, 42).map((entry) => entry.iceCode));

    // R4：撤销在实际撤销时间（2026-11-10 14:44:50 +08）成为独立记录，原决定保留在 12:36:38。
    const revokeWindow = await readRecords(owner, ['all', null, '2026-11-10T06:40:00Z', '2026-11-10T06:50:00Z', null, 200, 0]);
    const fieldRevoke = (revokeWindow?.rows ?? []).find((row) => row.action === 'source_field_decision_revoked');
    const dupRevokes = (revokeWindow?.rows ?? []).filter((row) => row.action === 'duplicate_source_decision_revoked');
    const dupDecisionIds = new Set(dupRevokes.map((row) => row.detail.decisionId));
    evidence.revocationWindow = {
      total: revokeWindow?.total,
      actions: (revokeWindow?.rows ?? []).map((row) => row.action),
      fieldRevoke: fieldRevoke && { at: fieldRevoke.at, detail: fieldRevoke.detail },
      dupRevokes: dupRevokes.map((row) => ({ at: row.at, actorId: row.actorId, detail: row.detail })),
    };
    check(results, 'R4 字段口径撤销：14:44:50(+08) 独立显示撤销，原决定时间保留为 12:36:38(+08)',
      Boolean(fieldRevoke)
      && Date.parse(fieldRevoke.at) === Date.parse('2026-11-10T06:44:50.408Z')
      && fieldRevoke.detail.fieldKey === 'unitWeight'
      && Date.parse(fieldRevoke.detail.decidedAt) === Date.parse('2026-11-10T04:36:38.362Z')
      && fieldRevoke.actorId === ADMIN_PROFILE_ID,
      fieldRevoke && { at: fieldRevoke.at, detail: fieldRevoke.detail });
    check(results, 'R4 来源行选择撤销：四条决定各有一条独立撤销记录（不重复计数），撤销账号来自审计',
      dupRevokes.length === 4 && dupDecisionIds.size === 4
      && dupRevokes.every((row) => row.actorId === ADMIN_PROFILE_ID
        && Date.parse(row.at) === Date.parse('2026-11-10T06:44:50.408Z')
        && row.detail.originalAction === 'duplicate_source_decision'),
      dupRevokes.map((row) => row.detail.decisionId));
    check(results, 'R4 原决定保存明确撤销事实：revoked=true + 撤销时间/账号，与独立撤销记录指向同一条决定',
      dupRevokes.every((revokedRow) => {
        const original = allRows.find((row) => row.action === 'duplicate_source_decision'
          && row.detail.decisionId === undefined && row.id === `dup:${revokedRow.detail.decisionId}`);
        return Boolean(original) && original.detail.revoked === true
          && Date.parse(original.detail.revokedAt) === Date.parse(revokedRow.at)
          && original.detail.revokedByName === 'ISOLATED TEST admin';
      }),
      dupRevokes.map((row) => row.detail.decisionId));

    /*
     * R4 构造投影（不是完整业务写入链）：直接插入一条“正常改选”旧决定
     * （state=superseded，但没有 restore 审计）和一条新的 active 决定，
     * 验证查询把旧决定显示为“被后续选择替代”，不另造撤销记录。
     * 全部在 SAVEPOINT 内，随后回滚，不留在现役库。
     */
    const fixtureCode = 'R4-NORMAL-RESELECT';
    await owner.query('SAVEPOINT r4_normal_reselect');
    try {
      const fixtureBase = (await owner.query(
        `SELECT d.profile_id,d.item_id,d.decided_by
           FROM catalog.product_source_duplicate_decision d
          ORDER BY d.decided_at DESC LIMIT 1`)).rows[0];
      const sha = 'a'.repeat(64);
      const oldDecisionId = (await owner.query(
        `INSERT INTO catalog.product_source_duplicate_decision(profile_id,ice_code,item_id,
           chosen_row_number,chosen_row_sha256,basis_sha256,evidence_row_sha256,chosen_fields,comparison,
           state,decided_by,decided_at,superseded_at,note)
         VALUES($1,$2,$3,1,$4,$4,$4,'{"nameCn":{"raw":"构造旧选择"}}'::jsonb,
           '{"rowNumbers":[1,2],"fields":[]}'::jsonb,'superseded',$5,now()-interval '1 hour',now(),'构造旧选择')
         RETURNING id`,
        [fixtureBase.profile_id, fixtureCode, fixtureBase.item_id, sha, fixtureBase.decided_by])).rows[0].id;
      const newDecisionId = (await owner.query(
        `INSERT INTO catalog.product_source_duplicate_decision(profile_id,ice_code,item_id,
           chosen_row_number,chosen_row_sha256,basis_sha256,evidence_row_sha256,chosen_fields,comparison,
           state,decided_by,decided_at,note)
         VALUES($1,$2,$3,2,$4,$4,$4,'{"nameCn":{"raw":"构造新选择"}}'::jsonb,
           '{"rowNumbers":[1,2],"fields":[]}'::jsonb,'active',$5,now(),'构造新选择')
         RETURNING id`,
        [fixtureBase.profile_id, fixtureCode, fixtureBase.item_id, sha, fixtureBase.decided_by])).rows[0].id;
      const fixtureRows = (await readRecords(owner, ['catalog', null, null, null, fixtureCode, 50, 0]))?.rows ?? [];
      const oldRow = fixtureRows.find((row) => row.id === `dup:${oldDecisionId}`);
      const newRow = fixtureRows.find((row) => row.id === `dup:${newDecisionId}`);
      const revocationRows = fixtureRows.filter((row) => row.action === 'duplicate_source_decision_revoked');
      evidence.r4NormalReselectProjection = {
        oldDecisionId, newDecisionId, old: oldRow?.detail, new: newRow?.detail,
        revocationRows: revocationRows.map((row) => row.id),
      };
      check(results, 'R4 构造投影（正常改选）：旧决定 revoked=false、替代行号指向新选择，不生成撤销记录',
        Boolean(oldRow) && oldRow.detail.state === 'superseded' && oldRow.detail.revoked === false
        && oldRow.detail.replacementRowNumber === 2
        && Boolean(newRow) && newRow.detail.state === 'active'
        && revocationRows.length === 0,
        evidence.r4NormalReselectProjection);
    } finally {
      await owner.query('ROLLBACK TO SAVEPOINT r4_normal_reselect');
      await owner.query('RELEASE SAVEPOINT r4_normal_reselect');
    }
    check(results, 'R4 分合票只纳人工已处理决定（resolved + resolved_at + resolved_by）',
      allRows.filter((row) => row.action === 'shipment_grouping_decision')
        .every((row) => row.detail.status === 'resolved' && Boolean(row.detail.resolvedAt)),
      allRows.filter((row) => row.action === 'shipment_grouping_decision').map((row) => row.detail.status));

    // R5：类别计数不受当前类别筛选影响；全部业务 = 三类之和。
    const invOnly = await readRecords(owner, ['inventory', null, null, null, null, 50, 0]);
    check(results, 'R5 分类计数：选中库存对应时“全部业务”仍为三类之和，其它类别计数不变',
      invOnly?.ok === true && invOnly.total === invOnly.categoryCounts.inventory
      && invOnly.categoryCounts.catalog === page1.categoryCounts.catalog
      && invOnly.categoryCounts.shipment === page1.categoryCounts.shipment
      && Number(invOnly.categoryCounts.catalog) + Number(invOnly.categoryCounts.inventory)
        + Number(invOnly.categoryCounts.shipment) === page1.total,
      { total: invOnly?.total, counts: invOnly?.categoryCounts });

    const countsAfterProbe = (await owner.query(countsSql)).rows[0];
    evidence.countsAfterProbe = countsAfterProbe;
    check(results, '只读：所有业务行数前后不变',
      JSON.stringify(countsBefore) === JSON.stringify(countsAfterProbe),
      { before: countsBefore, after: countsAfterProbe });

    if (commit) {
      await owner.query('COMMIT');
      const after = (await owner.query(functionStateSql, [APP_ROLE, FUNCTION])).rows;
      check(results, '提交后函数存在且 app 可执行', after.length === 1 && after[0].app_exec === true);
      // 提交后本地事务已结束：SET LOCAL 不再生效，重开一个只读事务再以 app 角色读取一次。
      await owner.query('BEGIN READ ONLY');
      const live = await readRecords(owner, ['all', null, null, null, null, 5, 0]);
      await owner.query('ROLLBACK');
      check(results, '提交后 app 角色可读（limit 5）', live?.ok === true && live.rows.length === 5, { total: live?.total });
    } else {
      await owner.query('ROLLBACK');
      const after = (await owner.query(functionStateSql, [APP_ROLE, FUNCTION])).rows;
      const countsAfterRollback = (await owner.query(countsSql)).rows[0];
      evidence.countsAfterRollback = countsAfterRollback;
      check(results, 'rollback 后函数签名回到安装前（不留下半安装）',
        JSON.stringify(after.map((row) => row.identity_args).sort()) === JSON.stringify(beforeFunctions),
        { before: beforeFunctions, after: after.map((row) => row.identity_args) });
      check(results, 'rollback 后业务行数不变', JSON.stringify(countsBefore) === JSON.stringify(countsAfterRollback));
    }
    evidence.results = results;
    evidence.passed = results.every((item) => item.ok);
    evidence.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(EVIDENCE_DIR, commit ? 'apply-042-commit.json' : 'apply-042.json'),
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
    fs.writeFileSync(path.join(EVIDENCE_DIR, commit ? 'apply-042-commit.json' : 'apply-042.json'),
      `${JSON.stringify(evidence, null, 2)}\n`);
    console.error('[apply-042] failed:', error.message);
    process.exitCode = 1;
  } finally {
    await owner.end().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
