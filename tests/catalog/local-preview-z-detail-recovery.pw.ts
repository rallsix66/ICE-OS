import { expect, test, type Browser, type Page, type Route } from '@playwright/test';
import { patchCatalogActionFailure, type CatalogActionProbe } from './catalog-detail-action-probe.pw';

/**
 * v3（V3-01/V3-08）：来源与授权证据不再是独立页面，而是**同一商品弹窗内的子视图**
 * （`catalog-detail-more` → `catalog-more-evidence` → `catalog-evidence-view`，`catalog-evidence-back` 原位返回）。
 *
 * 本文件保留 v2 的失败恢复语义并迁移到子视图：
 * - 有界一次性审计请求、失败后只手动重试、迟到响应不串商品；
 * - 受限金额按需读取、传输失败清空旧值且可重试；
 * - 日常详情仍不得出现技术证据（原始 JSON/UUID/金额按钮）。
 */
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

function row(page: Page, iceCode: string) {
  return page.getByTestId(`catalog-row-${iceCode}`);
}

/** 从列表真实点击打开统一弹窗；返回该商品的 UUID（v3 仍由 URL detail 参数承载）。 */
async function openDetailFromList(page: Page, iceCode: string) {
  await page.getByLabel(/搜索/).fill(iceCode);
  const target = row(page, iceCode);
  await expect(target).toBeVisible({ timeout: 30_000 });
  await target.getByRole('button', { name: /查看详情|查看/ }).first().click();
  await expect(page.getByTestId('catalog-detail-core-ready')).toBeVisible({ timeout: 30_000 });
  const itemId = new URL(page.url()).searchParams.get('detail') ?? '';
  expect(itemId, 'detail URL must carry the item UUID').toMatch(/^[0-9a-f-]{36}$/);
  return itemId;
}

async function closeDialog(page: Page) {
  const v3 = page.getByTestId('catalog-detail-close');
  if (await v3.count()) { await v3.click(); return; }
  await page.getByLabel('关闭商品详情').click();
}

async function resolveItemId(page: Page, iceCode: string) {
  const itemId = await openDetailFromList(page, iceCode);
  await closeDialog(page);
  await expect(row(page, iceCode)).toBeVisible();
  return itemId;
}

function evidenceView(page: Page) {
  return page.getByTestId('catalog-evidence-view');
}

/** 打开弹窗内“来源与证据”子视图（更多菜单 → 菜单项），并等到非 loading 终态。 */
async function openEvidenceSubview(page: Page) {
  const more = page.getByTestId('catalog-detail-more');
  await expect(more).toBeVisible({ timeout: 30_000 });
  if ((await more.getAttribute('open')) === null) await more.locator('summary').click();
  const entry = page.getByTestId('catalog-more-evidence');
  await expect(entry).toBeVisible({ timeout: 30_000 });
  await entry.click();
  const view = evidenceView(page);
  await expect(view).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => view.getAttribute('data-evidence-state'), { timeout: 60_000 })
    .not.toBe('loading');
  return view;
}

function candidates(page: Page) {
  /* V4-02：来源子视图改为业务记录；测试仍要求真实记录行存在。 */
  return page.locator('[data-testid^="source-record-"]');
}

/**
 * 学习审计 server action id：打开子视图时审计请求自动发起一次（有界），
 * 用响应负载识别（带 candidates 且不带 bsSample/金额），不靠请求顺序猜。
 */
async function discoverAuditAction(browser: Browser, itemId: string): Promise<CatalogActionProbe> {
  const probeCtx = await browser.newContext();
  const probePage = await probeCtx.newPage();
  await login(probePage);
  const seen: Array<{ actionId: string; hasCandidates: boolean; hasSourceView: boolean; hasBsSample: boolean; hasAmounts: boolean }> = [];
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
      hasSourceView: text.includes('"systems"') && text.includes('"sourceRecorded"'),
      hasBsSample: text.includes('"bsSample"'),
      hasAmounts: text.includes('"operatingPrice"') || text.includes('"amountCny"'),
    });
    const headers = { ...response.headers() };
    delete headers['content-length'];
    delete headers['content-encoding'];
    await route.fulfill({ response, headers, body: text });
  };
  await probePage.route('**/*', handler);
  try {
    await openDetailFromList(probePage, WM0043);
    await openEvidenceSubview(probePage);
    await expect(probePage.getByTestId('evidence-audit-state')).toBeVisible({ timeout: 60_000 });
  } finally {
    await probePage.unroute('**/*', handler);
    await probeCtx.close();
  }
  const audit = seen.find((entry) => entry.hasSourceView && !entry.hasBsSample);
  if (!audit) throw new Error(`AUDIT_ACTION_DISCOVERY_FAILED:${JSON.stringify(seen)}`);
  return { actionId: audit.actionId, contentType: 'text/plain;charset=UTF-8', bodyIncludes: itemId };
}

type AuditPolicy = (hit: number) => { kind: 'pass' } | { kind: 'fail'; message: string } | { kind: 'delay'; ms: number };

async function installAuditRoute(page: Page, probe: CatalogActionProbe, policy: AuditPolicy) {
  const state = { hits: 0 };
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

test.describe('catalog evidence subview recovery (v3 unified dialog)', () => {
  test('persistent audit failure does not auto-loop and keeps the error visible in-dialog', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await login(page);
    const itemId = await resolveItemId(page, WM0043);
    const probe = await discoverAuditAction(browser, itemId);
    const route = await installAuditRoute(page, probe, () => ({ kind: 'fail', message: AUDIT_FAILURE_MESSAGE }));
    try {
      await openDetailFromList(page, WM0043);
      const view = await openEvidenceSubview(page);
      await expect(page.getByTestId('evidence-audit-state')).toHaveAttribute('data-audit-state', 'error', { timeout: 60_000 });
      await expect(view).toContainText('来源记录读取失败');
      await expect(page.getByTestId('evidence-candidate-count')).toHaveText('—');
      await page.waitForTimeout(1_500);
      expect(route.state.hits, 'one bounded prefetch only').toBe(1);
      await expect(candidates(page)).toHaveCount(0);
      // 原位返回后，日常详情仍不得出现技术证据
      await page.getByTestId('catalog-evidence-back').click();
      await expect(evidenceView(page)).toHaveCount(0);
      for (const forbidden of ['catalog-audit-json', 'evidence-raw-json', 'item-uuid', 'bs-basis-sha']) {
        await expect(page.getByTestId(forbidden), `${forbidden} must stay out of daily detail`).toHaveCount(0);
      }
    } finally {
      await route.dispose();
      await ctx.close();
    }
  });

  test('manual retry issues one request and restores candidates + raw evidence', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await login(page);
    const itemId = await resolveItemId(page, WM0043);
    const probe = await discoverAuditAction(browser, itemId);
    const route = await installAuditRoute(page, probe, (hit) => (hit === 1 ? { kind: 'fail', message: AUDIT_FAILURE_MESSAGE } : { kind: 'pass' }));
    try {
      await openDetailFromList(page, WM0043);
      const view = await openEvidenceSubview(page);
      await expect(page.getByTestId('evidence-audit-state')).toHaveAttribute('data-audit-state', 'error', { timeout: 60_000 });
      expect(route.state.hits).toBe(1);
      const retry = view.getByRole('button', { name: '重试' }).first();
      await expect(retry).toBeVisible();
      await retry.click();
      await expect(page.getByTestId('evidence-audit-state')).toHaveAttribute('data-audit-state', 'loaded', { timeout: 60_000 });
      await expect(page.getByTestId('evidence-candidate-count')).toHaveText(/\d+/);
      await expect(candidates(page).first()).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId('evidence-amounts')).toContainText('2.94');
      expect(route.state.hits, 'retry must send exactly one extra request').toBe(2);
    } finally {
      await route.dispose();
      await ctx.close();
    }
  });

  test('delayed first audit response renders once without duplicating the request', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await login(page);
    const itemId = await resolveItemId(page, WM0043);
    const probe = await discoverAuditAction(browser, itemId);
    let delayed = false;
    const route = await installAuditRoute(page, probe, () => {
      if (delayed) return { kind: 'pass' };
      delayed = true;
      return { kind: 'delay', ms: 1_500 };
    });
    try {
      await openDetailFromList(page, WM0043);
      const view = await openEvidenceSubview(page);
      await expect(view).toHaveAttribute('data-evidence-state', /ready|empty/, { timeout: 60_000 });
      await expect(page.getByTestId('evidence-audit-state')).toHaveAttribute('data-audit-state', /loaded|empty/, { timeout: 60_000 });
      expect(route.state.hits, 'opening the subview must not duplicate the in-flight prefetch').toBe(1);
    } finally {
      await route.dispose();
      await ctx.close();
    }
  });

  test('late audit response after switching items never leaks into another item', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await login(page);
    const wm0043ItemId = await resolveItemId(page, WM0043);
    const wm0072ItemId = await resolveItemId(page, WM0072);
    const probe = await discoverAuditAction(browser, wm0043ItemId);
    const candidatesBefore = await (async () => {
      const probeCtx = await browser.newContext();
      const probePage = await probeCtx.newPage();
      await login(probePage);
      await openDetailFromList(probePage, WM0043);
      await openEvidenceSubview(probePage);
      await expect(candidates(probePage).first()).toBeVisible({ timeout: 60_000 });
      const ids = await candidates(probePage).evaluateAll((els) => els.map((el) => el.getAttribute('data-testid') ?? ''));
      await probeCtx.close();
      return ids;
    })();
    expect(candidatesBefore.length).toBeGreaterThan(0);
    let delayed = false;
    const route = await installAuditRoute(page, probe, () => {
      if (delayed) return { kind: 'pass' };
      delayed = true;
      return { kind: 'delay', ms: 2_000 };
    });
    try {
      await openDetailFromList(page, WM0043);
      await openEvidenceSubview(page);          // 审计迟到
      await closeDialog(page);
      await openDetailFromList(page, WM0072);   // 切到另一个商品
      const view = await openEvidenceSubview(page);
      await expect(view).toHaveAttribute('data-evidence-state', /ready|empty/, { timeout: 60_000 });
      const subject = page.getByTestId('catalog-evidence-subject');
      await expect(subject).toContainText('WM0072', { timeout: 60_000 });
      await expect(subject).not.toContainText('WM0043');
      await expect(subject).not.toContainText(wm0072ItemId);
      await page.waitForTimeout(2_500);
      await expect(subject).toContainText('WM0072');
      await expect(subject).not.toContainText(wm0043ItemId);
      for (const testId of candidatesBefore) await expect(page.getByTestId(testId)).toHaveCount(0);
    } finally {
      await route.dispose();
      await ctx.close();
    }
  });

  test('price read failure clears values and retry restores the business source view', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await login(page);
    const itemId = await resolveItemId(page, WM0043);
    const probe = await discoverAuditAction(browser, itemId);
    const route = await installAuditRoute(page, probe, (hit) => (hit === 1 ? { kind: 'fail', message: AUDIT_FAILURE_MESSAGE } : { kind: 'pass' }));
    try {
      await openDetailFromList(page, WM0043);
      const view = await openEvidenceSubview(page);
      await expect(view).toHaveAttribute('data-evidence-state', 'error', { timeout: 60_000 });
      /* 失败时整块来源内容不可用：旧价格不显示，也不当成 0。 */
      await expect(page.getByTestId('evidence-amounts')).toHaveCount(0);
      await view.getByRole('button', { name: /重试/ }).first().click();
      await expect(view).toHaveAttribute('data-evidence-state', 'ready', { timeout: 60_000 });
      await expect(page.getByTestId('evidence-amounts')).toContainText('2.94', { timeout: 30_000 });
      expect(route.state.hits).toBeGreaterThanOrEqual(2);
    } finally {
      await route.dispose();
      await ctx.close();
    }
  });
});
