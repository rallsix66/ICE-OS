import { test, expect, type BrowserContext, type Page, type Route } from '@playwright/test';
import { Pool } from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const runRoot = process.env.CATALOG_RUN_ROOT!;
const evidence = process.env.CATALOG_TEST_EVIDENCE_DIR!;
const instance = JSON.parse(fs.readFileSync(path.join(runRoot, 'instance/catalog-instance.json'), 'utf8'));
const owner = new Pool({ connectionString: `postgres://${instance.bootstrapUser}:${instance.bootstrapPassword}@${instance.host}:${instance.port}/${instance.dbName}` });
const app = new Pool({ connectionString: process.env.P0_02_APP_DATABASE_URL, max: 1 });
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
const ADMIN_A = '11111111-1111-4111-8111-111111111101', CONTRACT_A = 'cccccccc-aaaa-4ccc-8aaa-ccccccccccc1';
const PROOF_A = 'eeeeeeee-aaaa-4eee-8aaa-eeeeeeeeeee1';
const CAPTURE_A = 'dddddddd-aaaa-4ddd-8aaa-ddddddddddd1', CAPTURE_A2 = 'dddddddd-aaaa-4ddd-8aaa-ddddddddddd2';
const outside: string[] = [];
let actionProbes: { actionId: string; body: string }[] = [];
const save = (name: string, value: unknown) => fs.writeFileSync(path.join(evidence, name), JSON.stringify(value, null, 2));
test.describe.configure({ mode: 'serial' });

async function guard(context: BrowserContext) {
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) return route.continue();
    outside.push(url.origin); return route.abort();
  });
}
async function login(page: Page, email = 'admin@catalog.test', password = 'CatalogAdmin123!') {
  await page.goto('/auth/login');
  await page.getByLabel('邮箱', { exact: true }).fill(email);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}
async function publicRows() {
  const result: Record<string, unknown> = {};
  for (const table of ['product', 'product_variant', 'inventory']) result[table] = (await owner.query(`SELECT * FROM public.${table} ORDER BY id`)).rows;
  return result;
}
async function frozenState() {
  return (await owner.query(`SELECT
    (SELECT count(*)::int FROM catalog.catalog_item) AS items,
    (SELECT count(*)::int FROM catalog.source_observation WHERE review_state IS NOT NULL) AS observations,
    (SELECT count(*)::int FROM catalog.decision_evidence WHERE entry_kind='candidate_snapshot' AND selected_item_id IS NOT NULL) AS choices,
    (SELECT md5(jsonb_agg(to_jsonb(d) ORDER BY id)::text) FROM catalog.decision_evidence d) AS decision_hash,
    (SELECT md5(jsonb_agg(to_jsonb(r) ORDER BY item_id,revision)::text) FROM catalog.item_revision r) AS revision_hash,
    (SELECT md5(jsonb_agg(to_jsonb(f) ORDER BY item_id,financial_revision)::text) FROM catalog_private.item_financial_revision f) AS financial_hash`)).rows[0];
}
async function importFixture(page: Page, fixtureId: string) {
  await page.getByLabel('固定fixture', { exact: true }).selectOption(fixtureId);
  await page.getByRole('button', { name: '准备来源观测预览', exact: true }).click();
  await expect(page.getByTestId('identity-preview')).toContainText(fixtureId);
  await page.getByRole('button', { name: '原子导入来源观测', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('观测已原子保存');
  await expect(page.getByTestId('identity-preview')).toHaveCount(0);
}
async function recordHead(recordId: string) {
  return (await owner.query(`SELECT id,scope_id,revision,state,active_claim_id,current_contract_id FROM catalog.source_record WHERE id=$1`, [recordId])).rows[0];
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, child]) => JSON.stringify(key) + ':' + canonical(child)).join(',') + '}';
  return JSON.stringify(value);
}
const hash = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex');
type ActionHttpResult = { status: string; code?: string; data?: Record<string, unknown> };
async function submitHttpAction(page: Page, reason: string, submit: () => Promise<void>) {
  let receive!: (response: { status: number; body: string; actionId: string; requestBody: string; headers: Record<string, string> }) => void;
  let reject!: (error: unknown) => void;
  const responsePromise = new Promise<Parameters<typeof receive>[0]>((resolve, fail) => { receive = resolve; reject = fail; });
  const pattern = '**/dashboard/catalog/sources**';
  let matches = 0;
  const handler = async (route: Route) => {
    const request = route.request(), actionId = request.headers()['next-action'], requestBody = request.postData() ?? '';
    let payload: unknown;
    try { payload = JSON.parse(requestBody); } catch { return route.fallback(); }
    const input: unknown = Array.isArray(payload) ? payload[0] : null;
    if (request.method() !== 'POST' || !actionId || new URL(request.url()).pathname !== '/dashboard/catalog/sources'
      || input === null || typeof input !== 'object' || !('reason' in input) || input.reason !== reason) return route.fallback();
    try {
      matches += 1;
      const response = await route.fetch(), body = await response.text();
      const captured = { status: response.status(), body, actionId, requestBody, headers: response.headers() };
      await route.fulfill({ response }); // Forward the actual server response without changing status, headers or body.
      receive(captured);
    } catch (error) { reject(error); throw error; }
  };
  await page.route(pattern, handler);
  try {
    const [, response] = await Promise.all([submit(), responsePromise]);
    expect(matches).toBe(1); expect(response.status).toBe(200);
    const results = response.body.split('\n').flatMap((line) => {
      const match = line.match(/^[a-z0-9]+:(\{.*\})$/); if (!match) return [];
      try { const result = JSON.parse(match[1]) as ActionHttpResult; return ['success', 'denied', 'conflict', 'unknown'].includes(result.status) ? [result] : []; } catch { return []; }
    });
    expect(results).toHaveLength(1);
    for (const forbidden of ['9988.17', '8877.26', 'storageHandle', 'storage_handle', 'bootstrapPassword', 'financial_revision']) expect(response.body).not.toContain(forbidden);
    save(`browser-action-http-${reason}.json`, { reason, actionId: response.actionId, requestBody: response.requestBody,
      actualResponse: { status: response.status, body: response.body, bodySha256: hash(response.body),
        contentType: response.headers['content-type'], cacheControl: response.headers['cache-control'], vary: response.headers.vary },
      forwardedOriginalUnmodified: true, syntheticSuccess: false });
    return { status: response.status, result: results[0] };
  } finally { await page.unroute(pattern, handler); }
}
async function scopedIdentityState(scopeId = A) {
  const state: Record<string, unknown> = {};
  for (const table of ['source_record', 'identity_claim', 'observation_record_link', 'source_identity_request']) {
    state[table] = (await owner.query(`SELECT to_jsonb(t) row FROM catalog.${table} t WHERE scope_id=$1 ORDER BY to_jsonb(t)::text`, [scopeId])).rows;
  }
  return state;
}
/** Fresh, single-scope test evidence; only its import uses the real app function. No fixture or production path changes. */
async function importRepairProof(phase: string, afterRevision: number, options: {
  scopeId?: string; contractId?: string; values?: Partial<Record<'vendorRecordId' | 'sku' | 'name' | 'barcode', string>>;
  warehouse?: string;
} = {}) {
  const scopeId = options.scopeId ?? A, contractId = options.contractId ?? CONTRACT_A;
  const template = (await owner.query(`SELECT fields,market_context,warehouse_context FROM catalog.identity_observation
    WHERE evidence_id=$1 AND fields->'vendorRecordId'->>'value'='fixture-vendor-001'`, [CAPTURE_A2])).rows[0];
  const evidenceId = crypto.randomUUID(), observationId = crypto.randomUUID();
  const fields: Record<string, Record<string, unknown>> = Object.fromEntries(Object.entries(template.fields as Record<string, Record<string, unknown>>)
    .map(([key, field]) => [key, { ...field, evidenceRef: `${evidenceId}#/records/0/${key}` }]));
  for (const [key, value] of Object.entries(options.values ?? {})) fields[key] = value === ''
    ? { state: 'empty', value: null, evidenceRef: `${evidenceId}#/records/0/${key}` }
    : { state: 'value', value, evidenceRef: `${evidenceId}#/records/0/${key}` };
  const proofSemantics = { uniqueness: true, stability: true, keyChange: true, reuse: true, oldObservationCompatible: true };
  const observations = [{ observationId, recordPointer: '/records/0', fields,
    marketContext: template.market_context, warehouseContext: options.warehouse === undefined ? template.warehouse_context
      : { state: 'known', raw: options.warehouse, canonical: options.warehouse, evidenceRef: `${evidenceId}#/records/0/warehouse` },
    position: { file: 'controlled-browser-repair-proof.json', row: 1 }, payloadSha256: hash(canonical(fields)),
    sourceEffectiveAt: null, sourceAvailability: 'not_observed' }];
  // The new verification statement is a new fact after the actual head, not an ID-renamed copy or a delayed old capture.
  const verificationFact = { phase, verifiedAfterRecordRevision: afterRevision, statement: `Explicit isolated verification after identity fact ${afterRevision}` };
  const bytes = Buffer.from(canonical({ environment: 'fixture', scopeId, verificationFact, proofSemantics, observations }));
  const bytesSha256 = hash(bytes), storageHandle = `${bytesSha256.slice(0, 2)}/${bytesSha256}`;
  const target = path.join(runRoot, 'private-evidence', ...storageHandle.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes, { flag: 'wx' });
  const coverage = { singleScope: true, complete: true, recordCount: 1, verificationEnvironment: 'fixture' };
  const projectionSha256 = hash(canonical(observations));
  const payload = { evidenceId, captureKey: `browser-repair-${phase}-${evidenceId}`, manifestId: 'controlled-browser-repair-proof-v1',
    bytesSha256, size: bytes.length, format: 'json', parserId: 'controlled-browser-repair-proof', parserVersion: '1',
    contractId, contractRevision: 1, coverage, projectionSha256, proofSemantics, storageHandle, observations,
    adoptionDigest: hash(canonical(['iceos-identity-capture-v1', bytesSha256, 'controlled-browser-repair-proof', '1', contractId, 1, scopeId, coverage, projectionSha256])) };
  const requestId = crypto.randomUUID(), intent = hash(canonical(['iceos-source-request-v1', ADMIN_A, scopeId, 'import_capture', payload]));
  const client = await app.connect();
  try {
    await client.query('BEGIN'); await client.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`, [ADMIN_A]);
    const role = (await client.query('SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
    expect(role.rolsuper).toBe(false); expect(role.rolbypassrls).toBe(false); expect(role.current_user).not.toBe(instance.bootstrapUser);
    const imported = (await client.query('SELECT catalog.identity_mutate($1,$2,$3,$4,$5::jsonb) result', [requestId, scopeId, 'import_capture', intent, JSON.stringify(payload)])).rows[0].result;
    await client.query('COMMIT');
    expect(imported).toMatchObject({ requestId, evidenceId, observationIds: [observationId], verificationEnvironment: 'fixture', relationshipUsable: false });
    return { evidenceId, observationId, bytesSha256, verificationFact, requestId, role, scopeId, contractId };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
async function bootstrapResidualWarehouseScope(warehouse: string) {
  const scopeId = crypto.randomUUID(), contractId = crypto.randomUUID(), proofId = crypto.randomUUID();
  const proofSemantics = { uniqueness: true, stability: true, keyChange: true, reuse: true, oldObservationCompatible: true };
  const bytes = Buffer.from(canonical({ environment: 'fixture', scopeId, purpose: 'Controlled browser residual identity-warehouse policy', warehouse, proofSemantics }));
  const proofSha256 = hash(bytes), proofHandle = `${proofSha256.slice(0, 2)}/${proofSha256}`;
  const target = path.join(runRoot, 'private-evidence', ...proofHandle.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes, { flag: 'wx' });
  const config = { scopeId, contractId, proofId, system: 'bigseller', entityKind: 'product_record', accountKind: 'fixture_account',
    accountParts: [`browser-residual-account-${scopeId}`], resourceKind: 'fixture_dataset', resourceParts: [`browser-residual-resource-${scopeId}`],
    marketRole: 'context', marketIdentity: null, warehouseRole: 'identity', warehouseIdentity: warehouse,
    scopeState: 'identity_ready', displayName: '隔离fixture · 冻结范围残余回归', strategy: 'vendor_stable_id', keyFields: ['vendorRecordId'],
    proofCaptureKey: `browser-residual-policy-${proofId}`, proofSha256, proofSize: bytes.length, proofHandle, proofSemantics,
    grants: [{ profileId: ADMIN_A, read: true, manage: true, evidence: true, amount: true, enabled: true }] };
  await owner.query('SELECT catalog.identity_fixture_bootstrap($1::jsonb)', [JSON.stringify(config)]);
  return { scopeId, contractId, proofId, warehouse, proofSha256 };
}
async function injectOneLostResult(page: Page, action: 'register' | 'link', mode: 'synthetic_unknown_receipt' | 'drop_response') {
  const calls: { actionId: string; body: string; injected: boolean; realResult: unknown; responseStatus: number }[] = [];
  const handler = async (route: Route) => {
    const request = route.request(), actionId = request.headers()['next-action'];
    if (!actionId) return route.fallback();
    const response = await route.fetch();
    let matching = false;
    const entry = { actionId, body: request.postData() ?? '', injected: false, realResult: null as unknown, responseStatus: response.status() };
    const body = (await response.text()).split('\n').map((line) => {
      const match = line.match(/^([a-z0-9]+):(\{.*\})$/);
      if (!match) return line;
      let result;
      try { result = JSON.parse(match[2]); } catch { return line; }
      if (result.status !== 'success' || result.data?.action !== action) return line;
      matching = true; entry.realResult = result;
      if (calls.length !== 0) return line;
      entry.injected = true;
      return match[1] + ':' + JSON.stringify({ status: 'unknown', code: 'IDENTITY_REQUEST_OUTCOME_UNKNOWN' });
    }).join('\n');
    if (!matching) return route.fulfill({ response });
    calls.push(entry);
    if (mode === 'drop_response' && entry.injected) return route.abort('failed');
    const headers = { ...response.headers() }; delete headers['content-length']; delete headers['content-encoding'];
    await route.fulfill({ response, headers, body });
  };
  await page.route('**/dashboard/catalog/sources**', handler);
  return { calls, stop: () => page.unroute('**/dashboard/catalog/sources**', handler) };
}
async function recover(page: Page, injected: Awaited<ReturnType<typeof injectOneLostResult>>, kind: 'register' | 'link') {
  await expect(page.getByTestId('identity-pending-request')).toBeVisible();
  await expect(page.getByRole('status')).toContainText('提交结果暂未确认');
  const original = JSON.parse(await page.getByTestId('identity-pending-input').innerText());
  expect(original.kind).toBe(kind);
  expect(injected.calls).toHaveLength(1);
  expect(injected.calls[0].injected).toBe(true);
  expect(injected.calls[0].responseStatus).toBe(200);
  expect(JSON.parse(injected.calls[0].body)).toEqual([original.input]);
  const retry = page.getByRole('button', { name: '核对/重试原请求', exact: true });
  expect(await retry.evaluate((button) => button.closest('form') === null)).toBe(true);
  try {
    await owner.query(`UPDATE catalog.source_scope_grant SET enabled=false,grant_revision=grant_revision+1
      WHERE scope_id=$1 AND profile_id='11111111-1111-4111-8111-111111111101'`, [A]);
    await retry.click();
    await expect(page.getByTestId('identity-pending-request')).toBeVisible();
    await expect(page.getByRole('status')).toContainText('当前无法确认原结果');
    expect((await owner.query('SELECT count(*)::int n FROM catalog.source_identity_request WHERE request_id=$1', [original.input.requestId])).rows[0].n).toBe(1);
  } finally {
    await owner.query(`UPDATE catalog.source_scope_grant SET enabled=true,grant_revision=grant_revision+1
      WHERE scope_id=$1 AND profile_id='11111111-1111-4111-8111-111111111101'`, [A]);
  }
  await retry.click();
  await expect(page.getByTestId('identity-pending-request')).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText('原请求已确认');
  expect(injected.calls).toHaveLength(2);
  expect(JSON.parse(injected.calls[1].body)).toEqual([{ action: kind, input: original.input }]);
  expect(injected.calls[1].actionId).not.toBe(injected.calls[0].actionId);
  actionProbes = injected.calls.map(({ actionId, body }) => ({ actionId, body }));
  const audit = (await owner.query('SELECT request_id,scope_id,actor_id,action,result FROM catalog.source_identity_request WHERE request_id=$1', [original.input.requestId])).rows;
  expect(audit).toHaveLength(1);
  expect(audit[0].scope_id).toBe(A);
  expect(audit[0].actor_id).toBe('11111111-1111-4111-8111-111111111101');
  await injected.stop();
  save(`browser-${kind}-original-request-recovery.json`, { boundary: kind === 'register'
    ? 'Real commit followed by one synthetic front-end unknown Action receipt, not a real COMMIT failure.'
    : 'Real commit followed by an intentionally aborted browser response, separate from Repository COMMIT acknowledgement tests.', original, calls: injected.calls, audit,
    retryOutsideForm: true, independentReadOnlyReceiptLookup: true, revokedGrantReceiptDeniedWithoutLosingPending: true,
    sameRequestIdAndCompleteOriginalInput: true });
  return audit[0].result;
}

test.afterAll(async () => { await app.end(); await owner.end(); });

test('fixture观测、来源UUID、原选择关联、两种浏览器未知回执恢复、上下文重排与历史/raw/导出', async ({ page, context }) => {
  await guard(context); const beforePublic = await publicRows();
  await login(page);
  await page.goto('/dashboard/catalog');
  await page.getByRole('button', { name: '准备固定基线预览', exact: true }).click();
  await expect(page.getByTestId('manifest-counts')).toContainText('完整产物 147 份');
  await expect(page.getByTestId('manifest-counts')).toContainText('子集 129 份');
  await page.getByRole('button', { name: '发布固定基线', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已原子承接');
  await page.getByRole('button', { name: '承接冻结飞书观测', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('159格');
  const frozen = await frozenState(); expect(frozen.items).toBe(126); expect(frozen.choices).toBe(548);
  await page.goto(`/dashboard/catalog/sources?scope=${A}`);
  await expect(page.getByTestId('identity-scope-id')).toHaveText(A);
  await importFixture(page, 'products-v1');
  const observation = (await owner.query(`SELECT id FROM catalog.identity_observation WHERE evidence_id=$1 AND fields->'vendorRecordId'->>'value'='fixture-vendor-001'`, [CAPTURE_A])).rows[0].id;
  const article = page.getByTestId(`identity-observation-${observation}`);
  await article.getByRole('textbox', { name: '登记理由' }).fill('fixture稳定ID核实；不代表真实账号');
  const unknownReceipt = await injectOneLostResult(page, 'register', 'synthetic_unknown_receipt');
  await article.getByRole('button', { name: '核实来源身份', exact: true }).click();
  const registered = await recover(page, unknownReceipt, 'register');
  const recordId = registered.recordId as string;
  const head1 = await recordHead(recordId); expect(head1.revision).toBe(1); expect(head1.state).toBe('active');
  const origin = (await owner.query(`SELECT d.observation_id,d.selected_item_id FROM catalog.decision_evidence d
    JOIN catalog.source_observation o ON o.id=d.observation_id JOIN catalog.observation_batch b ON b.id=o.batch_id
    JOIN catalog.source_dataset ds ON ds.id=b.dataset_id JOIN catalog.source_namespace ns ON ns.id=ds.namespace_id
    WHERE d.entry_kind='candidate_snapshot' AND d.selected_item_id IS NOT NULL AND ns.system='bigseller'
    AND d.entry_key='/candidates/0' AND o.fields->'sku'->>'raw'='780103214060'`)).rows[0];
  expect(origin).toBeTruthy();
  const linkRegion = page.getByRole('region', { name: '观测关联', exact: true });
  await linkRegion.getByLabel('观测', { exact: true }).selectOption(`frozen:${origin.observation_id}`);
  await linkRegion.getByLabel('已核来源', { exact: true }).selectOption(recordId);
  await linkRegion.getByLabel('关联证明', { exact: true }).selectOption(PROOF_A);
  await linkRegion.getByLabel('关联理由', { exact: true }).fill('仅fixture证明原观测来源身份；548目标不变');
  const droppedResponse = await injectOneLostResult(page, 'link', 'drop_response');
  await linkRegion.getByRole('button', { name: '保存观测关联', exact: true }).click();
  await recover(page, droppedResponse, 'link');
  await expect(page.getByTestId('identity-link')).toContainText(`frozen:${origin.observation_id}`);
  await expect(page.getByTestId('identity-record-frozen-choices')).toContainText(origin.selected_item_id);
  await expect(page.getByTestId('identity-record-frozen-choices')).toContainText('manual_selected');
  await page.goto(`/dashboard/catalog/${origin.selected_item_id}?revision=1`);
  await expect(page.getByRole('region', { name: '当前来源核实附注', exact: true })).toContainText(recordId);
  await expect(page.getByTestId('identity-attachment-counts')).toContainText('真实长期身份核实 0');
  await page.goto(`/dashboard/catalog/sources?scope=${A}`);
  const record = page.getByTestId(`identity-record-${recordId}`);
  await record.getByLabel('身份操作').selectOption('revoke');
  await record.getByLabel('新证明').selectOption(PROOF_A);
  await record.getByLabel('复核理由').fill('fixture显式撤销，旧读取不得复活');
  await record.getByRole('button', { name: '保存身份状态', exact: true }).click();
  await expect(record.getByTestId('source-record-revision')).toHaveText('2');
  await expect(page.getByRole('status')).toContainText('原请求已确认');
  const revoked = await recordHead(recordId); expect(revoked.state).toBe('revoked'); expect(revoked.revision).toBe(2);
  await importFixture(page, 'products-reordered-v2');
  expect(await recordHead(recordId)).toEqual(revoked);
  const v2 = (await owner.query(`SELECT id,market_context,warehouse_context FROM catalog.identity_observation WHERE evidence_id=$1
    AND fields->'vendorRecordId'->>'value'='fixture-vendor-001'`, [CAPTURE_A2])).rows[0];
  expect(v2.market_context.state).toBe('known'); expect(v2.warehouse_context.state).toBe('known');
  await record.getByLabel('身份操作').selectOption('reverify');
  await record.getByLabel('新证明').selectOption(CAPTURE_A2);
  await record.getByLabel('复核观测').selectOption(v2.id);
  await record.getByLabel('复核理由').fill('fixture新观测新证据和当前墓碑版本显式复核');
  await record.getByRole('button', { name: '保存身份状态', exact: true }).click();
  await expect(record.getByTestId('source-record-revision')).toHaveText('3');
  await expect(page.getByRole('status')).toContainText('原请求已确认');
  const reverified = await recordHead(recordId); expect(reverified.id).toBe(recordId); expect(reverified.revision).toBe(3);
  expect(reverified.scope_id).toBe(A); expect(reverified.state).toBe('active'); expect(reverified.active_claim_id).toBe(head1.active_claim_id);
  await expect(record.getByTestId('source-record-revision')).toHaveText('3');
  await expect(record).toContainText('已核实（fixture）');
  await expect(page.getByTestId(`identity-observation-${v2.id}`)).toContainText('市场 known · 仓库 known');
  const safe = await page.request.get(`/api/catalog/source-evidence/${CAPTURE_A2}?projection=export`);
  expect(safe.status()).toBe(200); expect(safe.headers()['cache-control']).toContain('no-store'); expect(safe.headers().vary).toContain('Cookie');
  const dto = await safe.json(), serialized = JSON.stringify(dto);
  const exportedProof = (await owner.query(`SELECT scope_id,bytes_sha256,parser_id,parser_version,coverage,collected_at,source_effective_at,source_availability
    FROM catalog.identity_evidence WHERE id=$1`, [CAPTURE_A2])).rows[0];
  expect(dto.evidence).toMatchObject({ evidenceId: CAPTURE_A2, scopeId: exportedProof.scope_id, sha256: exportedProof.bytes_sha256,
    parserId: exportedProof.parser_id, parserVersion: exportedProof.parser_version, coverage: exportedProof.coverage,
    sourceEffectiveAt: exportedProof.source_effective_at, sourceAvailability: exportedProof.source_availability });
  expect(Date.parse(dto.evidence.collectedAt)).toBe(exportedProof.collected_at.getTime());
  const exportedObservations = (await owner.query(`SELECT id,fields,market_context,warehouse_context,position,record_pointer FROM catalog.identity_observation WHERE evidence_id=$1 ORDER BY id`, [CAPTURE_A2])).rows;
  expect(dto.observations.map((entry: { observationId: string }) => entry.observationId).sort()).toEqual(exportedObservations.map((row) => row.id));
  for (const row of exportedObservations) expect(dto.observations.find((entry: { observationId: string }) => entry.observationId === row.id)).toMatchObject({
    fields: row.fields, marketContext: row.market_context, warehouseContext: row.warehouse_context, position: row.position, recordPointer: row.record_pointer });
  for (const forbidden of ['9988.17', '8877.26', 'costPriceRaw', 'storageHandle', 'storage_handle', 'bootstrapPassword', 'financial_revision']) expect(serialized).not.toContain(forbidden);
  const raw = await page.request.get(`/api/catalog/source-evidence/${CAPTURE_A2}?projection=raw`);
  expect(raw.status()).toBe(200); expect(raw.headers()['cache-control']).toContain('no-store'); expect((await raw.text())).toContain('9988.17');
  const rawHash = crypto.createHash('sha256').update(await raw.body()).digest('hex');
  expect(rawHash).toBe((await owner.query('SELECT bytes_sha256 FROM catalog.identity_evidence WHERE id=$1', [CAPTURE_A2])).rows[0].bytes_sha256);
  await page.getByText('查看范围内身份历史', { exact: true }).click();
  const histories = (await owner.query(`SELECT request_id,reason,actor_id,recorded_at,before_state,after_state FROM catalog.source_identity_request WHERE source_record_id=$1 ORDER BY record_revision`, [recordId])).rows;
  expect(histories).toHaveLength(3);
  for (const history of histories) {
    const entry = page.getByTestId('identity-history-entry').filter({ hasText: history.reason });
    await expect(entry).toHaveCount(1); await expect(entry).toContainText(history.actor_id);
    expect(Date.parse(await entry.locator('time').getAttribute('datetime') ?? '')).toBe(history.recorded_at.getTime());
    await expect(entry).toContainText('来源业务时间 未观察到');
    await entry.getByText('当时身份版本事实', { exact: true }).click();
    expect(JSON.parse(await entry.locator('pre').innerText())).toEqual({ beforeState: history.before_state, afterState: history.after_state });
  }
  await page.getByText('查看全部观测关联版本', { exact: true }).click();
  const linked = (await owner.query('SELECT * FROM catalog.observation_record_link WHERE observation_key=$1 ORDER BY link_revision', [`frozen:${origin.observation_id}`])).rows;
  expect(linked).toHaveLength(1);
  await expect(page.getByTestId('identity-link-history')).toContainText(linked[0].contract_id);
  await expect(page.getByTestId('identity-link-history')).toContainText(linked[0].actor_id);
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
  expect(await publicRows()).toEqual(beforePublic); expect(await frozenState()).toEqual(frozen); expect(outside).toEqual([]);
  await expect(page.locator('body')).not.toContainText('9988.17');
  save('browser-identity-final-assertions.json', { recordId, observation, originalFrozen: origin, head1, revoked, reverified,
    rawHash, histories, safeHttpExport: dto, exportedProof, frozenBefore: frozen, frozenAfter: await frozenState(), publicUnchanged: true, realVerifiedCount: 0, relationshipUsable: false, outside });
  await page.screenshot({ path: path.join(evidence, 'identity-workspace.png'), fullPage: true });
});

test('第二账号同SKU独立建来源身份；默认/历史/导出/raw及当前撤权的HTTP拒绝', async ({ browser }) => {
  const contextB = await browser.newContext(); await guard(contextB); const pageB = await contextB.newPage();
  await login(pageB, 'scope-b@catalog.test', 'CatalogScopeB123!');
  await pageB.goto(`/dashboard/catalog/sources?scope=${B}`); await importFixture(pageB, 'products-conflicts-v3');
  const observationB = (await owner.query(`SELECT id FROM catalog.identity_observation WHERE evidence_id='dddddddd-bbbb-4ddd-8bbb-ddddddddddd3' AND record_pointer='/records/0'`)).rows[0].id;
  const articleB = pageB.getByTestId(`identity-observation-${observationB}`);
  await articleB.getByLabel('登记理由').fill('fixture另账号可靠组合键，不复用A来源');
  await articleB.getByRole('button', { name: '核实来源身份', exact: true }).click();
  await expect(pageB.getByTestId('source-record-id')).toHaveCount(1);
  await expect(pageB.getByRole('status')).toContainText('原请求已确认');
  const records = (await owner.query('SELECT id,scope_id FROM catalog.source_record ORDER BY scope_id')).rows;
  expect(records.filter((record) => record.scope_id === A)).toHaveLength(1); expect(records.filter((record) => record.scope_id === B)).toHaveLength(1);
  expect(records[0].id).not.toBe(records[1].id);
  const results = [];
  const actors = [
    ['anonymous', '', '', false, false], ['adminB', 'scope-b@catalog.test', 'CatalogScopeB123!', false, false],
    ['readOnly', 'read-only@catalog.test', 'CatalogReadOnly123!', true, true],
    ['noAmount', 'no-amount@catalog.test', 'CatalogNoAmount123!', true, false],
    ['noEvidence', 'no-evidence@catalog.test', 'CatalogNoEvidence123!', true, false],
    ['operator', 'operator@catalog.test', 'CatalogOperator123!', false, false],
    ['revoked', 'revoked@catalog.test', 'CatalogRevoked123!', false, false],
  ] as const;
  for (const [kind, email, password, exportAllowed, rawAllowed] of actors) {
    const context = await browser.newContext(); await guard(context); const page = await context.newPage();
    if (email) await login(page, email, password);
    const exported = await context.request.get(`/api/catalog/source-evidence/${CAPTURE_A}?projection=export`, { maxRedirects: 0 });
    const raw = await context.request.get(`/api/catalog/source-evidence/${CAPTURE_A}?projection=raw`, { maxRedirects: 0 });
    expect(exported.status() === 200).toBe(exportAllowed); expect(raw.status() === 200).toBe(rawAllowed);
    if (!rawAllowed) { expect(await raw.text()).not.toContain('9988.17'); expect(await raw.text()).not.toContain('storageHandle'); }
    await page.goto(`/dashboard/catalog/sources?scope=${A}`);
    if (!exportAllowed) await expect(page.getByTestId('identity-scope-id')).toHaveCount(0);
    if (kind === 'readOnly') await expect(page.getByRole('button', { name: '准备来源观测预览', exact: true })).toBeDisabled();
    expect(actionProbes).toHaveLength(2);
    const actionResults = [];
    for (const probe of actionProbes) {
      const denied = await context.request.post('/dashboard/catalog/sources', { data: probe.body, maxRedirects: 0,
        headers: { 'Next-Action': probe.actionId, 'Content-Type': 'text/plain;charset=UTF-8', Origin: new URL(page.url()).origin } });
      const body = await denied.text();
      if (denied.status() === 200) {
        if (kind === 'noAmount' || kind === 'noEvidence') {
          // These actors can manage identity; another actor's original request is still a conflict.
          expect(body).toContain('"status":"conflict"'); expect(body).toContain('IDENTITY_REQUEST_CONFLICT');
        } else { expect(body).toContain('"status":"denied"'); expect(body).toContain('IDENTITY_OPERATION_DENIED'); }
      }
      else expect([303, 307, 401, 403]).toContain(denied.status());
      expect(body).not.toContain('"status":"success"'); expect(body).not.toContain('9988.17');
      expect(body).not.toContain('"relationshipUsable":false');
      actionResults.push({ status: denied.status(), denied: true });
    }
    results.push({ kind, exportStatus: exported.status(), rawStatus: raw.status(), exportAllowed, rawAllowed, actionResults });
    await context.close();
  }
  const inactive = await browser.newContext(); await guard(inactive);
  await inactive.request.post('/api/auth/sign-in/email', { data: { email: 'inactive@catalog.test', password: 'CatalogInactive123!' } });
  const inactiveRaw = await inactive.request.get(`/api/catalog/source-evidence/${CAPTURE_A}?projection=raw`, { maxRedirects: 0 });
  expect(inactiveRaw.status()).not.toBe(200); await inactive.close();
  await pageB.goto(`/dashboard/catalog/sources?scope=${A}`); await expect(pageB.getByTestId('identity-scope-id')).toHaveCount(0);
  await owner.query(`UPDATE catalog.source_scope_grant SET enabled=false,grant_revision=grant_revision+1 WHERE scope_id=$1 AND profile_id='11111111-1111-4111-8111-111111111107'`, [B]);
  const deniedAfterRevoke = await contextB.request.get('/api/catalog/source-evidence/dddddddd-bbbb-4ddd-8bbb-ddddddddddd3?projection=export', { maxRedirects: 0 });
  expect(deniedAfterRevoke.status()).not.toBe(200);
  await pageB.goto(`/dashboard/catalog/sources?scope=${B}`); await expect(pageB.getByTestId('identity-scope-id')).toHaveCount(0);
  await contextB.close(); expect(outside).toEqual([]);
  save('browser-scope-http-permission-matrix.json', { results, inactiveStatus: inactiveRaw.status(), revokedStatus: deniedAfterRevoke.status(), records, outside });
});

test('补修R1/R2：暂停后撤销观测关联；旧证明拒绝恢复，真正新证明沿原UUID恢复', async ({ page, context }) => {
  await guard(context); const publicBefore = await publicRows(), frozenBefore = await frozenState();
  const initial = (await owner.query('SELECT id FROM catalog.source_record WHERE scope_id=$1', [A])).rows;
  expect(initial).toHaveLength(1);
  const recordId = initial[0].id as string, headBefore = await recordHead(recordId);
  expect(headBefore.state).toBe('active'); expect(headBefore.revision).toBe(3);
  const historyBefore = (await owner.query('SELECT * FROM catalog.source_identity_request WHERE source_record_id=$1 ORDER BY record_revision', [recordId])).rows;
  const firstProof = await importRepairProof('association-before-suspension', headBefore.revision);
  await login(page); await page.goto(`/dashboard/catalog/sources?scope=${A}`);
  const record = page.getByTestId(`identity-record-${recordId}`), region = page.getByRole('region', { name: '观测关联', exact: true });
  const observationKey = `identity:${firstProof.observationId}`;
  await region.getByLabel('观测', { exact: true }).selectOption(observationKey);
  await region.getByLabel('已核来源', { exact: true }).selectOption(recordId);
  await region.getByLabel('关联证明', { exact: true }).selectOption(PROOF_A);
  await region.getByLabel('关联理由', { exact: true }).fill('N1A-R1-initial-link');
  const linkHttp = await submitHttpAction(page, 'N1A-R1-initial-link', () => region.getByRole('button', { name: '保存观测关联', exact: true }).click());
  expect(linkHttp.result).toMatchObject({ status: 'success', data: { action: 'link', recordId, linkRevision: 1, relationshipUsable: false } });
  await expect(page.getByTestId('identity-link').filter({ hasText: observationKey })).toContainText('linked v1');
  const originalLink = (await owner.query('SELECT * FROM catalog.observation_record_link WHERE observation_key=$1 ORDER BY link_revision', [observationKey])).rows;
  expect(originalLink).toHaveLength(1);
  await record.getByLabel('身份操作').selectOption('suspend');
  await record.getByLabel('新证明').selectOption(PROOF_A);
  await record.getByLabel('复核理由').fill('N1A-R1-suspend-before-link-correction');
  const suspendHttp = await submitHttpAction(page, 'N1A-R1-suspend-before-link-correction', () => record.getByRole('button', { name: '保存身份状态', exact: true }).click());
  expect(suspendHttp.result).toMatchObject({ status: 'success', data: { state: 'suspended', revision: 4, recordId } });
  await expect(record.getByTestId('source-record-revision')).toHaveText('4'); await expect(record).toContainText('身份暂停');
  const suspended = await recordHead(recordId);
  await region.getByLabel('观测', { exact: true }).selectOption(observationKey);
  await region.getByLabel('已核来源', { exact: true }).selectOption(recordId);
  await region.getByLabel('关联操作', { exact: true }).selectOption('revoke');
  await region.getByLabel('关联证明', { exact: true }).selectOption(CAPTURE_A2);
  await region.getByLabel('关联理由', { exact: true }).fill('N1A-R1-revoke-link-while-identity-suspended');
  const revokeHttp = await submitHttpAction(page, 'N1A-R1-revoke-link-while-identity-suspended', () => region.getByRole('button', { name: '保存观测关联', exact: true }).click());
  expect(revokeHttp.result).toMatchObject({ status: 'success', data: { action: 'link', recordId, observationKey, linkRevision: 2 } });
  await expect(page.getByTestId('identity-link').filter({ hasText: observationKey })).toContainText('revoked v2');
  await expect(record).toContainText('身份暂停'); await expect(record.getByTestId('source-record-revision')).toHaveText('4');
  expect(await recordHead(recordId)).toEqual(suspended);
  const linkHistory = (await owner.query('SELECT * FROM catalog.observation_record_link WHERE observation_key=$1 ORDER BY link_revision', [observationKey])).rows;
  expect(linkHistory).toHaveLength(2); expect(linkHistory[0]).toEqual(originalLink[0]);
  expect(linkHistory[1]).toMatchObject({ previous_revision: 1, link_revision: 2, status: 'revoked', record_id: recordId,
    contract_id: originalLink[0].contract_id, proof_id: originalLink[0].proof_id, identity_observation_id: firstProof.observationId });
  const revokeRequest = (await owner.query('SELECT proof_id,result,source_record_id,record_revision FROM catalog.source_identity_request WHERE request_id=$1', [revokeHttp.result.data?.requestId])).rows[0];
  expect(revokeRequest).toMatchObject({ proof_id: CAPTURE_A2, source_record_id: null, record_revision: null });
  const evidenceHttp = await page.request.get(`/api/catalog/source-evidence/${firstProof.evidenceId}?projection=export`);
  expect(evidenceHttp.status()).toBe(200); expect(evidenceHttp.headers()['cache-control']).toContain('no-store');
  const safeExport = await evidenceHttp.json(); expect(safeExport.evidence.sha256).toBe(firstProof.bytesSha256);
  expect(JSON.stringify(safeExport)).not.toMatch(/storageHandle|storage_handle|9988\.17|8877\.26|bootstrapPassword/);
  await page.getByText('查看全部观测关联版本', { exact: true }).click();
  const domLinks = page.getByTestId('identity-link-history').filter({ hasText: observationKey });
  await expect(domLinks).toHaveCount(2); await expect(domLinks.filter({ hasText: 'linked v1' })).toHaveCount(1);
  await expect(domLinks.filter({ hasText: 'revoked v2' })).toHaveCount(1);
  save('browser-n1a-r1-link-revoke-after-suspend.json', { firstProof, headBefore, suspended, linkHttp, suspendHttp, revokeHttp,
    originalLink, linkHistory, revokeRequest, identityStillSuspended: await recordHead(recordId), exportStatus: evidenceHttp.status(), safeExport });

  const restore = async (proof: Awaited<ReturnType<typeof importRepairProof>>, reason: string) => {
    await record.getByLabel('身份操作').selectOption('reverify'); await record.getByLabel('新证明').selectOption(proof.evidenceId);
    await record.getByLabel('复核合同').selectOption(CONTRACT_A); await record.getByLabel('复核观测').selectOption(proof.observationId);
    await record.getByLabel('复核理由').fill(reason);
    return submitHttpAction(page, reason, () => record.getByRole('button', { name: '保存身份状态', exact: true }).click());
  };
  const freshAfterSuspend = await importRepairProof('fresh-verification-after-suspension', suspended.revision);
  await page.reload(); const restoredHttp = await restore(freshAfterSuspend, 'N1A-R2-first-fresh-verification');
  expect(restoredHttp.result).toMatchObject({ status: 'success', data: { recordId, revision: 5, state: 'active', claimId: headBefore.active_claim_id } });
  await expect(record.getByTestId('source-record-revision')).toHaveText('5');
  await record.getByLabel('身份操作').selectOption('revoke'); await record.getByLabel('新证明').selectOption(PROOF_A);
  await record.getByLabel('复核理由').fill('N1A-R2-new-tombstone-after-proof-used');
  const tombstoneHttp = await submitHttpAction(page, 'N1A-R2-new-tombstone-after-proof-used', () => record.getByRole('button', { name: '保存身份状态', exact: true }).click());
  expect(tombstoneHttp.result).toMatchObject({ status: 'success', data: { recordId, revision: 6, state: 'revoked' } });
  await expect(record.getByTestId('source-record-revision')).toHaveText('6'); await expect(record).toContainText('身份已撤销');
  const tombstone = await recordHead(recordId), beforeStale = await scopedIdentityState();
  const chronology = (await owner.query(`SELECT e.collected_at,q.recorded_at,e.collected_at<q.recorded_at AS proof_predates_tombstone
    FROM catalog.identity_evidence e JOIN catalog.source_identity_request q ON q.source_record_id=$1 AND q.record_revision=6 WHERE e.id=$2`, [recordId, freshAfterSuspend.evidenceId])).rows[0];
  expect(chronology.proof_predates_tombstone).toBe(true);
  const staleHttp = await restore(freshAfterSuspend, 'N1A-R2-reuse-old-proof-new-request');
  expect(staleHttp.result).toEqual({ status: 'denied', code: 'IDENTITY_OPERATION_DENIED' });
  await expect(page.getByRole('status')).toContainText('原请求未保存');
  await expect(record.getByTestId('source-record-revision')).toHaveText('6'); await expect(record).toContainText('身份已撤销');
  const afterStale = await scopedIdentityState();
  expect(await recordHead(recordId)).toEqual(tombstone); expect(afterStale).toEqual(beforeStale);
  const trulyNewProof = await importRepairProof('fresh-verification-after-latest-tombstone', tombstone.revision);
  expect(trulyNewProof.bytesSha256).not.toBe(freshAfterSuspend.bytesSha256);
  await page.reload(); const latestHttp = await restore(trulyNewProof, 'N1A-R2-truly-new-proof-after-latest-tombstone');
  expect(latestHttp.result).toMatchObject({ status: 'success', data: { recordId, revision: 7, state: 'active', claimId: headBefore.active_claim_id, relationshipUsable: false } });
  await expect(record.getByTestId('source-record-revision')).toHaveText('7'); await expect(record).toContainText('已核实（fixture）');
  const finalHead = await recordHead(recordId);
  expect(finalHead).toMatchObject({ id: recordId, revision: 7, state: 'active', active_claim_id: headBefore.active_claim_id, current_contract_id: CONTRACT_A });
  const finalHistory = (await owner.query('SELECT * FROM catalog.source_identity_request WHERE source_record_id=$1 ORDER BY record_revision', [recordId])).rows;
  expect(finalHistory).toHaveLength(7); expect(finalHistory.slice(0, historyBefore.length)).toEqual(historyBefore);
  expect(finalHistory.map((entry) => entry.after_state.state)).toEqual(['active', 'revoked', 'active', 'suspended', 'active', 'revoked', 'active']);
  expect((await owner.query('SELECT * FROM catalog.observation_record_link WHERE observation_key=$1 ORDER BY link_revision', [observationKey])).rows).toEqual(linkHistory);
  expect((await owner.query('SELECT id FROM catalog.identity_claim WHERE record_id=$1', [recordId])).rows.map((row) => row.id)).toEqual([headBefore.active_claim_id]);
  expect(await publicRows()).toEqual(publicBefore); expect(await frozenState()).toEqual(frozenBefore);
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]); expect(outside).toEqual([]);
  await expect(page.locator('body')).not.toContainText('9988.17');
  save('browser-n1a-r2-stale-proof-rejection.json', { recordId, freshAfterSuspend, restoredHttp, tombstoneHttp, tombstone, chronology,
    beforeStale, staleHttp, afterStale, trulyNewProof, latestHttp, finalHead, finalHistory, linkHistory,
    oldProofRejectedWithoutHeadOrHistoryAdvance: true, oldPublicAndFrozenStateUnchanged: true, realIdentityVerifiedCount: 0, relationshipUsable: false });
});

test('残余R2：不相干B新证明与A旧观测真实拒绝，包含A的新证明沿原UUID恢复', async ({ page, context }) => {
  await guard(context); const publicBefore = await publicRows(), frozenBefore = await frozenState();
  const records = (await owner.query('SELECT id FROM catalog.source_record WHERE scope_id=$1', [A])).rows;
  expect(records).toHaveLength(1); const recordId = records[0].id as string, initial = await recordHead(recordId);
  expect(initial).toMatchObject({ revision: 7, state: 'active' });
  const historyBefore = (await owner.query('SELECT * FROM catalog.source_identity_request WHERE source_record_id=$1 ORDER BY record_revision', [recordId])).rows;
  const oldObservation = (await owner.query(`SELECT id,evidence_id FROM catalog.identity_observation
    WHERE evidence_id=$1 AND fields->'vendorRecordId'->>'value'='fixture-vendor-001'`, [CAPTURE_A2])).rows[0];
  await login(page); await page.goto(`/dashboard/catalog/sources?scope=${A}`);
  const record = page.getByTestId(`identity-record-${recordId}`);
  await record.getByLabel('身份操作').selectOption('revoke'); await record.getByLabel('新证明').selectOption(PROOF_A);
  await record.getByLabel('复核理由').fill('N1A-residual-R2-invalidate-A');
  const revokeHttp = await submitHttpAction(page, 'N1A-residual-R2-invalidate-A', () => record.getByRole('button', { name: '保存身份状态', exact: true }).click());
  expect(revokeHttp.result).toMatchObject({ status: 'success', data: { recordId, revision: 8, state: 'revoked' } });
  await expect(record.getByTestId('source-record-revision')).toHaveText('8'); const tombstone = await recordHead(recordId);
  const unrelated = await importRepairProof('residual-only-unrelated-B-after-A-tombstone', 8,
    { values: { vendorRecordId: 'browser-residual-unrelated-B', sku: 'BROWSER-UNRELATED-B', name: 'Only unrelated B freshly observed' } });
  const members = (await owner.query(`SELECT id,evidence_id,fields->'vendorRecordId'->>'value' vendor FROM catalog.identity_observation WHERE evidence_id=$1`, [unrelated.evidenceId])).rows;
  expect(members.map((row) => row.vendor)).toEqual(['browser-residual-unrelated-B']);
  const chronology = (await owner.query(`SELECT e.collected_at>q.recorded_at AS proof_after_tombstone,
    o.collected_at<q.recorded_at AS old_observation_before_tombstone,o.evidence_id AS old_evidence_id,e.id AS submitted_proof
    FROM catalog.identity_evidence e,catalog.identity_observation o,catalog.source_identity_request q
    WHERE e.id=$1 AND o.id=$2 AND q.source_record_id=$3 AND q.record_revision=8`, [unrelated.evidenceId, oldObservation.id, recordId])).rows[0];
  expect(chronology).toMatchObject({ proof_after_tombstone: true, old_observation_before_tombstone: true,
    old_evidence_id: CAPTURE_A2, submitted_proof: unrelated.evidenceId });
  await page.reload();
  await record.getByLabel('身份操作').selectOption('reverify'); await record.getByLabel('新证明').selectOption(unrelated.evidenceId);
  await record.getByLabel('复核合同').selectOption(CONTRACT_A); await record.getByLabel('复核观测').selectOption(oldObservation.id);
  await record.getByLabel('复核理由').fill('N1A-residual-R2-B-proof-plus-old-A-observation');
  const beforeRejected = await scopedIdentityState();
  const rejectedHttp = await submitHttpAction(page, 'N1A-residual-R2-B-proof-plus-old-A-observation', () => record.getByRole('button', { name: '保存身份状态', exact: true }).click());
  expect(rejectedHttp.result).toEqual({ status: 'conflict', code: 'IDENTITY_PROOF_COVERAGE_REQUIRED' });
  await expect(page.getByRole('status')).toContainText('新证明未覆盖本次复核观测');
  await expect(record.getByTestId('source-record-revision')).toHaveText('8'); await expect(record).toContainText('身份已撤销');
  const afterRejected = await scopedIdentityState(); expect(afterRejected).toEqual(beforeRejected); expect(await recordHead(recordId)).toEqual(tombstone);
  const actualA = await importRepairProof('residual-genuinely-observed-A-after-tombstone', 8);
  const actualMembers = (await owner.query(`SELECT id,evidence_id,fields->'vendorRecordId'->>'value' vendor FROM catalog.identity_observation WHERE evidence_id=$1`, [actualA.evidenceId])).rows;
  expect(actualMembers).toEqual([{ id: actualA.observationId, evidence_id: actualA.evidenceId, vendor: 'fixture-vendor-001' }]);
  await page.reload();
  await record.getByLabel('身份操作').selectOption('reverify'); await record.getByLabel('新证明').selectOption(actualA.evidenceId);
  await record.getByLabel('复核合同').selectOption(CONTRACT_A); await record.getByLabel('复核观测').selectOption(actualA.observationId);
  await record.getByLabel('复核理由').fill('N1A-residual-R2-A-proof-with-actual-A-member');
  const restoredHttp = await submitHttpAction(page, 'N1A-residual-R2-A-proof-with-actual-A-member', () => record.getByRole('button', { name: '保存身份状态', exact: true }).click());
  expect(restoredHttp.result).toMatchObject({ status: 'success', data: { recordId, revision: 9, state: 'active', claimId: initial.active_claim_id, relationshipUsable: false } });
  await expect(record.getByTestId('source-record-revision')).toHaveText('9'); await expect(record).toContainText('已核实（fixture）');
  const finalHead = await recordHead(recordId), finalHistory = (await owner.query('SELECT * FROM catalog.source_identity_request WHERE source_record_id=$1 ORDER BY record_revision', [recordId])).rows;
  expect(finalHead).toMatchObject({ id: recordId, revision: 9, state: 'active', active_claim_id: initial.active_claim_id });
  expect(finalHistory).toHaveLength(9); expect(finalHistory.slice(0, 7)).toEqual(historyBefore);
  expect((await owner.query('SELECT id FROM catalog.identity_claim WHERE record_id=$1', [recordId])).rows.map((row) => row.id)).toEqual([initial.active_claim_id]);
  expect(await publicRows()).toEqual(publicBefore); expect(await frozenState()).toEqual(frozenBefore);
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]); expect(outside).toEqual([]);
  save('browser-residual-r2-proof-coverage.json', { recordId, initial, revokeHttp, tombstone, oldObservation, unrelated, members, chronology,
    beforeRejected, rejectedHttp, afterRejected, actualA, actualMembers, restoredHttp, finalHead, finalHistory,
    unrelatedProofRejectedWithoutHeadAdvance: true, realIdentityVerifiedCount: 0, relationshipUsable: false });
});

test('残余R3：冻结原仓known冲突真实拒绝，原人工选择和历史保持可见', async ({ page, context }) => {
  await guard(context); const publicBefore = await publicRows(), frozenBefore = await frozenState();
  const selected = (await owner.query(`SELECT to_jsonb(fo) frozen,d.id AS decision_id,d.selected_item_id
    FROM catalog.source_observation fo JOIN catalog.decision_evidence d ON d.observation_id=fo.id
    JOIN catalog.observation_batch b ON b.id=fo.batch_id JOIN catalog.source_dataset ds ON ds.id=b.dataset_id
    JOIN catalog.source_namespace ns ON ns.id=ds.namespace_id
    WHERE ns.system='bigseller' AND d.entry_kind='candidate_snapshot' AND d.selected_item_id IS NOT NULL
      AND fo.scope->'warehouse'->>'state'='known' AND fo.fields->'sku'->>'meaning'='value' AND fo.fields->'name'->>'meaning'='value'
      AND NOT EXISTS(SELECT 1 FROM catalog.observation_record_link l WHERE l.observation_key='frozen:'||fo.id::text)
    ORDER BY fo.entry_key LIMIT 1`)).rows[0];
  expect(selected).toBeTruthy(); const frozen = selected.frozen;
  const decisionsBefore = (await owner.query('SELECT * FROM catalog.decision_evidence WHERE observation_id=$1 ORDER BY id', [frozen.id])).rows;
  const scope = await bootstrapResidualWarehouseScope('BROWSER-RESIDUAL-W1');
  expect(frozen.scope.warehouse.canonical).not.toBe(scope.warehouse);
  const support = await importRepairProof('residual-W1-support-cannot-override-frozen-W2', 0, { scopeId: scope.scopeId, contractId: scope.contractId,
    warehouse: scope.warehouse, values: { vendorRecordId: 'browser-residual-frozen-support', sku: frozen.fields.sku.raw,
      name: frozen.fields.name.raw, barcode: frozen.fields.barcode?.meaning === 'value' ? frozen.fields.barcode.raw : '' } });
  await login(page); await page.goto(`/dashboard/catalog/sources?scope=${scope.scopeId}`);
  const article = page.getByTestId(`identity-observation-${support.observationId}`);
  await article.getByLabel('核实证明').selectOption(scope.proofId); await article.getByLabel('登记理由').fill('N1A-residual-R3-register-actual-W1-support');
  const registerHttp = await submitHttpAction(page, 'N1A-residual-R3-register-actual-W1-support', () => article.getByRole('button', { name: '核实来源身份', exact: true }).click());
  expect(registerHttp.result).toMatchObject({ status: 'success', data: { revision: 1, state: 'active', relationshipUsable: false } });
  const recordId = registerHttp.result.data?.recordId as string; expect(recordId).toMatch(/^[a-f0-9-]{36}$/);
  await expect(page.getByTestId('source-record-id')).toHaveText(recordId);
  const region = page.getByRole('region', { name: '观测关联', exact: true });
  await region.getByLabel('观测', { exact: true }).selectOption(`frozen:${frozen.id}`);
  await region.getByLabel('已核来源', { exact: true }).selectOption(recordId); await region.getByLabel('关联证明', { exact: true }).selectOption(support.evidenceId);
  await region.getByLabel('关联理由', { exact: true }).fill('N1A-residual-R3-known-frozen-W2-vs-identity-W1');
  const beforeRejected = await scopedIdentityState(scope.scopeId), headBefore = await recordHead(recordId);
  const rejectedHttp = await submitHttpAction(page, 'N1A-residual-R3-known-frozen-W2-vs-identity-W1', () => region.getByRole('button', { name: '保存观测关联', exact: true }).click());
  expect(rejectedHttp.result).toEqual({ status: 'conflict', code: 'IDENTITY_FROZEN_SCOPE_CONTRADICTION' });
  await expect(page.getByRole('status')).toContainText('冻结观测的已知范围与来源身份范围冲突');
  await expect(page.getByRole('status')).toContainText('原人工选择与历史保持');
  await expect(page.getByRole('status')).not.toContainText(scope.warehouse);
  await expect(page.getByRole('status')).not.toContainText(frozen.scope.warehouse.raw);
  await expect(page.getByTestId('identity-link')).toHaveCount(0);
  await expect(page.getByTestId(`identity-record-${recordId}`).getByTestId('source-record-revision')).toHaveText('1');
  const afterRejected = await scopedIdentityState(scope.scopeId); expect(afterRejected).toEqual(beforeRejected); expect(await recordHead(recordId)).toEqual(headBefore);
  expect((await owner.query('SELECT * FROM catalog.observation_record_link WHERE observation_key=$1', [`frozen:${frozen.id}`])).rows).toEqual([]);
  const frozenAfter = (await owner.query('SELECT to_jsonb(fo) frozen FROM catalog.source_observation fo WHERE id=$1', [frozen.id])).rows[0].frozen;
  const decisionsAfter = (await owner.query('SELECT * FROM catalog.decision_evidence WHERE observation_id=$1 ORDER BY id', [frozen.id])).rows;
  expect(frozenAfter).toEqual(frozen); expect(decisionsAfter).toEqual(decisionsBefore);
  await page.goto(`/dashboard/catalog/${selected.selected_item_id}?revision=1`);
  await expect(page.getByTestId('item-uuid')).toHaveText(selected.selected_item_id); await expect(page.getByTestId('revision-history-1')).toBeVisible();
  await page.getByText('查看本商品决定与历史索引', { exact: true }).click();
  const originalHistory = await page.getByRole('region', { name: '差异与决定', exact: true }).locator('details').filter({ hasText: '查看本商品决定与历史索引' }).locator('pre').innerText();
  expect(originalHistory).toContain(selected.decision_id); expect(originalHistory).toContain(frozen.id);
  expect(originalHistory).toContain('manual_selected'); expect(originalHistory).toContain(selected.selected_item_id);
  expect(await publicRows()).toEqual(publicBefore); expect(await frozenState()).toEqual(frozenBefore);
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]); expect(outside).toEqual([]);
  save('browser-residual-r3-frozen-known-scope.json', { scope, support, selected, decisionsBefore, registerHttp, recordId, headBefore,
    beforeRejected, rejectedHttp, afterRejected, frozenAfter, decisionsAfter, originalHistory,
    knownConflictRejectedAndOriginalDecisionHistoryVisible: true, realIdentityVerifiedCount: 0, relationshipUsable: false });
});
