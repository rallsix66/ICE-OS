import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  consumeDropped,
  setDropMode,
  startProxy,
  stopProxy,
} from './repair-v4-proxy';
import {
  callBeginPending,
  deleteAllTestPending,
  deletePendingByRequestId,
  insertLegacyPendingFixture,
  legacyConfirmV3Intent,
  legacyFingerprintCollisionFixture,
  openInstanceDb,
  promoteOperatorToAdmin,
  readFirstConfirmedMapping,
  readInstanceEnv,
  readItemIdByIceCode,
  readMapping,
  readPendingRow,
  readRequest,
  readSettings,
  readTwoItemIds,
  restoreOperatorRole,
  type InstanceDb,
  type InstanceEnv,
} from './repair-v4-db';

/**
 * v4 修复包 R2（本地未知请求锁/身份/状态重置）与 R3（混合批量）真实页面验证。
 * 仅新隔离实例（run-20261026T153500Z-c4e8a1b2 / web 3034 上游 + 本地代理）。
 *
 * 运行：
 *   INVENTORY_BASE_URL=http://127.0.0.1:3044
 *   INVENTORY_UPSTREAM_URL=http://127.0.0.1:3034
 *   INVENTORY_INSTANCE_DIR=...\run-...\instance
 *   INVENTORY_BROWSER_EVIDENCE_DIR=<absolute>
 *   [INVENTORY_DB_GRANT_ALLOWED=1]  # 仅受控 fixture（旧指纹 pending / 第二管理员）需要
 *   node node_modules/@playwright/test/cli.js test tests/inventory-browser/inventory-repair-v4.browser.pw.ts --config playwright.config.inventory.ts
 *
 * 与 v3 的差异（每写动作两个 server action POST）：
 *   register（先登记）→ business（原动作）。代理按 body 分类；R2-1/R2-2/R2-3/R2-4 只丢 register，
 *   等价“请求未到服务端”；R2-7 丢 business 响应，等价“业务已落库但回执丢失”。
 * v3 已可信的 A/A2/C 分支不重跑同等流程；本文件只跑 v4 新增/变更分支。
 */

const PROXY_PORT = Number(process.env.INVENTORY_PROXY_PORT ?? 3044);
const UPSTREAM = process.env.INVENTORY_UPSTREAM_URL ?? '';
const CONFIGURED_BASE = process.env.INVENTORY_BASE_URL ?? '';
const GRANT = process.env.INVENTORY_DB_GRANT_ALLOWED === '1';

let proxyUrl = '';
let env: InstanceEnv;
let db: InstanceDb;
const facts: Record<string, unknown> = {
  suite: 'inventory-repair-v4',
  buildId: process.env.INVENTORY_BUILD_ID ?? null,
  runId: process.env.INVENTORY_EXPECTED_RUN_ID ?? null,
  upstream: process.env.INVENTORY_UPSTREAM_URL ?? null,
  proxy: null,
  guard: null,
  scenarios: [] as Array<Record<string, unknown>>,
  dbChecks: [] as Array<Record<string, unknown>>,
  fixtures: [] as Array<Record<string, unknown>>,
  reusedEvidence: [
    'v3 F1 原单条/普通批量/旧版本拒绝（执行方页面证据，本轮不重跑同等分支）',
    'v3 F4-A（响应丢失→核对取回执）与 F4-A2/C（核对失败/解锁失败）页面证据沿用；本轮只跑 v4 新增的 register/business 两段分支',
    'v3 F4-D 他人服务端 pending 分支沿用',
  ],
};

function scenario(id: string, detail: Record<string, unknown>): void {
  (facts.scenarios as Array<Record<string, unknown>>).push({ id, at: new Date().toISOString(), ...detail });
}

function dbCheck(label: string, detail: Record<string, unknown>): void {
  (facts.dbChecks as Array<Record<string, unknown>>).push({ label, at: new Date().toISOString(), ...detail });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  if (!UPSTREAM) throw new Error('INVENTORY_UPSTREAM_URL_REQUIRED（如 http://127.0.0.1:3034）');
  env = readInstanceEnv();
  facts.guard = env.guardVerification;
  if (env.guard.database.port === 53442 || env.guard.database.port === 50499 || env.guard.database.port === 59532) {
    throw new Error(`INVENTORY_PROTECTED_TARGET_DENIED: ${env.guard.database.port}`);
  }
  proxyUrl = await startProxy(UPSTREAM, PROXY_PORT);
  facts.proxy = proxyUrl;
  if (CONFIGURED_BASE !== proxyUrl) {
    throw new Error(`INVENTORY_BASE_URL 必须等于代理地址 ${proxyUrl}（当前 ${CONFIGURED_BASE || '未设置'}）`);
  }
  db = await openInstanceDb(env);
  // 上一轮异常退出可能遗留测试 pending：只在新实例、且授权时清理。
  if (GRANT) {
    const deleted = await deleteAllTestPending(env);
    if (deleted.length > 0) facts.remainingPendingCleared = deleted.length;
  }
});

test.afterAll(async () => {
  try {
    await db?.close();
  } finally {
    await stopProxy();
    const evidenceDir = process.env.INVENTORY_BROWSER_EVIDENCE_DIR;
    if (evidenceDir && fs.existsSync(evidenceDir)) {
      fs.writeFileSync(path.join(evidenceDir, 'web-report.json'), JSON.stringify(facts, null, 2));
    }
  }
});

/* ------------------------------------------------------------------ *
 * 页面辅助
 * ------------------------------------------------------------------ */

async function login(page: Page, email = 'admin@catalog.test', password = 'CatalogAdmin123!'): Promise<void> {
  await page.goto('/auth/login');
  await page.getByLabel('邮箱', { exact: true }).fill(email);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForURL(/\/dashboard/);
  // Better Auth 成功后可能跳转到配置的绝对地址；强制回到代理 origin，确保后续 POST 都走代理。
  await page.goto(`${CONFIGURED_BASE}/dashboard`);
  await page.waitForLoadState('networkidle');
}

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

interface LocalUnknownRecord {
  schemaVersion: number;
  requestId: string;
  action: string;
  intent: string;
  payload: Record<string, unknown>;
  actorId: string;
  accountId: string;
  registration: 'registered' | 'unknown';
}

async function readLocalUnknown(page: Page): Promise<LocalUnknownRecord | null> {
  return page.evaluate(() => {
    const raw = window.sessionStorage.getItem('inventory.localUnknownRequest.v1');
    return raw ? JSON.parse(raw) as LocalUnknownRecord : null;
  });
}

async function clearLocalUnknown(page: Page): Promise<void> {
  await page.evaluate(() => window.sessionStorage.removeItem('inventory.localUnknownRequest.v1'));
}

/**
 * R2 本地未知：丢“登记”POST（请求未到服务端），页面应保存 registration:'unknown' 并整页重载。
 * 返回本次本地记录 + 代理丢弃明细。
 */
async function createLocalUnknownByDroppedRegister(page: Page, nextInterval: number): Promise<{
  local: LocalUnknownRecord;
  dropped: ReturnType<typeof consumeDropped>;
}> {
  await gotoStable(page, '/dashboard/sync');
  await expect(page.getByTestId('sync-controls')).toBeVisible();
  await page.getByLabel('同步频率数值').fill(String(nextInterval));
  setDropMode('drop-request-register');
  await page.getByTestId('sync-save-settings').click();
  // 产品在 catch 中整页重载进入恢复入口；等待恢复面板出现。
  await expect(page.getByTestId('sync-pending-recovery')).toBeVisible({ timeout: 60_000 });
  setDropMode('pass');
  const dropped = consumeDropped();
  const local = await readLocalUnknown(page);
  if (!local) throw new Error('本地未知记录未保存（服务端登记被丢弃时应保存 registration:unknown）');
  return { local, dropped };
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
      // 用较长/非占位的 SKU 做混合批量：后续按 SKU 搜索时结果收敛在少数行，避免分页把两行拆开。
      if (sku.length < 6 || /^0+$/.test(sku)) continue;
      const warehouseName = (text.match(/来源仓库：([^（(]+)/)?.[1]?.trim()) ?? '';
      const previous = seen.get(sku);
      if (previous && previous.warehouseExternalId !== warehouseExternalId) {
        return [previous, { rowKey, sku, warehouseExternalId, warehouseName, text, pageNumber }];
      }
      seen.set(sku, { rowKey, sku, warehouseExternalId, warehouseName, text, pageNumber });
    }
  }
  throw new Error('没有找到同 SKU 两个仓都未对应的行（数据前置不满足）');
}

async function fillRowForSubmit(
  page: Page,
  row: ReturnType<typeof rowLocator>,
  sku: string,
  options: { targetSearch: string; unit?: string; reason?: string; verification?: boolean },
): Promise<string> {
  await row.getByLabel(`搜索目标商品 ${sku}`).fill(options.targetSearch);
  await row.getByRole('button', { name: '搜索', exact: true }).click();
  const results = row.getByTestId('sync-mapping-target-result');
  await expect(results.first()).toBeVisible({ timeout: 20_000 });
  const matching = results.filter({ hasText: options.targetSearch });
  if (await matching.count() > 0) await matching.first().click();
  else await results.first().click();
  const targetText = (await results.first().innerText()).trim();
  await row.getByLabel(`单位 ${sku}`).fill(options.unit ?? '件');
  await row.getByLabel(`理由 ${sku}`).fill(options.reason ?? '验证数据，业务包装单位待确认');
  if (options.verification !== false) {
    await row.getByTestId('sync-mapping-verification-toggle').check();
  }
  const selection = row.getByRole('checkbox', { name: /^选择待处理 SKU / });
  await selection.check();
  await expect(selection).toBeChecked();
  return targetText;
}

/* ------------------------------------------------------------------ *
 * R2-1 本地未知（登记未达服务端）：全部写入口被锁 + 不执行业务动作
 * ------------------------------------------------------------------ */
test('R2-1 本地未知锁新写：设置/立即同步/对应确认/详情维护禁用，登记未知不执行业务写', async ({ page }) => {
  test.setTimeout(240_000);
  await login(page);
  const before = await readSettings(db);
  const nextInterval = before.intervalMinutes === 73 ? 74 : 73;
  const { local, dropped } = await createLocalUnknownByDroppedRegister(page, nextInterval);
  expect(local.schemaVersion).toBe(2);
  expect(local.action).toBe('update_inventory_sync_settings');
  expect(local.registration).toBe('unknown');
  expect(local.actorId).toBe(db.adminProfileId);
  expect(local.accountId.length).toBeGreaterThan(0);
  expect(local.intent).toMatch(/^[a-f0-9]{64}$/);
  expect(dropped.length).toBe(1);
  expect(dropped[0].kind).toBe('register');
  expect(dropped[0].mode).toBe('drop-request-register');

  // 服务端确实没有这次请求（业务未执行、没有 request/pending 行）。
  const request = await readRequest(db, local.requestId);
  expect(request.requestCount).toBe(0);
  expect(request.pendingStatus).toBeNull();
  const afterSettings = await readSettings(db);
  expect(afterSettings.intervalMinutes).toBe(before.intervalMinutes);
  expect(afterSettings.configVersion).toBe(before.configVersion);

  // 页面：恢复入口 + 锁提示；四个写入口全部禁用。
  const panel = page.getByTestId('sync-pending-recovery');
  await expect(panel).toHaveAttribute('data-local', 'true');
  await expect(page.getByTestId('sync-pending-registration')).toContainText(/未确认/);
  await expect(page.getByTestId('sync-write-locked')).toBeVisible();
  const saveButton = page.getByTestId('sync-save-settings');
  await expect(saveButton).toBeDisabled();
  await expect(page.getByTestId('sync-manual-button')).toBeDisabled();
  await expect(page.getByLabel('同步频率数值')).toBeDisabled();
  await expect(page.getByLabel('开启自动同步')).toBeDisabled();
  await expect(page.getByTestId('sync-mapping-confirm-selected')).toBeDisabled();
  const firstRow = page.getByTestId('sync-mapping-row').first();
  await expect(firstRow.getByRole('checkbox', { name: /^选择待处理 SKU / })).toBeDisabled();
  await expect(firstRow.getByLabel(/^单位 /)).toBeDisabled();
  await expect(firstRow.getByTestId('sync-mapping-submit-row')).toBeDisabled();

  // 详情维护入口同样被锁。
  const confirmed = await readFirstConfirmedMapping(db);
  expect(confirmed, '需要至少一条已确认对应用于详情维护锁断言').toBeTruthy();
  await page.goto(`/dashboard/inventory?q=${encodeURIComponent(confirmed!.itemIceCode ?? '')}`);
  await page.getByTestId('inventory-row').filter({ hasText: confirmed!.itemIceCode ?? '' }).first()
    .getByRole('link', { name: '查看详情' }).click();
  const mappingRow = page.getByTestId('sync-confirmed-mapping-row')
    .filter({ hasText: confirmed!.externalSku })
    .filter({ hasText: confirmed!.warehouseName })
    .first();
  await expect(mappingRow).toBeVisible();
  await expect(page.getByTestId('sync-confirmed-locked')).toBeVisible();
  await expect(mappingRow.getByRole('button', { name: '重核', exact: true })).toBeDisabled();
  await expect(mappingRow.getByRole('button', { name: '停用', exact: true })).toBeDisabled();
  await expect(mappingRow.getByRole('button', { name: '换绑', exact: true })).toBeDisabled();
  await expect(page.getByLabel('对应维护理由')).toBeDisabled();
  await page.screenshot({ path: test.info().outputPath('r2-1-local-unknown-locked.png'), fullPage: true });

  scenario('R2-1', {
    result: 'pass',
    localRequestId: local.requestId,
    registration: local.registration,
    actorBound: local.actorId === db.adminProfileId,
    droppedRegisterPosts: dropped.length,
    requestCount: request.requestCount,
    settingsUnchanged: afterSettings.configVersion === before.configVersion,
  });
  dbCheck('R2-1 登记未达服务端不执行业务写', { requestCount: 0, pendingStatus: null, configVersion: before.configVersion });
  await clearLocalUnknown(page);
});

/* ------------------------------------------------------------------ *
 * R2-2 换管理员：B 不能接管 A 的本地记录，且 B 的新写仍被锁
 * ------------------------------------------------------------------ */
test('R2-2 换管理员不能接管 A 的本地原请求，新写仍锁定', async ({ page }) => {
  test.setTimeout(300_000);
  test.skip(!GRANT, '需要 Lead 授权（INVENTORY_DB_GRANT_ALLOWED=1）临时提升种子 operator 为 admin 以真实登录第二管理员');
  await promoteOperatorToAdmin(env);
  try {
    await login(page);
    const before = await readSettings(db);
    const nextInterval = before.intervalMinutes === 71 ? 72 : 71;
    const { local } = await createLocalUnknownByDroppedRegister(page, nextInterval);
    expect(local.actorId).toBe(db.adminProfileId);

    // A 退出登录（不改动本地 record），同浏览器登录 B（operator 临时提升为 admin）。
    await page.getByRole('button', { name: '退出登录' }).click();
    await page.waitForURL(/\/auth\/login/);
    const stillThere = await readLocalUnknown(page);
    expect(stillThere?.requestId).toBe(local.requestId);
    await login(page, 'operator@catalog.test', 'CatalogOperator123!');
    await gotoStable(page, '/dashboard/sync');

    const panel = page.getByTestId('sync-pending-recovery');
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(panel).toHaveAttribute('data-local', 'true');
    await expect(panel).toHaveAttribute('data-untrusted', 'true');
    await expect(page.getByTestId('sync-pending-local-untrusted')).toContainText(/另一位管理员|原管理员/);
    await expect(page.getByTestId('sync-pending-reconcile')).toHaveCount(0);
    await expect(page.getByTestId('sync-pending-retry')).toHaveCount(0);
    // B 的新写仍被本地记录锁住。
    await expect(page.getByTestId('sync-save-settings')).toBeDisabled();
    await expect(page.getByTestId('sync-manual-button')).toBeDisabled();
    const recordAfter = await readLocalUnknown(page);
    expect(recordAfter?.actorId).toBe(local.actorId);
    expect(recordAfter?.requestId).toBe(local.requestId);
    await page.screenshot({ path: test.info().outputPath('r2-2-second-admin-cannot-take-over.png'), fullPage: true });

    scenario('R2-2', {
      result: 'pass',
      originalActor: local.actorId,
      secondAdminActor: '11111111-1111-4111-8111-111111111104',
      untrustedPanel: true,
      noExecuteButtons: true,
      secondAdminWritesLocked: true,
    });
    dbCheck('R2-2 B 未产生业务写', {
      requestCount: (await readRequest(db, local.requestId)).requestCount,
      settingsConfigVersion: (await readSettings(db)).configVersion,
    });
  } finally {
    await clearLocalUnknown(page).catch(() => undefined);
    await restoreOperatorRole(env);
  }
});

/* ------------------------------------------------------------------ *
 * R2-3 换请求必须先核对：新 requestId 不继承上一条 not_found/重试按钮
 * ------------------------------------------------------------------ */
test('R2-3 本地换成另一条请求后必须先核对，不继承旧 not_found/重试', async ({ page }) => {
  test.setTimeout(240_000);
  await login(page);
  const before = await readSettings(db);
  const nextInterval = before.intervalMinutes === 69 ? 70 : 69;
  const { local: first } = await createLocalUnknownByDroppedRegister(page, nextInterval);

  // 第一条：核对 → 明确未找到 → 出现重试按钮。
  await page.getByTestId('sync-pending-reconcile').click();
  await expect(page.getByTestId('sync-pending-reconcile-state')).toHaveAttribute('data-state', 'not_found', { timeout: 30_000 });
  await expect(page.getByTestId('sync-pending-retry')).toBeVisible();

  // 换一条新的原请求记录（同 payload/intent，新 requestId）→ 状态必须重置。
  await page.evaluate((payload: Record<string, unknown>) => {
    window.sessionStorage.setItem('inventory.localUnknownRequest.v1', JSON.stringify(payload));
  }, {
    schemaVersion: 2,
    requestId: crypto.randomUUID(),
    action: first.action,
    intent: first.intent,
    intentVersion: 'v4',
    payload: first.payload,
    createdAt: new Date().toISOString(),
    actorId: first.actorId,
    accountId: first.accountId,
    registration: 'unknown',
    trusted: true,
  });
  const second = await readLocalUnknown(page);
  expect(second?.requestId).not.toBe(first.requestId);
  await page.reload();
  const panel = page.getByTestId('sync-pending-recovery');
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await expect(panel).toHaveAttribute('data-local', 'true');
  // 页面展示的就是第二条请求（sessionStorage 中的新 requestId），旧请求的核对状态未继承。
  const shown = await readLocalUnknown(page);
  expect(shown?.requestId).toBe(second!.requestId);
  await expect(page.getByTestId('sync-pending-retry')).toHaveCount(0);
  await expect(page.getByTestId('sync-pending-reconcile-state')).toHaveCount(0);
  await expect(page.getByTestId('sync-pending-message')).toContainText('先核对；只有');

  // 新请求自己的核对：not_found 后才出现重试。
  await page.getByTestId('sync-pending-reconcile').click();
  await expect(page.getByTestId('sync-pending-reconcile-state')).toHaveAttribute('data-state', 'not_found', { timeout: 30_000 });
  await expect(page.getByTestId('sync-pending-retry')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('r2-3-request-switch-reset.png'), fullPage: true });

  scenario('R2-3', {
    result: 'pass',
    firstRequestId: first.requestId,
    secondRequestId: second!.requestId,
    inheritedNotFoundCleared: true,
    retryShownOnlyAfterOwnReconcile: true,
  });
  dbCheck('R2-3 两条请求都未产生业务写', {
    firstRequestCount: (await readRequest(db, first.requestId)).requestCount,
    secondRequestCount: (await readRequest(db, second!.requestId)).requestCount,
  });
  await clearLocalUnknown(page);
});

/* ------------------------------------------------------------------ *
 * R2-7 登记成功、业务回执丢失：本地记录 registration:'registered'，服务端 pending 恢复
 * ------------------------------------------------------------------ */
test('R2-7 业务回执丢失：登记成功→本地保留 registered→服务端 pending 核对解除（一次效果）', async ({ page }) => {
  test.setTimeout(240_000);
  await login(page);
  const before = await readSettings(db);
  const nextInterval = before.intervalMinutes === 67 ? 68 : 67;
  await gotoStable(page, '/dashboard/sync');
  await page.getByLabel('同步频率数值').fill(String(nextInterval));
  setDropMode('drop-response-business');
  await page.getByTestId('sync-save-settings').click();
  await expect(page.getByTestId('sync-pending-recovery')).toBeVisible({ timeout: 60_000 });
  setDropMode('pass');
  const dropped = consumeDropped();
  expect(dropped.length).toBe(1);
  expect(dropped[0].kind).toBe('business');

  // 登记成功 → 本地记录保留（registered）；业务可能已落库（响应被丢弃）。
  await page.reload();
  const local = await readLocalUnknown(page);
  expect(local, '业务回执丢失后应保留已登记的本地记录').toBeTruthy();
  expect(local!.registration).toBe('registered');
  expect(local!.actorId).toBe(db.adminProfileId);
  const beforeReconcile = await readRequest(db, local!.requestId);
  expect(beforeReconcile.requestCount).toBe(1);
  expect(beforeReconcile.pendingStatus).toBe('completed');

  // 核对取得原回执 → 本地副本清除、面板消失；设置只生效一次。
  await expect(page.getByTestId('sync-pending-registration')).toContainText(/已确认登记/);
  await page.getByTestId('sync-pending-reconcile').click();
  await expect(page.getByTestId('sync-pending-recovery')).toHaveCount(0, { timeout: 30_000 });
  const request = await readRequest(db, local!.requestId);
  expect(request.requestCount).toBe(1);
  expect(request.pendingStatus).toBe('completed');
  expect(request.requestIntent).toBe(local!.intent);
  const after = await readSettings(db);
  expect(after.intervalMinutes).toBe(nextInterval);
  expect(after.configVersion).toBe(before.configVersion + 1);
  expect(await readLocalUnknown(page)).toBeNull();
  await page.screenshot({ path: test.info().outputPath('r2-7-business-response-lost.png'), fullPage: true });

  scenario('R2-7', {
    result: 'pass',
    localRequestId: local!.requestId,
    registration: local!.registration,
    requestCount: request.requestCount,
    pendingStatus: request.pendingStatus,
    configVersionDelta: after.configVersion - before.configVersion,
  });
  dbCheck('R2-7 业务只一次效果', {
    requestCount: 1,
    pendingStatus: 'completed',
    intervalMinutes: after.intervalMinutes,
    configVersion: after.configVersion,
  });
});

/* ------------------------------------------------------------------ *
 * R2-4 合法原请求重试只一次业务效果（DB 断言）
 * ------------------------------------------------------------------ */
test('R2-4 明确未找到后重试原请求：只一次业务效果（requestId/intent 不变）', async ({ page }) => {
  test.setTimeout(240_000);
  await login(page);
  const before = await readSettings(db);
  const nextInterval = before.intervalMinutes === 65 ? 66 : 65;
  const { local, dropped } = await createLocalUnknownByDroppedRegister(page, nextInterval);
  expect(dropped[0].kind).toBe('register');
  expect((await readRequest(db, local.requestId)).requestCount).toBe(0);

  await page.getByTestId('sync-pending-reconcile').click();
  await expect(page.getByTestId('sync-pending-reconcile-state')).toHaveAttribute('data-state', 'not_found', { timeout: 30_000 });
  await page.getByTestId('sync-pending-retry').click();
  await expect(page.getByTestId('sync-pending-recovery')).toHaveCount(0, { timeout: 40_000 });

  const request = await readRequest(db, local.requestId);
  expect(request.requestCount).toBe(1);
  expect(request.requestIntent).toBe(local.intent);
  expect(request.requestAction).toBe('update_inventory_sync_settings');
  expect(request.pendingStatus).toBe('completed');
  const after = await readSettings(db);
  expect(after.intervalMinutes).toBe(nextInterval);
  expect(after.configVersion).toBe(before.configVersion + 1);
  await page.screenshot({ path: test.info().outputPath('r2-4-retry-single-effect.png'), fullPage: true });

  scenario('R2-4', {
    result: 'pass',
    requestId: local.requestId,
    sameIntent: request.requestIntent === local.intent,
    requestCount: request.requestCount,
    pendingStatus: request.pendingStatus,
    configVersionDelta: after.configVersion - before.configVersion,
  });
  dbCheck('R2-4 重试只一次效果', {
    requestCount: 1,
    intentPreserved: true,
    intervalMinutes: after.intervalMinutes,
    configVersion: after.configVersion,
  });
});

/* ------------------------------------------------------------------ *
 * R2-5 同旧指纹不同确认内容被拒（真实 app RPC：begin 拒绝）
 * ------------------------------------------------------------------ */
test('R2-5 同旧 v3 指纹、不同确认内容被 begin 拒绝（INVENTORY_REQUEST_CONFLICT）', async () => {
  test.setTimeout(180_000);
  test.skip(!GRANT, '需要 Lead 授权（INVENTORY_DB_GRANT_ALLOWED=1）写旧指纹 pending fixture 并调用 begin RPC');
  const items = await readTwoItemIds(db);
  expect(items, '需要至少两个商品').toBeTruthy();
  const [itemA, itemB] = items as [string, string];
  const collision = legacyFingerprintCollisionFixture(itemA, itemB);
  // 旧 v3 编码下“一条备注内嵌第二条”与“两条不同映射”文本相同（已修复反例可复现）。
  expect(collision.legacyTextOne).toBe(collision.legacyTextTwo);
  const legacyIntent = legacyConfirmV3Intent([collision.one]);
  expect(legacyConfirmV3Intent(collision.two)).toBe(legacyIntent);

  const fixture = await insertLegacyPendingFixture(env, db, {
    action: 'confirm_inventory_mapping',
    intent: legacyIntent,
    payload: { mappings: [collision.one] },
  });
  (facts.fixtures as Array<Record<string, unknown>>).push({ name: 'r2-5-legacy-confirm-pending', ...fixture });
  try {
    // 同 requestId/旧 intent、不同确认行集合 → 必须拒绝（不能返回旧回执当成功）。
    const conflict = await callBeginPending(env, {
      requestId: fixture.requestId,
      intent: legacyIntent,
      action: 'confirm_inventory_mapping',
      payload: { mappings: collision.two },
      profileId: db.adminProfileId,
    });
    expect(conflict.ok).toBe(false);
    expect(conflict.code).toBe('23505');
    expect(conflict.message).toContain('INVENTORY_REQUEST_CONFLICT');

    // 同 requestId/旧 intent、原内容重放 → 允许（登记内容权威）。
    const replay = await callBeginPending(env, {
      requestId: fixture.requestId,
      intent: legacyIntent,
      action: 'confirm_inventory_mapping',
      payload: { mappings: [collision.one] },
      profileId: db.adminProfileId,
    });
    expect(replay.ok).toBe(true);
    expect((replay.result as { replayed?: boolean } | null)?.replayed).toBe(true);

    const pending = await readPendingRow(db, fixture.requestId);
    expect(pending?.status).toBe('pending');
    expect(pending?.intentHash).toBe(legacyIntent);
    scenario('R2-5', {
      result: 'pass',
      requestId: fixture.requestId,
      legacyTextCollisionReproduced: true,
      conflictErrorCode: conflict.code,
      conflictMessage: conflict.message,
      sameContentReplayAllowed: true,
    });
    dbCheck('R2-5 同旧指纹不同内容被拒', {
      errorCode: 'INVENTORY_REQUEST_CONFLICT',
      pendingStillOnlyOriginal: true,
    });
  } finally {
    await deletePendingByRequestId(env, fixture.requestId);
  }
});

/* ------------------------------------------------------------------ *
 * R2-6 旧可信 server pending（v3 指纹）仍可核对/恢复
 * ------------------------------------------------------------------ */
test('R2-6 旧 v3 指纹服务端 pending：页面核对明确未找到→原参数重试→恢复且一次效果', async ({ page }) => {
  test.setTimeout(300_000);
  test.skip(!GRANT, '需要 Lead 授权（INVENTORY_DB_GRANT_ALLOWED=1）写旧 v3 指纹 server pending fixture');
  await login(page);
  const info = await findUnmappedRow(page);
  const itemId = await readItemIdByIceCode(db, 'LS101295');
  expect(itemId, '需要 LS101295 商品 id 作为确认目标').toBeTruthy();
  const mapping = {
    externalSku: info.sku,
    warehouseExternalId: info.warehouseExternalId,
    itemId: itemId as string,
    unit: '件',
    expectedVersion: null,
    reason: '验证数据，业务包装单位待确认（旧指纹恢复）',
    note: null,
    verification: true,
  };
  const legacyIntent = legacyConfirmV3Intent([mapping]);
  const fixture = await insertLegacyPendingFixture(env, db, {
    action: 'confirm_inventory_mapping',
    intent: legacyIntent,
    payload: { mappings: [mapping] },
  });
  (facts.fixtures as Array<Record<string, unknown>>).push({ name: 'r2-6-legacy-confirm-pending', sku: info.sku, warehouseExternalId: info.warehouseExternalId, ...fixture });
  try {
    await page.reload();
    const panel = page.getByTestId('sync-pending-recovery');
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(panel).not.toHaveAttribute('data-local', 'true');
    await expect(page.getByRole('heading', { name: '原请求待核对' })).toBeVisible();
    await page.getByTestId('sync-pending-reconcile').click();
    await expect(page.getByTestId('sync-pending-reconcile-state')).toHaveAttribute('data-state', 'not_found', { timeout: 30_000 });
    await page.getByTestId('sync-pending-retry').click();
    // 重试成功：服务端 pending 完成、恢复面板消失（结果消息随面板一起卸载，去 DB 断言唯一效果）。
    await expect(page.getByTestId('sync-pending-recovery')).toHaveCount(0, { timeout: 40_000 });

    const recovered = await readMapping(db, info.sku, info.warehouseExternalId);
    expect(recovered?.status).toBe('confirmed');
    expect(recovered?.version).toBe(1);
    expect(recovered?.itemId).toBe(itemId);
    expect(recovered?.unit).toBe('件');
    const request = await readRequest(db, fixture.requestId);
    expect(request.requestCount).toBe(1);
    expect(request.requestAction).toBe('confirm_inventory_mapping');
    expect(request.requestIntent).toBe(legacyIntent);
    expect(request.pendingStatus).toBe('completed');
    await page.screenshot({ path: test.info().outputPath('r2-6-legacy-pending-recovered.png'), fullPage: true });

    scenario('R2-6', {
      result: 'pass',
      requestId: fixture.requestId,
      legacyIntentPreserved: true,
      pendingStatus: request.pendingStatus,
      mappingVersion: recovered?.version,
      mappingSku: info.sku,
      warehouseExternalId: info.warehouseExternalId,
    });
    dbCheck('R2-6 旧指纹 pending 恢复且一次效果', {
      requestCount: 1,
      pendingStatus: 'completed',
      legacyIntent: legacyIntent.slice(0, 16),
      mappingVersion: recovered?.version,
    });
  } finally {
    await deletePendingByRequestId(env, fixture.requestId).catch(() => undefined);
  }
});

/* ------------------------------------------------------------------ *
 * R3-1 实际页面混合批量：首次确认行 + 已有对应重确认行，一次提交成功，两行版本正确
 * ------------------------------------------------------------------ */
test('R3-1 页面混合批量（首次行+重确认行）成功，DB 版本 1 与旧版+1', async ({ page }) => {
  test.setTimeout(360_000);
  await login(page);
  const [first, second] = await findSameSkuPair(page);
  expect(first.sku).toBe(second.sku);
  expect(first.warehouseExternalId).not.toBe(second.warehouseExternalId);

  // 1) 先给 A 仓建立首次对应（版本 1）。
  await page.goto(`/dashboard/sync?mapPage=${first.pageNumber}`);
  const rowFirst = rowLocator(page, first.rowKey);
  await expect(rowFirst).toBeVisible();
  await fillRowForSubmit(page, rowFirst, first.sku, {
    targetSearch: 'LS101295',
    unit: '件',
    reason: '验证数据，业务包装单位待确认（混合批量首次）',
  });
  await rowFirst.getByTestId('sync-mapping-submit-row').click();
  await expect(mappingMessage(page)).toContainText(/已提交 1 条对应/);
  const beforeRecheck = await readMapping(db, first.sku, first.warehouseExternalId);
  expect(beforeRecheck?.status).toBe('confirmed');
  expect(beforeRecheck?.version).toBe(1);
  const iceCode = beforeRecheck?.itemIceCode ?? 'LS101295';

  // 2) 详情页重核 A 仓对应 → 该行带 currentMapping 版本回到待处理队列。
  await page.goto(`/dashboard/inventory?q=${encodeURIComponent(iceCode)}`);
  await page.getByTestId('inventory-row').filter({ hasText: iceCode }).first()
    .getByRole('link', { name: '查看详情' }).click();
  await expect(page.getByTestId('inventory-item-detail')).toBeVisible();
  const mappingRow = page.getByTestId('sync-confirmed-mapping-row')
    .filter({ hasText: first.sku })
    .filter({ hasText: first.warehouseName })
    .first();
  await expect(mappingRow).toBeVisible();
  await page.getByLabel('对应维护理由').fill('验证数据，业务包装单位待确认（混合批量重核）');
  await mappingRow.getByRole('button', { name: '重核', exact: true }).click();
  await expect(page.getByTestId('sync-confirmed-mappings').locator('p[role="status"]')).toContainText(/已发起重核/);

  // 3) 同一页同时有“首次行（B 仓）”和“已有对应重确认行（A 仓）”，一次批量提交。
  await page.goto(`/dashboard/sync?mapQ=${encodeURIComponent(first.sku)}`);
  const rowA = rowLocator(page, first.rowKey);
  const rowB = rowLocator(page, second.rowKey);
  await expect(rowA).toBeVisible();
  await expect(rowB).toBeVisible();
  await expect(rowA.getByTestId('sync-mapping-current')).toContainText(/第 1 版/);
  await expect(rowB).toContainText('当前没有生效的仓级对应');
  await fillRowForSubmit(page, rowA, first.sku, {
    targetSearch: iceCode,
    unit: '件',
    reason: '验证数据，业务包装单位待确认（混合批量重确认）',
  });
  await fillRowForSubmit(page, rowB, second.sku, {
    targetSearch: iceCode,
    unit: '件',
    reason: '验证数据，业务包装单位待确认（混合批量首次）',
  });
  await page.screenshot({ path: test.info().outputPath('r3-1-mixed-batch-before-submit.png'), fullPage: true });
  await page.getByTestId('sync-mapping-confirm-selected').click();
  await expect(mappingMessage(page)).toContainText(/已提交 2 条对应/, { timeout: 40_000 });

  // 4) DB：重确认行旧版+1；首次行版本 1；两行都 confirmed。
  const reconfirmed = await readMapping(db, first.sku, first.warehouseExternalId);
  const firstTime = await readMapping(db, second.sku, second.warehouseExternalId);
  expect(reconfirmed?.status).toBe('confirmed');
  expect(reconfirmed?.version).toBe(beforeRecheck!.version + 1);
  expect(reconfirmed?.version).toBe(2);
  expect(firstTime?.status).toBe('confirmed');
  expect(firstTime?.version).toBe(1);
  await page.screenshot({ path: test.info().outputPath('r3-1-mixed-batch-after.png'), fullPage: true });

  scenario('R3-1', {
    result: 'pass',
    sku: first.sku,
    reconfirmWarehouse: first.warehouseExternalId,
    reconfirmVersionBefore: beforeRecheck?.version,
    reconfirmVersionAfter: reconfirmed?.version,
    firstTimeWarehouse: second.warehouseExternalId,
    firstTimeVersion: firstTime?.version,
    pageMessage: '已提交 2 条对应',
  });
  dbCheck('R3-1 混合批量两行版本', {
    reconfirmVersion: reconfirmed?.version,
    firstTimeVersion: firstTime?.version,
  });
});
