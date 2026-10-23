#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function readArg(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

const baseUrl = readArg('--base-url') ?? 'http://127.0.0.1:3010';
const outDir = readArg('--out-dir') ?? path.join(REPO_ROOT, '.local/catalog/ui-perf-probe/screenshots');

async function main() {
  const { chromium } = await import('playwright');
  mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`${baseUrl}/auth/login`);
  await page.getByLabel('邮箱', { exact: true }).fill('admin@catalog.test');
  await page.getByLabel('密码', { exact: true }).fill('CatalogAdmin123!');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForURL(/\/dashboard\/catalog/);
  for (const [name, width] of [['real-catalog-wide-1440', 1440], ['real-catalog-narrow-635', 635]]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${baseUrl}/dashboard/catalog`, { waitUntil: 'networkidle' });
    await page.getByTestId('catalog-counts').waitFor({ state: 'visible' });
    await page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: true });
  }
  for (const [name, width, iceCode] of [
    ['real-catalog-detail-1440', 1440, 'WM0043'],
    ['real-catalog-detail-narrow-635', 635, 'WM0043'],
  ]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${baseUrl}/dashboard/catalog`, { waitUntil: 'networkidle' });
    await page.getByLabel(/搜索/).fill(iceCode);
    await page.getByTestId(`catalog-row-${iceCode}`).waitFor({ state: 'visible' });
    await page.getByTestId(`catalog-row-${iceCode}`).getByRole('link', { name: '商品详情' }).click();
    await page.getByTestId('catalog-bs-sample-inventory-table').waitFor({ state: 'visible' });
    await page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: true });
  }
  await browser.close();
  console.log(`screenshots saved to ${outDir}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
