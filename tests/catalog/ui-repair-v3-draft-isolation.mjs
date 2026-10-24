#!/usr/bin/env node
/**
 * V3-04 cross-account draft isolation and legacy storage quarantine.
 *
 * Requirements under test (contract-v3-interfaces.md §3):
 *  - drafts: `catalog:edit-state:v3:<principalKey>:<itemId>`;
 *  - pending requests: `catalog:pending-request:v3:<principalKey>:<itemId>` (independent cleanup);
 *  - legacy `catalog:edit-state:<itemId>`: not read, not migrated, not deleted; show
 *    `catalog-edit-legacy-quarantined` instead;
 *  - account A logout → B login (same tab) must not see/commit A's draft, basis or requestId;
 *  - A relogin must recover A's own draft.
 *
 * Usage: node tests/catalog/ui-repair-v3-draft-isolation.mjs --run-id <work-run> --port 3015
 */
import {
  createRecorder, expectAll, fillDraft, launch, login, openDetailByCode, ownerClient, resolveRun, storage, switchAccount,
} from './ui-repair-v3-lib.mjs';

function arg(flag, fallback) { const i = process.argv.indexOf(flag); return i < 0 ? fallback : process.argv[i + 1]; }
const runId = arg('--run-id');
const port = Number(arg('--port', '3015'));
const code = arg('--code', 'WM0043');
const adminA = { email: arg('--email-a', 'admin@catalog.test'), password: arg('--password-a', 'CatalogAdmin123!') };
const adminB = { email: arg('--email-b', 'scope-b@catalog.test'), password: arg('--password-b', 'CatalogScopeB123!') };
const run = await resolveRun(runId);
const rec = createRecorder('v3-04-draft-isolation', runId);
const { expectations, expect, summary } = expectAll();
const db = await ownerClient(run);
const base = `http://127.0.0.1:${port}`;
const draftValue = `V3-DRAFT-A-${Date.now()}`;
let itemId = null;

const browser = await launch();
try {
  const context = await browser.newContext({ baseURL: base, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  itemId = (await db.query(`SELECT item_id FROM catalog.catalog_item_code WHERE ice_code=$1`, [code])).rows[0]?.item_id;
  expect('setup/item-found', Boolean(itemId), { code, itemId });

  /* A writes a draft */
  await login(page, adminA.email, adminA.password);
  await openDetailByCode(page, code);
  await page.getByRole('button', { name: '编辑资料', exact: true }).click();
  await page.getByTestId('catalog-detail-edit').waitFor({ timeout: 60_000 });
  const fields = await fillDraft(page, { value: draftValue, evidence: 'fixture:v3:account-a', reason: 'V3 draft A' });
  const storageA = await storage(page);
  const aDraftKey = Object.keys(storageA).find((key) => key.startsWith('catalog:edit-state:v3:') && key.endsWith(`:${itemId}`));
  expect('A/draft-stored-under-principal-key', Boolean(aDraftKey) && storageA[aDraftKey].includes(draftValue), { aDraftKey });
  const aPrincipal = aDraftKey ? aDraftKey.split(':')[3] : null;
  await rec.shot(page, 'a-draft');

  /* Inject a legacy unbound draft before B opens the editor */
  await page.evaluate((id) => {
    window.sessionStorage.setItem(`catalog:edit-state:${id}`, JSON.stringify({ draft: { fieldValue: 'LEGACY-SENTINEL' }, notice: 'legacy' }));
  }, itemId);

  /* A logs out, B logs in (same tab); the modal must be closed first (focus trap keeps
     background controls out of reach while the dialog is open). */
  await page.getByTestId('catalog-detail-close').click().catch(() => {});
  const leavePrompt = page.getByRole('button', { name: /放弃修改并关闭/ });
  if (await leavePrompt.count()) await leavePrompt.first().click();
  await page.waitForTimeout(500);
  // Record the real logout button behaviour first; it is a separate product finding.
  await page.getByRole('button', { name: '退出登录' }).first().click();
  await page.waitForTimeout(3_000);
  const logoutUrl = page.url();
  const logoutError = await page.getByTestId('logout-error').innerText().catch(() => null);
  const stillAuthenticated = await page.getByTestId('catalog-counts').count();
  expect('logout/real-button-signs-out', /\/auth\/login/.test(logoutUrl),
    { logoutUrl, logoutError, stillAuthenticated });
  rec.record('logoutButton', { logoutUrl, logoutError, stillAuthenticated });
  // Auth cookies are cleared for the account switch; sessionStorage stays in the same tab.
  await switchAccount(context, page, adminB.email, adminB.password);
  await openDetailByCode(page, code);
  await page.getByRole('button', { name: '编辑资料', exact: true }).click();
  await page.getByTestId('catalog-detail-edit').waitFor({ timeout: 60_000 });
  const storageB = await storage(page);
  const valueAfterB = await fields.value.inputValue().catch(() => null);
  const restoredAfterB = await page.getByTestId('catalog-edit-restored').count();
  const legacyNotice = await page.getByTestId('catalog-edit-legacy-quarantined').count();
  const legacyKeyStillPresent = JSON.stringify(storageB).includes('LEGACY-SENTINEL');
  const aKeySeenByB = aDraftKey ? Object.prototype.hasOwnProperty.call(storageB, aDraftKey) : false;
  const bDraftKey = Object.keys(storageB).find((key) => key.startsWith('catalog:edit-state:v3:') && key.endsWith(`:${itemId}`));
  await rec.shot(page, 'b-after-a');
  expect('B/does-not-load-A-draft', valueAfterB !== draftValue && restoredAfterB === 0, { valueAfterB, restoredAfterB });
  expect('B/legacy-quarantined-not-loaded', legacyNotice >= 1 && !JSON.stringify(storageB).includes('"fieldValue":"LEGACY-SENTINEL"') , { legacyNotice });
  expect('B/legacy-key-not-deleted', legacyKeyStillPresent, { legacyKeyStillPresent });
  // The same tab legitimately still contains A's key; isolation means B's editor never reads it
  // and no draft is created under B's own principal by that content.
  const bPrincipalKey = '11111111-1111-4111-8111-111111111107';
  const bOwnKey = Object.keys(storageB).find((key) => key.startsWith('catalog:edit-state:v3:') && key.includes(bPrincipalKey));
  expect('B/no-draft-under-B-principal', !bOwnKey && valueAfterB !== draftValue, { bOwnKey, aKeySeenByB });
  rec.record('accountB', { storageKeys: Object.keys(storageB), valueAfterB, restoredAfterB, legacyNotice, legacyKeyStillPresent, bDraftKey });

  /* A relogin recovers A's own draft */
  await page.getByTestId('catalog-detail-close').click().catch(() => {});
  const leavePromptB = page.getByRole('button', { name: /放弃修改并关闭/ });
  if (await leavePromptB.count()) await leavePromptB.first().click();
  await page.waitForTimeout(500);
  await switchAccount(context, page, adminA.email, adminA.password);
  await openDetailByCode(page, code);
  await page.getByRole('button', { name: '编辑资料', exact: true }).click();
  await page.getByTestId('catalog-detail-edit').waitFor({ timeout: 60_000 });
  const restoredA = await page.getByTestId('catalog-edit-restored').count();
  const valueAfterARelogin = await fields.value.inputValue().catch(() => null);
  const evidenceAfterARelogin = await fields.evidence.inputValue().catch(() => null);
  await rec.shot(page, 'a-relogin');
  expect('A/relogin-restores-own-draft', restoredA >= 1 && valueAfterARelogin === draftValue && evidenceAfterARelogin === 'fixture:v3:account-a',
    { restoredA, valueAfterARelogin, evidenceAfterARelogin });
  rec.record('accountARelogin', { restoredA, valueAfterARelogin, evidenceAfterARelogin, storageKeys: Object.keys(await storage(page)) });

  /* Pending request must survive abandon + same-account relogin, and check-only must not write. */
  {
    await page.getByTestId('catalog-detail-close').click().catch(() => {});
    const leave = page.getByRole('button', { name: /放弃修改并关闭/ });
    if (await leave.count()) await leave.first().click();
    await page.waitForTimeout(500);
    const pendingItem = (await db.query(`SELECT k.item_id, c.revision FROM catalog.catalog_item_code k JOIN catalog.item_current c ON c.item_id=k.item_id WHERE k.ice_code='WM0059'`)).rows[0];
    await openDetailByCode(page, 'WM0059');
    await page.getByRole('button', { name: '编辑资料', exact: true }).click();
    await page.getByTestId('catalog-detail-edit').waitFor({ timeout: 60_000 });
    const loc = await fillDraft(page, { value: 'V3-PENDING-SURVIVE', evidence: 'fixture:v3:pending', reason: 'V3 pending survive' });
    await page.route('**/*', (route) => {
      const request = route.request();
      if (request.method() !== 'POST') return route.fallback();
      const postData = request.postData() ?? '';
      if (postData.includes(pendingItem.item_id) && postData.includes('"fields"')) return route.abort('failed');
      return route.fallback();
    });
    await loc.submit.click();
    await page.getByTestId('pending-original-request').waitFor({ timeout: 120_000 });
    const requestId = JSON.parse((await page.getByTestId('pending-original-input').textContent()) ?? '{}').requestId;
    await page.unroute('**/*');
    // abandon the draft (must keep the pending request)
    await page.getByTestId('catalog-detail-close').click().catch(() => {});
    const abandon = page.getByRole('button', { name: /放弃修改并关闭/ });
    if (await abandon.count()) await abandon.first().click();
    await page.waitForTimeout(500);
    const storageAfterAbandon = await storage(page);
    const pendingKeyAfterAbandon = Object.keys(storageAfterAbandon).find((key) => key.startsWith('catalog:pending-request:v3:') && key.endsWith(`:${pendingItem.item_id}`));
    expect('pending/survives-abandon', Boolean(pendingKeyAfterAbandon) && storageAfterAbandon[pendingKeyAfterAbandon].includes(requestId),
      { pendingKeyAfterAbandon, requestId });
    await switchAccount(context, page, adminA.email, adminA.password);
    await openDetailByCode(page, 'WM0059');
    await page.getByRole('button', { name: '编辑资料', exact: true }).click();
    await page.getByTestId('catalog-detail-edit').waitFor({ timeout: 60_000 });
    const pendingRestored = await page.getByTestId('pending-original-request').count();
    const restoredInput = JSON.parse((await page.getByTestId('pending-original-input').textContent().catch(() => '{}')) ?? '{}');
    const revisionBefore = pendingItem.revision;
    await page.getByTestId('catalog-check-original').click();
    await page.waitForTimeout(3_000);
    const revisionAfterCheck = (await db.query('SELECT revision FROM catalog.item_current WHERE item_id=$1', [pendingItem.item_id])).rows[0].revision;
    const auditBeforeRetry = (await db.query('SELECT count(*)::int n FROM catalog.audit_event WHERE item_id=$1', [pendingItem.item_id])).rows[0].n;
    await page.getByTestId('catalog-retry-original').click();
    await page.waitForTimeout(3_000);
    const auditAfterRetry = (await db.query('SELECT count(*)::int n FROM catalog.audit_event WHERE item_id=$1', [pendingItem.item_id])).rows[0].n;
    expect('pending/relogin-restores-same-request', pendingRestored === 1 && restoredInput.requestId === requestId, { pendingRestored, requestId, restoredInputRequest: restoredInput.requestId });
    expect('pending/check-readonly-then-retry-same-id', revisionAfterCheck === revisionBefore && auditAfterRetry === auditBeforeRetry + 1,
      { revisionBefore, revisionAfterCheck, auditBeforeRetry, auditAfterRetry, requestId });
    rec.record('pending-survive', { pendingItem, requestId, pendingKeyAfterAbandon, pendingRestored, revisionBefore, revisionAfterCheck, auditBeforeRetry, auditAfterRetry });
  }
  await context.close();
} finally {
  await browser.close();
  await db.end();
}
const result = summary();
rec.finish(result);
console.log(JSON.stringify({ suite: 'v3-04-draft-isolation', runId, itemId, ...result, evidence: rec.file }, null, 2));
process.exitCode = result.pass ? 0 : 1;
