#!/usr/bin/env node
/**
 * V3-01/V3-05 in-dialog history and evidence subview.
 *
 * Checks the frozen v3 testid contract:
 *  - history: `revision-history-<n>[data-current]`, `revision-current-badge`, `revision-switch-<n>`,
 *    `catalog-detail-back-current`/`catalog-history-back-current`, `revision-evidence-open`;
 *  - evidence: `catalog-detail-more` summary → `catalog-more-evidence` →
 *    `catalog-evidence-view[data-evidence-state]`, `catalog-evidence-back/title/subject`,
 *    `evidence-audit-state[data-audit-state]`, `evidence-candidate-count`, `evidence-raw-json`,
 *    `evidence-amounts`; Esc closes evidence before the dialog;
 *  - daily history after a real revision must not contain UUID / JSON path / internal English reason.
 *
 * Usage: node tests/catalog/ui-repair-v3-history-evidence.mjs --run-id <work-run> --port 3015
 */
import {
  createRecorder, expectAll, launch, login, openDetailByCode, ownerClient, resolveRun,
} from './ui-repair-v3-lib.mjs';

function arg(flag, fallback) { const i = process.argv.indexOf(flag); return i < 0 ? fallback : process.argv[i + 1]; }
const runId = arg('--run-id');
const port = Number(arg('--port', '3015'));
const code = arg('--code', 'WM0043');
const run = await resolveRun(runId);
const rec = createRecorder('v3-01-history-evidence', runId);
const { expectations, expect, summary } = expectAll();
const db = await ownerClient(run);
const base = `http://127.0.0.1:${port}`;
const browser = await launch();
try {
  const context = await browser.newContext({ baseURL: base, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await login(page);
  await openDetailByCode(page, code);
  const item = (await db.query(`SELECT k.item_id, c.revision FROM catalog.catalog_item_code k JOIN catalog.item_current c ON c.item_id=k.item_id WHERE k.ice_code=$1`, [code])).rows[0];
  expect('setup/item-and-revisions', Boolean(item) && item.revision >= 2, { code, item });

  /* ---------- dialog shell + current state ---------- */
  const shell = {
    dialog: await page.getByTestId('catalog-detail-dialog').count(),
    revisionAttr: await page.getByTestId('catalog-detail-dialog').getAttribute('data-revision').catch(() => null),
    evidenceAttr: await page.getByTestId('catalog-detail-dialog').getAttribute('data-evidence').catch(() => null),
    currentBadge: await page.getByTestId('revision-current-badge').count() + await page.getByTestId('catalog-detail-current-badge').count(),
  };
  expect('dialog/current-state', shell.dialog === 1 && shell.revisionAttr === 'current' && shell.evidenceAttr === 'off', shell);
  rec.record('dialog-current', shell);

  /* ---------- history partition ---------- */
  await page.getByTestId('catalog-tab-history').click();
  await page.getByTestId('catalog-history-list').waitFor({ timeout: 60_000 });
  const history = {
    rows: await page.locator('[data-testid^="revision-history-"]').evaluateAll((nodes) => nodes.map((node) => ({
      revision: node.getAttribute('data-testid'),
      current: node.getAttribute('data-current'),
      text: (node.textContent ?? '').trim().slice(0, 300),
    }))),
    switches: await page.locator('[data-testid^="revision-switch-"]').count(),
    evidenceOpens: await page.locator('[data-testid="revision-evidence-open"]').count(),
    bodyText: ((await page.getByTestId('catalog-detail-body').innerText().catch(() => '')) ?? ''),
  };
  const uuidLike = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const jsonPath = /[A-Za-z0-9_.-]+\.json#?\//;
  const internalReason = /accepted frozen baseline|pending_confirmation|match-bundle/i;
  expect('history/current-row-and-switch', history.rows.length >= 1 && history.rows.some((row) => row.current === 'true')
    && history.switches >= 1, { rowCount: history.rows.length, switches: history.switches });
  expect('history/daily-no-technical-raw', !uuidLike.test(history.bodyText) && !jsonPath.test(history.bodyText) && !internalReason.test(history.bodyText),
    { uuidLike: uuidLike.test(history.bodyText), jsonPath: jsonPath.test(history.bodyText), internalReason: internalReason.test(history.bodyText) });
  rec.record('history', { ...history, bodyText: history.bodyText.slice(0, 1200) });

  /* ---------- switch to an older revision and back ---------- */
  const older = history.rows.map((row) => Number((row.revision ?? '').replace('revision-history-', ''))).filter((n) => Number.isInteger(n) && n < item.revision).sort((a, b) => b - a)[0];
  if (older) {
    await page.getByTestId(`revision-switch-${older}`).click();
    await page.getByTestId('catalog-detail-history-badge').waitFor({ timeout: 60_000 });
    await page.getByTestId('catalog-tab-inventory').click().catch(() => {});
    await page.waitForTimeout(800);
    const historicalBody = ((await page.getByTestId('catalog-detail-body').innerText().catch(() => '')) ?? '');
    const historical = {
      badge: await page.getByTestId('catalog-detail-history-badge').innerText().catch(() => null),
      revisionAttr: await page.getByTestId('catalog-detail-dialog').getAttribute('data-revision').catch(() => null),
      backCurrent: await page.getByTestId('catalog-detail-back-current').count() + await page.getByTestId('catalog-history-back-current').count(),
      historicalInventoryText: await page.getByTestId('catalog-tabpanel-inventory').innerText().catch(() => null),
      historicalNoteVisible: /历史版本不显示当前库存|历史快照/.test(historicalBody),
    };
    await rec.shot(page, 'history-older');
    expect('history/older-readonly-and-back-current', historical.revisionAttr === String(older) && historical.backCurrent >= 1
      && /历史只读/.test(historical.badge ?? '') && historical.historicalNoteVisible === true,
      { older, ...historical, historicalBody: historicalBody.slice(-600) });
    const backButton = page.getByTestId('catalog-detail-back-current').or(page.getByTestId('catalog-history-back-current')).first();
    await backButton.click();
    await page.getByTestId('catalog-detail-current-badge').or(page.getByTestId('revision-current-badge')).first().waitFor({ timeout: 60_000 });
    const backRevision = await page.getByTestId('catalog-detail-dialog').getAttribute('data-revision').catch(() => null);
    expect('history/back-current', backRevision === 'current', { backRevision });
    rec.record('history-older', { older, ...historical, backRevision });
  }

  /* ---------- evidence subview ---------- */
  const attemptOpenEvidence = async () => {
    // Force the <details> open; clicking the summary again would toggle it closed.
    await page.getByTestId('catalog-detail-more').evaluate((node) => { node.open = true; }).catch(() => {});
    await page.waitForTimeout(300);
    const item = page.getByTestId('catalog-more-evidence');
    if (!(await item.count())) return { opened: false, reason: 'no evidence entry (no real sources/history evidence for this item)' };
    await item.click();
    const view = page.getByTestId('catalog-evidence-view');
    await view.waitFor({ timeout: 60_000 });
    const state = await view.getAttribute('data-evidence-state');
    if (state === 'loading') await page.waitForTimeout(3_000);
    return {
      opened: true,
      state: await view.getAttribute('data-evidence-state'),
      title: await page.getByTestId('catalog-evidence-title').innerText().catch(() => null),
      subject: await page.getByTestId('catalog-evidence-subject').innerText().catch(() => null),
      auditState: await page.getByTestId('evidence-audit-state').getAttribute('data-audit-state').catch(() => null),
      candidateCount: await page.getByTestId('evidence-candidate-count').innerText().catch(() => null),
      rawJson: await page.getByTestId('evidence-raw-json').count(),
      amounts: await page.getByTestId('evidence-amounts').count(),
      detailHiddenAttr: await page.getByTestId('catalog-detail-body').evaluate((node) => node.hidden).catch(() => null),
      evidenceAttr: await page.getByTestId('catalog-detail-dialog').getAttribute('data-evidence').catch(() => null),
    };
  };
  const evidence = await attemptOpenEvidence();
  await rec.shot(page, 'evidence-view');
  if (evidence.opened) {
    expect('evidence/subview-ready', evidence.state === 'ready' && Boolean(evidence.title) && Boolean(evidence.subject)
      && evidence.evidenceAttr === 'on', evidence);
    if (evidence.auditState === 'loaded') {
      expect('evidence/raw-json-only-in-subview', evidence.rawJson === 1 && Boolean(evidence.candidateCount), evidence);
    }
    await page.getByTestId('catalog-evidence-back').click();
    await page.getByTestId('catalog-evidence-view').waitFor({ state: 'detached', timeout: 30_000 }).catch(() => {});
    const afterBack = await page.getByTestId('catalog-detail-dialog').getAttribute('data-evidence').catch(() => null);
    expect('evidence/back-restores-detail', afterBack === 'off', { afterBack });
    // Esc closes evidence first, then the dialog (open evidence again)
    const second = await attemptOpenEvidence();
    if (second.opened) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      const evidenceGone = await page.getByTestId('catalog-evidence-view').count();
      const dialogStillOpen = await page.getByTestId('catalog-detail-dialog').count();
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
      const dialogClosed = await page.getByTestId('catalog-detail-dialog').count();
      expect('evidence/esc-order', evidenceGone === 0 && dialogStillOpen === 1 && dialogClosed === 0, { evidenceGone, dialogStillOpen, dialogClosed });
    }
    rec.record('evidence', { evidence, second });
  } else rec.record('evidence', evidence);
  await context.close();
} finally {
  await browser.close();
  await db.end();
}
const result = summary();
rec.finish(result);
console.log(JSON.stringify({ suite: 'v3-01-history-evidence', runId, code, ...result, evidence: rec.file }, null, 2));
process.exitCode = result.pass ? 0 : 1;
