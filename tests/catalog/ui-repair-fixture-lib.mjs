/**
 * Shared helpers for the isolated UI-repair fixture acceptance lanes (R4/R6/R7/R9).
 *
 * Every lane runs against a fixture run created by scripts under
 * `.local/catalog/ui-repair-v2-20261023/fixture/`; it never connects to the live run
 * `run-20261021T100700Z-b3c4d5e6` (that run id is explicitly refused here).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

/** Locate the repository root by walking up to package.json (works from tests/ and from .local/). */
function findRepoRoot(start) {
  let current = start;
  for (let depth = 0; depth < 12; depth += 1) {
    if (fs.existsSync(path.join(current, 'package.json')) && fs.existsSync(path.join(current, 'scripts/catalog/prepare.mjs'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error('FIXTURE_REPO_ROOT_NOT_FOUND');
}
export const REPO_ROOT = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
export const PROTECTED_RUN_ID = 'run-20261021T100700Z-b3c4d5e6';
const RUN_PATTERN = /^run-\d{8}T\d{6}Z-[a-f0-9]{8}$/;

export async function loadPrepare() {
  return import(pathToFileURL(path.join(REPO_ROOT, 'scripts/catalog/prepare.mjs')).href);
}

export async function resolveRun(runId) {
  if (!RUN_PATTERN.test(runId ?? '')) throw new Error('FIXTURE_RUN_ID_REQUIRED');
  if (runId === PROTECTED_RUN_ID) throw new Error('FIXTURE_PROTECTED_RUN_REFUSED');
  const { openRun, readArgs } = await loadPrepare();
  const run = openRun(readArgs(['--run-id', runId]));
  return run;
}

export async function ownerClient(run) {
  const { default: pg } = await import(pathToFileURL(path.join(REPO_ROOT, 'node_modules/pg/lib/index.js')).href);
  const instance = run.instance;
  return new pg.Client({
    host: instance.host, port: instance.port, database: instance.dbName,
    user: instance.bootstrapUser, password: instance.bootstrapPassword,
  });
}

export async function appDb(run, identity, sql, values = []) {
  const { default: pg } = await import(pathToFileURL(path.join(REPO_ROOT, 'node_modules/pg/lib/index.js')).href);
  const instance = run.instance;
  const env = run.env;
  const client = new pg.Client({ connectionString: env.P0_02_APP_DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`, [identity]);
    const result = await client.query(sql, values);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

export function evidenceRoot(lane) {
  const dir = path.join(REPO_ROOT, '.local/catalog/ui-repair-v2-20261023/fixture/evidence', lane);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function createRecorder(lane, runId) {
  const dir = evidenceRoot(lane);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const records = [];
  const screenshots = path.join(dir, `screenshots-${stamp}`);
  fs.mkdirSync(screenshots, { recursive: true });
  const record = (name, value) => {
    records.push({ name, at: new Date().toISOString(), value });
    fs.writeFileSync(path.join(dir, `${stamp}-${lane}.json`), JSON.stringify({ lane, runId, startedAt: stamp, records }, null, 2) + '\n');
    return value;
  };
  return {
    dir, screenshotDir: screenshots, stamp,
    record,
    async shot(page, name) {
      const file = path.join(screenshots, `${name}.png`);
      await page.screenshot({ path: file, fullPage: false }).catch(() => {});
      return file;
    },
    finish(summary) {
      const file = path.join(dir, `${stamp}-${lane}.json`);
      fs.writeFileSync(file, JSON.stringify({ lane, runId, startedAt: stamp, finishedAt: new Date().toISOString(), summary, records }, null, 2) + '\n');
      return file;
    },
  };
}

export async function launch() {
  const browser = await chromium.launch({ headless: true });
  return browser;
}

export function baseUrl(port) { return `http://127.0.0.1:${port}`; }

export async function login(page, { email = 'admin@catalog.test', password = 'CatalogAdmin123!', expectCatalog = true } = {}) {
  await page.goto('/auth/login');
  await page.getByLabel('邮箱', { exact: true }).fill(email);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  // Every fixture account lands on /dashboard after a successful sign-in; waiting here also
  // prevents the lane from racing the login POST with the first navigation.
  await page.waitForURL(/\/dashboard/, { timeout: 90_000 });
  void expectCatalog;
  return page;
}

export async function newLoggedInPage(browser, base, credentials) {
  const context = await browser.newContext({ baseURL: base, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await login(page, credentials);
  return { context, page };
}

/** Wait until a callback returns a truthy value; returns that value. */
export async function waitFor(fn, { timeout = 30_000, interval = 250, label = 'condition' } = {}) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeout) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`FIXTURE_WAIT_TIMEOUT:${label}${lastError ? `:${lastError.message}` : ''}`);
}

/** Parse the JSON payload lines of a Next server-action flight response. */
export function patchFlightBody(body, transform) {
  return body.split('\n').map((line) => {
    const match = line.match(/^([0-9a-f]+):(\{.*\})$/i);
    if (!match) return line;
    let parsed;
    try { parsed = JSON.parse(match[2]); } catch { return line; }
    const next = transform(parsed);
    if (next === undefined) return line;
    return `${match[1]}:${JSON.stringify(next)}`;
  }).join('\n');
}

export function safeName(value) { return String(value).replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 80); }

export async function captureActionId(page, { onAction, timeout = 30_000 } = {}) {
  let captured = null;
  const listener = (request) => {
    if (captured) return;
    if (request.method() !== 'POST') return;
    const actionId = request.headers()['next-action'];
    if (!actionId) return;
    const body = request.postData() ?? '';
    if (onAction && !onAction(actionId, body)) return;
    captured = { actionId, body, contentType: request.headers()['content-type'] ?? 'text/plain;charset=UTF-8' };
  };
  page.on('request', listener);
  try {
    const started = Date.now();
    while (!captured && Date.now() - started < timeout) await page.waitForTimeout(100);
  } finally {
    page.off('request', listener);
  }
  if (!captured) throw new Error('FIXTURE_ACTION_CAPTURE_MISS');
  return captured;
}
