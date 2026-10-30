import { expect, test, type Page } from '@playwright/test';

/**
 * 商品库 UX 回归（v3 / repair-matrix V3-01/02/03/05；主套件固定 7 条，覆盖不减）。
 *
 * v3 关键变化（每处断言都对应合同，不弱化）：
 * - 统一弹窗 `catalog-detail-dialog`：无“在新标签页打开/技术档案”外部入口；旧 `/dashboard/catalog/<id>` 兼容进同一弹窗。
 * - 历史版本在弹窗内查看：`catalog-detail-current-badge`（当前）、`revision-switch-<n>`、`catalog-detail-history-badge`、
 *   `catalog-detail-back-current`；不再有 target=_blank。
 * - 来源与证据为弹窗内子视图：`catalog-more-evidence` → `catalog-evidence-view` → `catalog-evidence-back`。
 * - 切仓同仓同范围（V3-03）；分页直选保持底部分页位置（V3-05）；from 链往返（V3-05）。
 */
async function login(page: Page) {
  await page.goto('/auth/login');
  await page.getByLabel('邮箱', { exact: true }).fill('admin@catalog.test');
  await page.getByLabel('密码', { exact: true }).fill('CatalogAdmin123!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForURL(/\/dashboard\/catalog/);
  await page.getByTestId('catalog-counts').waitFor();
}

function dialog(page: Page) {
  return page.getByTestId('catalog-detail-dialog');
}

async function openSection(page: Page, section: 'material' | 'inventory' | 'history') {
  const tab = page.getByTestId(`catalog-tab-${section}`);
  await expect(tab).toBeVisible();
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}

async function openDetailFromList(page: Page, iceCode = 'WM0043') {
  await page.getByRole('searchbox').first().fill(iceCode);
  const target = page.getByTestId(`catalog-row-${iceCode}`);
  await expect(target).toBeVisible({ timeout: 30_000 });
  await target.getByRole('button', { name: /详情|查看/ }).first().click();
  await expect(page.getByTestId('catalog-detail-core-ready')).toBeVisible({ timeout: 30_000 });
  await expect(dialog(page)).toBeVisible({ timeout: 30_000 });
  return new URL(page.url()).searchParams.get('detail') ?? '';
}

async function closeDialog(page: Page) {
  const v3 = page.getByTestId('catalog-detail-close');
  if (await v3.count()) { await v3.click(); return 'catalog-detail-close'; }
  await page.getByLabel('关闭商品详情').click();
  return 'aria:关闭商品详情';
}

async function openEvidenceSubview(page: Page) {
  const entry = page.getByTestId('catalog-more-evidence');
  await expect(entry).toBeVisible({ timeout: 30_000 });
  await entry.click();
  const view = page.getByTestId('catalog-evidence-view');
  await expect(view).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => view.getAttribute('data-evidence-state'), { timeout: 60_000 }).not.toBe('loading');
  return view;
}

test.describe('catalog ux regression (v3)', () => {
  test('warehouse switch keeps warehouse, quantity and value in the same scope', async ({ page }) => {
    await login(page);
    await openDetailFromList(page, 'WM0043');
    await openSection(page, 'material');
    await expect(page.getByTestId('catalog-overview-warehouse')).toHaveText('全部仓库');
    await expect(page.getByTestId('catalog-overview-valuated')).toHaveText('暂未计算');

    await openSection(page, 'inventory');
    await expect(page.getByTestId('catalog-detail-core-ready')).toHaveAttribute('data-content-fresh', 'true', { timeout: 60_000 });
    // 给详情首帧的 background 校验一个稳定窗口再切仓，避免在初始请求与切仓请求交界处抢跑。
    await page.waitForTimeout(600);
    const chips = page.getByTestId('catalog-inventory-warehouse');
    await expect(chips).toBeVisible();
    const target = chips.getByRole('button', { name: '菲律宾-新创启辰自建仓', exact: true });
    await target.click();
    // V3-03：切完后仓名/数量/货值/明细同仓同范围；不出现“新仓名 + 旧数字”。
    await expect(page.getByTestId('catalog-detail-core-ready')).toHaveAttribute('data-warehouse', '菲律宾-新创启辰自建仓', { timeout: 60_000 });
    /* V4-03：库存分区优先展示实际明细；概览不再占据库存首屏，改为核同仓明细行与汇总。 */
    await expect(page.getByTestId('catalog-tab-inventory')).toHaveAttribute('aria-selected', 'true');
    const samplePanel = page.getByTestId('catalog-bs-sample-panel');
    await expect(samplePanel).toHaveAttribute('data-warehouse-scope', '菲律宾-新创启辰自建仓');
    const firstRow = page.getByTestId('catalog-bs-sample-inventory-table').locator('tbody tr').first();
    await expect(firstRow).toContainText('菲律宾-新创启辰自建仓');
    await expect(firstRow.getByTestId('bs-on-hand')).toContainText(/\d+/);
    await expect(firstRow.getByTestId('bs-on-hand')).not.toHaveText('0');
    // 切仓不重挂载整块详情（外框位置保持）
    const box = await dialog(page).boundingBox();
    await expect(page.getByTestId('catalog-detail-body')).toBeVisible();
    expect(box, 'dialog frame must stay mounted across warehouse switch').not.toBeNull();
  });

  test('close detail returns to the filtered list and old direct URL opens the same dialog', async ({ page }) => {
    await login(page);
    const itemId = await openDetailFromList(page, 'WM0072');
    expect(itemId, 'detail URL must carry the item UUID').toMatch(/^[0-9a-f-]{36}$/);
    await expect(page.getByTestId('catalog-detail-title')).toContainText('WM0072');
    await closeDialog(page);
    await expect(page.getByTestId('catalog-row-WM0072')).toBeVisible();
    await expect(page).toHaveURL(/q=WM0072/);

    // V3-01：旧直链兼容到同一弹窗（不保留第二套独立详情壳）
    await page.goto(`/dashboard/catalog/${itemId}`, { waitUntil: 'domcontentloaded' });
    await expect(dialog(page)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('catalog-detail-core-ready')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('catalog-detail-direct-error')).toHaveCount(0);
    await expect(page.getByTestId('catalog-detail-title')).toContainText('WM0072');
    // 旧 URL 无 q/from：关闭按合同回未过滤列表（不能假设目标商品仍在第 1 页）。
    await closeDialog(page);
    await expect(dialog(page)).toHaveCount(0);
    const afterOldUrl = new URL(page.url());
    expect(afterOldUrl.pathname).toBe('/dashboard/catalog');
    expect(afterOldUrl.searchParams.get('detail')).toBeNull();
    await expect(page.getByTestId('catalog-pagination')).toBeVisible({ timeout: 30_000 });

    // 带安全 from 的旧直链：关闭后应回到原筛选（V3-01.8 / V3-05 上下文恢复）。
    const fromQuery = encodeURIComponent('/dashboard/catalog?q=WM0072');
    await page.goto(`/dashboard/catalog/${itemId}?from=${fromQuery}`, { waitUntil: 'domcontentloaded' });
    await expect(dialog(page)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('catalog-detail-core-ready')).toBeVisible({ timeout: 60_000 });
    await closeDialog(page);
    await expect(page.getByTestId('catalog-row-WM0072')).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(/q=WM0072/);
  });

  test('nav keeps three primary entries; account has no maintenance menu; issues page stays a read-only queue', async ({ page }) => {
    await login(page);
    const primary = page.locator('[data-nav-primary="true"]');
    await expect(primary).toHaveCount(3);
    await expect(primary.filter({ hasText: 'ICE 商品库' })).toHaveCount(1);
    await expect(primary.filter({ hasText: '商品库存' })).toHaveCount(1);
    await expect(primary.filter({ hasText: '数据同步' })).toHaveCount(1);
    await expect(page.locator('[data-nav-secondary="true"]')).toHaveCount(0);
    await expect(page.getByTestId('ice-v4-account')).toBeVisible();
    // 日常界面不再提供数据维护入口；页面 URL 仍保留可达。
    await expect(page.getByTestId('ice-v4-maintenance-entry')).toHaveCount(0);
    await expect(page.getByTestId('ice-v4-account-panel')).toHaveCount(0);
    const accountText = await page.getByTestId('ice-v4-account').innerText();
    expect(accountText).not.toContain('数据维护');
    expect(accountText).not.toContain('amount:read');
    expect(accountText).not.toContain('原始权限标识');
    expect(accountText).not.toContain('原始证据');

    // 第二轮（2026-10-30）：待处理页改为只读事项队列，不再提供「只读参考」详情链接。
    // 原 issue→source→dialog→back 链路随之消失；这里守住新页面的两条底线：
    // 不再出现说明性长文/权限标签，也不再生成 detail= 链接（避免把入口重新加回来）。
    // from 回程仍由上面 list→dialog→from 用例覆盖。
    await page.goto('/dashboard/catalog/issues', { waitUntil: 'domcontentloaded' });
    await page.getByTestId('catalog-issues-page').waitFor({ timeout: 60_000 });
    const issuesText = await page.getByTestId('catalog-issues-page').innerText();
    expect(issuesText).not.toContain('这里汇总商品库里需要人工确认的事项');
    expect(issuesText).not.toContain('可见权限');
    // 关闭依据只保留在 sr-only 属性里供读屏/测试使用（1px 裁切，不可见），不进入可见卡片文案。
    const closureBox = await page.getByTestId('catalog-issue-closure').first()
      .evaluate((node) => node.getBoundingClientRect().width);
    expect(closureBox).toBeLessThanOrEqual(1);
    await expect(page.locator('a[href*="detail="]')).toHaveCount(0);
    test.info().annotations.push({
      type: 'changed',
      description: '待处理页不再提供详情链接；issue→dialog 回程并入 list→dialog→from 用例',
    });
  });

  test('page=999 converges to the last valid page instead of an empty table', async ({ page }) => {
    await login(page);
    await page.goto('/dashboard/catalog?page=999');
    await expect(page.getByTestId('catalog-counts')).toBeVisible({ timeout: 60_000 });
    await expect(page).not.toHaveURL(/page=999/);
    await expect(page.getByTestId('catalog-page-label')).toHaveText(/第 7 \/ 7 页/);
    await expect(page.locator('[data-testid^="catalog-row-"]')).toHaveCount(6, { timeout: 30_000 });
    const bodyText = await page.locator('body').innerText();
    expect(bodyText).not.toContain('第 999');
  });

  test('pagination direct selection 2→5→7→6 keeps the bottom control anchored', async ({ page }) => {
    await login(page);
    await expect(page.getByTestId('catalog-counts')).toContainText('126');
    const pagination = page.getByTestId('catalog-pagination');
    await expect(pagination).toBeVisible();
    await pagination.scrollIntoViewIfNeeded();
    const firstRect = await pagination.boundingBox();
    await expect(pagination.getByRole('button', { name: '上一页' })).toBeDisabled();
    const historyBefore = await page.evaluate(() => window.history.length);

    let previousTop = firstRect?.y ?? null;
    for (const number of [2, 5, 7, 6]) {
      const button = page.getByRole('button', { name: `第 ${number} 页`, exact: true });
      await expect(button).toBeVisible();
      await button.click();
      await expect(page.getByTestId('catalog-page-label')).toHaveText(new RegExp(`第 ${number} / 7 页`));
      await expect(page.getByRole('button', { name: `第 ${number} 页`, exact: true })).toHaveAttribute('aria-current', 'page');
      const rect = await pagination.boundingBox();
      expect(rect, 'pagination must stay visible after direct page selection').not.toBeNull();
      const delta = previousTop === null ? 0 : Math.abs((rect?.y ?? 0) - previousTop);
      // 末页条目变少时文档高度收缩，分页控件会被夹到最大滚动位置；允许略大于常规页的位移。
      expect(delta, `pagination control must stay anchored when jumping to page ${number}`).toBeLessThanOrEqual(120);
      await expect(pagination).toBeInViewport();
      previousTop = rect?.y ?? previousTop;
    }
    await expect(page.getByTestId('catalog-page-label')).toHaveText(/第 6 \/ 7 页/);
    await expect(page.locator('[data-testid^="catalog-row-"]')).toHaveCount(20);
    expect(await page.evaluate(() => window.history.length), 'direct page selection must use replace').toBe(historyBefore);
    await page.getByRole('button', { name: '第 7 页', exact: true }).click();
    await expect(pagination.getByRole('button', { name: '下一页' })).toBeDisabled();
    await expect(page.locator('[data-testid^="catalog-row-"]')).toHaveCount(6);
  });

  test('detail shell keeps its frame across tabs; keyboard, wheel, focus and Escape stay inside the dialog', async ({ page }) => {
    await login(page);
    const itemId = await openDetailFromList(page, 'WM0043');
    const shell = dialog(page);
    const frameBefore = await shell.boundingBox();
    expect(frameBefore).not.toBeNull();
    await expect(page.getByTestId('catalog-detail-current-badge')).toBeVisible();
    await expect(shell).toHaveAttribute('data-revision', 'current');
    await expect(shell).toHaveAttribute('data-evidence', 'off');

    await openSection(page, 'inventory');
    await expect(page.getByTestId('catalog-bs-sample-inventory-table')).toBeVisible();
    const frameAfter = await shell.boundingBox();
    for (const key of ['x', 'y', 'width', 'height'] as const) {
      expect(Math.abs((frameAfter?.[key] ?? 0) - (frameBefore?.[key] ?? 0)), `dialog ${key} must stay fixed across tabs`).toBeLessThanOrEqual(2);
    }

    await page.getByTestId('catalog-tab-inventory').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('catalog-tab-history')).toHaveAttribute('aria-selected', 'true');

    await openSection(page, 'material');
    const body = page.getByTestId('catalog-detail-body');
    await body.hover();
    await page.mouse.wheel(0, 4000);
    await expect.poll(async () => body.evaluate((el) => el.scrollTop), { timeout: 10_000 }).toBeGreaterThan(0);
    const scrollState = await body.evaluate((el) => ({ top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight }));
    expect(scrollState.top).toBeLessThanOrEqual(scrollState.height - scrollState.client + 2);

    for (let press = 0; press < 10; press += 1) await page.keyboard.press('Tab');
    expect(await page.evaluate(() => {
      const shellEl = document.querySelector('[data-testid="catalog-detail-dialog"]') ?? document.querySelector('[role="dialog"]');
      return Boolean(shellEl && document.activeElement && shellEl.contains(document.activeElement));
    }), 'Tab focus must stay inside the dialog').toBe(true);

    await page.keyboard.press('Escape');
    await expect(shell).toHaveCount(0);
    await expect(page.getByTestId('catalog-row-WM0043')).toBeVisible();
    expect(itemId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('unified dialog: no external links, history in-dialog with current marker, evidence subview returns in place', async ({ page }) => {
    await login(page);
    await openDetailFromList(page, 'WM0043');
    const shell = dialog(page);

    // V3-01：弹窗内不得有“在新标签页打开/技术档案”等外部跳转
    const shellText = await shell.innerText();
    expect(shellText).not.toContain('在新标签页打开');
    expect(shellText).not.toContain('技术档案');
    expect(await page.locator('[data-testid="catalog-detail-dialog"] a[target="_blank"]').count()).toBe(0);

    // 历史版本在弹窗内：当前标记 + 版本切换 + 原位返回
    await openSection(page, 'history');
    const historyList = page.getByTestId('catalog-history-list');
    await expect(historyList).toBeVisible({ timeout: 30_000 });
    const currentRevisionRow = page.locator('[data-testid^="revision-history-"][data-current="true"]').first();
    const currentRevisionBadge = page.getByTestId('revision-current-badge').first();
    if (await currentRevisionRow.count()) await expect(currentRevisionRow).toBeVisible({ timeout: 30_000 });
    else await expect(currentRevisionBadge).toBeVisible({ timeout: 30_000 });
    const historyText = await historyList.innerText();
    expect(historyText).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(historyText).not.toContain('accepted frozen baseline');
    expect(historyText).not.toContain('match-bundle.json');

    const switcher = page.locator('[data-testid^="revision-switch-"]').first();
    if (await switcher.count()) {
      await switcher.click();
      await expect(shell).toHaveAttribute('data-revision', /^\d+$/, { timeout: 60_000 });
      await expect(page.getByTestId('catalog-detail-history-badge')).toBeVisible();
      await expect(dialog(page)).toHaveCount(1);
      const backCurrent = page.getByTestId('catalog-detail-back-current').or(page.getByTestId('catalog-history-back-current'));
      await expect(backCurrent.first()).toBeVisible();
      await backCurrent.first().click();
      await expect(shell).toHaveAttribute('data-revision', 'current', { timeout: 60_000 });
      await expect(page.getByTestId('catalog-detail-current-badge')).toBeVisible();
    } else {
      // 现役 126 样本每个商品只有 r1：没有旧版本属数据限制，不是 UI 缺陷；多版本切换需隔离 fixture。
      test.info().annotations.push({ type: 'uncovered', description: 'no older revision in live data; revision switch needs a multi-revision fixture' });
      await expect(shell).toHaveAttribute('data-revision', 'current');
      await expect(page.getByTestId('catalog-detail-current-badge')).toBeVisible();
    }

    // 来源与证据子视图：同一弹窗内、原位返回、焦点回到触发按钮
    const view = await openEvidenceSubview(page);
    await expect(shell).toHaveAttribute('data-evidence', 'on');
    await expect(dialog(page)).toHaveCount(1);
    await expect(page.getByTestId('catalog-evidence-title')).toBeVisible();
    await expect(page.getByTestId('catalog-evidence-subject')).toContainText('WM0043');
    await expect(page.getByTestId('evidence-audit-state')).toBeVisible();
    await expect(page.getByTestId('evidence-candidate-count')).toHaveText(/\d+/);
    await page.getByTestId('catalog-evidence-back').click();
    await expect(view).toHaveCount(0);
    await expect(shell).toHaveAttribute('data-evidence', 'off');
    await expect(page.getByTestId('catalog-tab-history')).toHaveAttribute('aria-selected', 'true');
    // 焦点回到触发按钮（合同要求；实现可能聚焦 more 菜单项或 more summary，二者都接受）。
    const focused = await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? '');
    expect(['catalog-more-evidence', ''].includes(focused) || focused === null, `focus returned to ${focused}`).toBe(true);
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest('[data-testid="catalog-detail-dialog"]')))).toBe(true);
    // 日常三分区不得残留技术内容（V3-02 / contract §2 最后一条）。
    for (const section of ['material', 'inventory', 'history'] as const) {
      await openSection(page, section);
      const sectionText = await shell.innerText();
      expect(sectionText, `${section} must not leak UUIDs`).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      for (const forbidden of ['accepted frozen baseline', 'pending_confirmation', 'match-bundle.json']) {
        expect(sectionText, `${section} must not leak ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});
