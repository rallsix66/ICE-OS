#!/usr/bin/env node
/**
 * V3-04 edit matrix on an isolated fixture lane (baseline item).
 *
 * States: success / verification failure / real concurrent version conflict /
 * unknown submitted-response-lost / unknown not-submitted / original already applied /
 * no receipt / check failed. Every state verifies actual DB write counts, revisions and
 * audit rows (not toasts), and that drafts/pending requests follow the v3 storage contract.
 *
 * Also checks in-dialog history (current/history badges, revision switching) and the
 * in-dialog evidence subview where the implementation exposes it.
 *
 * Usage: node tests/catalog/ui-repair-v3-edit-matrix.mjs --run-id <work-run> --port 3015
 */
import {
  createRecorder, editorLocators, expectAll, fillDraft, launch, login, openDetailByCode, ownerClient, patchFlightBody, resolveRun, storage,
} from './ui-repair-v3-lib.mjs';

const ADMIN = '11111111-1111-4111-8111-111111111101';
function arg(flag, fallback) { const i = process.argv.indexOf(flag); return i < 0 ? fallback : process.argv[i + 1]; }
const runId = arg('--run-id');
const port = Number(arg('--port', '3015'));
const run = await resolveRun(runId);
const rec = createRecorder('v3-04-edit-matrix', runId);
const { expectations, expect, summary } = expectAll();
const db = await ownerClient(run);
const base = `http://127.0.0.1:${port}`;
const tag = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const codes = { success: 'WM0043', validation: 'WM0042', conflict: 'WM0041', unknownLost: 'WM0040', unknownNotSubmitted: 'WM0059' };

async function itemByCode(code) {
  return (await db.query(`SELECT k.item_id, c.revision FROM catalog.catalog_item_code k JOIN catalog.item_current c ON c.item_id=k.item_id WHERE k.ice_code=$1`, [code])).rows[0];
}
async function auditByRequest(requestId) {
  return (await db.query('SELECT request_id, action, item_id, result FROM catalog.audit_event WHERE request_id=$1', [requestId])).rows[0] ?? null;
}
async function revisionRows(itemId) {
  return (await db.query('SELECT revision, name_cn, fields, reason, evidence_ref FROM catalog.item_revision WHERE item_id=$1 ORDER BY revision', [itemId])).rows;
}
async function bumpExternal(itemId) {
  await db.query('BEGIN');
  try {
    await db.query(`INSERT INTO catalog.item_revision(item_id,revision,previous_revision,ice_code_snapshot,name_cn,fields,evidence_ref,reason,actor_id)
      SELECT c.item_id,c.revision+1,c.revision,r.ice_code_snapshot,r.name_cn,r.fields,'fixture:v3:concurrent','V3 external concurrent writer',$2
      FROM catalog.item_current c JOIN catalog.item_revision r ON r.item_id=c.item_id AND r.revision=c.revision WHERE c.item_id=$1`, [itemId, ADMIN]);
    await db.query('UPDATE catalog.item_current SET revision=revision+1 WHERE item_id=$1', [itemId]);
    await db.query(`INSERT INTO catalog.audit_event(request_id,intent_sha256,actor_id,action,item_id,result)
      VALUES(gen_random_uuid(),repeat('f',64),$2,'append_nonprice_revision',$1,'{"fixture":"v3-concurrent"}'::jsonb)`, [itemId, ADMIN]);
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  return itemByCode((await db.query(`SELECT ice_code FROM catalog.catalog_item_code WHERE item_id=$1`, [itemId])).rows[0]?.ice_code ?? '');
}
async function statusText(page) {
  return ((await page.locator('section[aria-label="补充资料"] p[role="status"]').last().textContent().catch(() => '')) ?? '').trim();
}
async function waitStatus(page, predicate, timeout = 90_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const text = await statusText(page);
    if (text && predicate(text)) return text;
    await page.waitForTimeout(250);
  }
  return await statusText(page);
}
const browser = await launch();
try {
  const context = await browser.newContext({ baseURL: base, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await login(page);
  let fields;

  /* ---------- 1. success ---------- */
  {
    const state = await itemByCode(codes.success);
    await openDetailByCode(page, codes.success);
    await page.getByRole('button', { name: '编辑资料', exact: true }).click();
    await page.getByTestId('catalog-detail-edit').waitFor({ timeout: 60_000 });
    fields = await fillDraft(page, { field: 'nameCn', value: `V3-SUCCESS-${tag}`, evidence: 'fixture:v3:success', reason: `V3 success ${tag}` });
    await fields.submit.click();
    const message = await waitStatus(page, (text) => /已保存|保存/.test(text));
    const after = await itemByCode(codes.success);
    const rows = await revisionRows(state.item_id);
    const latest = rows[rows.length - 1];
    const audits = (await db.query(`SELECT request_id, result FROM catalog.audit_event WHERE item_id=$1 AND action='append_nonprice_revision' ORDER BY recorded_at DESC LIMIT 1`, [state.item_id])).rows[0];
    await rec.shot(page, 'success');
    expect('success/real-write', after.revision === state.revision + 1 && latest.name_cn === `V3-SUCCESS-${tag}` && Boolean(audits),
      { before: state.revision, after: after.revision, audits, message });
    // in-dialog history: current badge + revision rows + switch
    await page.getByTestId('catalog-tab-history').click();
    await page.getByTestId('catalog-history-list').waitFor({ timeout: 60_000 });
    const currentBadge = await page.getByTestId('catalog-detail-current-badge').count().catch(() => 0);
    const currentRow = await page.getByTestId(`revision-history-${after.revision}`).getAttribute('data-current').catch(() => null);
    const switchButtons = await page.locator('[data-testid^="revision-switch-"]').count();
    expect('history/in-dialog-current+switch', currentBadge >= 1 && currentRow === 'true' && switchButtons >= 1,
      { currentBadge, currentRow, switchButtons });
    rec.record('success', { before: state.revision, after: after.revision, audits, message, currentBadge, currentRow, switchButtons });
  }

  /* ---------- 2. verification failure ---------- */
  {
    const state = await itemByCode(codes.validation);
    await page.goto('/dashboard/catalog');
    await openDetailByCode(page, codes.validation);
    await page.getByRole('button', { name: '编辑资料', exact: true }).click();
    await page.getByTestId('catalog-detail-edit').waitFor({ timeout: 60_000 });
    fields = editorLocators(page);
    await fields.field.selectOption('nameCn');
    await fields.value.fill('');
    await page.locator('input[name="confirmEmpty"]').check();
    await fields.evidence.fill('fixture:v3:validation');
    await fields.reason.fill(`V3 validation ${tag}`);
    await fields.submit.click();
    const message = await waitStatus(page, (text) => /未完成|未保存|无效|拒绝|不能/.test(text));
    const after = await itemByCode(codes.validation);
    const stored = await storage(page);
    const v3Draft = Object.entries(stored).find(([key]) => key.startsWith('catalog:edit-state:v3:'));
    const valueAfter = await fields.value.inputValue();
    await rec.shot(page, 'validation');
    expect('validation/db-unchanged', after.revision === state.revision && Boolean(message), { before: state.revision, after: after.revision, message });
    expect('validation/draft-kept-v3-key', valueAfter === '' && Boolean(v3Draft) && v3Draft[1].includes('fixture:v3:validation'),
      { v3DraftKey: v3Draft?.[0] });
    rec.record('validation', { before: state.revision, after: after.revision, message, v3DraftKey: v3Draft?.[0] });
  }

  /* ---------- 3. real concurrent version conflict ---------- */
  {
    const state = await itemByCode(codes.conflict);
    await page.goto('/dashboard/catalog');
    await openDetailByCode(page, codes.conflict);
    await page.getByRole('button', { name: '编辑资料', exact: true }).click();
    await page.getByTestId('catalog-detail-edit').waitFor({ timeout: 60_000 });
    fields = await fillDraft(page, { value: `V3-CONFLICT-${tag}`, evidence: 'fixture:v3:conflict', reason: `V3 conflict ${tag}` });
    const marker = `mount-${Date.now()}`;
    await page.getByTestId('catalog-detail-edit').evaluate((node, value) => node.setAttribute('data-fixture-mount', value), marker);
    const bumped = await bumpExternal(state.item_id);
    await fields.submit.click();
    const message = await waitStatus(page, (text) => /冲突|版本已变化/.test(text));
    await page.waitForTimeout(3_000);
    const stillMounted = await page.getByTestId('catalog-detail-edit').getAttribute('data-fixture-mount').catch(() => null);
    const valueAfter = await fields.value.inputValue().catch(() => null);
    const stored = await storage(page);
    const draftKept = Object.entries(stored).some(([key, value]) => key.startsWith('catalog:edit-state:v3:') && value.includes(`V3-CONFLICT-${tag}`));
    await rec.shot(page, 'conflict');
    expect('conflict/reported+no-write', /冲突|版本已变化/.test(message) && (await itemByCode(codes.conflict)).revision === bumped.revision,
      { message, before: state.revision, bumped: bumped.revision, after: (await itemByCode(codes.conflict)).revision });
    expect('conflict/draft-survives', valueAfter === `V3-CONFLICT-${tag}` && draftKept && Boolean(stillMounted), { valueAfter, draftKept, stillMounted, marker });
    rec.record('conflict', { message, before: state.revision, bumped: bumped.revision, valueAfter, draftKept, stillMounted, marker });
  }

  /* ---------- 4. unknown: submitted but response lost ---------- */
  {
    const state = await itemByCode(codes.unknownLost);
    await page.goto('/dashboard/catalog');
    await openDetailByCode(page, codes.unknownLost);
    await page.getByRole('button', { name: '编辑资料', exact: true }).click();
    await page.getByTestId('catalog-detail-edit').waitFor({ timeout: 60_000 });
    fields = await fillDraft(page, { value: `V3-UNKNOWN-LOST-${tag}`, evidence: 'fixture:v3:unknown-lost', reason: `V3 unknown lost ${tag}` });
    let submitted = 0;
    const bodies = [];
    await page.route('**/*', async (route) => {
      const request = route.request();
      if (request.method() !== 'POST') return route.fallback();
      const postData = request.postData() ?? '';
      if (!postData.includes(state.item_id) || !postData.includes('"fields"')) return route.fallback();
      submitted += 1;
      bodies.push(postData.slice(0, 400));
      const response = await route.fetch();
      const text = await response.text();
      const patched = patchFlightBody(text, (parsed) => (parsed && typeof parsed === 'object' && parsed.success === true
        ? { success: false, outcome: 'unknown', error: '提交结果暂未确认。请保留原请求编号核对状态，勿创建新请求重复操作。' } : undefined));
      const headers = { ...response.headers() }; delete headers['content-length']; delete headers['content-encoding'];
      await route.fulfill({ response, headers, body: patched });
    });
    await fields.submit.click();
    await page.getByTestId('pending-original-request').waitFor({ timeout: 120_000 });
    const pendingJson = JSON.parse((await page.getByTestId('pending-original-input').textContent()) ?? '{}');
    const requestId = pendingJson.requestId;
    await page.waitForTimeout(4_000);
    const stored = await storage(page);
    const pendingKey = Object.keys(stored).find((key) => key.startsWith('catalog:pending-request:v3:'));
    const draftKey = Object.keys(stored).find((key) => key.startsWith('catalog:edit-state:v3:'));
    await rec.shot(page, 'unknown-lost');
    expect('unknown-lost/pending-kept+same-request', Boolean(requestId) && Boolean(pendingKey) && submitted === 1,
      { requestId, pendingKey, draftKey, submitted });
    expect('unknown-lost/committed-once', Boolean(await auditByRequest(requestId)), { requestId });
    // check-only: read-only receipt lookup finds the committed write and never re-sends
    await page.unroute('**/*');
    const revisionBeforeCheck = (await itemByCode(codes.unknownLost)).revision;
    const auditBeforeCheck = (await db.query('SELECT count(*)::int n FROM catalog.audit_event WHERE item_id=$1', [state.item_id])).rows[0].n;
    await page.getByTestId('catalog-check-original').click();
    const checkMessage = await waitStatus(page, (text) => /已核实原请求已保存/.test(text));
    const revisionAfterCheck = (await itemByCode(codes.unknownLost)).revision;
    const auditAfterCheck = (await db.query('SELECT count(*)::int n FROM catalog.audit_event WHERE item_id=$1', [state.item_id])).rows[0].n;
    const pendingAfterCheck = await page.getByTestId('pending-original-request').count();
    const storageAfterCheck = await storage(page);
    const pendingKeyAfterCheck = Object.keys(storageAfterCheck).some((key) => key.startsWith('catalog:pending-request:v3:'));
    const revisionsAfterCheck = await revisionRows(state.item_id);
    await rec.shot(page, 'unknown-lost-applied');
    expect('unknown-lost/check-read-only-applied',
      revisionAfterCheck === revisionBeforeCheck && auditAfterCheck === auditBeforeCheck
      && /已核实原请求已保存/.test(checkMessage) && pendingAfterCheck === 0 && !pendingKeyAfterCheck
      && revisionsAfterCheck.length === state.revision + 1,
      { requestId, revisionBeforeCheck, revisionAfterCheck, auditBeforeCheck, auditAfterCheck, checkMessage, pendingAfterCheck, pendingKeyAfterCheck, revisions: revisionsAfterCheck.length });
    rec.record('unknown-lost', { requestId, submitted, pendingKey, draftKey, revisionBeforeCheck, revisionAfterCheck, auditBeforeCheck, auditAfterCheck, checkMessage, pendingAfterCheck, pendingKeyAfterCheck });
  }

  /* ---------- 5. unknown: not submitted ---------- */
  {
    const state = await itemByCode(codes.unknownNotSubmitted);
    await page.goto('/dashboard/catalog');
    await openDetailByCode(page, codes.unknownNotSubmitted);
    await page.getByRole('button', { name: '编辑资料', exact: true }).click();
    await page.getByTestId('catalog-detail-edit').waitFor({ timeout: 60_000 });
    fields = await fillDraft(page, { value: `V3-UNKNOWN-NOT-${tag}`, evidence: 'fixture:v3:unknown-not', reason: `V3 unknown not ${tag}` });
    await page.route('**/*', async (route) => {
      const request = route.request();
      if (request.method() !== 'POST') return route.fallback();
      const postData = request.postData() ?? '';
      if (!postData.includes(state.item_id) || !postData.includes('"fields"')) return route.fallback();
      const parsed = JSON.parse(postData);
      const requestId = parsed?.[0]?.requestId ?? null;
      const body = `0:{"a":"$@1","f":"","q":"","i":false,"b":"v3-fixture"}\n1:${JSON.stringify({ success: false, outcome: 'unknown', error: '提交结果暂未确认。请保留原请求编号核对状态，勿创建新请求重复操作。' })}\n`;
      await route.fulfill({ status: 200, headers: { 'content-type': 'text/x-component' }, body });
      void requestId;
    });
    await fields.submit.click();
    await page.getByTestId('pending-original-request').waitFor({ timeout: 120_000 });
    const requestId = JSON.parse((await page.getByTestId('pending-original-input').textContent()) ?? '{}').requestId;
    const revisionBefore = (await itemByCode(codes.unknownNotSubmitted)).revision;
    await page.unroute('**/*');
    await page.getByTestId('catalog-check-original').click();
    const checkMessage = await waitStatus(page, (text) => /未找到原请求回执/.test(text));
    const revisionsAfterCheck = await revisionRows(state.item_id);
    const auditAfterCheck = await auditByRequest(requestId);
    await rec.shot(page, 'unknown-not-submitted');
    expect('unknown-not/check-no-write', revisionsAfterCheck.length === state.revision && !auditAfterCheck && (await itemByCode(codes.unknownNotSubmitted)).revision === revisionBefore,
      { requestId, checkMessage, revisions: revisionsAfterCheck.length, auditAfterCheck });
    expect('unknown-not/not-claimed-unsubmitted', /未找到原请求回执/.test(checkMessage) && /不等于尚未提交/.test(checkMessage)
      && !/从未提交|没有提交/.test(checkMessage), { checkMessage });
    // explicit retry submits with the same request id
    await page.getByTestId('catalog-retry-original').click();
    await waitStatus(page, (text) => /已保存|保存/.test(text));
    const auditAfterRetry = await auditByRequest(requestId);
    const revisionsAfterRetry = await revisionRows(state.item_id);
    expect('unknown-not/retry-same-id-writes-once', Boolean(auditAfterRetry) && revisionsAfterRetry.length === state.revision + 1,
      { requestId, auditAfterRetry: Boolean(auditAfterRetry), revisions: revisionsAfterRetry.length });
    rec.record('unknown-not', { requestId, revisionBefore, checkMessage, revisionsAfterRetry: revisionsAfterRetry.length, auditAfterRetry: Boolean(auditAfterRetry) });
  }

  /* ---------- 6. no receipt + check failure (same pending request) ---------- */
  {
    const state = await itemByCode('WM0072');
    await page.goto('/dashboard/catalog');
    await openDetailByCode(page, 'WM0072');
    await page.getByRole('button', { name: '编辑资料', exact: true }).click();
    await page.getByTestId('catalog-detail-edit').waitFor({ timeout: 60_000 });
    fields = await fillDraft(page, { value: `V3-NORECEIPT-${tag}`, evidence: 'fixture:v3:noreceipt', reason: `V3 no receipt ${tag}` });
    // submit never reaches the server: connection failure leaves an unknown/pending state
    await page.route('**/*', (route) => {
      const request = route.request();
      if (request.method() !== 'POST') return route.fallback();
      const postData = request.postData() ?? '';
      if (!postData.includes(state.item_id) || !postData.includes('"fields"')) return route.fallback();
      return route.abort('failed');
    });
    await fields.submit.click();
    await page.getByTestId('pending-original-request').waitFor({ timeout: 120_000 });
    const requestId = JSON.parse((await page.getByTestId('pending-original-input').textContent()) ?? '{}').requestId;
    await page.unroute('**/*');
    // check failure: patch the check action response to a failure
    let checkAttempts = 0;
    await page.route('**/*', async (route) => {
      const request = route.request();
      if (request.method() !== 'POST') return route.fallback();
      const postData = request.postData() ?? '';
      if (!postData.includes(requestId) || postData.includes('"fields"')) return route.fallback();
      checkAttempts += 1;
      const response = await route.fetch();
      const text = await response.text();
      const patched = patchFlightBody(text, (parsed) => (parsed && typeof parsed === 'object' && 'success' in parsed
        ? { success: false, error: '核对失败（隔离注入）' } : undefined));
      const headers = { ...response.headers() }; delete headers['content-length']; delete headers['content-encoding'];
      await route.fulfill({ response, headers, body: patched });
    });
    await page.getByTestId('catalog-check-original').click();
    const failMessage = await waitStatus(page, (text) => /核对未完成/.test(text));
    const pendingStillThere = await page.getByTestId('pending-original-request').count();
    const storageAfter = await storage(page);
    const pendingKeyStill = Object.keys(storageAfter).some((key) => key.startsWith('catalog:pending-request:v3:'));
    await rec.shot(page, 'check-failed');
    expect('check-failed/pending-retained', checkAttempts >= 1 && pendingStillThere === 1 && pendingKeyStill, { checkAttempts, pendingStillThere, pendingKeyStill, failMessage });
    await page.unroute('**/*');
    // no receipt path: retry writes with the same id and then check reports applied
    await page.getByTestId('catalog-retry-original').click();
    await waitStatus(page, (text) => /已保存|保存/.test(text));
    const audit = await auditByRequest(requestId);
    expect('no-receipt/retry-then-applied', Boolean(audit), { requestId, audit: Boolean(audit) });
    rec.record('check-failed-no-receipt', { requestId, checkAttempts, failMessage, pendingStillThere, audit: Boolean(audit) });
  }
  await context.close();
} finally {
  await browser.close();
  await db.end();
}
const result = summary();
rec.finish(result);
console.log(JSON.stringify({ suite: 'v3-04-edit-matrix', runId, ...result, evidence: rec.file }, null, 2));
process.exitCode = result.pass ? 0 : 1;
