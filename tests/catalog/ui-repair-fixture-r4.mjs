#!/usr/bin/env node
/**
 * R4 acceptance lane — edit four states against an ISOLATED preview fixture run.
 *
 * States: success / validation failure / version conflict / unknown outcome.
 * Also checks: draft retained on failure, draft restored after browser back,
 * commit receipt kept on unknown (no automatic re-send, no new request id),
 * history projection refreshed after success (modal + direct link).
 *
 * Usage:
 *   node tests/catalog/ui-repair-fixture-r4.mjs --run-id <fixture-run> --port 3012
 */
import {
  baseUrl, captureActionId, createRecorder, launch, newLoggedInPage, ownerClient, patchFlightBody, resolveRun, safeName,
} from './ui-repair-fixture-lib.mjs';

const ADMIN = '11111111-1111-4111-8111-111111111101';
function arg(flag, fallback) { const index = process.argv.indexOf(flag); return index < 0 ? fallback : process.argv[index + 1]; }
const runId = arg('--run-id');
const port = Number(arg('--port', '3012'));
const uiMode = String(arg('--mode', 'direct')).toLowerCase() === 'dialog' ? 'dialog' : 'direct';
const tag = arg('--tag', new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'));
const run = await resolveRun(runId);
const rec = createRecorder(`r4-${tag}`, runId);
const base = baseUrl(port);
const db = await ownerClient(run);
await db.connect();

const expectations = [];
function expect(name, condition, detail) {
  expectations.push({ name, pass: Boolean(condition), detail });
  return Boolean(condition);
}

async function itemByCode(code) {
  const rows = (await db.query(`SELECT k.item_id, c.revision, r.name_cn, r.ice_code_snapshot
    FROM catalog.catalog_item_code k JOIN catalog.item_current c ON c.item_id=k.item_id
    JOIN catalog.item_revision r ON r.item_id=k.item_id AND r.revision=c.revision WHERE k.ice_code=$1`, [code])).rows;
  return rows[0];
}
async function auditCount(requestId) {
  return (await db.query('SELECT count(*)::int n FROM catalog.audit_event WHERE request_id=$1', [requestId])).rows[0].n;
}
async function latestRevisionRows(itemId) {
  return (await db.query(`SELECT revision, name_cn, fields, evidence_ref, reason FROM catalog.item_revision WHERE item_id=$1 ORDER BY revision DESC`, [itemId])).rows;
}
async function externalConcurrentRevision(itemId) {
  await db.query('BEGIN');
  try {
    await db.query(`INSERT INTO catalog.item_revision(item_id,revision,previous_revision,ice_code_snapshot,name_cn,fields,evidence_ref,reason,actor_id)
      SELECT c.item_id, c.revision+1, c.revision, r.ice_code_snapshot, r.name_cn, r.fields, 'fixture:r4:concurrent-writer', 'FIXTURE R4 external concurrent writer', $2
      FROM catalog.item_current c JOIN catalog.item_revision r ON r.item_id=c.item_id AND r.revision=c.revision WHERE c.item_id=$1`, [itemId, ADMIN]);
    await db.query('UPDATE catalog.item_current SET revision=revision+1 WHERE item_id=$1', [itemId]);
    await db.query(`INSERT INTO catalog.audit_event(request_id,intent_sha256,actor_id,action,item_id,result)
      VALUES(gen_random_uuid(), repeat('f',64), $2, 'append_nonprice_revision', $1, '{"fixture":"r4-concurrent"}'::jsonb)`, [itemId, ADMIN]);
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  return itemByCode('WM0041');
}

async function openDetailByCode(page, code, { viaDirectLink = uiMode === 'direct' } = {}) {
  if (viaDirectLink) {
    const item = await itemByCode(code);
    await page.goto(`/dashboard/catalog/${item.item_id}`);
  } else {
    await page.goto('/dashboard/catalog');
    await page.getByTestId('catalog-counts').waitFor({ timeout: 120_000 });
    await page.getByLabel(/搜索/).fill(code);
    const row = page.getByTestId(`catalog-row-${code}`);
    await row.waitFor({ timeout: 120_000 });
    await row.getByRole('button', { name: '查看详情' }).click();
  }
  await page.getByTestId('catalog-detail-core-ready').waitFor({ timeout: 120_000 });
}
async function enterEdit(page) {
  await page.getByRole('button', { name: '编辑资料', exact: true }).click();
  await page.getByTestId('catalog-detail-edit').waitFor({ timeout: 30_000 });
}
function editorFields(page) {
  return {
    field: page.locator('select[name="field"]'),
    value: page.locator('input[name="fieldValue"]'),
    evidence: page.locator('input[name="evidenceRef"]'),
    reason: page.locator('input[name="revisionReason"]'),
    empty: page.locator('input[name="confirmEmpty"]'),
    submit: page.getByRole('button', { name: '保存非价格修订', exact: true }),
    status: page.locator('section[aria-label="补充资料"] p[role="status"]').first(),
  };
}
async function fillRevision(page, { field = 'englishName', value = '', evidence = 'fixture:r4', reason = 'R4 fixture write', confirmEmpty = false } = {}) {
  const fields = editorFields(page);
  await fields.field.selectOption(field);
  if (value) await fields.value.fill(value); else await fields.value.fill('');
  if (confirmEmpty) await fields.empty.check();
  await fields.evidence.fill(evidence);
  await fields.reason.fill(reason);
  return fields;
}
async function storageState(page, itemId) {
  return page.evaluate((key) => {
    const raw = window.sessionStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  }, `catalog:edit-state:${itemId}`);
}
async function mountMarker(page) {
  const el = page.getByTestId('catalog-detail-edit');
  const marker = `mount-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  await el.evaluate((node, value) => node.setAttribute('data-fixture-mount', value), marker);
  return marker;
}

const browser = await launch();
try {
  /* ---------------- 1. success ---------------- */
  {
    const state = await itemByCode('WM0043');
    const beforeRevision = state.revision;
    const value = `FIXTURE-R4-SUCCESS-${tag}`;
    const { context, page } = await newLoggedInPage(browser, base);
    await openDetailByCode(page, 'WM0043');
    await enterEdit(page);
    const fields = await fillRevision(page, { field: 'nameCn', value, evidence: 'fixture:r4:success', reason: `R4 success ${tag}` });
    await fields.submit.click();
    await page.getByText('资料修订已保存；旧版本和采用价格保持').waitFor({ timeout: 120_000 });
    await rec.shot(page, 'r4-success-saved');
    const rows = await latestRevisionRows(state.item_id);
    const latest = rows[0];
    const audit = (await db.query(`SELECT request_id, action, result FROM catalog.audit_event WHERE item_id=$1 AND action='append_nonprice_revision' ORDER BY recorded_at DESC LIMIT 1`, [state.item_id])).rows[0];
    expect('R4-success/real-write', Number(latest.revision) === beforeRevision + 1 && latest.name_cn === value,
      { beforeRevision, latestRevision: latest.revision, latestName: latest.name_cn, requestId: audit?.request_id });
    expect('R4-success/audit-projection', Boolean(audit) && audit.result?.revision === latest.revision, audit);
    // history is refreshed in the open modal
    await page.getByTestId('catalog-tab-history').click();
    await page.getByTestId('catalog-history-list').waitFor({ timeout: 60_000 });
    const modalHistory = await page.getByTestId(`revision-history-${latest.revision}`).count();
    // direct link must not serve a stale history projection
    const direct = await context.newPage();
    await direct.goto(`/dashboard/catalog/${state.item_id}`);
    await direct.getByTestId('catalog-detail-core-ready').waitFor({ timeout: 120_000 });
    const directCoreRevision = (await direct.getByTestId('catalog-detail-version').textContent() ?? '').trim();
    await direct.getByTestId('catalog-tab-history').click();
    await direct.getByTestId('catalog-history-list').waitFor({ timeout: 60_000 });
    const directHistory = await direct.getByTestId(`revision-history-${latest.revision}`).count();
    const directLatestMeta = await direct.getByTestId('revision-reason').first().textContent().catch(() => null);
    expect('R4-success/history-modal-fresh', modalHistory === 1, { modalHistory, expectedRevision: latest.revision });
    expect('R4-success/history-direct-fresh', directHistory === 1 && directCoreRevision === String(latest.revision),
      { directHistory, directCoreRevision, directLatestMeta, expectedRevision: latest.revision });
    // list projection after leaving the detail must show the new name
    if (uiMode === 'dialog') await page.getByLabel('关闭商品详情').click();
    await page.goto('/dashboard/catalog');
    await page.getByTestId('catalog-counts').waitFor({ timeout: 120_000 });
    await page.getByLabel(/搜索/).fill('WM0043');
    const row = page.getByTestId('catalog-row-WM0043');
    await row.waitFor({ timeout: 120_000 });
    const rowText = await row.textContent();
    expect('R4-success/list-detail-consistent', (rowText ?? '').includes(value), { rowText: (rowText ?? '').slice(0, 200) });
    rec.record('success', { beforeRevision, latestRevision: latest.revision, modalHistory, directHistory, directCoreRevision, rowMatched: (rowText ?? '').includes(value), audit });
    await direct.close();
    await context.close();
  }

  /* ---------------- 2. validation failure ---------------- */
  {
    const state = await itemByCode('WM0042');
    const beforeRevision = state.revision;
    const { context, page } = await newLoggedInPage(browser, base);
    await openDetailByCode(page, 'WM0042');
    await enterEdit(page);
    const fields = await fillRevision(page, { field: 'nameCn', value: '', evidence: 'fixture:r4:validation', reason: `R4 validation ${tag}`, confirmEmpty: true });
    const marker = await mountMarker(page);
    await fields.submit.click();
    const message = await (async () => {
      const started = Date.now();
      while (Date.now() - started < 90_000) {
        const text = (await fields.status.textContent().catch(() => '')) ?? '';
        if (text && !text.includes('正在核对')) return text;
        await page.waitForTimeout(250);
      }
      return '';
    })();
    const after = await itemByCode('WM0042');
    const draftFields = {
      field: await fields.field.inputValue(),
      confirmedEmpty: await fields.empty.isChecked(),
      evidence: await fields.evidence.inputValue(),
      reason: await fields.reason.inputValue(),
    };
    const mountStillThere = await page.getByTestId('catalog-detail-edit').getAttribute('data-fixture-mount');
    const stored = await storageState(page, state.item_id);
    await rec.shot(page, 'r4-validation-failure');
    expect('R4-validation/server-rejected', after.revision === beforeRevision && /操作未完成|未保存|不能|无效/.test(message),
      { beforeRevision, afterRevision: after.revision, message });
    expect('R4-validation/draft-retained', mountStillThere === marker && draftFields.field === 'nameCn' && draftFields.confirmedEmpty
      && draftFields.evidence === 'fixture:r4:validation' && draftFields.reason === `R4 validation ${tag}` && Boolean(stored),
      { mountStillThere, marker, draftFields, stored: Boolean(stored) });
    rec.record('validation', { beforeRevision, afterRevision: after.revision, message, draftFields, stored: Boolean(stored) });
    await context.close();
  }

  /* ---------------- 3. version conflict ---------------- */
  {
    const state = await itemByCode('WM0041');
    const beforeRevision = state.revision;
    const value = `FIXTURE-R4-CONFLICT-${tag}`;
    const { context, page } = await newLoggedInPage(browser, base);
    await openDetailByCode(page, 'WM0041');
    await enterEdit(page);
    const fields = await fillRevision(page, { field: 'englishName', value, evidence: 'fixture:r4:conflict', reason: `R4 conflict ${tag}` });
    // capture the append action id for the unknown-outcome step below
    const appendProbe = await captureActionId(page, { onAction: () => true, timeout: 1 }).catch(() => null);
    void appendProbe;
    const marker = await mountMarker(page);
    const bumped = await externalConcurrentRevision(state.item_id);
    await fields.submit.click();
    const message = await (async () => {
      const started = Date.now();
      while (Date.now() - started < 90_000) {
        const text = (await fields.status.textContent().catch(() => '')) ?? '';
        if (text && !text.includes('正在核对') && !text.includes('正在')) return text;
        await page.waitForTimeout(250);
      }
      return '';
    })();
    // wait for the router.refresh round-trip that the implementation still performs on failure
    await page.waitForTimeout(4_000);
    const editorStillMounted = await page.getByTestId('catalog-detail-edit').count();
    const mountAfter = await page.getByTestId('catalog-detail-edit').getAttribute('data-fixture-mount').catch(() => null);
    const draftAfter = {
      value: await fields.value.inputValue().catch(() => null),
      evidence: await fields.evidence.inputValue().catch(() => null),
      reason: await fields.reason.inputValue().catch(() => null),
    };
    const stored = await storageState(page, state.item_id);
    const after = await itemByCode('WM0041');
    await rec.shot(page, 'r4-version-conflict');
    expect('R4-conflict/reported', /冲突|版本已变化/.test(message) && after.revision === bumped.revision,
      { message, beforeRevision, bumpedRevision: bumped.revision, afterRevision: after.revision });
    expect('R4-conflict/draft-survives-refresh', editorStillMounted === 1 && mountAfter === marker
      && draftAfter.value === value && draftAfter.evidence === 'fixture:r4:conflict' && Boolean(stored),
      { editorStillMounted, mountAfter, marker, draftAfter, stored: Boolean(stored) });
    rec.record('conflict', { beforeRevision, bumpedRevision: bumped.revision, message, mountAfter, marker, draftAfter, stored: Boolean(stored) });
    await context.close();
  }

  /* ---------------- 4. unknown outcome (committed, response lost) ---------------- */
  {
    const state = await itemByCode('WM0040');
    const beforeRevision = state.revision;
    const value = `FIXTURE-R4-UNKNOWN-${tag}`;
    const { context, page } = await newLoggedInPage(browser, base);
    await openDetailByCode(page, 'WM0040');
    await enterEdit(page);
    const fields = await fillRevision(page, { field: 'englishName', value, evidence: 'fixture:r4:unknown', reason: `R4 unknown ${tag}` });
    // discover the append action id from a real (intercepted) submit
    let appendActionId = null;
    const requestIds = [];
    const posts = [];
    await page.route('**/*', async (route) => {
      const request = route.request();
      if (request.method() !== 'POST') return route.fallback();
      const actionId = request.headers()['next-action'];
      if (!actionId) return route.fallback();
      const postData = request.postData() ?? '';
      if (!appendActionId) {
        if (!/appendNonPriceRevision|"reason"|revisionReason/.test(postData) && !postData.includes(state.item_id)) return route.fallback();
        appendActionId = actionId;
      }
      if (actionId !== appendActionId) return route.fallback();
      posts.push({ at: new Date().toISOString(), actionId, body: postData.slice(0, 400) });
      const uuid = postData.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      if (uuid) requestIds.push(uuid[0]);
      const response = await route.fetch();
      const text = await response.text();
      const patched = patchFlightBody(text, (parsed) => {
        if (parsed && typeof parsed === 'object' && parsed.success === true) {
          return { success: false, outcome: 'unknown', error: '提交结果暂未确认。请保留原请求编号核对状态，勿创建新请求重复操作。' };
        }
        return undefined;
      });
      const headers = { ...response.headers() };
      delete headers['content-length'];
      delete headers['content-encoding'];
      await route.fulfill({ response, headers, body: patched });
    });
    await fields.submit.click();
    await page.getByTestId('pending-original-request').waitFor({ timeout: 120_000 });
    const pendingText = await page.getByTestId('pending-original-input').textContent();
    const pendingJson = JSON.parse(pendingText ?? '{}');
    const statusMessage = (await fields.status.textContent().catch(() => '')) ?? '';
    await page.waitForTimeout(5_000); // must not auto-resend
    const postsAfterWait = posts.length;
    const draftAfter = {
      value: await fields.value.inputValue().catch(() => null),
      evidence: await fields.evidence.inputValue().catch(() => null),
      reason: await fields.reason.inputValue().catch(() => null),
    };
    const stored = await storageState(page, state.item_id);
    await rec.shot(page, 'r4-unknown-outcome');
    const committedRows = (await latestRevisionRows(state.item_id)).filter((row) => Number(row.revision) > beforeRevision);
    const committed = committedRows.find((row) => JSON.stringify(row.fields).includes(value));
    const originalRequestId = pendingJson.requestId ?? null;
    const auditForRequest = originalRequestId ? await auditCount(originalRequestId) : 0;
    expect('R4-unknown/marked-unknown-not-unsaved', /暂未确认/.test(statusMessage) && Boolean(pendingJson.requestId)
      && pendingJson.reason === `R4 unknown ${tag}`, { statusMessage, pendingJson });
    expect('R4-unknown/kept-original-request', originalRequestId && committed && auditForRequest === 1,
      { originalRequestId, committedRevision: committed?.revision, auditForRequest, committedRowsCount: committedRows.length });
    expect('R4-unknown/no-auto-resend', postsAfterWait === 1, { postsAfterWait, posts });
    expect('R4-unknown/draft-retained', draftAfter.value === value && draftAfter.evidence === 'fixture:r4:unknown' && Boolean(stored),
      { draftAfter, stored: Boolean(stored) });
    // The unknown-response interception is removed for the manual reconcile: the lane now
    // observes the real recovery path. For baseline items recovery re-sends the SAME request id
    // (never a new one); the write must stay single.
    await page.unroute('**/*');
    const reconcilePosts = [];
    page.on('request', (request) => {
      if (request.method() !== 'POST') return;
      const actionId = request.headers()['next-action'];
      if (!actionId || actionId !== appendActionId) return;
      const body = request.postData() ?? '';
      reconcilePosts.push({ actionId, bodyHead: body.slice(0, 220) });
    });
    await page.getByRole('button', { name: '核对/重试原请求' }).click();
    const reconciled = await (async () => {
      const started = Date.now();
      while (Date.now() - started < 90_000) {
        if (await page.getByTestId('pending-original-request').count() === 0) return true;
        await page.waitForTimeout(250);
      }
      return false;
    })();
    const reconcileMessage = (await fields.status.textContent().catch(() => '')) ?? '';
    const rowsAfterReconcile = (await latestRevisionRows(state.item_id)).filter((row) => JSON.stringify(row.fields).includes(value));
    const auditAfterReconcile = originalRequestId ? await auditCount(originalRequestId) : 0;
    const storedAfterReconcile = await storageState(page, state.item_id);
    await rec.shot(page, 'r4-unknown-reconciled');
    const sameRequestId = reconcilePosts.length >= 1 && Boolean(originalRequestId)
      && reconcilePosts.every((entry) => entry.bodyHead.includes(originalRequestId));
    expect('R4-unknown/manual-reconcile-same-request', reconciled && sameRequestId
      && (/已只读核实原请求/.test(reconcileMessage) || /资料修订已保存/.test(reconcileMessage)),
      { reconciled, reconcileMessage, reconcilePosts, originalRequestId });
    expect('R4-unknown/no-duplicate-write', rowsAfterReconcile.length === 1 && auditAfterReconcile === 1,
      { duplicateRows: rowsAfterReconcile.length, auditAfterReconcile, requestId: originalRequestId });
    rec.record('unknown', {
      beforeRevision, statusMessage, pendingJson, postsAfterWait, draftAfter, storedBefore: Boolean(stored),
      committedRevision: committed?.revision, originalRequestId, auditForRequest, reconciled, reconcileMessage,
      reconcilePosts, sameRequestId, duplicateRows: rowsAfterReconcile.length, auditAfterReconcile,
      storedAfterReconcile: Boolean(storedAfterReconcile), actionId: appendActionId,
    });
    await context.close();
  }

  /* ---------------- 5. browser back keeps draft ---------------- */
  {
    const state = await itemByCode('WM0059');
    const value = `FIXTURE-R4-BACK-${tag}`;
    const { context, page } = await newLoggedInPage(browser, base);
    await openDetailByCode(page, 'WM0059');
    await enterEdit(page);
    const fields = await fillRevision(page, { field: 'englishName', value, evidence: 'fixture:r4:back', reason: `R4 back ${tag}` });
    await page.goBack();
    await page.waitForTimeout(1_500);
    const dialogAfterBack = await page.getByTestId('catalog-detail-core-ready').count();
    await openDetailByCode(page, 'WM0059');
    await enterEdit(page);
    const restoredNotice = await page.getByTestId('catalog-edit-restored').count();
    const restoredValue = await page.locator('input[name="fieldValue"]').inputValue().catch(() => null);
    const restoredEvidence = await page.locator('input[name="evidenceRef"]').inputValue().catch(() => null);
    await rec.shot(page, 'r4-back-restored');
    expect('R4-back/draft-restored', restoredNotice === 1 && restoredValue === value && restoredEvidence === 'fixture:r4:back',
      { dialogAfterBack, restoredNotice, restoredValue, restoredEvidence });
    rec.record('back', { dialogAfterBack, restoredNotice, restoredValue, restoredEvidence });
    await context.close();
  }
} finally {
  await browser.close();
  await db.end();
}

const failed = expectations.filter((entry) => !entry.pass);
const file = rec.finish({ pass: failed.length === 0, total: expectations.length, failed: failed.length, expectations });
console.log(JSON.stringify({ lane: 'r4', runId, pass: failed.length === 0, failed, total: expectations.length, evidence: file }, null, 2));
process.exitCode = failed.length === 0 ? 0 : 1;
