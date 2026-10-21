import { expect, test } from '@playwright/test';

async function login(page: import('@playwright/test').Page) {
  await page.goto('/auth/login');
  await page.getByLabel('邮箱', { exact: true }).fill('admin@catalog.test');
  await page.getByLabel('密码', { exact: true }).fill('CatalogAdmin123!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForURL(/\/dashboard\/catalog/);
}

test.describe('local preview catalog smoke', () => {
  test('login, list, search, warehouse filter, detail, amounts cleared on logout', async ({ page, context }) => {
    await login(page);
    await expect(page.getByTestId('catalog-counts')).toContainText('126');
    const banner = page.getByTestId('catalog-display-banner');
    await expect(banner).toBeVisible();
    const select = banner.locator('select');
    const options = (await select.locator('option').allTextContents()).filter((o) => o && o !== '全部');
    expect(options.length).toBeGreaterThan(0);
    const warehouse = options[0]!;
    await select.selectOption(warehouse);
    await expect(banner).toContainText('本仓统计');
    await page.getByLabel(/搜索/).fill('WM0072');
    const row = page.getByTestId('catalog-row-WM0072');
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row.getByRole('cell').nth(3)).toContainText('5.18');
    await row.getByRole('link').first().click();
    await expect(page.getByTestId('item-code')).toContainText('WM0072');
    const bsPanel = page.getByTestId('catalog-bs-sample-panel');
    await expect(bsPanel).toBeVisible();
    await expect(page.getByTestId('bs-adopted-unit-cost')).toContainText('5.18');
    await expect(page.getByTestId('bs-basis-sha')).toContainText(/[a-f0-9]{64}/);
    const itemId = await page.getByTestId('item-uuid').innerText();
    await page.getByRole('button', { name: '读取受限金额' }).click();
    await expect(page.getByTestId('restricted-amounts')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('restricted-amounts')).toContainText('5.18');
    await context.clearCookies();
    await page.goto(`/dashboard/catalog/${itemId}`);
    await expect(page).toHaveURL(/auth\/login/);
    await expect(page.getByTestId('restricted-amounts')).toHaveCount(0);
  });
});
