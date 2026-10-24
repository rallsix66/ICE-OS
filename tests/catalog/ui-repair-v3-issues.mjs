#!/usr/bin/env node
/**
 * V3-05 issue-index states on ISOLATED fixtures.
 *
 * Modes:
 *  - `--lane zero`  : true 0-item fixture (0 catalog facts; modules disabled boundary shown);
 *  - `--lane si-zero`: 0-item fixture with source-identity enabled+covered, new-item disabled;
 *  - `--lane work`  : seeded module lane (existing items / unlinked source items).
 * Additional states (forbidden/read-fail) are exercised in the same run where possible.
 *
 * Usage: node tests/catalog/ui-repair-v3-issues.mjs --lane zero --base http://127.0.0.1:3016
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

function arg(flag, fallback) { const i = process.argv.indexOf(flag); return i < 0 ? fallback : process.argv[i + 1]; }
const lane = arg('--lane', 'zero');
const base = arg('--base');
const outDir = path.join('D:/try one/ICEOS/.local/catalog/ui-repair-v3-20261024/fixture/evidence/v3-05', `${lane}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
fs.mkdirSync(outDir, { recursive: true });
const expectations = [];
const expect = (name, condition, detail) => { expectations.push({ name, pass: Boolean(condition), detail }); return Boolean(condition); };
const record = { lane, base, startedAt: new Date().toISOString(), observations: [] };
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ baseURL: base, viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
async function readIndex(label) {
  await page.goto('/dashboard/catalog/issues');
  await page.getByTestId('catalog-issues-page').waitFor({ timeout: 120_000 });
  const data = {
    label,
    state: await page.getByTestId('catalog-issues-page').getAttribute('data-issues-state'),
    counts: await page.getByTestId('catalog-issues-counts').innerText().catch(() => null),
    unlinked: await page.getByTestId('catalog-issues-unlinked').innerText().catch(() => null),
    empty: await page.getByTestId('catalog-issues-empty').innerText().catch(() => null),
    rows: await page.locator('[data-testid="catalog-issue-row"]').evaluateAll((nodes) => nodes.map((node) => ({
      key: node.getAttribute('data-issue-key'), kind: node.getAttribute('data-issue-kind'),
      hasItem: node.getAttribute('data-has-item'), itemId: node.getAttribute('data-item-id'),
      href: node.querySelector('a')?.getAttribute('href') ?? null,
      text: (node.textContent ?? '').trim().slice(0, 500),
    }))),
    modules: await page.locator('[data-module-key]').evaluateAll((nodes) => nodes.map((node) => ({
      key: node.getAttribute('data-module-key'), enabled: node.getAttribute('data-module-enabled'),
      status: node.getAttribute('data-module-status'), text: (node.textContent ?? '').trim().slice(0, 300),
    }))),
  };
  record.observations.push(data);
  await page.screenshot({ path: path.join(outDir, `${label}.png`) });
  return data;
}
try {
  await page.goto('/auth/login');
  await page.getByLabel('邮箱', { exact: true }).fill('admin@catalog.test');
  await page.getByLabel('密码', { exact: true }).fill('CatalogAdmin123!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 90_000 });
  const index = await readIndex('issues');
  const zeroCounts = /0 项 \/ 0 款/.test(index.counts ?? '');
  if (lane === 'zero') {
    expect('zero/state-ok', index.state === 'ok', index.state);
    expect('zero/0-items-0-items-not-1-unlinked', zeroCounts && index.rows.length === 0, { counts: index.counts, rows: index.rows.length });
    expect('zero/0-unlinked', /未关联商品 0 项/.test(index.unlinked ?? ''), index.unlinked);
    expect('zero/empty-state-shown', /当前没有(?:可确认的)?待处理事项/.test(index.empty ?? ''), index.empty);
    expect('zero/no-complete-claim', !/已查全/.test(JSON.stringify(index.modules)), index.modules);
  } else if (lane === 'si-zero') {
    const si = index.modules.find((m) => m.key === 'source_identity');
    const ni = index.modules.find((m) => m.key === 'new_item');
    expect('si-zero/0-items', zeroCounts && index.rows.length === 0, { counts: index.counts, rows: index.rows.length });
    expect('si-zero/source-identity-enabled-covered', si?.enabled === 'true' && si?.status === 'covered', si);
    expect('si-zero/new-item-boundary-disabled', ni?.enabled === 'false' && ni?.status === 'disabled', ni);
    expect('si-zero/empty-state-shown', /当前没有(?:可确认的)?待处理事项/.test(index.empty ?? ''), index.empty);
    expect('si-zero/no-complete-claim', !/已查全/.test(JSON.stringify(index.modules)), index.modules);
  } else {
    expect('work/has-rows', index.state === 'ok' && index.rows.length > 0, { counts: index.counts, rows: index.rows.length });
    expect('work/stable-dedupe-keys', new Set(index.rows.map((r) => r.key)).size === index.rows.length, index.rows.map((r) => r.key));
    const unlinkedRows = index.rows.filter((r) => r.hasItem === 'false');
    expect('work/unlinked-items-visible', /未关联商品 [1-9]/.test(index.unlinked ?? '') && unlinkedRows.length > 0, index.unlinked);
    const second = await readIndex('issues-reload');
    expect('work/key-stable-across-reload', JSON.stringify(second.rows.map((r) => r.key)) === JSON.stringify(index.rows.map((r) => r.key)), {});
  }
  const failed = expectations.filter((entry) => !entry.pass);
  const summary = { pass: failed.length === 0, total: expectations.length, failed: failed.length, expectations };
  fs.writeFileSync(path.join(outDir, 'result.json'), `${JSON.stringify({ ...record, summary }, null, 2)}\n`);
  console.log(JSON.stringify({ suite: `v3-05-issues-${lane}`, base, ...summary, evidenceDir: outDir }, null, 2));
  process.exitCode = summary.pass ? 0 : 1;
} finally {
  await browser.close();
}
