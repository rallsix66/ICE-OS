/**
 * P0-02 A3：Playwright 真实浏览器登录、导航、表单交互；采集网络与 PG 只读对照。
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

import pg from 'pg';

import {
  DEFAULT_RUN_ID,
  REPO_ROOT,
  detachedHiddenServerOptions,
  ensureEnvContract,
  loadInstance,
  newEvidenceSessionDir,
  runRoot,
  withHiddenWindowsSpawnOptions,
} from './common.mjs';
import { buildP001ProcessEnv } from './env-whitelist.mjs';
import { guardBeforeMutate } from './instance-guard.mjs';
import { installNetworkGuard } from './network-guard.mjs';
import {
  ensureValidatedIsolatedWorkspace,
  validateBuildCredential,
  validateIsolatedWorkspaceSources,
  writeBuildCredential,
} from './isolated-workspace.mjs';
import { unregisterManagedProcess } from './managed-processes.mjs';
import { guardP001Entry } from './entry-guard.mjs';

const ADMIN_EMAIL = 'admin@p0-02.test';
const ADMIN_PASSWORD = 'AdminPass123!';

function pickPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('no port'));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

function waitForHttp(url, attempts = 120) {
  return new Promise((resolve, reject) => {
    let i = 0;
    const tick = async () => {
      i += 1;
      try {
        const res = await fetch(url);
        if (res.status < 500) {
          resolve(undefined);
          return;
        }
      } catch {
        // retry
      }
      if (i >= attempts) {
        reject(new Error('Next.js 启动超时'));
        return;
      }
      setTimeout(tick, 500);
    };
    tick();
  });
}

function ensurePlaywrightChromium() {
  const probe = spawnSync(
    process.execPath,
    ['-e', "import('playwright').then(m=>m.chromium.launch({headless:true}).then(b=>b.close())).catch(e=>{console.error(e);process.exit(1)})"],
    { cwd: REPO_ROOT, encoding: 'utf8', shell: false },
  );
  if (probe.status === 0) {
    return;
  }
  const install = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, 'node_modules', '@playwright', 'test', 'cli.js'), 'install', 'chromium'],
    { cwd: REPO_ROOT, encoding: 'utf8', stdio: 'inherit' },
  );
  if (install.status !== 0) {
    throw new Error('Playwright chromium 安装失败');
  }
}

const ADMIN_PROFILE_ID = '11111111-1111-4111-8111-111111111101';

async function countProductsWithSessionIdentity(connectionString) {
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [ADMIN_PROFILE_ID]);
      const { rows } = await client.query('SELECT COUNT(*)::int AS n FROM public.product');
      await client.query('ROLLBACK');
      return rows[0]?.n ?? 0;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore
      }
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

async function main() {
  const runId = DEFAULT_RUN_ID;
  guardP001Entry(runId);
  guardBeforeMutate(runId);
  ensurePlaywrightChromium();

  const evidenceDir = newEvidenceSessionDir(runId, 'browser');
  const instance = loadInstance(runId);
  const envFile = path.join(runRoot(runId), 'env.p0-02.json');
  const envJson = ensureEnvContract(instance, envFile);
  const { workspace } = ensureValidatedIsolatedWorkspace(runId, { resync: true });
  const buildEnv = buildP001ProcessEnv(
    {
      NODE_ENV: 'production',
      NEXT_TELEMETRY_DISABLED: '1',
      NODE_PATH: path.join(REPO_ROOT, 'node_modules'),
    },
    envJson,
  );
  const buildResult = spawnSync('npm', ['run', 'build', '--', '--webpack'], {
    cwd: workspace,
    env: buildEnv,
    encoding: 'utf8',
    shell: true,
    ...withHiddenWindowsSpawnOptions({}),
  });
  if (buildResult.status !== 0) {
    throw new Error(`隔离 build 失败:\n${buildResult.stderr}\n${buildResult.stdout}`);
  }
  const afterBuild = validateIsolatedWorkspaceSources(runId);
  if (afterBuild.ok) {
    writeBuildCredential(runId, workspace, afterBuild.sourceSnapshotHash);
  }
  const buildValidation = validateBuildCredential(runId);
  if (!buildValidation.ok) {
    throw new Error(`隔离构建与源码不一致: ${JSON.stringify(buildValidation)}`);
  }
  const nodeModulesLink = path.join(workspace, 'node_modules');
  if (!fs.existsSync(nodeModulesLink)) {
    fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), nodeModulesLink, 'junction');
  }

  const productCountBefore = await countProductsWithSessionIdentity(envJson.P0_02_APP_DATABASE_URL);

  const port = await pickPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  envJson.P0_02_BETTER_AUTH_URL = baseUrl;
  const preload = path.join(REPO_ROOT, 'scripts', 'p0-02', 'loopback-network-preload.cjs');
  const nextBin = path.join(REPO_ROOT, 'node_modules', 'next', 'dist', 'bin', 'next');
  const env = buildP001ProcessEnv(
    {
      NODE_ENV: 'production',
      NODE_OPTIONS: `--require ${JSON.stringify(preload)}`,
      P0_02_ALLOWED_PORTS: [port, instance.port, 5432].join(','),
      P0_02_DISABLE_AUTH_RATE_LIMIT: 'true',
    },
    envJson,
  );

  installNetworkGuard({ runId, allowedPorts: [port, instance.port] });
  const child = spawn(
    process.execPath,
    [nextBin, 'start', '-p', String(port), '-H', '127.0.0.1'],
    detachedHiddenServerOptions({ cwd: workspace, env, stdio: 'ignore' }),
  );
  child.unref();

  const results = [];
  const networkLog = [];
  const blockedExternal = [];

  const { chromium } = await import('playwright');

  try {
    await waitForHttp(`${baseUrl}/api/p0-02/session`);

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ baseURL: baseUrl });
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(url)) {
        route.continue();
        return;
      }
      blockedExternal.push(url);
      route.abort('blockedbyclient');
    });
    const page = await context.newPage();

    page.on('response', async (response) => {
      const url = response.url();
      if (!url.includes('/api/') && !url.includes('/dashboard')) {
        return;
      }
      if (response.request().resourceType() === 'document') {
        return;
      }
      networkLog.push({
        url,
        status: response.status(),
        method: response.request().method(),
      });
    });

    await page.goto('/auth/login', { waitUntil: 'domcontentloaded' });
    await page.fill('#email', ADMIN_EMAIL);
    await page.fill('#password', ADMIN_PASSWORD);
    const signInResponse = page.waitForResponse(
      (r) => r.url().includes('/api/auth/sign-in/email') && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: '登录' }).click();
    const authRes = await signInResponse;
    results.push({
      name: 'playwright-sign-in-api',
      pass: authRes.status() === 200,
      status: authRes.status(),
    });
    const sessionProbe = await page.request.get('/api/p0-02/session');
    networkLog.push({
      url: sessionProbe.url(),
      status: sessionProbe.status(),
      method: 'GET',
    });
    results.push({
      name: 'playwright-session-probe',
      pass: sessionProbe.status() === 204,
      status: sessionProbe.status(),
    });

    const dashboardApi = await page.request.get('/api/p0-02/dashboard');
    networkLog.push({
      url: dashboardApi.url(),
      status: dashboardApi.status(),
      method: 'GET',
    });
    const dashboardJson = await dashboardApi.json().catch(() => null);
    results.push({
      name: 'playwright-dashboard-api',
      pass: dashboardApi.status() === 200 && dashboardJson?.health?.summary != null,
      status: dashboardApi.status(),
    });

    const inventoryApi = await page.request.get('/api/p0-02/inventory');
    networkLog.push({
      url: inventoryApi.url(),
      status: inventoryApi.status(),
      method: 'GET',
    });
    const inventoryJson = await inventoryApi.json().catch(() => null);
    results.push({
      name: 'playwright-inventory-api',
      pass: inventoryApi.status() === 200 && (inventoryJson?.items?.length ?? 0) >= 1,
      status: inventoryApi.status(),
    });
    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    if (!page.url().includes('/dashboard')) {
      throw new Error(`登录后会话无效，当前 URL: ${page.url()}`);
    }

    results.push({
      name: 'playwright-login-dashboard',
      pass: /dashboard/.test(page.url()),
    });

    await page.getByRole('heading', { name: '决策看板' }).waitFor({ timeout: 15_000 });
    results.push({
      name: 'playwright-dashboard-heading',
      pass: true,
    });

    await page.getByRole('link', { name: /库存同步/ }).click();
    await page.waitForURL('**/dashboard/sync**', { timeout: 15_000 });
    const syncText = await page.locator('body').innerText();
    results.push({
      name: 'playwright-sync-page',
      pass: /同步|sync/i.test(syncText),
    });

    const overviewNav = page.waitForURL('**/dashboard/products/overview**', { timeout: 15_000 });
    await page.goto('/dashboard/products/overview', { waitUntil: 'domcontentloaded' });
    await overviewNav;
    const searchInput = page.getByPlaceholder(/搜索 SKU、产品名或变体名/i);
    await searchInput.fill('SKU-TH');
    const searchResponse = page.waitForResponse(
      (r) =>
        r.request().method() === 'GET' &&
        r.url().includes('/dashboard/products/overview') &&
        r.url().includes('search='),
      { timeout: 15_000 },
    );
    await page.getByRole('button', { name: '搜索' }).click();
    const searchRes = await searchResponse;
    const overviewText = await page.locator('body').innerText();
    results.push({
      name: 'playwright-product-search-request',
      pass: searchRes.status() === 200,
      status: searchRes.status(),
    });
    results.push({
      name: 'playwright-product-search-content',
      pass: /SKU-TH|SKU|产品|库存/i.test(overviewText),
    });

    await page.goto('/dashboard/inventory/overseas', { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: /海外库存/i }).waitFor({ timeout: 15_000 });
    const overseasText = await page.locator('body').innerText();
    results.push({
      name: 'playwright-overseas-inventory',
      pass: /海外|库存|SKU/i.test(overseasText) && overseasText.includes('SKU-TH'),
    });

    const favoriteBtn = page.locator('button[title="关注"], button[title="取消关注"]').first();
    if (await favoriteBtn.count()) {
      const favResponse = page.waitForResponse(
        (r) => r.request().method() === 'POST' && /dashboard\/inventory\/overseas/.test(r.url()),
        { timeout: 15_000 },
      );
      await favoriteBtn.click();
      const favRes = await favResponse;
      networkLog.push({
        url: favRes.url(),
        status: favRes.status(),
        method: 'POST',
      });
      results.push({
        name: 'playwright-overseas-favorite-action',
        pass: favRes.status() >= 200 && favRes.status() < 400,
        status: favRes.status(),
      });
    }

    const exportBtn = page.getByRole('button', { name: /导出/i });
    const downloadPromise = page.waitForEvent('download', { timeout: 20_000 }).catch(() => null);
    await exportBtn.click();
    const download = await downloadPromise;
    results.push({
      name: 'playwright-overseas-csv-export',
      pass: download != null && /overseas-inventory.*\.csv/i.test(download.suggestedFilename()),
      filename: download?.suggestedFilename(),
    });

    const blockedProbe = page
      .goto('http://example.com/', { waitUntil: 'commit', timeout: 5_000 })
      .then(() => false)
      .catch(() => true);
    results.push({
      name: 'playwright-browser-egress-block-selftest',
      pass: await blockedProbe,
    });

    const htmlLeak = /SUPABASE_SERVICE_ROLE|createBrowserClient/i.test(overviewText + overseasText);
    results.push({
      name: 'no-supabase-leak-in-rendered-ui',
      pass: !htmlLeak,
    });

    await browser.close();
  } finally {
    try {
      child.kill('SIGTERM');
    } catch {
      // ignore
    }
    if (child.pid) {
      unregisterManagedProcess(runId, child.pid);
    }
  }

  const productCountAfter = await countProductsWithSessionIdentity(envJson.P0_02_APP_DATABASE_URL);
  const apiHits = networkLog.filter(
    (e) => e.status >= 200 && e.status < 400 && e.url.includes('/api/'),
  );

  const payload = {
    results,
    networkSample: networkLog.slice(0, 40),
    apiSuccessCount: apiHits.length,
    db: {
      productCountBefore,
      productCountAfter,
      identity: ADMIN_PROFILE_ID,
      unchanged: productCountBefore === productCountAfter,
      positive: productCountBefore > 0,
    },
    blockedExternalCount: blockedExternal.length,
    playwright: true,
  };

  fs.writeFileSync(path.join(evidenceDir, 'results.json'), `${JSON.stringify(payload, null, 2)}\n`);

  const failed = results.filter((r) => !r.pass);
  if (!payload.db.positive) {
    failed.push({ name: 'db-product-count-with-admin-identity', pass: false });
  }
  if (!results.some((r) => r.name === 'playwright-browser-egress-block-selftest' && r.pass)) {
    failed.push({ name: 'browser-external-block-selftest', pass: false });
  }
  if (apiHits.length < 2) {
    failed.push({ name: 'network-api-evidence', pass: false });
  }

  if (failed.length > 0) {
    console.error(failed);
    process.exit(1);
  }
  console.log(`browser Playwright A3 passed (${results.length}) evidence: ${evidenceDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
