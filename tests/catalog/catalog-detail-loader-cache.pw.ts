import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * 详情 loader 缓存负向与 R4 刷新语义（UI 补修包 v2 / repair-matrix §4）。
 *
 * 本包把日常详情拆成固定外壳 + 三分区（商品资料 / 库存明细 / 变更记录），库存表与 BS 错误态
 * 只存在于「库存明细」分区，因此相关断言必须先真实点击分区再断言内容；技术证据（SHA/UUID/
 * 受限金额）已退出日常详情，只能从授权维护页读取，本文件改为断言它们**不存在**于日常详情。
 */
const WM0043_ID = 'f579a67f-cce9-41e8-8b22-d91f3d1313f6';
const WM0072 = 'WM0072';

async function login(page: Page) {
  await page.goto('/auth/login');
  await page.getByLabel('邮箱', { exact: true }).fill('admin@catalog.test');
  await page.getByLabel('密码', { exact: true }).fill('CatalogAdmin123!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForURL(/\/dashboard\/catalog/);
  await page.getByTestId('catalog-counts').waitFor();
}

async function openWm0043FromList(page: Page) {
  await page.getByRole('searchbox').first().fill('WM0043');
  await expect(page.getByTestId('catalog-row-WM0043')).toBeVisible();
  await page.getByRole('button', { name: '详情', exact: true }).first().click();
}

async function openFromList(page: Page, iceCode: string) {
  await page.getByRole('searchbox').first().fill(iceCode);
  const row = page.getByTestId(`catalog-row-${iceCode}`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.getByRole('button', { name: '详情', exact: true }).click();
}

/** 分区必须真实点击（不得用注入 CSS/JS 强制显示）。 */
async function openSection(page: Page, section: 'material' | 'inventory' | 'history') {
  const tab = page.getByTestId(`catalog-tab-${section}`);
  await expect(tab).toBeVisible();
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}

function patchDetailPayload(body: string, itemId: string, transform: (data: Record<string, unknown>) => void): string {
  return body.split('\n').map((line) => {
    const match = line.match(/^([0-9a-f]+):(\{.*\})$/i);
    if (!match) return line;
    try {
      const data = JSON.parse(match[2]) as { success?: boolean; data?: { item?: { itemId?: string } } };
      if (data.success !== true || data.data?.item?.itemId !== itemId) return line;
      transform(data as Record<string, unknown>);
      return `${match[1]}:${JSON.stringify(data)}`;
    } catch {
      return line;
    }
  }).join('\n');
}

/**
 * 只改写详情读取的 server action 响应。
 * `times` 用于“只污染首个响应”的场景（R4：列表版本变化后的重新取数必须拿到真实内容）。
 */
async function withDetailPatch(
  page: Page,
  itemId: string,
  transform: (data: Record<string, unknown>) => void,
  run: (counts: { patched: () => number; fetches: () => number }) => Promise<void>,
  options: { times?: number } = {},
) {
  let hits = 0;
  let fetches = 0;
  const limit = options.times ?? Number.POSITIVE_INFINITY;
  // The detail mount also issues the audit prefetch, which passes through this handler. Its fetch must
  // finish before the page closes, otherwise Playwright reports a teardown error unrelated to the test.
  const pending = new Set<Promise<void>>();
  const handler = (route: Route) => {
    const request = route.request();
    if (request.method() !== 'POST' || !request.headers()['next-action']) return route.fallback();
    if (!(request.postData() ?? '').includes(itemId)) return route.fallback();
    const task = (async () => {
      const response = await route.fetch();
      const text = await response.text();
      fetches += 1;
      if (hits >= limit) {
        const headers = { ...response.headers() };
        delete headers['content-length'];
        delete headers['content-encoding'];
        await route.fulfill({ response, headers, body: text });
        return;
      }
      const body = patchDetailPayload(text, itemId, transform);
      if (body !== text) hits += 1;
      const headers = { ...response.headers() };
      delete headers['content-length'];
      delete headers['content-encoding'];
      await route.fulfill({ response, headers, body });
    })();
    pending.add(task);
    return task.finally(() => { pending.delete(task); });
  };
  await page.route('**/*', handler);
  try {
    await run({ patched: () => hits, fetches: () => fetches });
  } finally {
    const deadline = Date.now() + 15_000;
    while (pending.size > 0 && Date.now() < deadline) {
      await Promise.allSettled([...pending]);
      if (pending.size > 0) await page.waitForTimeout(50);
    }
    await page.unroute('**/*', handler);
  }
  return hits;
}

type R4RefreshDrift = {
  detailFetches: () => number;
  listRefreshes: () => number;
};

/**
 * R4「列表刷新导致详情重新取数，但不得重挂载抹掉草稿/当前分区」的浏览器内探针（**不写库**）。
 *
 * 现役 126 样本只读，因此绝不用真实保存推进版本，也不用改写列表 RSC payload
 * （实测该 flight 响应里没有可直接改写的 `itemRevision` 明文，见本轮报告：
 * rewrite 命中 0 次、trace 留存）。这里只用 `page.route` 改写本次浏览器会话的详情响应：
 * 1. 首个详情响应只改估值口径投影 → 详情与列表投影不一致，出现「刷新列表」入口；
 *    版本不变，因此不会触发自动 router.refresh，草稿可以先填好；
 * 2. 点同步提示条里的「刷新列表」= 真实列表 router.refresh()（列表工具栏另有同名 aria-label 按钮，
 *    因此点击必须在提示条范围内定位）→ 详情重新取数（第 2 次响应）；
 *    这次只改一个业务字段（生产工厂），版本仍不变 → 内容更新但不会形成刷新环。
 * 列表刷新只计数（排除 prefetch），详情取数次数是「重新取数」的直接证据。
 */
async function withR4RefreshDrift(page: Page, itemId: string, run: (drift: R4RefreshDrift) => Promise<void>) {
  const state = { detailFetches: 0, listRefreshes: 0 };
  const pending = new Set<Promise<void>>();
  const handle = async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = request.headers();
    if (request.method() === 'POST' && headers['next-action'] && (request.postData() ?? '').includes(itemId)) {
      state.detailFetches += 1;
      const response = await route.fetch();
      const text = await response.text();
      const body = state.detailFetches === 1
        ? patchDetailPayload(text, itemId, (data) => {
            const payload = data.data as { bsSample?: { basisDocumentSha256?: string } };
            if (payload.bsSample) payload.bsSample.basisDocumentSha256 = 'f'.repeat(64);
          })
        : patchDetailPayload(text, itemId, (data) => {
            const payload = data.data as { item: { fields: Record<string, unknown> } };
            payload.item.fields.factory = { state: 'observed', meaning: 'value', raw: 'R4 REFETCHED FACTORY', evidenceRef: 'fixture:pw-r4' };
          });
      const responseHeaders = { ...response.headers() };
      delete responseHeaders['content-length'];
      delete responseHeaders['content-encoding'];
      await route.fulfill({ response, headers: responseHeaders, body });
      return;
    }
    if (request.method() === 'GET' && headers.rsc === '1' && headers['next-router-prefetch'] !== '1'
      && url.pathname === '/dashboard/catalog') {
      state.listRefreshes += 1;
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
  try {
    await run({
      detailFetches: () => state.detailFetches,
      listRefreshes: () => state.listRefreshes,
    });
  } finally {
    const deadline = Date.now() + 15_000;
    while (pending.size > 0 && Date.now() < deadline) {
      await Promise.allSettled([...pending]);
      if (pending.size > 0) await page.waitForTimeout(50);
    }
    await page.unroute('**/*', handler);
  }
}

const DETAIL_DIALOG = 'catalog-detail-dialog';

/** v3 统一弹窗关闭：优先契约 testid，回退旧可访问名。 */
async function closeDetail(page: Page, options: { timeout?: number } = {}) {
  const v3 = page.getByTestId('catalog-detail-close');
  if (await v3.count()) return v3.click({ timeout: options.timeout });
  return page.getByLabel('关闭商品详情').click({ timeout: options.timeout });
}

test.describe('catalog detail loader cache negatives', () => {
  test('BS inventory read_failed shows core and inventory error (not projection spinner)', async ({ page }) => {
    await login(page);
    await withDetailPatch(page, WM0043_ID, (data) => {
      const payload = data.data as Record<string, unknown>;
      payload.bsSample = null;
      payload.bsSampleError = { code: 'read_failed', message: 'BS 样表库存投影读取失败（测试注入）' };
    }, async () => {
      await openWm0043FromList(page);
      await expect(page.getByTestId('catalog-detail-core-ready')).toBeVisible({ timeout: 60_000 });
      await openSection(page, 'inventory');
      await expect(page.getByTestId('catalog-bs-sample-error')).toBeVisible();
      await expect(page.getByTestId('catalog-detail-fetch-error')).toHaveCount(0);
      await expect(page.getByText('正在切换仓库投影…')).toHaveCount(0);
    });
  });

  test('detail revision ahead of list shows core and list sync notice', async ({ page }) => {
    await login(page);
    await withDetailPatch(page, WM0043_ID, (data) => {
      const payload = data.data as { item: { revision: number } };
      payload.item.revision += 1;
    }, async () => {
      await openWm0043FromList(page);
      await expect(page.getByTestId('catalog-detail-core-ready')).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId('catalog-detail-list-sync-notice')).toBeVisible();
      await expect(page.getByText('正在切换仓库投影…')).toHaveCount(0);
    });
  });

  test('display basis drift marks detail stale until list authority syncs', async ({ page }) => {
    await login(page);
    await openWm0043FromList(page);
    await expect(page.getByTestId('catalog-detail-core-ready')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('catalog-detail-core-ready')).toHaveAttribute('data-content-fresh', 'true');
    await expect(page.getByTestId('catalog-detail-core-ready')).toHaveAttribute('data-list-projection-synced', 'true');
    // U3：估值口径 SHA 是技术证据，已退出日常详情（只能从授权维护页读取）。
    await expect(page.getByTestId('bs-basis-sha')).toHaveCount(0);
    const mutatedSha = `${'a'.repeat(64)}`;
    await closeDetail(page);
    await withDetailPatch(page, WM0043_ID, (data) => {
      const payload = data.data as { bsSample?: { basisDocumentSha256?: string } };
      if (payload.bsSample) payload.bsSample.basisDocumentSha256 = mutatedSha;
    }, async () => {
      await page.getByRole('button', { name: '详情', exact: true }).first().click();
      await expect(page.getByTestId('catalog-detail-core-ready')).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId('catalog-detail-core-ready')).toHaveAttribute('data-content-fresh', 'false');
      await expect(page.getByTestId('catalog-detail-core-ready')).toHaveAttribute('data-list-projection-synced', 'false');
      await expect(page.getByTestId('catalog-detail-list-sync-notice')).toBeVisible();
      const dialogText = await page.getByRole('dialog').innerText();
      expect(dialogText, 'daily detail must not print the valuation basis fingerprint').not.toContain(mutatedSha);
    });
    await page.getByTestId('catalog-detail-list-sync-notice').getByRole('button', { name: '刷新列表' }).click();
    await expect(page.getByTestId('catalog-row-WM0043')).toBeVisible();
    await expect(page.getByTestId('catalog-detail-core-ready')).toHaveAttribute('data-content-fresh', 'true');
    await expect(page.getByTestId('catalog-detail-core-ready')).toHaveAttribute('data-list-projection-synced', 'true');
  });

  test('background forbidden after cache hit masks amounts and blocks fresh core', async ({ page }) => {
    await login(page);
    await openWm0043FromList(page);
    await expect(page.getByTestId('catalog-detail-core-ready')).toBeVisible({ timeout: 60_000 });
    await closeDetail(page);
    await withDetailPatch(page, WM0043_ID, (data) => {
      (data as { success?: boolean; error?: string }).success = false;
      (data as { success?: boolean; error?: string }).error = '权限不足（测试注入）';
      delete (data as { data?: unknown }).data;
    }, async () => {
      await page.getByRole('button', { name: '详情', exact: true }).first().click();
      await expect(page.getByTestId('catalog-detail-fetch-error')).toContainText('权限', { timeout: 60_000 });
      await expect(page.getByTestId('catalog-detail-core-ready')).toHaveCount(0);
      // 授权失守后不得继续渲染任何金额：概览四卡与库存/资料分区都不存在，弹层内无人民币金额。
      await expect(page.getByTestId('catalog-detail-overview')).toHaveCount(0);
      await expect(page.getByTestId('catalog-overview-valuated')).toHaveCount(0);
      await expect(page.getByTestId('bs-estimated-value')).toHaveCount(0);
      const dialogText = await page.getByRole('dialog').innerText();
      expect(dialogText).not.toMatch(/¥/);
    });
  });

  test('list sync notice refresh triggers list reload without spinner lock', async ({ page }) => {
    await login(page);
    await withDetailPatch(page, WM0043_ID, (data) => {
      const payload = data.data as { item: { revision: number } };
      payload.item.revision += 1;
    }, async () => {
      await openWm0043FromList(page);
      await expect(page.getByTestId('catalog-detail-list-sync-notice')).toBeVisible({ timeout: 60_000 });
      await page.getByTestId('catalog-detail-list-sync-notice').getByRole('button', { name: '刷新列表' }).click();
      await expect(page.getByTestId('catalog-row-WM0043')).toBeVisible();
      await expect(page.getByText('正在切换仓库投影…')).toHaveCount(0);
    });
  });

  test('late detail response does not overwrite newer open (request seq)', async ({ page }) => {
    await login(page);
    let delayed = false;
    await page.route('**/*', async (route) => {
      const request = route.request();
      if (request.method() !== 'POST' || !request.headers()['next-action']) return route.fallback();
      if (!(request.postData() ?? '').includes(WM0043_ID)) return route.fallback();
      if (!delayed) {
        delayed = true;
        await new Promise((r) => setTimeout(r, 1200));
      }
      return route.fallback();
    });
    await page.getByRole('searchbox').first().fill('WM0043');
    await page.getByRole('button', { name: '详情', exact: true }).first().click();
    await closeDetail(page, { timeout: 5000 }).catch(() => {});
    await page.getByRole('searchbox').first().fill('WM0072');
    await page.getByRole('button', { name: '详情', exact: true }).first().click();
    // 身份来自详情 DTO（catalog-material-ice-code），不是列表摘要，才能证明迟到响应没覆盖新开启的详情。
    await expect(page.getByTestId('catalog-material-ice-code')).toContainText('WM0072', { timeout: 60_000 });
    await expect(page.getByTestId('catalog-material-ice-code')).not.toContainText('WM0043');
    await page.waitForTimeout(1500);
    await expect(page.getByTestId('catalog-material-ice-code')).toContainText('WM0072');
    await expect(page.getByTestId('catalog-material-ice-code')).not.toContainText('WM0043');
    await page.unroute('**/*');
  });

  test('locked quantity drift in detail still renders core (not projection spinner)', async ({ page }) => {
    await login(page);
    await withDetailPatch(page, WM0043_ID, (data) => {
      const payload = data.data as { bsSample?: { rows?: Array<{ orderLocked?: number }> } };
      const row = payload.bsSample?.rows?.[0];
      if (row) row.orderLocked = (row.orderLocked ?? 0) + 999;
    }, async () => {
      await openWm0043FromList(page);
      await expect(page.getByTestId('catalog-detail-core-ready')).toBeVisible({ timeout: 60_000 });
      await openSection(page, 'inventory');
      await expect(page.getByTestId('catalog-bs-sample-panel')).toBeVisible();
      await expect(page.getByText('正在切换仓库投影…')).toHaveCount(0);
    });
  });

  /**
   * R4：列表刷新必须触发详情重新取数（fetch 次数与内容都更新），当前分区不得被重置。
   * 日常弹窗已不再提供编辑入口（编辑能力只保留在低频直链页），因此不再断言编辑草稿。
   * 全程只用浏览器会话内的响应改写，不写现役库。
   */
  test('list refresh refetches detail and keeps the current section', async ({ page }) => {
    await login(page);
    await openFromList(page, WM0072);
    await expect(page.getByTestId('catalog-detail-core-ready')).toBeVisible({ timeout: 60_000 });
    const itemId = new URL(page.url()).searchParams.get('detail') ?? '';
    expect(itemId).toMatch(/^[0-9a-f-]{36}$/);
    await closeDetail(page);
    await expect(page.getByTestId('catalog-row-WM0072')).toBeVisible();

    await withR4RefreshDrift(page, itemId, async (drift) => {
      await openFromList(page, WM0072);
      await expect(page.getByTestId('catalog-detail-core-ready')).toBeVisible({ timeout: 60_000 });
      // 第 1 个响应只改估值口径投影：出现「刷新列表」入口，但版本不变、不会自动刷新。
      await expect(page.getByTestId('catalog-detail-list-sync-notice')).toBeVisible({ timeout: 60_000 });

      // 保持「商品资料」分区。
      await openSection(page, 'material');
      await expect(page.getByTestId('catalog-tab-material')).toHaveAttribute('aria-selected', 'true');

      // 真实列表刷新（router.refresh）→ 详情必须重新取数。
      await page.getByTestId('catalog-detail-list-sync-notice').getByRole('button', { name: '刷新列表' }).click();
      await expect.poll(() => drift.listRefreshes(), { timeout: 60_000 }).toBeGreaterThanOrEqual(1);
      await expect.poll(() => drift.detailFetches(), { timeout: 60_000 }).toBeGreaterThanOrEqual(2);

      // 内容更新：分区可见值来自重新取数的响应（不只是复用旧缓存）。
      await expect(page.getByTestId('catalog-material-details')).toContainText('R4 REFETCHED FACTORY', { timeout: 60_000 });
      await expect(page.getByTestId('catalog-detail-core-ready')).toHaveAttribute('data-content-fresh', 'true');
      // 列表投影已同步（只有真的重新取数过才会消失）。
      await expect(page.getByTestId('catalog-detail-list-sync-notice')).toHaveCount(0);
      // v3：刷新后仍是同一个统一弹窗（不重挂载、不叠第二弹窗）
      await expect(page.getByTestId(DETAIL_DIALOG)).toHaveCount(1);
      await expect(page.getByTestId(DETAIL_DIALOG)).toHaveAttribute('data-evidence', 'off');
      await expect(page.getByTestId('catalog-tab-material')).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByTestId('catalog-tabpanel-material')).toBeVisible();
    });

    await closeDetail(page);
    await expect(page.getByTestId('catalog-row-WM0072')).toBeVisible();
  });

  test('list refresh keeps the current section instead of resetting to the default', async ({ page }) => {
    await login(page);
    await openFromList(page, WM0072);
    await expect(page.getByTestId('catalog-detail-core-ready')).toBeVisible({ timeout: 60_000 });
    const itemId = new URL(page.url()).searchParams.get('detail') ?? '';
    expect(itemId).toMatch(/^[0-9a-f-]{36}$/);
    await closeDetail(page);
    await expect(page.getByTestId('catalog-row-WM0072')).toBeVisible();

    await withR4RefreshDrift(page, itemId, async (drift) => {
      await openFromList(page, WM0072);
      await expect(page.getByTestId('catalog-detail-list-sync-notice')).toBeVisible({ timeout: 60_000 });
      // 真实点击切到「库存明细」，并确认分区内容可见。
      await openSection(page, 'inventory');
      await expect(page.getByTestId('catalog-bs-sample-panel')).toBeVisible();

      await page.getByTestId('catalog-detail-list-sync-notice').getByRole('button', { name: '刷新列表' }).click();
      await expect.poll(() => drift.listRefreshes(), { timeout: 60_000 }).toBeGreaterThanOrEqual(1);
      await expect.poll(() => drift.detailFetches(), { timeout: 60_000 }).toBeGreaterThanOrEqual(2);
      // 重新取数已落地（版本仍是不变的当前版本，这里只断言该分区内容仍在，且不是旧缓存）。
      // 注：WM0072 是「BS 未建档」样本，库存明细分区可见但可能没有样表行，故不断言库存表。
      await expect(page.getByTestId('catalog-bs-sample-panel')).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId('catalog-detail-list-sync-notice')).toHaveCount(0);

      // 当前分区不被重置：仍是库存明细，且该分区内容真实可见。
      await expect(page.getByTestId('catalog-tab-inventory')).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByTestId('catalog-tab-inventory')).toHaveAttribute('tabindex', '0');
      await expect(page.getByTestId('catalog-tabpanel-inventory')).toBeVisible();
      await expect(page.getByTestId('catalog-bs-sample-panel')).toBeVisible();
      // 唯一 tabpanel：不得重置回「商品资料」分区。
      const panels = page.locator('[role="tabpanel"]');
      await expect(panels).toHaveCount(1);
      await expect(panels).toHaveAttribute('aria-labelledby', 'catalog-tab-inventory');
      await expect(page.getByTestId(DETAIL_DIALOG)).toHaveCount(1);
      await expect(page.getByTestId(DETAIL_DIALOG)).toHaveAttribute('data-revision', 'current');
    });

    await closeDetail(page);
    await expect(page.getByTestId('catalog-row-WM0072')).toBeVisible();
  });
});
