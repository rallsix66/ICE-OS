/**
 * 把 041「海外库存历史快照只读读取」应用到一个 catalog 库。
 *
 * 041 只新增两个只读函数（不建表、不改 016-040、不写任何业务数据）：
 *   A. catalog.read_inventory_snapshot_batches(uuid,int,int)             -> jsonb（单仓已发布批次分页，时间倒序）
 *   B. catalog.read_inventory_snapshot_rows(uuid,uuid,text,int,int)      -> jsonb（单批明细 + 历史归属）
 *   旧签名 (uuid) / (uuid,text,int,int) 由 041 显式 DROP，避免分页/明确批次语义出现重载歧义。
 *
 * 模式（默认绝不改目标库）：
 *   --rollback（默认）：事务内安装 → 结构/权限/真实数据探针 → ROLLBACK
 *   --commit          ：安装 → 回读 → 真实数据探针 → COMMIT
 *   安全闸门：目标库名等于现役库名时 --commit 必须显式 --allow-live-commit。
 *
 * 用法：
 *   node scripts/catalog/apply-041.mjs --rollback --run-id run-20261026T211500Z-11a22b33
 *   node scripts/catalog/apply-041.mjs --commit --allow-live-commit --run-id run-20261026T211500Z-11a22b33
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
const SQL_FILE = 'db/catalog/041_inventory_snapshot_reads.sql';
const BATCHES_FUNCTION = 'read_inventory_snapshot_batches';
const ROWS_FUNCTION = 'read_inventory_snapshot_rows';
const APP_ROLE = 'ice_p0_02_app_runner';
const ADMIN_PROFILE_ID = '11111111-1111-4111-8111-111111111101';
const EVIDENCE_DIR = path.join(REPO_ROOT, '.local', 'catalog', 'inventory-snapshot-20261116');

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
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail === undefined ? '' : ` :: ${JSON.stringify(detail).slice(0, 700)}`}`);
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
  p.prosrc,
  pg_catalog.has_function_privilege($1, p.oid, 'EXECUTE') AS app_exec,
  pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='catalog' AND p.proname=$2
 ORDER BY identity_args`;

const countsSql = `SELECT
  (SELECT count(*) FROM catalog.inventory_batch)::int AS batches,
  (SELECT count(*) FROM catalog.inventory_batch_row)::int AS batch_rows,
  (SELECT count(*) FROM catalog.inventory_warehouse)::int AS warehouses`;

async function install(owner, sql) {
  await owner.query(sql);
  await owner.query('RESET ROLE; RESET ALL');
}

async function probeBatches(owner, warehouseId, limit, offset) {
  await owner.query(`SET LOCAL ROLE ${APP_ROLE}`);
  await owner.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [ADMIN_PROFILE_ID]);
  const result = (await owner.query(
    'SELECT catalog.read_inventory_snapshot_batches($1::uuid,$2::integer,$3::integer) AS r',
    [warehouseId, limit, offset])).rows[0]?.r ?? null;
  await owner.query('RESET ROLE; RESET ALL');
  return result;
}

async function probeRows(owner, warehouseId, batchId, search, limit, offset) {
  await owner.query(`SET LOCAL ROLE ${APP_ROLE}`);
  await owner.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [ADMIN_PROFILE_ID]);
  const result = (await owner.query(
    'SELECT catalog.read_inventory_snapshot_rows($1::uuid,$2::uuid,$3::text,$4::integer,$5::integer) AS r',
    [warehouseId, batchId, search, limit, offset])).rows[0]?.r ?? null;
  await owner.query('RESET ROLE; RESET ALL');
  return result;
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
    const tablePrivBefore = (await owner.query(
      `SELECT has_table_privilege($1,'catalog.inventory_batch','SELECT') AS batch,
              has_table_privilege($1,'catalog.inventory_batch_row','SELECT') AS batch_row`,
      [APP_ROLE])).rows[0];
    // 安装前的函数签名快照：rollback 后必须与安装前完全一致（旧签名存在时不允许被半安装替换）。
    const beforeFunctions = {
      batches: (await owner.query(functionStateSql, [APP_ROLE, BATCHES_FUNCTION])).rows
        .map((row) => row.identity_args).sort(),
      rows: (await owner.query(functionStateSql, [APP_ROLE, ROWS_FUNCTION])).rows
        .map((row) => row.identity_args).sort(),
    };
    evidence.functionsBefore = beforeFunctions;
    await owner.query('BEGIN');
    await install(owner, sql);
    const batches1 = (await owner.query(functionStateSql, [APP_ROLE, BATCHES_FUNCTION])).rows;
    const rows1 = (await owner.query(functionStateSql, [APP_ROLE, ROWS_FUNCTION])).rows;
    await install(owner, sql);
    const batches2 = (await owner.query(functionStateSql, [APP_ROLE, BATCHES_FUNCTION])).rows;
    const rows2 = (await owner.query(functionStateSql, [APP_ROLE, ROWS_FUNCTION])).rows;
    evidence.install = {
      applications: 2,
      batches: batches2[0] ? {
        identityArgs: batches2[0].identity_args, resultType: batches2[0].result_type,
        prosecdef: batches2[0].prosecdef, proconfig: batches2[0].proconfig,
        provolatile: batches2[0].provolatile, owner: batches2[0].owner_name,
        bodySha256: batches2[0].body_sha256, appExec: batches2[0].app_exec, publicExec: batches2[0].public_exec,
      } : null,
      rows: rows2[0] ? {
        identityArgs: rows2[0].identity_args, resultType: rows2[0].result_type,
        prosecdef: rows2[0].prosecdef, proconfig: rows2[0].proconfig,
        provolatile: rows2[0].provolatile, owner: rows2[0].owner_name,
        bodySha256: rows2[0].body_sha256, appExec: rows2[0].app_exec, publicExec: rows2[0].public_exec,
      } : null,
    };
    check(results, '041 安装两次均成功（幂等，无报错）', true, { applications: 2 });
    check(results, '批次函数仅一个重载（uuid,integer,integer）',
      batches2.length === 1
      && batches2[0].identity_args === 'p_warehouse uuid, p_limit integer, p_offset integer',
      batches2.map((row) => row.identity_args));
    check(results, '明细函数仅一个重载（uuid,uuid,text,integer,integer）',
      rows2.length === 1
      && rows2[0].identity_args === 'p_warehouse uuid, p_batch uuid, p_search text, p_limit integer, p_offset integer',
      rows2.map((row) => row.identity_args));
    check(results, '两个函数均为 SECURITY DEFINER + search_path 锁定为空 + STABLE',
      batches2[0]?.prosecdef === true && rows2[0]?.prosecdef === true
      && searchPathLocked(batches2[0]?.proconfig) && searchPathLocked(rows2[0]?.proconfig)
      && batches2[0]?.provolatile === 's' && rows2[0]?.provolatile === 's',
      { batches: batches2[0]?.proconfig, rows: rows2[0]?.proconfig });
    check(results, '两个函数属主 ice_p0_02_owner / app 可执行 / PUBLIC 不可执行',
      batches2[0]?.owner_name === 'ice_p0_02_owner' && rows2[0]?.owner_name === 'ice_p0_02_owner'
      && batches2[0]?.app_exec === true && rows2[0]?.app_exec === true
      && batches2[0]?.public_exec === false && rows2[0]?.public_exec === false,
      { batches: { owner: batches2[0]?.owner_name, app: batches2[0]?.app_exec, public: batches2[0]?.public_exec },
        rows: { owner: rows2[0]?.owner_name, app: rows2[0]?.app_exec, public: rows2[0]?.public_exec } });
    check(results, '两次安装函数体哈希一致（幂等）',
      batches1[0]?.body_sha256 === batches2[0]?.body_sha256 && rows1[0]?.body_sha256 === rows2[0]?.body_sha256);
    const tablePriv = (await owner.query(
      `SELECT has_table_privilege($1,'catalog.inventory_batch','SELECT') AS batch,
              has_table_privilege($1,'catalog.inventory_batch_row','SELECT') AS batch_row`,
      [APP_ROLE])).rows[0];
    check(results, '041 不改变表权限（安装前后一致；沿用现有读取权限）',
      JSON.stringify(tablePriv) === JSON.stringify(tablePrivBefore),
      { before: tablePrivBefore, after: tablePriv });

    // 真实数据探针：选一个有两个以上批次的仓；用最新两批对账同一 SKU、真实 0、未绑定行与搜索未命中。
    const warehouse = (await owner.query(`SELECT b.warehouse_id, count(*)::int AS batches
      FROM catalog.inventory_batch b GROUP BY b.warehouse_id HAVING count(*)>=2
      ORDER BY count(*) DESC, b.warehouse_id LIMIT 1`)).rows[0];
    evidence.warehouse = warehouse ?? null;
    if (warehouse) {
      const batchList = await probeBatches(owner, warehouse.warehouse_id, 200, 0);
      evidence.batchList = {
        listed: Array.isArray(batchList?.batches) ? batchList.batches.length : null,
        batchTotal: batchList?.batchTotal,
        offset: batchList?.offset,
        limit: batchList?.limit,
        first: batchList?.batches?.[0] ?? null,
        last: batchList?.batches?.[batchList.batches.length - 1] ?? null,
      };
      const listed = Array.isArray(batchList?.batches) ? batchList.batches : [];
      const ordered = listed.every((entry, index) => index === 0
        || Date.parse(listed[index - 1].observationAt) >= Date.parse(entry.observationAt));
      check(results, '批次列表返回该仓已发布批次，按 observation_at 倒序且无重复',
        listed.length >= 2 && ordered
        && new Set(listed.map((entry) => entry.batchId)).size === listed.length
        && batchList.batchTotal >= listed.length,
        { listed: listed.length, total: batchList?.batchTotal, ordered });
      check(results, '批次列表字段齐全（observationAt/publishedAt/rowCount/adoptedCount/unmappedCount）',
        listed.every((entry) => typeof entry.batchId === 'string' && typeof entry.observationAt === 'string'
          && typeof entry.publishedAt === 'string' && Number.isInteger(entry.rowCount)
          && Number.isInteger(entry.adoptedCount) && Number.isInteger(entry.unmappedCount)));
      // 批次列表分页：offset 5 / limit 5 与第一页 5 条不重复，总数不变。
      const page2 = await probeBatches(owner, warehouse.warehouse_id, 5, 5);
      const page2Ids = (page2?.batches ?? []).map((entry) => entry.batchId);
      check(results, '批次列表分页：offset 5 / limit 5 返回第 6–10 批，与第一页不重复',
        page2?.offset === 5 && page2?.limit === 5 && page2?.batchTotal === batchList.batchTotal
        && page2Ids.length === Math.min(5, Math.max(0, batchList.batchTotal - 5))
        && page2Ids.every((id) => !listed.slice(0, 5).some((entry) => entry.batchId === id)),
        { total: page2?.batchTotal, offset: page2?.offset, ids: page2Ids });
      // 页码超出末页时回退到最后一页（页面据此显示真实页码，不出现空的更早批次页）。
      const lastPageOffset = Math.floor((batchList.batchTotal - 1) / 5) * 5;
      const lastPage = await probeBatches(owner, warehouse.warehouse_id, 5, lastPageOffset + 5);
      check(results, '批次列表页码超出末页时回退到最后一页（不返回空页）',
        lastPage?.offset === lastPageOffset && Array.isArray(lastPage?.batches) && lastPage.batches.length > 0,
        { requested: lastPageOffset + 5, resolved: lastPage?.offset, rows: lastPage?.batches?.length });
      const latest = listed[0];
      const previous = listed[1];
      const detail = await probeRows(owner, warehouse.warehouse_id, latest.batchId, null, 200, 0);
      evidence.detail = {
        ok: detail?.ok, total: detail?.total, matched: detail?.matched,
        rowCount: Array.isArray(detail?.rows) ? detail.rows.length : null,
        batch: detail?.batch ?? null,
      };
      check(results, '明细返回选定批次元数据（仓库/观测时间/行数）',
        detail?.ok === true && detail?.batch?.batchId === latest.batchId
        && detail?.batch?.warehouseId === warehouse.warehouse_id
        && detail?.batch?.observationAt === latest.observationAt
        && detail?.total === latest.rowCount,
        { batch: detail?.batch, total: detail?.total });
      check(results, '明细行数 = min(批次行数, 分页上限)，且不与总数混淆',
        Array.isArray(detail?.rows) && detail.rows.length === Math.min(latest.rowCount, 200),
        { rows: detail?.rows?.length, rowCount: latest.rowCount });
      check(results, '明细带该批在本仓的倒序位置与批次总数（batchRank/batchTotal）',
        detail?.batchRank === 1 && detail?.batchTotal === batchList.batchTotal,
        { rank: detail?.batchRank, total: detail?.batchTotal, expectedTotal: batchList.batchTotal });
      check(results, '明细字段齐全（来源 SKU/归属/实物/锁定/仓库可用/单位）',
        (detail?.rows ?? []).every((row) => typeof row.externalSku === 'string'
          && ('itemId' in row) && ('iceCode' in row) && ('nameCn' in row)
          && ('onHand' in row) && ('orderLocked' in row) && ('warehouseAvailable' in row)
          && ('unit' in row) && ('excelRow' in row) && ('observationAt' in row)));
      const sku = (await owner.query(`SELECT a.external_sku
        FROM catalog.inventory_batch_row a
        JOIN catalog.inventory_batch_row b ON b.batch_id=$2 AND b.external_sku=a.external_sku
        WHERE a.batch_id=$1
        ORDER BY a.excel_row LIMIT 1`, [latest.batchId, previous.batchId])).rows[0]?.external_sku ?? null;
      const skuDetail = sku ? await probeRows(owner, warehouse.warehouse_id, latest.batchId, sku, 10, 0) : null;
      const skuRow = skuDetail?.rows?.find((row) => row.externalSku === sku) ?? null;
      const expected = sku ? (await owner.query(`SELECT on_hand, order_locked, warehouse_available, unit
        FROM catalog.inventory_batch_row WHERE batch_id=$1 AND external_sku=$2`,
      [latest.batchId, sku])).rows[0] : null;
      evidence.searchHit = { sku, matched: skuDetail?.matched, row: skuRow, expected };
      check(results, '按来源 SKU 搜索命中该批记录，数量与批次原数一致',
        Boolean(sku) && skuDetail?.matched === 1 && skuRow?.onHand === expected?.on_hand
        && skuRow?.orderLocked === expected?.order_locked
        && skuRow?.warehouseAvailable === expected?.warehouse_available,
        { sku, matched: skuDetail?.matched, row: skuRow, expected });
      const missing = await probeRows(owner, warehouse.warehouse_id, latest.batchId, '__NO_SUCH_SOURCE_SKU__', 10, 0);
      check(results, '搜索不存在的来源 SKU：matched=0 且 rows 为空（页面据此显示「本批未见」）',
        missing?.ok === true && missing?.matched === 0 && Array.isArray(missing?.rows) && missing.rows.length === 0,
        { matched: missing?.matched, rows: missing?.rows?.length });
      const unbound = (await owner.query(`SELECT external_sku, on_hand, unit
        FROM catalog.inventory_batch_row WHERE batch_id=$1 AND item_id IS NULL
        ORDER BY excel_row LIMIT 1`, [latest.batchId])).rows[0];
      const unboundDetail = unbound ? await probeRows(owner, warehouse.warehouse_id, latest.batchId, unbound.external_sku, 10, 0) : null;
      const unboundRow = unboundDetail?.rows?.[0] ?? null;
      evidence.unbound = { source: unbound, returned: unboundRow };
      check(results, '未绑定 SKU 同样可查：itemId 为空、数量原样返回',
        Boolean(unbound) && unboundRow?.itemId === null && unboundRow?.externalSku === unbound.external_sku
        && unboundRow?.onHand === unbound.on_hand,
        { source: unbound, returned: unboundRow });
      const zeroRow = (await owner.query(`SELECT external_sku FROM catalog.inventory_batch_row
        WHERE batch_id=$1 AND on_hand=0 ORDER BY excel_row LIMIT 1`, [latest.batchId])).rows[0];
      const zeroDetail = zeroRow ? await probeRows(owner, warehouse.warehouse_id, latest.batchId, zeroRow.external_sku, 10, 0) : null;
      const zeroReturned = zeroDetail?.rows?.[0] ?? null;
      evidence.zero = { source: zeroRow, returned: zeroReturned };
      check(results, '真实 0 原样返回 0（不转 null）',
        Boolean(zeroRow) && zeroReturned?.onHand === 0,
        { source: zeroRow, onHand: zeroReturned?.onHand });
      const historical = (await owner.query(`SELECT br.item_id, br.item_revision, br.mapping_id,
          (SELECT c.ice_code FROM catalog.catalog_item_code c WHERE c.item_id=br.item_id) AS ice_code
        FROM catalog.inventory_batch_row br
        WHERE br.batch_id=$1 AND br.item_id IS NOT NULL AND br.mapping_id IS NOT NULL
        ORDER BY br.excel_row LIMIT 1`, [latest.batchId])).rows[0];
      const histDetail = historical ? await probeRows(owner, warehouse.warehouse_id, latest.batchId, null, 200, 0) : null;
      const histRow = historical
        ? (histDetail?.rows ?? []).find((row) => row.itemId === historical.item_id) ?? null
        : null;
      const mappingVersion = historical
        ? (await owner.query(`SELECT (m->>'version')::int AS version
            FROM catalog.inventory_batch b, jsonb_array_elements(b.mapping_snapshot->'mappings') m
            WHERE b.id=$1 AND m->>'mappingId'=$2`, [latest.batchId, historical.mapping_id])).rows[0]?.version ?? null
        : null;
      evidence.historical = { source: historical, returned: histRow, expectedMappingVersion: mappingVersion };
      check(results, '历史归属取批次保存的 item/mapping 版本（itemRevision、mappingVersion）',
        Boolean(historical) && histRow?.itemId === historical.item_id
        && histRow?.itemRevision === historical.item_revision
        && histRow?.mappingId === historical.mapping_id
        && histRow?.mappingVersion === mappingVersion,
        { source: historical, returned: histRow, expectedMappingVersion: mappingVersion });
      const offsetPage = await probeRows(owner, warehouse.warehouse_id, latest.batchId, null, 5, 5);
      check(results, '明细分页：offset 5 / limit 5 返回第 6-10 行且 matched 为整批匹配数',
        offsetPage?.ok === true && offsetPage?.matched === latest.rowCount
        && Array.isArray(offsetPage?.rows) && offsetPage.rows.length === Math.min(5, Math.max(0, latest.rowCount - 5))
        && offsetPage?.offset === 5 && offsetPage?.limit === 5,
        { matched: offsetPage?.matched, rows: offsetPage?.rows?.length });
      // 明确批次不在当前批次列表页时仍按编号读取同一批，并能算出它所在的列表页。
      const pinned = listed.length > 50 ? listed[60] : null;
      const pinnedDetail = pinned
        ? await probeRows(owner, warehouse.warehouse_id, pinned.batchId, null, 10, 0)
        : null;
      const pinnedPageOffset = pinnedDetail?.batchRank
        ? Math.floor((pinnedDetail.batchRank - 1) / 50) * 50
        : null;
      const pinnedPage = pinnedDetail
        ? await probeBatches(owner, warehouse.warehouse_id, 50, pinnedPageOffset)
        : null;
      evidence.pinnedBatch = {
        batchId: pinned?.batchId ?? null,
        rank: pinnedDetail?.batchRank ?? null,
        listPageOffset: pinnedPageOffset,
        sameBatchOnPage: Boolean(pinnedPage?.batches?.some((entry) => entry.batchId === pinned?.batchId)),
        observationAt: pinnedDetail?.batch?.observationAt ?? null,
      };
      check(results, '明确批次独立读取：第 61 批不在首批 50 条仍按编号返回同一批，且能定位到所在列表页',
        pinned !== null && pinnedDetail?.ok === true && pinnedDetail?.batch?.batchId === pinned.batchId
        && pinnedDetail?.batchRank === 61 && pinnedDetail?.batch?.observationAt === pinned.observationAt
        && Boolean(pinnedPage?.batches?.some((entry) => entry.batchId === pinned.batchId)),
        evidence.pinnedBatch);
      const otherWarehouse = (await owner.query(`SELECT b.id AS batch_id, b.warehouse_id
        FROM catalog.inventory_batch b WHERE b.warehouse_id<>$1 LIMIT 1`, [warehouse.warehouse_id])).rows[0];
      if (otherWarehouse) {
        const mismatchDetail = await probeRows(owner, warehouse.warehouse_id, otherWarehouse.batch_id, null, 10, 0);
        check(results, '明确批次与所选仓不一致：status=warehouse_mismatch，且不返回行/数量',
          mismatchDetail?.ok === false && mismatchDetail?.status === 'warehouse_mismatch'
          && mismatchDetail?.batchWarehouseId === otherWarehouse.warehouse_id
          && mismatchDetail?.rows === undefined,
          mismatchDetail);
        const directDetail = await probeRows(owner, null, otherWarehouse.batch_id, null, 10, 0);
        check(results, '不带仓库的直接链接：批次存在时独立读取成功，元数据归属实际仓（不换批）',
          directDetail?.ok === true && directDetail?.batch?.batchId === otherWarehouse.batch_id
          && directDetail?.batch?.warehouseId === otherWarehouse.warehouse_id,
          { ok: directDetail?.ok, batch: directDetail?.batch });
      }
      const notFound = await probeRows(owner, warehouse.warehouse_id, '00000000-0000-4000-8000-000000000000', null, 10, 0);
      check(results, '不存在的批次：status=not_found 且不返回任何行（不退回最新批次）',
        notFound?.ok === false && notFound?.status === 'not_found' && notFound?.rows === undefined,
        notFound);
    } else {
      check(results, '真实数据探针：找到至少一个多批次仓库', false);
    }
    const countsAfterProbe = (await owner.query(countsSql)).rows[0];
    evidence.countsAfterProbe = countsAfterProbe;
    check(results, '只读：batches / batch_rows / warehouses 数量前后不变',
      JSON.stringify(countsBefore) === JSON.stringify(countsAfterProbe),
      { before: countsBefore, after: countsAfterProbe });

    if (commit) {
      await owner.query('COMMIT');
      const afterBatches = (await owner.query(functionStateSql, [APP_ROLE, BATCHES_FUNCTION])).rows;
      const afterRows = (await owner.query(functionStateSql, [APP_ROLE, ROWS_FUNCTION])).rows;
      check(results, '提交后两个函数均存在且 app 可执行',
        afterBatches.length === 1 && afterBatches[0].app_exec === true
        && afterRows.length === 1 && afterRows[0].app_exec === true);
    } else {
      await owner.query('ROLLBACK');
      const afterBatches = (await owner.query(functionStateSql, [APP_ROLE, BATCHES_FUNCTION])).rows;
      const afterRows = (await owner.query(functionStateSql, [APP_ROLE, ROWS_FUNCTION])).rows;
      const countsAfterRollback = (await owner.query(countsSql)).rows[0];
      evidence.countsAfterRollback = countsAfterRollback;
      check(results, 'rollback 后函数签名回到安装前（未留下半安装/新签名残留）',
        JSON.stringify(afterBatches.map((row) => row.identity_args).sort()) === JSON.stringify(beforeFunctions.batches)
        && JSON.stringify(afterRows.map((row) => row.identity_args).sort()) === JSON.stringify(beforeFunctions.rows),
        { before: beforeFunctions, after: {
          batches: afterBatches.map((row) => row.identity_args),
          rows: afterRows.map((row) => row.identity_args),
        } });
      check(results, 'rollback 后业务行数不变',
        JSON.stringify(countsBefore) === JSON.stringify(countsAfterRollback));
    }
    evidence.results = results;
    evidence.passed = results.every((item) => item.ok);
    evidence.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(EVIDENCE_DIR, commit ? 'apply-041-commit.json' : 'apply-041.json'),
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
    fs.writeFileSync(path.join(EVIDENCE_DIR, commit ? 'apply-041-commit.json' : 'apply-041.json'),
      `${JSON.stringify(evidence, null, 2)}\n`);
    console.error('[apply-041] failed:', error.message);
    process.exitCode = 1;
  } finally {
    await owner.end().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
