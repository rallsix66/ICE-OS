import { expect, test } from '@playwright/test';

/**
 * 本地预览商品库冒烟（v3 / V3-01/02/03）。
 *
 * v3 变化（断言随之迁移，不弱化）：
 * - 列表只剩一处**静态简短**「样表 · <日期>」；列表/行内不再复读价格口径与“在新标签页打开”。
 * - 商品查看只有一套统一弹窗（`catalog-detail-dialog`）；历史版本与来源/证据都在弹窗内。
 * - 来源与证据子视图：`catalog-detail-more` → `catalog-more-evidence` → `catalog-evidence-view`（含原始 JSON/受限金额），
 *   `catalog-evidence-back` 原位返回。
 * - 旧 `/dashboard/catalog/<id>` 兼容进同一弹窗。
 */
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

function dialog(page: import('@playwright/test').Page) {
  return page.getByTestId('catalog-detail-dialog');
}

async function closeDialog(page: import('@playwright/test').Page) {
  const v3 = page.getByTestId('catalog-detail-close');
  if (await v3.count()) { await v3.click(); return; }
  await page.getByLabel('关闭商品详情').click();
}

async function openSection(page: import('@playwright/test').Page, section: 'material' | 'inventory' | 'history') {
  const tab = page.getByTestId(`catalog-tab-${section}`);
  await expect(tab).toBeVisible();
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}

async function openWarehouseMenu(page: import('@playwright/test').Page) {
  const trigger = page.getByTestId('catalog-warehouse-filter');
  await trigger.click();
  const list = page.getByTestId('catalog-warehouse-filter-listbox');
  await expect(list).toBeVisible();
  return list;
}

async function selectWarehouse(page: import('@playwright/test').Page, warehouse: string) {
  const select = page.getByTestId('catalog-warehouse-filter');
  const list = await openWarehouseMenu(page);
  await list.locator(`[role="option"][data-value="${warehouse}"]`).click();
  await expect(select).toHaveAttribute('data-value', warehouse);
  // 列表只保留一处数据时间，不再有“样表/口径”说明
  await expect(page.getByTestId('catalog-sample-date')).toContainText(/数据时间 \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
}

async function openEvidenceSubview(page: import('@playwright/test').Page) {
  const entry = page.getByTestId('catalog-more-evidence');
  await expect(entry).toBeVisible({ timeout: 30_000 });
  await entry.click();
  const view = page.getByTestId('catalog-evidence-view');
  await expect(view).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => view.getAttribute('data-evidence-state'), { timeout: 60_000 }).not.toBe('loading');
  return view;
}

test.describe('local preview catalog smoke (v3)', () => {
  test('login, six warehouses, list cleanup, unified dialog partitions, in-dialog evidence, logout', async ({ page, context }) => {
    await login(page);
    await expect(page.getByTestId('catalog-counts')).toContainText('126');

    const warehouseList = await openWarehouseMenu(page);
    const warehouses = (await warehouseList.locator('[role="option"]').allTextContents())
      .map((text) => text.trim())
      .filter((text) => text && text !== '全部仓库');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('catalog-warehouse-filter-listbox')).toHaveCount(0);
    expect(warehouses).toEqual(expect.arrayContaining([
      'DEE-龙仔厝（ICE专属）',
      'PH-彩妆日均万单简简单单仓',
      '印尼-DEE仓库',
      '喜运达MY仓',
      '菲律宾-新创启辰自建仓',
      '越南青林湾仓库',
    ]));
    expect(warehouses.length).toBeGreaterThanOrEqual(6);

    // 列表只剩一处数据时间；来源与口径不在列表常驻
    await expect(page.getByTestId('catalog-sample-date')).toHaveText(/数据时间 \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    await expect(page.getByTestId('catalog-sample-scope')).toHaveCount(0);
    await expect(page.getByTestId('catalog-sample-scope-detail')).toHaveCount(0);
    expect(await page.getByText('不是实时库存').count()).toBe(0);
    expect(await page.getByText(/已确认 \d+ 行 · 未选择 \d+ 行/).count()).toBe(0);
    // 行内不再复读价格小字
    const listText = await page.locator('body').innerText();
    expect(listText).not.toContain('CNY / 单品');
    expect(listText).not.toContain('不含运费、不含税');
    // 旧工程横幅/长文不再出现
    for (const removed of [/已确认 BS 库存行/, /每页 20 款/, /默认展示 \d+ 份真实主资料/, /C127/, /口径与覆盖明细/]) {
      expect(await page.getByText(removed).count(), `${removed} must be removed from the list DOM`).toBe(0);
    }

    await page.getByRole('searchbox').first().fill('CHIC-WM0043-P01');
    await expect(row(page, 'WM0043')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('searchbox').first().fill('WM0043');
    await expect(row(page, 'WM0043')).toBeVisible({ timeout: 30_000 });

    const wm0043Warehouses = [
      '菲律宾-新创启辰自建仓',
      '越南青林湾仓库',
      '印尼-DEE仓库',
      'DEE-龙仔厝（ICE专属）',
      'PH-彩妆日均万单简简单单仓',
      '喜运达MY仓',
    ];
    for (const warehouse of wm0043Warehouses) {
      await selectWarehouse(page, warehouse);
      await expect(row(page, 'WM0043').getByTestId('catalog-bs-inventory')).not.toHaveText('');
    }
    await selectWarehouse(page, 'all');
    await expect(row(page, 'WM0043').getByTestId('catalog-bs-inventory')).toContainText('仓有当前库存');

    await selectWarehouse(page, 'all');
    await page.getByRole('searchbox').first().fill('brush');
    const brushRow = page.locator('tr').filter({ hasText: /brush/i }).first();
    await expect(brushRow).toBeVisible({ timeout: 30_000 });
    await expect(brushRow.getByTestId('catalog-bs-inventory')).not.toHaveText(/^0$/);

    await page.getByRole('searchbox').first().fill('WM0072');
    await expect(row(page, 'WM0072')).toBeVisible({ timeout: 30_000 });
    await expect(row(page, 'WM0072').getByTestId('catalog-unit-cost')).toContainText('5.18');
    await expect(row(page, 'WM0072').getByTestId('catalog-bs-inventory')).not.toHaveText(/^0$/);
    // 行内不再有“更多资料”入口，也不再出现外链新标签
    await expect(row(page, 'WM0072').getByRole('button', { name: /更多资料/ })).toHaveCount(0);
    expect(await page.locator('a[target="_blank"]').count()).toBe(0);

    await page.getByRole('searchbox').first().fill('WM0043');
    await row(page, 'WM0043').getByRole('button', { name: '详情', exact: true }).click();
    await expect(dialog(page)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('catalog-detail-title')).toContainText('WM0043');
    await expect(page.getByTestId('catalog-detail-current-badge')).toBeVisible();
    await expect(dialog(page)).toHaveAttribute('data-revision', 'current');
    await expect(dialog(page)).toHaveAttribute('data-evidence', 'off');
    // 统一弹窗：无外部新标签/技术档案入口
    const shellText = await dialog(page).innerText();
    expect(shellText).not.toContain('在新标签页打开');
    expect(shellText).not.toContain('技术档案');
    expect(await page.locator('[data-testid="catalog-detail-dialog"] a[target="_blank"]').count()).toBe(0);

    // 商品资料分区：单位与口径收敛（V3-02）
    await openSection(page, 'material');
    await expect(page.getByTestId('catalog-material-details')).toBeVisible();
    await expect(page.getByTestId('catalog-material-ice-code')).toContainText('WM0043');
    await expect(page.getByTestId('catalog-material-spec')).toBeVisible();
    await expect(page.getByTestId('catalog-material-unit-cost')).toContainText('2.94');

    // 库存明细分区
    await openSection(page, 'inventory');
    await expect(page.getByTestId('catalog-inventory-warehouse')).toBeVisible();
    const table = page.getByTestId('catalog-bs-sample-inventory-table');
    await expect(table).toBeVisible();
    await expect(table.locator('th')).toHaveText(['仓库', '来源编码', '单位', '现有', '订单已锁', '整仓可用', '活动预留', '在途', '来源时间', '状态']);
    const firstDataRow = table.locator('tbody tr').first();
    for (const cell of ['bs-on-hand', 'bs-order-locked', 'bs-warehouse-available', 'bs-activity-reserved', 'bs-in-transit']) {
      await expect(firstDataRow.getByTestId(cell)).toBeVisible();
    }

    // 变更记录分区：当前标记 + 无技术泄漏（V3-01/02）
    await openSection(page, 'history');
    await expect(page.getByTestId('catalog-history-list')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-testid^="revision-history-"][data-current="true"]').first()).toBeVisible({ timeout: 30_000 });
    const historyText = await page.getByTestId('catalog-history-list').innerText();
    expect(historyText).not.toContain('accepted frozen baseline');
    expect(historyText).not.toContain('match-bundle.json');
    expect(historyText).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);

    // 635 宽：内容仍可读（窄屏不靠隐藏内容过关）
    await page.setViewportSize({ width: 635, height: 800 });
    await openSection(page, 'inventory');
    await expect(table).toBeVisible();
    await openSection(page, 'material');
    await expect(page.getByTestId('catalog-material-unit-cost')).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 900 });

    // V4-02：弹窗内数据来源只呈现业务内容；原始 JSON/UUID/技术下载退出日常界面
    const itemId = new URL(page.url()).searchParams.get('detail') ?? '';
    expect(itemId).toMatch(/^[0-9a-f-]{36}$/);
    const view = await openEvidenceSubview(page);
    await expect(dialog(page)).toHaveAttribute('data-evidence', 'on');
    await expect(page.getByTestId('catalog-evidence-subject')).toContainText('WM0043');
    await expect(page.getByTestId('catalog-evidence-subject')).not.toContainText(itemId);
    await expect.poll(async () => view.getAttribute('data-evidence-state'), { timeout: 60_000 }).toBe('ready');
    await expect(page.getByTestId('catalog-source-records')).toBeVisible();
    await expect(page.getByTestId('catalog-source-records')).toContainText('本批已采用对应');
    await expect(page.getByTestId('catalog-source-records')).toContainText('来源仓库');
    await expect(page.locator('pre')).toHaveCount(0);
    await expect(page.locator('a[href*="/api/catalog/"]')).toHaveCount(0);
    await expect(page.getByTestId('evidence-raw-json')).toHaveCount(0);
    await expect(page.getByTestId('item-uuid')).toHaveCount(0);
    await expect(page.getByTestId('evidence-amounts')).toContainText('2.94', { timeout: 30_000 });
    await page.getByTestId('catalog-evidence-back').click();
    await expect(view).toHaveCount(0);
    await expect(dialog(page)).toHaveAttribute('data-evidence', 'off');
    await expect(dialog(page)).toHaveAttribute('data-revision', 'current');

    // 登出后直链与列表都回登录，且无金额/证据残留
    await context.clearCookies();
    await page.goto(`/dashboard/catalog/${itemId}`);
    await expect(page).toHaveURL(/auth\/login/);
    await expect(page.getByTestId('restricted-amounts')).toHaveCount(0);
    await expect(page.getByTestId('catalog-evidence-view')).toHaveCount(0);
    await page.goto('/dashboard/catalog');
    await expect(page).toHaveURL(/auth\/login/);
    await expect(page.getByTestId('catalog-evidence-view')).toHaveCount(0);
    void closeDialog;
  });
});
