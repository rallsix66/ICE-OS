/**
 * 036 上线后的一次性人工决定落库（本机现役实例；也在隔离克隆库复用）。
 *
 * 只做用户已明确决定的事项，不新增猜测：
 *   - 5 个商品的“单瓶立方”暂不处理：WM0005 / WM0007 / WM10012 / WM0081 / brush
 *   - LS101302 的“运输时间”暂不处理
 *   - LS101501 的“单个重量”按人工口径采用 O 列 0.05/件（箱重仍取 T 列 24.15）
 *   - 4 个同号多行：人工确认以带 69 商品编码的那一行为准（WM0069/70/71/73）
 *   - 定向纠正 TEST-PG-NEW122-0，恢复烟酰胺提亮精华水 150ml 的“货号待确认”
 *   - 旧 row:122 缺码事项因原表行删除而关闭；商品级待确认事项保留
 *
 * 默认 dry-run（只打印将执行的动作）；`--commit` 才调用 RPC。
 * 幂等：已有 active 决定 / 已关闭事项 / 测试码已移除时跳过。
 *
 * 用法：
 *   node scripts/catalog/apply-036-corrections.mjs --run-id <run-id>
 *   node scripts/catalog/apply-036-corrections.mjs --run-id <run-id> --database-url <url> --commit
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_RUN_ID = 'run-20261026T211500Z-11a22b33';
const ADMIN = '11111111-1111-4111-8111-111111111101';
const PROFILE_KEY = 'feishu.ice-product-library.sheet1';
const ADOPTABLE_FIELD_KEYS = [
  'nameCn', 'specification', 'englishName', 'factory', 'barcode',
  'length', 'width', 'height', 'unitWeight', 'cartonQuantity',
  'cartonLength', 'cartonWidth', 'cartonHeight', 'cartonWeight', 'liquid',
  'shelfLifeDays', 'cartonVolume', 'unitVolume', 'factoryLeadDays', 'shippingDays', 'sourceNote',
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

function intentOf(identity, action, payload) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(['iceos-product-source-request-v1', identity, action, payload]))
    .digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256Text(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function cellSignature(cell) {
  if (!cell) return 'e';
  if (cell.state === 'observed') return `v:${cell.raw}`;
  if (cell.state === 'explicit_empty') return 'e';
  if (cell.state === 'parse_failed') return `f:${cell.reason ?? ''}`;
  if (cell.state === 'not_read') return `n:${cell.reason ?? ''}`;
  return 'unknown';
}

function rowBusinessSha256(fields) {
  const payload = {};
  for (const fieldKey of ADOPTABLE_FIELD_KEYS) payload[fieldKey] = cellSignature(fields?.[fieldKey]);
  return sha256Text(canonicalJson(payload));
}

function duplicateBasisSha256(rows) {
  return sha256Text(canonicalJson(rows.map((row) => rowBusinessSha256(row.fields)).sort()));
}

const DEFER_UNIT_VOLUME = ['WM0005', 'WM0007', 'WM10012', 'WM0081', 'brush'];
const DEFER_SHIPPING_DAYS = ['LS101302'];
const DUPLICATE_CODES = ['WM0069', 'WM0070', 'WM0071', 'WM0073'];
const TEST_ITEM_ID = 'dfef3f23-c64e-4646-98d0-045efb4e55f2';
const TEST_CODE = 'TEST-PG-NEW122-0';
const WEIGHT_CODE = 'LS101501';
const WEIGHT_VALUE = '0.05';
const WEIGHT_REASON = '用户确认：单个重量取 O 列 0.05/件；箱重以 T 列 24.15 为准，忽略 O 列夹带的 24.45/箱';

async function main() {
  const args = readArgs(process.argv.slice(2));
  const runId = args['run-id'] ?? DEFAULT_RUN_ID;
  const envPath = path.join(REPO_ROOT, '.local/catalog', runId, 'instance/env.inventory.json');
  const env = JSON.parse(fs.readFileSync(envPath, 'utf8'));
  const databaseUrl = args['database-url'] ?? env.ownerDbUrl;
  const commit = args.commit === true;
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const results = [];
  const evidence = {
    at: new Date().toISOString(), databaseUrl: databaseUrl.replace(/:[^:@]+@/, ':***@'),
    mode: commit ? 'commit' : 'dry-run', runId, steps: results,
  };
  const q = async (sql, params) => (await client.query(sql, params)).rows;
  let serial = 0;
  const nextRequest = () => {
    serial += 1;
    return crypto.createHash('sha256').update(`036-correction:${runId}:${serial}`).digest('hex');
  };
  const call = async (label, action, payload, fn) => {
    const step = { label, action, executed: false };
    results.push(step);
    if (!commit) { step.planned = true; return null; }
    try {
      const requestId = nextRequest();
      // deterministic UUID from hash for idempotent reruns
      const uuid = `${requestId.slice(0, 8)}-${requestId.slice(8, 12)}-4${requestId.slice(13, 16)}-a${requestId.slice(17, 20)}-${requestId.slice(20, 32)}`;
      const intent = intentOf(ADMIN, action, payload);
      await client.query('SELECT set_config($1,$2,true)', ['request.jwt.claim.sub', ADMIN]);
      const value = await fn(uuid, intent);
      step.executed = true;
      step.requestId = uuid;
      step.result = value;
      return value;
    } catch (error) {
      step.error = String(error.message).slice(0, 400);
      throw error;
    }
  };

  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1,$2,true)', ['request.jwt.claim.sub', ADMIN]);
    const profile = (await q('SELECT id FROM catalog.product_source_profile WHERE profile_key=$1', [PROFILE_KEY]))[0];
    if (!profile) throw new Error('SOURCE_PROFILE_NOT_FOUND');
    const issues = await q(
      `SELECT i.id,i.source_key,i.issue_kind,i.item_id,i.detail,i.review_state,i.scope
       FROM catalog.product_source_issue i
       JOIN catalog.product_source_batch b ON b.id=i.batch_id
       WHERE b.profile_id=$1 AND i.review_state='open' ORDER BY i.opened_at`, [profile.id]);
    const activeField = await q(
      `SELECT d.item_id,d.field_key,d.action FROM catalog.product_source_field_decision d
       WHERE d.profile_id=$1 AND d.state='active'`, [profile.id]);
    const activeDup = await q(
      `SELECT d.ice_code FROM catalog.product_source_duplicate_decision d
       WHERE d.profile_id=$1 AND d.state='active'`, [profile.id]);
    const activeFieldKeys = new Set(activeField.map((row) => `${row.item_id}:${row.field_key}`));
    const activeDupCodes = new Set(activeDup.map((row) => row.ice_code));

    const findByCode = (code, kind) => issues.find((issue) => issue.source_key === `code:${code}`
      && (!kind || issue.issue_kind === kind));

    for (const code of DEFER_UNIT_VOLUME) {
      const issue = findByCode(code);
      if (!issue) { results.push({ label: `defer unitVolume ${code}`, skipped: 'NO_OPEN_ISSUE' }); continue; }
      if (activeFieldKeys.has(`${issue.item_id}:unitVolume`)) {
        results.push({ label: `defer unitVolume ${code}`, skipped: 'ALREADY_ACTIVE' }); continue;
      }
      await call(`defer unitVolume ${code}`, 'defer_source_field', { issueId: issue.id, action: 'defer' },
        (requestId, intent) => q(
          `SELECT catalog.set_product_source_field_decision($1,$2,$3,'defer',NULL,$4,$5) AS r`,
          [requestId, intent, issue.id, '用户决定：该商品的单瓶立方暂不处理，保留现值', '暂不处理该字段']).then((rows) => rows[0].r));
    }
    for (const code of DEFER_SHIPPING_DAYS) {
      const issue = findByCode(code);
      if (!issue) { results.push({ label: `defer shippingDays ${code}`, skipped: 'NO_OPEN_ISSUE' }); continue; }
      if (activeFieldKeys.has(`${issue.item_id}:shippingDays`)) {
        results.push({ label: `defer shippingDays ${code}`, skipped: 'ALREADY_ACTIVE' }); continue;
      }
      await call(`defer shippingDays ${code}`, 'defer_source_field', { issueId: issue.id, action: 'defer' },
        (requestId, intent) => q(
          `SELECT catalog.set_product_source_field_decision($1,$2,$3,'defer',NULL,$4,$5) AS r`,
          [requestId, intent, issue.id, '用户决定：运输时间暂不处理，保留现值', '暂不处理该字段']).then((rows) => rows[0].r));
    }
    {
      const issue = findByCode(WEIGHT_CODE);
      if (!issue) results.push({ label: `override unitWeight ${WEIGHT_CODE}`, skipped: 'NO_OPEN_ISSUE' });
      else if (activeFieldKeys.has(`${issue.item_id}:unitWeight`)) results.push({ label: `override unitWeight ${WEIGHT_CODE}`, skipped: 'ALREADY_ACTIVE' });
      else {
        await call(`override unitWeight ${WEIGHT_CODE}`, 'override_source_field',
          { issueId: issue.id, action: 'override', value: WEIGHT_VALUE },
          (requestId, intent) => q(
            `SELECT catalog.set_product_source_field_decision($1,$2,$3,'override',$4,$5,$6) AS r`,
            [requestId, intent, issue.id, WEIGHT_VALUE, WEIGHT_REASON, '人工口径：O 列 0.05/件，忽略 /箱 片段']).then((rows) => rows[0].r));
      }
    }
    for (const code of DUPLICATE_CODES) {
      const issue = findByCode(code, 'duplicate_code_inconsistent');
      if (!issue) { results.push({ label: `duplicate choice ${code}`, skipped: 'NO_OPEN_ISSUE' }); continue; }
      if (activeDupCodes.has(code)) { results.push({ label: `duplicate choice ${code}`, skipped: 'ALREADY_ACTIVE' }); continue; }
      const batchId = (await q('SELECT batch_id FROM catalog.product_source_issue WHERE id=$1', [issue.id]))[0].batch_id;
      const codeRows = await q(
        `SELECT row_number,row_sha256,fields FROM catalog.product_source_row
         WHERE batch_id=$1 AND is_empty=false AND ice_code_raw=$2 ORDER BY row_number`, [batchId, code]);
      if (codeRows.length < 2) { results.push({ label: `duplicate choice ${code}`, skipped: 'ROWS_NOT_FOUND', count: codeRows.length }); continue; }
      const chosen = codeRows.find((row) => {
        const barcode = row.fields?.barcode;
        return barcode?.state === 'observed' && String(barcode.raw ?? '').trim() !== '';
      }) ?? codeRows[codeRows.length - 1];
      const chosenRowSha256 = rowBusinessSha256(chosen.fields);
      const basisSha256 = duplicateBasisSha256(codeRows);
      await call(`duplicate choice ${code}`, 'decide_duplicate_source_row',
        { issueId: issue.id, chosenRowNumber: chosen.row_number },
        (requestId, intent) => q(
          `SELECT catalog.decide_product_source_duplicate_row($1,$2,$3,$4,$5,$6,$7,$8) AS r`,
          [requestId, intent, issue.id, chosen.row_number, chosenRowSha256, basisSha256, chosen.row_sha256,
            `用户确认：以来源第 ${chosen.row_number} 行（含 69 商品编码）为准`]).then((result) => result[0].r));
    }
    {
      const codeRow = await q('SELECT ice_code FROM catalog.catalog_item_code WHERE item_id=$1', [TEST_ITEM_ID]);
      if (codeRow.length === 0) {
        results.push({ label: 'correct test code', skipped: 'ALREADY_CORRECTED' });
      } else if (codeRow[0].ice_code !== TEST_CODE) {
        results.push({ label: 'correct test code', skipped: 'UNEXPECTED_CODE', code: codeRow[0].ice_code });
      } else {
        await call('correct test code', 'correct_test_source_code', { itemId: TEST_ITEM_ID, code: TEST_CODE },
          (requestId, intent) => q(
            `SELECT catalog.correct_test_product_code($1,$2,$3,$4,$5) AS r`,
            [requestId, intent, TEST_ITEM_ID, TEST_CODE, '核清测试修订：恢复货号待确认，保留原商品 UUID、历史与在途关联']).then((rows) => rows[0].r));
      }
    }
    // 旧来源缺码行事项：原表行已删除，由商品级 pending 事项承载。
    {
      const stale = issues.find((issue) => issue.issue_kind === 'missing_code'
        && issue.item_id === null
        && issue.detail?.nameCn === 'ICE LERSKIN 烟酰胺提亮精华水150ml');
      if (!stale) results.push({ label: 'close stale row:122 issue', skipped: 'NOT_OPEN' });
      else {
        await call('close stale row:122 issue', 'resolve_source_issue', { issueId: stale.id },
          (requestId, intent) => q(
            `SELECT catalog.resolve_product_source_issue($1,$2,$3,'resolved',$4) AS r`,
            [requestId, intent, stale.id, '原表行已删除；货号待确认由商品级事项继续跟踪']).then((rows) => rows[0].r));
      }
    }

    const summary = await q(
      `SELECT
        (SELECT count(*)::int FROM catalog.product_source_issue i JOIN catalog.product_source_batch b ON b.id=i.batch_id
          WHERE b.profile_id=$1 AND i.review_state='open') AS open_issues,
        (SELECT count(*)::int FROM catalog.product_source_field_decision WHERE profile_id=$1 AND state='active') AS field_decisions,
        (SELECT count(*)::int FROM catalog.product_source_duplicate_decision WHERE profile_id=$1 AND state='active') AS duplicate_decisions,
        (SELECT count(*)::int FROM catalog.catalog_item_code WHERE item_id=$2) AS test_codes`,
      [profile.id, TEST_ITEM_ID]);
    evidence.summary = summary[0];
    if (commit) await client.query('COMMIT');
    else await client.query('ROLLBACK');
    fs.mkdirSync(path.join(REPO_ROOT, '.local/catalog/feishu-source-review-flow-20261110'), { recursive: true });
    fs.writeFileSync(
      path.join(REPO_ROOT, '.local/catalog/feishu-source-review-flow-20261110', commit ? 'corrections-commit.json' : 'corrections-dry-run.json'),
      `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(JSON.stringify(evidence.summary, null, 2));
    console.log(`mode=${evidence.mode} steps=${results.length} errors=${results.filter((step) => step.error).length}`);
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* already ended */ }
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((error) => { console.error(error.stack ?? error.message); process.exitCode = 1; });
