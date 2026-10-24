import { test, expect, type BrowserContext, type Page, type Route } from '@playwright/test';

/**
 * 真实页面承接 / 新品同 UUID / 补码旧版本 / 修订重导 / 金额显式读取。
 *
 * !! 本文件不在任何 playwright.config*.ts 的 testMatch 中，本包未运行它（lead 决定：只做
 *    testid / URL 迁移，不扩大主套件范围）。其流程还早于更早的包：
 *    - 「准备固定基线预览 / 发布固定基线 / 承接冻结飞书观测 / manifest-counts / catalog-counts
 *      的 126·548 文案」已经只在开发维护页 `/dashboard/catalog/admin`，不在 `/dashboard/catalog`；
 *    - 列表行名称已从链接改成按钮（`查看详情` 打开弹窗），旧的「点行链接进详情」不再成立。
 *    因此本文件即使完成下列契约迁移也不保证可跑通，属于历史未运行资产。
 *
 * 已按 repair-matrix §4 迁移：item-code → catalog-material-ice-code；item-revision →
 *    catalog-detail-version；item-uuid / restricted-amounts / load-restricted-amounts /
 *    候选审计 / 原始 JSON → `/dashboard/catalog/admin/evidence?item=<uuid>`；
 *    历史与「采用资料」→ 变更记录 / 商品资料分区（必须先真实点击分区）。
 */
import { Pool } from 'pg';
import fs from 'node:fs';
import path from 'node:path';

const runRoot = process.env.CATALOG_RUN_ROOT!;
const evidence = process.env.CATALOG_TEST_EVIDENCE_DIR!;
const instance = JSON.parse(fs.readFileSync(path.join(runRoot, 'instance/catalog-instance.json'), 'utf8'));
const owner = new Pool({ connectionString: `postgres://${instance.bootstrapUser}:${instance.bootstrapPassword}@${instance.host}:${instance.port}/${instance.dbName}` });
test.describe.configure({ mode: 'serial' });
const external: string[] = [];
let observedAction: { id: string; body: string; contentType: string } | null = null;
async function guard(context: BrowserContext) {
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (['127.0.0.1', 'localhost'].includes(url.hostname)) return route.continue();
    external.push(url.origin); return route.abort();
  });
}
async function login(page: Page, email: string, password: string) {
  await page.goto('/auth/login');
  await page.getByLabel('邮箱', { exact: true }).fill(email);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}
async function oldRows() {
  const result: Record<string, unknown> = {};
  for (const name of ['product', 'product_variant', 'inventory']) result[name] = (await owner.query(`SELECT * FROM public.${name} ORDER BY id`)).rows;
  return result;
}
async function revisionSnapshot(itemId: string) {
  const current = (await owner.query(`SELECT c.revision,c.financial_revision,r.ice_code_snapshot,r.fields,r.reason,r.actor_id,r.recorded_at,r.evidence_ref
    FROM catalog.item_current c JOIN catalog.item_revision r ON r.item_id=c.item_id AND r.revision=c.revision WHERE c.item_id=$1`, [itemId])).rows[0];
  const revisionCount = (await owner.query('SELECT count(*)::int AS count FROM catalog.item_revision WHERE item_id=$1', [itemId])).rows[0].count;
  return { current, revisionCount };
}
async function injectOneUnknownReceipt(page: Page, flow: string) {
  const actions: { id: string; body: string; realStatus: number; realResult: unknown; injected: boolean }[] = [];
  let failure: string | null = null;
  const handler = async (route: Route) => {
    const request = route.request();
    const id = request.headers()['next-action'];
    if (!id) return route.fallback();
    const response = await route.fetch();
    const responseText = await response.text();
    const entry = { id, body: request.postData() ?? '', realStatus: response.status(), realResult: null as unknown, injected: false };
    actions.push(entry);
    let successes = 0;
    const body = responseText.split('\n').map((line) => {
      const match = line.match(/^([a-f0-9]+):(\{.*\})$/);
      if (!match) return line;
      let result;
      try { result = JSON.parse(match[2]); } catch { return line; }
      if (result.success !== true || !result.data?.itemId || typeof result.data.revision !== 'number') return line;
      successes += 1; entry.realResult = result;
      if (actions.length !== 1) return line;
      entry.injected = true;
      return match[1] + ':' + JSON.stringify({ success: false, outcome: 'unknown',
        error: '提交结果暂未确认。请保留原请求编号核对状态，勿创建新请求重复操作。' });
    }).join('\n');
    if (successes !== 1) failure = `${flow}: expected one real successful mutation payload, observed ${successes}`;
    const headers = { ...response.headers() };
    delete headers['content-length']; delete headers['content-encoding'];
    await route.fulfill({ response, headers, body });
  };
  await page.route('**/dashboard/catalog/**', handler);
  return { actions, failure: () => failure, stop: () => page.unroute('**/dashboard/catalog/**', handler) };
}
async function recoverOriginalRequest(page: Page, itemId: string, before: Awaited<ReturnType<typeof revisionSnapshot>>,
  injection: Awaited<ReturnType<typeof injectOneUnknownReceipt>>, flow: string, expectedIntent: Record<string, unknown>) {
  await expect(page.getByRole('status')).toContainText('提交结果暂未确认');
  const pending = page.getByTestId('pending-original-request');
  await expect(pending).toContainText('其他输入不会作为本次保存内容');
  const original = JSON.parse(await page.getByTestId('pending-original-input').innerText());
  expect(original).toMatchObject({ ...expectedIntent, itemId, expectedRevision: before.current.revision });
  expect(original.requestId).toMatch(/^[a-f\d-]{36}$/i);
  const firstRequest = JSON.parse(injection.actions[0].body);
  expect(firstRequest).toEqual([original]);
  expect(injection.actions[0].injected).toBe(true);
  expect(injection.actions[0].realStatus).toBe(200);
  const afterUnknown = await revisionSnapshot(itemId);
  expect(afterUnknown.revisionCount).toBe(before.revisionCount + 1);
  expect(afterUnknown.current.financial_revision).toBe(before.current.financial_revision);
  expect(afterUnknown.current.reason).toBe(original.reason);
  expect(afterUnknown.current.evidence_ref).toBe(`manual-request:${original.requestId}`);
  if (flow === 'nonprice') expect(afterUnknown.current.fields.factory.evidenceRef).toBe('fixture:browser-nonprice');
  for (const field of await page.getByRole('region', { name: '补充资料', exact: true }).locator('form input, form select').all()) {
    await expect(field).toBeDisabled();
  }
  await expect(page.getByRole('button', { name: '保存非价格修订', exact: true })).toBeDisabled();
  const retry = page.getByRole('button', { name: '核对/重试原请求', exact: true });
  expect(await retry.evaluate((button) => button.closest('form') === null)).toBe(true);
  // A stale/new value is deliberately put into the locked DOM as a stronger
  // guard probe; ordinary users cannot edit these disabled form controls.
  const differentValue = `UNSENT DIFFERENT ${flow}`;
  await page.getByLabel('明确采用值（留空表示明确空串）').evaluate((field, value) => { (field as HTMLInputElement).value = value; }, differentValue);
  await expect(page.getByTestId('pending-original-input')).not.toContainText(differentValue);
  await page.evaluate(() => {
    document.documentElement.dataset.catalogInvalidCount = '0';
    document.addEventListener('invalid', () => { document.documentElement.dataset.catalogInvalidCount = String(Number(document.documentElement.dataset.catalogInvalidCount) + 1); }, true);
  });
  await retry.click();
  await expect(pending).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText(`已确认原请求 ${original.requestId}`);
  await expect(page.getByRole('status')).not.toContainText(differentValue);
  await expect(page.getByLabel('明确采用值（留空表示明确空串）')).toHaveValue('');
  expect(await page.evaluate(() => document.documentElement.dataset.catalogInvalidCount)).toBe('0');
  expect(injection.failure()).toBeNull();
  expect(injection.actions).toHaveLength(2);
  expect(injection.actions[1].id).toBe(injection.actions[0].id);
  expect(injection.actions[1].body).toBe(injection.actions[0].body);
  expect(injection.actions[1].injected).toBe(false);
  const afterRetry = await revisionSnapshot(itemId);
  expect(afterRetry).toEqual(afterUnknown);
  const audit = (await owner.query('SELECT request_id,actor_id,action,item_id,result FROM catalog.audit_event WHERE request_id=$1', [original.requestId])).rows;
  expect(audit).toHaveLength(1); expect(audit[0].item_id).toBe(itemId);
  expect(audit[0].actor_id).toBe('11111111-1111-4111-8111-111111111101');
  await injection.stop();
  const result = { boundary: 'Real successful local fixture mutation plus one synthetic front-end unknown Action receipt; not a real COMMIT/network fault.',
    original, before, afterUnknown, afterRetry, actions: injection.actions, audit,
    retryOutsideForm: true, invalidEvents: 0, differentLockedInputNotSaved: differentValue };
  fs.writeFileSync(path.join(evidence, `unknown-recovery-${flow}.json`), JSON.stringify(result, null, 2));
  return result;
}
async function assertHistoryMetadata(page: Page, itemId: string, expectedRevisions: number[]) {
  const rows = (await owner.query(`SELECT revision,reason,actor_id,recorded_at,evidence_ref,ice_code_snapshot,fields
    FROM catalog.item_revision WHERE item_id=$1 ORDER BY revision DESC`, [itemId])).rows;
  const response = await page.request.get(`/api/catalog/evidence/${itemId}?projection=export`);
  expect(response.status()).toBe(200); expect(response.headers()['cache-control']).toContain('no-store');
  const exported = await response.json();
  const comparisons = [];
  for (const revision of expectedRevisions) {
    const row = rows.find((entry) => entry.revision === revision)!;
    const expected = { reason: row.reason, actorId: row.actor_id, recordedAt: new Date(row.recorded_at).toISOString(), evidenceRef: row.evidence_ref };
    const actual = exported.history.find((entry: { revision: number }) => entry.revision === revision);
    expect(actual.revisionAudit).toEqual(expected);
    expect(Object.keys(actual.revisionAudit).sort()).toEqual(['reason', 'actorId', 'recordedAt', 'evidenceRef'].sort());
    await page.goto(`/dashboard/catalog/${itemId}?revision=${revision}`);
    await expect(page.getByTestId('catalog-detail-core-ready')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('catalog-tab-history').click();
    await expect(page.getByTestId('catalog-tab-history')).toHaveAttribute('aria-selected', 'true');
    const history = page.getByTestId(`revision-history-${revision}`).or(page.getByTestId(`revision-${revision}`));
    await expect(history.getByTestId('revision-reason')).toHaveText(expected.reason);
    await expect(history.getByTestId('revision-actor')).toHaveText(expected.actorId);
    await expect(history.getByTestId('revision-recorded-at')).toHaveText(expected.recordedAt);
    await expect(history.getByTestId('revision-evidence')).toHaveText(expected.evidenceRef);
    await expect(page.getByRole('region', { name: '变更记录', exact: true })).toContainText('不代表来源业务更新时间');
    // 直链页头部身份（货号·名称）与商品资料分区（真实点击）。
    await expect(page.getByTestId('catalog-detail-title')).toContainText(row.ice_code_snapshot ?? '待补货号');
    await page.getByTestId('catalog-tab-material').click();
    await expect(page.getByTestId('catalog-material-details')).toContainText(row.fields.factory.raw || '明确空串');
    const dom = { reason: await history.getByTestId('revision-reason').textContent(), actorId: await history.getByTestId('revision-actor').textContent(),
      recordedAt: await history.getByTestId('revision-recorded-at').textContent(), evidenceRef: await history.getByTestId('revision-evidence').textContent() };
    expect(dom).toEqual(expected);
    expect(actual.fields).toEqual(row.fields);
    comparisons.push({ revision, sql: expected, export: actual.revisionAudit, dom, iceCodeAtRevision: row.ice_code_snapshot, factoryAtRevision: row.fields.factory });
  }
  const text = JSON.stringify(exported);
  for (const forbidden of ['operatingPrice', 'financialRevision', 'storageHandle', 'password', 'sessionToken']) expect(text).not.toContain(forbidden);
  fs.writeFileSync(path.join(evidence, 'history-page-http-export-sql.json'), JSON.stringify({ itemId, status: response.status(),
    cacheControl: response.headers()['cache-control'], comparisons, privateAmountRowsAbsent: true }, null, 2));
}
test.afterAll(async () => { await owner.end(); });

test('真实页面承接、新品同UUID、补码旧版本、修订重导及金额显式读取', async ({ page, context }) => {
  await guard(context);
  const before = await oldRows();
  await login(page, 'admin@catalog.test', 'CatalogAdmin123!');
  // 维护动作（准备/发布固定基线、承接冻结观测）与 catalog-counts 的 126·548 摘要现在只在维护页。
  await page.goto('/dashboard/catalog/admin');
  page.on('request', (request) => {
    const id = request.headers()['next-action'];
    if (id && !observedAction) observedAction = { id, body: request.postData() ?? '', contentType: request.headers()['content-type'] ?? 'text/plain;charset=UTF-8' };
  });
  await page.getByRole('button', { name: '准备固定基线预览', exact: true }).click();
  await expect(page.getByTestId('manifest-counts')).toContainText('完整产物 147 份');
  await expect(page.getByTestId('manifest-counts')).toContainText('子集 129 份');
  await page.getByRole('button', { name: '发布固定基线', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已原子承接');
  await expect(page.getByTestId('catalog-counts')).toContainText('资料 126');
  await expect(page.getByTestId('catalog-counts')).toContainText('548');
  await page.getByRole('button', { name: '承接冻结飞书观测', exact: true }).click();
  // 回到列表做搜索（列表搜索标签已改为「搜索货号、中英文名、69编码或已确认来源SKU」）。
  await page.goto('/dashboard/catalog');
  await expect(page.getByRole('status')).toContainText('159格');
  await page.getByLabel(/搜索/).fill('烟酰胺提亮精华水150ml');
  await page.getByRole('link', { name: 'ICE LERSKIN 烟酰胺提亮精华水150ml', exact: true }).click();
  await expect(page.getByText('新品，待补货号', { exact: true })).toBeVisible();
  await expect(page.getByTestId('item-code')).toHaveText('待补货号');
  // 日常详情不再输出 item-uuid（技术证据退出日常详情，U3）：UUID 从 URL detail 参数读取。
  const itemId = (new URL(page.url()).searchParams.get('detail') ?? '').trim();
  const initialRevision = Number(await page.getByTestId('catalog-detail-version').innerText());
  expect(await page.getByRole('button', { name: /改绑|撤销|正式关系启用|换表/ }).count()).toBe(0);
  // v3：证据在弹窗内子视图（本文件历史未运行，仅迁移契约）。
  await page.goto(`/dashboard/catalog?detail=${itemId}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('catalog-detail-core-ready')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('catalog-detail-more').locator('summary').click();
  await page.getByTestId('catalog-more-evidence').click();
  await expect(page.getByTestId('catalog-evidence-view')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('catalog-evidence-audit')).toContainText('JST', { timeout: 60_000 });
  await expect(page.getByTestId('catalog-evidence-audit')).toContainText('BS');
  await page.goto(`/dashboard/catalog?detail=${itemId}`);
  await expect(page.getByTestId('catalog-detail-core-ready')).toBeVisible({ timeout: 60_000 });
  await page.getByLabel('首次ICE货号').fill('TEST-CATALOG-NEW-122');
  await page.getByLabel('补码依据').fill('仅本地隔离fixture测试，不是实际业务货号');
  const beforeCode = await revisionSnapshot(itemId);
  const codeInjection = await injectOneUnknownReceipt(page, 'initial-code');
  await page.getByRole('button', { name: '保存首次货号', exact: true }).click();
  await recoverOriginalRequest(page, itemId, beforeCode, codeInjection, 'initial-code',
    { code: 'TEST-CATALOG-NEW-122', reason: '仅本地隔离fixture测试，不是实际业务货号' });
  await expect(page.getByTestId('catalog-material-ice-code')).toContainText('TEST-CATALOG-NEW-122');
  await expect(page.getByTestId('catalog-detail-version')).toHaveText(String(initialRevision + 2));
  await page.getByLabel('修订字段', { exact: true }).selectOption('factory');
  await page.getByLabel('明确采用值（留空表示明确空串）').fill('ISOLATED TEST FACTORY');
  await page.getByLabel('证据引用', { exact: true }).fill('fixture:browser-nonprice');
  await page.getByLabel('修订理由', { exact: true }).fill('本地隔离资料修订测试');
  const beforeRevision = await revisionSnapshot(itemId);
  const revisionInjection = await injectOneUnknownReceipt(page, 'nonprice');
  await page.getByRole('button', { name: '保存非价格修订', exact: true }).click();
  await recoverOriginalRequest(page, itemId, beforeRevision, revisionInjection, 'nonprice',
    { reason: '本地隔离资料修订测试', fields: { factory: { state: 'observed', meaning: 'value', raw: 'ISOLATED TEST FACTORY', evidenceRef: 'fixture:browser-nonprice' } } });
  await expect(page.getByRole('status')).toContainText('资料修订已保存');
  const currentRevision = Number(await page.getByTestId('catalog-detail-version').innerText());
  expect(currentRevision).toBe(initialRevision + 2);
  await assertHistoryMetadata(page, itemId, [initialRevision, initialRevision + 1, currentRevision]);
  await page.goto(`/dashboard/catalog/${itemId}?revision=${initialRevision}`);
  await expect(page.getByTestId('catalog-detail-core-ready')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('catalog-material-ice-code')).toContainText('待补货号');
  await page.goto('/dashboard/catalog');
  await page.getByRole('button', { name: '准备固定基线预览', exact: true }).click();
  await expect(page.getByRole('button', { name: '发布固定基线', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '发布固定基线', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已原子承接');
  await page.goto(`/dashboard/catalog/${itemId}`);
  await expect(page.getByTestId('catalog-material-ice-code')).toContainText('TEST-CATALOG-NEW-122');
  await expect(page.getByTestId('catalog-detail-version')).toHaveText(String(currentRevision));
  await expect(page.getByTestId('catalog-material-details')).toContainText('ISOLATED TEST FACTORY');
  const codeItem = (await owner.query(`SELECT item_id FROM catalog.catalog_item_code WHERE ice_code='WM0072'`)).rows[0].item_id;
  await page.goto(`/dashboard/catalog/${codeItem}`);
  await expect(page.getByText('本批冻结说明：该系统尚未建档（用户已确认）；不代表实时账号状态或库存0。', { exact: true })).toBeVisible();
  // 受限金额读取只在授权维护页（日常详情已无该入口）。
  await page.goto(`/dashboard/catalog?detail=${codeItem}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('catalog-detail-core-ready')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('catalog-detail-more').locator('summary').click();
  await page.getByTestId('catalog-more-evidence').click();
  await expect(page.getByTestId('catalog-evidence-view')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('restricted-amounts')).toHaveCount(0);
  await page.getByTestId('load-restricted-amounts').click();
  await expect(page.getByTestId('restricted-amounts')).toContainText('5.18');
  await expect(page.getByTestId('restricted-amounts')).toContainText('5.68');
  await expect(page.getByTestId('restricted-amounts')).toContainText('5.5');
  const exported = await page.request.get(`/api/catalog/evidence/${itemId}?projection=export`);
  expect(exported.status()).toBe(200); expect(exported.headers()['cache-control']).toContain('no-store');
  const exportDto = await exported.json(); expect(exportDto.item.itemId).toBe(itemId); expect(JSON.stringify(exportDto)).not.toContain('operatingPrice');
  const artifactId = (await owner.query(`SELECT id FROM catalog.artifact WHERE logical_name='match-bundle.json'`)).rows[0].id;
  const raw = await page.request.get(`/api/catalog/evidence/${artifactId}?projection=raw`);
  expect(raw.status()).toBe(200); expect(raw.headers()['cache-control']).toContain('no-store');
  expect((await raw.body()).length).toBeGreaterThan(1000000);
  expect(await oldRows()).toEqual(before);
  expect(external).toEqual([]);
  const finalState = (await owner.query(`SELECT i.id,c.revision,c.financial_revision,r.ice_code_snapshot FROM catalog.catalog_item i JOIN catalog.item_current c ON c.item_id=i.id JOIN catalog.item_revision r ON r.item_id=i.id AND r.revision=c.revision WHERE i.id=$1`, [itemId])).rows;
  fs.writeFileSync(path.join(evidence, 'browser-final-assertions.json'), JSON.stringify({ itemId, initialRevision, currentRevision, finalState, oldPublicRowsUnchanged: true, externalAttempts: external, fixtureCodeOnly: true, manifest: { full: 147, subset: 129 } }, null, 2));
  await page.screenshot({ path: path.join(evidence, 'catalog-detail.png'), fullPage: true });
});

test('匿名、运营、停用拒绝资料、raw、历史、导出和金额，撤权后重新核验', async ({ browser }) => {
  const itemId = (await owner.query(`SELECT item_id FROM catalog.catalog_item_code WHERE ice_code='WM0072'`)).rows[0].item_id;
  const artifactId = (await owner.query(`SELECT id FROM catalog.artifact LIMIT 1`)).rows[0].id;
  for (const kind of ['anonymous', 'operator', 'inactive'] as const) {
    const context = await browser.newContext(); await guard(context); const page = await context.newPage();
    if (kind === 'operator') await login(page, 'operator@catalog.test', 'CatalogOperator123!');
    if (kind === 'inactive') {
      const response = await context.request.post('/api/auth/sign-in/email', { data: { email: 'inactive@catalog.test', password: 'CatalogInactive123!' } });
      expect(response.status()).toBeLessThan(500);
    }
    for (const url of [`/api/catalog/evidence/${artifactId}?projection=raw`, `/api/catalog/evidence/${itemId}?projection=export`, `/api/catalog/evidence/${itemId}?projection=amounts`]) {
      const res = await context.request.get(url, { maxRedirects: 0 }); expect(res.status()).not.toBe(200);
      expect(await res.text()).not.toContain('5.18');
    }
    expect(observedAction).not.toBeNull();
    if (kind === 'operator' && observedAction) {
      const deniedAction = await context.request.post('/dashboard/catalog', { data: observedAction.body,
        headers: { 'Next-Action': observedAction.id, 'Content-Type': observedAction.contentType, Origin: process.env.CATALOG_BASE_URL! } });
      expect(await deniedAction.text()).toMatch(/当前账户无权访问商品资料|商品资料操作未完成/);
    }
    await page.goto(`/dashboard/catalog/${itemId}?revision=1`);
    for (const forbidden of ['item-uuid', 'bs-basis-sha', 'catalog-audit-json', 'load-restricted-amounts', 'restricted-amounts']) {
      await expect(page.getByTestId(forbidden)).toHaveCount(0);
    }
    await page.goto(`/dashboard/catalog?detail=${itemId}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('catalog-evidence-view')).toHaveCount(0);
    expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
    await context.close();
  }
  const context = await browser.newContext(); await guard(context); const page = await context.newPage();
  await login(page, 'admin@catalog.test', 'CatalogAdmin123!');
  try {
    await owner.query(`UPDATE public.profiles SET is_active=false WHERE id='11111111-1111-4111-8111-111111111101'`);
    const res = await context.request.get(`/api/catalog/evidence/${itemId}?projection=amounts`, { maxRedirects: 0 });
    expect(res.status()).not.toBe(200); expect(await res.text()).not.toContain('5.18');
  } finally {
    await owner.query(`UPDATE public.profiles SET is_active=true WHERE id='11111111-1111-4111-8111-111111111101'`);
    await context.close();
  }
  expect(external).toEqual([]);
});
