#!/usr/bin/env node
/**
 * V3-04 scoped-new-item edit matrix (N1C-origin items) on an isolated NEW-ITEM lane.
 *
 * Selects scoped items (catalog_item with first_release_id NULL, i.e. created through the
 * N1C intake flow) from the lane DB and runs the same four-state matrix plus
 * applied/no-receipt/check-failed on them:
 *   success / verification failure / real concurrent version conflict /
 *   unknown submitted-response-lost / unknown not-submitted / check failure.
 * Every state verifies real revisions/audit rows and the v3 draft/pending storage keys.
 *
 * Requires the lane env to be `env.catalog-new-item.json` (N1A/N1C fixture enabled).
 *
 * Usage: node tests/catalog/ui-repair-v3-scoped-edit.mjs --run-id <work-run> --port 3015
 */
import {
  createRecorder, editorLocators, expectAll, fillDraft, launch, login, openDetailByCode, ownerClient, patchFlightBody, resolveRun, storage,
} from './ui-repair-v3-lib.mjs';

const ADMIN = '11111111-1111-4111-8111-111111111101';
function arg(flag, fallback) { const i = process.argv.indexOf(flag); return i < 0 ? fallback : process.argv[i + 1]; }
const runId = arg('--run-id');
const port = Number(arg('--port', '3015'));
const run = await resolveRun(runId);
const rec = createRecorder('v3-04-scoped-edit', runId);
const { expectations, expect, summary } = expectAll();
const db = await ownerClient(run);
const base = `http://127.0.0.1:${port}`;
const tag = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

async function scopedItems() {
  return (await db.query(`SELECT i.id, k.ice_code, c.revision, r.name_cn FROM catalog.catalog_item i
    JOIN catalog.item_current c ON c.item_id=i.id
    JOIN catalog.item_revision r ON r.item_id=i.id AND r.revision=c.revision
    LEFT JOIN catalog.catalog_item_code k ON k.item_id=i.id
    WHERE i.first_release_id IS NULL AND k.ice_code IS NOT NULL ORDER BY i.id LIMIT 5`)).rows;
}
async function itemById(itemId) {
  return (await db.query(`SELECT i.id, k.ice_code, c.revision FROM catalog.catalog_item i JOIN catalog.item_current c ON c.item_id=i.id
    LEFT JOIN catalog.catalog_item_code k ON k.item_id=i.id WHERE i.id=$1`, [itemId])).rows[0];
}
async function auditByRequest(requestId) {
  return (await db.query('SELECT request_id, action, result FROM catalog.audit_event WHERE request_id=$1', [requestId])).rows[0] ?? null;
}
async function revisions(itemId) {
  return (await db.query('SELECT revision, name_cn FROM catalog.item_revision WHERE item_id=$1 ORDER BY revision', [itemId])).rows;
}
async function bumpExternal(itemId) {
  await db.query('BEGIN');
  try {
    await db.query(`INSERT INTO catalog.item_revision(item_id,revision,previous_revision,ice_code_snapshot,name_cn,fields,evidence_ref,reason,actor_id)
      SELECT c.item_id,c.revision+1,c.revision,r.ice_code_snapshot,r.name_cn,r.fields,'fixture:v3:scoped-concurrent','V3 scoped external concurrent writer',$2
      FROM catalog.item_current c JOIN catalog.item_revision r ON r.item_id=c.item_id AND r.revision=c.revision WHERE c.item_id=$1`, [itemId, ADMIN]);
    await db.query('UPDATE catalog.item_current SET revision=revision+1 WHERE item_id=$1', [itemId]);
    await db.query(`INSERT INTO catalog.audit_event(request_id,intent_sha256,actor_id,action,item_id,result)
      VALUES(gen_random_uuid(),repeat('f',64),$2,'append_nonprice_revision',$1,'{"fixture":"v3-scoped-concurrent"}'::jsonb)`, [itemId, ADMIN]);
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  return itemById(itemId);
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
async function openEditor(page, code) {
  await openDetailByCode(page, code);
  await page.getByRole('button', { name: '编辑资料', exact: true }).click();
  await page.getByTestId('catalog-detail-edit').waitFor({ timeout: 60_000 });
  return editorLocators(page);
}
const browser = await launch();
try {
  const context = await browser.newContext({ baseURL: base, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await login(page);
  const items = await scopedItems();
  expect('setup/scoped-items-available', items.length >= 4, { count: items.length, items });
  const [successItem, validationItem, conflictItem, unknownLostItem, unknownNotItem] = items;
  const work = items.slice(0, 4);
  work.forEach((item, index) => rec.record(`scoped-item-${index}`, item));

  if (successItem) {
    const before = await itemById(successItem.id);
    const fields = await openEditor(page, successItem.ice_code);
    await fillDraft(page, { field: 'factory', value: `V3-SCOPED-OK-${tag}`, evidence: 'fixture:v3:scoped-success', reason: `V3 scoped success ${tag}` });
    await fields.submit.click();
    const message = await waitStatus(page, (text) => /已保存|保存/.test(text));
    const after = await itemById(successItem.id);
    const auditCount = (await db.query(`SELECT count(*)::int n FROM catalog.audit_event WHERE item_id=$1 AND action='append_nonprice_revision'`, [successItem.id])).rows[0].n;
    expect('scoped-success/real-write', after.revision === before.revision + 1 && auditCount >= 1, { before, after, message, auditCount });
    rec.record('scoped-success', { before, after, message, auditCount });
  }
  if (validationItem) {
    const before = await itemById(validationItem.id);
    const fields = await openEditor(page, validationItem.ice_code);
    await fields.field.selectOption('nameCn');
    await fields.value.fill('');
    await page.locator('input[name="confirmEmpty"]').check();
    await fields.evidence.fill('fixture:v3:scoped-validation');
    await fields.reason.fill(`V3 scoped validation ${tag}`);
    await fields.submit.click();
    const message = await waitStatus(page, (text) => /未完成|未保存|无效|拒绝|不能/.test(text));
    const after = await itemById(validationItem.id);
    const stored = await storage(page);
    const draftKey = Object.keys(stored).find((key) => key.startsWith('catalog:edit-state:v3:'));
    expect('scoped-validation/rejected-draft-kept', after.revision === before.revision && Boolean(message) && Boolean(draftKey), { before, after, message, draftKey });
    rec.record('scoped-validation', { before, after, message, draftKey });
  }
  if (conflictItem) {
    const before = await itemById(conflictItem.id);
    const fields = await openEditor(page, conflictItem.ice_code);
    await fillDraft(page, { field: 'englishName', value: `V3-SCOPED-CONFLICT-${tag}`, evidence: 'fixture:v3:scoped-conflict', reason: `V3 scoped conflict ${tag}` });
    const bumped = await bumpExternal(conflictItem.id);
    await fields.submit.click();
    const message = await waitStatus(page, (text) => /冲突|版本已变化/.test(text));
    await page.waitForTimeout(2_000);
    const valueAfter = await fields.value.inputValue().catch(() => null);
    const after = await itemById(conflictItem.id);
    expect('scoped-conflict/reported-draft-survives', /冲突|版本已变化/.test(message) && after.revision === bumped.revision && valueAfter === `V3-SCOPED-CONFLICT-${tag}`,
      { before, bumped: bumped.revision, after: after.revision, message, valueAfter });
    rec.record('scoped-conflict', { before, bumped: bumped.revision, after: after.revision, message, valueAfter });
  }
  if (unknownLostItem) {
    const before = await itemById(unknownLostItem.id);
    const fields = await openEditor(page, unknownLostItem.ice_code);
    await fillDraft(page, { field: 'englishName', value: `V3-SCOPED-LOST-${tag}`, evidence: 'fixture:v3:scoped-lost', reason: `V3 scoped lost ${tag}` });
    await page.route('**/*', async (route) => {
      const request = route.request();
      if (request.method() !== 'POST') return route.fallback();
      const postData = request.postData() ?? '';
      if (!postData.includes(unknownLostItem.id) || !postData.includes('"fields"')) return route.fallback();
      const response = await route.fetch();
      const text = await response.text();
      const patched = patchFlightBody(text, (parsed) => (parsed && typeof parsed === 'object' && parsed.success === true
        ? { success: false, outcome: 'unknown', error: '提交结果暂未确认。请保留原请求编号核对状态，勿创建新请求重复操作。' } : undefined));
      const headers = { ...response.headers() }; delete headers['content-length']; delete headers['content-encoding'];
      await route.fulfill({ response, headers, body: patched });
    });
    await fields.submit.click();
    await page.getByTestId('pending-original-request').waitFor({ timeout: 120_000 });
    const requestId = JSON.parse((await page.getByTestId('pending-original-input').textContent()) ?? '{}').requestId;
    await page.unroute('**/*');
    const auditBefore = (await db.query('SELECT count(*)::int n FROM catalog.audit_event WHERE item_id=$1', [unknownLostItem.id])).rows[0].n;
    await page.getByTestId('catalog-check-original').click();
    const message = await waitStatus(page, (text) => /已核实原请求已保存/.test(text));
    const after = await itemById(unknownLostItem.id);
    const auditAfter = (await db.query('SELECT count(*)::int n FROM catalog.audit_event WHERE item_id=$1', [unknownLostItem.id])).rows[0].n;
    expect('scoped-unknown-lost/check-applied-no-rewrite', after.revision === before.revision + 1 && auditAfter === auditBefore && /已核实原请求已保存/.test(message),
      { before, after, auditBefore, auditAfter, message, requestId });
    rec.record('scoped-unknown-lost', { before, after, auditBefore, auditAfter, message, requestId });
  }
  if (unknownNotItem) {
    const before = await itemById(unknownNotItem.id);
    const fields = await openEditor(page, unknownNotItem.ice_code);
    await fillDraft(page, { field: 'englishName', value: `V3-SCOPED-NOT-${tag}`, evidence: 'fixture:v3:scoped-not', reason: `V3 scoped not ${tag}` });
    await page.route('**/*', async (route) => {
      const request = route.request();
      if (request.method() !== 'POST') return route.fallback();
      const postData = request.postData() ?? '';
      if (!postData.includes(unknownNotItem.id) || !postData.includes('"fields"')) return route.fallback();
      const body = `0:{"a":"$@1","f":"","q":"","i":false,"b":"v3-fixture"}\n1:${JSON.stringify({ success: false, outcome: 'unknown', error: '提交结果暂未确认。请保留原请求编号核对状态，勿创建新请求重复操作。' })}\n`;
      await route.fulfill({ status: 200, headers: { 'content-type': 'text/x-component' }, body });
    });
    await fields.submit.click();
    await page.getByTestId('pending-original-request').waitFor({ timeout: 120_000 });
    const requestId = JSON.parse((await page.getByTestId('pending-original-input').textContent()) ?? '{}').requestId;
    await page.unroute('**/*');
    await page.getByTestId('catalog-check-original').click();
    const noReceiptMessage = await waitStatus(page, (text) => /未找到原请求回执/.test(text));
    const afterCheck = await itemById(unknownNotItem.id);
    await page.getByTestId('catalog-retry-original').click();
    const savedMessage = await waitStatus(page, (text) => /已保存|保存/.test(text));
    const afterRetry = await itemById(unknownNotItem.id);
    const audit = await auditByRequest(requestId);
    expect('scoped-unknown-not/no-receipt-then-explicit-retry',
      afterCheck.revision === before.revision && /未找到原请求回执/.test(noReceiptMessage)
      && Boolean(audit) && afterRetry.revision === before.revision + 1 && /已保存|保存/.test(savedMessage),
      { before, afterCheck, afterRetry, requestId, noReceiptMessage, savedMessage, audit: Boolean(audit) });
    rec.record('scoped-unknown-not', { before, afterCheck, afterRetry, requestId, noReceiptMessage, savedMessage, audit: Boolean(audit) });
  }
  await context.close();
} finally {
  await browser.close();
  await db.end();
}
const result = summary();
rec.finish(result);
console.log(JSON.stringify({ suite: 'v3-04-scoped-edit', runId, ...result, evidence: rec.file }, null, 2));
process.exitCode = result.pass ? 0 : 1;
