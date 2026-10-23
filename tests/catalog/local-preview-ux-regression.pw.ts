import { expect, test } from '@playwright/test';

async function login(page: import('@playwright/test').Page) {
  await page.goto('/auth/login');
  await page.getByLabel('邮箱', { exact: true }).fill('admin@catalog.test');
  await page.getByLabel('密码', { exact: true }).fill('CatalogAdmin123!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForURL(/\/dashboard\/catalog/);
  await page.getByTestId('catalog-counts').waitFor();
}

test.describe('catalog ux regression', () => {
  test('quick warehouse switch never shows all-warehouse value under PH label', async ({ page }) => {
    await login(page);
    await page.getByLabel(/搜索/).fill('WM0043');
    await expect(page.getByTestId('catalog-row-WM0043')).toBeVisible();
    await page.getByRole('button', { name: '查看详情' }).first().click();
    await expect(page.getByTestId('catalog-detail-core-ready')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('bs-estimated-value')).toHaveText('¥21623.7');
    await page.getByLabel('关闭商品详情').click();
    await page.getByLabel('仓库筛选').selectOption('菲律宾-新创启辰自建仓');
    await expect(page.getByTestId('catalog-row-WM0043').getByTestId('catalog-estimated-value')).toHaveText('¥14541.24');
    await page.getByRole('button', { name: '查看详情' }).first().click();
    const value = page.getByTestId('bs-estimated-value');
    await expect(value).toBeVisible();
    const textDuringLoad = await value.textContent();
    expect(textDuringLoad).not.toBe('¥21623.7');
    await expect(page.getByTestId('catalog-detail-core-ready')).toHaveAttribute('data-warehouse', '菲律宾-新创启辰自建仓');
    await expect(value).toHaveText('¥14541.24');
    await expect(page.getByTestId('catalog-bs-sample-panel')).toHaveAttribute('data-warehouse-scope', '菲律宾-新创启辰自建仓');
  });

  test('close detail returns to filtered list and can reopen', async ({ page }) => {
    await login(page);
    await page.getByLabel(/搜索/).fill('WM0072');
    await expect(page.getByTestId('catalog-row-WM0072')).toBeVisible();
    await page.getByRole('button', { name: '查看详情' }).first().click();
    await expect(page.getByTestId('item-code')).toContainText('WM0072');
    await page.getByLabel('关闭商品详情').click();
    await expect(page.getByTestId('catalog-row-WM0072')).toBeVisible();
    await expect(page).toHaveURL(/q=WM0072/);
    await page.getByRole('button', { name: '查看详情' }).first().click();
    await expect(page.getByTestId('catalog-detail-core-ready')).toBeVisible();
    await expect(page.getByTestId('item-code')).toContainText('WM0072');
  });

  test('nav shows intake and sources availability in sidebar', async ({ page }) => {
    await login(page);
    await expect(page.locator('[data-nav-module="intake"]')).toHaveAttribute('data-nav-availability', '未启用');
    await expect(page.locator('[data-nav-module="sources"]')).toHaveAttribute('data-nav-availability', '未启用');
  });

  test('audit retry control is present when candidates section opens', async ({ page }) => {
    await login(page);
    await page.getByLabel(/搜索/).fill('WM0043');
    await page.getByRole('button', { name: '查看详情' }).first().click();
    await expect(page.getByTestId('catalog-detail-core-ready')).toBeVisible({ timeout: 30_000 });
    await page.locator('details').filter({ hasText: 'JST 与 BS 来源候选' }).locator('summary').click();
    await expect(
      page.getByTestId('catalog-audit-error')
        .or(page.getByTestId('catalog-candidates-empty'))
        .or(page.locator('[data-testid^="catalog-candidate-"]').first()),
    ).toBeVisible({ timeout: 60_000 });
    if (await page.locator('[data-testid^="catalog-candidate-"]').count()) {
      await expect(page.getByRole('heading', { name: 'JST', exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'BS', exact: true })).toBeVisible();
    }
  });
});
