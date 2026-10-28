/**
 * Isolated PostgreSQL acceptance for db/catalog/015_product_source_sync.sql.
 *
 * Runs against a guarded, freshly prepared catalog instance (same chain as
 * catalog.postgres.test.ts): the app-runner URL is used for every authorised
 * call (identity via `request.jwt.claim.sub`), the bootstrap/owner URL only for
 * schema assertions and fixtures. Skipped when P0_02_APP_DATABASE_URL is absent.
 *
 * Every source key / ice code / profile key is suffixed with a per-run token so
 * the same database can be used for a repeated run without snapshot collisions.
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

const ADMIN = '11111111-1111-4111-8111-111111111101';
const OPERATOR = '11111111-1111-4111-8111-111111111104';
const INACTIVE_ADMIN = '11111111-1111-4111-8111-111111111106';
const UNKNOWN = '11111111-1111-4111-8111-111111111199';

const RUN = randomUUID().replace(/[^a-z0-9]/g, '').slice(0, 8);
const CODE_ONE = `WMDB-${RUN}-0001`;
const CODE_TWO = `WMDB-${RUN}-0002`;
const CODE_ROW_ONLY = `WMDB-${RUN}-9003`;
const CODE_ASSIGN = `WMDB-${RUN}-9001`;
const PROFILE_KEY = `feishu.test-db-dbeng.${RUN}.v1`;
const DEFAULT_PROFILE_KEY = 'feishu.ice-product-library.sheet1';

const databaseUrl = process.env.P0_02_APP_DATABASE_URL;
const runRoot = process.env.CATALOG_RUN_ROOT;
const evidenceDir = process.env.CATALOG_PRODUCT_SOURCE_DB_EVIDENCE_DIR
  ?? process.env.CATALOG_TEST_EVIDENCE_DIR
  ?? null;
const instanceFile = runRoot ? path.join(runRoot, 'instance/catalog-instance.json') : null;
const ownerUrl = (() => {
  if (!instanceFile || !fs.existsSync(instanceFile)) return null;
  const instance = JSON.parse(fs.readFileSync(instanceFile, 'utf8')) as {
    bootstrapUser: string; bootstrapPassword: string; host: string; port: number; dbName: string;
  };
  return `postgres://${instance.bootstrapUser}:${instance.bootstrapPassword}@${instance.host}:${instance.port}/${instance.dbName}`;
})();

const app = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 2 }) : null;
const owner = ownerUrl ? new Pool({ connectionString: ownerUrl, max: 2 }) : null;
const sha = (label: string) => createHash('sha256').update(label).digest('hex');
const receipt = (name: string, value: unknown) => {
  if (!evidenceDir) return;
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, name), `${JSON.stringify(value, null, 2)}\n`);
};
const iso = (value: string) => new Date(value).toISOString();

type Json = Record<string, unknown>;
const PRICE = { cost: '5.18', operating: '5.68', shipping: '0.5', secondCost: '9.99', secondOperating: '10.99' };

const profile = (profileKey = PROFILE_KEY): Json => ({
  profileKey,
  documentKey: 'TEST-WIKI-NODE',
  spreadsheetToken: null,
  sheetId: null,
  sheetName: 'Sheet1',
  displayName: 'ICE产品库（隔离测试）',
  sourceUrl: 'https://example.invalid/wiki/ice-product-library',
  acquisitionMode: 'local_snapshot',
});

const field = (raw: string, ref: string): Json => ({
  state: 'observed',
  raw,
  meaning: raw === '' ? 'explicit_empty' : 'value',
  evidenceRef: `test:${ref}`,
});

interface RowInput { rowNumber: number; isBusinessRow: boolean; iceCode: string | null; cells: Record<string, string> }
const row = (rowNumber: number, isBusinessRow: boolean, iceCode: string | null, cells: Record<string, string>): RowInput => ({
  rowNumber, isBusinessRow, iceCode, cells,
});

/** Observed run-1 column order: price labels sit on I/J/Y. */
const HEADERS_RUN1: Record<string, string> = {
  A: '日期', B: '中文产品名称', G: '聚水潭内部货号',
  I: '成本价格', J: '运营价格', Y: '单品运费（自由计算列）',
};
/** Re-ordered worksheet: price labels moved to AB/AC/AD, I/J/Y hold ordinary text. */
const HEADERS_REORDERED: Record<string, string> = {
  A: '日期', B: '中文产品名称', G: '聚水潭内部货号',
  I: '普通文本列', J: '普通文本列', Y: '普通文本列',
  AB: '成本价格', AC: '运营价格', AD: '单品运费（自由计算列）',
};

const collection = (businessRows: number, emptyRows: number, headers: Record<string, string> = HEADERS_RUN1): Json => ({
  method: 'mock_reader',
  url: 'https://example.invalid/wiki/ice-product-library',
  worksheetTitle: 'Sheet1',
  headerRow: 1,
  requestedRange: 'A1:AE404',
  observedRange: 'A1:AE404',
  gridRows: businessRows + emptyRows + 1,
  gridColumns: 31,
  businessRowCount: businessRows,
  emptyRowCount: emptyRows,
  complete: true,
  headers,
  rawEvidenceSha256: null,
  rawEvidenceBytes: null,
  truncated: false,
  readError: null,
});

function batchPayload(
  label: string,
  capturedAt: string,
  rows: RowInput[],
  amounts: { rowNumber: number; payload: Json }[],
  origin = 'local_simulation',
  headers: Record<string, string> = HEADERS_RUN1,
  retryOfBatchId: string | null = null,
): Json {
  return {
    snapshotKey: sha(`snapshot:${RUN}:${label}`),
    origin,
    capturedAt,
    sourceModifiedLabel: '最新修改时间为10月20日',
    collection: collection(rows.filter((entry) => entry.isBusinessRow).length, rows.filter((entry) => !entry.isBusinessRow).length, headers),
    rowsSha256: sha(`rows:${RUN}:${label}`),
    adoptionSha256: sha(`adoption:${RUN}:${label}`),
    parentBatchId: null,
    retryOfBatchId,
    simulationNote: origin === 'local_simulation' ? '本地模拟变化，非飞书真实修改' : null,
    artifacts: [
      { logicalName: 'source-snapshot.json', sha256: sha(`artifact:snapshot:${RUN}:${label}`), size: 4096, format: 'json', storageHandle: `memory://snapshot/${RUN}/${label}`, role: 'snapshot' },
      { logicalName: 'capture.raw.tsv', sha256: sha(`artifact:raw:${RUN}:${label}`), size: 2048, format: 'tsv', storageHandle: `memory://raw/${RUN}/${label}`, role: 'raw_capture' },
    ],
    rows: rows.map((entry) => ({ ...entry, rowSha256: sha(`row:${RUN}:${label}:${entry.rowNumber}`) })),
    amounts,
  };
}

const baseRows = (): RowInput[] => [
  row(2, true, CODE_ONE, { A: '2026-10-20', B: '测试产品一', G: CODE_ONE, H: '0690000000001', I: PRICE.cost, J: PRICE.operating, P: '12', Y: PRICE.shipping }),
  row(3, true, CODE_TWO, { B: '测试产品二', G: CODE_TWO, I: PRICE.secondCost, J: PRICE.secondOperating, P: '6' }),
  row(4, true, CODE_ROW_ONLY, { B: '测试待补号商品', G: CODE_ROW_ONLY }),
  row(5, false, null, {}),
];
const baseAmounts = [
  { rowNumber: 2, payload: { costPrice: PRICE.cost, operatingPrice: PRICE.operating, shippingPrice: PRICE.shipping } },
  { rowNumber: 3, payload: { costPrice: PRICE.secondCost, operatingPrice: PRICE.secondOperating } },
];

const planBase = (results: Json[], seenItemIds: string[] = []): Json => ({
  countsHint: { created: 0, updated: 0, unchanged: 0, needsReview: 0, failed: 0, missing: 0 },
  results,
  seenItemIds,
  batchStatusHint: 'applied',
});

const createResult = (code: string, name: string, carton: string, rowNumber: number): Json => ({
  sourceKey: `code:${code}`,
  iceCode: code,
  itemId: null,
  action: 'create',
  reasonCode: 'NEW_ITEM_CREATED',
  reasonText: '来源新建商品',
  rowNumbers: [rowNumber],
  expectedRevision: null,
  changes: [{ fieldKey: 'nameCn', beforeRaw: null, afterRaw: name, kind: 'initial_baseline' }],
  adoptions: [
    { fieldKey: 'nameCn', raw: name, state: 'observed', unitState: 'not_applicable' },
    { fieldKey: 'cartonQuantity', raw: carton, state: 'observed', unitState: 'confirmed' },
  ],
  nextFields: { nameCn: field(name, 'nameCn'), cartonQuantity: field(carton, 'cartonQuantity') },
  nameCn: name,
  createCode: code,
  issues: [],
  missing: false,
});

const unchangedResult = (itemId: string, code: string, name: string, rowNumber: number): Json => ({
  sourceKey: `code:${code}`,
  iceCode: code,
  itemId,
  action: 'unchanged',
  reasonCode: 'SOURCE_UNCHANGED',
  reasonText: '来源与当前一致，无修订',
  rowNumbers: [rowNumber],
  expectedRevision: null,
  changes: [],
  adoptions: [{ fieldKey: 'nameCn', raw: name, state: 'observed', unitState: 'not_applicable' }],
  nextFields: null,
  nameCn: name,
  createCode: null,
  issues: [],
  missing: false,
});

async function tx<T>(identity: string | null, fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
  if (!app) throw new Error('P0_02_APP_DATABASE_URL is required');
  const client = await app.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`, [identity ?? '']);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const applyBatch = (requestId: string, profileInput: Json, batch: Json, plan: Json, intentLabel = 'apply') => tx(ADMIN, async (client) => {
  const intent = sha(`${requestId}:${intentLabel}`);
  const response = await client.query('SELECT catalog.apply_product_source_batch($1,$2,$3::jsonb,$4::jsonb,$5::jsonb) AS result', [
    requestId, intent, JSON.stringify(profileInput), JSON.stringify(batch), JSON.stringify(plan),
  ]);
  return { result: response.rows[0].result as Json, intent };
});

const overview = async () => tx(ADMIN, async (client) => (await client.query('SELECT catalog.read_product_source_overview($1) AS result', [PROFILE_KEY])).rows[0].result as Json);
const itemState = async (itemId: string) => tx(ADMIN, async (client) => (await client.query('SELECT catalog.read_product_source_item_state($1) AS result', [itemId])).rows[0].result as Json);
const ownerQuery = async (sql: string, parameters: unknown[] = []) => {
  if (!owner) throw new Error('owner connection is required for this assertion');
  return owner.query(sql, parameters);
};

let itemOne = '';
let itemTwo = '';
let requestA = '';
const batches: Record<string, Json> = {};
const applied: Record<string, Json> = {};

describe.sequential('product source database increment 015', () => {
  afterAll(async () => {
    await Promise.all(([app, owner].filter(Boolean) as Pool[]).map((pool) => pool.end()));
  });

  it('installs the new tables with FORCE RLS, admin-only policies, immutable histories and no runtime DML', async () => {
    const tables = ['product_source_profile', 'product_source_batch', 'product_source_row', 'product_source_binding',
      'product_source_adoption', 'product_source_result', 'product_source_issue', 'product_source_request'];
    const rows = (await ownerQuery(
      `SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner) AS owner,
        (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='enabled_admin') AS policies
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='catalog' AND c.relkind='r' AND c.relname = ANY($1::text[]) ORDER BY c.relname`, [tables],
    )).rows;
    expect(rows.map((entry) => entry.relname)).toEqual([...tables].sort());
    for (const entry of rows) {
      expect(entry.relrowsecurity).toBe(true);
      expect(entry.relforcerowsecurity).toBe(true);
      expect(entry.policies).toBe(1);
      expect(entry.owner).toBe('ice_p0_02_owner');
    }
    const privateTable = (await ownerQuery(
      `SELECT c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner) AS owner
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='catalog_private' AND c.relname='product_source_row_amounts'`,
    )).rows[0];
    expect(privateTable).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true, owner: 'ice_p0_02_owner' });
    const functions = (await ownerQuery(
      `SELECT p.proname,p.prosecdef,p.proconfig,pg_get_function_identity_arguments(p.oid) AS args,
        has_function_privilege('ice_p0_02_app_runner',p.oid,'EXECUTE') AS runner
       FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='catalog' AND p.proname IN('apply_product_source_batch','resolve_product_source_issue',
        'assign_product_source_code','read_product_source_overview','read_product_source_item_state')
       ORDER BY p.proname`, [],
    )).rows;
    expect(functions).toHaveLength(5);
    for (const entry of functions) {
      expect(entry.prosecdef).toBe(true);
      expect(entry.runner).toBe(true);
      expect(JSON.stringify(entry.proconfig)).toMatch(/search_path=/);
    }
    const triggers = (await ownerQuery(
      `SELECT DISTINCT c.relname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
       JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE NOT t.tgisinternal AND n.nspname IN('catalog','catalog_private')
        AND c.relname IN('product_source_row','product_source_result','product_source_request',
         'product_source_row_amounts','product_source_batch') ORDER BY c.relname`, [],
    )).rows.map((entry) => entry.relname);
    expect(triggers).toEqual(expect.arrayContaining([
      'product_source_batch', 'product_source_request', 'product_source_result', 'product_source_row', 'product_source_row_amounts',
    ]));
    // Runtime role: no DML on the new tables, no access to the private price table.
    await expect(tx(ADMIN, (client) => client.query(
      'INSERT INTO catalog.product_source_row(batch_id,row_number) VALUES($1,1)', [randomUUID()],
    ))).rejects.toMatchObject({ code: '42501' });
    await expect(tx(ADMIN, (client) => client.query('SELECT * FROM catalog_private.product_source_row_amounts'))).rejects.toMatchObject({ code: '42501' });
    // RLS hides rows from non-admin identities even though SELECT is granted.
    expect(await tx(OPERATOR, async (client) => (await client.query('SELECT count(*)::int AS n FROM catalog.product_source_batch')).rows[0].n)).toBe(0);
    receipt('product-source-015-schema.json', { tables: rows, privateTable, functions, triggers, runtimeDmlDenied: true });
  });

  it('rejects unknown, operator and inactive identities on every new entry point', async () => {
    const batch = batchPayload('A', '2026-10-25T04:00:00Z', baseRows(), baseAmounts, 'real_capture');
    const plan = planBase([]);
    for (const actor of [null, OPERATOR, INACTIVE_ADMIN, UNKNOWN]) {
      await expect(tx(actor, (client) => client.query(
        'SELECT catalog.apply_product_source_batch($1,$2,$3::jsonb,$4::jsonb,$5::jsonb)',
        [randomUUID(), sha('denied'), JSON.stringify(profile()), JSON.stringify(batch), JSON.stringify(plan)],
      ))).rejects.toMatchObject({ code: '42501' });
      await expect(tx(actor, (client) => client.query('SELECT catalog.read_product_source_overview($1)', [PROFILE_KEY]))).rejects.toMatchObject({ code: '42501' });
      await expect(tx(actor, (client) => client.query('SELECT catalog.read_product_source_item_state($1)', [randomUUID()]))).rejects.toMatchObject({ code: '42501' });
      await expect(tx(actor, (client) => client.query(
        'SELECT catalog.resolve_product_source_issue($1,$2,$3,$4,$5)', [randomUUID(), sha('denied'), randomUUID(), 'resolved', 'x'],
      ))).rejects.toMatchObject({ code: '42501' });
      await expect(tx(actor, (client) => client.query(
        'SELECT catalog.assign_product_source_code($1,$2,$3,$4,$5,$6,$7)', [randomUUID(), sha('denied'), randomUUID(), 1, 'X', 'y', 'z'],
      ))).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('creates new items once, keeps worksheet price columns out of every public read and links revision/current/binding/adoption', async () => {
    const requestId = randomUUID();
    requestA = requestId;
    batches.A = batchPayload('A', '2026-10-25T04:00:00Z', baseRows(), baseAmounts, 'real_capture');
    const plan = planBase([
      { ...createResult(CODE_ONE, '测试产品一', '12', 2), issues: [{ kind: 'unit_unconfirmed', detail: { fieldKeys: ['cartonLength', 'cartonWeight'] } }] },
      createResult(CODE_TWO, '测试产品二', '6', 3),
    ]);
    const { result } = await applyBatch(requestId, profile(), batches.A, plan);
    applied.A = result;
    expect(result).toMatchObject({ status: 'applied', snapshotKey: batches.A.snapshotKey });
    expect(result.counts).toMatchObject({ created: 2, updated: 0, unchanged: 0, needsReview: 0, failed: 0, missing: 0 });

    const items = (await ownerQuery(
      `SELECT i.id,c.ice_code,r.revision,r.name_cn,r.fields,ic.revision AS current_revision
       FROM catalog.catalog_item i JOIN catalog.catalog_item_code c ON c.item_id=i.id
       JOIN catalog.item_revision r ON r.item_id=i.id JOIN catalog.item_current ic ON ic.item_id=i.id
       WHERE c.ice_code = ANY($1::text[]) ORDER BY c.ice_code`, [[CODE_ONE, CODE_TWO]],
    )).rows;
    expect(items).toHaveLength(2);
    itemOne = items[0].id; itemTwo = items[1].id;
    expect(items[0]).toMatchObject({ ice_code: CODE_ONE, revision: 1, current_revision: 1, name_cn: '测试产品一' });
    expect(items[0].fields.cartonQuantity.raw).toBe('12');
    expect(items[0].fields.nameCn.raw).toBe('测试产品一');
    expect(items[1].fields.cartonQuantity.raw).toBe('6');
    const revisions = (await ownerQuery('SELECT item_id,revision,previous_revision FROM catalog.item_revision WHERE item_id = ANY($1::uuid[]) ORDER BY item_id,revision', [[itemOne, itemTwo]])).rows;
    expect(revisions).toHaveLength(2);
    for (const entry of revisions) expect(entry).toMatchObject({ revision: 1, previous_revision: null });
    const profileId = (await ownerQuery('SELECT id FROM catalog.product_source_profile WHERE profile_key=$1', [PROFILE_KEY])).rows[0].id as string;
    const bindings = (await ownerQuery('SELECT item_id,ice_code,state FROM catalog.product_source_binding WHERE profile_id=$1 ORDER BY ice_code', [profileId])).rows;
    expect(bindings).toEqual([
      expect.objectContaining({ item_id: itemOne, ice_code: CODE_ONE, state: 'active' }),
      expect.objectContaining({ item_id: itemTwo, ice_code: CODE_TWO, state: 'active' }),
    ]);
    const adoptions = (await ownerQuery('SELECT field_key,adopted_raw,adopted_state,unit_state FROM catalog.product_source_adoption WHERE item_id=$1 ORDER BY field_key', [itemOne])).rows;
    expect(adoptions).toEqual([
      expect.objectContaining({ field_key: 'cartonQuantity', adopted_raw: '12', adopted_state: 'observed', unit_state: 'confirmed' }),
      expect.objectContaining({ field_key: 'nameCn', adopted_raw: '测试产品一', adopted_state: 'observed', unit_state: 'not_applicable' }),
    ]);

    // Price evidence exists only in the private table; the public row never stores I/J/Y.
    const amounts = (await ownerQuery(
      `SELECT r.row_number,a.payload FROM catalog_private.product_source_row_amounts a
       JOIN catalog.product_source_row r ON r.id=a.row_id
       JOIN catalog.product_source_batch b ON b.id=r.batch_id WHERE b.snapshot_key=$1 ORDER BY r.row_number`,
      [batches.A.snapshotKey],
    )).rows;
    expect(amounts.find((entry) => entry.row_number === 2)!.payload).toEqual({
      costPrice: PRICE.cost, operatingPrice: PRICE.operating, shippingPrice: PRICE.shipping,
    });
    expect(amounts.find((entry) => entry.row_number === 3)!.payload).toEqual({
      costPrice: PRICE.secondCost, operatingPrice: PRICE.secondOperating,
    });
    // Public cells of the price columns are removed by header text, not by column letter.
    const publicCells = (await ownerQuery(
      `SELECT r.row_number,r.cells FROM catalog.product_source_row r JOIN catalog.product_source_batch b ON b.id=r.batch_id
       WHERE b.snapshot_key=$1 ORDER BY r.row_number`, [batches.A.snapshotKey],
    )).rows;
    for (const entry of publicCells) {
      expect(Object.keys(entry.cells)).not.toEqual(expect.arrayContaining(['I', 'J', 'Y']));
      expect(JSON.stringify(entry.cells)).not.toMatch(/"5\.18"|"5\.68"|"0\.5"|"9\.99"|"10\.99"/);
    }
    const firstRow = publicCells.find((entry) => entry.row_number === 2)!;
    expect(firstRow.cells).toMatchObject({ B: '测试产品一', G: CODE_ONE, P: '12' });

    // Every read projection is price-free.
    const over = await overview();
    const state = await itemState(itemOne);
    for (const payload of [over, state, result]) {
      const text = JSON.stringify(payload);
      for (const price of Object.values(PRICE)) expect(text).not.toContain(`"${price}"`);
    }
    expect(over.source).toMatchObject({ profileKey: PROFILE_KEY, sheetName: 'Sheet1', acquisitionMode: 'local_snapshot' });
    expect(over.latest).toMatchObject({ snapshotKey: batches.A.snapshotKey, status: 'applied', origin: 'real_capture' });
    // A create-time review issue must point at the newly created item, not at a null uuid.
    const createIssue = (await ownerQuery(
      `SELECT i.item_id,i.issue_kind,i.source_key FROM catalog.product_source_issue i
       JOIN catalog.product_source_batch b ON b.id=i.batch_id WHERE b.snapshot_key=$1 AND i.issue_kind='unit_unconfirmed'`,
      [batches.A.snapshotKey],
    )).rows;
    expect(createIssue).toEqual([{ item_id: itemOne, issue_kind: 'unit_unconfirmed', source_key: `code:${CODE_ONE}` }]);
    const openIssue = (over.issues as Json[]).find((entry) => entry.kind === 'unit_unconfirmed')!;
    expect(openIssue).toMatchObject({ iceCode: CODE_ONE, nameCn: '测试产品一', reviewState: 'open', sourceKey: `code:${CODE_ONE}` });
    expect(openIssue.rows).toEqual([2]);
    expect((over.latest as Json).collection).toMatchObject({ complete: true, businessRowCount: 3 });
    expect((over.results as Json[])).toHaveLength(2);
    expect((over.results as Json[]).map((entry) => entry.action)).toEqual(['create', 'create']);
    expect(over.bindingCount).toBe(2);
    expect(over.batches).toHaveLength(1);
    expect(state).toMatchObject({ itemId: itemOne, iceCode: CODE_ONE });
    expect(state.binding).toMatchObject({ iceCode: CODE_ONE, state: 'active' });
    expect((state.adoptions as Json).cartonQuantity).toEqual({ raw: '12', unitState: 'confirmed' });
    receipt('product-source-015-create.json', { requestId, receipt: result, itemOne, itemTwo, amounts, firstRow, overview: over, itemState: state });
  });

  it('returns the stored receipt for the same request and the stored results for the same snapshot', async () => {
    const replay = await applyBatch(requestA, profile(), batches.A, planBase([
      createResult(CODE_ONE, '测试产品一', '12', 2), createResult(CODE_TWO, '测试产品二', '6', 3),
    ]));
    expect(replay.result).toEqual(applied.A);
    await expect(tx(ADMIN, (client) => client.query(
      'SELECT catalog.apply_product_source_batch($1,$2,$3::jsonb,$4::jsonb,$5::jsonb)',
      [requestA, sha('different-intent'), JSON.stringify(profile()), JSON.stringify(batches.A), JSON.stringify(planBase([]))],
    ))).rejects.toMatchObject({ code: '23505' });

    const before = (await ownerQuery('SELECT count(*)::int AS items FROM catalog.catalog_item'))!.rows[0].items;
    const duplicate = await applyBatch(randomUUID(), profile(), batches.A, planBase([]));
    expect(duplicate.result).toMatchObject({ status: 'duplicate', originalStatus: 'applied', snapshotKey: batches.A.snapshotKey });
    expect(duplicate.result.counts).toMatchObject({ created: 2, failed: 0, needsReview: 0, missing: 0 });
    expect(duplicate.result.results).toHaveLength(2);
    expect((await ownerQuery('SELECT count(*)::int AS items FROM catalog.catalog_item'))!.rows[0].items).toBe(before);
  });

  it('writes one adopted revision for an update and keeps item_current aligned with item_revision', async () => {
    const requestId = randomUUID();
    batches.B = batchPayload('B', '2026-10-25T04:10:00Z', baseRows(), baseAmounts);
    const { result } = await applyBatch(requestId, profile(), batches.B, planBase([
      {
        sourceKey: `code:${CODE_ONE}`, iceCode: CODE_ONE, itemId: itemOne, action: 'update',
        reasonCode: 'SOURCE_FIELD_UPDATE', reasonText: '来源资料采用', rowNumbers: [2], expectedRevision: 1,
        changes: [{ fieldKey: 'cartonQuantity', beforeRaw: '12', afterRaw: '24', kind: 'update' }],
        adoptions: [
          { fieldKey: 'nameCn', raw: '测试产品一', state: 'observed', unitState: 'not_applicable' },
          { fieldKey: 'cartonQuantity', raw: '24', state: 'observed', unitState: 'confirmed' },
        ],
        nextFields: { nameCn: field('测试产品一', 'nameCn'), cartonQuantity: field('24', 'cartonQuantity') },
        nameCn: '测试产品一', createCode: null, issues: [], missing: false,
      },
      unchangedResult(itemTwo, CODE_TWO, '测试产品二', 3),
    ]));
    applied.B = result;
    expect(result).toMatchObject({ status: 'applied' });
    expect(result.counts).toMatchObject({ updated: 1, unchanged: 1, failed: 0 });
    const current = (await ownerQuery('SELECT revision FROM catalog.item_current WHERE item_id=$1', [itemOne])).rows[0];
    expect(current.revision).toBe(2);
    const history = (await ownerQuery('SELECT revision,previous_revision,name_cn,fields,reason FROM catalog.item_revision WHERE item_id=$1 ORDER BY revision', [itemOne])).rows;
    expect(history.map((entry) => [entry.revision, entry.previous_revision])).toEqual([[1, null], [2, 1]]);
    expect(history[1]).toMatchObject({ name_cn: '测试产品一', reason: '来源资料采用' });
    expect(history[1].fields.cartonQuantity.raw).toBe('24');
    expect(history[0].fields.cartonQuantity.raw).toBe('12');
    const adoption = (await ownerQuery('SELECT adopted_raw,unit_state FROM catalog.product_source_adoption WHERE item_id=$1 AND field_key=$2', [itemOne, 'cartonQuantity'])).rows[0];
    expect(adoption).toMatchObject({ adopted_raw: '24', unit_state: 'confirmed' });
    const binding = (await ownerQuery('SELECT state,last_seen_batch_id FROM catalog.product_source_binding WHERE item_id=$1', [itemOne])).rows[0];
    const batchRow = (await ownerQuery('SELECT id FROM catalog.product_source_batch WHERE snapshot_key=$1', [batches.B.snapshotKey])).rows[0];
    expect(binding).toEqual(expect.objectContaining({ state: 'active', last_seen_batch_id: batchRow.id }));
  });

  it('records a stale revision as a failed item while the rest of the batch still commits', async () => {
    const requestId = randomUUID();
    batches.C = batchPayload('C', '2026-10-25T04:20:00Z', baseRows(), []);
    const { result } = await applyBatch(requestId, profile(), batches.C, planBase([
      {
        sourceKey: `code:${CODE_ONE}`, iceCode: CODE_ONE, itemId: itemOne, action: 'update',
        reasonCode: 'SOURCE_FIELD_UPDATE', reasonText: '来源资料采用', rowNumbers: [2], expectedRevision: 1,
        changes: [{ fieldKey: 'cartonQuantity', beforeRaw: '24', afterRaw: '36', kind: 'update' }],
        adoptions: [], nextFields: { cartonQuantity: field('36', 'cartonQuantity') },
        nameCn: '测试产品一', createCode: null, issues: [], missing: false,
      },
      {
        sourceKey: `code:${CODE_TWO}`, iceCode: CODE_TWO, itemId: itemTwo, action: 'update',
        reasonCode: 'SOURCE_FIELD_UPDATE', reasonText: '来源资料采用', rowNumbers: [3], expectedRevision: 1,
        changes: [{ fieldKey: 'nameCn', beforeRaw: '测试产品二', afterRaw: '测试产品二改名', kind: 'update' }],
        adoptions: [{ fieldKey: 'nameCn', raw: '测试产品二改名', state: 'observed', unitState: 'not_applicable' }],
        nextFields: { nameCn: field('测试产品二改名', 'nameCn') },
        nameCn: '测试产品二改名', createCode: null, issues: [], missing: false,
      },
    ]));
    applied.C = result;
    expect(result).toMatchObject({ status: 'partial' });
    expect(result.counts).toMatchObject({ updated: 1, failed: 1, needsReview: 0 });
    const byKey = Object.fromEntries((result.results as Json[]).map((entry) => [entry.sourceKey, entry]));
    expect(byKey[`code:${CODE_ONE}`]).toMatchObject({ action: 'failed', reasonCode: 'CATALOG_REVISION_CONFLICT' });
    expect(byKey[`code:${CODE_TWO}`]).toMatchObject({ action: 'update', itemRevision: 2 });
    const one = (await ownerQuery('SELECT revision FROM catalog.item_current WHERE item_id=$1', [itemOne])).rows[0];
    expect(one.revision).toBe(2);
    const oneFields = (await ownerQuery('SELECT fields FROM catalog.item_revision WHERE item_id=$1 AND revision=2', [itemOne])).rows[0];
    expect(oneFields.fields.cartonQuantity.raw).toBe('24');
    const two = (await ownerQuery('SELECT ic.revision,v.name_cn FROM catalog.item_current ic JOIN catalog.item_revision v ON v.item_id=ic.item_id AND v.revision=ic.revision WHERE ic.item_id=$1', [itemTwo])).rows[0];
    expect(two).toEqual({ revision: 2, name_cn: '测试产品二改名' });
    const issue = (await ownerQuery(
      `SELECT i.issue_kind,i.review_state,i.item_id FROM catalog.product_source_issue i
       JOIN catalog.product_source_batch b ON b.id=i.batch_id WHERE b.snapshot_key=$1 ORDER BY i.issue_kind`,
      [batches.C.snapshotKey],
    )).rows;
    expect(issue).toEqual([expect.objectContaining({ issue_kind: 'CATALOG_REVISION_CONFLICT', review_state: 'open', item_id: itemOne })]);
    receipt('product-source-015-revision-conflict.json', { result, one, two, issue });
  });

  it('records a stale plan as failed without overwriting local fields', async () => {
    const requestId = randomUUID();
    batches.D = batchPayload('D', '2026-10-25T04:30:00Z', baseRows(), []);
    const { result } = await applyBatch(requestId, profile(), batches.D, planBase([
      unchangedResult(itemOne, CODE_ONE, '测试产品一', 2),
      {
        sourceKey: `code:${CODE_TWO}`, iceCode: CODE_TWO, itemId: itemTwo, action: 'update',
        reasonCode: 'SOURCE_FIELD_UPDATE', reasonText: '来源资料采用', rowNumbers: [3], expectedRevision: 2,
        changes: [{ fieldKey: 'nameCn', beforeRaw: '本地已被别人改过', afterRaw: '测试产品二再改名', kind: 'update' }],
        adoptions: [], nextFields: { nameCn: field('测试产品二再改名', 'nameCn') },
        nameCn: '测试产品二再改名', createCode: null, issues: [], missing: false,
      },
    ]));
    applied.D = result;
    expect(result).toMatchObject({ status: 'partial' });
    const byKey = Object.fromEntries((result.results as Json[]).map((entry) => [entry.sourceKey, entry]));
    expect(byKey[`code:${CODE_TWO}`]).toMatchObject({ action: 'failed', reasonCode: 'CATALOG_PLAN_STALE' });
    const two = (await ownerQuery('SELECT ic.revision,v.name_cn FROM catalog.item_current ic JOIN catalog.item_revision v ON v.item_id=ic.item_id AND v.revision=ic.revision WHERE ic.item_id=$1', [itemTwo])).rows[0];
    expect(two).toEqual({ revision: 2, name_cn: '测试产品二改名' });
  });

  it('rejects a snapshot older than the latest applied batch as rejected_stale without product writes', async () => {
    const requestId = randomUUID();
    batches.E = batchPayload('E', '2026-10-25T03:00:00Z', baseRows(), baseAmounts);
    const before = (await ownerQuery('SELECT revision FROM catalog.item_current WHERE item_id=ANY($1::uuid[]) ORDER BY item_id', [[itemOne, itemTwo]])).rows;
    const { result } = await applyBatch(requestId, profile(), batches.E, planBase([
      {
        sourceKey: `code:${CODE_ONE}`, iceCode: CODE_ONE, itemId: itemOne, action: 'update',
        reasonCode: 'SOURCE_FIELD_UPDATE', reasonText: '来源资料采用', rowNumbers: [2], expectedRevision: 1,
        changes: [], adoptions: [], nextFields: { cartonQuantity: field('999', 'cartonQuantity') },
        nameCn: '测试产品一', createCode: null, issues: [], missing: false,
      },
    ]));
    applied.E = result;
    expect(result).toMatchObject({ status: 'rejected_stale' });
    expect(String(result.message)).toContain('早于');
    const stored = (await ownerQuery('SELECT status,counts,release_id FROM catalog.product_source_batch WHERE snapshot_key=$1', [batches.E.snapshotKey])).rows[0];
    expect(stored.status).toBe('rejected_stale');
    expect(stored.release_id).toBeNull();
    expect((await ownerQuery('SELECT revision FROM catalog.item_current WHERE item_id=ANY($1::uuid[]) ORDER BY item_id', [[itemOne, itemTwo]])).rows).toEqual(before);
    expect((await ownerQuery('SELECT count(*)::int AS n FROM catalog.product_source_result r JOIN catalog.product_source_batch b ON b.id=r.batch_id WHERE b.snapshot_key=$1', [batches.E.snapshotKey])).rows[0].n).toBe(0);
    const replay = await applyBatch(randomUUID(), profile(), batches.E, planBase([]));
    expect(replay.result).toMatchObject({ status: 'rejected_stale' });
  });

  it('marks a bound item that is absent from this snapshot as missing and never touches its data', async () => {
    const requestId = randomUUID();
    batches.F = batchPayload('F', '2026-10-25T04:40:00Z', baseRows(), []);
    const { result } = await applyBatch(requestId, profile(), batches.F, planBase([
      unchangedResult(itemOne, CODE_ONE, '测试产品一', 2),
      {
        sourceKey: `code:${CODE_TWO}`, iceCode: CODE_TWO, itemId: itemTwo, action: 'unchanged',
        reasonCode: 'SOURCE_ROW_MISSING', reasonText: '本次来源快照未见该已绑定商品，仅标记', rowNumbers: [], expectedRevision: null,
        changes: [], adoptions: [], nextFields: null, nameCn: '测试产品二改名', createCode: null,
        issues: [{ kind: 'missing_row', detail: { itemId: itemTwo } }], missing: true,
      },
    ]));
    applied.F = result;
    expect(result).toMatchObject({ status: 'applied' });
    expect(result.counts).toMatchObject({ missing: 1, failed: 0, needsReview: 0, unchanged: 1 });
    const byKey = Object.fromEntries((result.results as Json[]).map((entry) => [entry.sourceKey, entry]));
    expect(byKey[`code:${CODE_TWO}`]).toMatchObject({ action: 'unchanged', missing: true });
    const binding = (await ownerQuery('SELECT state FROM catalog.product_source_binding WHERE item_id=$1', [itemTwo])).rows[0];
    expect(binding.state).toBe('missing');
    expect((await ownerQuery('SELECT count(*)::int AS n FROM catalog.catalog_item WHERE id=$1', [itemTwo])).rows[0].n).toBe(1);
    expect((await ownerQuery('SELECT revision FROM catalog.item_current WHERE item_id=$1', [itemTwo])).rows[0].revision).toBe(2);
    const issues = (await ownerQuery(
      `SELECT issue_kind FROM catalog.product_source_issue i JOIN catalog.product_source_batch b ON b.id=i.batch_id WHERE b.snapshot_key=$1`, [batches.F.snapshotKey],
    )).rows;
    expect(issues.map((entry) => entry.issue_kind)).toEqual(['missing_row']);
  });

  it('keeps blocked review results read-only and writes the non-blocking fields of the same item', async () => {
    const reviewRequest = randomUUID();
    batches.G = batchPayload('G', '2026-10-25T04:50:00Z', baseRows(), []);
    const reviewResult = await applyBatch(reviewRequest, profile(), batches.G, planBase([
      {
        sourceKey: `code:${CODE_ONE}`, iceCode: CODE_ONE, itemId: itemOne, action: 'needs_review',
        reasonCode: 'FIELD_CONFLICT', reasonText: '本地与来源同时修改，保留本地值，待人工核对', rowNumbers: [2],
        expectedRevision: null, changes: [], adoptions: [], nextFields: null, nameCn: '测试产品一', createCode: null,
        issues: [
          { kind: 'field_conflict', detail: { fieldKey: 'cartonQuantity', local: '24', source: '36' } },
          { kind: 'field_group_conflict', detail: { group: 'cartonDimensions' } },
        ],
        missing: false,
      },
      unchangedResult(itemTwo, CODE_TWO, '测试产品二改名', 3),
    ]));
    applied.G = reviewResult.result;
    expect(reviewResult.result).toMatchObject({ status: 'partial' });
    expect(reviewResult.result.counts).toMatchObject({ needsReview: 1, updated: 0, failed: 0 });
    expect((await ownerQuery('SELECT revision FROM catalog.item_current WHERE item_id=$1', [itemOne])).rows[0].revision).toBe(2);
    const issueRows = (await ownerQuery(
      `SELECT i.id,i.source_key,i.issue_kind,i.review_state,i.detail,i.item_id FROM catalog.product_source_issue i
       JOIN catalog.product_source_batch b ON b.id=i.batch_id WHERE b.snapshot_key=$1 ORDER BY i.issue_kind`, [batches.G.snapshotKey],
    )).rows;
    expect(issueRows.map((entry) => entry.issue_kind)).toEqual(['field_conflict', 'field_group_conflict']);
    expect(issueRows[0]).toMatchObject({ source_key: `code:${CODE_ONE}`, review_state: 'open', item_id: itemOne });
    expect(issueRows[0].detail).toMatchObject({ fieldKey: 'cartonQuantity', rowNumbers: [2] });

    const writeRequest = randomUUID();
    batches.H = batchPayload('H', '2026-10-25T05:00:00Z', baseRows(), []);
    const writeResult = await applyBatch(writeRequest, profile(), batches.H, planBase([
      {
        sourceKey: `code:${CODE_ONE}`, iceCode: CODE_ONE, itemId: itemOne, action: 'needs_review',
        reasonCode: 'FIELD_CONFLICT', reasonText: '来源资料采用（部分字段待核对）', rowNumbers: [2], expectedRevision: 2,
        changes: [{ fieldKey: 'factory', beforeRaw: null, afterRaw: '测试工厂甲', kind: 'update' }],
        adoptions: [
          { fieldKey: 'nameCn', raw: '测试产品一', state: 'observed', unitState: 'not_applicable' },
          { fieldKey: 'factory', raw: '测试工厂甲', state: 'observed', unitState: 'not_applicable' },
        ],
        nextFields: { nameCn: field('测试产品一', 'nameCn'), factory: field('测试工厂甲', 'factory'), cartonQuantity: field('24', 'cartonQuantity') },
        nameCn: '测试产品一', createCode: null,
        issues: [{ kind: 'field_conflict', detail: { fieldKey: 'cartonQuantity' } }],
        missing: false,
      },
      unchangedResult(itemTwo, CODE_TWO, '测试产品二改名', 3),
    ]));
    applied.H = writeResult.result;
    expect(writeResult.result).toMatchObject({ status: 'partial' });
    const byKey = Object.fromEntries((writeResult.result.results as Json[]).map((entry) => [entry.sourceKey, entry]));
    expect(byKey[`code:${CODE_ONE}`]).toMatchObject({ action: 'needs_review', itemRevision: 3 });
    const one = (await ownerQuery(
      'SELECT ic.revision,v.name_cn,v.reason,v.fields FROM catalog.item_current ic JOIN catalog.item_revision v ON v.item_id=ic.item_id AND v.revision=ic.revision WHERE ic.item_id=$1', [itemOne],
    )).rows[0];
    expect(one.revision).toBe(3);
    expect(one.reason).toBe('来源资料采用（部分字段待核对）');
    expect(one.fields.factory.raw).toBe('测试工厂甲');
    expect(one.fields.cartonQuantity.raw).toBe('24');
    // The 015 item projection reports this non-blocking write as needs_review.
    const stateAfterReview = await itemState(itemOne);
    expect(stateAfterReview.latestResult).toMatchObject({ classification: 'needs_review' });
    receipt('product-source-015-review.json', { reviewOnly: reviewResult.result, reviewWrite: writeResult.result, issueRows, one, stateAfterReview });
  });

  it('resolves exactly one open issue without touching product data and refuses to resolve twice', async () => {
    const open = (await ownerQuery(
      `SELECT i.id,i.item_id FROM catalog.product_source_issue i JOIN catalog.product_source_batch b ON b.id=i.batch_id
       WHERE b.snapshot_key=$1 AND i.review_state='open' ORDER BY i.issue_kind LIMIT 1`, [batches.G.snapshotKey],
    )).rows[0];
    const before = (await ownerQuery('SELECT revision FROM catalog.item_current WHERE item_id=$1', [open.item_id])).rows[0];
    const requestId = randomUUID();
    const resolved = await tx(ADMIN, async (client) => (await client.query(
      'SELECT catalog.resolve_product_source_issue($1,$2,$3,$4,$5) AS result',
      [requestId, sha('resolve'), open.id, 'resolved', '已人工核对，来源值保留'],
    )).rows[0].result as Json);
    expect(resolved).toMatchObject({ reviewState: 'resolved', sourceKey: `code:${CODE_ONE}` });
    const after = (await ownerQuery('SELECT review_state,resolved_by,resolution_note FROM catalog.product_source_issue WHERE id=$1', [open.id])).rows[0];
    expect(after).toMatchObject({ review_state: 'resolved', resolved_by: ADMIN, resolution_note: '已人工核对，来源值保留' });
    expect((await ownerQuery('SELECT revision FROM catalog.item_current WHERE item_id=$1', [open.item_id])).rows[0]).toEqual(before);
    await expect(tx(ADMIN, async (client) => client.query(
      'SELECT catalog.resolve_product_source_issue($1,$2,$3,$4,$5) AS result',
      [randomUUID(), sha('resolve-again'), open.id, 'ignored', '重复关闭'],
    ))).rejects.toMatchObject({ code: '22023' });
    const replay = await tx(ADMIN, async (client) => (await client.query(
      'SELECT catalog.resolve_product_source_issue($1,$2,$3,$4,$5) AS result',
      [requestId, sha('resolve'), open.id, 'resolved', '已人工核对，来源值保留'],
    )).rows[0].result);
    expect(replay).toEqual(resolved);
  });

  it('assigns a source code to an existing code-less item, keeps its UUID and refuses a second code', async () => {
    if (!owner) return; // owner-setup fixture requires the prepared instance marker
    const release = (await ownerQuery(
      `SELECT id FROM catalog.baseline_release WHERE release_key LIKE 'product-source:%' ORDER BY recorded_at DESC LIMIT 1`, [],
    )).rows[0];
    expect(release).toBeDefined();
    const codeLessItem = randomUUID();
    await ownerQuery(
      `INSERT INTO catalog.product_source_profile(profile_key,system,document_key,sheet_name,display_name,source_url,acquisition_mode)
       VALUES($1,'feishu','TEST-WIKI-NODE','Sheet1','ICE产品库（隔离测试）','https://example.invalid','local_snapshot')
       ON CONFLICT(profile_key) DO NOTHING`, [DEFAULT_PROFILE_KEY],
    );
    await ownerQuery('INSERT INTO catalog.catalog_item(id,first_release_id) VALUES($1,$2)', [codeLessItem, release.id]);
    await ownerQuery(
      `INSERT INTO catalog.item_revision(item_id,revision,name_cn,fields,evidence_ref,reason,actor_id)
       VALUES($1,1,'测试待补号商品','{}'::jsonb,'fixture:test-db','fixture code-less item',$2)`,
      [codeLessItem, ADMIN],
    );
    await ownerQuery('INSERT INTO catalog.item_current(item_id,revision,financial_revision) VALUES($1,1,NULL)', [codeLessItem]);
    const requestId = randomUUID();
    const assigned = await tx(ADMIN, async (client) => (await client.query(
      'SELECT catalog.assign_product_source_code($1,$2,$3,$4,$5,$6,$7) AS result',
      [requestId, sha('assign'), codeLessItem, 1, CODE_ASSIGN, '人工补录来源货号', 'fixture:test-db'],
    )).rows[0].result as Json);
    expect(assigned).toMatchObject({ itemId: codeLessItem, revision: 2, iceCode: CODE_ASSIGN });
    const code = (await ownerQuery('SELECT ice_code FROM catalog.catalog_item_code WHERE item_id=$1', [codeLessItem])).rows[0];
    expect(code.ice_code).toBe(CODE_ASSIGN);
    const history = (await ownerQuery('SELECT revision,previous_revision,ice_code_snapshot,reason FROM catalog.item_revision WHERE item_id=$1 ORDER BY revision', [codeLessItem])).rows;
    expect(history.map((entry) => [entry.revision, entry.ice_code_snapshot, entry.reason])).toEqual([[1, null, 'fixture code-less item'], [2, CODE_ASSIGN, '来源编号补录']]);
    const binding = (await ownerQuery('SELECT state,ice_code FROM catalog.product_source_binding WHERE item_id=$1', [codeLessItem])).rows[0];
    expect(binding).toEqual({ state: 'active', ice_code: CODE_ASSIGN });
    const state = await itemState(codeLessItem);
    expect(state.binding).toMatchObject({ iceCode: CODE_ASSIGN, state: 'active' });
    await expect(tx(ADMIN, async (client) => client.query(
      'SELECT catalog.assign_product_source_code($1,$2,$3,$4,$5,$6,$7)',
      [randomUUID(), sha('assign-again'), codeLessItem, 2, `${CODE_ASSIGN}X`, 'again', 'fixture:test-db'],
    ))).rejects.toMatchObject({ code: '23505' });
    await expect(tx(ADMIN, async (client) => client.query(
      'SELECT catalog.assign_product_source_code($1,$2,$3,$4,$5,$6,$7)',
      [randomUUID(), sha('assign-clash'), itemOne, 3, CODE_TWO, 'clash', 'fixture:test-db'],
    ))).rejects.toMatchObject({ code: '23505' });
  });

  it('keeps the last batch idempotent per snapshot and reports the final projection', async () => {
    const requestId = randomUUID();
    batches.I = batchPayload('I', '2026-10-25T05:10:00Z', baseRows(), []);
    const { result } = await applyBatch(requestId, profile(), batches.I, planBase([
      unchangedResult(itemOne, CODE_ONE, '测试产品一', 2),
      unchangedResult(itemTwo, CODE_TWO, '测试产品二改名', 3),
    ]));
    applied.I = result;
    expect(result).toMatchObject({ status: 'applied' });
    expect(result.counts).toMatchObject({ unchanged: 2, missing: 0, failed: 0, needsReview: 0 });
    expect((await ownerQuery('SELECT state FROM catalog.product_source_binding WHERE item_id=$1', [itemTwo])).rows[0].state).toBe('active');

    const over = await overview();
    expect(over.latest).toMatchObject({ snapshotKey: batches.I.snapshotKey, status: 'applied' });
    expect(((over.latest as Json).counts as Json)).toMatchObject({ created: 0, updated: 0, unchanged: 2, needsReview: 0, failed: 0, missing: 0 });
    expect(over.batches).toHaveLength(9);
    expect((over.batches as Json[]).map((entry) => entry.status)).toEqual(expect.arrayContaining(['rejected_stale', 'partial', 'applied']));
    expect((over.issues as Json[]).length).toBeGreaterThanOrEqual(1);
    expect((over.issues as Json[]).map((entry) => entry.reviewState)).toEqual(expect.arrayContaining(['open', 'resolved']));
    const stateOne = await itemState(itemOne);
    expect(stateOne.latestResult).toMatchObject({ classification: 'unchanged' });
    expect(iso(String((stateOne.latestResult as Json).capturedAt))).toBe(iso('2026-10-25T05:10:00Z'));
    const stateTwo = await itemState(itemTwo);
    expect(stateTwo.latestResult).toMatchObject({ classification: 'unchanged' });
    for (const payload of [over, stateOne, stateTwo]) {
      const text = JSON.stringify(payload);
      for (const price of Object.values(PRICE)) expect(text).not.toContain(`"${price}"`);
      // Header labels (column titles) may appear in collection metadata; price values and
      // the semantic amount keys never do.
      expect(text).not.toMatch(/costPrice|operatingPrice|shippingPrice|"amounts"/);
    }
    receipt('product-source-015-final-projection.json', { receipt: result, overview: over, stateOne, stateTwo });
  });

  it('isolates restricted price columns by header text for both worksheet column orders', async () => {
    // Re-ordered sheet: price labels on AB/AC/AD, ordinary text in I/J/Y.
    const reorderedRows: RowInput[] = [
      row(2, true, CODE_ONE, { A: '2026-10-20', B: '测试产品一', G: CODE_ONE, I: '普通文本I', J: '普通文本J', Y: '普通文本Y', AB: PRICE.cost, AC: PRICE.operating, AD: PRICE.shipping }),
      row(3, true, CODE_TWO, { B: '测试产品二', G: CODE_TWO }),
      row(4, true, CODE_ROW_ONLY, { B: '测试待补号商品', G: CODE_ROW_ONLY, I: '普通I', J: '普通J', Y: '普通Y' }),
      row(5, false, null, {}),
    ];
    batches.K = batchPayload('K', '2026-10-25T05:20:00Z', reorderedRows, [
      { rowNumber: 2, payload: { costPrice: PRICE.cost, operatingPrice: PRICE.operating, shippingPrice: PRICE.shipping } },
    ], 'local_simulation', HEADERS_REORDERED);
    const { result } = await applyBatch(randomUUID(), profile(), batches.K, planBase([
      unchangedResult(itemOne, CODE_ONE, '测试产品一', 2),
      unchangedResult(itemTwo, CODE_TWO, '测试产品二改名', 3),
    ]));
    expect(result).toMatchObject({ status: 'applied' });

    const rows = (await ownerQuery(
      `SELECT r.row_number,r.cells FROM catalog.product_source_row r JOIN catalog.product_source_batch b ON b.id=r.batch_id
       WHERE b.snapshot_key=$1 ORDER BY r.row_number`, [batches.K.snapshotKey],
    )).rows;
    const first = rows.find((entry) => entry.row_number === 2)!;
    // Ordinary I/J/Y text is kept; the relocated price columns AB/AC/AD are removed.
    expect(first.cells).toMatchObject({ I: '普通文本I', J: '普通文本J', Y: '普通文本Y' });
    expect(Object.keys(first.cells)).not.toEqual(expect.arrayContaining(['AB', 'AC', 'AD']));
    for (const entry of rows) {
      expect(JSON.stringify(entry.cells)).not.toMatch(/"5\.18"|"5\.68"|"0\.5"/);
    }
    const amounts = (await ownerQuery(
      `SELECT r.row_number,a.payload FROM catalog_private.product_source_row_amounts a
       JOIN catalog.product_source_row r ON r.id=a.row_id
       JOIN catalog.product_source_batch b ON b.id=r.batch_id WHERE b.snapshot_key=$1`, [batches.K.snapshotKey],
    )).rows;
    expect(amounts).toEqual([{ row_number: 2, payload: { costPrice: PRICE.cost, operatingPrice: PRICE.operating, shippingPrice: PRICE.shipping } }]);
    for (const payload of [result, await overview(), await itemState(itemOne)]) {
      const text = JSON.stringify(payload);
      for (const price of Object.values(PRICE)) expect(text).not.toContain(`"${price}"`);
      expect(text).not.toMatch(/costPrice|operatingPrice|shippingPrice/);
    }

    // Legacy letter-keyed private payloads are rejected (semantic keys only).
    const legacy = batchPayload('K-legacy', '2026-10-25T05:21:00Z', baseRows(), [{ rowNumber: 2, payload: { I: PRICE.cost } }]);
    await expect(applyBatch(randomUUID(), profile(), legacy, planBase([])))
      .rejects.toMatchObject({ code: '22023', message: expect.stringContaining('CATALOG_SOURCE_AMOUNTS_INVALID') });
  });

  it('retries only the failed source keys of a partial batch without touching successful items', async () => {
    const parent = applied.C as Json;
    const parentId = String(parent.batchId);
    const parentRow = (await ownerQuery('SELECT snapshot_key,release_id,status,record_artifact_id FROM catalog.product_source_batch WHERE id=$1', [parentId])).rows[0] as {
      snapshot_key: string; release_id: string; status: string; record_artifact_id: string;
    };
    expect(parentRow.status).toBe('partial');
    const revisionOne = (await ownerQuery('SELECT revision FROM catalog.item_current WHERE item_id=$1', [itemOne])).rows[0].revision as number;
    const revisionTwo = (await ownerQuery('SELECT revision FROM catalog.item_current WHERE item_id=$1', [itemTwo])).rows[0].revision as number;

    batches.Cretry = { ...batches.C, retryOfBatchId: parentId };
    const retryRequest = randomUUID();
    const retryPlan = planBase([{
      sourceKey: `code:${CODE_ONE}`, iceCode: CODE_ONE, itemId: itemOne, action: 'update',
      reasonCode: 'SOURCE_FIELD_UPDATE', reasonText: '来源资料采用（补做）', rowNumbers: [2], expectedRevision: revisionOne,
      changes: [{ fieldKey: 'cartonQuantity', beforeRaw: '24', afterRaw: '36', kind: 'update' }],
      adoptions: [{ fieldKey: 'cartonQuantity', raw: '36', state: 'observed', unitState: 'confirmed' }],
      nextFields: { cartonQuantity: field('36', 'cartonQuantity') },
      nameCn: '测试产品一', createCode: null, issues: [], missing: false,
    }]);
    const { result } = await applyBatch(retryRequest, profile(), batches.Cretry, retryPlan);
    expect(result).toMatchObject({ status: 'applied', retryOfBatchId: parentId, snapshotKey: parentRow.snapshot_key });
    expect(result.counts).toMatchObject({ updated: 1, created: 0, unchanged: 0, failed: 0, needsReview: 0, missing: 0 });
    expect(result.batchId).not.toBe(parentId);

    const retried = (await ownerQuery(
      `SELECT id,retry_of_batch_id,release_id,record_artifact_id,status,counts FROM catalog.product_source_batch
       WHERE snapshot_key=$1 AND retry_of_batch_id=$2`, [parentRow.snapshot_key, parentId],
    )).rows;
    expect(retried).toHaveLength(1);
    expect(retried[0]).toMatchObject({ retry_of_batch_id: parentId, release_id: parentRow.release_id, status: 'applied' });
    // Evidence rows are reused, never duplicated.
    expect((await ownerQuery('SELECT count(*)::int AS n FROM catalog.artifact WHERE release_id=$1', [parentRow.release_id])).rows[0].n).toBe(2);
    // The failed item is now applied; the successful item keeps its revision.
    expect((await ownerQuery('SELECT revision FROM catalog.item_current WHERE item_id=$1', [itemOne])).rows[0].revision).toBe(revisionOne + 1);
    expect((await ownerQuery('SELECT revision FROM catalog.item_current WHERE item_id=$1', [itemTwo])).rows[0].revision).toBe(revisionTwo);
    // The missing safety net is skipped for a retry: the untouched success item stays bound.
    expect((await ownerQuery('SELECT state FROM catalog.product_source_binding WHERE item_id=$1', [itemTwo])).rows[0].state).toBe('active');
    // The parent batch stays immutable and partial.
    expect((await ownerQuery('SELECT status FROM catalog.product_source_batch WHERE id=$1', [parentId])).rows[0].status).toBe('partial');
    // Same request replays the stored retry receipt.
    const replay = await applyBatch(retryRequest, profile(), batches.Cretry, retryPlan);
    expect(replay.result).toEqual(result);
    receipt('product-source-015-retry.json', { parentId, retry: result, retried, revisionOne, revisionTwo });

    // Retrying a source key that succeeded in the parent is refused.
    await expect(applyBatch(randomUUID(), profile(), { ...batches.C, retryOfBatchId: parentId },
      planBase([unchangedResult(itemTwo, CODE_TWO, '测试产品二改名', 3)]),
    )).rejects.toMatchObject({ code: '22023', message: expect.stringContaining('CATALOG_SOURCE_RETRY_NOT_FAILED') });
    // Retrying a fully applied batch is refused.
    await expect(applyBatch(randomUUID(), profile(), { ...batches.A, retryOfBatchId: String((applied.A as Json).batchId) },
      planBase([createResult(CODE_ONE, '测试产品一', '12', 2)]),
    )).rejects.toMatchObject({ code: '22023', message: expect.stringContaining('CATALOG_SOURCE_RETRY_NOT_ALLOWED') });
    // Retrying with a different snapshot than the parent is refused.
    await expect(applyBatch(randomUUID(), profile(), { ...batches.D, retryOfBatchId: parentId },
      planBase([unchangedResult(itemOne, CODE_ONE, '测试产品一', 2)]),
    )).rejects.toMatchObject({ code: '22023', message: expect.stringContaining('CATALOG_SOURCE_RETRY_NOT_ALLOWED') });
  });

  it('retains the original request intent privately and still replays the stored receipt', async () => {
    const requestId = randomUUID();
    const intent = sha(`intent:${RUN}:draft`);
    const snapshotKey = sha(`snapshot:${RUN}:draft`);
    const payload = { profileKey: PROFILE_KEY, snapshotKey, note: '原始提交意图 draft' };
    const record = (parameters: unknown[]) => tx(ADMIN, async (client) => (await client.query(
      'SELECT catalog.record_product_source_request_intent($1,$2,$3,$4,$5,$6::jsonb) AS result', parameters,
    )).rows[0].result as Json);
    const read = (id: string) => tx(ADMIN, async (client) => (await client.query(
      'SELECT catalog.read_product_source_request_intent($1) AS result', [id],
    )).rows[0].result as Json | null);

    const recorded = await record([requestId, intent, 'apply_product_source_batch', PROFILE_KEY, snapshotKey, JSON.stringify(payload)]);
    expect(recorded).toMatchObject({ recorded: true, action: 'apply_product_source_batch', intentSha256: intent });
    expect(await read(requestId)).toMatchObject({
      action: 'apply_product_source_batch', intentSha256: intent, profileKey: PROFILE_KEY, snapshotKey,
    });
    expect(((await read(requestId))!.payload as Json).note).toBe('原始提交意图 draft');
    // Same actor/action/intent: not rewritten, the draft payload is preserved.
    expect(await record([requestId, intent, 'apply_product_source_batch', PROFILE_KEY, snapshotKey, JSON.stringify({ note: 'changed' })])).toMatchObject({ recorded: false });
    expect(((await read(requestId))!.payload as Json).note).toBe('原始提交意图 draft');
    // Different intent or action for the same request id conflicts.
    await expect(record([requestId, sha('other-intent'), 'apply_product_source_batch', PROFILE_KEY, snapshotKey, '{}']))
      .rejects.toMatchObject({ code: '23505', message: expect.stringContaining('CATALOG_REQUEST_CONFLICT') });
    await expect(record([requestId, intent, 'resolve_source_issue', PROFILE_KEY, snapshotKey, '{}']))
      .rejects.toMatchObject({ code: '23505', message: expect.stringContaining('CATALOG_REQUEST_CONFLICT') });
    // Runtime role can neither record nor read the private draft.
    for (const actor of [null, OPERATOR, INACTIVE_ADMIN]) {
      await expect(tx(actor, (client) => client.query(
        'SELECT catalog.record_product_source_request_intent($1,$2,$3,$4,$5,$6::jsonb)',
        [randomUUID(), sha('denied-draft'), 'apply_product_source_batch', PROFILE_KEY, snapshotKey, '{}'],
      ))).rejects.toMatchObject({ code: '42501' });
      await expect(tx(actor, (client) => client.query('SELECT catalog.read_product_source_request_intent($1)', [requestId])))
        .rejects.toMatchObject({ code: '42501' });
    }

    // The recorded request id + intent applies normally, then replays its receipt even though
    // the resubmitted batch payload differs: the retained draft never forces a conflict.
    batches.L = batchPayload('L', '2026-10-25T05:30:00Z', baseRows(), []);
    const applyRaw = (batch: Json, plan: Json) => tx(ADMIN, async (client) => (await client.query(
      'SELECT catalog.apply_product_source_batch($1,$2,$3::jsonb,$4::jsonb,$5::jsonb) AS result',
      [requestId, intent, JSON.stringify(profile()), JSON.stringify(batch), JSON.stringify(plan)],
    )).rows[0].result as Json);
    const appliedOnce = await applyRaw(batches.L, planBase([
      unchangedResult(itemOne, CODE_ONE, '测试产品一', 2),
      unchangedResult(itemTwo, CODE_TWO, '测试产品二改名', 3),
    ]));
    expect(appliedOnce).toMatchObject({ status: 'applied' });
    const replayed = await applyRaw({ ...batches.L, snapshotKey: sha('changed-snapshot-key') }, planBase([]));
    expect(replayed).toEqual(appliedOnce);
    expect((await ownerQuery('SELECT count(*)::int AS n FROM catalog.product_source_batch WHERE snapshot_key=$1', [batches.L.snapshotKey])).rows[0].n).toBe(1);
    expect(await read(requestId)).toMatchObject({ intentSha256: intent });
    receipt('product-source-015-request-intent.json', { requestId, recorded, readBack: await read(requestId), appliedOnce, replayed, conflictCodes: ['CATALOG_REQUEST_CONFLICT'] });
  });
});
