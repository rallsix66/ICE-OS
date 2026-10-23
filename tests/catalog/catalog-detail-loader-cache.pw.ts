import { expect, test, type Page, type Route } from '@playwright/test';

const WM0043_ID = 'f579a67f-cce9-41e8-8b22-d91f3d1313f6';

async function login(page: Page) {
  await page.goto('/auth/login');
  await page.getByLabel('邮箱', { exact: true }).fill('admin@catalog.test');
  await page.getByLabel('密码', { exact: true }).fill('CatalogAdmin123!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForURL(/\/dashboard\/catalog/);
  await page.getByTestId('catalog-counts').waitFor();
}

async function openWm0043FromList(page: Page) {
  await page.getByLabel(/搜索/).fill('WM0043');
  await expect(page.getByTestId('catalog-row-WM0043')).toBeVisible();
  await page.getByRole('button', { name: '查看详情' }).first().click();
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

async function withOneDetailPatch(
  page: Page,
  itemId: string,
  transform: (data: Record<string, unknown>) => void,
  run: () => Promise<void>,
) {
  let hits = 0;
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
    await run();
  } finally {
    const deadline = Date.now() + 15_000;
    while (pending.size > 0 && Date.now() < deadline) {
      await Promise.allSettled([...pending]);
      if (pending.size > 0) await page.waitForTimeout(50);
    }
    await page.unroute('**/*', handler);
  }
  expect(hits).toBeGreaterThanOrEqual(1);
}

test.describe('catalog detail loader cache negatives', () => {
  test('BS inventory read_failed shows core and inventory error (not projection spinner)', async ({ page }) => {
    await login(page);
    await withOneDetailPatch(page, WM0043_ID, (data) => {
      const payload = data.data as Record<string, unknown>;
      payload.bsSample = null;
      payload.bsSampleError = { code: 'read_failed', message: 'BS 样表库存投影读取失败（测试注入）' };
    }, async () => {
      await openWm0043FromList(page);
      await expect(page.getByTestId('catalog-detail-core-ready')).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId('catalog-bs-sample-error')).toBeVisible();
      await expect(page.getByTestId('catalog-detail-fetch-error')).toHaveCount(0);
      await expect(page.getByText('正在切换仓库投影…')).toHaveCount(0);
    });
  });

  test('detail revision ahead of list shows core and list sync notice', async ({ page }) => {
    await login(page);
    await withOneDetailPatch(page, WM0043_ID, (data) => {
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
    const basisLine = await page.getByTestId('bs-basis-sha').textContent();
    const mutatedSha = `${'a'.repeat(64)}`;
    expect(basisLine).not.toContain(mutatedSha);
    await page.getByLabel('关闭商品详情').click();
    await withOneDetailPatch(page, WM0043_ID, (data) => {
      const payload = data.data as { bsSample?: { basisDocumentSha256?: string } };
      if (payload.bsSample) payload.bsSample.basisDocumentSha256 = mutatedSha;
    }, async () => {
      await page.getByRole('button', { name: '查看详情' }).first().click();
      await expect(page.getByTestId('catalog-detail-core-ready')).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId('bs-basis-sha')).toContainText(mutatedSha);
      await expect(page.getByTestId('catalog-detail-core-ready')).toHaveAttribute('data-content-fresh', 'false');
      await expect(page.getByTestId('catalog-detail-core-ready')).toHaveAttribute('data-list-projection-synced', 'false');
      await expect(page.getByTestId('catalog-detail-list-sync-notice')).toBeVisible();
    });
    await page.getByRole('button', { name: '刷新列表' }).click();
    await expect(page.getByTestId('catalog-row-WM0043')).toBeVisible();
    await expect(page.getByTestId('catalog-detail-core-ready')).toHaveAttribute('data-content-fresh', 'true');
    await expect(page.getByTestId('catalog-detail-core-ready')).toHaveAttribute('data-list-projection-synced', 'true');
  });

  test('background forbidden after cache hit masks amounts and blocks fresh core', async ({ page }) => {
    await login(page);
    await openWm0043FromList(page);
    await expect(page.getByTestId('catalog-detail-core-ready')).toBeVisible({ timeout: 60_000 });
    await page.getByLabel('关闭商品详情').click();
    await withOneDetailPatch(page, WM0043_ID, (data) => {
      (data as { success?: boolean; error?: string }).success = false;
      (data as { success?: boolean; error?: string }).error = '权限不足（测试注入）';
      delete (data as { data?: unknown }).data;
    }, async () => {
      await page.getByRole('button', { name: '查看详情' }).first().click();
      await expect(page.getByTestId('catalog-detail-fetch-error')).toContainText('权限', { timeout: 60_000 });
      await expect(page.getByTestId('catalog-detail-core-ready')).toHaveCount(0);
      await expect(page.getByTestId('bs-estimated-value')).toHaveCount(0);
    });
  });

  test('list sync notice refresh triggers list reload without spinner lock', async ({ page }) => {
    await login(page);
    await withOneDetailPatch(page, WM0043_ID, (data) => {
      const payload = data.data as { item: { revision: number } };
      payload.item.revision += 1;
    }, async () => {
      await openWm0043FromList(page);
      await expect(page.getByTestId('catalog-detail-list-sync-notice')).toBeVisible({ timeout: 60_000 });
      await page.getByRole('button', { name: '刷新列表' }).click();
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
    await page.getByLabel(/搜索/).fill('WM0043');
    await page.getByRole('button', { name: '查看详情' }).first().click();
    await page.getByLabel('关闭商品详情').click({ timeout: 5000 }).catch(() => {});
    await page.getByLabel(/搜索/).fill('WM0072');
    await page.getByRole('button', { name: '查看详情' }).first().click();
    await expect(page.getByTestId('item-code')).toContainText('WM0072', { timeout: 60_000 });
    await expect(page.getByTestId('item-code')).not.toContainText('WM0043');
    await page.waitForTimeout(1500);
    await expect(page.getByTestId('item-code')).toContainText('WM0072');
    await expect(page.getByTestId('item-code')).not.toContainText('WM0043');
    await page.unroute('**/*');
  });

  test('locked quantity drift in detail still renders core (not projection spinner)', async ({ page }) => {
    await login(page);
    await withOneDetailPatch(page, WM0043_ID, (data) => {
      const payload = data.data as { bsSample?: { rows?: Array<{ orderLocked?: number }> } };
      const row = payload.bsSample?.rows?.[0];
      if (row) row.orderLocked = (row.orderLocked ?? 0) + 999;
    }, async () => {
      await openWm0043FromList(page);
      await expect(page.getByTestId('catalog-detail-core-ready')).toBeVisible({ timeout: 60_000 });
      await expect(page.getByText('正在切换仓库投影…')).toHaveCount(0);
    });
  });

});
