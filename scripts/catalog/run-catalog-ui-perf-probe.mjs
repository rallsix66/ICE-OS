#!/usr/bin/env node
/**
 * Authenticated catalog list/detail timing against a live preview base URL.
 * Usage: node scripts/catalog/run-catalog-ui-perf-probe.mjs --base-url http://127.0.0.1:3010
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function readArg(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

const baseUrl = readArg('--base-url') ?? 'http://127.0.0.1:3010';
const email = readArg('--email') ?? 'admin@catalog.test';
const password = readArg('--password') ?? 'CatalogAdmin123!';

async function loginSession() {
  const res = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Origin: baseUrl,
      Referer: `${baseUrl}/`,
    },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json().catch(() => ({}));
  const setCookie = res.headers.getSetCookie?.() ?? [];
  const cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
  return { ok: res.ok && cookie.length > 0, status: res.status, cookie, body };
}

function findDetailPathForIceCode(html, iceCode) {
  const idx = html.indexOf(iceCode);
  if (idx < 0) return null;
  const window = html.slice(Math.max(0, idx - 800), idx + 800);
  const match = window.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return match ? `/dashboard/catalog/${match[0]}` : null;
}

async function timedFetch(label, url, cookie) {
  const started = performance.now();
  const res = await fetch(url, { headers: cookie ? { cookie, Origin: baseUrl } : { Origin: baseUrl }, redirect: 'manual' });
  const headersMs = performance.now() - started;
  const textStarted = performance.now();
  const text = await res.text();
  const bodyMs = performance.now() - started;
  const textOnlyMs = performance.now() - textStarted;
  return {
    label,
    status: res.status,
    headersMs: Math.round(headersMs),
    bodyMs: Math.round(bodyMs),
    textReadMs: Math.round(textOnlyMs),
    bytes: text.length,
    hasCatalogCounts: text.includes('data-testid="catalog-counts"'),
    hasItemCode: text.includes('data-testid="item-code"'),
    wm0072Href: text.match(/href="(\/dashboard\/catalog\/[0-9a-f-]{36})[^"]*"[^>]*data-testid="catalog-row-WM0072"/i)
      ?? text.match(/data-testid="catalog-row-WM0072"[\s\S]*?href="(\/dashboard\/catalog\/[0-9a-f-]{36})/i),
  };
}

async function browserTimings(base, cookie) {
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ baseURL: base });
    if (cookie) await context.addCookies(cookie.split('; ').map((pair) => {
      const [name, ...rest] = pair.split('=');
      return { name, value: rest.join('='), url: base };
    }));
    const page = await context.newPage();
    const listStart = performance.now();
    await page.goto('/dashboard/catalog', { waitUntil: 'domcontentloaded' });
    await page.getByTestId('catalog-counts').waitFor({ state: 'visible', timeout: 60_000 });
    await page.getByLabel(/搜索/).fill('WM0072');
    await page.getByTestId('catalog-row-WM0072').waitFor({ state: 'visible', timeout: 60_000 });
    const listVisibleMs = Math.round(performance.now() - listStart);
    const wmHref = await page.getByTestId('catalog-row-WM0072').getByRole('link', { name: '商品详情' }).getAttribute('href');
    if (!wmHref) throw new Error('WM0072 detail link missing');
    const detailStart = performance.now();
    await page.goto(wmHref, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('item-code').waitFor({ state: 'visible', timeout: 60_000 });
    const detailVisibleMs = Math.round(performance.now() - detailStart);
    await browser.close();
    return { ok: true, listVisibleMs, detailVisibleMs, detailPath: wmHref };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function main() {
  const login = await loginSession();
  if (!login.ok) {
    console.error(JSON.stringify({ error: 'LOGIN_FAILED', status: login.status, body: login.body }, null, 2));
    process.exitCode = 1;
    return;
  }
  const listFirst = await timedFetch('catalog-list-first', `${baseUrl}/dashboard/catalog`, login.cookie);
  const listRepeat = await timedFetch('catalog-list-repeat', `${baseUrl}/dashboard/catalog`, login.cookie);
  if (listFirst.status !== 200 || !listFirst.hasCatalogCounts) {
    console.error(JSON.stringify({ error: 'LIST_NOT_READY', listFirst }, null, 2));
    process.exitCode = 1;
    return;
  }
  const browser = await browserTimings(baseUrl, login.cookie);
  const detailPath = browser.ok && browser.detailPath
    ? browser.detailPath
    : findDetailPathForIceCode(await fetch(`${baseUrl}/dashboard/catalog`, { headers: { cookie: login.cookie, Origin: baseUrl } }).then((r) => r.text()), 'WM0072');
  if (!detailPath) {
    console.error(JSON.stringify({ error: 'DETAIL_UUID_NOT_FOUND', hint: 'WM0072 UUID not found in list HTML or browser navigation', browser }, null, 2));
    process.exitCode = 1;
    return;
  }
  const detailFirst = await timedFetch('catalog-detail-first', `${baseUrl}${detailPath}`, login.cookie);
  const detailRepeat = await timedFetch('catalog-detail-repeat', `${baseUrl}${detailPath}`, login.cookie);
  if (detailFirst.status !== 200 || !detailFirst.hasItemCode) {
    console.error(JSON.stringify({ error: 'DETAIL_NOT_READY', detailFirst, detailPath }, null, 2));
    process.exitCode = 1;
    return;
  }
  const out = {
    recordedAt: new Date().toISOString(),
    baseUrl,
    login: { ok: login.ok, status: login.status },
    detailPath,
    method: {
      fetch: 'headersMs = response object; bodyMs = through full text(); textReadMs = body read only',
      browser: 'domcontentloaded + key testid visible',
      warmProcessNote: 'Measurements are against an already-running next start preview (same process). list-first/detail-first are first authenticated requests in this probe session, not post-restart cold boot.',
    },
    samples: [listFirst, listRepeat, detailFirst, detailRepeat],
    browser,
  };
  const dir = path.join(REPO_ROOT, '.local/catalog/ui-perf-probe');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `perf-${Date.now()}.json`);
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify(out, null, 2));
  console.log(`saved ${file}`);
  if (listRepeat.status !== 200 || detailRepeat.status !== 200) process.exitCode = 1;
  if (!browser.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
