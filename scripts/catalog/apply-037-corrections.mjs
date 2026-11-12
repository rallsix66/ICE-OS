/**
 * 037 一次性数据补修（dry-run 默认，--commit 才写；幂等；克隆库先跑通，现役由 Lead 执行）。
 *
 * A. 撤销 WM0069/WM0070/WM0071/WM0073 的 4 条脚本代选 duplicate decision（无真实人工确认记录）。
 * B. 在最近一次 applied/partial 批次为这 4 个 code 重建 1 条 open duplicate_code_inconsistent
 *    事项（行号取该批真实行；fields 必须非空，否则 fail closed；按 21 个 ADOPTABLE_FIELD_KEYS
 *    实算差异：空白相等、数值容差、文本 trim 精确）。
 * C. 删除仅由脚本选行产生的 barcode adoption（adopted_batch_id=该批）；WM0073 若 revision=2 且
 *    rev2.barcode=757577407359 则追加 revision 3（fields = rev2 去掉 barcode），rev1/rev2 保留。
 * D. 撤销 LS101501 的 active override（unitWeight=0.05），登记 2 条 interpret：
 *    unitWeight=unit_weight_per_unit_fragment、cartonWeight=confirmed_source_value。
 *
 * 幂等语义：只有本轮确实撤销了 active duplicate decision 才执行 B/C；已撤销/已回滚则 skip，
 * 不重复开事项、不重复加修订、不重复删 adoption；interpret/override 已就位则 skip。
 *
 * 安全闸门：目标库名等于现役库名时 --commit 需要 --allow-live-commit（由 Lead 显式执行）；
 * 默认 dry-run 在事务内完整演练后 ROLLBACK。
 *
 * 用法：
 *   node scripts/catalog/apply-037-corrections.mjs                       # dry-run（现役库，只读演练）
 *   node scripts/catalog/apply-037-corrections.mjs --commit --database-url <clone>   # 克隆库提交
 *   node scripts/catalog/apply-037-corrections.mjs --commit --allow-live-commit      # 现役库（Lead）
 * 证据：.../corrections-037-dryrun.json（dry-run）或 .../corrections-037.json（commit）
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
const ADMIN_PROFILE_ID = '11111111-1111-4111-8111-111111111101';
const PROFILE_KEY = 'feishu.ice-product-library.sheet1';
const EVIDENCE_DIR = path.join(REPO_ROOT, '.local', 'catalog', 'feishu-source-review-fix-20261110');
const LS_ITEM = 'c5bd27f4-98e2-440d-b2be-0ecab5da4e1d';
const REVOKE_NOTE = '撤销脚本代选：无真实人工确认记录，恢复待人工确认';
const WM0073_ITEM = '4a97ad8b-8bd9-4aaf-a48a-530ae130b68a';
const ADOPTABLE_FIELD_KEYS = [
  'nameCn', 'specification', 'englishName', 'factory', 'barcode', 'length', 'width', 'height',
  'unitWeight', 'cartonQuantity', 'cartonLength', 'cartonWidth', 'cartonHeight', 'cartonWeight',
  'liquid', 'shelfLifeDays', 'cartonVolume', 'unitVolume', 'factoryLeadDays', 'shippingDays',
  'sourceNote',
];
const NUMERIC_FIELD_KEYS = new Set([
  'length', 'width', 'height', 'unitWeight', 'cartonQuantity', 'cartonLength', 'cartonWidth',
  'cartonHeight', 'cartonWeight', 'shelfLifeDays', 'cartonVolume', 'unitVolume',
  'factoryLeadDays', 'shippingDays',
]);
const DUPLICATE_CODES = [
  { code: 'WM0069', expectedRows: [63, 127] },
  { code: 'WM0070', expectedRows: [64, 128] },
  { code: 'WM0071', expectedRows: [65, 129] },
  { code: 'WM0073', expectedRows: [67, 131] },
];
const INTERPRETATIONS = [
  { field: 'unitWeight', rule: 'unit_weight_per_unit_fragment',
    reason: '按来源 O 列 0.05/件 解释单个产品重量（忽略同一单元格的 24.45/箱）',
    note: 'LS101501 退出固定 0.05 override' },
  { field: 'cartonWeight', rule: 'confirmed_source_value',
    reason: '箱重取来源 T 列已确认数值 24.15',
    note: 'LS101501 箱重按来源列解释' },
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
function sha256Text(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function newIntent() { return sha256Text(`${Date.now()}:${Math.random()}:${crypto.randomUUID()}`); }
function databaseNameOf(connectionString) {
  const url = new URL(connectionString);
  return decodeURIComponent(url.pathname.replace(/^\//, ''));
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail === undefined ? '' : ` :: ${JSON.stringify(detail).slice(0, 600)}`}`);
}
function normalizeCell(fieldKey, cell) {
  const state = cell?.state ?? 'explicit_empty';
  const raw = typeof cell?.raw === 'string' ? cell.raw : '';
  if (state !== 'observed') return { kind: 'state', state };
  const trimmed = raw.trim();
  if (trimmed === '') return { kind: 'blank' };
  if (NUMERIC_FIELD_KEYS.has(fieldKey)) {
    const num = Number(trimmed);
    if (Number.isFinite(num)) return { kind: 'number', value: num };
  }
  return { kind: 'text', value: trimmed };
}
function cellsEquivalent(left, right) {
  if (left.kind === 'blank' && right.kind === 'blank') return true;
  if (left.kind === 'state' || right.kind === 'state') {
    return left.kind === 'state' && right.kind === 'state' && left.state === right.state;
  }
  if (left.kind === 'number' && right.kind === 'number') {
    const scale = Math.max(1, Math.abs(left.value), Math.abs(right.value));
    return Math.abs(left.value - right.value) <= 1e-9 * scale;
  }
  if (left.kind === 'text' && right.kind === 'text') return left.value === right.value;
  return false;
}

/** 按 21 个可采纳字段计算一批同 code 行之间的真实差异（行号不参与比较）。 */
function computeFieldDifferences(rows) {
  const differences = [];
  for (const fieldKey of ADOPTABLE_FIELD_KEYS) {
    const cells = rows.map((row) => row.fields?.[fieldKey] ?? { state: 'explicit_empty', raw: '' });
    const normalized = cells.map((cell) => normalizeCell(fieldKey, cell));
    const first = normalized[0];
    if (normalized.every((value) => cellsEquivalent(first, value))) continue;
    differences.push({
      fieldKey,
      values: rows.map((row, index) => ({
        rowNumber: row.row_number,
        raw: cells[index]?.state === 'observed' && typeof cells[index]?.raw === 'string' ? cells[index].raw : null,
        state: cells[index]?.state ?? 'explicit_empty',
      })),
    });
  }
  return differences;
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  const runId = args['run-id'] ?? DEFAULT_RUN_ID;
  const env = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, '.local/catalog', runId, 'instance/env.inventory.json'), 'utf8'));
  const ownerUrl = args['database-url'] ?? env.ownerDbUrl;
  const targetDatabase = databaseNameOf(ownerUrl);
  const isLive = targetDatabase === env.database;
  const commit = args.commit === true;
  const with037 = args['with-037'] === true;

  if (with037 && commit) {
    console.error('[REFUSED] --with-037 只用于 dry-run 演练（事务内临时安装 037 后整体 ROLLBACK）。');
    process.exitCode = 2;
    return;
  }

  if (commit && isLive && args['allow-live-commit'] !== true) {
    console.error('[REFUSED] 目标是现役库（' + targetDatabase + '），--commit 需要显式 --allow-live-commit（Lead 手动执行）。');
    process.exitCode = 2;
    return;
  }

  const owner = new pg.Client({ connectionString: ownerUrl });
  await owner.connect();
  const evidence = {
    runId, targetDatabase, isLive, mode: commit ? 'commit' : 'dry-run',
    at: new Date().toISOString(), revokeNote: REVOKE_NOTE,
    steps: { A: { executed: [], skipped: [], failed: [] }, B: { executed: [], skipped: [], failed: [] },
      C: { executed: [], skipped: [], failed: [] }, D: { executed: [], skipped: [], failed: [] } },
    checks: results,
  };
  const query = async (sql, params = []) => (await owner.query(sql, params)).rows;
  const one = async (sql, params = []) => (await query(sql, params))[0];

  const countsSql = `SELECT
    (SELECT count(*) FROM catalog.product_source_issue)::int AS issues,
    (SELECT count(*) FROM catalog.product_source_issue WHERE review_state='open')::int AS open_issues,
    (SELECT count(*) FROM catalog.catalog_item)::int AS items,
    (SELECT count(*) FROM catalog.item_revision)::int AS revisions,
    (SELECT count(*) FROM catalog.catalog_item_code)::int AS codes,
    (SELECT count(*) FROM catalog.product_source_adoption)::int AS adoptions,
    (SELECT count(*) FROM catalog.product_source_duplicate_decision)::int AS duplicate_decisions,
    (SELECT count(*) FROM catalog.product_source_duplicate_decision WHERE state='active')::int AS active_duplicate_decisions,
    (SELECT count(*) FROM catalog.product_source_field_decision)::int AS field_decisions,
    (SELECT count(*) FROM catalog.product_source_field_decision WHERE action='interpret' AND state='active')::int AS active_interpretations`;

  try {
    await owner.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [ADMIN_PROFILE_ID]);
    const profile = await one('SELECT id FROM catalog.product_source_profile WHERE profile_key=$1', [PROFILE_KEY]);
    if (!profile) throw new Error('PROFILE_NOT_FOUND');
    const latestBatch = await one(`SELECT id, snapshot_key, captured_at, status FROM catalog.product_source_batch
      WHERE status IN('applied','partial') ORDER BY captured_at DESC, received_at DESC LIMIT 1`);
    if (!latestBatch) throw new Error('LATEST_BATCH_NOT_FOUND');
    const lsItem = await one('SELECT revision FROM catalog.item_current WHERE item_id=$1', [LS_ITEM]);
    const decisionRows = await query(`SELECT ice_code, item_id FROM catalog.product_source_duplicate_decision
      WHERE profile_id=$1`, [profile.id]);
    const itemIdByCode = Object.fromEntries(decisionRows.map((row) => [row.ice_code, row.item_id]));
    for (const config of DUPLICATE_CODES) {
      if (!itemIdByCode[config.code]) {
        const binding = await one(`SELECT item_id FROM catalog.product_source_binding
          WHERE profile_id=$1 AND ice_code=$2`, [profile.id, config.code]);
        itemIdByCode[config.code] = binding?.item_id ?? null;
      }
    }
    evidence.context = { profileId: profile.id, latestBatch, lsRevision: lsItem?.revision ?? null, itemIdByCode };
    evidence.before = await one(countsSql);

    await owner.query('BEGIN');
    try {
      await owner.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [ADMIN_PROFILE_ID]);

      // dry-run 演练：现役库尚未安装 037 时，可在本事务内临时安装 037（结束时整体 ROLLBACK）。
      if (with037) {
        const sql037 = fs.readFileSync(path.join(REPO_ROOT, 'db/catalog', '037_product_source_interpretation.sql'), 'utf8');
        await owner.query(sql037);
        await owner.query('RESET ROLE');
        await owner.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [ADMIN_PROFILE_ID]);
        evidence.with037 = true;
        check('dry-run 演练：本事务内先安装 037（结束整体 ROLLBACK，不落库）', true);
      }

      // ---------------------------------------------------------------
      // A. 撤销 4 条脚本代选
      // ---------------------------------------------------------------
      const revokedDecisions = [];
      for (const config of DUPLICATE_CODES) {
        const decision = await one(`SELECT * FROM catalog.product_source_duplicate_decision
          WHERE profile_id=$1 AND ice_code=$2 AND state='active'`, [profile.id, config.code]);
        if (!decision) {
          evidence.steps.A.skipped.push({ code: config.code, reason: 'no-active-duplicate-decision' });
          continue;
        }
        const before = {
          id: decision.id, code: decision.ice_code, itemId: decision.item_id,
          chosenRowNumber: decision.chosen_row_number, sourceIssueId: decision.source_issue_id,
          decidedBy: decision.decided_by, decidedAt: decision.decided_at,
          chosenFieldsKeys: Object.keys(decision.chosen_fields ?? {}),
        };
        const revokeResult = (await one(
          'SELECT catalog.revoke_product_source_duplicate_decision($1,$2,$3,$4) AS r',
          [crypto.randomUUID(), newIntent(), decision.id, REVOKE_NOTE])).r;
        const after = await one('SELECT state, superseded_at, note FROM catalog.product_source_duplicate_decision WHERE id=$1', [decision.id]);
        if (after?.state !== 'superseded') {
          evidence.steps.A.failed.push({ code: config.code, reason: 'revoke-did-not-supersede', after });
          check(`A 撤销 ${config.code} 代选结果为 superseded`, false, after);
          continue;
        }
        revokedDecisions.push({ code: config.code, itemId: before.itemId, decision: before, revokeResult,
          afterState: after.state, supersededAt: after.superseded_at });
        evidence.steps.A.executed.push({ code: config.code, decisionId: decision.id, before, revokeResult,
          afterState: after.state, note: after.note });
      }
      const decisionsAfterRevoke = await query(`SELECT ice_code, state FROM catalog.product_source_duplicate_decision ORDER BY ice_code`);
      check('A 撤销脚本代选（active duplicate decision → superseded；已撤销则整体 skip）',
        (revokedDecisions.length === 4
          && decisionsAfterRevoke.length === 4 && decisionsAfterRevoke.every((row) => row.state === 'superseded'))
        || (revokedDecisions.length === 0 && evidence.steps.A.skipped.length === 4
          && decisionsAfterRevoke.every((row) => row.state === 'superseded')),
        { executed: revokedDecisions.length, skipped: evidence.steps.A.skipped.length, decisionsAfterRevoke });
      check('A 撤销备注为约定文本', evidence.steps.A.executed.every((row) => row.note === REVOKE_NOTE),
        evidence.steps.A.executed.map((row) => row.note));

      // ---------------------------------------------------------------
      // B. 重建 4 条 open duplicate_code_inconsistent（最近 applied/partial 批）
      // ---------------------------------------------------------------
      const rebuiltIssues = [];
      for (const revoked of revokedDecisions) {
        const config = DUPLICATE_CODES.find((row) => row.code === revoked.code);
        const rows = await query(`SELECT row_number, is_empty, ice_code_raw, fields
          FROM catalog.product_source_row WHERE batch_id=$1 AND ice_code_raw=$2 AND is_empty=false
          ORDER BY row_number`, [latestBatch.id, config.code]);
        const failClosed = (reason, detail) => {
          evidence.steps.B.failed.push({ code: config.code, reason, detail });
          check(`B ${config.code} 重建同号事项（fail closed：${reason}）`, false, detail);
        };
        if (rows.length < 2) { failClosed('rows<2', { rowsFound: rows.length }); continue; }
        const emptyFields = rows.filter((row) => !row.fields || typeof row.fields !== 'object'
          || Object.keys(row.fields).length === 0).map((row) => row.row_number);
        if (emptyFields.length > 0) { failClosed('fields-empty', { emptyFields }); continue; }
        const rowNumbers = rows.map((row) => row.row_number);
        if (JSON.stringify(rowNumbers) !== JSON.stringify(config.expectedRows)) {
          failClosed('row-numbers-mismatch', { actual: rowNumbers, expected: config.expectedRows });
          continue;
        }
        const differences = computeFieldDifferences(rows);
        if (differences.length === 0) { failClosed('no-real-difference', { rowNumbers }); continue; }
        const detail = {
          code: config.code, rows: rowNumbers, rowNumbers, fields: differences,
          note: '脚本代选已撤销，按最近一次已应用批次的来源行恢复同号多行核对',
        };
        const existing = await one(`SELECT id, review_state FROM catalog.product_source_issue
          WHERE batch_id=$1 AND source_key=$2 AND issue_kind='duplicate_code_inconsistent'`,
        [latestBatch.id, `code:${config.code}`]);
        let issueId = existing?.id ?? null;
        let action = null;
        if (existing && existing.review_state === 'open') {
          evidence.steps.B.skipped.push({ code: config.code, reason: 'already-open', issueId: existing.id });
          continue;
        }
        if (existing) {
          await owner.query(`UPDATE catalog.product_source_issue
            SET review_state='open', detail=$2::jsonb, item_id=$3, scope='batch', opened_at=now(),
                resolved_at=NULL, resolved_by=NULL, resolution_note=NULL, superseded_by=NULL, superseded_at=NULL
            WHERE id=$1`, [existing.id, JSON.stringify(detail), revoked.itemId]);
          action = 'reopened';
        } else {
          const inserted = await one(`INSERT INTO catalog.product_source_issue
            (batch_id, source_key, issue_kind, detail, item_id, scope)
            VALUES($1,$2,'duplicate_code_inconsistent',$3::jsonb,$4,'batch') RETURNING id`,
          [latestBatch.id, `code:${config.code}`, JSON.stringify(detail), revoked.itemId]);
          issueId = inserted.id;
          action = 'inserted';
        }
        const requestId = crypto.randomUUID();
        const intent = newIntent();
        const result = {
          correction: 'rebuild_duplicate_issue', code: config.code, issueId,
          rowNumbers, fieldDifferences: differences.map((row) => row.fieldKey),
          revokedDecisionId: revoked.decision.id, action,
        };
        await owner.query(`INSERT INTO catalog.audit_event(request_id,intent_sha256,actor_id,action,item_id,result)
          VALUES($1,$2,$3,'restore_duplicate_source_decision',$4,$5::jsonb)`,
        [requestId, intent, ADMIN_PROFILE_ID, revoked.itemId, JSON.stringify(result)]);
        await owner.query(`INSERT INTO catalog.product_source_request
          (request_id,profile_id,action,intent_sha256,batch_id,result,actor_id)
          VALUES($1,$2,'restore_duplicate_source_decision',$3,$4,$5::jsonb,$6)
          ON CONFLICT(request_id) DO NOTHING`,
        [requestId, profile.id, intent, latestBatch.id, JSON.stringify(result), ADMIN_PROFILE_ID]);
        const issueRow = await one('SELECT id, batch_id, source_key, issue_kind, review_state, scope, item_id, detail, opened_at FROM catalog.product_source_issue WHERE id=$1', [issueId]);
        rebuiltIssues.push({ code: config.code, issueId, action, rowNumbers, differences, itemId: revoked.itemId });
        evidence.steps.B.executed.push({
          code: config.code, action, issueId, rowNumbers,
          fieldDifferences: differences.map((row) => ({ fieldKey: row.fieldKey, rowValues: row.values })),
          itemId: revoked.itemId, batchId: latestBatch.id, requestId,
          issue: { review_state: issueRow.review_state, scope: issueRow.scope, opened_at: issueRow.opened_at },
        });
      }
      const issuesInTx = await query(`SELECT id, source_key, review_state, item_id,
          detail->'rowNumbers' AS row_numbers, detail->'fields' AS fields
        FROM catalog.product_source_issue
        WHERE batch_id=$1 AND issue_kind='duplicate_code_inconsistent' ORDER BY source_key`, [latestBatch.id]);
      const issuesByCode = Object.fromEntries(issuesInTx.map((row) => [row.source_key.replace(/^code:/, ''), row]));
      check('B 为 4 个 code 重建 open 同号事项（行号取最新批 63/127、64/128、65/129、67/131；已重建则 skip）',
        issuesInTx.length === 4 && issuesInTx.every((row) => row.review_state === 'open')
        && DUPLICATE_CODES.every((config) => {
          const found = issuesByCode[config.code];
          return found && JSON.stringify(found.row_numbers) === JSON.stringify(config.expectedRows);
        }), { executed: rebuiltIssues.length, skipped: evidence.steps.B.skipped.length,
          issues: issuesInTx.map((row) => ({ code: row.source_key, rows: row.row_numbers, state: row.review_state })) });
      check('B 每条事项都包含真实差异（barcode 空白 vs 有值，其余字段一致）',
        issuesInTx.length === 4 && issuesInTx.every((row) => Array.isArray(row.fields)
          && row.fields.length >= 1
          && row.fields.every((difference) => difference.fieldKey === 'barcode')
          && row.fields[0].values.length === 2
          && row.fields[0].values.some((value) => value.state === 'explicit_empty')
          && row.fields[0].values.some((value) => value.state === 'observed' && value.raw)),
        issuesInTx.map((row) => ({ code: row.source_key, diffs: row.fields?.map((difference) => difference.fieldKey) })));
      evidence.rebuiltIssues = rebuiltIssues;

      // ---------------------------------------------------------------
      // C. 删除脚本选行产生的 barcode adoption；WM0073 追加 revision 3
      // ---------------------------------------------------------------
      const deletedAdoptions = [];
      for (const revoked of revokedDecisions) {
        const deleted = await query(`DELETE FROM catalog.product_source_adoption
          WHERE item_id=$1 AND field_key='barcode' AND adopted_batch_id=$2
          RETURNING item_id, field_key, adopted_raw, adopted_state, adopted_batch_id`,
        [revoked.itemId, latestBatch.id]);
        if (deleted.length > 0) {
          deletedAdoptions.push(...deleted);
          evidence.steps.C.executed.push({ code: revoked.code, action: 'delete-barcode-adoption', deleted });
        } else {
          evidence.steps.C.skipped.push({ code: revoked.code, reason: 'no-barcode-adoption-for-batch' });
        }
      }
      const allDuplicateItemIds = DUPLICATE_CODES.map((config) => itemIdByCode[config.code]).filter(Boolean);
      const barcodeLeftInTx = await query(`SELECT item_id FROM catalog.product_source_adoption
        WHERE item_id = ANY($1::uuid[]) AND field_key='barcode' AND adopted_batch_id=$2`,
      [allDuplicateItemIds, latestBatch.id]);
      check('C 删除 4 条仅由脚本选行产生的 barcode adoption（已删除则 skip）',
        barcodeLeftInTx.length === 0
        && (deletedAdoptions.length === 4 || (deletedAdoptions.length === 0 && revokedDecisions.length === 0)),
        { deleted: deletedAdoptions.length, left: barcodeLeftInTx.length });
      const wm0073Revoked = revokedDecisions.some((row) => row.code === 'WM0073');
      let wm0073Result = null;
      if (wm0073Revoked) {
        const current = await one('SELECT revision FROM catalog.item_current WHERE item_id=$1', [WM0073_ITEM]);
        const rev2 = await one(`SELECT revision, previous_revision, ice_code_snapshot, name_cn, fields, artifact_id,
          evidence_ref FROM catalog.item_revision WHERE item_id=$1 AND revision=2`, [WM0073_ITEM]);
        const rev3 = await one('SELECT revision FROM catalog.item_revision WHERE item_id=$1 AND revision=3', [WM0073_ITEM]);
        const rev2Barcode = rev2?.fields?.barcode;
        if (rev3) {
          wm0073Result = { skipped: 'revision-3-exists', currentRevision: current?.revision };
          evidence.steps.C.skipped.push({ code: 'WM0073', reason: 'revision-3-exists' });
        } else if (current?.revision !== 2 || rev2Barcode?.raw !== '757577407359') {
          wm0073Result = { skipped: 'precondition-not-met',
            currentRevision: current?.revision ?? null, rev2Barcode: rev2Barcode ?? null };
          evidence.steps.C.skipped.push({ code: 'WM0073', reason: 'precondition-not-met',
            currentRevision: current?.revision ?? null, rev2Barcode: rev2Barcode ?? null });
        } else {
          const nextFields = { ...rev2.fields };
          delete nextFields.barcode;
          const evidenceRef = `correction:duplicate-decision-revoke:${crypto.randomUUID()}`;
          await owner.query(`INSERT INTO catalog.item_revision
            (item_id,revision,previous_revision,ice_code_snapshot,name_cn,fields,artifact_id,evidence_ref,reason,actor_id)
            VALUES($1,3,2,$2,$3,$4::jsonb,$5,$6,'撤销脚本代选，恢复待人工确认',$7)`,
          [WM0073_ITEM, rev2.ice_code_snapshot, rev2.name_cn, JSON.stringify(nextFields),
            rev2.artifact_id, evidenceRef, ADMIN_PROFILE_ID]);
          await owner.query('UPDATE catalog.item_current SET revision=3 WHERE item_id=$1', [WM0073_ITEM]);
          wm0073Result = {
            executed: true, previousRevision: 2, revision: 3, iceCodeSnapshot: rev2.ice_code_snapshot,
            barcodeRemoved: true, removedBarcode: rev2Barcode,
            fieldsKeys: Object.keys(nextFields), evidenceRef,
            rev1Preserved: Boolean(await one('SELECT 1 AS ok FROM catalog.item_revision WHERE item_id=$1 AND revision=1', [WM0073_ITEM])),
            rev2Preserved: Boolean(await one('SELECT 1 AS ok FROM catalog.item_revision WHERE item_id=$1 AND revision=2', [WM0073_ITEM])),
          };
          evidence.steps.C.executed.push({ code: 'WM0073', action: 'append-revision-3', ...wm0073Result });
        }
      } else {
        wm0073Result = { skipped: 'decision-not-revoked-this-run' };
        evidence.steps.C.skipped.push({ code: 'WM0073', reason: 'decision-not-revoked-this-run' });
      }
      const wm0073RevisionsInTx = await query(`SELECT revision, previous_revision, ice_code_snapshot,
          fields->'barcode' AS barcode FROM catalog.item_revision WHERE item_id=$1 ORDER BY revision`, [WM0073_ITEM]);
      evidence.wm0073 = wm0073Result;
      check('C WM0073 追加 revision 3（去掉 barcode，rev1/rev2 保留，item_current=3；已追加则 skip）',
        wm0073RevisionsInTx.length === 3
        && wm0073RevisionsInTx[2]?.revision === 3
        && wm0073RevisionsInTx[2]?.barcode === null
        && wm0073RevisionsInTx[1]?.barcode?.raw === '757577407359'
        && wm0073Result && (wm0073Result.executed === true
          || wm0073Result.skipped === 'revision-3-exists'
          || wm0073Result.skipped === 'decision-not-revoked-this-run'),
        { result: wm0073Result, revisions: wm0073RevisionsInTx });

      // ---------------------------------------------------------------
      // D. LS101501：撤销 override，登记 2 条 interpret
      // ---------------------------------------------------------------
      const lsOverride = await one(`SELECT * FROM catalog.product_source_field_decision
        WHERE item_id=$1 AND field_key='unitWeight' AND action='override' AND state='active'`, [LS_ITEM]);
      const overrideRevoked = { executed: false, before: lsOverride ?? null };
      if (lsOverride) {
        const revoke = (await one('SELECT catalog.revoke_product_source_field_decision($1,$2,$3,$4) AS r',
          [crypto.randomUUID(), newIntent(), lsOverride.id, '撤销固定 0.05 override：改为按来源列解释重量'])).r;
        const after = await one('SELECT state, revoked_at, revoked_by, revoked_note FROM catalog.product_source_field_decision WHERE id=$1', [lsOverride.id]);
        overrideRevoked.executed = true;
        overrideRevoked.revoke = revoke;
        overrideRevoked.after = after;
        evidence.steps.D.executed.push({ action: 'revoke-ls101501-override', decisionId: lsOverride.id,
          before: { action: lsOverride.action, valueRaw: lsOverride.value_raw, state: lsOverride.state },
          revoke, after });
      } else {
        evidence.steps.D.skipped.push({ action: 'revoke-ls101501-override', reason: 'no-active-unitWeight-override' });
      }
      const interpretations = [];
      for (const config of INTERPRETATIONS) {
        const active = await one(`SELECT * FROM catalog.product_source_field_decision
          WHERE item_id=$1 AND field_key=$2 AND action='interpret' AND state='active'`, [LS_ITEM, config.field]);
        if (active) {
          evidence.steps.D.skipped.push({ action: 'interpret', fieldKey: config.field, reason: 'already-active',
            decisionId: active.id, rule: active.rule });
          interpretations.push({ field: config.field, skipped: true, decisionId: active.id, rule: active.rule });
          continue;
        }
        const requestId = crypto.randomUUID();
        const setResult = (await one(
          'SELECT catalog.set_product_source_field_interpretation($1,$2,$3,$4,$5,$6,$7) AS r',
          [requestId, newIntent(), LS_ITEM, config.field, config.rule, config.reason, config.note])).r;
        const row = await one('SELECT * FROM catalog.product_source_field_decision WHERE id=$1', [setResult.decisionId]);
        interpretations.push({ field: config.field, decisionId: setResult.decisionId, rule: config.rule,
          setResult, state: row?.state, storedRule: row?.rule, valueRaw: row?.value_raw });
        evidence.steps.D.executed.push({ action: 'interpret', fieldKey: config.field, rule: config.rule,
          decisionId: setResult.decisionId, state: row?.state, storedRule: row?.rule, valueRaw: row?.value_raw,
          itemId: LS_ITEM, reason: config.reason });
      }
      const activeOverrideAfter = await one(`SELECT 1 AS ok FROM catalog.product_source_field_decision
        WHERE item_id=$1 AND field_key='unitWeight' AND action='override' AND state='active'`, [LS_ITEM]);
      check('D 撤销 LS101501 固定 0.05 override（已撤销则 skip）',
        (overrideRevoked.executed === true && overrideRevoked.after?.state === 'revoked')
        || (!activeOverrideAfter && evidence.steps.D.skipped.some((row) => row.action === 'revoke-ls101501-override')),
        { executed: overrideRevoked.executed, activeOverrideAfter: Boolean(activeOverrideAfter) });
      check('D 登记 2 条 interpret（unitWeight=unit_weight_per_unit_fragment、cartonWeight=confirmed_source_value）',
        interpretations.length === 2 && interpretations.every((row) => row.rule)
        && interpretations.map((row) => row.field).sort().join(',') === 'cartonWeight,unitWeight',
        interpretations.map((row) => ({ field: row.field, rule: row.rule, skipped: row.skipped ?? false })));
      const lsCurrent = await one('SELECT revision FROM catalog.item_current WHERE item_id=$1', [LS_ITEM]);
      check('D interpret 不写商品字段、不新增修订（LS101501 revision 不变）',
        lsCurrent?.revision === evidence.context.lsRevision,
        { before: evidence.context.lsRevision, after: lsCurrent?.revision });
      evidence.interpretations = interpretations;
      evidence.overrideRevoked = overrideRevoked;

      const readDecisions = (await one('SELECT catalog.read_product_source_manual_decisions($1) AS r', [PROFILE_KEY])).r;
      evidence.manufacturingDecisions = readDecisions;
      const interpretInRead = (readDecisions.fieldDecisions ?? [])
        .filter((row) => row.itemId === LS_ITEM && row.action === 'interpret');
      check('D read_product_source_manual_decisions 返回 interpret 决定且带 rule',
        interpretInRead.length === 2 && interpretInRead.every((row) => row.rule)
        && interpretInRead.map((row) => `${row.fieldKey}:${row.rule}`).sort().join(',')
          === 'cartonWeight:confirmed_source_value,unitWeight:unit_weight_per_unit_fragment',
        interpretInRead.map((row) => ({ fieldKey: row.fieldKey, rule: row.rule, action: row.action })));

      // ---------------------------------------------------------------
      // 汇总（事务内状态）
      // ---------------------------------------------------------------
      evidence.afterInTransaction = await one(countsSql);
      evidence.inTransactionState = {
        supersededDecisions: await query(`SELECT ice_code, state FROM catalog.product_source_duplicate_decision ORDER BY ice_code`),
        openDuplicateIssues: await query(`SELECT id, source_key, batch_id, detail->>'code' AS code,
            detail->'rowNumbers' AS row_numbers, review_state FROM catalog.product_source_issue
          WHERE issue_kind='duplicate_code_inconsistent' AND review_state='open' ORDER BY source_key`),
        wm0073Revisions: await query(`SELECT revision, previous_revision, ice_code_snapshot,
            fields->'barcode' AS barcode FROM catalog.item_revision WHERE item_id=$1 ORDER BY revision`, [WM0073_ITEM]),
        barcodeAdoptions: await query(`SELECT item_id, field_key, adopted_raw FROM catalog.product_source_adoption
          WHERE item_id = ANY($1::uuid[]) AND field_key='barcode'`,
        [revokedDecisions.map((row) => row.itemId)]),
        nameCnAdoptions: await query(`SELECT item_id, field_key, adopted_raw FROM catalog.product_source_adoption
          WHERE item_id = ANY($1::uuid[]) AND field_key='nameCn'`,
        [revokedDecisions.map((row) => row.itemId)]),
        interpretActive: await query(`SELECT id, item_id, field_key, rule, state FROM catalog.product_source_field_decision
          WHERE item_id=$1 AND action='interpret' ORDER BY field_key`, [LS_ITEM]),
      };

      // 提交 / 回滚
      if (commit) {
        await owner.query('COMMIT');
        evidence.committed = true;
      } else {
        await owner.query('ROLLBACK');
        evidence.committed = false;
      }

      // 模式后置检查：commit 后应看到补修结果；dry-run 后应回到原状
      await owner.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [ADMIN_PROFILE_ID]);
      evidence.afterMode = await one(countsSql);
      const decisionsAfter = await query(`SELECT ice_code, state FROM catalog.product_source_duplicate_decision ORDER BY ice_code`);
      const openAfter = await query(`SELECT id, source_key, review_state, detail->'rowNumbers' AS row_numbers
        FROM catalog.product_source_issue WHERE issue_kind='duplicate_code_inconsistent' AND review_state='open'
        ORDER BY source_key`);
      const interpretAfterQuery = await owner.query(
        `SELECT count(*)::int AS n FROM information_schema.columns
         WHERE table_schema='catalog' AND table_name='product_source_field_decision' AND column_name='rule'`);
      const hasRuleColumn = interpretAfterQuery.rows[0].n === 1;
      const interpretAfter = hasRuleColumn
        ? await query(`SELECT id, field_key, rule, state FROM catalog.product_source_field_decision
            WHERE item_id=$1 AND action='interpret' ORDER BY field_key`, [LS_ITEM])
        : [];
      const wm0073RevisionsAfter = await query(`SELECT revision, previous_revision, fields->'barcode' AS barcode
        FROM catalog.item_revision WHERE item_id=$1 ORDER BY revision`, [WM0073_ITEM]);
      evidence.afterModeState = { decisionsAfter, openAfter, interpretAfter, wm0073RevisionsAfter,
        barcodeAdoptionsAfter: await query(`SELECT item_id, field_key FROM catalog.product_source_adoption
          WHERE item_id = ANY($1::uuid[]) AND field_key='barcode'`, [revokedDecisions.map((row) => row.itemId)]) };

      if (commit) {
        check('提交后 4 条旧 duplicate decision 均为 superseded',
          decisionsAfter.length === 4 && decisionsAfter.every((row) => row.state === 'superseded'),
          decisionsAfter);
        check('提交后 4 条新 open 同号事项就位（行号 63/127、64/128、65/129、67/131）',
          openAfter.length === 4 && openAfter.every((row) => {
            const config = DUPLICATE_CODES.find((entry) => `code:${entry.code}` === row.source_key);
            return config && JSON.stringify(row.row_numbers) === JSON.stringify(config.expectedRows);
          }), openAfter);
        check('提交后 4 条 barcode adoption 已删除、4 条 nameCn adoption 保留',
          evidence.afterModeState.barcodeAdoptionsAfter.length === 0
          && (await query(`SELECT item_id FROM catalog.product_source_adoption
              WHERE item_id = ANY($1::uuid[]) AND field_key='nameCn'`, [allDuplicateItemIds])).length === 4,
          { barcodeLeft: evidence.afterModeState.barcodeAdoptionsAfter.length });
        check('提交后 WM0073 revision=3 且 rev3 无 barcode、rev2 仍在',
          evidence.afterModeState.wm0073RevisionsAfter.length === 3
          && evidence.afterModeState.wm0073RevisionsAfter[2]?.revision === 3
          && evidence.afterModeState.wm0073RevisionsAfter[2]?.barcode === null
          && Boolean(evidence.afterModeState.wm0073RevisionsAfter[1]?.barcode),
          evidence.afterModeState.wm0073RevisionsAfter);
        check('提交后 LS101501 有 2 条 active interpret',
          interpretAfter.length === 2 && interpretAfter.every((row) => row.state === 'active'),
          interpretAfter);
        check('提交后 open 事项总数 = 1 + 4（原 item 级缺码 + 4 条重建同号）',
          evidence.afterMode.open_issues === 5,
          { beforeRun: evidence.before.open_issues, after: evidence.afterMode.open_issues });
      } else {
        check('dry-run 后旧 duplicate decision 仍为 active（未落库）',
          decisionsAfter.length === 4 && decisionsAfter.every((row) => row.state === 'active'), decisionsAfter);
        check('dry-run 后无新增 open 同号事项（回滚干净）', openAfter.length === 0, openAfter);
        check('dry-run 后 LS101501 override 仍 active、无 interpret（回滚干净）',
          interpretAfter.length === 0
          && Boolean(await one(`SELECT 1 AS ok FROM catalog.product_source_field_decision
            WHERE item_id=$1 AND field_key='unitWeight' AND action='override' AND state='active'`, [LS_ITEM])),
          { interpretAfter });
        check('dry-run 后行数/修订/adoption 与执行前一致',
          JSON.stringify(evidence.afterMode) === JSON.stringify(evidence.before),
          { before: evidence.before, after: evidence.afterMode });
      }
    } catch (error) {
      try { await owner.query('ROLLBACK'); } catch { /* 事务可能已结束 */ }
      evidence.error = { message: error.message, code: error.code, where: error.where,
        stack: String(error.stack).slice(0, 2000) };
      throw error;
    }
  } catch (error) {
    if (!evidence.error) evidence.error = { message: error.message, code: error.code };
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    const failed = results.filter((row) => !row.ok);
    evidence.summary = { total: results.length, failed: failed.length };
    fs.writeFileSync(path.join(EVIDENCE_DIR, commit ? 'corrections-037.json' : 'corrections-037-dryrun.json'),
      `${JSON.stringify(evidence, null, 2)}\n`);
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
    return;
  } finally {
    await owner.end();
  }

  const failed = results.filter((row) => !row.ok);
  evidence.summary = {
    total: results.length, failed: failed.length,
    executedSteps: ['A', 'B', 'C', 'D'].reduce((acc, key) => acc + evidence.steps[key].executed.length, 0),
    skippedSteps: ['A', 'B', 'C', 'D'].reduce((acc, key) => acc + evidence.steps[key].skipped.length, 0),
    failedSteps: ['A', 'B', 'C', 'D'].reduce((acc, key) => acc + evidence.steps[key].failed.length, 0),
  };
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const evidencePath = path.join(EVIDENCE_DIR, commit ? 'corrections-037.json' : 'corrections-037-dryrun.json');
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`\nSUMMARY mode=${evidence.mode} database=${targetDatabase} checks=${results.length} `
    + `pass=${results.length - failed.length} fail=${failed.length} `
    + `executed=${evidence.summary.executedSteps} skipped=${evidence.summary.skippedSteps} `
    + `failedSteps=${evidence.summary.failedSteps}`);
  console.log(`EVIDENCE ${evidencePath}`);
  if (failed.length > 0 || evidence.summary.failedSteps > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
