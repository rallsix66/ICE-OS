#!/usr/bin/env node
/**
 * R7 acceptance lane — issue index (N1A/N1C) against ISOLATED fixture runs.
 *
 * Modes:
 *  - `--lane modules --empty` on the empty N1A/N1C fixture (3014): enabled + genuine
 *    unlinked source-scope issue, coverage status, dedupe keys, 无权 / 读取失败.
 *  - `--lane modules` on the seeded module fixture (3013): + linked brush fact, closed
 *    exclusion, uncoded new-item fact, entry context.
 *  - `--lane preview` on the preview fixture (3012): modules disabled expression.
 *
 * 无事项 on an enabled fixture: see README "未覆盖" — the N1A/N1C fixture always carries a
 * real unresolved source scope, and source_scope/source_record are immutable by trigger,
 * so a zero-fact enabled fixture would need a new fixture config (not faked by a switch).
 */
import {
  baseUrl, createRecorder, launch, login, newLoggedInPage, ownerClient, resolveRun,
} from './ui-repair-fixture-lib.mjs';

function arg(flag, fallback) { const index = process.argv.indexOf(flag); return index < 0 ? fallback : process.argv[index + 1]; }
const runId = arg('--run-id');
const port = Number(arg('--port', '3014'));
const lane = arg('--lane', 'modules');
const emptyRun = process.argv.includes('--empty');
const tag = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const run = await resolveRun(runId);
const rec = createRecorder(`r7-${lane}-${emptyRun ? 'empty-' : ''}${tag}`, runId);
const base = baseUrl(port);
const db = await ownerClient(run);
await db.connect();
const expectations = [];
function expect(name, condition, detail) {
  expectations.push({ name, pass: Boolean(condition), detail });
  return Boolean(condition);
}
async function q(sql, values = []) { return (await db.query(sql, values)).rows; }

async function readIndex(page) {
  await page.goto('/dashboard/catalog/issues');
  await page.getByTestId('catalog-issues-page').waitFor({ timeout: 120_000 });
  return {
    state: await page.getByTestId('catalog-issues-page').getAttribute('data-issues-state'),
    counts: await page.getByTestId('catalog-issues-counts').innerText().catch(() => null),
    unlinked: await page.getByTestId('catalog-issues-unlinked').innerText().catch(() => null),
    empty: await page.getByTestId('catalog-issues-empty').innerText().catch(() => null),
    modules: await page.locator('[data-module-key]').evaluateAll((nodes) => nodes.map((node) => ({
      key: node.getAttribute('data-module-key'),
      enabled: node.getAttribute('data-module-enabled'),
      status: node.getAttribute('data-module-status'),
      text: (node.textContent ?? '').trim().slice(0, 220),
    }))),
    rows: await page.locator('[data-testid="catalog-issue-row"]').evaluateAll((nodes) => nodes.map((node) => ({
      key: node.getAttribute('data-issue-key'),
      kind: node.getAttribute('data-issue-kind'),
      module: node.getAttribute('data-issue-module'),
      itemId: node.getAttribute('data-item-id'),
      hasItem: node.getAttribute('data-has-item'),
      href: node.querySelector('a')?.getAttribute('href') ?? null,
      text: (node.textContent ?? '').trim().slice(0, 400),
    }))),
  };
}

const browser = await launch();
try {
  const { context, page } = await newLoggedInPage(browser, base);

  if (lane === 'preview') {
    /* ---------- 未启用 expression (both modules disabled) ---------- */
    const index = await readIndex(page);
    await rec.shot(page, 'r7-disabled');
    expect('R7-disabled/expr', index.state === 'ok'
      && index.modules.length === 2 && index.modules.every((entry) => entry.enabled === 'false' && entry.status === 'disabled')
      && /未启用/.test(index.modules.map((entry) => entry.text).join('\n'))
      && index.rows.length > 0,
      { state: index.state, modules: index.modules, counts: index.counts, rowCount: index.rows.length });
    expect('R7-disabled/no-zero-claim', !/已查全/.test(index.modules.map((entry) => entry.text).join('\n')), index.modules);
    rec.record('disabled', index);
    await context.close();
  } else if (emptyRun) {
    /* ---------- enabled, unlinked source-scope issue ---------- */
    const index = await readIndex(page);
    const unlinkedRows = index.rows.filter((row) => row.hasItem === 'false');
    const scopeRow = unlinkedRows.find((row) => row.kind === 'source_scope_unresolved');
    await rec.shot(page, 'r7-enabled-unlinked');
    expect('R7-unlinked/expr', index.state === 'ok' && index.rows.length > 0
      && index.modules.every((entry) => entry.enabled === 'true' && entry.status === 'covered')
      && Boolean(index.unlinked) && /未关联商品 [1-9]/.test(index.unlinked ?? ''),
      { state: index.state, counts: index.counts, unlinked: index.unlinked, modules: index.modules });
    expect('R7-unlinked/row-has-no-item', Boolean(scopeRow) && scopeRow?.module === 'source_identity'
      && /谓词/.test(scopeRow?.text ?? '') && /关闭条件/.test(scopeRow?.text ?? '')
      && /所需权限/.test(scopeRow?.text ?? ''), { scopeRow });
    // dedupe keys stable across reload
    const keys = index.rows.map((row) => row.key);
    await page.reload();
    await page.getByTestId('catalog-issues-page').waitFor({ timeout: 120_000 });
    const second = await page.locator('[data-testid="catalog-issue-row"]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-issue-key')));
    expect('R7-unlinked/key-stable', new Set(keys).size === keys.length && JSON.stringify(second) === JSON.stringify(keys),
      { keys, second });
    // entry context for an unlinked item
    if (scopeRow?.href) {
      await page.goto(scopeRow.href);
      await page.waitForTimeout(3_000);
      const links = await page.locator('a[href]').evaluateAll((nodes) => nodes.map((node) => ({ href: node.getAttribute('href'), text: (node.textContent ?? '').trim().slice(0, 60) })));
      const returnLink = links.find((entry) => /返回/.test(entry.text));
      expect('R7-unlinked/entry-context', Boolean(returnLink?.href) && /\/dashboard\/catalog/.test(returnLink?.href ?? ''),
        { href: scopeRow.href, returnLink });
      rec.record('unlinked-entry', { href: scopeRow.href, returnLink });
    }
    rec.record('enabled-unlinked', index);

    /* ---------- 无权 ---------- */
    const weakCtx = await browser.newContext({ baseURL: base });
    const weakPage = await weakCtx.newPage();
    await login(weakPage, { email: 'operator@catalog.test', password: 'CatalogOperator123!' });
    await weakPage.goto('/dashboard/catalog/issues').catch(() => {});
    await weakPage.waitForTimeout(3_000);
    const forbidden = await weakPage.getByTestId('catalog-issues-forbidden').innerText().catch(() => null);
    await rec.shot(weakPage, 'r7-forbidden');
    expect('R7-forbidden/expr', Boolean(forbidden) && /无法查看待处理事项/.test(forbidden ?? '') && /不显示 0 项/.test(forbidden ?? ''),
      { forbidden });
    rec.record('forbidden', { forbidden });
    await weakCtx.close();

    /* ---------- 读取失败 ---------- */
    await db.query('ALTER TABLE catalog.item_current RENAME TO item_current_r7probe');
    try {
      await page.goto('/dashboard/catalog/issues');
      const failedNode = page.getByTestId('catalog-issues-read-failed');
      await failedNode.waitFor({ timeout: 120_000 });
      const failedText = (await failedNode.innerText()) ?? '';
      await rec.shot(page, 'r7-read-failed');
      expect('R7-read-failed/expr', /读取失败/.test(failedText) && /不显示“0 项”/.test(failedText)
        && await page.getByTestId('catalog-issues-retry').count() === 1, { failedText: failedText.slice(0, 260) });
      rec.record('read-failed', { failedText });
    } finally {
      await db.query('ALTER TABLE catalog.item_current_r7probe RENAME TO item_current');
    }
    await page.getByTestId('catalog-issues-retry').click();
    await page.waitForTimeout(2_000);
    expect('R7-read-failed/retry-recovers', await page.getByTestId('catalog-issues-page').getAttribute('data-issues-state') === 'ok', {});
    rec.record('read-failed-recovered', {});
    await context.close();
  } else {
    /* ---------- seeded module fixture: linked/closed/uncoded facts ---------- */
    const baseline = (await q(`SELECT item_id FROM catalog.catalog_item_code WHERE ice_code='WM0044'`))[0];
    const release = (await q(`SELECT id, release_id FROM catalog.artifact ORDER BY release_id LIMIT 1`))[0];
    const linkedDecision = (await q(`INSERT INTO catalog.decision_evidence(release_id,artifact_id,entry_kind,entry_key,selected_item_id,
        review_state,payload_sha256,raw_ref,summary) VALUES($1,$2,'history:batch_brush_preservation',$3,$4,'pending_confirmation',
        repeat('a',64),'fixture:r7:linked',jsonb_build_object('status','pending_confirmation','sourceSystem','bigseller','reason',$5::text,'doNotMerge',true))
        RETURNING id`, [release.release_id, release.id, `fixture-r7-linked-${tag}`, baseline.item_id, `R7 linked ${tag}`]))[0];
    const closedDecision = (await q(`INSERT INTO catalog.decision_evidence(release_id,artifact_id,entry_kind,entry_key,selected_item_id,
        review_state,payload_sha256,raw_ref,summary) VALUES($1,$2,'history:batch_brush_preservation',$3,$4,'confirmed',
        repeat('c',64),'fixture:r7:closed',jsonb_build_object('status','confirmed','sourceSystem','bigseller','reason','closed'))
        RETURNING id`, [release.release_id, release.id, `fixture-r7-closed-${tag}`, baseline.item_id]))[0];
    const unlinkedDecision = (await q(`INSERT INTO catalog.decision_evidence(release_id,artifact_id,entry_kind,entry_key,selected_item_id,
        review_state,payload_sha256,raw_ref,summary) VALUES($1,$2,'history:batch_brush_preservation',$3,NULL,'pending_confirmation',
        repeat('b',64),'fixture:r7:unlinked',jsonb_build_object('status','pending_confirmation','sourceSystem','jushuitan','reason',$4::text,'doNotMerge',false))
        RETURNING id`, [release.release_id, release.id, `fixture-r7-unlinked-${tag}`, `R7 unlinked ${tag}`]))[0];

    const index = await readIndex(page);
    await rec.shot(page, 'r7-seeded');
    const linkedRow = index.rows.find((row) => row.key === `brush_pending:${linkedDecision.id}`);
    const closedListed = index.rows.some((row) => row.key === `brush_pending:${closedDecision.id}`);
    const newItemRow = index.rows.find((row) => row.kind === 'new_item_missing_code');
    const unlinkedBrushListed = index.rows.some((row) => row.key === `brush_pending:${unlinkedDecision.id}`);
    expect('R7-seeded/has-linked-issue', index.state === 'ok' && Boolean(linkedRow) && !closedListed,
      { counts: index.counts, kinds: index.rows.map((row) => row.kind), linkedKey: linkedRow?.key, closedListed });
    expect('R7-seeded/new-item-issue', Boolean(newItemRow), { newItemRow: newItemRow?.key });
    expect('R7-seeded/unlinked-scope-issue-present', /未关联商品 [1-9]/.test(index.unlinked ?? ''),
      { unlinked: index.unlinked });
    expect('R7-seeded/record-level-unlinked-brush-not-a-new-kind', unlinkedBrushListed === false,
      { unlinkedDecisionId: unlinkedDecision.id, unlinkedBrushListed, note: 'brush predicate keeps selected_item_id; unlinked scope records cover the "no item" case' });
    rec.record('seeded', { index, linkedDecision: linkedDecision.id, closedDecision: closedDecision.id, unlinkedDecision: unlinkedDecision.id });
    if (linkedRow?.href) {
      await page.goto(linkedRow.href);
      await page.waitForTimeout(3_000);
      const links = await page.locator('a[href]').evaluateAll((nodes) => nodes.map((node) => ({ href: node.getAttribute('href'), text: (node.textContent ?? '').trim().slice(0, 60) })));
      const returnLink = links.find((entry) => /返回/.test(entry.text));
      expect('R7-seeded/entry-context', Boolean(returnLink?.href) && /\/dashboard\/catalog/.test(returnLink?.href ?? ''),
        { href: linkedRow.href, returnLink });
      rec.record('entry', { href: linkedRow.href, returnLink });
    }
    await context.close();
  }
} finally {
  await browser.close();
  await db.end();
}
const failed = expectations.filter((entry) => !entry.pass);
const file = rec.finish({ pass: failed.length === 0, total: expectations.length, failed: failed.length, expectations });
console.log(JSON.stringify({ lane: 'r7', fixtureLane: lane, empty: emptyRun, runId, pass: failed.length === 0, failed, total: expectations.length, evidence: file }, null, 2));
process.exitCode = failed.length === 0 ? 0 : 1;
