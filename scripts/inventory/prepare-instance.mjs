/**
 * Prepare the isolated instance for the inventory-sync repair round v4 (R1-R4).
 *
 * Steps:
 *   1. catalog isolated instance (p0-02 base + catalog 001/002 + local display 009-015 + 126 items)
 *      via prepare-local-preview.mjs (only when the instance is missing);
 *   2. schema handshake:
 *        - no 016 tables            -> apply 016 structure, then 018 v3 + 019 v4 + 020 v4-final + 021 v6;
 *        - old 016 without state    -> apply 017 v2 upgrade, then 018 v3 + 019 v4 + 020 + 021;
 *        - state version < 2        -> apply 017 v2 upgrade, then 018 v3 + 019 v4 + 020 + 021;
 *        - state version < 3        -> apply 018 v3 + 019 v4 + 020 + 021 (idempotent);
 *        - always re-apply the idempotent 019 v4 / 020 v4-final / 021 v6 increments and the functions
 *          file (CREATE OR REPLACE) so the database code can never silently lag behind db/catalog/*.sql;
 *        - record schema version 6 + the applied v6 structure and functions sha256;
 *   3. seed: account, 8 warehouses (7 confirmed + 1 excluded, market evidence only from explicit
 *      warehouse-name tokens), scope v1, settings disabled/60, and the historical BS sample decisions
 *      **as candidates only** (never confirmed);
 *   4. marker: package inventory-sync-v1, repair repair-v4, testWritable/validationInstance true,
 *      runId and database identity written to both instance and run-root markers so the F5.4 guard can
 *      prove a writable test target before any DB connection.
 *
 * Only writes inside the new run root; never touches 3011/3021/3022/3031/50499/59532/3033/53442.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, readArgs, openRun, safeEnv, writeJson } from '../catalog/prepare.mjs';
import { freezeWorkerSource } from './freeze-worker-source.mjs';

const DEFAULT_WEB_PORT = 3031;
const SCHEMA_VERSION = 6;
const V3_UPGRADE_FILE = 'db/catalog/018_inventory_sync_repair_v3.sql';
const V4_UPGRADE_FILE = 'db/catalog/019_inventory_sync_repair_v4.sql';
const V4_FINAL_UPGRADE_FILE = 'db/catalog/020_inventory_sync_repair_v4_final.sql';
const V6_UPGRADE_FILE = 'db/catalog/021_inventory_live_intake.sql';
const LEGACY_016_SHA256 = '7f12c313b68dedd4bb5ee727bbc772508ff5670e285ba469eb8d63286b08400e';

// The original task's user-confirmed decision: exclude the account's self-declared abandoned warehouse.
// Markets are only assigned when the warehouse name contains an explicit country / market token; the
// remaining warehouse stays NULL ("待确认") instead of being guessed.
const BIGSELLER_WAREHOUSES = [
  { externalId: '56673', name: 'DEE-龙仔厝（ICE专属）', status: 'confirmed', market: null, token: null },
  { externalId: '52074', name: 'DEE泰国海外仓(曼谷仓）', status: 'confirmed', market: 'TH', token: '泰国' },
  { externalId: '54409', name: 'PH-彩妆日均万单简简单单仓', status: 'confirmed', market: 'PH', token: 'PH' },
  { externalId: '53252', name: '印尼-DEE仓库', status: 'confirmed', market: 'ID', token: '印尼' },
  { externalId: '54886', name: '喜运达MY仓', status: 'confirmed', market: 'MY', token: 'MY' },
  { externalId: '48787', name: '昕兰PH自建仓(弃用）', status: 'excluded', market: 'PH', token: 'PH' },
  { externalId: '56519', name: '菲律宾-新创启辰自建仓', status: 'confirmed', market: 'PH', token: '菲律宾' },
  { externalId: '50455', name: '越南青林湾仓库', status: 'confirmed', market: 'VN', token: '越南' },
];

const ACCOUNT = {
  accountKey: 'bigseller-primary',
  accountLabel: 'laiguoyong@KNZX019402',
  externalAccountCode: 'KNZX019402',
};

const PRIOR_RUN_ID = 'run-20261025T175500Z-f7a8b9c0';
const EVIDENCE_ROOT = path.join(REPO_ROOT, '.local', 'inventory-sync-repair-20261026');

function runNode(script, args, env) {
  const result = spawnSync(process.execPath, [path.join(REPO_ROOT, script), ...args], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) throw new Error(`INVENTORY_PREPARE_STEP_FAILED:${script}:${result.status}`);
}

function hashFile(relative) {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO_ROOT, relative))).digest('hex');
}

async function applySql(owner, relative) {
  const sql = fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8');
  await owner.query(sql);
  await owner.query('RESET ROLE; RESET ALL');
  return { path: relative, sha256: hashFile(relative) };
}

async function readSchemaState(owner) {
  const present = (await owner.query(
    `SELECT to_regclass('catalog.inventory_schema_state') IS NOT NULL AS present,
            to_regclass('catalog.inventory_source_account') IS NOT NULL AS has_016`)).rows[0];
  if (!present.has_016) return { state: 'missing', present, row: null };
  if (!present.present) return { state: 'legacy', present, row: null };
  const row = (await owner.query(
    `SELECT version, source_sha256, functions_sha256, applied_at, upgraded_from
     FROM catalog.inventory_schema_state ORDER BY id LIMIT 1`)).rows[0] ?? null;
  return { state: 'present', present, row };
}

async function ensureSchema(owner, evidence) {
  const before = await readSchemaState(owner);
  const structureFile = 'db/catalog/016_inventory_sync.sql';
  const functionsFile = 'db/catalog/016_inventory_sync_functions.sql';
  const upgradeFile = 'db/catalog/017_inventory_sync_repair_v2.sql';
  const v3File = V3_UPGRADE_FILE;
  const v4File = V4_UPGRADE_FILE;
  const v4FinalFile = V4_FINAL_UPGRADE_FILE;
  const v6File = V6_UPGRADE_FILE;
  // 商品库存双视图 v1：只读读模型增量（022）与国内冻结表格快照关联（023）。
  // 两者都是幂等的 CREATE OR REPLACE 只读函数，不建表、不改 schema version。
  const dualViewFile = 'db/catalog/022_inventory_dual_view.sql';
  const domesticLinksFile = 'db/catalog/023_inventory_domestic.sql';
  const applied = [];
  let sqlState;
  const version = Number(before.row?.version ?? 0);
  if (before.state === 'missing') {
    applied.push(await applySql(owner, structureFile));
    applied.push(await applySql(owner, v3File));
    applied.push(await applySql(owner, v4File));
    applied.push(await applySql(owner, v4FinalFile));
    applied.push(await applySql(owner, v6File));
    sqlState = 'applied-fresh-v6';
  } else if (before.state === 'legacy' || version < 2) {
    const fromSha = before.row?.source_sha256 ?? LEGACY_016_SHA256;
    applied.push(await applySql(owner, upgradeFile));
    applied.push(await applySql(owner, v3File));
    applied.push(await applySql(owner, v4File));
    applied.push(await applySql(owner, v4FinalFile));
    applied.push(await applySql(owner, v6File));
    sqlState = `upgraded-from-${String(fromSha).slice(0, 12)}-v6`;
  } else if (version < 3) {
    applied.push(await applySql(owner, v3File));
    applied.push(await applySql(owner, v4File));
    applied.push(await applySql(owner, v4FinalFile));
    applied.push(await applySql(owner, v6File));
    sqlState = `upgraded-v6-from-v${version}`;
  } else {
    // Always re-apply the idempotent v4/v4-final/v6 increments so a partially applied instance converges.
    applied.push(await applySql(owner, v4File));
    applied.push(await applySql(owner, v4FinalFile));
    applied.push(await applySql(owner, v6File));
    sqlState = 'current';
  }
  // Always re-apply the idempotent function definitions so DB code cannot silently lag the files.
  applied.push(await applySql(owner, functionsFile));
  applied.push(await applySql(owner, dualViewFile));
  applied.push(await applySql(owner, domesticLinksFile));
  const structureSha = hashFile(v6File);
  const functionsSha = hashFile(functionsFile);
  await owner.query(
    `UPDATE catalog.inventory_schema_state
     SET version=$1, source_sha256=$2, functions_sha256=$3, applied_at=now()
     WHERE id = (SELECT id FROM catalog.inventory_schema_state ORDER BY id LIMIT 1)`,
    [SCHEMA_VERSION, structureSha, functionsSha]);
  const after = await readSchemaState(owner);
  if (!after.row || Number(after.row.version) !== SCHEMA_VERSION
    || after.row.source_sha256 !== structureSha || after.row.functions_sha256 !== functionsSha) {
    throw new Error('INVENTORY_SCHEMA_STATE_MISMATCH');
  }
  evidence.schema = { sqlState, applied, structureSha, functionsSha, version: SCHEMA_VERSION };
  return { sqlState, applied, structureSha, functionsSha };
}

async function seedInventory(owner, evidence) {
  const accountId = (await owner.query(
    `INSERT INTO catalog.inventory_source_account (account_key, account_label, external_account_code, source_system, status)
     VALUES ($1,$2,$3,'bigseller','active')
     ON CONFLICT (account_key) DO UPDATE SET account_label=EXCLUDED.account_label, external_account_code=EXCLUDED.external_account_code
     RETURNING id`, [ACCOUNT.accountKey, ACCOUNT.accountLabel, ACCOUNT.externalAccountCode])).rows[0].id;

  const warehouseIds = [];
  for (const warehouse of BIGSELLER_WAREHOUSES) {
    const marketEvidence = warehouse.market
      ? {
        source: 'bigseller_warehouse_name',
        token: warehouse.token,
        method: 'exact_country_or_market_token',
        note: '市场只从仓库名称中明确出现的国家/市场词读取；未出现则保持待确认，不猜值',
      }
      : {};
    const row = (await owner.query(
      `INSERT INTO catalog.inventory_warehouse (account_id, external_warehouse_id, external_name, normalized_name, status, evidence, market, market_evidence)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb)
       ON CONFLICT (account_id, external_warehouse_id)
       DO UPDATE SET external_name=EXCLUDED.external_name, normalized_name=EXCLUDED.normalized_name,
         status=EXCLUDED.status, market=EXCLUDED.market, market_evidence=EXCLUDED.market_evidence
       RETURNING id`,
      [accountId, warehouse.externalId, warehouse.name, warehouse.name.trim().toLowerCase(), warehouse.status,
        JSON.stringify({ source: 'bigseller.warehouse.getWarehouseInfoVoList', discoveredAt: new Date().toISOString() }),
        warehouse.market, JSON.stringify(marketEvidence)],
    )).rows[0];
    if (warehouse.status === 'confirmed') warehouseIds.push(row.id);
  }
  if (warehouseIds.length === 0) throw new Error('INVENTORY_SEED_SCOPE_EMPTY');

  const scopeId = (await owner.query(
    `INSERT INTO catalog.inventory_scope (account_id, version, warehouse_ids, note, created_at)
     VALUES ($1, 1, $2::uuid[], $3, now())
     ON CONFLICT (account_id, version) DO UPDATE SET warehouse_ids=EXCLUDED.warehouse_ids, note=EXCLUDED.note
     RETURNING id`,
    [accountId, warehouseIds,
      `首次范围：沿用原任务用户确认的参与仓（原实例 ${PRIOR_RUN_ID}）；排除账号自述“弃用”的昕兰PH自建仓，空范围=停止发布`])).rows[0].id;

  await owner.query(
    `INSERT INTO catalog.inventory_sync_settings (account_id, enabled, interval_minutes, scope_id, next_run_at, plan_anchor_at, config_version)
     VALUES ($1,false,60,$2,NULL,NULL,1)
     ON CONFLICT (account_id) DO NOTHING`, [accountId, scopeId]);

  // Historical BS sample decisions are evidence-bearing CANDIDATES only. They are never confirmed by
  // the preparation script: an administrator must explicitly confirm account/warehouse/item/unit.
  const candidateInsert = await owner.query(
    `WITH src AS (
        SELECT DISTINCT ON (r.sku, w.id)
               r.sku AS external_sku, w.id AS warehouse_id, r.selected_item_id AS item_id,
               jsonb_build_object('source','bs_sample_export','exportLabel',e.export_label,
                 'excelRow',r.excel_row,'legacySelectionState',r.selection_state,
                 'note','旧BS样表人工决定，仅作有出处候选；需管理员核实账号/仓库/商品/单位后明确确认') AS evidence
        FROM catalog.bs_sample_inventory_row r
        JOIN catalog.bs_sample_export e ON e.id = r.export_id
        JOIN catalog.inventory_warehouse w ON w.account_id = $1 AND w.external_name = r.warehouse
        WHERE r.selection_state = 'confirmed' AND r.selected_item_id IS NOT NULL AND btrim(r.sku) <> ''
        ORDER BY r.sku, w.id, r.excel_row
     ), ins AS (
        INSERT INTO catalog.inventory_mapping_candidate (account_id, warehouse_id, external_sku, suggested_item_id, evidence)
        SELECT $1, s.warehouse_id, s.external_sku, s.item_id, s.evidence
        FROM src s
        ON CONFLICT (account_id, coalesce(warehouse_id,'00000000-0000-0000-0000-000000000000'::uuid), external_sku)
        DO NOTHING
        RETURNING 1)
     SELECT (SELECT count(*) FROM src) AS candidates, (SELECT count(*) FROM ins) AS inserted`,
    [accountId]);

  const counts = {
    account: accountId,
    warehouses: warehouseIds.length,
    excludedWarehouses: BIGSELLER_WAREHOUSES.length - warehouseIds.length,
    markets: BIGSELLER_WAREHOUSES.filter((w) => w.market).length,
    unknownMarketWarehouses: BIGSELLER_WAREHOUSES.filter((w) => !w.market).length,
    scope: scopeId,
    mappingCandidates: Number(candidateInsert.rows[0].candidates),
    mappingCandidatesInserted: Number(candidateInsert.rows[0].inserted),
    confirmedMappings: 0,
    variants: 0,
  };
  evidence.seed = counts;
  fs.mkdirSync(evidence.runRoot, { recursive: true });
  writeJson(path.join(evidence.runRoot, 'inventory-seed-counts.json'), counts);
  return { accountId, scopeId, warehouseIds, counts };
}

export async function prepareInventoryInstance(argv = process.argv.slice(2)) {
  const args = readArgs(argv);
  const webPort = Number(process.env.INVENTORY_PREVIEW_PORT ?? DEFAULT_WEB_PORT);
  if (!Number.isInteger(webPort) || webPort < 1 || webPort > 65535) throw new Error('INVENTORY_WEB_PORT_INVALID');
  const evidence = { runRoot: args.root };
  const instanceMarker = path.join(args.instanceRoot, 'catalog-instance.json');

  if (!fs.existsSync(instanceMarker)) {
    runNode('scripts/catalog/prepare-local-preview.mjs', ['--run-id', args.runId], safeEnv());
  } else {
    console.log(`instance already prepared: ${args.runId}`);
  }

  const run = openRun(args);
  const { default: pg } = await import('pg');
  const ownerUrl = `postgres://${run.instance.bootstrapUser}:${run.instance.bootstrapPassword}@${run.instance.host}:${run.instance.port}/${run.instance.dbName}`;
  const owner = new pg.Client({ connectionString: ownerUrl });
  await owner.connect();
  // Post-connect identity proof (read-only) before any schema write: the bootstrap URL must resolve
  // to exactly this new isolated instance (host/port/database), not a protected/delivered one.
  await owner.query('BEGIN READ ONLY');
  const liveIdentity = (await owner.query(
    `SELECT current_database() AS db, inet_server_port() AS port`)).rows[0];
  await owner.query('ROLLBACK');
  if (!liveIdentity || String(liveIdentity.db) !== run.instance.dbName
    || Number(liveIdentity.port) !== Number(run.instance.port)) {
    await owner.end();
    throw new Error(`INVENTORY_PREPARE_DB_IDENTITY_MISMATCH:${JSON.stringify(liveIdentity)}`);
  }
  let schema;
  let seed;
  let frozen;
  try {
    schema = await ensureSchema(owner, evidence);
    seed = await seedInventory(owner, evidence);
  } finally {
    await owner.end();
  }

  const workDir = path.join(args.root, 'inventory-work');
  fs.mkdirSync(path.join(workDir, 'exports'), { recursive: true });
  fs.mkdirSync(path.join(workDir, 'logs'), { recursive: true });
  const env = JSON.parse(fs.readFileSync(path.join(args.instanceRoot, 'env.catalog.json'), 'utf8'));
  const inventoryEnv = {
    runId: args.runId,
    runRoot: args.root,
    instanceRoot: args.instanceRoot,
    host: run.instance.host,
    port: run.instance.port,
    database: run.instance.dbName,
    appDbUrl: env.P0_02_APP_DATABASE_URL,
    syncDbUrl: env.P0_02_SYNC_DATABASE_URL,
    ownerDbUrl: ownerUrl,
    webPort,
    previewUrl: `http://127.0.0.1:${webPort}`,
    workDir,
    evidenceRoot: EVIDENCE_ROOT,
    accountLabel: ACCOUNT.accountLabel,
    loginFile: path.join(args.instanceRoot, 'login.local-preview.txt'),
    schemaVersion: SCHEMA_VERSION,
    schemaHashes: { structure: schema.structureSha, functions: schema.functionsSha },
  };
  writeJson(path.join(args.instanceRoot, 'env.inventory.json'), inventoryEnv);
  writeJson(path.join(args.instanceRoot, 'inventory-worker.json'), {
    runId: args.runId,
    appDbUrl: env.P0_02_APP_DATABASE_URL,
    syncDbUrl: env.P0_02_SYNC_DATABASE_URL,
    workDir,
    workerId: `inv-worker-${run.instance.port}`,
    version: 'inv-sync-v2',
    leaseSeconds: 120,
    exportTimeoutSeconds: 300,
    logPath: path.join(workDir, 'logs'),
    exportDir: path.join(workDir, 'exports'),
  });
  frozen = freezeWorkerSource(args.instanceRoot, {
    mode: process.argv.includes('--refresh-worker-source') ? 'refresh' : 'first-only',
  });
  fs.writeFileSync(path.join(args.instanceRoot, 'password.local.txt'), 'admin@catalog.test / CatalogAdmin123!\n');

  const marker = {
    package: 'inventory-sync-v1',
    repair: 'repair-v4-final',
    testWritable: true,
    validationInstance: true,
    runId: args.runId,
    preparedAt: new Date().toISOString(),
    webPort,
    previewUrl: `http://127.0.0.1:${webPort}`,
    database: { host: run.instance.host, port: run.instance.port, name: run.instance.dbName },
    schema: { version: SCHEMA_VERSION, sqlState: schema.sqlState, applied: schema.applied, structureSha: schema.structureSha, functionsSha: schema.functionsSha },
    seed: seed.counts,
    workerSource: { snapshotHash: frozen.source.snapshotHash, frozenAt: frozen.source.frozenAt, files: Object.keys(frozen.source.files).length },
  };
  writeJson(path.join(args.instanceRoot, 'inventory-instance.json'), marker);
  writeJson(path.join(args.root, 'inventory-manifest.json'), marker);
  console.log(`inventory instance ready: ${args.runId} web http://127.0.0.1:${webPort} db ${run.instance.host}:${run.instance.port}`);
  console.log(
    `schema=${schema.sqlState} v${SCHEMA_VERSION} candidates=${seed.counts.mappingCandidatesInserted}/${seed.counts.mappingCandidates} `
    + `confirmed=0 scopeWarehouses=${seed.counts.warehouses} workerSource=${frozen.source.snapshotHash.slice(0, 12)}`,
  );
  return marker;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareInventoryInstance().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
