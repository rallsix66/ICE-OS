import { test, expect, type BrowserContext, type Page, type Route } from '@playwright/test';
import { Pool } from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const runRoot = process.env.CATALOG_RUN_ROOT!, evidence = process.env.CATALOG_TEST_EVIDENCE_DIR!;
const instance = JSON.parse(fs.readFileSync(path.join(runRoot, 'instance/catalog-instance.json'), 'utf8'));
const owner = new Pool({ connectionString: `postgres://${instance.bootstrapUser}:${instance.bootstrapPassword}@${instance.host}:${instance.port}/${instance.dbName}` });
const A = 'cccccccc-aaaa-4ccc-8aaa-cccccccccca1', B = 'cccccccc-bbbb-4ccc-8bbb-ccccccccccb2';
const ADMIN_A = '11111111-1111-4111-8111-111111111101', ADMIN_B = '11111111-1111-4111-8111-111111111107';
const READ = '11111111-1111-4111-8111-111111111108', NO_AMOUNT = '11111111-1111-4111-8111-111111111109', NO_EVIDENCE = '11111111-1111-4111-8111-111111111110';
const outside: string[] = [], privateSentinels = ['N1C_PRIVATE_ACCOUNT', 'N1C_PRIVATE_RESOURCE', 'N1C_PRIVATE_AMOUNT', 'N1C_PRIVATE_EVIDENCE', 'N1C_PRIVATE_SOURCE_REASON', 'N1C_PRIVATE_PARSE_REASON', 'N1C_PRIVATE_IMAGE'];
const hash = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex');
const save = (name: string, value: unknown) => fs.writeFileSync(path.join(evidence, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
test.describe.configure({ mode: 'serial' });
let mainItem: string, mainObservation: string, mainCapture: string, original122: string;
let initialPublic: Record<string, unknown>, frozenBaseline: unknown;
let httpIndex = 0;
type ActionResult = { success: boolean; data?: Record<string, unknown> | null; code?: string; outcome?: string; error?: string };
let originalConfirmProbe: { actionId: string; body: string } | null = null;
let sensitiveHistoryProbe: { actionId: string; body: string } | null = null;
let headerIndex = 0;
function varyTokens(headers: Record<string, string>) { return (headers.vary ?? '').split(',').map((token) => token.trim().toLowerCase()); }
function assertCatalogVary(headers: Record<string, string>) {
  expect(varyTokens(headers)).toEqual(expect.arrayContaining(['rsc', 'next-router-state-tree', 'next-router-prefetch', 'next-router-segment-prefetch']));
}
function cacheDirectives(headers: Record<string, string>) {
  const directives = (headers['cache-control'] ?? '').split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((part) => {
    const match = part.trim().match(/^([!#$%&'*+.^_`|~\da-z-]+)(?:\s*=\s*(?:"([^"\\]*(?:\\.[^"\\]*)*)"|([!#$%&'*+.^_`|~\da-z-]+)))?$/i);
    expect(match, `Invalid complete Cache-Control directive: ${part}`).not.toBeNull();
    return { name: match![1].toLowerCase(), value: match![2] ?? match![3] ?? null };
  });
  expect(directives).toContainEqual({ name: 'no-store', value: null });
  for (const directive of directives) {
    expect(['public', 'must-understand']).not.toContain(directive.name);
    if (['s-maxage', 'max-age', 'stale-while-revalidate', 'stale-if-error'].includes(directive.name)) {
      expect(directive.value).toMatch(/^\d+$/); expect(Number(directive.value)).toBe(0);
    }
  }
  return directives;
}
function assertActionHeaders(headers: Record<string, string>) {
  assertCatalogVary(headers); const cache = cacheDirectives(headers);
  expect(cache).toEqual(expect.arrayContaining([{ name: 'no-cache', value: null }, { name: 'must-revalidate', value: null }, { name: 'max-age', value: '0' }]));
}
function assertCatalogPageHeaders(headers: Record<string, string>) {
  assertCatalogVary(headers); expect(cacheDirectives(headers)).toContainEqual({ name: 'private', value: null });
}
function assertPrivateGet(headers: Record<string, string>) {
  expect(cacheDirectives(headers)).toContainEqual({ name: 'private', value: null }); expect(varyTokens(headers)).toContain('cookie');
}
async function catalogPage(page: Page, url: string) {
  const response = await page.goto(url); expect(response).not.toBeNull();
  save(`browser-page-headers-${++headerIndex}.json`, { url, actualUrl: response!.url(), status: response!.status(), headers: response!.headers() });
  expect(response!.status()).toBe(200); assertCatalogPageHeaders(response!.headers());
}

/** Capture a real client Link transition, excluding prefetches and without adding or synthesizing any response header. */
async function catalogRscNavigation(page: Page, url: string, navigate: () => Promise<unknown>) {
  const target = new URL(url, process.env.CATALOG_BASE_URL), index = ++headerIndex;
  const catalogPattern = /\/dashboard\/catalog(?:[/?]|$)/;
  let receive!: (value: { url: string; status: number; headers: Record<string, string>; body: string; requestHeaders: Record<string, string> }) => void;
  let reject!: (error: unknown) => void;
  const resultPromise = new Promise<Parameters<typeof receive>[0]>((resolve, fail) => { receive = resolve; reject = fail; });
  const seen: Record<string, unknown>[] = [];
  const timer = setTimeout(() => {
    save(`browser-rsc-timeout-${index}.json`, { target: url, seen, outcome: 'unconfirmed', boundary: 'No matching real client navigation response; an old body is not accepted as current evidence.' });
    reject(new Error(`RSC_NAVIGATION_HTTP_UNCONFIRMED:${url}`));
  }, 20_000);
  const handler = async (route: Route) => {
    const request = route.request(), requested = new URL(request.url()), requestHeaders = request.headers();
    if (request.method() !== 'GET' || requestHeaders.rsc !== '1') return route.fallback();
    const matches = requested.pathname === target.pathname && [...target.searchParams].every(([key, value]) => requested.searchParams.get(key) === value)
      && requestHeaders['next-router-prefetch'] !== '1';
    seen.push({ pathname: requested.pathname, rsc: requestHeaders.rsc, prefetch: requestHeaders['next-router-prefetch'] ?? null, matches });
    if (!matches) return route.fallback();
    try {
      const response = await route.fetch(), body = await response.text();
      await route.fulfill({ response });
      receive({ url: request.url(), status: response.status(), headers: response.headers(), body,
        requestHeaders: { rsc: requestHeaders.rsc, prefetch: requestHeaders['next-router-prefetch'] ?? '',
          routerStateSha256: hash(requestHeaders['next-router-state-tree'] ?? '') } });
    } catch (error) { reject(error); throw error; }
  };
  await page.route(catalogPattern, handler);
  try {
    const [, response] = await Promise.all([navigate(), resultPromise]);
    save(`browser-rsc-headers-${index}.json`, { target: url, ...response, responseSha256: hash(response.body), boundary: 'Actual GET RSC request caused by a client Link transition; original response forwarded unchanged.' });
    expect(response.status).toBe(200); expect(response.headers['content-type']).toMatch(/^text\/x-component(?:;|$)/i);
    assertCatalogPageHeaders(response.headers); await expect(page).toHaveURL((current) => current.pathname === target.pathname
      && [...target.searchParams].every(([key, value]) => current.searchParams.get(key) === value));
    for (const marker of [...privateSentinels, 'storageHandle', 'browser-main-confirm', 'browser-revision-private-reason']) expect(response.body).not.toContain(marker);
    return response;
  } finally { clearTimeout(timer); await page.unroute(catalogPattern, handler); }
}

/** v3（V3-01）：已建档商品的详情不再常驻候选/附件块；来源与授权证据只在**同一弹窗内的子视图**
 * （`catalog-detail-more` → `catalog-more-evidence` → `catalog-evidence-view`）。
 * 本 helper 打开该商品的统一弹窗与证据子视图，断言候选可见性（服务端按来源范围过滤的语义不变），
 * 然后原位返回并关闭弹窗，避免把“另一页/另一弹窗”当作证据。 */
async function withEvidenceCandidates(page: Page, itemId: string, run: (view: import('@playwright/test').Locator) => Promise<void>) {
  await page.goto(`/dashboard/catalog?detail=${itemId}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('catalog-detail-core-ready')).toBeVisible({ timeout: 60_000 });
  const more = page.getByTestId('catalog-detail-more');
  await expect(more).toBeVisible({ timeout: 30_000 });
  if ((await more.getAttribute('open')) === null) await more.locator('summary').click();
  await page.getByTestId('catalog-more-evidence').click();
  const view = page.getByTestId('catalog-evidence-view');
  await expect(view).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => view.getAttribute('data-evidence-state'), { timeout: 60_000 }).not.toBe('loading');
  try {
    await run(view);
  } finally {
    const back = page.getByTestId('catalog-evidence-back');
    if (await back.count()) await back.click().catch(() => {});
    const close = page.getByTestId('catalog-detail-close');
    if (await close.count()) await close.click().catch(() => {});
    else await page.getByLabel('关闭商品详情').click().catch(() => {});
  }
}
async function assertEvidenceCandidates(page: Page, itemId: string, expected: {
  present: string[]; absent: string[]; emptySource: boolean;
}) {
  await withEvidenceCandidates(page, itemId, async (view) => {
    for (const marker of expected.present) await expect(view).toContainText(marker);
    for (const marker of expected.absent) await expect(view).not.toContainText(marker);
    if (expected.emptySource) await expect(view).toContainText('没有候选');
  });
}

async function guard(context: BrowserContext) {
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) return route.continue();
    outside.push(url.origin); return route.abort();
  });
}
async function login(page: Page, email = 'admin@catalog.test', password = 'CatalogAdmin123!') {
  await page.goto('/auth/login'); await page.getByLabel('邮箱', { exact: true }).fill(email); await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click(); await expect(page).toHaveURL(/\/dashboard/);
}
async function publicRows() {
  const result: Record<string, unknown> = {};
  for (const table of ['product', 'product_variant', 'inventory']) result[table] = (await owner.query(`SELECT * FROM public.${table} ORDER BY id`)).rows;
  return result;
}
async function baselineState() {
  return (await owner.query(`SELECT
    (SELECT count(*)::int FROM catalog.baseline_item_anchor) items,
    (SELECT count(*)::int FROM catalog.source_observation o JOIN catalog.observation_batch b ON b.id=o.batch_id
      JOIN catalog.source_dataset d ON d.id=b.dataset_id JOIN catalog.source_namespace n ON n.id=d.namespace_id WHERE n.system<>'feishu') observations,
    (SELECT count(*)::int FROM catalog.decision_evidence WHERE entry_kind='candidate_snapshot' AND selected_item_id IS NOT NULL) choices,
    (SELECT md5(jsonb_agg(to_jsonb(d) ORDER BY id)::text) FROM catalog.decision_evidence d) decisions_sha,
    (SELECT md5(jsonb_agg(to_jsonb(a) ORDER BY release_id,json_pointer)::text) FROM catalog.baseline_item_anchor a) anchors_sha,
    (SELECT md5(jsonb_agg(to_jsonb(r) ORDER BY r.item_id,r.revision)::text) FROM catalog.item_revision r JOIN catalog.baseline_item_anchor a ON a.item_id=r.item_id) revisions_sha,
    (SELECT md5(jsonb_agg(to_jsonb(f) ORDER BY item_id,financial_revision)::text) FROM catalog_private.item_financial_revision f) financial_sha`)).rows[0];
}
async function itemState(itemId: string) {
  return (await owner.query(`SELECT c.*,r.ice_code_snapshot,r.fields,r.evidence_ref,r.reason FROM catalog.item_current c
    JOIN catalog.item_revision r ON r.item_id=c.item_id AND r.revision=c.revision WHERE c.item_id=$1`, [itemId])).rows[0];
}
function actionResults(body: string): ActionResult[] {
  return body.split('\n').flatMap((line) => {
    const match = line.match(/^[a-z0-9]+:(\{.*\})$/); if (!match) return [];
    try { const result = JSON.parse(match[1]); return typeof result.success === 'boolean' ? [result as ActionResult] : []; } catch { return []; }
  });
}
/** The browser sends a real Next Action. Fetch and forward its actual response before navigation can discard CDP bodies. */
async function actionHttp(page: Page, label: string, predicate: (input: Record<string, unknown>) => boolean, submit: () => Promise<unknown>, options: {
  mutateInput?: (input: Record<string, unknown>) => Record<string, unknown>; loseAck?: boolean; sensitive?: boolean;
} = {}) {
  let receive!: (value: { status: number; body: string; requestBody: string; sentBody: string; actionId: string; injected: boolean; headers: Record<string, string> }) => void;
  let reject!: (error: unknown) => void;
  const responsePromise = new Promise<Parameters<typeof receive>[0]>((resolve, fail) => { receive = resolve; reject = fail; });
  const probeIndex = ++httpIndex, seen: Record<string, unknown>[] = [];
  const captureTimer = setTimeout(() => {
    save(`browser-action-timeout-${probeIndex}-${label}.json`, { label, matchedRequests: matches, seenRequests: seen,
      outcome: 'unconfirmed', notProofOfRollback: true, boundary: 'No matching Action response within the bounded capture window; no success or rollback is inferred.' });
    reject(new Error(`ACTION_HTTP_CAPTURE_UNCONFIRMED:${label}`));
  }, 20_000);
  let matches = 0;
  const handler = async (route: Route) => {
    const request = route.request(), actionId = request.headers()['next-action'], requestBody = request.postData() ?? '';
    let args: unknown; try { args = JSON.parse(requestBody); } catch { return route.fallback(); }
    const input = Array.isArray(args) ? args[0] : null;
    if (request.method() !== 'POST' || !actionId || !input || typeof input !== 'object') return route.fallback();
    const matched = predicate(input);
    seen.push({ method: request.method(), pathname: new URL(request.url()).pathname, actionId, inputKeys: Object.keys(input).sort(),
      requestId: typeof input.requestId === 'string' ? input.requestId : null,
      markerSha256: typeof input.privateReason === 'string' ? hash(input.privateReason) : null, matched });
    if (!matched) return route.fallback();
    try {
      matches++; const sentBody = options.mutateInput ? JSON.stringify([options.mutateInput(input)]) : requestBody;
      const response = await route.fetch(options.mutateInput ? { postData: sentBody } : {}), body = await response.text();
      let forwarded = body, injected = false;
      if (options.loseAck) forwarded = body.split('\n').map((line) => {
        const match = line.match(/^([a-z0-9]+):(\{.*\})$/); if (!match) return line;
        let result; try { result = JSON.parse(match[2]); } catch { return line; }
        if (result.success !== true || !result.data?.itemId) return line;
        injected = true; return `${match[1]}:${JSON.stringify({ success: false, outcome: 'unknown', code: 'REQUEST_OUTCOME_UNKNOWN', error: '提交结果暂未确认，请独立核对原请求。' })}`;
      }).join('\n');
      if (injected) {
        const headers = { ...response.headers() }; delete headers['content-length']; delete headers['content-encoding'];
        await route.fulfill({ response, headers, body: forwarded });
      } else await route.fulfill({ response });
      receive({ status: response.status(), body, requestBody, sentBody, actionId, injected, headers: response.headers() });
    } catch (error) { reject(error); throw error; }
  };
  await page.route('**/dashboard/catalog/**', handler);
  try {
    const [, response] = await Promise.all([submit(), responsePromise]); expect(matches).toBe(1); expect(response.status).toBe(200);
    const results = actionResults(response.body); expect(results).toHaveLength(1);
    for (const sentinel of [...(options.sensitive ? [] : privateSentinels), 'storageHandle', 'storage_handle', 'bootstrapPassword']) expect(response.body).not.toContain(sentinel);
    save(`browser-action-${probeIndex}-${label}.json`, { ...response, responseSha256: hash(response.body), actualServerResult: results[0],
      boundary: options.loseAck ? 'Actual committed Action response; one synthetic lost front-end acknowledgment. Real COMMIT-ACK fault is separately tested in PostgreSQL.' : 'Actual server response, unmodified forwarding; no synthetic success.' });
    assertActionHeaders(response.headers);
    return { ...response, result: results[0] };
  } finally { clearTimeout(captureTimer); await page.unroute('**/dashboard/catalog/**', handler); }
}
async function intake(page: Page, scope = A) { await catalogPage(page, `/dashboard/catalog/intake?scope=${scope}`); await expect(page.getByLabel('来源范围', { exact: true })).toHaveValue(scope); }
async function selectIntakeScope(page: Page, scope: string) {
  const selector = page.getByLabel('来源范围', { exact: true });
  await expect(selector.locator(`option[value="${scope}"]`)).toHaveCount(1);
  if (await selector.inputValue() !== scope) await catalogRscNavigation(page, `/dashboard/catalog/intake?scope=${scope}`, () => selector.selectOption(scope));
  await expect(selector).toHaveValue(scope);
}
async function importCapture(page: Page, id: string, scope = A) {
  await intake(page, scope); await page.getByLabel('取样商品资料', { exact: true }).selectOption(id);
  await page.getByRole('button', { name: '准备商品观测预览', exact: true }).click(); await expect(page.getByTestId('product-capture-preview')).toContainText('已固定观测预览');
  await expect(page.getByTestId('product-capture-preview')).toContainText(/\d+ 条观测/);
  await expect(page.getByTestId('product-capture-preview')).not.toContainText(id);
  const response = await actionHttp(page, `import-${id}`, (input) => input.approvedFixtureId === id && typeof input.requestId === 'string',
    () => page.getByRole('button', { name: '导入商品观测', exact: true }).click());
  expect(response.result.success).toBe(true); await expect(page.getByTestId('new-item-status')).toContainText('本次操作已保存');
  const rows = (await owner.query(`SELECT o.*,c.id capture_id,c.approved_fixture_id FROM catalog.product_observation o JOIN catalog.product_capture c ON c.id=o.capture_id
    WHERE c.approved_fixture_id=$1 ORDER BY o.record_pointer`, [id])).rows;
  return { response, rows, captureId: response.result.data!.captureId as string };
}
const editor = (page: Page, observationId: string) => page.getByTestId(`product-observation-${observationId}`);
async function classify(page: Page, observationId: string, label: string) {
  const section = editor(page, observationId); await section.getByLabel('分类', { exact: true }).selectOption('new_item');
  await section.getByLabel('分类理由', { exact: true }).fill(label);
  const response = await actionHttp(page, label, (input) => input.privateReason === label, () => section.getByRole('button', { name: '保存分类', exact: true }).click());
  expect(response.result.success).toBe(true);
  // F11/F12：面板改为中文业务摘要，技术编码移入「技术说明（维护）」块（分类编码 / 复核状态），
  // 因此不再有旧的「new_item / proposed」拼接文本；这里断言同一事实的两个中文标签。
  await expect(section).toContainText('分类编码 new_item');
  await expect(section).toContainText('复核状态 proposed');
  return response;
}
async function createItem(page: Page, observationId: string, label: string, loseAck = false) {
  const section = editor(page, observationId); await section.getByLabel('新品确认理由', { exact: true }).fill(label);
  await section.getByRole('button', { name: '准备新品采用预览', exact: true }).click(); await expect(section.getByTestId('new-item-adoption-preview')).toBeVisible();
  const response = await actionHttp(page, label, (input) => input.privateReason === label, () => section.getByRole('button', { name: '确认新增商品', exact: true }).click(), { loseAck });
  expect(response.result.success).toBe(true); expect(response.result.data!.created).toBe(true);
  if (!loseAck) await expect(page.getByTestId('new-item-result')).toHaveAttribute('data-item-id', String(response.result.data!.itemId));
  return response;
}
async function assertBaselineProtected() { expect(await publicRows()).toEqual(initialPublic); expect(await baselineState()).toEqual(frozenBaseline); expect(outside).toEqual([]); }
async function grant(scopeId: string, profileId: string, capabilities: { read: boolean; manage?: boolean; publish?: boolean; evidence?: boolean; amount?: boolean }) {
  await owner.query(`INSERT INTO catalog.source_scope_grant(scope_id,profile_id,can_read,can_manage,can_evidence,can_amount,enabled,grant_revision,authorization_ref,can_publish_catalog)
    VALUES($1,$2,$3,$4,$5,$6,true,1,'isolated-browser-explicit-grant',$7) ON CONFLICT(scope_id,profile_id) DO UPDATE SET can_read=excluded.can_read,
    can_manage=excluded.can_manage,can_evidence=excluded.can_evidence,can_amount=excluded.can_amount,can_publish_catalog=excluded.can_publish_catalog,
    enabled=true,grant_revision=catalog.source_scope_grant.grant_revision+1`, [scopeId, profileId, capabilities.read, capabilities.manage ?? false, capabilities.evidence ?? false, capabilities.amount ?? false, capabilities.publish ?? false]);
}
async function cBusinessFingerprint() {
  const tables = ['catalog.product_capture', 'catalog_private.product_capture_handle', 'catalog.product_observation',
    'catalog.intake_classification_revision', 'catalog.new_item_decision', 'catalog.item_observation_origin', 'catalog.new_item_source_claim', 'catalog.new_item_request'];
  const result: Record<string, { count: number; digest: string | null }> = {};
  for (const table of tables) result[table] = (await owner.query(`SELECT count(*)::int count,md5(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text) digest FROM ${table} t`)).rows[0];
  return result;
}
async function assertDirectWriteDenied(actorContext: BrowserContext, actorPage: Page, kind: string) {
  expect(originalConfirmProbe).not.toBeNull(); const probe = originalConfirmProbe!, before = await cBusinessFingerprint();
  const response = await actorContext.request.post(`/dashboard/catalog/intake?scope=${A}`, { data: probe.body, maxRedirects: 0,
    headers: { 'Next-Action': probe.actionId, 'Content-Type': 'text/plain;charset=UTF-8', Origin: new URL(process.env.CATALOG_BASE_URL!).origin } });
  const body = await response.text(), results = actionResults(body), after = await cBusinessFingerprint();
  save(`browser-direct-write-${kind}.json`, { kind, request: probe, status: response.status(), responseBody: body, responseSha256: hash(body), headers: response.headers(), before, after,
    boundary: 'Actual HTTP replay of a real Next Action under a different/currently denied session; no disabled-control assumption.' });
  if (response.status() === 200) {
    assertActionHeaders(response.headers());
    expect(results).toHaveLength(1); expect(results[0].success).toBe(false); expect(results[0]).not.toHaveProperty('data');
    expect(results[0].code).toBe(kind === 'noAmount' || kind === 'noEvidence' ? 'REQUEST_CONFLICT' : 'NEW_ITEM_OPERATION_DENIED');
  } else expect([303, 307, 401, 403]).toContain(response.status());
  for (const forbidden of [...privateSentinels, 'storageHandle', 'storage_handle', 'bootstrapPassword']) expect(body).not.toContain(forbidden);
  expect(body).not.toContain('"success":true'); expect(after).toEqual(before); expect(actorPage.context()).toBe(actorContext);
}
async function assertSensitiveHistoryDenied(actorContext: BrowserContext, label: string) {
  expect(sensitiveHistoryProbe).not.toBeNull(); const probe = sensitiveHistoryProbe!, before = await cBusinessFingerprint();
  const response = await actorContext.request.post(`/dashboard/catalog/intake?scope=${A}`, { data: probe.body, maxRedirects: 0,
    headers: { 'Next-Action': probe.actionId, 'Content-Type': 'text/plain;charset=UTF-8', Origin: new URL(process.env.CATALOG_BASE_URL!).origin } });
  const body = await response.text(), results = actionResults(body), after = await cBusinessFingerprint();
  save(`browser-sensitive-history-denied-${label}.json`, { label, request: probe, status: response.status(), headers: response.headers(), actualResponse: body, before, after });
  if (response.status() === 200) { assertActionHeaders(response.headers()); expect(results).toHaveLength(1); expect(results[0].success).toBe(false); expect(results[0]).not.toHaveProperty('data'); }
  else expect([303, 307, 401, 403]).toContain(response.status());
  for (const forbidden of [...privateSentinels, 'storageHandle', 'browser-main-confirm', 'browser-revision-private-reason']) expect(body).not.toContain(forbidden);
  expect(after).toEqual(before);
}
test.afterAll(async () => { await owner.end(); });

test('C127真实建档与未知回执核对；缺码、补码修订、历史和两种重导保持原UUID', async ({ page, context }) => {
  await guard(context); initialPublic = await publicRows(); await login(page);
  const sourceConfig = path.join(process.env.CATALOG_SOURCE_ROOT ?? process.cwd(), 'next.config.ts'), workspaceConfig = path.join(process.cwd(), 'next.config.ts');
  save('browser-header-config-build.json', { sourceConfig, workspaceConfig, sourceConfigSha256: hash(fs.readFileSync(sourceConfig)),
    workspaceConfigSha256: hash(fs.readFileSync(workspaceConfig)), buildId: fs.readFileSync(path.join(process.cwd(), '.next/BUILD_ID'), 'utf8').trim(),
    approval: '.local/catalog/new-item-framework-cache-review-20261021T011540Z-64be7a56/decision.md',
    boundary: 'Approved framework no-store amendment; literal Cookie is not asserted for Page/RSC/Action. Independent raw/export GET retains Cookie.' });
  expect(hash(fs.readFileSync(sourceConfig))).toBe(hash(fs.readFileSync(workspaceConfig)));
  // 维护动作（准备/发布固定基线、承接冻结观测）与 manifest-counts 在维护页，不在列表页。
  await catalogPage(page, '/dashboard/catalog/admin');
  await page.getByRole('button', { name: '准备固定基线预览', exact: true }).click(); await expect(page.getByTestId('manifest-counts')).toContainText('完整产物 147 份');
  await page.getByRole('button', { name: '发布固定基线', exact: true }).click(); await expect(page.getByRole('status')).toContainText('已原子承接');
  await page.getByRole('button', { name: '承接冻结飞书观测', exact: true }).click(); await expect(page.getByRole('status')).toContainText('159格');
  frozenBaseline = await baselineState(); expect(frozenBaseline).toMatchObject({ items: 126, choices: 548 });
  original122 = (await owner.query('SELECT item_id FROM catalog.baseline_item_anchor WHERE row_position=122')).rows[0].item_id;
  await page.goto(`/dashboard/catalog/${original122}`); await expect(page.getByTestId('catalog-material-ice-code')).toContainText('待补货号');
  const imported = await importCapture(page, 'a-main'); mainObservation = imported.rows[0].id; mainCapture = imported.captureId;
  await classify(page, mainObservation, 'browser-main-classification');
  const created = await createItem(page, mainObservation, 'browser-main-confirm', true); mainItem = String(created.result.data!.itemId);
  originalConfirmProbe = { actionId: created.actionId, body: created.sentBody };
  expect(mainItem).not.toBe(original122); expect(created.injected).toBe(true);
  await expect(page.getByTestId('new-item-status')).toContainText('暂未确认'); const recovery = page.getByTestId('new-item-request-recovery');
  await expect(recovery).toBeVisible(); const recoverButton = recovery.getByRole('button', { name: '独立核对原请求', exact: true });
  expect(await recoverButton.evaluate((button) => button.closest('form') === null)).toBe(true);
  for (const field of await page.locator('form input,form select').all()) await expect(field).toBeDisabled();
  const originalInput = JSON.parse(created.requestBody)[0], beforeRecover = await itemState(mainItem);
  const recovered = await actionHttp(page, 'recover-main-confirm', (input) => input.action === 'confirm_new_item', () => recoverButton.click());
  expect(recovered.result.success).toBe(true); expect(recovered.result.data!.itemId).toBe(mainItem); await expect(recovery).toHaveCount(0);
  expect(await itemState(mainItem)).toEqual(beforeRecover);
  expect((await owner.query('SELECT count(*)::int n FROM catalog.new_item_request WHERE request_id=$1', [originalInput.requestId])).rows[0].n).toBe(1);
  expect((await owner.query('SELECT count(*)::int n FROM catalog.audit_event WHERE request_id=$1', [originalInput.requestId])).rows[0].n).toBe(0);
  expect((await owner.query('SELECT count(*)::int n FROM catalog.catalog_item')).rows[0].n).toBe(127);
  await catalogRscNavigation(page, '/dashboard/catalog', () => page.getByRole('link', { name: '返回商品资料', exact: true }).click());
  // U7：侧栏旧入口已删除，URL 仍可达（catalogPage 仍校验 200 与私有缓存头）。
  await catalogPage(page, '/dashboard/catalog/intake');
  await selectIntakeScope(page, A);
  // F11/F12：链接名称现在为「已有商品 <uuid>（<来源种类>）」，用 UUID 正则匹配同一意图。
  await catalogRscNavigation(page, `/dashboard/catalog/${mainItem}`, () => editor(page, mainObservation).getByRole('link', { name: new RegExp(`已有商品 ${mainItem}`) }).click());
  await expect(page).toHaveURL(new RegExp(mainItem));
  await expect(page.getByTestId('catalog-detail-core-ready')).toBeVisible({ timeout: 60_000 });
  // 日常详情不再展示 item-uuid（技术证据退到授权维护页），身份改由 URL 与商品资料货号行核对。
  await expect(page.getByTestId('catalog-material-ice-code')).toContainText('待补货号');
  // v3：UUID 只在弹窗内“来源与证据”子视图出现（不再跳维护页）。
  await page.goto(`/dashboard/catalog?detail=${mainItem}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('catalog-detail-core-ready')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('catalog-detail-more').locator('summary').click();
  await page.getByTestId('catalog-more-evidence').click();
  await expect(page.getByTestId('catalog-evidence-view')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('catalog-evidence-subject')).toContainText('待补货号', { timeout: 60_000 });
  await expect(page.getByTestId('catalog-evidence-subject')).not.toContainText(mainItem);
  await page.getByTestId('catalog-evidence-back').click();
  await page.getByTestId('catalog-detail-close').click();
  await catalogPage(page, `/dashboard/catalog/${mainItem}`);
  await expect(page.getByTestId('catalog-detail-core-ready')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('catalog-material-ice-code')).toContainText('待补货号');
  await expect(page.getByText('新品，待补货号', { exact: true })).toBeVisible(); expect((await itemState(mainItem)).financial_revision).toBeNull();
  // F13：补充资料在「编辑资料」编辑态里；直链页默认收起，必须真实点击入口（不能用注入显示）。
  await page.getByRole('button', { name: '编辑资料', exact: true }).click();
  await expect(page.getByTestId('catalog-detail-edit')).toBeVisible({ timeout: 30_000 });
  await page.getByLabel('首次ICE货号', { exact: true }).fill('N1C-BROWSER-127'); await page.getByLabel('补码依据').fill('browser-initial-code-private-reason');
  const coded = await actionHttp(page, 'initial-code', (input) => input.reason === 'browser-initial-code-private-reason', () => page.getByRole('button', { name: '保存首次货号', exact: true }).click());
  expect(coded.result.success).toBe(true); await expect(page.getByTestId('catalog-material-ice-code')).toContainText('N1C-BROWSER-127');
  await page.getByLabel('修订字段', { exact: true }).selectOption('factory'); await page.getByLabel('明确采用值（留空表示明确空串）').fill('虚构工厂修订');
  await page.getByLabel('证据引用', { exact: true }).fill('N1C_PRIVATE_BROWSER_FIELD_REFERENCE'); await page.getByLabel('修订理由', { exact: true }).fill('browser-revision-private-reason');
  const revised = await actionHttp(page, 'nonprice-revision', (input) => input.reason === 'browser-revision-private-reason', () => page.getByRole('button', { name: '保存非价格修订', exact: true }).click());
  expect(revised.result.success).toBe(true); await expect(page.getByTestId('catalog-detail-version')).toHaveText('3'); await expect(page.getByTestId('catalog-material-details')).toContainText('虚构工厂修订');
  const after = await itemState(mainItem); expect(after.financial_revision).toBeNull(); expect(JSON.stringify(after.fields)).not.toContain('N1C_PRIVATE_BROWSER_FIELD_REFERENCE');
  await page.goto(`/dashboard/catalog/${mainItem}?revision=1`); await expect(page.getByTestId('catalog-material-ice-code')).toContainText('待补货号');
  await expect(page.getByTestId('catalog-material-details')).not.toContainText('虚构工厂修订');
  await importCapture(page, 'a-main'); expect(await itemState(mainItem)).toEqual(after);
  await page.goto('/dashboard/catalog/admin'); await page.getByRole('button', { name: '准备固定基线预览', exact: true }).click();
  await page.getByRole('button', { name: '发布固定基线', exact: true }).click(); await expect(page.getByRole('status')).toContainText('已原子承接');
  expect(await itemState(mainItem)).toEqual(after); expect((await owner.query('SELECT count(*)::int n FROM catalog.product_observation WHERE id=$1', [mainObservation])).rows[0].n).toBe(1);
  await assertBaselineProtected(); save('browser-main-final.json', { original122, mainItem, mainObservation, mainCapture, originalInput, beforeRecover, after, baselineProtected: true, publicUnchanged: true });
});

test('C10可靠来源新批无额外proof，实际A链和永久slot固定原商品，只追加origin与私有审计', async ({ page, context }) => {
  await guard(context); await login(page);
  const first = await importCapture(page, 'a-r1-first'), firstId = first.rows[0].id; await classify(page, firstId, 'browser-source-slot-classify-first');
  const created = await createItem(page, firstId, 'browser-source-slot-create'), itemId = String(created.result.data!.itemId), before = await itemState(itemId);
  const repeat = await importCapture(page, 'a-r1-repeat'), repeatedId = repeat.rows[0].id; await classify(page, repeatedId, 'browser-source-slot-classify-repeat');
  const proofFacts = (await owner.query(`SELECT c.approved_fixture_id,c.association_proofs,o.identity_observation_id,l.link_revision,l.status,r.id record_id,r.state
    FROM catalog.product_capture c JOIN catalog.product_observation o ON o.capture_id=c.id JOIN catalog.identity_observation io ON io.id=o.identity_observation_id
    JOIN LATERAL(SELECT * FROM catalog.observation_record_link WHERE observation_key='identity:'||io.id::text ORDER BY link_revision DESC LIMIT 1) l ON true
    JOIN catalog.source_record r ON r.id=l.record_id WHERE c.approved_fixture_id IN('a-r1-first','a-r1-repeat') ORDER BY c.approved_fixture_id`)).rows;
  expect(proofFacts).toHaveLength(2); for (const fact of proofFacts) { expect(fact.association_proofs).toEqual([]); expect(fact.status).toBe('linked'); expect(fact.state).toBe('active'); }
  expect(proofFacts[0].record_id).toBe(proofFacts[1].record_id);
  const section = editor(page, repeatedId); await section.getByLabel('复用理由', { exact: true }).fill('browser-source-slot-reuse');
  await section.getByRole('button', { name: '准备同源复用', exact: true }).click(); await expect(section.getByTestId('source-slot-preview')).toContainText('原商品已由服务器固定');
  const response = await actionHttp(page, 'source-slot-reuse', (input) => input.privateReason === 'browser-source-slot-reuse', () => section.getByRole('button', { name: '确认沿用原商品', exact: true }).click());
  expect(response.result).toMatchObject({ success: true, data: { itemId, created: false, associated: true, relationshipUsable: false } });
  const request = JSON.parse(response.sentBody)[0]; expect(request.basis).toEqual({ kind: 'source_slot' }); expect(await itemState(itemId)).toEqual(before);
  const audit = (await owner.query('SELECT * FROM catalog.new_item_request WHERE request_id=$1', [request.requestId])).rows[0];
  expect(audit.publication_token).toBeNull(); expect(audit.private_field_evidence.source_slot_basis).toBeTruthy(); expect(audit.private_field_evidence.associationProof ?? null).toBeNull();
  const origins = (await owner.query('SELECT * FROM catalog.item_observation_origin WHERE item_id=$1 ORDER BY recorded_at,id', [itemId])).rows;
  expect(origins).toHaveLength(2); expect(origins[1].association_basis_kind).toBe('source_slot'); expect(origins[1].source_record_id).toBe(proofFacts[0].record_id);
  const slots = (await owner.query('SELECT * FROM catalog.new_item_source_claim WHERE source_record_id=$1', [proofFacts[0].record_id])).rows; expect(slots).toHaveLength(1); expect(slots[0].item_id).toBe(itemId);
  await expect(editor(page, repeatedId)).toContainText(itemId); await assertBaselineProtected(); save('browser-source-slot-final.json', { itemId, before, after: await itemState(itemId), proofFacts, audit, origins, slots });
});

test('C08无ID双端proof错配拒绝后正确关联；C09真正同来源证据沿原UUID后补身份', async ({ page, context }) => {
  await guard(context); await login(page);
  const old = await importCapture(page, 'a-proof-old'), oldId = old.rows[0].id; await classify(page, oldId, 'browser-proof-old-classify');
  const created = await createItem(page, oldId, 'browser-proof-old-create'), itemId = String(created.result.data!.itemId), before = await itemState(itemId);
  const newer = await importCapture(page, 'a-proof-new'), newId = newer.rows[0].id; await classify(page, newId, 'browser-proof-new-classify');
  const section = editor(page, newId); await section.getByLabel('关联理由', { exact: true }).fill('browser-proof-associate');
  await section.getByRole('button', { name: '准备证据关联', exact: true }).click(); await expect(section.getByRole('button', { name: '确认关联已有商品', exact: true })).toBeVisible();
  const countBefore = (await owner.query('SELECT count(*)::int n FROM catalog.item_observation_origin WHERE item_id=$1', [itemId])).rows[0].n;
  const wrongOrigin = (await owner.query(`SELECT id FROM catalog.item_observation_origin WHERE item_id=$1 AND scope_id=$2 AND origin_kind='created'`, [mainItem, A])).rows[0].id;
  const wrong = await actionHttp(page, 'wrong-proof', (input) => input.privateReason === 'browser-proof-associate', () => section.getByRole('button', { name: '确认关联已有商品', exact: true }).click(), {
    mutateInput: (input) => { const basis = input.basis as Record<string, unknown>; return { ...input, basis: { ...basis, basisAnchorOrOrigin: { kind: 'origin', originId: wrongOrigin } } }; },
  });
  const sentWrong = JSON.parse(wrong.sentBody)[0], preparedCorrect = JSON.parse(wrong.requestBody)[0];
  expect(sentWrong.basis.associationProofRef).toEqual(preparedCorrect.basis.associationProofRef);
  expect(sentWrong.basis.targetItemId).toBe(itemId); expect(sentWrong.basis.basisAnchorOrOrigin.originId).toBe(wrongOrigin);
  expect(wrong.result.success).toBe(false); expect(wrong.result.code).toBe('ASSOCIATION_PROOF_INVALID'); expect(await itemState(itemId)).toEqual(before);
  expect((await owner.query('SELECT count(*)::int n FROM catalog.item_observation_origin WHERE item_id=$1', [itemId])).rows[0].n).toBe(countBefore);
  await expect(page.getByTestId('new-item-status')).toContainText('证据与本次两端不一致');
  // React resets uncontrolled form inputs after a resolved Action, including a known business rejection.
  await section.getByLabel('关联理由', { exact: true }).fill('browser-proof-associate');
  const correct = await actionHttp(page, 'right-proof', (input) => input.privateReason === 'browser-proof-associate', () => section.getByRole('button', { name: '确认关联已有商品', exact: true }).click());
  expect(correct.result).toMatchObject({ success: true, data: { itemId, created: false, associated: true, relationshipUsable: false } });
  expect(await itemState(itemId)).toEqual(before); await expect(editor(page, newId)).toContainText(itemId);
  const pending = await importCapture(page, 'a-attach-old'), pendingId = pending.rows[0].id; await classify(page, pendingId, 'browser-attach-old-classify');
  const pendingCreate = await createItem(page, pendingId, 'browser-attach-old-create'), pendingItem = String(pendingCreate.result.data!.itemId), pendingBefore = await itemState(pendingItem);
  await importCapture(page, 'a-attach-support'); await importCapture(page, 'a-attach-proof');
  const attachEditor = editor(page, pendingId); await attachEditor.getByLabel('后补依据', { exact: true }).fill('browser-attach-source');
  await attachEditor.getByRole('button', { name: '准备后补来源身份', exact: true }).click(); await expect(attachEditor.getByRole('button', { name: '确认后补来源身份', exact: true })).toBeVisible();
  const attached = await actionHttp(page, 'attach-source', (input) => input.privateReason === 'browser-attach-source', () => attachEditor.getByRole('button', { name: '确认后补来源身份', exact: true }).click());
  expect(attached.result.success).toBe(true); expect(attached.result.data!.itemId).toBe(pendingItem); expect(attached.result.data!.relationshipUsable).toBe(false); expect(await itemState(pendingItem)).toEqual(pendingBefore);
  const facts = (await owner.query('SELECT * FROM catalog.item_observation_origin WHERE item_id=$1 ORDER BY recorded_at,id', [pendingItem])).rows;
  expect(facts).toHaveLength(2); expect(facts[1].source_record_id).toMatch(/^[a-f0-9-]{36}$/); expect(facts[1].association_proof_key).toBeTruthy();
  await assertBaselineProtected(); save('browser-proof-and-attach-final.json', { itemId, pendingItem, wrongRejected: true, correct: correct.result, attached: attached.result, facts, noRevisionPublished: true });
});

test('C06两个系统独立候选；共享采用字段、scoped raw/history/HTTP权限与撤权不泄漏', async ({ page, context, browser }) => {
  await guard(context); await login(page); await grant(B, ADMIN_A, { read: true });
  await importCapture(page, 'a-bs-candidate'); await page.goto(`/dashboard/catalog/${mainItem}`);
  await expect(page.getByTestId('catalog-detail-core-ready')).toBeVisible({ timeout: 60_000 });
  // (a)：普通商品详情不常驻候选/附件块；候选审计只在授权维护页。
  await expect(page.getByTestId('catalog-detail-attachments')).toHaveCount(0);
  await assertEvidenceCandidates(page, mainItem, { present: ['N1C-BS-CANDIDATE'], absent: ['N1C-JST-CANDIDATE'], emptySource: true });
  const before = await itemState(mainItem); const contextB = await browser.newContext(); await guard(contextB); const pageB = await contextB.newPage(); await login(pageB, 'scope-b@catalog.test', 'CatalogScopeB123!');
  await importCapture(pageB, 'b-jst-candidate', B); await pageB.goto(`/dashboard/catalog/${mainItem}`);
  await expect(pageB.getByTestId('catalog-detail-core-ready')).toBeVisible({ timeout: 60_000 });
  // 无权写入的提示在「商品资料」分区（默认分区）。
  await expect(pageB.getByTestId('catalog-write-denied')).toBeVisible();
  await assertEvidenceCandidates(pageB, mainItem, { present: ['N1C-JST-CANDIDATE'], absent: ['N1C-BS-CANDIDATE'], emptySource: true });
  // A 侧重新打开维护页后也能看到 B 刚导入的 JST 候选（仍是作用域内可见，不是缓存旧值）。
  await assertEvidenceCandidates(page, mainItem, { present: ['N1C-JST-CANDIDATE'], absent: [], emptySource: false });
  // A second real product and distinct candidate pair exercise the reverse arrival order without deleting old observations.
  await grant(A, ADMIN_B, { read: true });
  const secondMain = await importCapture(pageB, 'b-main', B), secondObservation = secondMain.rows[0].id;
  await classify(pageB, secondObservation, 'browser-second-main-classify');
  const secondCreated = await createItem(pageB, secondObservation, 'browser-second-main-create'), secondItem = String(secondCreated.result.data!.itemId), secondBefore = await itemState(secondItem);
  await importCapture(pageB, 'b-jst-candidate-second', B); await pageB.goto(`/dashboard/catalog/${secondItem}`);
  await expect(pageB.getByTestId('catalog-detail-core-ready')).toBeVisible({ timeout: 60_000 });
  await assertEvidenceCandidates(pageB, secondItem, { present: ['N1C-JST-CANDIDATE-SECOND'], absent: ['N1C-BS-CANDIDATE-SECOND'], emptySource: true });
  await importCapture(page, 'a-bs-candidate-second');
  await assertEvidenceCandidates(pageB, secondItem, { present: ['N1C-JST-CANDIDATE-SECOND', 'N1C-BS-CANDIDATE-SECOND'], absent: [], emptySource: false });
  await expect(pageB.getByTestId('catalog-evidence-subject')).toContainText('待补货号');
  await expect(pageB.getByTestId('catalog-evidence-subject')).not.toContainText(secondItem); expect(await itemState(secondItem)).toEqual(secondBefore);
  for (const activePage of [page, pageB]) {
    await assertEvidenceCandidates(activePage, mainItem, { present: ['N1C-BS-CANDIDATE', 'N1C-JST-CANDIDATE'], absent: [], emptySource: false });
  }
  expect(await itemState(mainItem)).toEqual(before);
  await grant(A, READ, { read: true, evidence: true, amount: true }); await grant(A, NO_AMOUNT, { read: true, manage: true, publish: true, evidence: true });
  await grant(A, NO_EVIDENCE, { read: true, manage: true, publish: true, amount: true });
  const results = []; let originalSensitiveHistory: Record<string, unknown> | null = null;
  for (const [kind, email, password, rawAllowed, scopedAllowed] of [
    ['readOnly', 'read-only@catalog.test', 'CatalogReadOnly123!', true, true], ['noAmount', 'no-amount@catalog.test', 'CatalogNoAmount123!', false, true],
    ['noEvidence', 'no-evidence@catalog.test', 'CatalogNoEvidence123!', false, true], ['sharedAdmin', 'scope-b@catalog.test', 'CatalogScopeB123!', false, true],
    ['operator', 'operator@catalog.test', 'CatalogOperator123!', false, false], ['anonymous', '', '', false, false],
  ] as const) {
    const actorContext = await browser.newContext(); await guard(actorContext); const actorPage = await actorContext.newPage(); if (email) await login(actorPage, email, password);
    const exported = await actorContext.request.get(`/api/catalog/product-evidence/${mainCapture}?projection=export`, { maxRedirects: 0 });
    const raw = await actorContext.request.get(`/api/catalog/product-evidence/${mainCapture}?projection=raw`, { maxRedirects: 0 });
    expect(exported.status() === 200).toBe(scopedAllowed); expect(raw.status() === 200).toBe(rawAllowed);
    const safeText = await exported.text(); for (const sentinel of [...privateSentinels, 'storageHandle', 'browser-main-confirm', 'browser-revision-private-reason']) expect(safeText).not.toContain(sentinel);
    assertPrivateGet(exported.headers()); assertPrivateGet(raw.headers());
    if (!rawAllowed) { const text = await raw.text(); for (const sentinel of [...privateSentinels, 'storageHandle']) expect(text).not.toContain(sentinel); }
    else { expect(hash(Buffer.from(await raw.body()))).toBe((await owner.query('SELECT bytes_sha256 FROM catalog.product_capture WHERE id=$1', [mainCapture])).rows[0].bytes_sha256); }
    if (scopedAllowed) {
      await actorPage.goto(`/dashboard/catalog/${mainItem}`); const publicExport = await actorContext.request.get(`/api/catalog/evidence/${mainItem}?projection=export`);
      expect(publicExport.status()).toBe(200); const body = await publicExport.text();
      assertPrivateGet(publicExport.headers());
      for (const sentinel of [...privateSentinels, 'browser-main-confirm', 'browser-revision-private-reason', 'N1C_PRIVATE_BROWSER_FIELD_REFERENCE', 'creationDecisionId', 'source_slot_basis']) expect(body).not.toContain(sentinel);
      await actorPage.goto(`/dashboard/catalog/intake?scope=${A}`); const historyButton = actorPage.getByRole('button', { name: '读取来源历史（需授权）', exact: true });
      const historyHttp = await actionHttp(actorPage, `history-${kind}`, (input) => input.projection === 'sensitive_history', () => historyButton.click(), { sensitive: rawAllowed });
      expect(historyHttp.result.success).toBe(rawAllowed);
      if (kind === 'readOnly') { sensitiveHistoryProbe = { actionId: historyHttp.actionId, body: historyHttp.sentBody }; originalSensitiveHistory = historyHttp.result.data ?? null; }
      if (rawAllowed) await expect(actorPage.getByTestId('sensitive-product-history')).toContainText('browser-main-confirm');
      else await expect(actorPage.getByTestId('sensitive-product-history')).toHaveCount(0);
      if (kind === 'readOnly' || kind === 'sharedAdmin') await expect(editor(actorPage, mainObservation).getByRole('button', { name: '保存分类', exact: true })).toBeDisabled();
    }
    await assertDirectWriteDenied(actorContext, actorPage, kind);
    if (sensitiveHistoryProbe && !rawAllowed) await assertSensitiveHistoryDenied(actorContext, kind);
    results.push({ kind, exportStatus: exported.status(), rawStatus: raw.status(), rawAllowed, scopedAllowed }); await actorContext.close();
  }
  const readContext = await browser.newContext(); await guard(readContext); const readPage = await readContext.newPage();
  await login(readPage, 'read-only@catalog.test', 'CatalogReadOnly123!');
  async function showCurrentSensitiveHistory(label: string) {
    await intake(readPage);
    const response = await actionHttp(readPage, label, (input) => input.projection === 'sensitive_history',
      () => readPage.getByRole('button', { name: '读取来源历史（需授权）', exact: true }).click(), { sensitive: true });
    expect(response.result.success).toBe(true); expect(response.result.data).toEqual(originalSensitiveHistory);
    await expect(readPage.getByTestId('sensitive-product-history')).toContainText('browser-main-confirm');
  }
  async function rejectPreviouslyDisplayedHistory(label: string, scopeStillReadable: boolean) {
    // The existing sensitive DOM is real authorized output. Revoke, then re-read through the existing UI, rather than inferring UI safety from a raw HTTP denial.
    await expect(readPage.getByTestId('sensitive-product-history')).toContainText('browser-main-confirm');
    const denied = await actionHttp(readPage, `history-ui-${label}`, (input) => input.projection === 'sensitive_history',
      () => readPage.getByRole('button', { name: '读取来源历史（需授权）', exact: true }).click());
    expect(denied.result.success).toBe(false); expect(denied.result).not.toHaveProperty('data');
    await expect(readPage.getByTestId('sensitive-product-history')).toHaveCount(0);
    await assertSensitiveHistoryDenied(readContext, label);
    await catalogRscNavigation(readPage, '/dashboard/catalog', () => readPage.getByRole('link', { name: '返回商品资料', exact: true }).click());
    // U7：侧栏旧入口已删除，URL 仍可达。
    await catalogPage(readPage, '/dashboard/catalog/intake');
    await expect(readPage.getByTestId('sensitive-product-history')).toHaveCount(0);
    if (scopeStillReadable) {
      await selectIntakeScope(readPage, A); await expect(editor(readPage, mainObservation)).toBeVisible();
    } else {
      // Other authorized scopes may remain the default. The revoked C scope itself must be unavailable, not merely absent from the currently selected scope's rows.
      await expect(readPage.getByLabel('来源范围', { exact: true }).locator(`option[value="${A}"]`)).toHaveCount(0);
      await catalogPage(readPage, `/dashboard/catalog/intake?scope=${A}`);
      await expect(readPage.getByLabel('来源范围', { exact: true })).toHaveCount(0);
      await expect(editor(readPage, mainObservation)).toHaveCount(0);
    }
    const currentDom = await readPage.locator('body').innerText();
    for (const marker of [...privateSentinels, 'browser-main-confirm', 'browser-revision-private-reason']) expect(currentDom).not.toContain(marker);
    save(`browser-current-ui-after-${label}.json`, { label, scopeStillReadable, sensitiveHistoryCount: await readPage.getByTestId('sensitive-product-history').count(),
      observationCount: await editor(readPage, mainObservation).count(), currentDomSha256: hash(currentDom), currentUrl: readPage.url(),
      boundary: 'Actual UI re-read rejected and removed the prior sensitive DOM; actual client Link return obtained a current RSC response. No claim that no-store clears previously displayed content by itself.' });
  }
  await showCurrentSensitiveHistory('history-before-ui-revocation');
  for (const capability of ['can_read', 'can_evidence', 'can_amount']) {
    try {
      await owner.query(`UPDATE catalog.source_scope_grant SET ${capability}=false,grant_revision=grant_revision+1 WHERE scope_id=$1 AND profile_id=$2`, [A, READ]);
      await rejectPreviouslyDisplayedHistory(`revoked-${capability}`, capability !== 'can_read');
    } finally { await owner.query(`UPDATE catalog.source_scope_grant SET ${capability}=true,grant_revision=grant_revision+1 WHERE scope_id=$1 AND profile_id=$2`, [A, READ]); }
    await showCurrentSensitiveHistory(`history-restored-${capability}`);
  }
  try {
    await owner.query('UPDATE catalog.source_scope_grant SET enabled=false,grant_revision=grant_revision+1 WHERE scope_id=$1 AND profile_id=$2', [A, READ]);
    await rejectPreviouslyDisplayedHistory('grant-disabled', false);
  } finally { await owner.query('UPDATE catalog.source_scope_grant SET enabled=true,grant_revision=grant_revision+1 WHERE scope_id=$1 AND profile_id=$2', [A, READ]); }
  await readPage.goto(`/dashboard/catalog/intake?scope=${A}`);
  const restoredHistory = await actionHttp(readPage, 'history-restored-after-revocation', (input) => input.projection === 'sensitive_history',
    () => readPage.getByRole('button', { name: '读取来源历史（需授权）', exact: true }).click(), { sensitive: true });
  expect(originalSensitiveHistory).not.toBeNull(); expect(restoredHistory.result.success).toBe(true); expect(restoredHistory.result.data).toEqual(originalSensitiveHistory);
  await expect(readPage.getByTestId('sensitive-product-history')).toContainText('browser-main-confirm');
  const storage = await readPage.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));
  for (const marker of [...privateSentinels, 'browser-main-confirm', 'browser-revision-private-reason']) expect(JSON.stringify(storage)).not.toContain(marker);
  await readContext.close();
  const inactive = await browser.newContext(); await guard(inactive);
  await inactive.request.post('/api/auth/sign-in/email', { data: { email: 'inactive@catalog.test', password: 'CatalogInactive123!' } });
  const inactiveRaw = await inactive.request.get(`/api/catalog/product-evidence/${mainCapture}?projection=raw`, { maxRedirects: 0 });
  expect(inactiveRaw.status()).not.toBe(200); await assertSensitiveHistoryDenied(inactive, 'inactive'); await inactive.close();
  await owner.query('UPDATE catalog.source_scope_grant SET enabled=false,grant_revision=grant_revision+1 WHERE scope_id=$1 AND profile_id=$2', [A, ADMIN_B]);
  const revoked = await contextB.request.get(`/api/catalog/product-evidence/${mainCapture}?projection=export`, { maxRedirects: 0 }); expect(revoked.status()).not.toBe(200);
  await assertDirectWriteDenied(contextB, pageB, 'revoked');
  await assertSensitiveHistoryDenied(contextB, 'scope-revoked');
  await pageB.goto(`/dashboard/catalog/${mainItem}`); await expect(pageB.getByTestId('catalog-material-ice-code')).toContainText('N1C-BROWSER-127'); await expect(pageB.getByTestId('catalog-write-denied')).toBeVisible();
  await pageB.goto(`/dashboard/catalog/intake?scope=${A}`); await expect(pageB.getByLabel('来源范围', { exact: true })).toHaveCount(0);
  await contextB.close(); await assertBaselineProtected(); save('browser-permissions-and-candidates-final.json', { mainItem, secondItem, before, after: await itemState(mainItem), secondBefore, secondAfter: await itemState(secondItem),
    candidateOrderingBoundary: 'Two distinct real products and frozen candidate pairs: first BS then later JST capture; second JST then later BS capture. Explicit isolated read grants precede late captures. No observation deletion, external target or Inventory placeholder.',
    results, revokedStatus: revoked.status(), inactiveStatus: inactiveRaw.status(), privateNoStore: true, outside });
});
