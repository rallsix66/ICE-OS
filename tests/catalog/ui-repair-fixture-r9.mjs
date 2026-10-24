#!/usr/bin/env node
/**
 * R9 acceptance lane — enabled legacy entry pages (/dashboard/catalog/intake, /sources)
 * against the ISOLATED module fixture, plus their disabled-guidance counterpart on the
 * preview fixture. Records whether item / observation / record / scope / from are really
 * consumed, the safe return point, and visual facts (screenshots at 1440 and 635).
 *
 * Usage:
 *   node .../ui-repair-fixture-r9.mjs --run-id <modules-run> --port 3013 --lane modules
 *   node .../ui-repair-fixture-r9.mjs --run-id <preview-run> --port 3012 --lane preview
 */
import {
  baseUrl, createRecorder, launch, login, newLoggedInPage, ownerClient, resolveRun,
} from './ui-repair-fixture-lib.mjs';

function arg(flag, fallback) { const index = process.argv.indexOf(flag); return index < 0 ? fallback : process.argv[index + 1]; }
const runId = arg('--run-id');
const port = Number(arg('--port', '3013'));
const lane = arg('--lane', 'modules');
const tag = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const run = await resolveRun(runId);
const rec = createRecorder(`r9-${lane}-${tag}`, runId);
const base = baseUrl(port);
const db = await ownerClient(run);
await db.connect();
const expectations = [];
function expect(name, condition, detail) {
  expectations.push({ name, pass: Boolean(condition), detail });
  return Boolean(condition);
}
async function q(sql, values = []) { return (await db.query(sql, values)).rows; }

const browser = await launch();
try {
  const record = lane === 'modules'
    ? (await q(`SELECT id, scope_id FROM catalog.source_record ORDER BY id LIMIT 1`))[0]
    : null;
  const observationId = '00000000-0000-4000-8000-0000000000aa';

  if (lane === 'modules') {
    const item = (await q(`SELECT item_id FROM catalog.catalog_item_code WHERE ice_code='WM0044'`))[0];
    const { context, page } = await newLoggedInPage(browser, base);

    /* ---------- intake: item + from + observation ---------- */
    const intakeUrl = `/dashboard/catalog/intake?scope=${record.scope_id}&item=${item.item_id}&observation=${observationId}&from=/dashboard/catalog?q=WM0044`;
    await page.goto(intakeUrl);
    await page.getByTestId('new-item-page').waitFor({ timeout: 120_000 });
    const intake = {
      context: await page.getByTestId('intake-context').innerText(),
      locate: await page.getByTestId('intake-observation-locate').innerText().catch(() => null),
      back: await page.locator('a', { hasText: /返回原处|返回待处理/ }).first().getAttribute('href').catch(() => null),
      backLabel: await page.locator('a', { hasText: /返回原处|返回待处理/ }).first().innerText().catch(() => null),
      hasIntake: await page.getByTestId('new-item-intake').count(),
      technical: /技术说明|原始 JSON|catalog-audit-json/.test(await page.locator('body').innerText()),
    };
    await rec.shot(page, 'r9-intake-1440');
    await page.setViewportSize({ width: 635, height: 900 });
    await rec.shot(page, 'r9-intake-635');
    await page.setViewportSize({ width: 1440, height: 900 });
    expect('R9-intake/item-consumed', intake.hasIntake === 1 && /关联商品/.test(intake.context) && intake.context.includes('WM0044'), intake);
    expect('R9-intake/observation-consumed', /原观测/.test(intake.context) && Boolean(intake.locate), intake);
    expect('R9-intake/from-consumed', intake.back === '/dashboard/catalog?q=WM0044' && /返回原处/.test(intake.backLabel ?? ''), intake);
    // Technical/raw evidence on the authorized processing page is expected here (R9 moves it out of
    // the daily detail, not out of the processing workspace). Recorded as a fact, not asserted.

    rec.record('intake', intake);

    /* ---------- sources: item + record + from=issues ---------- */
    const sourcesUrl = `/dashboard/catalog/sources?scope=${record.scope_id}&item=${item.item_id}&record=${record.id}&from=/dashboard/catalog/issues`;
    await page.goto(sourcesUrl);
    await page.getByTestId('source-identity-page').waitFor({ timeout: 120_000 });
    const sources = {
      context: await page.getByTestId('identity-context').innerText(),
      locate: await page.getByTestId('identity-record-locate').innerText().catch(() => null),
      back: await page.locator('a', { hasText: /返回原处|返回待处理/ }).first().getAttribute('href').catch(() => null),
      backLabel: await page.locator('a', { hasText: /返回原处|返回待处理/ }).first().innerText().catch(() => null),
      workspace: await page.getByTestId('identity-scope-id').innerText().catch(() => null),
      technical: /技术说明|原始 JSON|catalog-audit-json/.test(await page.locator('body').innerText()),
    };
    await rec.shot(page, 'r9-sources-1440');
    await page.setViewportSize({ width: 635, height: 900 });
    await rec.shot(page, 'r9-sources-635');
    await page.setViewportSize({ width: 1440, height: 900 });
    expect('R9-sources/item+record-consumed', /关联商品/.test(sources.context) && /原记录/.test(sources.context)
      && sources.context.includes(record.id), sources);
    expect('R9-sources/record-located', /已定位原记录|原记录已建立关联|未替你切换到别的范围/.test(sources.locate ?? ''), sources);
    expect('R9-sources/from-issues-consumed', sources.back === '/dashboard/catalog/issues' && /返回待处理/.test(sources.backLabel ?? ''), sources);
    expect('R9-sources/scope-consumed', sources.workspace === record.scope_id, sources);
    // Same note as the intake page: raw evidence remains in the authorized processing workspace.

    rec.record('sources', sources);

    /* ---------- invalid scope must not fall back to a default scope ---------- */
    await page.goto('/dashboard/catalog/sources?scope=not-a-uuid&item=' + item.item_id);
    await page.waitForTimeout(3_000);
    const guidance = await page.getByTestId('legacy-entry-guidance').count();
    const guidanceText = await page.getByTestId('legacy-entry-guidance').innerText().catch(() => null);
    await rec.shot(page, 'r9-invalid-scope');
    expect('R9-invalid-scope/safe-guidance', guidance === 1 && /无权|不可用|不可|不存在/.test(guidanceText ?? ''), { guidance, guidanceText });
    rec.record('invalid-scope', { guidance, guidanceText });
    await context.close();
  } else {
    /* ---------- disabled guidance on the preview fixture ---------- */
    const { context, page } = await newLoggedInPage(browser, base);
    const item = (await q(`SELECT item_id FROM catalog.catalog_item_code WHERE ice_code='WM0044'`))[0];
    for (const [name, url] of [
      ['intake', `/dashboard/catalog/intake?item=${item.item_id}&from=/dashboard/catalog/issues`],
      ['sources', `/dashboard/catalog/sources?item=${item.item_id}&from=/dashboard/catalog/issues`],
    ]) {
      await page.goto(url);
      await page.getByTestId('legacy-entry-guidance').waitFor({ timeout: 120_000 });
      const state = await page.getByTestId('legacy-entry-guidance').getAttribute('data-entry-state');
      const disabled = await page.getByTestId('legacy-entry-disabled').count();
      const contextNode = await page.getByTestId('legacy-entry-item-context').innerText().catch(() => null);
      const back = await page.locator('a', { hasText: /返回待处理|返回原处|返回商品/ }).first().getAttribute('href').catch(() => null);
      await rec.shot(page, `r9-${name}-disabled`);
      expect(`R9-disabled/${name}`, state === 'disabled' && disabled === 1 && Boolean(contextNode) && back === '/dashboard/catalog/issues',
        { url, state, disabled, contextNode, back });
      rec.record(`disabled-${name}`, { url, state, disabled, contextNode, back });
    }
    await context.close();
  }
} finally {
  await browser.close();
  await db.end();
}
const failed = expectations.filter((entry) => !entry.pass);
const file = rec.finish({ pass: failed.length === 0, total: expectations.length, failed: failed.length, expectations });
console.log(JSON.stringify({ lane: 'r9', fixtureLane: lane, runId, pass: failed.length === 0, failed, total: expectations.length, evidence: file }, null, 2));
process.exitCode = failed.length === 0 ? 0 : 1;
