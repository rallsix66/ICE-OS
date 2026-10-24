#!/usr/bin/env node
/**
 * V3-08 resilience matrix on an isolated module lane:
 *  - BS projection read failure + independent retry, successful content retained;
 *  - main detail read failure + retry;
 *  - forbidden (operator) and revoked (role changed mid-session);
 *  - late detail response must not overwrite a newer warehouse selection;
 *  - attachment per-side failure/retry for a processing-entry item (pass --attachments-item <uuid>).
 *
 * Usage: node tests/catalog/ui-repair-v3-resilience.mjs --run-id <work-run> --port 3015
 *   [--attachments-item <uuid>]
 */
import {
  createRecorder, expectAll, launch, login, openDetailByCode, ownerClient, resolveRun,
} from './ui-repair-v3-lib.mjs';

function arg(flag, fallback) { const i = process.argv.indexOf(flag); return i < 0 ? fallback : process.argv[i + 1]; }
const runId = arg('--run-id');
const port = Number(arg('--port', '3015'));
const attachmentsItem = arg('--attachments-item', null);
const code = arg('--code', 'WM0043');
const run = await resolveRun(runId);
const rec = createRecorder('v3-08-resilience', runId);
const { expectations, expect, summary } = expectAll();
const db = await ownerClient(run);
const base = `http://127.0.0.1:${port}`;
async function withRename(table, suffix, fn) {
  const [schema, name] = table.split('.');
  await db.query(`ALTER TABLE ${schema}.${name} RENAME TO ${name}_${suffix}`);
  try { return await fn(); } finally {
    const original = (await db.query('SELECT to_regclass($1) AS oid', [table])).rows[0].oid;
    const moved = (await db.query('SELECT to_regclass($1) AS oid', [`${schema}.${name}_${suffix}`])).rows[0].oid;
    if (moved && !original) await db.query(`ALTER TABLE ${schema}.${name}_${suffix} RENAME TO ${name}`);
  }
}
const browser = await launch();
try {
  const context = await browser.newContext({ baseURL: base, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await login(page);

  /* ---------- forbidden: operator ---------- */
  {
    const opCtx = await browser.newContext({ baseURL: base });
    const opPage = await opCtx.newPage();
    await login(opPage, 'operator@catalog.test', 'CatalogOperator123!');
    await opPage.goto('/dashboard/catalog');
    await opPage.waitForTimeout(3_000);
    const body = ((await opPage.locator('body').innerText().catch(() => '')) ?? '').slice(0, 500);
    const core = await opPage.getByTestId('catalog-detail-core-ready').count();
    const listError = await opPage.getByTestId('catalog-list-error').count();
    expect('forbidden/operator-cannot-read', core === 0 && (/无权|不可用|权限/.test(body) || listError >= 1), { core, listError, body });
    rec.record('forbidden', { core, listError, body });
    await opCtx.close();
  }

  /* ---------- BS failure + independent retry, content retained ---------- */
  {
    const fault = await withRename('catalog.bs_sample_inventory_row', 'v3probe', async () => {
      await openDetailByCode(page, code);
      await page.getByTestId('catalog-tab-inventory').click();
      const error = page.getByTestId('catalog-bs-sample-error');
      await error.waitFor({ timeout: 60_000 });
      return { text: await error.innerText(), retry: await error.getByRole('button').count() };
    });
    const coreRetained = await page.getByTestId('catalog-detail-core-ready').count();
    await page.reload();
    await page.getByTestId('catalog-detail-core-ready').waitFor({ timeout: 120_000 });
    await page.getByTestId('catalog-tab-inventory').click();
    await page.getByTestId('catalog-bs-sample-inventory-table').waitFor({ timeout: 120_000 });
    const recovered = await page.getByTestId('catalog-bs-sample-inventory-table').count();
    expect('bs/read-failed-retained-retry', /读取失败/.test(fault.text) && fault.retry >= 1 && coreRetained === 1 && recovered === 1,
      { fault, coreRetained, recovered });
    rec.record('bs-failure', { fault, coreRetained, recovered });
  }

  /* ---------- main read failure + retry (dialog fetch) ---------- */
  {
    let hits = 0;
    await page.route('**/*', async (route) => {
      const request = route.request();
      if (request.method() !== 'POST') return route.fallback();
      const postData = request.postData() ?? '';
      if (!postData.includes('"warehouse"') && !postData.includes('fetchCatalogDetailView')) return route.fallback();
      hits += 1;
      if (hits === 1) return route.abort('failed');
      return route.fallback();
    });
    await page.goto('/dashboard/catalog');
    await page.getByLabel(/搜索/).fill(code);
    await page.getByTestId(`catalog-row-${code}`).waitFor({ timeout: 120_000 });
    await page.getByTestId(`catalog-row-${code}`).getByRole('button', { name: '查看详情' }).click();
    const error = page.getByTestId('catalog-detail-fetch-error');
    await error.waitFor({ timeout: 120_000 });
    const errorText = await error.innerText();
    await error.getByRole('button', { name: /重试/ }).click();
    await page.getByTestId('catalog-detail-core-ready').waitFor({ timeout: 120_000 });
    const recovered = await page.getByTestId('catalog-detail-core-ready').count();
    expect('main/read-failed-retry', /读取失败|失败/.test(errorText) && recovered === 1, { errorText, recovered, hits });
    rec.record('main-failure', { errorText, recovered, hits });
    await page.unroute('**/*');
  }

  /* ---------- late response: delayed first warehouse switch must not win ---------- */
  {
    await page.getByTestId('catalog-tab-inventory').click().catch(() => {});
    await page.waitForTimeout(500);
    const chips = page.getByTestId('catalog-inventory-warehouse').getByRole('button');
    await chips.first().waitFor({ timeout: 60_000 });
    const labels = await chips.allTextContents();
    const target = labels.find((label) => label && !/全部仓库/.test(label)) ?? null;
    if (target) {
      let hit = 0;
      await page.route('**/*', async (route) => {
        const request = route.request();
        if (request.method() !== 'POST') return route.fallback();
        const postData = request.postData() ?? '';
        if (!postData.includes(target) && !postData.includes('"warehouse"')) return route.fallback();
        hit += 1;
        if (hit === 1) await new Promise((r) => setTimeout(r, 4_000));
        return route.fallback();
      });
      const chip = (name) => page.getByTestId('catalog-inventory-warehouse').getByRole('button', { name, exact: true });
      await chip(target).click();
      await page.waitForTimeout(900);
      const allChip = chip('全部仓库');
      const canSwitchBack = await allChip.count();
      if (canSwitchBack) await allChip.click();
      await page.waitForTimeout(7_000);
      const finalWarehouse = await page.getByTestId('catalog-detail-core-ready').getAttribute('data-warehouse');
      const headerWarehouse = await page.getByTestId('catalog-detail-warehouse').innerText().catch(() => null);
      await page.unroute('**/*');
      expect('late/last-selection-wins', canSwitchBack === 0 || (finalWarehouse === 'all' && !/DEE|PH|印尼|喜运达|菲律宾|越南/.test(headerWarehouse ?? '')),
        { target, hit, canSwitchBack, finalWarehouse, headerWarehouse });
      rec.record('late-response', { target, hit, canSwitchBack, finalWarehouse, headerWarehouse });
    } else rec.record('late-response', { skipped: 'no warehouse chips' });
  }

  /* ---------- revoked mid-session ---------- */
  {
    const before = await page.getByTestId('catalog-detail-core-ready').count();
    await db.query(`UPDATE public.profiles SET role_id=(SELECT id FROM public.role WHERE name='operator') WHERE id='11111111-1111-4111-8111-111111111101'`);
    try {
      await page.reload();
      await page.waitForTimeout(4_000);
      const body = ((await page.locator('body').innerText().catch(() => '')) ?? '').slice(-500);
      const core = await page.getByTestId('catalog-detail-core-ready').count();
      expect('revoked/no-authorized-content', before === 1 && core === 0 && /无权|不可用|权限/.test(body), { before, core, body });
      rec.record('revoked', { before, core, body });
    } finally {
      await db.query(`UPDATE public.profiles SET role_id=(SELECT id FROM public.role WHERE name='admin') WHERE id='11111111-1111-4111-8111-111111111101'`);
    }
  }

  /* ---------- attachment per-side failure + independent retry ---------- */
  if (attachmentsItem) {
    const procedure = await (async () => {
      await page.goto(`/dashboard/catalog?detail=${attachmentsItem}`);
      await page.getByTestId('catalog-detail-core-ready').waitFor({ timeout: 120_000 });
      await page.getByTestId('catalog-tab-inventory').click();
      const processing = page.getByTestId('catalog-processing-entry');
      await processing.waitFor({ timeout: 60_000 });
      await db.query('ALTER TABLE catalog.source_scope RENAME TO source_scope_v3probe');
      await db.query('ALTER TABLE catalog.product_observation RENAME TO product_observation_v3probe');
      try {
        await page.reload();
        await page.getByTestId('catalog-detail-core-ready').waitFor({ timeout: 120_000 });
        await page.getByTestId('catalog-tab-inventory').click();
        await page.waitForTimeout(2_500);
        return {
          identityError: await page.getByTestId('catalog-attachment-identity-error').innerText().catch(() => null),
          productError: await page.getByTestId('catalog-attachment-product-error').innerText().catch(() => null),
          identityRetry: await page.getByTestId('catalog-attachment-identity-retry').count(),
          productRetry: await page.getByTestId('catalog-attachment-product-retry').count(),
        };
      } finally {
        await db.query('ALTER TABLE catalog.source_scope_v3probe RENAME TO source_scope');
        await db.query('ALTER TABLE catalog.product_observation_v3probe RENAME TO product_observation');
      }
    })();
    expect('attachments/per-side-failure-distinct', /读取失败/.test(procedure.identityError ?? '') && /读取失败/.test(procedure.productError ?? '')
      && /不等于未启用/.test(procedure.identityError ?? '') && procedure.identityRetry === 1 && procedure.productRetry === 1, procedure);
    await page.getByTestId('catalog-attachment-identity-retry').click();
    await page.waitForTimeout(1_500);
    if (await page.getByTestId('catalog-attachment-product-error').count()) {
      for (let i = 0; i < 60; i += 1) {
        if (await page.getByTestId('catalog-attachment-product-retry').isEnabled().catch(() => false)) break;
        await page.waitForTimeout(250);
      }
      await page.getByTestId('catalog-attachment-product-retry').click();
    }
    await page.getByTestId('catalog-attachment-identity').waitFor({ timeout: 60_000 });
    await page.getByTestId('catalog-attachment-product').waitFor({ timeout: 60_000 });
    expect('attachments/per-side-retry-recovers', await page.getByTestId('catalog-attachment-identity-error').count() === 0
      && await page.getByTestId('catalog-attachment-product-error').count() === 0, {});
    rec.record('attachments', { attachmentsItem, procedure });
  } else {
    rec.record('attachments', { skipped: 'no --attachments-item supplied; requires an N1C processing-entry item created by the new-item suite' });
  }
  await context.close();
} finally {
  await browser.close();
  await db.end();
}
const result = summary();
rec.finish(result);
console.log(JSON.stringify({ suite: 'v3-08-resilience', runId, ...result, evidence: rec.file }, null, 2));
process.exitCode = result.pass ? 0 : 1;
