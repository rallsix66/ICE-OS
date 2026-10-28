import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { Client } from 'pg';
import { assertConnectedTarget } from '../../scripts/inventory/test-target-guard.mjs';
import { consumeDropped, setDropMode, startProxy, stopProxy } from './repair-v4-proxy';
import { openInstanceDb, readInstanceEnv, readPendingRow, readSettings, type InstanceDb, type InstanceEnv } from './repair-v4-db';

/**
 * v4-final A（R2 失败结案）最小真实页面链 —— 只跑一条主链，只在新隔离实例。
 *
 * 场景（v4 独审 R2 正常恢复路径）：
 *   本地未知（register 请求被丢，服务端没有任何 pending/request）
 *   → 核对原请求 = 明确未找到
 *   → 另一会话把参与范围清空（真实 app RPC，与页面同账号）
 *   → 重试原操作（同 requestId + intent + 原参数）遇 INVENTORY_SCOPE_EMPTY
 *   → 服务端 settle 确认 SETTLED（页面清除本地记录、解除写锁）→ 设置可修改
 *   DB 断言：catalog.inventory_pending_action.status='failed'、error_code='INVENTORY_SCOPE_EMPTY'、
 *   无 inventory_request 行；之后页面保存设置成功（config_version + interval 真落库）。
 *
 * 运行（等 Lead 通知 BUILD 就绪；web 3035 上游 + 本地代理 3045）：
 *   INVENTORY_BASE_URL=http://127.0.0.1:3045
 *   INVENTORY_UPSTREAM_URL=http://127.0.0.1:3035
 *   INVENTORY_PROXY_PORT=3045
 *   INVENTORY_INSTANCE_DIR=<...run-20261026T164500Z-e8f9a0b1>/instance
 *   INVENTORY_EXPECTED_RUN_ID=run-20261026T164500Z-e8f9a0b1
 *   INVENTORY_BROWSER_EVIDENCE_DIR=<absolute .../a/browser>
 *   node node_modules/@playwright/test/cli.js test tests/inventory-browser/inventory-settlement-v4-final.browser.pw.ts --config playwright.config.inventory.ts
 */

const PROXY_PORT = Number(process.env.INVENTORY_PROXY_PORT ?? 3045);
const UPSTREAM = process.env.INVENTORY_UPSTREAM_URL ?? '';
const CONFIGURED_BASE = process.env.INVENTORY_BASE_URL ?? '';
const LOCAL_STORAGE_KEY = 'inventory.localUnknownRequest.v1';
const PROTECTED_PORTS = new Set([53442, 50499, 59532, 61135]);

let proxyUrl = '';
let env: InstanceEnv;
let db: InstanceDb;
let originalScope: ScopeSnapshot | null = null;
const facts: Record<string, unknown> = {
  suite: 'inventory-settlement-v4-final',
  buildId: process.env.INVENTORY_BUILD_ID ?? null,
  runId: process.env.INVENTORY_EXPECTED_RUN_ID ?? null,
  upstream: process.env.INVENTORY_UPSTREAM_URL ?? null,
  proxy: null,
  guard: null,
  steps: [] as Array<Record<string, unknown>>,
};

function step(id: string, detail: Record<string, unknown>): void {
  (facts.steps as Array<Record<string, unknown>>).push({ id, at: new Date().toISOString(), ...detail });
}

function intentHash(): string {
  return crypto.randomBytes(32).toString('hex');
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  if (!UPSTREAM) throw new Error('INVENTORY_UPSTREAM_URL_REQUIRED（如 http://127.0.0.1:3035）');
  env = readInstanceEnv();
  facts.guard = env.guardVerification;
  if (PROTECTED_PORTS.has(env.guard.database.port)) {
    throw new Error(`INVENTORY_PROTECTED_TARGET_DENIED: ${env.guard.database.port}`);
  }
  if (env.runId !== 'run-20261026T164500Z-e8f9a0b1') {
    throw new Error(`INVENTORY_WRONG_RUN_ID: ${env.runId}`);
  }
  proxyUrl = await startProxy(UPSTREAM, PROXY_PORT);
  facts.proxy = proxyUrl;
  if (CONFIGURED_BASE !== proxyUrl) {
    throw new Error(`INVENTORY_BASE_URL 必须等于代理地址 ${proxyUrl}（当前 ${CONFIGURED_BASE || '未设置'}）`);
  }
  db = await openInstanceDb(env);
  originalScope = await readScopeSnapshot();
  facts.scopeBefore = originalScope;
});

test.afterAll(async () => {
  try {
    // 无论断言在哪一步失败，都把新实例的参与范围/频率/enabled 还原到本轮开始时（B 的列表断言依赖范围）。
    if (db && originalScope) {
      try {
        const current = await readScopeSnapshot();
        const sameScope = current.warehouseIds.length === originalScope.warehouseIds.length
          && [...current.warehouseIds].map(String).sort().join(',')
            === [...originalScope.warehouseIds].map(String).sort().join(',');
        if (!sameScope || current.intervalMinutes !== originalScope.intervalMinutes
          || current.enabled !== originalScope.enabled) {
          const restored = await callSettingsRpc({
            enabled: originalScope.enabled,
            intervalMinutes: originalScope.intervalMinutes,
            scopeProvided: true,
            warehouseIds: originalScope.warehouseIds.map((id) => String(id)),
          });
          facts.scopeRestoredInAfterAll = restored.settings;
        }
      } catch (error) {
        facts.scopeRestoreError = error instanceof Error ? error.message : String(error);
      }
    }
  } finally {
    await db?.close();
    await stopProxy();
    const evidenceDir = process.env.INVENTORY_BROWSER_EVIDENCE_DIR;
    if (evidenceDir && fs.existsSync(evidenceDir)) {
      fs.writeFileSync(path.join(evidenceDir, 'settlement-report.json'), JSON.stringify(facts, null, 2));
    }
  }
});

/* ------------------------------------------------------------------ *
 * 页面/DB 辅助
 * ------------------------------------------------------------------ */

async function login(page: Page): Promise<void> {
  await page.goto('/auth/login');
  await page.getByLabel('邮箱', { exact: true }).fill('admin@catalog.test');
  await page.getByLabel('密码', { exact: true }).fill('CatalogAdmin123!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForURL(/\/dashboard/);
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

async function readLocalRecord(page: Page): Promise<Record<string, unknown> | null> {
  return page.evaluate((key) => {
    const raw = window.sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  }, LOCAL_STORAGE_KEY);
}

interface ScopeSnapshot {
  warehouseIds: string[];
  enabled: boolean;
  intervalMinutes: number;
  configVersion: number;
}

async function readScopeSnapshot(): Promise<ScopeSnapshot> {
  const result = await db.client.query<{
    warehouse_ids: string[]; enabled: boolean; interval_minutes: number; config_version: number;
  }>(
    `SELECT s.warehouse_ids, st.enabled, st.interval_minutes, st.config_version
       FROM catalog.inventory_sync_settings st
       JOIN catalog.inventory_scope s ON s.id = st.scope_id
      ORDER BY st.updated_at DESC LIMIT 1`,
  );
  if (result.rowCount !== 1) throw new Error('INVENTORY_SCOPE_ROW_MISSING');
  const row = result.rows[0];
  return {
    warehouseIds: row.warehouse_ids,
    enabled: row.enabled,
    intervalMinutes: row.interval_minutes,
    configVersion: row.config_version,
  };
}

interface SettingsRpcResult {
  ok: boolean;
  settings: { scopeEmpty: boolean; warehouseCount: number; intervalMinutes: number; configVersion: number };
}

/** 以 app 角色真实调用设置 RPC（等价另一会话修改范围；不经 fixture/owner 写）。 */
async function callSettingsRpc(input: {
  enabled: boolean;
  intervalMinutes: number;
  scopeProvided: boolean;
  warehouseIds: string[];
}): Promise<SettingsRpcResult> {
  const client = new Client({ connectionString: env.appDbUrl, database: env.database });
  await client.connect();
  try {
    await assertConnectedTarget(client, env.guard as never, 'settlement-chain-settings-rpc');
    await client.query('BEGIN');
    await client.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [db.adminProfileId]);
    try {
      const result = await client.query<{ r: SettingsRpcResult }>(
        'SELECT catalog.update_inventory_sync_settings($1,$2,$3,$4,$5,$6::text[]) AS r',
        [
          crypto.randomUUID(),
          intentHash(),
          input.enabled,
          input.intervalMinutes,
          input.scopeProvided,
          input.warehouseIds,
        ],
      );
      await client.query('COMMIT');
      return result.rows[0].r;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  } finally {
    await client.end();
  }
}

/* ------------------------------------------------------------------ *
 * 唯一主链
 * ------------------------------------------------------------------ */

test('settled definite retry failure releases the local lock and settings become editable', async ({ page }) => {
  await login(page);
  const before = originalScope;
  if (!before) throw new Error('INVENTORY_SCOPE_SNAPSHOT_MISSING');
  expect(before.warehouseIds.length).toBeGreaterThan(0);

  await gotoStable(page, `${CONFIGURED_BASE}/dashboard/sync`);
  await page.getByTestId('sync-controls').waitFor();
  await expect(page.getByTestId('sync-write-locked')).toHaveCount(0);
  await expect(page.getByTestId('sync-manual-button')).toBeEnabled();

  // 1) 本地未知：登记请求被代理丢弃（服务端不会出现 pending/request），页面保存本地 v2 记录并整页重载。
  setDropMode('drop-request-register');
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => null),
    page.getByTestId('sync-manual-button').click().catch(() => null),
  ]);
  await page.waitForLoadState('networkidle');
  const dropped = consumeDropped();
  step('local-unknown-register-dropped', { dropped, url: page.url() });
  expect(dropped.some((entry) => entry.kind === 'register' && entry.mode === 'drop-request-register')).toBe(true);
  await page.getByTestId('sync-pending-recovery').waitFor();

  const local = await readLocalRecord(page);
  expect(local).toBeTruthy();
  const requestId = String(local?.requestId ?? '');
  expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
  expect(local?.action).toBe('request_inventory_manual_sync');
  step('local-record-saved', { requestId, action: local?.action, registration: local?.registration });
  await expect(page.getByTestId('sync-write-locked')).toBeVisible();
  await expect(page.getByTestId('sync-save-settings')).toBeDisabled();
  // 服务端此刻没有任何 pending/request（本地未知的判据）。
  expect(await readPendingRow(db, requestId)).toBeNull();

  // 2) 核对 → 服务端明确未找到（该请求从未到达）。
  await page.getByTestId('sync-pending-reconcile').click();
  await expect(page.getByTestId('sync-pending-reconcile-state')).toHaveAttribute('data-state', 'not_found');
  await expect(page.getByTestId('sync-pending-retry')).toBeVisible();
  step('reconcile-not-found', {
    state: await page.getByTestId('sync-pending-reconcile-state').getAttribute('data-state'),
    message: await page.getByTestId('sync-pending-message').innerText(),
  });

  // 3) “另一会话”清空参与范围 → 重试时后台确定拒绝 INVENTORY_SCOPE_EMPTY。
  const cleared = await callSettingsRpc({
    enabled: false,
    intervalMinutes: before.intervalMinutes,
    scopeProvided: true,
    warehouseIds: [],
  });
  expect(cleared.settings.scopeEmpty).toBe(true);
  step('scope-cleared-by-other-session', { settings: cleared.settings });

  // 4) 重试原操作：同 requestId/intent/原参数；业务拒绝 → settle 确认 SETTLED → 页面解锁。
  await page.getByTestId('sync-pending-retry').click();
  await expect(page.getByTestId('sync-save-settings')).toBeEnabled({ timeout: 30_000 });
  await expect(page.getByTestId('sync-write-locked')).toHaveCount(0);
  await expect(page.getByTestId('sync-manual-button')).toBeDisabled(); // 空范围仍阻止立即同步
  await expect(page.locator('[data-testid="sync-pending-recovery"]')).toHaveCount(0);
  expect(await readLocalRecord(page)).toBeNull();
  const messageAfter = (await page.getByTestId('sync-pending-message').count()) > 0
    ? await page.getByTestId('sync-pending-message').innerText()
    : null;
  step('retry-settled-unlocked', {
    message: messageAfter,
    localRecordCleared: (await readLocalRecord(page)) === null,
    saveEnabled: await page.getByTestId('sync-save-settings').isEnabled(),
  });

  // 5) DB 断言：原 pending 已 failed（结案），没有业务 request 回执；本地记录已清除。
  const pending = await readPendingRow(db, requestId);
  expect(pending).toBeTruthy();
  expect(pending?.status).toBe('failed');
  const requestRows = await db.client.query(
    'SELECT request_id FROM catalog.inventory_request WHERE request_id = $1', [requestId],
  );
  expect(requestRows.rowCount).toBe(0);
  const failedDetail = await db.client.query<{ status: string; error_code: string | null }>(
    'SELECT status, error_code FROM catalog.inventory_pending_action WHERE request_id = $1', [requestId],
  );
  expect(failedDetail.rows[0].error_code).toBe('INVENTORY_SCOPE_EMPTY');
  step('db-pending-failed-no-receipt', {
    requestId, pendingStatus: pending?.status, errorCode: failedDetail.rows[0].error_code,
    requestRowCount: requestRows.rowCount,
  });
  await page.screenshot({ path: path.join(process.env.INVENTORY_BROWSER_EVIDENCE_DIR as string, 'settled-unlocked.png') });

  // 6) 恢复参与范围（本轮测试清理），页面重新加载后证明“设置可修改”真落库。
  const restored = await callSettingsRpc({
    enabled: before.enabled,
    intervalMinutes: before.intervalMinutes,
    scopeProvided: true,
    warehouseIds: before.warehouseIds.map((id) => String(id)),
  });
  expect(restored.settings.warehouseCount).toBe(before.warehouseIds.length);
  await gotoStable(page, `${CONFIGURED_BASE}/dashboard/sync`);
  await page.getByTestId('sync-controls').waitFor();
  await expect(page.getByTestId('sync-write-locked')).toHaveCount(0);
  await expect(page.getByTestId('sync-save-settings')).toBeEnabled();

  const targetInterval = before.intervalMinutes >= 1440 ? 1435 : before.intervalMinutes + 5;
  await page.getByLabel('同步频率数值').fill(String(targetInterval));
  await page.getByTestId('sync-save-settings').click();
  await expect(page.getByTestId('sync-control-message')).toContainText(/设置已保存|已更新|频率/);
  await expect.poll(async () => (await readSettings(db)).intervalMinutes).toBe(targetInterval);
  const afterSave = await readSettings(db);
  step('settings-editable-after-settle', {
    targetInterval, dbInterval: afterSave.intervalMinutes, configVersion: afterSave.configVersion,
  });

  // 恢复原频率（页面再次保存成功即完成“可修改”，随后把实例恢复原值）。
  await page.getByLabel('同步频率数值').fill(String(before.intervalMinutes));
  await page.getByTestId('sync-save-settings').click();
  await expect(page.getByTestId('sync-control-message')).toContainText(/设置已保存|已更新|频率/);
  await expect.poll(async () => (await readSettings(db)).intervalMinutes).toBe(before.intervalMinutes);
  step('settings-restored', { intervalMinutes: before.intervalMinutes });

  // 7) 实例恢复原范围/频率/版本（只回放本轮写，不动其它数据）。
  facts.scopeAfter = await readScopeSnapshot();
});
