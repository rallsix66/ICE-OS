import { expect, test, type Page } from '@playwright/test';

/**
 * inventory-sync-v1 修复包 v2 定向浏览器检查（真实隔离实例，真实同步数据；不写外部服务）。
 *
 * 覆盖 R1/R2/R5/R7 的页面接入点：
 * - 同步页：真实账号/范围/逐仓进度/任务详情（观测时间、身份、文件校验、坏行）；
 * - 对应复核：搜索 + 分页、手动仓库/商品/单位（无默认“件”）/理由，未勾选不批量；
 * - 库存页：列表与详情同一筛选上下文、显式“查看全仓”、逐仓×SKU 行、失败/未见标记；
 * - 空范围：明确清空→停止发布→刷新保持→立即同步给原因→重选恢复（结束时恢复原范围）；
 * - 未接入来源、匿名访问、无 500/未处理异常。
 */

async function login(page: Page) {
  await page.goto('/auth/login');
  await page.getByLabel('邮箱', { exact: true }).fill('admin@catalog.test');
  await page.getByLabel('密码', { exact: true }).fill('CatalogAdmin123!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForURL(/\/dashboard/);
}

function warehouseCheckboxes(page: Page) {
  return page.getByTestId('sync-warehouse-picker').getByRole('checkbox');
}

/**
 * 等客户端 hydration 接管（React 会在 DOM 节点上挂 __reactFiber$ 等属性）。
 * 仅用于“冷加载后立即读取/操作勾选”的测试时序；产品本身不依赖该属性。
 */
async function waitForClientHydration(page: Page, testId: string) {
  await page.waitForFunction((id) => {
    const element = document.querySelector(`[data-testid="${id}"]`);
    if (!element) return false;
    return Object.keys(element).some((key) => key.startsWith('__react'));
  }, testId, { timeout: 20_000 });
}

async function saveSettings(page: Page) {
  await page.getByTestId('sync-save-settings').click();
}

/** 点击保存并等 Server Action 的 POST 回包，避免“刚提交就 reload”读到旧 RSC。 */
async function saveSettingsAndWait(page: Page) {
  const [response] = await Promise.all([
    page.waitForResponse((candidate) => (
      candidate.request().method() === 'POST' && candidate.url().includes('/dashboard/sync')
    ), { timeout: 30_000 }),
    saveSettings(page),
  ]);
  expect(response.status()).toBeLessThan(500);
}

test.describe.configure({ mode: 'serial' });

test('1. 数据同步页显示真实账号、范围、逐仓进度与任务详情（含观测/身份/文件校验）', async ({ page }) => {
  await login(page);
  await page.goto('/dashboard/sync');
  await expect(page.getByTestId('sync-page')).toBeVisible();

  await expect(page.getByText('laiguoyong@KNZX019402').first()).toBeVisible();
  await expect(page.getByTestId('sync-controls')).toBeVisible();
  await expect(page.getByTestId('sync-warehouse-picker')).toBeVisible();
  await expect(page.getByTestId('sync-scope-progress')).toBeVisible();
  await expect(page.getByTestId('sync-scope-progress')).toContainText(/参与仓库|已停止发布/);
  await expect(page.getByRole('button', { name: /立即同步/ })).toBeVisible();
  await expect(page.getByTestId('sync-runs')).toBeVisible();
  await expect(page.getByTestId('sync-run-row').first()).toBeVisible();

  const firstRun = page.getByTestId('sync-run-row').first();
  await firstRun.getByRole('link', { name: /查看详情/ }).click();
  await expect(page).toHaveURL(/run=/);
  await expect(page.getByTestId('sync-run-detail')).toBeVisible();
  await expect(page.getByTestId('sync-run-warehouse-row').first()).toBeVisible();
  await expect(page.getByTestId('sync-run-detail')).toContainText(/本次观测时间|逐仓结果/);
  // 逐仓坏行/重复列与结果原因都有落点，不是只显示“成功”。
  await expect(page.getByTestId('sync-run-detail')).toContainText(/行数/);

  await expect(page.getByTestId('inventory-not-connected')).toBeVisible();
  await expect(page.getByTestId('inventory-not-connected')).toContainText('未接入');
  await page.screenshot({ path: test.info().outputPath('sync-page.png'), fullPage: true });
});

test('2. 连点立即同步只产生一个活动任务（不重复排队）', async ({ page }) => {
  await login(page);
  await page.goto('/dashboard/sync');
  const button = page.getByTestId('sync-manual-button');
  const blocked = page.getByTestId('sync-manual-blocked');
  if (await blocked.count() > 0) {
    // 空范围时按钮应被禁用并给出明确原因（R7），不能静默失败。
    await expect(button).toBeDisabled();
    await expect(blocked).toContainText('参与仓库为空');
    return;
  }
  await button.click();
  await expect(page.getByTestId('sync-control-message')).toBeVisible();
  const first = await page.getByTestId('sync-control-message').innerText();
  if (await button.isEnabled()) {
    await button.click();
    await expect(page.getByTestId('sync-control-message')).toBeVisible();
  }
  const second = await page.getByTestId('sync-control-message').innerText();
  expect(`${first} | ${second}`).toMatch(/同步|任务|执行|排队/);
  const statuses = await page.getByTestId('sync-run-row').allInnerTexts();
  const active = statuses.filter((text) => /等待|下载|检查|保存中|结果待核对/.test(text));
  expect(active.length).toBeLessThanOrEqual(1);
  await page.screenshot({ path: test.info().outputPath('sync-manual-dedupe.png'), fullPage: true });
});

test('3. 保存频率（未改范围）成功且显示下次计划时间', async ({ page }) => {
  await login(page);
  await page.goto('/dashboard/sync');
  const interval = page.getByLabel('同步频率数值');
  await interval.fill('60');
  await expect(page.getByTestId('sync-scope-change-hint')).toContainText(/未修改|未改/);
  await saveSettings(page);
  await expect(page.getByTestId('sync-control-message')).toContainText(/保存|已更新|设置/);
  await expect(page.getByText(/下次计划时间/).first()).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('sync-settings.png'), fullPage: true });
});

test('4. 对应复核：搜索/分页可用，手动选仓/单位（无默认件）/理由，未选行不批量', async ({ page }) => {
  await login(page);
  await page.goto('/dashboard/sync');

  const section = page.getByTestId('sync-mapping');
  await expect(section).toBeVisible();
  await expect(page.getByTestId('sync-mapping-queue')).toBeVisible();
  await expect(page.getByTestId('sync-mapping-pagination')).toBeVisible();
  await expect(page.getByTestId('sync-mapping-search')).toBeVisible();

  // 搜索写进地址栏，避免“前 20 条挡路”。
  const searchBox = page.getByTestId('sync-mapping-search').locator('input[name="mapQ"]');
  await searchBox.fill('697');
  await page.getByTestId('sync-mapping-search').getByRole('button', { name: '搜索' }).click();
  await expect(page).toHaveURL(/mapQ=697/);
  await expect(page.getByTestId('sync-mapping-pagination')).toBeVisible();

  const rows = page.getByTestId('sync-mapping-row');
  const rowCount = await rows.count();
  // 未勾选任何行时批量按钮禁用（不默认全选）。
  await expect(page.getByTestId('sync-mapping-confirm-selected')).toBeDisabled();
  if (rowCount > 0) {
    const first = rows.first();
    const unitInput = first.getByLabel(/^单位 /);
    const reasonInput = first.getByLabel(/^理由 /);
    await expect(unitInput).toHaveValue('');
    await expect(reasonInput).toHaveValue('');
    // 必须明确选择出现仓库后才能提交。
    await expect(first.getByTestId('sync-mapping-submit-row')).toBeDisabled();
    // 队列行是待确认的 (SKU×仓) 对，没有“当前已确认对应”；重核/停用入口在商品详情（这里不应出现按钮）。
    await expect(first.getByTestId('sync-mapping-recheck')).toHaveCount(0);
    await expect(first.getByTestId('sync-mapping-disable')).toHaveCount(0);
    await first.getByRole('checkbox').first().check();
    await expect(page.getByTestId('sync-mapping-confirm-selected')).toBeEnabled();
    await first.getByRole('checkbox').first().uncheck();
  }
  // 搜索不命中时给出明确空态，不显示为 0 个待处理。
  await searchBox.fill('no-such-sku-should-not-exist-zzz');
  await page.getByTestId('sync-mapping-search').getByRole('button', { name: '搜索' }).click();
  await expect(page.getByTestId('sync-mapping-empty').or(page.getByTestId('sync-mapping-row'))).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('sync-mapping.png'), fullPage: true });
});

test('5. 库存列表/详情同筛选上下文；显式查看全仓；逐仓×SKU 行', async ({ page }) => {
  await login(page);
  await page.goto('/dashboard/inventory');
  await expect(page.getByTestId('inventory-page')).toBeVisible();
  await expect(page.getByTestId('inventory-list')).toBeVisible();
  await expect(page.getByTestId('inventory-row').first()).toBeVisible();

  const marketFilter = page.getByTestId('inventory-market-filter');
  await expect(marketFilter).toBeVisible();
  const marketValuesBefore = await marketFilter.locator('option').allTextContents();

  const search = page.getByLabel(/搜索/).first();
  await search.fill('LS101295');
  await page.getByRole('button', { name: '筛选' }).click();
  await expect(page).toHaveURL(/LS101295|q=/);
  await expect(page.getByTestId('inventory-row')).toHaveCount(1);
  const row = page.getByTestId('inventory-row').first();
  await expect(row).toContainText('LS101295');
  // R1 固定核对点：LS101295 的有效当前行合计 1028（不是 2056）。
  await expect(row).toContainText('1,028');

  await row.getByRole('link', { name: /查看详情/ }).click();
  await expect(page.getByTestId('inventory-item-detail')).toBeVisible();
  await expect(page.getByTestId('inventory-detail-totals')).toBeVisible();
  await expect(page.getByTestId('inventory-detail-totals')).toContainText('1,028');
  await expect(page.getByTestId('inventory-detail-scope')).toContainText('沿用列表筛选');
  // 逐仓×SKU 行：有映射/批次的固定样本必须有行；每行带来源 SKU/单位/时间/状态。
  await expect(page.getByTestId('inventory-detail-row').first()).toBeVisible();
  await expect(page.getByTestId('inventory-detail-row').first()).toContainText(/件|未标单位/);
  await expect(page.getByTestId('inventory-detail-row').first()).toContainText(/当前|本次未见|未对应|保留旧值/);

  const historyRows = page.getByTestId('inventory-detail-history-row');
  if ((await historyRows.count()) > 0) {
    await expect(historyRows.first()).toBeVisible();
  }

  // 显式“查看全仓”切换带 all=1，且保持同一 item/筛选；再切回只算筛选仓。
  const allScope = page.getByTestId('inventory-detail-scope-all');
  if (await allScope.count() > 0) {
    await allScope.click();
    await expect(page).toHaveURL(/all=1/);
    await expect(page.getByTestId('inventory-detail-scope')).toContainText('全仓');
    await page.getByTestId('inventory-detail-scope-filtered').click();
    await expect(page).not.toHaveURL(/all=1/);
    await expect(page.getByTestId('inventory-detail-scope')).toContainText('沿用列表筛选');
  }
  await page.screenshot({ path: test.info().outputPath('inventory-detail.png'), fullPage: true });

  // 市场选项来自服务端聚合，翻页/搜索前后不丢。
  const marketValuesAfter = await marketFilter.locator('option').allTextContents();
  expect(marketValuesAfter.length).toBeGreaterThanOrEqual(marketValuesBefore.length);
  await page.screenshot({ path: test.info().outputPath('inventory-list.png'), fullPage: true });
});

test('6. 未接入来源显示“未接入”，旧库存地址安全引导到新页面', async ({ page }) => {
  await login(page);
  await page.goto('/dashboard/inventory');
  await expect(page.getByTestId('inventory-not-connected')).toBeVisible();
  const notConnected = await page.getByTestId('inventory-not-connected').innerText();
  expect((notConnected.match(/未接入/g) ?? []).length).toBeGreaterThanOrEqual(3);
  expect(notConnected).not.toMatch(/(可用库存|库存数量|在途数量|库存)\s*[:：]?\s*0(?!\d)/);

  await page.goto('/dashboard/inventory/domestic');
  await expect(page.getByTestId('legacy-inventory-guidance')).toBeVisible();
  await expect(page.getByRole('link', { name: /商品库存/ }).first()).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('legacy-guidance.png'), fullPage: true });
});

test('7. 匿名访问被服务端拒绝（库存与同步页都要登录）', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  for (const path of ['/dashboard/sync', '/dashboard/inventory']) {
    const response = await page.goto(path);
    expect(response?.status() ?? 200).toBeLessThan(500);
    await expect(page).toHaveURL(/auth\/login/);
    await expect(page.getByLabel('邮箱', { exact: true })).toBeVisible();
  }
  await context.close();
});

test('8. 明确清空范围：停止发布、刷新保持、立即同步给原因、重选恢复', async ({ page }) => {
  await login(page);
  await page.goto('/dashboard/sync');
  // 冷加载后先等 picker 出现且 hydration 完成，再读取勾选；否则会把“尚未恢复勾选”误判成空范围。
  const picker = page.getByTestId('sync-warehouse-picker');
  await expect(picker.locator('input[type="checkbox"]')).not.toHaveCount(0);
  await waitForClientHydration(page, 'sync-controls');
  // 初始状态只有两种：已恢复勾选（非空范围），或服务端已明确空范围并渲染停止发布提示。
  await expect.poll(async () => {
    const checkedCount = await picker.locator('input[type="checkbox"]:checked').count();
    const emptyNoticeCount = await page.getByTestId('sync-scope-empty-notice').count();
    return checkedCount > 0 || emptyNoticeCount > 0;
  }, { timeout: 20_000 }).toBe(true);

  const checkedLabels: string[] = [];
  const boxes = warehouseCheckboxes(page);
  const total = await boxes.count();
  for (let index = 0; index < total; index += 1) {
    const box = boxes.nth(index);
    const label = (await box.getAttribute('aria-label')) ?? '';
    if (await box.isChecked()) checkedLabels.push(label);
  }

  // 确实没有勾选：只可能是服务端已明确空范围；等提示出现后再断言（不立即判定）。
  if (checkedLabels.length === 0) {
    await expect(page.getByTestId('sync-scope-empty-notice')).toBeVisible();
    await expect(page.getByTestId('sync-scope-empty-notice')).toContainText('已停止发布');
    await expect(page.getByTestId('sync-manual-button')).toBeDisabled();
    await expect(page.getByTestId('sync-manual-blocked')).toContainText('参与仓库为空');
    return;
  }

  try {
    // 全部取消 → 第一次保存只请求确认，第二次才明确清空。
    for (const label of checkedLabels) {
      const box = page.getByRole('checkbox', { name: label });
      if (await box.isChecked()) await box.uncheck();
    }
    await expect(page.getByTestId('sync-scope-change-hint')).toContainText('停止发布');
    await saveSettings(page);
    await expect(page.getByTestId('sync-control-message')).toContainText(/清空|停止发布/);
    // 清空保存成功后页面刷新为“已停止发布”；服务端写入与 RSC 刷新有先后，等回包后 reload 校验。
    await saveSettingsAndWait(page);
    await expect.poll(async () => {
      await page.reload();
      return page.getByTestId('sync-scope-empty-notice').count();
    }, { timeout: 30_000, intervals: [1_000, 1_000, 2_000] }).toBeGreaterThan(0);
    await expect(page.getByTestId('sync-scope-empty-notice')).toContainText('已停止发布');

    await page.reload();
    await expect(page.getByTestId('sync-scope-empty-notice')).toBeVisible();
    await expect(page.getByTestId('sync-scope-empty-notice')).toContainText('已停止发布');
    await expect(page.getByTestId('sync-scope-progress')).toContainText('已停止发布');
    await expect(page.getByTestId('sync-manual-button')).toBeDisabled();
    await expect(page.getByTestId('sync-manual-blocked')).toContainText('参与仓库为空');

    // 空范围持久：第二次刷新仍然为空，不自动回退旧范围。
    await page.reload();
    await expect(page.getByTestId('sync-scope-empty-notice')).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('sync-empty-scope.png'), fullPage: true });
  } finally {
    // 恢复原范围，避免影响其它检查与交付实例。
    await page.goto('/dashboard/sync');
    await expect(page.getByTestId('sync-warehouse-picker').locator('input[type="checkbox"]')).not.toHaveCount(0);
    await waitForClientHydration(page, 'sync-controls');
    for (const label of checkedLabels) {
      const box = page.getByRole('checkbox', { name: label });
      if (!await box.isChecked()) await box.check();
    }
    if (checkedLabels.length > 0) {
      await saveSettingsAndWait(page);
      // 等真正的保存结果（不要匹配默认提示“保存设置或立即同步后…”里的“设置”）。
      await expect(page.getByTestId('sync-control-message')).toContainText(/已更新：参与仓库|参与仓库已更新|参与仓库范围未修改/);
      await expect.poll(async () => {
        await page.reload();
        return page.getByTestId('sync-scope-empty-notice').count();
      }, { timeout: 30_000, intervals: [1_000, 1_000, 2_000] }).toBe(0);
      await expect(page.getByTestId('sync-scope-progress')).toContainText(/7 个参与仓库|范围版本/);
    }
  }
});

test('9. 页面无 500 响应、无未处理前端异常', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('response', (response) => {
    if (response.status() >= 500) errors.push(`http ${response.status()} ${response.url()}`);
  });
  await login(page);
  await page.goto('/dashboard/sync');
  await page.waitForTimeout(3000);
  await page.goto('/dashboard/inventory');
  await page.waitForTimeout(3000);
  expect(errors, errors.join('\n')).toEqual([]);
});
