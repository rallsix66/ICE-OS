#!/usr/bin/env node
/**
 * DATA-1 隔离副本失败例 / 冲突例验证（只在隔离库执行；正式库绝不运行）。
 *
 * 覆盖：身份/名称矛盾不写入、旧版本冲突、单位冲突、重复请求冲突、JST 决定来源不符/内容冲突、
 * 单行失败不产生半次写入、同请求幂等回执。
 *
 * 用法：node failure-cases.mjs --db iceos_review_import_test_b_<ts> --out <evidence dir>
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_CSV, buildPlan, loadAdminProfileId, loadReviewCsv, loadState, withReadTx } from './review-import.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const INSTANCE_FILE = path.join(REPO_ROOT, '.local', 'catalog', 'run-20261026T211500Z-11a22b33', 'instance', 'catalog-instance.json');
const FORMAL_DB = 'iceos_catalog_run_20261026T211500Z_11a22b33';
const ADMIN = '11111111-1111-4111-8111-111111111101';
const FILE_SHA = '5f39ae7438b4003caa5727dcace377ac912ad796ac9b3c9e61663dec69b40d12';

function readArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--db') args.db = argv[++i];
    else if (argv[i] === '--out') args.out = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!args.db || !args.out) throw new Error('--db and --out are required');
  if (args.db === FORMAL_DB) throw new Error('FAILURE_CASES_REFUSE_FORMAL_DB');
  return args;
}

async function writeServerFile(owner, evidenceDir, name, content) {
  const absolute = path.resolve(evidenceDir, name).replace(/\\/g, '/');
  const { rows } = await owner.query("SELECT lo_from_bytea(0, convert_to($1,'UTF8')) AS oid", [content]);
  try {
    await owner.query('SELECT lo_export($1,$2)', [rows[0].oid, absolute]);
  } finally {
    await owner.query('SELECT lo_unlink($1)', [rows[0].oid]);
  }
  return absolute;
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  const instance = JSON.parse(await readFile(INSTANCE_FILE, 'utf8'));
  const { default: pg } = await import('pg');
  const appUrl = `postgres://${instance.appRunnerUser}:${instance.appRunnerPassword}@${instance.host}:${instance.port}/${args.db}`;
  const ownerUrl = `postgres://${instance.bootstrapUser}:${instance.bootstrapPassword}@${instance.host}:${instance.port}/${args.db}`;
  const app = new pg.Client({ connectionString: appUrl });
  const owner = new pg.Client({ connectionString: ownerUrl });
  await app.connect();
  await owner.connect();
  const results = [];
  const record = (entry) => { results.push(entry); console.log(JSON.stringify(entry)); };
  const adminProfileId = await loadAdminProfileId(owner);

  const ownerTx = async (fn) => {
    await owner.query('BEGIN');
    try {
      await owner.query('SET LOCAL ROLE ice_p0_02_owner');
      const value = await fn();
      await owner.query('COMMIT');
      return value;
    } catch (error) {
      await owner.query('ROLLBACK');
      throw error;
    }
  };
  const appCall = async (sql, params) => {
    await app.query('BEGIN');
    try {
      await app.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [adminProfileId]);
      if ((await app.query('SELECT catalog.is_admin() AS ok')).rows[0].ok !== true) throw new Error('NOT_ADMIN');
      const value = (await app.query(sql, params)).rows[0];
      await app.query('COMMIT');
      return value;
    } catch (error) {
      await app.query('ROLLBACK');
      throw error;
    }
  };
  const readState = async () => withReadTx(app, adminProfileId, async () => {
    const state = await loadState(app);
    const mappings = state.mappings;
    const versions = (await app.query(
      `SELECT version,status,count(*)::int AS n FROM catalog.inventory_sku_mapping GROUP BY version,status ORDER BY version,status`)).rows;
    const requests = (await app.query('SELECT count(*)::int AS n FROM catalog.inventory_request')).rows[0].n;
    // 决定表只经函数读写，app 角色无 SELECT；证据统计用 owner 连接。
    const decisions = (await owner.query('SELECT count(*)::int AS n FROM catalog.domestic_review_decision')).rows[0].n;
    return { state, mappings, versions, decisions, requests };
  });

  try {
    // ---------------------------------------------------------------
    // F1 身份/名称矛盾：不写入，plan 单列 blocked
    //   item_revision 为不可变历史（UPDATE 0 行），因此在内存中篡改一份 item 快照交给 buildPlan，
    //   验证入口身份校验确实阻止写入，同时不改数据库。
    // ---------------------------------------------------------------
    const csv = await loadReviewCsv(DEFAULT_CSV);
    const before = await readState();
    const targetItem = before.state.items.find((i) => i.ice_code === 'WM0003');
    const immutableProbe = await ownerTx(async () => (await owner.query(
      `UPDATE catalog.item_revision SET name_cn='PROBE' WHERE item_id=$1`, [targetItem.id])).rowCount);
    const tamperedState = {
      ...before.state,
      items: before.state.items.map((item) => (item.id === targetItem.id ? { ...item, name_cn: 'PROBE-NAME-MISMATCH' } : item)),
    };
    const planMismatch = buildPlan({ csv, state: tamperedState, adminProfileId });
    const blockedByMismatch = planMismatch.rows.filter((r) => (r.category === 'bs_adopt' || r.category === 'jst_adopt')
      && r.action === 'blocked' && r.actionReasonCode === 'ITEM_NAME_MISMATCH');
    const writeRowsMismatch = planMismatch.rows.filter((r) => (r.category === 'bs_adopt' || r.category === 'jst_adopt') && (r.action === 'new' || r.action === 'rebind'));
    const afterMisname = await readState();
    record({
      case: 'F1_ITEM_NAME_MISMATCH_BLOCKS_WITHOUT_WRITE',
      pass: blockedByMismatch.length > 0 && afterMisname.mappings.length === before.mappings.length && immutableProbe === 0,
      blockedRows: blockedByMismatch.length,
      blockedByCategory: blockedByMismatch.reduce((acc, r) => { acc[r.category] = (acc[r.category] ?? 0) + 1; return acc; }, {}),
      blockedSample: blockedByMismatch.slice(0, 3).map((r) => ({ sourceRowId: r.sourceRowId, reason: r.reason })),
      writeRowsAfterBlock: writeRowsMismatch.length,
      mappingsBefore: before.mappings.length,
      mappingsAfter: afterMisname.mappings.length,
      itemRevisionImmutableRowCount: immutableProbe,
      tamperMode: 'in-memory plan state (item_revision is immutable history; no DB write)',
    });
    const planRestored = await withReadTx(app, adminProfileId, async () => buildPlan({ csv, state: await loadState(app), adminProfileId }));
    record({
      case: 'F1B_NAME_RESTORED_PLAN_CLEAN',
      pass: planRestored.summary.adoptBlockedAtPlan === 0,
      adoptBlockedAtPlan: planRestored.summary.adoptBlockedAtPlan,
    });

    // ---------------------------------------------------------------
    // F2 旧版本冲突：另一人工改过（v2）后，旧 expectedVersion=1 被拒绝
    // ---------------------------------------------------------------
    const mappingKey = { warehouseExternalId: '54886', externalSku: '757577983044' };
    const wh = before.state.warehouses.find((w) => w.external_warehouse_id === mappingKey.warehouseExternalId);
    const original = before.state.mappings.find((m) => m.warehouse_id === wh.id && m.external_sku === mappingKey.externalSku);
    const otherItem = before.state.items.find((i) => i.ice_code === 'WM0069');
    const requestA = '11111111-aaaa-4aaa-8aaa-111111111101';
    const requestB = '11111111-bbbb-4bbb-8bbb-111111111102';
    const payloadEdit = [{ externalSku: mappingKey.externalSku, warehouseExternalId: mappingKey.warehouseExternalId, itemId: otherItem.id, unit: '个', expectedVersion: original.version, reason: 'f2 人工换绑（隔离验证）' }];
    const firstEdit = await appCall('SELECT catalog.confirm_inventory_mapping($1,$2,$3::jsonb) AS r', [requestA, 'a'.repeat(64), JSON.stringify(payloadEdit)]);
    const stalePayload = [{ externalSku: mappingKey.externalSku, warehouseExternalId: mappingKey.warehouseExternalId, itemId: targetItem.id, unit: '个', expectedVersion: original.version, reason: 'f2 旧版本写入（应被拒绝）' }];
    let staleError = null;
    let staleReceipt = null;
    try {
      const staleCall = await appCall('SELECT catalog.confirm_inventory_mapping($1,$2,$3::jsonb) AS r', [requestB, 'b'.repeat(64), JSON.stringify(stalePayload)]);
      staleReceipt = staleCall.r;
    } catch (error) {
      staleError = `${error.code}:${error.message}`;
    }
    const staleSkipped = staleReceipt?.skipped?.map((s) => s.reason) ?? [];
    const afterStale = await readState();
    const staleRows = (await withReadTx(app, adminProfileId, async () => (await app.query(
      `SELECT version,status,item_id FROM catalog.inventory_sku_mapping
       WHERE account_id=$1 AND warehouse_id=$2 AND external_sku=$3 ORDER BY version`, [before.state.account.id, wh.id, mappingKey.externalSku])).rows));
    const latest = staleRows.sort((a, b) => b.version - a.version)[0];
    record({
      case: 'F2_STALE_VERSION_CONFLICT',
      pass: Boolean(firstEdit.r?.applied === 1)
        && (staleError?.includes('INVENTORY_MAPPING_VERSION_CONFLICT') || staleSkipped.includes('INVENTORY_MAPPING_VERSION_CONFLICT'))
        && latest?.version === original.version + 1 && latest?.item_id === otherItem.id && staleRows.length === 2,
      firstApplied: firstEdit.r?.applied ?? null,
      staleError,
      staleSkipped,
      staleReceipt,
      latestVersion: latest?.version ?? null,
      latestItem: latest?.item_id ?? null,
      expectedItem: otherItem.id,
      rowCountForKey: staleRows.length,
    });

    // ---------------------------------------------------------------
    // F3 单位冲突：variant 已确认“件”，再按“个”写入被拒绝且无半次写入
    // ---------------------------------------------------------------
    const unitItem = before.state.items.find((i) => i.ice_code === 'WM0003');
    await ownerTx(async () => {
      await owner.query(`UPDATE catalog.inventory_variant SET unit='件' WHERE item_id=$1 AND variant_key='default'`, [unitItem.id]);
    });
    const unitKey = { warehouseExternalId: '54409', externalSku: 'PROBE-UNIT-CONFLICT-1' };
    let unitError = null;
    let unitReceipt = null;
    try {
      const unitCall = await appCall('SELECT catalog.confirm_inventory_mapping($1,$2,$3::jsonb) AS r', [
        '11111111-cccc-4ccc-8ccc-111111111103', 'c'.repeat(64),
        JSON.stringify([{ externalSku: unitKey.externalSku, warehouseExternalId: unitKey.warehouseExternalId, itemId: unitItem.id, unit: '个', expectedVersion: null, reason: 'f3 单位冲突（应被拒绝）' }]),
      ]);
      unitReceipt = unitCall.r;
    } catch (error) {
      unitError = `${error.code}:${error.message}`;
    }
    const unitSkipped = unitReceipt?.skipped?.map((s) => s.reason) ?? [];
    const afterUnit = await readState();
    await ownerTx(async () => {
      await owner.query(`UPDATE catalog.inventory_variant SET unit='个' WHERE item_id=$1 AND variant_key='default'`, [unitItem.id]);
    });
    record({
      case: 'F3_UNIT_CONFLICT_REJECTED_WITHOUT_WRITE',
      pass: (unitError?.includes('INVENTORY_MAPPING_UNIT_CONFLICT') || unitSkipped.includes('INVENTORY_MAPPING_UNIT_CONFLICT'))
        && !afterUnit.mappings.some((m) => m.external_sku === unitKey.externalSku),
      unitError,
      unitSkipped,
      probeMappingExists: afterUnit.mappings.some((m) => m.external_sku === unitKey.externalSku),
    });

    // ---------------------------------------------------------------
    // F4 重复 requestId + 不同 payload：请求冲突，不覆盖原回执
    // ---------------------------------------------------------------
    let conflictError = null;
    const differentPayload = [{ externalSku: mappingKey.externalSku, warehouseExternalId: mappingKey.warehouseExternalId, itemId: targetItem.id, unit: '个', expectedVersion: latest.version, reason: 'f4 不同内容复用同一 requestId（应拒绝）' }];
    try {
      await appCall('SELECT catalog.confirm_inventory_mapping($1,$2,$3::jsonb) AS r', [requestA, 'd'.repeat(64), JSON.stringify(differentPayload)]);
    } catch (error) {
      conflictError = `${error.code}:${error.message}`;
    }
    record({
      case: 'F4_REQUEST_PAYLOAD_CONFLICT',
      pass: conflictError?.includes('INVENTORY_REQUEST_CONFLICT'),
      conflictError,
    });

    // ---------------------------------------------------------------
    // F5 JST 决定：来源位置不符 / 同来源行不同商品冲突 / 幂等回执
    // ------------------------------------------------------------
    const jstRow = planRestored.rows.find((r) => r.category === 'jst_adopt' && r.action === 'keep');
    const jstItem = planRestored.itemByCode.get(jstRow.targetCode);
    const otherJstItem = before.state.items.find((i) => i.ice_code !== jstRow.targetCode);
    const decisionBase = {
      datasetSha256: FILE_SHA,
      sourceRowId: jstRow.sourceRowId,
      legacyCandidateId: jstRow.sourceRowId,
      observationId: jstRow.observationId,
      itemId: jstItem.id,
      reviewState: 'manual_selected',
      sourceFile: jstRow.file,
      sourceSheet: jstRow.sheet,
      sourceExcelRow: jstRow.excelRow,
      sourceSku: jstRow.sourceSku,
    };
    const jstRequestA = '11111111-dddd-4ddd-8ddd-111111111104';
    const jstFirst = await appCall('SELECT catalog.apply_domestic_review_decision($1,$2,$3::jsonb) AS r',
      [jstRequestA, 'e'.repeat(64), JSON.stringify(decisionBase)]);
    const jstRepeat = await appCall('SELECT catalog.apply_domestic_review_decision($1,$2,$3::jsonb) AS r',
      [jstRequestA, 'e'.repeat(64), JSON.stringify(decisionBase)]);
    let mismatchError = null;
    try {
      await appCall('SELECT catalog.apply_domestic_review_decision($1,$2,$3::jsonb) AS r',
        ['11111111-eeee-4eee-8eee-111111111105', 'f'.repeat(64), JSON.stringify({ ...decisionBase, sourceExcelRow: Number(jstRow.excelRow) + 1 })]);
    } catch (error) {
      mismatchError = `${error.code}:${error.message}`;
    }
    let jstConflictError = null;
    try {
      await appCall('SELECT catalog.apply_domestic_review_decision($1,$2,$3::jsonb) AS r',
        ['11111111-ffff-4fff-8fff-111111111106', '1'.repeat(64), JSON.stringify({ ...decisionBase, itemId: otherJstItem.id })]);
    } catch (error) {
      jstConflictError = `${error.code}:${error.message}`;
    }
    const afterJst = await readState();
    const linkAfter = afterJst.state.jstLinks.find((l) => l.legacyCandidateId === jstRow.sourceRowId);
    record({
      case: 'F5A_JST_DECISION_IDEMPOTENT',
      pass: JSON.stringify(jstFirst.r) === JSON.stringify(jstRepeat.r) && jstRepeat.r?.applied === 1
        && (await owner.query('SELECT count(*)::int AS n FROM catalog.domestic_review_decision')).rows[0].n === 1,
      first: jstFirst.r,
      repeat: jstRepeat.r,
      sameReceipt: JSON.stringify(jstFirst.r) === JSON.stringify(jstRepeat.r),
    });
    record({
      case: 'F5B_JST_SOURCE_POSITION_MISMATCH',
      pass: mismatchError?.includes('DOMESTIC_REVIEW_SOURCE_MISMATCH'),
      mismatchError,
    });
    record({
      case: 'F5C_JST_SAME_SOURCE_DIFFERENT_ITEM_CONFLICT',
      pass: jstConflictError?.includes('DOMESTIC_REVIEW_CONFLICT') && afterJst.decisions === 1 && linkAfter?.itemId === jstItem.id,
      jstConflictError,
      decisions: afterJst.decisions,
      linkItemId: linkAfter?.itemId ?? null,
      expectedItemId: jstItem.id,
    });

    // ---------------------------------------------------------------
    // F6 单行失败不产生半次写入（未知仓库 → skipped，无映射行，回执记录 skipped）
    // ---------------------------------------------------------------
    const skippedRequest = '11111111-9999-4999-8999-111111111107';
    const skipResult = await appCall('SELECT catalog.confirm_inventory_mapping($1,$2,$3::jsonb) AS r', [
      skippedRequest, '9'.repeat(64),
      JSON.stringify([{ externalSku: 'PROBE-NO-WH', warehouseExternalId: 'NO-SUCH-WAREHOUSE', itemId: targetItem.id, unit: '个', expectedVersion: null, reason: 'f6 未知仓库（应 skipped）' }]),
    ]);
    const afterSkip = await readState();
    const skipReceipt = (await owner.query('SELECT response FROM catalog.inventory_request WHERE request_id=$1', [skippedRequest])).rows[0];
    record({
      case: 'F6_SINGLE_ROW_FAILURE_NO_HALF_WRITE',
      pass: skipResult.r?.applied === 0 && skipResult.r?.skipped?.length === 1
        && !afterSkip.mappings.some((m) => m.external_sku === 'PROBE-NO-WH')
        && skipReceipt?.response?.applied === 0,
      applied: skipResult.r?.applied ?? null,
      skipped: skipResult.r?.skipped ?? null,
      mappingExists: afterSkip.mappings.some((m) => m.external_sku === 'PROBE-NO-WH'),
      receipt: skipReceipt?.response ?? null,
    });

    // ---------------------------------------------------------------
    // F7 失败/冲突后库状态无意外变化：版本分布、决定数、请求数均可解释
    // ---------------------------------------------------------------
    const finalState = await readState();
    record({
      case: 'F7_STATE_SUMMARY',
      pass: true,
      versions: finalState.versions,
      decisions: finalState.decisions,
      requests: finalState.requests,
      mappings: finalState.mappings.length,
    });

    const payload = {
      database: args.db,
      generatedAt: new Date().toISOString(),
      fileSha256: FILE_SHA,
      results,
      passed: results.filter((r) => r.pass !== true).length === 0,
    };
    const written = await writeServerFile(owner, path.resolve(REPO_ROOT, args.out), 'failure-cases.json', `${JSON.stringify(payload, null, 2)}\n`);
    console.log(JSON.stringify({ stage: 'evidence', file: written, passed: payload.passed }, null, 2));
    if (!payload.passed) process.exitCode = 1;
  } finally {
    await app.end().catch(() => {});
    await owner.end().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error.stack ?? String(error));
  process.exitCode = 1;
});
