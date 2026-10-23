import { expect, test } from '@playwright/test';

async function login(page: import('@playwright/test').Page) {
  await page.goto('/auth/login');
  await page.getByLabel('邮箱', { exact: true }).fill('admin@catalog.test');
  await page.getByLabel('密码', { exact: true }).fill('CatalogAdmin123!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForURL(/\/dashboard\/catalog/);
}

function row(page: import('@playwright/test').Page, iceCode: string) {
  return page.getByTestId(`catalog-row-${iceCode}`);
}

async function selectWarehouse(page: import('@playwright/test').Page, warehouse: string) {
  await page.getByLabel('仓库筛选').selectOption(warehouse);
  await expect(page.getByTestId('catalog-display-banner')).toContainText(warehouse === 'all' ? '已确认 BS 库存行' : '本仓统计');
}

test.describe('local preview catalog smoke', () => {
  test('login, six warehouses, inventory states, WM0043 detail quantities, amounts cleared on logout', async ({ page, context }) => {
    await login(page);
    await expect(page.getByTestId('catalog-counts')).toContainText('126');
    const warehouseSelect = page.getByLabel('仓库筛选');
    const warehouses = (await warehouseSelect.locator('option').allTextContents()).filter((o) => o && o !== '全部仓库');
    expect(warehouses).toEqual([
      'DEE-龙仔厝（ICE专属）',
      'PH-彩妆日均万单简简单单仓',
      '印尼-DEE仓库',
      '喜运达MY仓',
      '菲律宾-新创启辰自建仓',
      '越南青林湾仓库',
    ]);

    await page.getByLabel(/搜索/).fill('CHIC-WM0043-P01');
    await expect(row(page, 'WM0043')).toBeVisible({ timeout: 30_000 });
    await page.getByLabel(/搜索/).fill('WM0043');
    await expect(row(page, 'WM0043')).toBeVisible({ timeout: 30_000 });

    const wm0043Expectations: Record<string, { inventory: string; value: string | RegExp }> = {
      all: { inventory: '7355', value: '¥21623.7' },
      '菲律宾-新创启辰自建仓': { inventory: '4946', value: '¥14541.24' },
      '越南青林湾仓库': { inventory: '2409', value: '¥7082.46' },
      '印尼-DEE仓库': { inventory: '0', value: /^¥0(\.00)?$/ },
      'DEE-龙仔厝（ICE专属）': { inventory: '0', value: /^¥0(\.00)?$/ },
      'PH-彩妆日均万单简简单单仓': { inventory: '本仓无对应', value: '本仓无对应' },
      '喜运达MY仓': { inventory: '本仓无对应', value: '本仓无对应' },
    };

    for (const [warehouse, expected] of Object.entries(wm0043Expectations)) {
      await selectWarehouse(page, warehouse);
      await expect(row(page, 'WM0043').getByTestId('catalog-bs-inventory')).toHaveText(expected.inventory);
      const valueCell = row(page, 'WM0043').getByTestId('catalog-estimated-value');
      if (expected.value instanceof RegExp) await expect(valueCell).toHaveText(expected.value);
      else await expect(valueCell).toHaveText(expected.value);
    }

    await selectWarehouse(page, 'all');
    await page.getByLabel(/搜索/).fill('brush');
    const brushRow = page.locator('tr').filter({ hasText: /brush/i }).first();
    await expect(brushRow).toBeVisible({ timeout: 30_000 });
    await expect(brushRow.getByTestId('catalog-bs-inventory')).toHaveText('无已确认库存');
    await expect(brushRow.getByTestId('catalog-estimated-value')).toContainText('无已确认');

    await page.getByLabel(/搜索/).fill('WM0072');
    await expect(row(page, 'WM0072')).toBeVisible({ timeout: 30_000 });
    await expect(row(page, 'WM0072').getByTestId('catalog-unit-cost')).toContainText('5.18');
    await expect(row(page, 'WM0072').getByTestId('catalog-bs-inventory')).not.toHaveText(/^0$/);
    await expect(row(page, 'WM0072').getByTestId('catalog-estimated-value')).toContainText('未建档');

    await page.getByLabel(/搜索/).fill('WM0043');
    await row(page, 'WM0043').getByRole('button', { name: '查看详情' }).click();
    await expect(page.getByTestId('catalog-detail-list-summary')).toContainText('WM0043');
    await expect(page.getByTestId('item-code')).toContainText('WM0043');
    const table = page.getByTestId('catalog-bs-sample-inventory-table');
    await expect(table).toBeVisible();
    await expect(table.locator('th')).toHaveText([
      '仓库', 'SKU', '选择', '现有', '订单已锁', '整仓可用', '活动预留', '在途',
    ]);
    const firstDataRow = table.locator('tbody tr').first();
    await expect(firstDataRow.getByTestId('bs-on-hand')).not.toHaveText('');
    await expect(firstDataRow.getByTestId('bs-order-locked')).toBeVisible();
    await expect(firstDataRow.getByTestId('bs-warehouse-available')).toBeVisible();
    await expect(firstDataRow.getByTestId('bs-activity-reserved')).toBeVisible();
    await expect(firstDataRow.getByTestId('bs-in-transit')).toBeVisible();

    await page.setViewportSize({ width: 635, height: 900 });
    await expect(table).toBeVisible();
    await expect(page.getByTestId('bs-adopted-unit-cost')).toBeVisible();

    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByTestId('bs-adopted-unit-cost')).toContainText('2.94');
    await page.getByText('技术说明：估值口径指纹').click();
    await expect(page.getByTestId('bs-basis-sha')).toContainText(/[a-f0-9]{64}/);

    const itemId = await page.getByTestId('item-uuid').innerText();
    await page.getByRole('button', { name: '读取受限金额' }).click();
    await expect(page.getByTestId('restricted-amounts')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('restricted-amounts')).toContainText('2.94');
    await context.clearCookies();
    await page.goto(`/dashboard/catalog/${itemId}`);
    await expect(page).toHaveURL(/auth\/login/);
    await expect(page.getByTestId('restricted-amounts')).toHaveCount(0);
  });
});
