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

async function countProductsAppDb(connectionString) {
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM public.product');
    return rows[0]?.n ?? 0;
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

  const productCountBefore = await countProductsAppDb(envJson.P0_02_APP_DATABASE_URL);

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

  const { chromium } = await import('playwright');

  try {
    await waitForHttp(`${baseUrl}/api/p0-02/session`);

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ baseURL: baseUrl });
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
    results.push({
      name: 'playwright-session-probe',
      pass: sessionProbe.status() === 204,
      status: sessionProbe.status(),
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

    await page.goto('/dashboard/products/overview', { waitUntil: 'domcontentloaded' });
    const searchInput = page.getByPlaceholder(/搜索|SKU|产品/i).first();
    await searchInput.fill('ICE');
    await page.getByRole('button', { name: '搜索' }).click();
    await page.waitForTimeout(800);
    const overviewText = await page.locator('body').innerText();
    results.push({
      name: 'playwright-product-search-interaction',
      pass: /产品|SKU|库存|overview|全球/i.test(overviewText),
    });

    await page.goto('/dashboard/inventory/overseas', { waitUntil: 'networkidle' });
    const overseasText = await page.locator('body').innerText();
    results.push({
      name: 'playwright-overseas-inventory',
      pass: /海外|库存|warehouse|SKU/i.test(overseasText),
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

  const productCountAfter = await countProductsAppDb(envJson.P0_02_APP_DATABASE_URL);
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
      unchanged: productCountBefore === productCountAfter,
    },
    playwright: true,
  };

  fs.writeFileSync(path.join(evidenceDir, 'results.json'), `${JSON.stringify(payload, null, 2)}\n`);

  const failed = results.filter((r) => !r.pass);
  if (!payload.db.unchanged) {
    failed.push({ name: 'db-product-count-stable', pass: false });
  }
  if (apiHits.length < 1) {
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
