import { expect, test, type Browser, type Page, type Route } from '@playwright/test';
import { captureCatalogAction, patchCatalogActionFailure, type CatalogActionProbe } from './catalog-detail-action-probe.pw';

const WM0043 = 'WM0043';
const WM0072 = 'WM0072';
const AUDIT_FAILURE_MESSAGE = '审计区读取失败（隔离探针）';

async function login(page: Page) {
  await page.goto('/auth/login');
  await page.getByLabel('邮箱', { exact: true }).fill('admin@catalog.test');
  await page.getByLabel('密码', { exact: true }).fill('CatalogAdmin123!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForURL(/\/dashboard\/catalog/);
  await page.getByTestId('catalog-counts').waitFor();
}

async function openDetail(page: Page, iceCode: string) {
  await page.getByLabel(/搜索/).fill(iceCode);
  const row = page.getByTestId(`catalog-row-${iceCode}`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.getByRole('button', { name: '查看详情' }).click();
  await expect(page.getByTestId('catalog-detail-core-ready')).toBeVisible({ timeout: 30_000 });
  // item-uuid lives inside a collapsed <details>, so innerText() would be empty; textContent() is the render text.
  const itemId = ((await page.getByTestId('item-uuid').textContent()) ?? '').trim();
  expect(itemId, 'detail must belong to the requested item').toMatch(/^[0-9a-f-]{36}$/);
  return itemId;
}

function candidatesPanel(page: Page) {
  return page.locator('details').filter({ hasText: 'JST 与 BS 来源候选' });
}

/**
 * Learn the audit server-action id (and WM0043's candidate ids) from a clean session.
 *
 * The audit action id must not be guessed from request order: opening the detail fires the detail-view
 * action first and the audit prefetch second, so "first POST containing the item id" is the view action.
 * The id is therefore identified by its *response payload* (it carries `candidates`, the view carries
 * `bsSample`), and the captured id is then used to intercept the audit prefetch before it starts.
 */
async function discoverAuditAction(browser: Browser) {
  const probeCtx = await browser.newContext();
  const probePage = await probeCtx.newPage();
  await login(probePage);
  const itemId = await openDetail(probePage, WM0043);
  await candidatesPanel(probePage).locator('summary').click();
  await expect(probePage.getByRole('heading', { name: 'JST', exact: true })).toBeVisible({ timeout: 60_000 });
  const candidateIds = await probePage
    .locator('[data-testid^="catalog-candidate-"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-testid') ?? ''));
  await probeCtx.close();

  const captureCtx = await browser.newContext();
  const capturePage = await captureCtx.newPage();
  await login(capturePage);
  const seen: Array<{ actionId: string; hasCandidates: boolean; hasBsSample: boolean; bytes: number }> = [];
  const handler = async (route: Route) => {
    const request = route.request();
    if (request.method() !== 'POST') return route.fallback();
    const actionId = request.headers()['next-action'];
    if (!actionId) return route.fallback();
    if (!(request.postData() ?? '').includes(itemId)) return route.fallback();
    const response = await route.fetch();
    const text = await response.text();
    seen.push({
      actionId,
      hasCandidates: text.includes('"candidates"'),
      hasBsSample: text.includes('"bsSample"'),
      bytes: text.length,
    });
    const headers = { ...response.headers() };
    delete headers['content-length'];
    delete headers['content-encoding'];
    await route.fulfill({ response, headers, body: text });
  };
  await capturePage.route('**/*', handler);
  try {
    await openDetail(capturePage, WM0043);
    await candidatesPanel(capturePage).locator('summary').click();
    await expect(capturePage.getByRole('heading', { name: 'JST', exact: true })).toBeVisible({ timeout: 60_000 });
  } finally {
    await capturePage.unroute('**/*', handler);
    await captureCtx.close();
  }
  const audit = seen.find((entry) => entry.hasCandidates && !entry.hasBsSample);
  if (!audit) throw new Error(`AUDIT_ACTION_DISCOVERY_FAILED:${JSON.stringify(seen)}`);
  return {
    probe: { actionId: audit.actionId, contentType: 'text/plain;charset=UTF-8', bodyIncludes: itemId },
    itemId,
    candidateIds,
  };
}

type AuditPolicy = (hit: number) => { kind: 'pass' } | { kind: 'fail'; message: string } | { kind: 'delay'; ms: number };

/**
 * The intercept is installed before the detail is opened, because the audit prefetch fires on mount.
 * Waiting for the prefetch to succeed first and only then injecting would not test the first request.
 */
async function installAuditRoute(page: Page, probe: CatalogActionProbe, policy: AuditPolicy) {
  const state = { hits: 0 };
  // In-flight handler work must settle before the page closes, otherwise Playwright reports a teardown
  // error that has nothing to do with the assertion under test.
  const pending = new Set<Promise<void>>();
  const handle = async (route: Route) => {
    const request = route.request();
    if (request.method() !== 'POST') return route.fallback();
    if (request.headers()['next-action'] !== probe.actionId) return route.fallback();
    if (!(request.postData() ?? '').includes(probe.bodyIncludes)) return route.fallback();
    state.hits += 1;
    const action = policy(state.hits);
    if (action.kind === 'fail') {
      const response = await route.fetch();
      const text = await response.text();
      const body = patchCatalogActionFailure(text, action.message);
      const headers = { ...response.headers() };
      delete headers['content-length'];
      delete headers['content-encoding'];
      await route.fulfill({ response, headers, body });
      return;
    }
    if (action.kind === 'delay') {
      await new Promise((resolve) => setTimeout(resolve, action.ms));
      return route.fallback();
    }
    return route.fallback();
  };
  const handler = (route: Route) => {
    const task = handle(route) as Promise<void>;
    pending.add(task);
    return task.finally(() => { pending.delete(task); });
  };
  await page.route('**/*', handler);
  return {
    state,
    dispose: async () => {
      const deadline = Date.now() + 15_000;
      while (pending.size > 0 && Date.now() < deadline) {
        await Promise.allSettled([...pending]);
        if (pending.size > 0) await page.waitForTimeout(50);
      }
      await page.unroute('**/*', handler);
    },
  };
}

test.describe('catalog detail partition recovery', () => {
  test('persistent audit failure does not auto-loop and keeps the error visible', async ({ browser }) => {
    const { probe } = await discoverAuditAction(browser);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await login(page);
    const route = await installAuditRoute(page, probe, () => ({ kind: 'fail', message: AUDIT_FAILURE_MESSAGE }));
    try {
      await openDetail(page, WM0043);
      await candidatesPanel(page).locator('summary').click();
      const error = page.getByTestId('catalog-audit-error');
      await expect(error).toBeVisible({ timeout: 60_000 });
      await expect(error).toContainText(AUDIT_FAILURE_MESSAGE);
      // Opening the other audit partition must not start another request either.
      await page.locator('details').filter({ hasText: '来源差异与原始观测 JSON' }).locator('summary').click();
      await page.waitForTimeout(1_500);
      await expect(error).toBeVisible();
      expect(route.state.hits, 'one bounded prefetch only').toBe(1);
      await expect(page.locator('[data-testid^="catalog-candidate-"]')).toHaveCount(0);
    } finally {
      await route.dispose();
      await ctx.close();
    }
  });

  test('manual retry issues one request and restores candidates', async ({ browser }) => {
    const { probe } = await discoverAuditAction(browser);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await login(page);
    const route = await installAuditRoute(page, probe, (hit) => (
      hit === 1 ? { kind: 'fail', message: AUDIT_FAILURE_MESSAGE } : { kind: 'pass' }
    ));
    try {
      await openDetail(page, WM0043);
      await candidatesPanel(page).locator('summary').click();
      const error = page.getByTestId('catalog-audit-error');
      await expect(error).toBeVisible({ timeout: 60_000 });
      expect(route.state.hits).toBe(1);
      await error.getByRole('button', { name: '重试' }).click();
      await expect(page.getByRole('heading', { name: 'JST', exact: true })).toBeVisible({ timeout: 60_000 });
      await expect(page.locator('[data-testid^="catalog-candidate-"]').first()).toBeVisible();
      expect(route.state.hits, 'retry must send exactly one extra request').toBe(2);
      await expect(error).toHaveCount(0);
    } finally {
      await route.dispose();
      await ctx.close();
    }
  });

  test('rapid expand while the prefetch is still in flight waits for the first response', async ({ browser }) => {
    const { probe } = await discoverAuditAction(browser);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await login(page);
    let delayed = false;
    const route = await installAuditRoute(page, probe, () => {
      if (delayed) return { kind: 'pass' };
      delayed = true;
      return { kind: 'delay', ms: 1_500 };
    });
    try {
      await openDetail(page, WM0043);
      await candidatesPanel(page).locator('summary').click();
      await expect(page.getByRole('heading', { name: 'JST', exact: true })).toBeVisible({ timeout: 60_000 });
      expect(route.state.hits, 'expanding must not duplicate the in-flight prefetch').toBe(1);
      await expect(page.locator('[data-testid^="catalog-candidate-"]').first()).toBeVisible();
    } finally {
      await route.dispose();
      await ctx.close();
    }
  });

  test('late audit response after closing and switching never leaks into another item', async ({ browser }) => {
    const { probe, candidateIds } = await discoverAuditAction(browser);
    expect(candidateIds.length).toBeGreaterThan(0);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await login(page);
    let delayed = false;
    const route = await installAuditRoute(page, probe, () => {
      if (delayed) return { kind: 'pass' };
      delayed = true;
      return { kind: 'delay', ms: 2_000 };
    });
    try {
      await openDetail(page, WM0043);
      await page.getByLabel('关闭商品详情').click();
      await expect(page.getByTestId(`catalog-row-${WM0043}`)).toBeVisible();
      const wm0072ItemId = await openDetail(page, WM0072);
      await candidatesPanel(page).locator('summary').click();
      await expect(page.getByRole('heading', { name: 'JST', exact: true })).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId('item-uuid')).toHaveText(wm0072ItemId);
      // Wait for the delayed WM0043 response to be delivered, then prove it did not land here.
      await page.waitForTimeout(2_500);
      await expect(page.getByTestId('item-uuid')).toHaveText(wm0072ItemId);
      for (const testId of candidateIds) {
        await expect(page.getByTestId(testId)).toHaveCount(0);
      }
      await expect(page.getByRole('heading', { name: 'JST', exact: true })).toBeVisible();
    } finally {
      await route.dispose();
      await ctx.close();
    }
  });

  test('restricted amounts: transport failure clears values and retry works', async ({ browser }) => {
    const discoverCtx = await browser.newContext();
    const discoverPage = await discoverCtx.newPage();
    await login(discoverPage);
    const itemId = await openDetail(discoverPage, WM0043);
    const detailProbe = await captureCatalogAction(discoverPage, async () => {
      await discoverPage.getByTestId('load-restricted-amounts').click();
      await expect(discoverPage.getByTestId('restricted-amounts')).toBeVisible({ timeout: 15_000 });
    }, itemId);
    await discoverCtx.close();

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await login(page);
    await openDetail(page, WM0043);

    let hits = 0;
    await page.route('**/*', async (route) => {
      const request = route.request();
      if (request.method() !== 'POST') return route.fallback();
      if (request.headers()['next-action'] !== detailProbe.actionId) return route.fallback();
      const postData = request.postData() ?? '';
      if (!postData.includes(detailProbe.bodyIncludes)) return route.fallback();
      hits += 1;
      if (hits === 1) return route.abort('failed');
      return route.fallback();
    });
    await page.getByTestId('load-restricted-amounts').click();
    await expect(page.getByTestId('restricted-amounts-error')).toBeVisible();
    await expect(page.getByTestId('restricted-amounts')).toHaveCount(0);
    await page.getByTestId('load-restricted-amounts').click();
    await expect(page.getByTestId('restricted-amounts')).toBeVisible({ timeout: 15_000 });
    expect(hits).toBeGreaterThanOrEqual(1);
    await ctx.close();
  });
});
