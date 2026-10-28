import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  consumeDropped,
  setDropMode,
  startProxy,
  stopProxy,
  type DropMode,
} from './repair-v3-proxy';
import {
  assertCompleteExecutePrivilege,
  deleteAllTestPending,
  insertForeignPendingFixture,
  openInstanceDb,
  readInstanceEnv,
  readMapping,
  readRequest,
  readSettings,
  readWarehouseId,
  setCompleteExecuteAllowed,
  type InstanceDb,
  type InstanceEnv,
} from './repair-v3-db';

/**
 * v3 修复包 F1/F2/F4 真实页面验证（仅本文件；旧 inventory.browser.pw.ts 保留不动）。
 *
 * 运行方式：baseURL 指向本文件启动的本地反代（默认 3044）→ 上游 3033：
 *   INVENTORY_BASE_URL=http://127.0.0.1:3044
 *   INVENTORY_UPSTREAM_URL=http://127.0.0.1:3033
 *   INVENTORY_INSTANCE_DIR=...\run-...\instance
 *   INVENTORY_BROWSER_EVIDENCE_DIR=<absolute>
 *   node node_modules/@playwright/test/cli.js test tests/inventory-browser/inventory-repair-v3.browser.pw.ts
 *
 * 反代 A/B 分支：
 * - A drop-response：POST 完整转发并等上游响应（业务/DB 已落库），浏览器收不到响应；
 * - B drop-request：POST 不转发（未达服务端），浏览器连接被销毁。
 * 均只用真实服务端回执/数据库判定，不伪造回执。
 */

const PROXY_PORT = Number(process.env.INVENTORY_PROXY_PORT ?? 3044);
const UPSTREAM = process.env.INVENTORY_UPSTREAM_URL ?? '';
const CONFIGURED_BASE = process.env.INVENTORY_BASE_URL ?? '';

let proxyUrl = '';
let env: InstanceEnv;
let db: InstanceDb;
/** F1-1 建立的验证对应，供 F1-3 重核/停用链复用。 */
let confirmedFixture: QueueRowInfo | null = null;
const facts: Record<string, unknown> = {
  buildId: process.env.INVENTORY_BUILD_ID ?? null,
  upstream: process.env.INVENTORY_UPSTREAM_URL ?? null,
  proxy: null,
  authorization: { grantRevokeSql: [], timestamps: [], finalPrivilege: null },
  foreignFixtureSql: [],
  databaseChecks: [],
};

test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  if (!UPSTREAM) throw new Error('INVENTORY_UPSTREAM_URL_REQUIRED（如 http://127.0.0.1:3033）');
  env = readInstanceEnv();
  proxyUrl = await startProxy(UPSTREAM, PROXY_PORT);
  facts.proxy = proxyUrl;
  if (CONFIGURED_BASE !== proxyUrl) {
    throw new Error(`INVENTORY_BASE_URL 必须等于代理地址 ${proxyUrl}（当前 ${CONFIGURED_BASE || '未设置'}）`);
  }
  db = await openInstanceDb(env);
});

test.afterAll(async () => {
  try {
    if (process.env.INVENTORY_DB_GRANT_ALLOWED === '1') {
      // Lead 授权要求：恢复权限后断言 app 角色重新拥有 EXECUTE；失败必须显式报错，不静默。
      await setCompleteExecuteAllowed(env, true);
      const ok = await assertCompleteExecutePrivilege(env);
      facts.authorization = { ...(facts.authorization as object), finalPrivilege: ok };
      if (!ok) {
        const evidenceDir = process.env.INVENTORY_BROWSER_EVIDENCE_DIR;
        if (evidenceDir) fs.writeFileSync(path.join(evidenceDir, 'web-report.json'), JSON.stringify(facts, null, 2));
        throw new Error('FATAL: complete_inventory_pending_action EXECUTE 权限恢复失败（has_function_privilege=false）');
      }
    }
  } finally {
    await db?.close();
    await stopProxy();
    const evidenceDir = process.env.INVENTORY_BROWSER_EVIDENCE_DIR;
    if (evidenceDir && fs.existsSync(evidenceDir)) {
      fs.writeFileSync(path.join(evidenceDir, 'web-report.json'), JSON.stringify(facts, null, 2));
    }
  }
});

async function login(page: Page) {
  await page.goto('/auth/login');
  await page.getByLabel('邮箱', { exact: true }).fill('admin@catalog.test');
  await page.getByLabel('密码', { exact: true }).fill('CatalogAdmin123!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForURL(/\/dashboard/);
  // Better Auth 成功后可能跳转到配置的绝对 3033；强制回到代理 origin，确保后续 POST 走代理（A/B 分支必需）。
  await page.goto(`${CONFIGURED_BASE}/dashboard`);
  await page.waitForLoadState('networkidle');
}

/** 刚登录后 Next 客户端仍可能发起导航；对 ERR_ABORTED 做一次重试。 */
async function gotoStable(page: Page, url: string): Promise<void> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  } catch (error) {
    if (/ERR_ABORTED/.test(String(error))) {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      return;
    }
    throw error;
  }
}

function mappingMessage(page: Page) {
  return page.getByTestId('sync-mapping-queue').locator('p[role="status"]');
}

function rowLocator(page: Page, rowKey: string) {
  return page.locator(`[data-testid="sync-mapping-row"][data-row-key=${JSON.stringify(rowKey)}]`);
}

async function readLocalUnknown(page: Page): Promise<{ requestId: string; action: string; intent: string; payload: Record<string, unknown> } | null> {
  return page.evaluate(() => {
    const raw = window.sessionStorage.getItem('inventory.localUnknownRequest.v1');
    return raw ? JSON.parse(raw) as { requestId: string; action: string; intent: string; payload: Record<string, unknown> } : null;
  });
}

interface QueueRowInfo {
  rowKey: string;
  sku: string;
  warehouseExternalId: string;
  warehouseName: string;
  text: string;
  pageNumber: number;
}

async function findQueueRow(
  page: Page,
  predicate: (row: { text: string; sku: string; warehouseExternalId: string; warehouseName: string }) => boolean,
  maxPages = 12,
): Promise<QueueRowInfo> {
  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
    await page.goto(`/dashboard/sync?mapPage=${pageNumber}`);
    await expect(page.getByTestId('sync-mapping-queue')).toBeVisible();
    const rows = page.getByTestId('sync-mapping-row');
    const count = await rows.count();
    for (let index = 0; index < count; index += 1) {
      const row = rows.nth(index);
      const text = (await row.innerText()).replace(/\s+/g, ' ');
      const sku = (await row.getAttribute('data-sku')) ?? '';
      const warehouseExternalId = (await row.getAttribute('data-warehouse-external-id')) ?? '';
      const rowKey = (await row.getAttribute('data-row-key')) ?? '';
      const warehouseName = (text.match(/来源仓库：([^（(]+)/)?.[1]?.trim()) ?? '';
      if (sku && warehouseExternalId && rowKey && predicate({ text, sku, warehouseExternalId, warehouseName })) {
        return { rowKey, sku, warehouseExternalId, warehouseName, text, pageNumber };
      }
    }
  }
  throw new Error('没有找到满足条件的队列行（数据前置不满足）');
}

async function findUnmappedRow(page: Page): Promise<QueueRowInfo> {
  return findQueueRow(page, ({ text }) => text.includes('当前没有生效的仓级对应'));
}

async function findTwoUnmappedOnSamePage(page: Page): Promise<[QueueRowInfo, QueueRowInfo]> {
  for (let pageNumber = 1; pageNumber <= 14; pageNumber += 1) {
    await page.goto(`/dashboard/sync?mapPage=${pageNumber}`);
    await expect(page.getByTestId('sync-mapping-queue')).toBeVisible();
    const rows = page.getByTestId('sync-mapping-row');
    const count = await rows.count();
    const found: QueueRowInfo[] = [];
    for (let index = 0; index < count; index += 1) {
      const row = rows.nth(index);
      const text = (await row.innerText()).replace(/\s+/g, ' ');
      if (!text.includes('当前没有生效的仓级对应')) continue;
      const sku = (await row.getAttribute('data-sku')) ?? '';
      const warehouseExternalId = (await row.getAttribute('data-warehouse-external-id')) ?? '';
      const rowKey = (await row.getAttribute('data-row-key')) ?? '';
      if (!sku || !warehouseExternalId || !rowKey) continue;
      const warehouseName = (text.match(/来源仓库：([^（(]+)/)?.[1]?.trim()) ?? '';
      found.push({ rowKey, sku, warehouseExternalId, warehouseName, text, pageNumber });
    }
    const [first, second] = found;
    if (first && second) return [first, second];
  }
  throw new Error('没有找到同一页两条未对应行（数据前置不满足）');
}

async function findSameSkuPair(page: Page): Promise<[QueueRowInfo, QueueRowInfo]> {
  const seen = new Map<string, QueueRowInfo>();
  for (let pageNumber = 1; pageNumber <= 14; pageNumber += 1) {
    await page.goto(`/dashboard/sync?mapPage=${pageNumber}`);
    await expect(page.getByTestId('sync-mapping-queue')).toBeVisible();
    const rows = page.getByTestId('sync-mapping-row');
    const count = await rows.count();
    for (let index = 0; index < count; index += 1) {
      const row = rows.nth(index);
      const text = (await row.innerText()).replace(/\s+/g, ' ');
      if (!text.includes('当前没有生效的仓级对应')) continue;
      const sku = (await row.getAttribute('data-sku')) ?? '';
      const warehouseExternalId = (await row.getAttribute('data-warehouse-external-id')) ?? '';
      const rowKey = (await row.getAttribute('data-row-key')) ?? '';
      if (!sku || !warehouseExternalId || !rowKey) continue;
      const warehouseName = (text.match(/来源仓库：([^（(]+)/)?.[1]?.trim()) ?? '';
      const previous = seen.get(sku);
      if (previous && previous.warehouseExternalId !== warehouseExternalId) return [previous, { rowKey, sku, warehouseExternalId, warehouseName, text, pageNumber }];
      seen.set(sku, { rowKey, sku, warehouseExternalId, warehouseName, text, pageNumber });
    }
  }
  throw new Error('没有找到同 SKU 两个仓都未对应的行（数据前置不满足）');
}

async function fillRowForm(
  page: Page,
  row: ReturnType<typeof rowLocator>,
  sku: string,
  options: { targetSearch: string; unit: string; reason: string; verification?: boolean },
): Promise<void> {
  await row.getByLabel(`搜索目标商品 ${sku}`).fill(options.targetSearch);
  await row.getByRole('button', { name: '搜索', exact: true }).click();
  const results = row.getByTestId('sync-mapping-target-result');
  await expect(results.first()).toBeVisible({ timeout: 20_000 });
  const matching = results.filter({ hasText: options.targetSearch });
  if (await matching.count() > 0) await matching.first().click();
  else await results.first().click();
}

/** 在指定队列行完成“搜索目标 → 选商品 → 单位/理由 → 勾选行”。 */
async function fillRowForSubmit(
  page: Page,
  row: ReturnType<typeof rowLocator>,
  sku: string,
  options: { targetSearch: string; unit?: string; reason?: string; verification?: boolean },
): Promise<void> {
  await fillRowForm(page, row, sku, {
    targetSearch: options.targetSearch,
    unit: options.unit ?? '件',
    reason: options.reason ?? '验证数据，业务包装单位待确认',
    verification: options.verification,
  });
  await row.getByLabel(`单位 ${sku}`).fill(options.unit ?? '件');
  await row.getByLabel(`理由 ${sku}`).fill(options.reason ?? '验证数据，业务包装单位待确认');
  if (options.verification !== false) {
    await row.getByTestId('sync-mapping-verification-toggle').check();
  }
  const selection = row.getByRole('checkbox', { name: /^选择待处理 SKU / });
  await selection.check();
  await expect(selection).toBeChecked();
}

/** 在指定队列行完成表单并提交（单条）。 */
async function fillAndSubmitRow(
  page: Page,
  info: QueueRowInfo,
  options: {
    targetSearch?: string;
    unit?: string;
    reason?: string;
    verification?: boolean;
    batch?: boolean;
  } = {},
): Promise<string> {
  await page.goto(`/dashboard/sync?mapPage=${info.pageNumber}`);
  const row = rowLocator(page, info.rowKey);
  await expect(row).toBeVisible();
  const targetSearch = options.targetSearch ?? 'LS101295';
  await fillRowForSubmit(page, row, info.sku, {
    targetSearch,
    unit: options.unit,
    reason: options.reason,
    verification: options.verification,
  });
  const results = row.getByTestId('sync-mapping-target-result');
  const targetText = (await results.first().innerText()).trim();
  if (options.batch) {
    await page.getByTestId('sync-mapping-confirm-selected').click();
  } else {
    await row.getByTestId('sync-mapping-submit-row').click();
  }
  await expect(mappingMessage(page)).toContainText(/已提交 1 条对应/);
  return targetText;
}

async function changeIntervalAndDrop(page: Page, nextValue: number, mode: Exclude<DropMode, 'pass'>): Promise<void> {
  await gotoStable(page, '/dashboard/sync');
  const valueInput = page.getByLabel('同步频率数值');
  await valueInput.fill(String(nextValue));
  setDropMode(mode);
  await page.getByTestId('sync-save-settings').click();
  // 产品在 catch 中整页重载进入恢复入口；等待恢复面板，而不是等待被重载冲掉的组件内文案。
  await expect(page.getByTestId('sync-pending-recovery')).toBeVisible({ timeout: 60_000 });
  setDropMode('pass');
  const dropped = consumeDropped();
  expect(dropped.length, `代理应拦截至少一次 POST（${mode}）`).toBeGreaterThanOrEqual(1);
  expect(dropped[0].mode).toBe(mode);
}

async function expectLocalRecoveryPanel(page: Page) {
  // 网络异常后 router.refresh 可能稍晚；刷新一次确保从 sessionStorage 读取本地未知请求。
  await page.reload();
  await expect(page.getByTestId('sync-pending-recovery')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('sync-pending-recovery')).toHaveAttribute('data-local', 'true');
}

test('F1-1 无建议行页面单条确认成功（验证数据标记，带 requestId+intent）', async ({ page }) => {
  test.setTimeout(180_000);
  await login(page);
  const info = await findUnmappedRow(page);
  const targetText = await fillAndSubmitRow(page, info, {
    targetSearch: 'LS101295',
    unit: '件',
    reason: '验证数据，业务包装单位待确认',
    verification: true,
  });
  expect(targetText).toContain('LS101295');
  confirmedFixture = info;

  // confirmed 行不再出现在待处理队列（DB 过滤）；到商品详情“对应关系”看验证数据标记。
  const mapping = await readMapping(db, info.sku, info.warehouseExternalId);
  expect(mapping?.status).toBe('confirmed');
  expect(mapping?.version).toBe(1);
  expect(mapping?.verification).toBe(true);
  expect(mapping?.unitConfirmed).toBe(false);
  expect(mapping?.evidenceSource).toBe('manual_confirm_validation');
  expect(mapping?.itemIceCode).toBe('LS101295');
  await page.goto(`/dashboard/inventory?q=${encodeURIComponent(mapping?.itemIceCode ?? 'LS101295')}`);
  await page.getByTestId('inventory-row').filter({ hasText: mapping?.itemIceCode ?? 'LS101295' }).first()
    .getByRole('link', { name: '查看详情' }).click();
  const mappingRow = page.getByTestId('sync-confirmed-mapping-row')
    .filter({ hasText: info.sku })
    .filter({ hasText: info.warehouseName })
    .first();
  await expect(mappingRow).toContainText(/验证数据|业务单位待确认/);
  await page.screenshot({ path: test.info().outputPath('f1-single-confirm.png'), fullPage: true });
});

test('F1-2 同 SKU 两仓只确认一仓：另一仓保持无对应', async ({ page }) => {
  test.setTimeout(240_000);
  await login(page);
  const [first, second] = await findSameSkuPair(page);
  expect(first.sku).toBe(second.sku);
  expect(first.warehouseExternalId).not.toBe(second.warehouseExternalId);
  await fillAndSubmitRow(page, first, { targetSearch: 'LS101302', unit: '件', reason: '验证数据，业务包装单位待确认', verification: true });

  await page.goto(`/dashboard/sync?mapQ=${encodeURIComponent(first.sku)}`);
  const other = rowLocator(page, second.rowKey);
  await expect(other).toBeVisible();
  await expect(other).toContainText('当前没有生效的仓级对应');
  expect(await readMapping(db, second.sku, second.warehouseExternalId)).toBeNull();
  const confirmedFirst = await readMapping(db, first.sku, first.warehouseExternalId);
  expect(confirmedFirst?.status).toBe('confirmed');
  expect(confirmedFirst?.itemIceCode).toBe('LS101302');
  await page.screenshot({ path: test.info().outputPath('f1-same-sku-two-warehouses.png'), fullPage: true });
});

test('F1-2b 同页两条未对应行批量确认：只提交勾选两行', async ({ page }) => {
  test.setTimeout(240_000);
  await login(page);
  const [first, second] = await findTwoUnmappedOnSamePage(page);
  await page.goto(`/dashboard/sync?mapPage=${first.pageNumber}`);
  const rowA = rowLocator(page, first.rowKey);
  const rowB = rowLocator(page, second.rowKey);
  await fillRowForSubmit(page, rowA, first.sku, { targetSearch: 'LS101295', unit: '件', reason: '验证数据，业务包装单位待确认（批量 A）', verification: true });
  await fillRowForSubmit(page, rowB, second.sku, { targetSearch: 'LS101302', unit: '件', reason: '验证数据，业务包装单位待确认（批量 B）', verification: true });
  await page.getByTestId('sync-mapping-confirm-selected').click();
  await expect(mappingMessage(page)).toContainText(/已提交 2 条对应/);
  const mappingA = await readMapping(db, first.sku, first.warehouseExternalId);
  const mappingB = await readMapping(db, second.sku, second.warehouseExternalId);
  expect(mappingA?.status).toBe('confirmed');
  expect(mappingB?.status).toBe('confirmed');
  expect(mappingA?.verification).toBe(true);
  expect(mappingB?.verification).toBe(true);
  await page.screenshot({ path: test.info().outputPath('f1-batch-confirm.png'), fullPage: true });
});

test('F1-3 重核/停用后按当前版本重新确认；旧版本被拒绝', async ({ page, context }) => {
  test.setTimeout(300_000);
  await login(page);
  const fixture = confirmedFixture;
  expect(fixture, '需要 F1-1 先建立一条验证对应作为重核对象').toBeTruthy();
  const info = fixture as QueueRowInfo;
  const mappingBefore = await readMapping(db, info.sku, info.warehouseExternalId);
  expect(mappingBefore?.itemIceCode).toBeTruthy();
  expect(mappingBefore?.status).toBe('confirmed');
  const iceCode = mappingBefore?.itemIceCode ?? '';

  // 详情页重核（页面看到版本 = mappingBefore.version）：重核后该 (仓,SKU) 重新进入待处理队列。
  await page.goto(`/dashboard/inventory?q=${encodeURIComponent(iceCode)}`);
  const inventoryRow = page.getByTestId('inventory-row').filter({ hasText: iceCode }).first();
  await inventoryRow.getByRole('link', { name: '查看详情' }).click();
  await expect(page.getByTestId('inventory-item-detail')).toBeVisible();
  const mappingRow = page.getByTestId('sync-confirmed-mapping-row')
    .filter({ hasText: info.sku })
    .filter({ hasText: info.warehouseName })
    .first();
  await expect(mappingRow).toBeVisible();
  await page.getByLabel('对应维护理由').fill('验证数据，业务包装单位待确认（重核）');
  await mappingRow.getByRole('button', { name: '重核', exact: true }).click();
  await expect(page.getByTestId('sync-confirmed-mappings').locator('p[role="status"]')).toContainText(/已发起重核/);

  await page.goto(`/dashboard/sync?mapQ=${encodeURIComponent(info.sku)}`);
  const rowA = rowLocator(page, info.rowKey);
  await expect(rowA.getByTestId('sync-mapping-current')).toContainText(/需按第 \d+ 版重新确认|待重核/);
  const recheckVersionText = await rowA.getByTestId('sync-mapping-current').innerText();
  const recheckVersion = Number(recheckVersionText.match(/第 (\d+) 版/)?.[1]);
  // 重核/停用是状态变化，服务端保留当前 version；重新确认才递增。
  expect(recheckVersion).toBe(mappingBefore?.version ?? 1);
  await fillRowForSubmit(page, rowA, info.sku, {
    targetSearch: iceCode,
    unit: '件',
    reason: '验证数据，业务包装单位待确认（按现版重新确认）',
    verification: true,
  });

  // 另一个标签页用当前版本重新确认成功 → 版本前进；A 页仍是旧草稿，提交应被拒绝。
  const pageB = await context.newPage();
  try {
    await pageB.goto(`/dashboard/sync?mapQ=${encodeURIComponent(info.sku)}`);
    const rowB = rowLocator(pageB, info.rowKey);
    await expect(rowB).toBeVisible();
    await fillRowForSubmit(pageB, rowB, info.sku, {
      targetSearch: iceCode,
      unit: '件',
      reason: '验证数据，业务包装单位待确认（B 页现版确认）',
      verification: true,
    });
    await rowB.getByTestId('sync-mapping-submit-row').click();
    await expect(mappingMessage(pageB)).toContainText(/已提交 1 条对应/);
    const confirmedByB = await readMapping(db, info.sku, info.warehouseExternalId);
    expect(confirmedByB?.status).toBe('confirmed');
    expect(confirmedByB?.version).toBe(recheckVersion + 1);

    await rowA.getByTestId('sync-mapping-submit-row').click();
    await expect(mappingMessage(page)).toContainText(/版本|冲突|已变化|刷新/, { timeout: 30_000 });
    const afterReject = await readMapping(db, info.sku, info.warehouseExternalId);
    expect(afterReject?.version).toBe(recheckVersion + 1);
    expect(afterReject?.status).toBe('confirmed');
  } finally {
    await pageB.close();
  }

  // 停用后再次按当前版本重新确认。
  await page.goto(`/dashboard/inventory?q=${encodeURIComponent(iceCode)}`);
  await page.getByTestId('inventory-row').filter({ hasText: iceCode }).first().getByRole('link', { name: '查看详情' }).click();
  const mappingRow2 = page.getByTestId('sync-confirmed-mapping-row')
    .filter({ hasText: info.sku })
    .filter({ hasText: info.warehouseName })
    .first();
  const beforeDisable = await readMapping(db, info.sku, info.warehouseExternalId);
  await page.getByLabel('对应维护理由').fill('验证数据，业务包装单位待确认（停用）');
  await mappingRow2.getByRole('button', { name: '停用', exact: true }).click();
  await expect(page.getByTestId('sync-confirmed-mappings')).toContainText(/已停用/);

  await page.goto(`/dashboard/sync?mapQ=${encodeURIComponent(info.sku)}`);
  const rowDisabled = rowLocator(page, info.rowKey);
  await expect(rowDisabled.getByTestId('sync-mapping-current')).toContainText(/已停用|需按第 \d+ 版重新确认/);
  const disabledText = await rowDisabled.getByTestId('sync-mapping-current').innerText();
  const disabledVersion = Number(disabledText.match(/第 (\d+) 版/)?.[1]);
  expect(disabledVersion).toBe(beforeDisable?.version ?? 1);
  await fillRowForSubmit(page, rowDisabled, info.sku, {
    targetSearch: iceCode,
    unit: '件',
    reason: '验证数据，业务包装单位待确认（停用后重新确认）',
    verification: true,
  });
  await rowDisabled.getByTestId('sync-mapping-submit-row').click();
  await expect(mappingMessage(page)).toContainText(/已提交 1 条对应/);
  const finalMapping = await readMapping(db, info.sku, info.warehouseExternalId);
  expect(finalMapping?.status).toBe('confirmed');
  expect(finalMapping?.version).toBe(disabledVersion + 1);
  await page.screenshot({ path: test.info().outputPath('f1-recheck-disable-reconfirm.png'), fullPage: true });
});

test('F2 固定样本覆盖/缺口/市场/历史版本（列表与详情同范围）', async ({ page }) => {
  test.setTimeout(180_000);
  await login(page);

  // 列表 LS101295：覆盖 5/7，缺口分别有原因，不能同时“缺口：无”。
  await page.goto('/dashboard/inventory?q=LS101295');
  const listRow = page.getByTestId('inventory-row').filter({ hasText: 'LS101295' }).first();
  await expect(listRow).toBeVisible();
  await expect(listRow).toContainText(/覆盖 5\/7 仓/);
  await expect(listRow).not.toContainText('缺口：无');
  await expect(listRow).toContainText(/有来源但未对应|没有该 SKU 的来源记录/);
  await expect(listRow.getByTestId('inventory-market')).toContainText(/VN/);
  await expect(listRow.getByTestId('inventory-verification-only')).toContainText(/验证数据|业务包装单位待确认/);
  await listRow.getByRole('link', { name: '查看详情' }).click();
  await expect(page.getByTestId('inventory-item-detail')).toBeVisible();
  await expect(page.getByTestId('inventory-detail-totals')).toContainText(/5\/7 仓/);
  await expect(page.getByTestId('inventory-detail-totals')).not.toContainText('缺口：无');
  await expect(page.getByTestId('inventory-detail-verification')).toContainText(/验证数据|业务包装单位待确认/);
  // 详情按整个筛选范围列出所有仓（含无 current 行的仓）。
  const detailRows = page.getByTestId('inventory-detail-row');
  await expect(detailRows).toHaveCount(7);
  await page.screenshot({ path: test.info().outputPath('f2-list-detail-coverage.png'), fullPage: true });

  // WM0049：多市场集合 + 未知单独提示（未筛选列表）。
  await page.goto('/dashboard/inventory?q=WM0049');
  const wmRow = page.getByTestId('inventory-row').filter({ hasText: 'WM0049' }).first();
  await expect(wmRow.getByTestId('inventory-market')).toContainText(/ID/);
  await expect(wmRow.getByTestId('inventory-market')).toContainText(/MY/);
  await expect(wmRow.getByTestId('inventory-market')).toContainText(/PH/);
  await expect(wmRow.getByTestId('inventory-market')).toContainText(/VN/);
  await expect(wmRow.getByTestId('inventory-market')).toContainText('部分仓市场待确认');

  // 历史前驱按相邻更早观测（83,025→83,022，不显示 83,074）；仓库筛选到越南青林湾（50455），避免 50 条上限截掉相邻批次。
  const vnWarehouseId = await readWarehouseId(db, '50455');
  expect(vnWarehouseId).toBeTruthy();
  await page.goto(`/dashboard/inventory?q=WM0049&warehouse=${vnWarehouseId}`);
  const wmFilteredRow = page.getByTestId('inventory-row').filter({ hasText: 'WM0049' }).first();
  await wmFilteredRow.getByRole('link', { name: '查看详情' }).click();
  await expect(page.getByTestId('inventory-item-detail')).toBeVisible();
  const historyRows = page.getByTestId('inventory-detail-history-row');
  await expect(historyRows.first()).toBeVisible();
  const historyText = await historyRows.allInnerTexts();
  const expectedHistoryRow = historyText.find((text) => text.includes('83,025 → 83,022'));
  expect(expectedHistoryRow).toBeTruthy();
  expect(expectedHistoryRow).not.toContain('83,074');
  // itemRevision 有值时显示版本；缺失场景由纯模型测试覆盖（不能拿当前版本回填）。
  await page.screenshot({ path: test.info().outputPath('f2-markets-history.png'), fullPage: true });
});

test('F4-A 响应丢失（上游已落库）：核对失败保留→刷新保留→核对取得回执→只一次效果', async ({ page }) => {
  test.setTimeout(240_000);
  await login(page);
  const before = await readSettings(db);
  const nextInterval = before.intervalMinutes === 61 ? 62 : 61;
  await changeIntervalAndDrop(page, nextInterval, 'drop-response');
  const local = await readLocalUnknown(page);
  expect(local?.action).toBe('update_inventory_sync_settings');
  expect(local?.requestId).toBeTruthy();
  expect(local?.intent).toMatch(/^[a-f0-9]{64}$/);

  // 刷新后本地未知请求仍保留（服务端 pending 已完成，故由本地副本恢复）。
  await expectLocalRecoveryPanel(page);
  await page.reload();
  await expect(page.getByTestId('sync-pending-recovery')).toBeVisible();
  await expect(page.getByTestId('sync-pending-retry')).toHaveCount(0);

  // 正常核对：服务端只读回执 found；成功后本地未知副本被清除、恢复面板消失（不再显示“正在核对”）。
  await page.getByTestId('sync-pending-reconcile').click();
  await expect(page.getByTestId('sync-pending-recovery')).toHaveCount(0, { timeout: 30_000 });

  const request = await readRequest(db, local!.requestId);
  expect(request.requestCount).toBe(1);
  expect(request.hasResponse).toBe(true);
  expect(request.pendingStatus).toBe('completed');
  const after = await readSettings(db);
  expect(after.intervalMinutes).toBe(nextInterval);
  expect(after.configVersion).toBe(before.configVersion + 1);
  await page.screenshot({ path: test.info().outputPath('f4a-response-lost-reconciled.png'), fullPage: true });
});

test('F4-A2 核对请求网络失败：结果未知/失败保留，不判成未找到；刷新后仍保留', async ({ page }) => {
  test.setTimeout(240_000);
  await login(page);
  const before = await readSettings(db);
  const nextInterval = before.intervalMinutes === 61 ? 62 : 61;
  await changeIntervalAndDrop(page, nextInterval, 'drop-response');
  const local = await readLocalUnknown(page);
  expect(local?.requestId).toBeTruthy();
  await expect(page.getByTestId('sync-pending-recovery')).toBeVisible();

  // 核对请求本身网络失败：必须显示“核对失败/不代表未生效”，且仍保留原请求（没有“重试”误判）。
  setDropMode('drop-request');
  await page.getByTestId('sync-pending-reconcile').click();
  await expect(page.getByTestId('sync-pending-message')).toContainText(/核对失败|这不代表原请求未生效|连接/, { timeout: 60_000 });
  setDropMode('pass');
  expect(consumeDropped().length).toBeGreaterThanOrEqual(1);
  await expect(page.getByTestId('sync-pending-recovery')).toBeVisible();
  await expect(page.getByTestId('sync-pending-retry')).toHaveCount(0);

  // 刷新保留：本地未知副本仍在；不自动重发、不显示已解锁。
  await page.reload();
  await expect(page.getByTestId('sync-pending-recovery')).toBeVisible();
  await expect(page.getByTestId('sync-pending-recovery')).toHaveAttribute('data-local', 'true');
  const request = await readRequest(db, local!.requestId);
  expect(request.requestCount).toBe(1);
  expect(request.pendingStatus).toBe('completed');
  expect((await readSettings(db)).intervalMinutes).toBe(nextInterval);
  await page.screenshot({ path: test.info().outputPath('f4a2-reconcile-network-failed.png'), fullPage: true });

  // 清理本地未知副本（本用例只验证“核对失败保留”，已由服务端 completed/设置生效确认一次效果）。
  await page.evaluate(() => window.sessionStorage.removeItem('inventory.localUnknownRequest.v1'));
  await page.reload();
});

test('F4-B 请求未达服务端：刷新保留→核对明确未找到→原 requestId/intent 重试→只一次效果', async ({ page }) => {
  test.setTimeout(240_000);
  await login(page);
  const before = await readSettings(db);
  const nextInterval = before.intervalMinutes === 61 ? 62 : 61;
  await changeIntervalAndDrop(page, nextInterval, 'drop-request');
  const local = await readLocalUnknown(page);
  expect(local?.requestId).toBeTruthy();
  expect((await readRequest(db, local!.requestId)).requestCount).toBe(0);

  await expectLocalRecoveryPanel(page);
  await page.reload();
  await expect(page.getByTestId('sync-pending-recovery')).toBeVisible();
  // 切换/新建的恢复状态必须是“未核对”，不能继承上一条请求的 not_found/重试按钮。
  await expect(page.getByTestId('sync-pending-retry')).toHaveCount(0);
  await expect(page.getByTestId('sync-pending-reconcile-state')).toHaveCount(0);

  await page.getByTestId('sync-pending-reconcile').click();
  await expect(page.getByTestId('sync-pending-reconcile-state')).toHaveAttribute('data-state', 'not_found', { timeout: 30_000 });
  await expect(page.getByTestId('sync-pending-message')).toContainText(/明确未找到|没有落库|未生效/);
  await expect(page.getByTestId('sync-pending-retry')).toBeVisible();

  await page.getByTestId('sync-pending-retry').click();
  // 重试成功后本地未知副本被清除、恢复面板消失（服务端 completed）。
  await expect(page.getByTestId('sync-pending-recovery')).toHaveCount(0, { timeout: 30_000 });

  const request = await readRequest(db, local!.requestId);
  expect(request.requestCount).toBe(1);
  expect(request.requestIntent).toBe(local!.intent);
  expect(request.requestAction).toBe('update_inventory_sync_settings');
  expect(request.pendingStatus).toBe('completed');
  const after = await readSettings(db);
  expect(after.intervalMinutes).toBe(nextInterval);
  expect(after.configVersion).toBe(before.configVersion + 1);
  await page.screenshot({ path: test.info().outputPath('f4b-not-reached-retried.png'), fullPage: true });
});

test('F4-C 找到回执但解锁失败：不得提示已解锁，恢复后仍只一次效果', async ({ page }) => {
  test.skip(process.env.INVENTORY_DB_GRANT_ALLOWED !== '1', '需要 Lead 显式授权临时 REVOKE/GRANT（INVENTORY_DB_GRANT_ALLOWED=1）；默认只读实例不写权限');
  test.setTimeout(240_000);
  await login(page);
  // 清理上一轮失败用例可能遗留的测试 pending（仅新实例、授权清理；否则设置表单被锁）。
  await deleteAllTestPending(env);
  const before = await readSettings(db);
  const nextInterval = before.intervalMinutes === 61 ? 62 : 61;
  let capturedRequestId = '';
  const auth = facts.authorization as { grantRevokeSql: string[]; timestamps: string[]; finalPrivilege: boolean | null };
  auth.grantRevokeSql.push(`REVOKE EXECUTE ON FUNCTION catalog.complete_inventory_pending_action(uuid,text,jsonb,text) FROM ${env.appRole}`);
  auth.timestamps.push(new Date().toISOString());
  await setCompleteExecuteAllowed(env, false);
  try {
    // A 型响应丢失：业务成功但 complete 被拒 → 服务端返回 unlockFailed，pending 保持。
    await changeIntervalAndDrop(page, nextInterval, 'drop-response');
    const local = await readLocalUnknown(page);
    expect(local?.requestId).toBeTruthy();
    capturedRequestId = local?.requestId ?? '';
    // complete 被拒后 pending 仍存在：重载后由服务端 pending 渲染（不是仅本地副本）。
    await expect(page.getByTestId('sync-pending-recovery')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('sync-pending-recovery')).not.toHaveAttribute('data-local', 'true');
    await expect(page.getByRole('heading', { name: '原请求待核对' })).toBeVisible();

    await page.getByTestId('sync-pending-reconcile').click();
    await expect(page.getByTestId('sync-pending-reconcile-state')).toHaveAttribute('data-state', 'found_unlock_failed', { timeout: 30_000 });
    const stateText = await page.getByTestId('sync-pending-reconcile-state').innerText();
    expect(stateText).not.toContain('锁已解除');
    expect(stateText).not.toContain('可刷新查看最新状态');
    expect(stateText).toContain('恢复锁未解除');
    expect((await readRequest(db, capturedRequestId)).pendingStatus).toBe('pending');
  } finally {
    auth.grantRevokeSql.push(`GRANT EXECUTE ON FUNCTION catalog.complete_inventory_pending_action(uuid,text,jsonb,text) TO ${env.appRole}`);
    auth.timestamps.push(new Date().toISOString());
    await setCompleteExecuteAllowed(env, true);
    const privilegeRestored = await assertCompleteExecutePrivilege(env);
    auth.finalPrivilege = privilegeRestored;
    if (!privilegeRestored) {
      throw new Error('FATAL: complete_inventory_pending_action EXECUTE 权限恢复失败（has_function_privilege=false）；已停止后续恢复断言');
    }
  }

  // 恢复权限后继续核对：应找到回执并解除。
  await page.getByTestId('sync-pending-reconcile').click();
  await expect(page.getByTestId('sync-pending-message')).toContainText(/已核对到原请求回执|没有重复写入/, { timeout: 30_000 });
  const request = await readRequest(db, capturedRequestId);
  expect(request.requestCount).toBe(1);
  expect(request.pendingStatus).toBe('completed');
  expect((await readSettings(db)).intervalMinutes).toBe(nextInterval);
  await page.screenshot({ path: test.info().outputPath('f4c-unlock-failed-recovered.png'), fullPage: true });
});

test('F4-D 他人 pending：页面只显示账号忙碌，无 requestId/核对/重试；清理 fixture', async ({ page }) => {
  test.skip(process.env.INVENTORY_DB_GRANT_ALLOWED !== '1', '需要 Lead 授权写 fixture（INVENTORY_DB_GRANT_ALLOWED=1）');
  test.setTimeout(180_000);
  const fixture = await insertForeignPendingFixture(env);
  try {
    facts.foreignFixtureSql = fixture.sqlLog;
    await login(page);
    await page.goto('/dashboard/sync');
    const panel = page.getByTestId('sync-pending-recovery');
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(panel).toHaveAttribute('data-foreign', 'true');
    await expect(page.getByTestId('sync-pending-foreign')).toContainText(/另一位管理员|忙碌|未完成请求/);
    await expect(page.getByTestId('sync-pending-reconcile')).toHaveCount(0);
    await expect(page.getByTestId('sync-pending-retry')).toHaveCount(0);
    const panelText = await panel.innerText();
    expect(panelText).not.toContain(fixture.requestId);
    await expect(page.getByTestId('sync-controls')).toContainText(/原请求待核对|服务端同样拒绝|写操作会被拒绝/);
    await page.screenshot({ path: test.info().outputPath('f4d-foreign-pending.png'), fullPage: true });
  } finally {
    await fixture.cleanup();
    facts.foreignFixtureSql = fixture.sqlLog;
  }
});
