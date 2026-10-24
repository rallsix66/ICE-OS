#!/usr/bin/env node
/**
 * R6 acceptance lane — fault injection inside an ISOLATED fixture instance.
 *
 * Covered read paths: main detail / BS sample projection / detail attachments / admin paging.
 * Injected states: server-side SQL failure (throw), graceful failure DTO, real empty, forbidden
 * (role or grant), revoked permission mid-session and a late response that must not overwrite
 * a newer request. Nothing here targets the live run (run-20261021T100700Z-b3c4d5e6).
 *
 * Usage:
 *   node tests/catalog/ui-repair-fixture-r6.mjs --run-id <run> --lane preview --port 3012
 *   node tests/catalog/ui-repair-fixture-r6.mjs --run-id <run> --lane modules --port 3013
 */
import {
  baseUrl, createRecorder, launch, login, newLoggedInPage, ownerClient, patchFlightBody, resolveRun,
} from './ui-repair-fixture-lib.mjs';

const ADMIN = '11111111-1111-4111-8111-111111111101';
function arg(flag, fallback) { const index = process.argv.indexOf(flag); return index < 0 ? fallback : process.argv[index + 1]; }
const runId = arg('--run-id');
const port = Number(arg('--port', '3012'));
const lane = arg('--lane', 'preview');
const tag = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const run = await resolveRun(runId);
const rec = createRecorder(`r6-${lane}-${tag}`, runId);
const base = baseUrl(port);
const db = await ownerClient(run);
await db.connect();

const expectations = [];
function expect(name, condition, detail) {
  expectations.push({ name, pass: Boolean(condition), detail });
  return Boolean(condition);
}
async function q(sql, values = []) { return (await db.query(sql, values)).rows; }
async function itemByCode(code) {
  return (await q(`SELECT k.item_id, c.revision FROM catalog.catalog_item_code k JOIN catalog.item_current c ON c.item_id=k.item_id WHERE k.ice_code=$1`, [code]))[0];
}
async function withRename(table, suffix, fn) {
  const [schema, name] = table.split('.');
  const target = `${name}_${suffix}`;
  await db.query(`ALTER TABLE ${schema}.${name} RENAME TO ${target}`);
  try { return await fn(); } finally {
    const original = (await q(`SELECT to_regclass($1) AS oid`, [table]))[0].oid;
    const moved = (await q(`SELECT to_regclass($1) AS oid`, [`${schema}.${target}`]))[0].oid;
    if (moved && !original) await db.query(`ALTER TABLE ${schema}.${target} RENAME TO ${name}`);
  }
}
async function expectDirectError(page) {
  const node = page.getByTestId('catalog-detail-direct-error');
  await node.waitFor({ timeout: 120_000 });
  return { kind: await node.getAttribute('data-error-kind'), text: (await node.locator('section').innerText().catch(() => '')) ?? '' };
}
/** Tabs are client-hydrated: click until the inventory panel or its error actually renders. */
async function openInventory(page) {
  await page.waitForTimeout(1_200);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await page.getByTestId('catalog-tab-inventory').click().catch(() => {});
    const ready = await page.getByTestId('catalog-tabpanel-inventory')
      .or(page.getByTestId('catalog-bs-sample-error'))
      .first().isVisible({ timeout: 5_000 }).catch(() => false);
    if (ready) return true;
  }
  return false;
}

const browser = await launch();
try {
  /* ============ main detail read ============ */
  {
    // forbidden: operator role cannot read the catalog at all
    const opCtx = await browser.newContext({ baseURL: base });
    const opPage = await opCtx.newPage();
    await login(opPage, { email: 'operator@catalog.test', password: 'CatalogOperator123!' });
    const target = await itemByCode('WM0044');
    await opPage.goto(`/dashboard/catalog/${target.item_id}`);
    const state = await expectDirectError(opPage);
    await rec.shot(opPage, 'r6-main-forbidden');
    expect('R6-main/forbidden', state.kind === 'not_found' && /无权|不可用/.test(state.text), state);
    rec.record('main-forbidden', state);
    await opCtx.close();
  }
  {
    // read failure thrown by PostgreSQL, then independent retry after recovery
    const target = await itemByCode('WM0044');
    const { context, page } = await newLoggedInPage(browser, base);
    const fault = await withRename('catalog.item_current', 'r6probe', async () => {
      await page.goto(`/dashboard/catalog/${target.item_id}`);
      return expectDirectError(page);
    });
    await rec.shot(page, 'r6-main-read-failed');
    await page.getByRole('button', { name: /重试/ }).first().click();
    await page.getByTestId('catalog-detail-core-ready').waitFor({ timeout: 120_000 });
    const recovered = await page.getByTestId('catalog-detail-core-ready').count();
    await rec.shot(page, 'r6-main-retry-recovered');
    expect('R6-main/read-failed+retry', fault.kind === 'read_failed' && /读取失败/.test(fault.text) && recovered === 1,
      { fault, recovered });
    rec.record('main-read-failed', { fault, recovered });
    await context.close();
  }
  {
    // empty / not found must not be merged with failure
    const { context, page } = await newLoggedInPage(browser, base);
    await page.goto('/dashboard/catalog/00000000-0000-4000-8000-000000000000');
    const state = await expectDirectError(page);
    expect('R6-main/not-found', state.kind === 'not_found', state);
    rec.record('main-not-found', state);
    await context.close();
  }

  /* ============ BS sample projection ============ */
  if (lane === 'preview') {
    {
      const target = await itemByCode('WM0043');
      const { context, page } = await newLoggedInPage(browser, base);
      const fault = await withRename('catalog.bs_sample_inventory_row', 'r6probe', async () => {
        await page.goto(`/dashboard/catalog/${target.item_id}`);
        await page.getByTestId('catalog-detail-core-ready').waitFor({ timeout: 120_000 });
        await openInventory(page);
        const node = page.getByTestId('catalog-bs-sample-error');
        await node.waitFor({ timeout: 60_000 });
        return { text: (await node.innerText()) ?? '', retryButton: await node.getByRole('button', { name: '重试' }).count() };
      });
      const materialVisible = await page.getByTestId('catalog-detail-overview').count();
      const coreRetained = await page.getByTestId('catalog-detail-core-ready').count();
      await rec.shot(page, 'r6-bs-read-failed');
      await page.reload();
      await page.getByTestId('catalog-detail-core-ready').waitFor({ timeout: 120_000 });
      await openInventory(page);
      await page.getByTestId('catalog-bs-sample-inventory-table').waitFor({ timeout: 120_000 });
      const tableBack = await page.getByTestId('catalog-bs-sample-inventory-table').count();
      expect('R6-bs/read-failed+content-retained', /读取失败/.test(fault.text) && materialVisible === 1 && coreRetained === 1 && tableBack === 1,
        { fault, materialVisible, coreRetained, tableBack });
      expect('R6-bs/independent-retry-on-direct-link', fault.retryButton >= 1, { retryButton: fault.retryButton });
      rec.record('bs-read-failed', { fault, materialVisible, tableBack });
      await context.close();
    }
    {
      const target = await itemByCode('WM0043');
      const { context, page } = await newLoggedInPage(browser, base);
      // PUBLIC also holds the default EXECUTE grant, so both must be revoked for a real 42501.
      await db.query('REVOKE EXECUTE ON FUNCTION catalog.read_item_bs_sample_inventory(uuid,text) FROM PUBLIC, ice_p0_02_app_runner');
      try {
        await page.goto(`/dashboard/catalog/${target.item_id}`);
        await page.getByTestId('catalog-detail-core-ready').waitFor({ timeout: 120_000 });
        await openInventory(page);
        const node = page.getByTestId('catalog-bs-sample-error');
        await node.waitFor({ timeout: 60_000 });
        const text = (await node.innerText()) ?? '';
        await rec.shot(page, 'r6-bs-forbidden');
        expect('R6-bs/forbidden-distinct', /权限不足/.test(text) && /不是「尚未导入」/.test(text), { text });
        rec.record('bs-forbidden', { text });
      } finally {
        await db.query('GRANT EXECUTE ON FUNCTION catalog.read_item_bs_sample_inventory(uuid,text) TO PUBLIC, ice_p0_02_app_runner');
      }
      await context.close();
    }
    {
      // real empty: an item without any confirmed BS row must read as empty, not as failure
      const emptyItem = (await q(`SELECT i.id FROM catalog.catalog_item i
        WHERE NOT EXISTS (SELECT 1 FROM catalog.bs_sample_inventory_row r WHERE r.selected_item_id=i.id) ORDER BY i.id LIMIT 1`))[0];
      const { context, page } = await newLoggedInPage(browser, base);
      await page.goto(`/dashboard/catalog/${emptyItem.id}`);
      await page.getByTestId('catalog-detail-core-ready').waitFor({ timeout: 120_000 });
      await openInventory(page);
      const panel = page.getByTestId('catalog-bs-sample-panel');
      await panel.waitFor({ timeout: 60_000 });
      const text = (await panel.innerText()) ?? '';
      const errorCount = await page.getByTestId('catalog-bs-sample-error').count();
      await rec.shot(page, 'r6-bs-real-empty');
      expect('R6-bs/real-empty', errorCount === 0 && /无已确认库存|本仓无对应|无已确认|暂无样表行|0 行/.test(text), { text: text.slice(0, 240), errorCount });
      rec.record('bs-real-empty', { text: text.slice(0, 400), errorCount });
      await context.close();
    }
  }

  /* ============ attachments (module lane) ============ */
  if (lane === 'modules') {
    const uncodedId = await (async () => {
      const existing = (await q(`SELECT i.id FROM catalog.catalog_item i JOIN catalog.item_current c ON c.item_id=i.id
        JOIN catalog.item_revision r ON r.item_id=i.id AND r.revision=c.revision
        WHERE i.new_product_confirmed=true AND r.ice_code_snapshot IS NULL LIMIT 1`))[0];
      if (existing) return existing.id;
      const rows = await q(`INSERT INTO catalog.catalog_item(first_release_id,new_product_confirmed,confirmation_ref)
        VALUES(NULL,true,'FIXTURE R6 ATTACHMENT ITEM') RETURNING id`);
      const itemId = rows[0].id;
      await db.query(`INSERT INTO catalog.item_revision(item_id,revision,previous_revision,ice_code_snapshot,name_cn,fields,evidence_ref,reason,actor_id)
        VALUES($1,1,NULL,NULL,'FIXTURE R6 附件商品','{"sku":{"state":"observed","meaning":"value","raw":"FIXTURE-R6","evidenceRef":"fixture:r6"}}'::jsonb,'fixture:r6','FIXTURE R6 attachment item',$2)`, [itemId, ADMIN]);
      await db.query('INSERT INTO catalog.item_current(item_id,revision,financial_revision) VALUES($1,1,NULL)', [itemId]);
      return itemId;
    })();
    rec.record('module-uncoded-item', { uncodedId });
    {
      // scope B account has no grant on this item's scope: closest isolated "no permission" state
      const ctxB = await browser.newContext({ baseURL: base });
      const pageB = await ctxB.newPage();
      await login(pageB, { email: 'scope-b@catalog.test', password: 'CatalogScopeB123!' });
      await pageB.goto(`/dashboard/catalog/${uncodedId}`).catch(() => {});
      await pageB.waitForTimeout(5_000);
      const body = ((await pageB.locator('body').innerText().catch(() => '')) ?? '').slice(0, 400);
      const coreCount = await pageB.getByTestId('catalog-detail-core-ready').count();
      await rec.shot(pageB, 'r6-attachment-scope-b');
      expect('R6-attachments/other-scope-not-authorized', coreCount === 0 || !/来源身份|新品候选|处理入口/.test(body), { coreCount, body });
      rec.record('attachment-scope-b', { coreCount, body });
      await ctxB.close();
    }
    {
      const { context, page } = await newLoggedInPage(browser, base);
      await page.goto(`/dashboard/catalog/${uncodedId}`);
      await page.getByTestId('catalog-detail-core-ready').waitFor({ timeout: 120_000 });
      await openInventory(page);
      const processing = page.getByTestId('catalog-processing-entry');
      await processing.waitFor({ timeout: 60_000 });
      const enabledPanels = await processing.innerText();
      // both panel DTOs fail -> the direct-link attachment block must not silently disappear
      const fault = await (async () => {
        await db.query('ALTER TABLE catalog.source_scope RENAME TO source_scope_r6probe');
        await db.query('ALTER TABLE catalog.product_observation RENAME TO product_observation_r6probe');
        try {
          await page.reload();
          await page.getByTestId('catalog-detail-core-ready').waitFor({ timeout: 120_000 });
          await openInventory(page);
          await page.waitForTimeout(3_000);
          const identityError = page.getByTestId('catalog-attachment-identity-error');
          const productError = page.getByTestId('catalog-attachment-product-error');
          return {
            processingCount: await page.getByTestId('catalog-processing-entry').count(),
            identityError: (await identityError.innerText().catch(() => '')) ?? '',
            productError: (await productError.innerText().catch(() => '')) ?? '',
            identityRetry: await page.getByTestId('catalog-attachment-identity-retry').count(),
            productRetry: await page.getByTestId('catalog-attachment-product-retry').count(),
          };
        } finally {
          await db.query('ALTER TABLE catalog.source_scope_r6probe RENAME TO source_scope');
          await db.query('ALTER TABLE catalog.product_observation_r6probe RENAME TO product_observation');
        }
      })();
      await rec.shot(page, 'r6-attachments-double-failure');
      expect('R6-attachments/enabled-baseline', /来源|新品|处理/.test(enabledPanels), { enabledPanels: enabledPanels.slice(0, 300) });
      expect('R6-attachments/failure-distinct+per-side-retry',
        fault.processingCount === 1 && /读取失败/.test(fault.identityError) && /不等于未启用/.test(fault.identityError)
        && /读取失败/.test(fault.productError) && fault.identityRetry === 1 && fault.productRetry === 1, fault);
      // independent retry per side after the fixture fault is removed;
      // one side is retried while the other keeps its own error and is retried afterwards.
      await page.getByTestId('catalog-attachment-identity-retry').click();
      const identityRecovered = await (async () => {
        for (let attempt = 0; attempt < 120; attempt += 1) {
          if (await page.getByTestId('catalog-attachment-identity-error').count() === 0) return true;
          await page.waitForTimeout(250);
        }
        return false;
      })();
      const productErrorStillVisible = await page.getByTestId('catalog-attachment-product-error').count();
      if (productErrorStillVisible) {
        const productRetry = page.getByTestId('catalog-attachment-product-retry');
        for (let attempt = 0; attempt < 80; attempt += 1) {
          if (await productRetry.isEnabled().catch(() => false)) break;
          await page.waitForTimeout(250);
        }
        await productRetry.click({ timeout: 60_000 });
        for (let attempt = 0; attempt < 120; attempt += 1) {
          if (await page.getByTestId('catalog-attachment-product-error').count() === 0) break;
          await page.waitForTimeout(250);
        }
      }
      await page.getByTestId('catalog-attachment-identity').waitFor({ timeout: 60_000 });
      await page.getByTestId('catalog-attachment-product').waitFor({ timeout: 60_000 });
      expect('R6-attachments/identity-retry-recovers-alone', identityRecovered === true, { identityRecovered });
      const recovered = {
        identityError: await page.getByTestId('catalog-attachment-identity-error').count(),
        productError: await page.getByTestId('catalog-attachment-product-error').count(),
        identityText: (await page.getByTestId('catalog-attachment-identity').innerText().catch(() => '')).slice(0, 200),
        productText: (await page.getByTestId('catalog-attachment-product').innerText().catch(() => '')).slice(0, 200),
      };
      await rec.shot(page, 'r6-attachments-retried');
      expect('R6-attachments/per-side-retry-recovers', recovered.identityError === 0 && recovered.productError === 0,
        { ...recovered, productErrorStillVisible });
      rec.record('attachments-double-failure', { enabledPanels: enabledPanels.slice(0, 400), fault, recovered });
      await context.close();
    }
  }

  /* ============ admin paging ============ */
  {
    const { context, page } = await newLoggedInPage(browser, base);
    await page.goto('/dashboard/catalog/admin');
    await page.getByTestId('admin-decisions-row').first().waitFor({ timeout: 120_000 });
    const loadedRows = await page.getByTestId('admin-decisions-row').count();
    let mode = 'business';
    const handler = async (route) => {
      const request = route.request();
      if (request.method() !== 'POST') return route.fallback();
      const response = await route.fetch();
      const text = await response.text();
      // Only the decision page is faulted; the observation page must keep loading.
      if (!text.includes('"rows"') || !text.includes('"decisionId"')) {
        const headers = { ...response.headers() }; delete headers['content-length']; delete headers['content-encoding'];
        return route.fulfill({ response, headers, body: text });
      }
      if (mode === 'network') return route.abort('failed');
      let out = text;
      if (mode === 'business') {
        out = patchFlightBody(text, (parsed) => (parsed && typeof parsed === 'object' && parsed.success === true && parsed.data && Array.isArray(parsed.data.rows)
          ? { success: false, error: '注入的读取失败（隔离 fixture）' } : undefined));
      } else if (mode === 'empty') {
        out = patchFlightBody(text, (parsed) => (parsed && typeof parsed === 'object' && parsed.success === true && parsed.data && Array.isArray(parsed.data.rows)
          ? { success: true, data: { total: 0, rows: [] } } : undefined));
      }
      const headers = { ...response.headers() }; delete headers['content-length']; delete headers['content-encoding'];
      return route.fulfill({ response, headers, body: out });
    };
    await page.route('**/*', handler);
    await page.reload();
    await page.getByTestId('admin-decisions-error').waitFor({ timeout: 120_000 });
    const businessText = (await page.getByTestId('admin-decisions-error').innerText()) ?? '';
    const observationsLoaded = await page.getByTestId('admin-observations-row').count();
    await rec.shot(page, 'r6-admin-business-failure');
    expect('R6-admin/business-failure+keep-success', /读取失败/.test(businessText) && observationsLoaded > 0,
      { businessText, observationsLoaded, loadedRows });
    mode = 'pass';
    await page.getByTestId('admin-decisions-error').getByRole('button', { name: /重试/ }).click();
    await page.getByTestId('admin-decisions-row').first().waitFor({ timeout: 120_000 });
    const retriedRows = await page.getByTestId('admin-decisions-row').count();
    mode = 'network';
    await page.reload();
    await page.getByTestId('admin-decisions-error').waitFor({ timeout: 120_000 });
    const networkText = (await page.getByTestId('admin-decisions-error').innerText()) ?? '';
    await rec.shot(page, 'r6-admin-network-failure');
    mode = 'empty';
    await page.reload();
    await page.getByTestId('admin-decisions-empty').waitFor({ timeout: 120_000 });
    const emptyText = (await page.getByTestId('admin-decisions-empty').innerText()) ?? '';
    await rec.shot(page, 'r6-admin-empty');
    await page.unroute('**/*', handler);
    expect('R6-admin/network-failure', /网络或传输异常/.test(networkText), { networkText });
    expect('R6-admin/retry-restores', retriedRows > 0, { retriedRows });
    expect('R6-admin/real-empty-distinct', /不是读取失败/.test(emptyText), { emptyText });
    rec.record('admin-paging', { businessText, observationsLoaded, retriedRows, networkText, emptyText });
    await context.close();
  }
  {
    // forbidden admin page for an operator account
    const ctx = await browser.newContext({ baseURL: base });
    const page = await ctx.newPage();
    await login(page, { email: 'operator@catalog.test', password: 'CatalogOperator123!' });
    await page.goto('/dashboard/catalog/admin').catch(() => {});
    await page.waitForTimeout(4_000);
    const body = ((await page.locator('body').innerText().catch(() => '')) ?? '').slice(0, 500);
    const unavailable = await page.getByTestId('catalog-admin-unavailable').count();
    await rec.shot(page, 'r6-admin-forbidden');
    expect('R6-admin/forbidden', unavailable >= 1 || /不可用|无权/.test(body), { unavailable, body });
    rec.record('admin-forbidden', { unavailable, body });
    await ctx.close();
  }

  /* ============ revoke mid-session + late response (dialog) ============ */
  if (lane === 'preview') {
    const { context, page } = await newLoggedInPage(browser, base);
    await page.goto('/dashboard/catalog');
    await page.getByTestId('catalog-counts').waitFor({ timeout: 120_000 });
    await page.getByLabel(/搜索/).fill('WM0043');
    await page.getByTestId('catalog-row-WM0043').waitFor({ timeout: 120_000 });
    await page.getByTestId('catalog-row-WM0043').getByRole('button', { name: '查看详情' }).click();
    await page.getByTestId('catalog-detail-core-ready').waitFor({ timeout: 120_000 });
    await openInventory(page);
    const chips = page.getByTestId('catalog-inventory-warehouse').getByRole('button');
    await chips.first().waitFor({ timeout: 60_000 });
    const labels = await chips.allTextContents();
    const targetWarehouse = labels.find((label) => label && !/全部仓库/.test(label) && !/本仓无对应/.test(label)) ?? 'PH-彩妆日均万单简简单单仓';
    const chipByLabel = (name) => page.getByTestId('catalog-inventory-warehouse').getByRole('button', { name, exact: true });
    // Late response: delay the first warehouse request, then switch back to "all warehouses"
    // while it is in flight. The late first response must NOT replace the newer scope.
    let hit = 0;
    const lateHandler = async (route) => {
      const request = route.request();
      if (request.method() !== 'POST') return route.fallback();
      const postData = request.postData() ?? '';
      if (!postData.includes(targetWarehouse) && !postData.includes('warehouse')) return route.fallback();
      hit += 1;
      if (hit === 1) await new Promise((resolve) => setTimeout(resolve, 4_000));
      return route.fallback();
    };
    await page.route('**/*', lateHandler);
    await chipByLabel(targetWarehouse).click();
    await page.waitForTimeout(900);
    const allChip = chipByLabel('全部仓库');
    const secondChipAvailable = await allChip.count();
    if (secondChipAvailable) await allChip.click();
    await page.waitForTimeout(7_000); // let the delayed first response arrive after the second one
    const finalWarehouse = await page.getByTestId('catalog-detail-core-ready').getAttribute('data-warehouse');
    const allPressed = secondChipAvailable
      ? await allChip.getAttribute('aria-pressed').catch(() => null)
      : null;
    await rec.shot(page, 'r6-late-response');
    await page.unroute('**/*', lateHandler);
    if (secondChipAvailable) {
      // The delayed first response (4s) arrives after the switch back to all warehouses; the
      // visible scope, pressed chip and absence of a scope revert prove it did not win.
      expect('R6-late/last-request-wins', hit >= 1 && finalWarehouse === 'all' && allPressed === 'true',
        { hit, finalWarehouse, allPressed, targetWarehouse });
    } else {
      expect('R6-late/remount-blocks-overlap', hit >= 1 && finalWarehouse === targetWarehouse,
        { hit, finalWarehouse, targetWarehouse });
    }
    rec.record('late-response', { hit, secondChipAvailable, finalWarehouse, allPressed, targetWarehouse });
    const before = await page.getByTestId('catalog-detail-core-ready').count();
    await db.query(`UPDATE public.profiles SET role_id=(SELECT id FROM public.role WHERE name='operator') WHERE id=$1`, [ADMIN]);
    try {
      await page.reload();
      await page.waitForTimeout(4_000);
      const after = {
        coreReady: await page.getByTestId('catalog-detail-core-ready').count(),
        entryRevoked: await page.getByTestId('catalog-detail-entry-revoked').count().catch(() => 0),
        bodyTail: ((await page.locator('body').innerText().catch(() => '')) ?? '').slice(-500),
      };
      await rec.shot(page, 'r6-revoked');
      expect('R6-revoke/no-authorized-content-after-revoke', before === 1 && after.coreReady === 0
        && /无权|不可用|不存在|登录/.test(after.bodyTail), { before, after });
      rec.record('revoke', { before, after });
    } finally {
      await db.query(`UPDATE public.profiles SET role_id=(SELECT id FROM public.role WHERE name='admin') WHERE id=$1`, [ADMIN]);
    }
    await context.close();
  }
} finally {
  await browser.close();
  await db.end();
}
const failed = expectations.filter((entry) => !entry.pass);
const file = rec.finish({ pass: failed.length === 0, total: expectations.length, failed: failed.length, expectations });
console.log(JSON.stringify({ lane: 'r6', fixtureLane: lane, runId, pass: failed.length === 0, failed, total: expectations.length, evidence: file }, null, 2));
process.exitCode = failed.length === 0 ? 0 : 1;
