/**
 * Shared helpers for the v3 isolated fixture behavior suites.
 *
 * Every suite runs against a v3 lane started by
 * `.local/catalog/ui-repair-v3-20261024/fixture/start-lane-v3.mjs`; the live run
 * (run-20261021T100700Z-b3c4d5e6 / 3011) is refused explicitly.
 *
 * Evidence is written under `.local/catalog/ui-repair-v3-20261024/fixture/evidence/<suite>/`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

function findRepoRoot(start) {
  let current = start;
  for (let depth = 0; depth < 12; depth += 1) {
    if (fs.existsSync(path.join(current, 'package.json')) && fs.existsSync(path.join(current, 'scripts/catalog/prepare.mjs'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error('V3_REPO_ROOT_NOT_FOUND');
}
export const REPO_ROOT = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
export const PROTECTED_RUN_ID = 'run-20261021T100700Z-b3c4d5e6';
const RUN_PATTERN = /^run-\d{8}T\d{6}Z-[a-f0-9]{8}$/;

export async function resolveRun(runId) {
  if (!RUN_PATTERN.test(runId ?? '')) throw new Error('V3_RUN_ID_REQUIRED');
  if (runId === PROTECTED_RUN_ID) throw new Error('V3_PROTECTED_RUN_REFUSED');
  const { openRun, readArgs } = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/catalog/prepare.mjs')).href);
  return openRun(readArgs(['--run-id', runId]));
}
export async function ownerClient(run) {
  const { default: pg } = await import(pathToFileURL(path.join(REPO_ROOT, 'node_modules/pg/lib/index.js')).href);
  const instance = run.instance;
  const client = new pg.Client({ host: instance.host, port: instance.port, database: instance.dbName, user: instance.bootstrapUser, password: instance.bootstrapPassword });
  await client.connect();
  return client;
}
export function evidenceDir(suite, runId, label) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(REPO_ROOT, '.local/catalog/ui-repair-v3-20261024/fixture/evidence', suite, `${label}-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
export function createRecorder(suite, runId, label = 'run') {
  const dir = evidenceDir(suite, runId, label);
  const records = [];
  const screenshots = path.join(dir, 'screenshots');
  fs.mkdirSync(screenshots, { recursive: true });
  const file = path.join(dir, 'result.json');
  const write = (summary) => fs.writeFileSync(file, `${JSON.stringify({ suite, runId, startedAt: dir.split(path.sep).pop(), summary, records }, null, 2)}\n`);
  return {
    dir, file, screenshots,
    record(name, value) { records.push({ name, at: new Date().toISOString(), value }); write(null); return value; },
    async shot(page, name) {
      const pathFile = path.join(screenshots, `${name}.png`);
      await page.screenshot({ path: pathFile, fullPage: false }).catch(() => {});
      return pathFile;
    },
    finish(summary) { write(summary); return file; },
  };
}
export function expectAll() {
  const expectations = [];
  return {
    expectations,
    expect(name, condition, detail) { expectations.push({ name, pass: Boolean(condition), detail }); return Boolean(condition); },
    summary() {
      const failed = expectations.filter((entry) => !entry.pass);
      return { pass: failed.length === 0, total: expectations.length, failed: failed.length, failures: failed, expectations };
    },
  };
}
export async function launch() { return chromium.launch({ headless: true }); }

export async function login(page, email = 'admin@catalog.test', password = 'CatalogAdmin123!') {
  await page.goto('/auth/login');
  await page.getByLabel('邮箱', { exact: true }).fill(email);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 90_000 });
}
export async function logout(page) {
  // The v3 shell keeps a dedicated logout button (aria-label "退出登录") in the account area.
  await page.getByRole('button', { name: '退出登录' }).first().click();
  await page.waitForURL(/\/auth\/login/, { timeout: 60_000 });
}
/**
 * Account switch for fixtures where the real logout button is broken (observed 415 in
 * the isolated build, reported separately): clears only the auth cookies, keeping the
 * same tab/sessionStorage so cross-account draft isolation can still be exercised.
 */
export async function switchAccount(context, page, email, password) {
  await context.clearCookies();
  await page.goto('/auth/login');
  await login(page, email, password);
}
export async function openDetailByCode(page, code) {
  await page.goto('/dashboard/catalog');
  await page.getByTestId('catalog-counts').waitFor({ timeout: 120_000 });
  await page.getByLabel(/搜索/).fill(code);
  const row = page.getByTestId(`catalog-row-${code}`);
  await row.waitFor({ timeout: 120_000 });
  await row.getByRole('button', { name: '查看详情' }).click();
  await page.getByTestId('catalog-detail-core-ready').waitFor({ timeout: 120_000 });
}
export async function enterEditor(page) {
  await page.getByRole('button', { name: '编辑资料', exact: true }).click();
  await page.getByTestId('catalog-detail-edit').waitFor({ timeout: 60_000 });
}
export function editorLocators(page) {
  return {
    field: page.locator('select[name="field"]'),
    value: page.locator('input[name="fieldValue"]'),
    evidence: page.locator('input[name="evidenceRef"]'),
    reason: page.locator('input[name="revisionReason"]'),
    submit: page.getByRole('button', { name: '保存非价格修订', exact: true }),
    status: page.locator('section[aria-label="补充资料"] p[role="status"]').first(),
  };
}
export async function fillDraft(page, { field = 'englishName', value, evidence = 'fixture:v3', reason = 'V3 fixture draft' } = {}) {
  const loc = editorLocators(page);
  await loc.field.selectOption(field);
  await loc.value.fill(value);
  await loc.evidence.fill(evidence);
  await loc.reason.fill(reason);
  return loc;
}
export async function storage(page) {
  return page.evaluate(() => Object.fromEntries(Object.keys(window.sessionStorage).map((key) => [key, window.sessionStorage.getItem(key)])));
}
export async function waitFor(fn, { timeout = 60_000, interval = 250, label = 'condition' } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try { const value = await fn(); if (value) return value; } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`V3_WAIT_TIMEOUT:${label}`);
}
export function patchFlightBody(body, transform) {
  return body.split('\n').map((line) => {
    const match = line.match(/^([0-9a-f]+):(\{.*\})$/i);
    if (!match) return line;
    let parsed;
    try { parsed = JSON.parse(match[2]); } catch { return line; }
    const next = transform(parsed);
    return next === undefined ? line : `${match[1]}:${JSON.stringify(next)}`;
  }).join('\n');
}
export function lower(value) { return String(value ?? '').toLowerCase(); }
