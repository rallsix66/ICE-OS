import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { expect, test, type Page, type Request } from '@playwright/test';
import { Client } from 'pg';
import { assertConnectedTarget } from '../../scripts/inventory/test-target-guard.mjs';
import { classifyPostBody, consumeDropped, setDropMode, startProxy, stopProxy } from './repair-v4-proxy';
import { openInstanceDb, readInstanceEnv, readPendingRow, readSettings, type InstanceDb, type InstanceEnv } from './repair-v4-db';

/**
 * v4-final A1 最小真实页面链（只在新隔离实例；不重跑完整矩阵）。
 *
 * 场景（A 独审唯一阻断项）：
 *   页面仍显示非空范围 → 另一会话清空范围 → 页面旧状态点“立即同步”
 *   → 后台确定失败并 settle 为 failed（提交成功），但代理丢弃响应（通知丢失）
 *   → 刷新后本地恢复记录仍在、写锁仍在（overview 只展示 pending，failed 不显示为服务端 pending）
 *   → 核对原请求：服务端返回同 actor/intent 的 failed 终态
 *   → 页面显示“原操作失败，已处理完，可以修正后重新操作”，清除该条本地记录、解除写锁
 *   → 恢复阶段只有 1 个核对 POST，0 个 register/business POST；库存/批次/历史/回执无新增效果。
 *
 * 运行（新实例 web 3036 上游 + 本地代理 3046）：
 *   INVENTORY_BASE_URL=http://127.0.0.1:3046
 *   INVENTORY_UPSTREAM_URL=http://127.0.0.1:3036
 *   INVENTORY_PROXY_PORT=3046
 *   INVENTORY_INSTANCE_DIR=<...run-20261026T180500Z-a1b2c3d4>/instance
 *   INVENTORY_EXPECTED_RUN_ID=run-20261026T180500Z-a1b2c3d4
 *   INVENTORY_BROWSER_EVIDENCE_DIR=<absolute .../browser>
 *   node node_modules/@playwright/test/cli.js test tests/inventory-browser/inventory-terminal-recovery-a1.browser.pw.ts --config playwright.config.inventory.ts
 */

const PROXY_PORT = Number(process.env.INVENTORY_PROXY_PORT ?? 3046);
const UPSTREAM = process.env.INVENTORY_UPSTREAM_URL ?? '';
const CONFIGURED_BASE = process.env.INVENTORY_BASE_URL ?? '';
const EXPECTED_RUN_ID = process.env.INVENTORY_EXPECTED_RUN_ID ?? '';
const LOCAL_STORAGE_KEY = 'inventory.localUnknownRequest.v1';
const PROTECTED_PORTS = new Set([53442, 50499, 59532, 61135, 54164]);

let proxyUrl = '';
let env: InstanceEnv;
let db: InstanceDb;
let originalScope: ScopeSnapshot | null = null;
const facts: Record<string, unknown> = {
  suite: 'inventory-terminal-recovery-a1',
  buildId: process.env.INVENTORY_BUILD_ID ?? null,
  runId: EXPECTED_RUN_ID || null,
  upstream: UPSTREAM || null,
  proxy: null,
  guard: null,
  steps: [] as Array<Record<string, unknown>>,
};

function step(id: string, detail: Record<string, unknown>): void {
  (facts.steps as Array<Record<string, unknown>>).push({ id, at: new Date().toISOString(), ...detail });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  if (!UPSTREAM) throw new Error('INVENTORY_UPSTREAM_URL_REQUIRED（如 http://127.0.0.1:3036）');
  if (!EXPECTED_RUN_ID) throw new Error('INVENTORY_EXPECTED_RUN_ID_REQUIRED');
  env = readInstanceEnv();
  facts.guard = env.guardVerification;
  if (PROTECTED_PORTS.has(env.guard.database.port)) {
    throw new Error(`INVENTORY_PROTECTED_TARGET_DENIED: ${env.guard.database.port}`);
  }
  if (env.runId !== EXPECTED_RUN_ID) throw new Error(`INVENTORY_WRONG_RUN_ID: ${env.runId}`);
  proxyUrl = await startProxy(UPSTREAM, PROXY_PORT);
  facts.proxy = proxyUrl;
  if (CONFIGURED_BASE !== proxyUrl) {
    throw new Error(`INVENTORY_BASE_URL 必须等于代理地址 ${proxyUrl}（当前 ${CONFIGURED_BASE || '未设置'}）`);
  }
  db = await openInstanceDb(env);
  originalScope = await readScopeSnapshot();
  facts.scopeBefore = originalScope;
  facts.countsBefore = await readInventoryCounts();
});

test.afterAll(async () => {
  try {
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
    if (db) facts.countsAfter = await readInventoryCounts();
  } finally {
    await db?.close();
    await stopProxy();
    const evidenceDir = process.env.INVENTORY_BROWSER_EVIDENCE_DIR;
    if (evidenceDir && fs.existsSync(evidenceDir)) {
      fs.writeFileSync(path.join(evidenceDir, 'a1-recovery-report.json'), JSON.stringify(facts, null, 2));
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

async function readInventoryCounts(): Promise<Record<string, number>> {
  const runs = await db.client.query<{ n: string }>('SELECT count(*)::text AS n FROM catalog.inventory_sync_run');
  const batches = await db.client.query<{ n: string }>('SELECT count(*)::text AS n FROM catalog.inventory_batch');
  const rows = await db.client.query<{ n: string }>('SELECT count(*)::text AS n FROM catalog.inventory_batch_row');
  const requests = await db.client.query<{ n: string }>('SELECT count(*)::text AS n FROM catalog.inventory_request');
  return {
    runs: Number(runs.rows[0].n), batches: Number(batches.rows[0].n),
    batchRows: Number(rows.rows[0].n), requests: Number(requests.rows[0].n),
  };
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

function intentHash(): string {
  return crypto.randomBytes(32).toString('hex');
}

interface SettingsRpcResult {
  ok: boolean;
  settings: { scopeEmpty: boolean; warehouseCount: number; intervalMinutes: number; configVersion: number };
}

/** 以 app 角色真实调用设置 RPC（等价另一会话修改范围；不经 owner 写）。 */
async function callSettingsRpc(input: {
  enabled: boolean;
  intervalMinutes: number;
  scopeProvided: boolean;
  warehouseIds: string[];
}): Promise<SettingsRpcResult> {
  const client = new Client({ connectionString: env.appDbUrl, database: env.database });
  await client.connect();
  try {
    await assertConnectedTarget(client, env.guard as never, 'a1-terminal-chain-settings-rpc');
    await client.query('BEGIN');
    await client.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [db.adminProfileId]);
    try {
      const result = await client.query<{ r: SettingsRpcResult }>(
        'SELECT catalog.update_inventory_sync_settings($1,$2,$3,$4,$5,$6::text[]) AS r',
        [crypto.randomUUID(), intentHash(), input.enabled, input.intervalMinutes, input.scopeProvided, input.warehouseIds],
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

test('settlement committed with lost response: reconcile reads failed terminal, unlocks without re-running business', async ({ page }) => {
  await login(page);
  if (!originalScope) throw new Error('INVENTORY_SCOPE_SNAPSHOT_MISSING');
  expect(originalScope.warehouseIds.length).toBeGreaterThan(0);

  await gotoStable(page, `${CONFIGURED_BASE}/dashboard/sync`);
  await page.getByTestId('sync-controls').waitFor();
  await expect(page.getByTestId('sync-manual-button')).toBeEnabled();

  // 1) 保留一份“范围非空”的旧页面状态；另一会话真实清空参与范围。
  const cleared = await callSettingsRpc({
    enabled: false,
    intervalMinutes: originalScope.intervalMinutes,
    scopeProvided: true,
    warehouseIds: [],
  });
  expect(cleared.settings.scopeEmpty).toBe(true);
  step('scope-cleared-by-other-session', { settings: cleared.settings });
  // 该设置 RPC 自身会追加一条业务回执；以清空后的计数作为本链基线（库存/批次不能变）。
  facts.countsAfterScopeClear = await readInventoryCounts();
  await expect(page.getByTestId('sync-manual-button')).toBeEnabled();

  // 2) 旧页面点立即同步：register 正常；业务 POST 到达服务端并确定失败、settle 提交；
  //    代理在收到完整上游响应后丢弃它（通知丢失，DB 已提交 failed）。
  setDropMode('drop-response-business');
  const posts: Array<{ url: string; kind: string; body: string }> = [];
  const onRequest = (request: Request) => {
    if (request.method() !== 'POST') return;
    const body = request.postData() ?? '';
    posts.push({ url: request.url(), kind: classifyPostBody(body), body });
  };
  page.on('request', onRequest);
  await page.getByTestId('sync-manual-button').click().catch(() => null);
  await page.waitForTimeout(2_500);
  page.off('request', onRequest);
  const dropped = consumeDropped();
  expect(dropped.some((entry) => entry.mode === 'drop-response-business' && entry.matched)).toBe(true);
  expect(posts.some((entry) => entry.kind === 'register')).toBe(true);
  step('business-response-withheld-after-settle', { dropped, postKinds: posts.map((entry) => entry.kind) });

  const local = await readLocalRecord(page);
  expect(local).toBeTruthy();
  const requestId = String(local?.requestId ?? '');
  expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
  expect(local?.action).toBe('request_inventory_manual_sync');
  await expect(page.getByTestId('sync-write-locked')).toBeVisible();
  await expect(page.getByTestId('sync-save-settings')).toBeDisabled();
  step('local-unknown-kept', { requestId, registration: local?.registration });

  // 3) 服务端事实：failed 已提交（error_code=INVENTORY_SCOPE_EMPTY），没有业务回执，没有新效果。
  const failed = await readPendingRow(db, requestId);
  expect(failed?.status).toBe('failed');
  const failedDetail = await db.client.query<{ status: string; error_code: string | null }>(
    'SELECT status, error_code FROM catalog.inventory_pending_action WHERE request_id = $1', [requestId],
  );
  expect(failedDetail.rows[0]?.error_code).toBe('INVENTORY_SCOPE_EMPTY');
  const requestRows = await db.client.query('SELECT request_id FROM catalog.inventory_request WHERE request_id = $1', [requestId]);
  expect(requestRows.rowCount).toBe(0);
  const countsAfterFailure = await readInventoryCounts();
  expect(countsAfterFailure).toEqual(facts.countsAfterScopeClear as Record<string, number>);
  step('db-failed-no-receipt-no-effect', {
    requestId, status: failed?.status, errorCode: failedDetail.rows[0]?.error_code,
    requestRowCount: requestRows.rowCount, counts: countsAfterFailure,
  });

  // 4) 刷新：overview 不显示 failed 为服务端 pending，但本地恢复记录仍在并锁写。
  await gotoStable(page, `${CONFIGURED_BASE}/dashboard/sync`);
  await page.getByTestId('sync-pending-recovery').waitFor();
  await expect(page.getByTestId('sync-write-locked')).toBeVisible();
  await expect(page.getByTestId('sync-pending-reconcile')).toBeVisible();
  await expect(page.getByTestId('sync-pending-retry')).toHaveCount(0);
  step('refresh-keeps-local-lock', { local: await readLocalRecord(page) });

  // 5) 核对：服务端返回同 actor/intent 的 failed 终态；页面先显示终态，再清本地记录/解锁/刷新。
  const recoveryPosts: Array<{ kind: string; body: string }> = [];
  const onRecoveryRequest = (request: Request) => {
    if (request.method() !== 'POST') return;
    const body = request.postData() ?? '';
    recoveryPosts.push({ kind: classifyPostBody(body), body });
  };
  page.on('request', onRecoveryRequest);
  await page.getByTestId('sync-pending-reconcile').click();
  await expect(page.getByTestId('sync-pending-reconcile-state')).toHaveAttribute('data-state', 'failed_terminal', { timeout: 15_000 });
  await expect(page.getByTestId('sync-pending-message')).toContainText('原操作失败，已处理完，可以修正后重新操作');
  step('terminal-state-shown', {
    state: await page.getByTestId('sync-pending-reconcile-state').getAttribute('data-state'),
    message: await page.getByTestId('sync-pending-message').innerText(),
  });
  await expect(page.locator('[data-testid="sync-pending-recovery"]')).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByTestId('sync-write-locked')).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByTestId('sync-save-settings')).toBeEnabled({ timeout: 15_000 });
  page.off('request', onRecoveryRequest);
  expect(await readLocalRecord(page)).toBeNull();

  // 恢复阶段只允许“核对”这一个 POST；不得出现 register/business（即原业务没有被再次执行）。
  expect(recoveryPosts.filter((entry) => entry.kind === 'register' || entry.kind === 'business')).toEqual([]);
  expect(recoveryPosts.length).toBe(1);
  const countsAfterRecovery = await readInventoryCounts();
  expect(countsAfterRecovery).toEqual(facts.countsAfterScopeClear as Record<string, number>);
  const stillFailed = await readPendingRow(db, requestId);
  expect(stillFailed?.status).toBe('failed');
  step('terminal-unlocked-no-business-calls', {
    recoveryPostKinds: recoveryPosts.map((entry) => entry.kind),
    counts: countsAfterRecovery,
    pendingStatus: stillFailed?.status,
    localCleared: (await readLocalRecord(page)) === null,
    saveEnabled: await page.getByTestId('sync-save-settings').isEnabled(),
  });

  // 6) 设置真实可修改：勾选一个参与仓库并保存（新请求编号），DB 落库。
  const warehouse = await db.client.query<{ id: string; name: string; external_id: string }>(
    `SELECT w.id, w.external_name AS name, w.external_warehouse_id AS external_id
       FROM catalog.inventory_warehouse w
      WHERE w.id = ANY($1::uuid[]) AND w.status <> 'excluded'
      ORDER BY w.external_warehouse_id LIMIT 1`,
    [originalScope.warehouseIds],
  );
  expect(warehouse.rowCount).toBe(1);
  const target = warehouse.rows[0];
  await page.getByLabel(`参与仓库：${target.name}`).check();
  const targetInterval = originalScope.intervalMinutes >= 1440 ? 1435 : originalScope.intervalMinutes + 5;
  await page.getByLabel('同步频率数值').fill(String(targetInterval));
  await page.getByTestId('sync-save-settings').click();
  await expect(page.getByTestId('sync-control-message')).toContainText(/设置已保存|已更新|参与仓库|频率/);
  await expect.poll(async () => (await readSettings(db)).intervalMinutes).toBe(targetInterval);
  const afterSave = await readSettings(db);
  step('settings-editable-after-terminal', {
    targetInterval, dbInterval: afterSave.intervalMinutes, configVersion: afterSave.configVersion,
    warehouseExternalId: target.external_id,
  });
  await page.screenshot({ path: path.join(process.env.INVENTORY_BROWSER_EVIDENCE_DIR as string, 'terminal-unlocked.png') });

  // 7) 恢复原范围/频率（只回放本轮写；不动库存/历史）。
  const restored = await callSettingsRpc({
    enabled: originalScope.enabled,
    intervalMinutes: originalScope.intervalMinutes,
    scopeProvided: true,
    warehouseIds: originalScope.warehouseIds.map((id) => String(id)),
  });
  expect(restored.settings.warehouseCount).toBe(originalScope.warehouseIds.length);
  facts.scopeAfter = await readScopeSnapshot();
  facts.countsFinal = await readInventoryCounts();
});
