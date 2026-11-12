#!/usr/bin/env node
/**
 * 飞书商品来源：scratch 库写分支验证（真实读取 → 差异预览 → 采用 → 商品详情/历史）。
 *
 * 目的：在**从现役库复制出来的 scratch 数据库**里验证四条写分支，绝不写现役库、不启停现役服务：
 *   A 真实快照首次采用：buildPlan(snapshot) → app runner + admin claim → apply_product_source_batch；
 *   B 同一快照重复应用：数据库必须返回 duplicate，且不新增商品/修订/批次；
 *   C 人工修改冲突：本地手工改资料并追加 item_revision，来源同一字段也变化但值不同 →
 *     action=needs_review / reasonCode=FIELD_CONFLICT，本地值不被覆盖，其他无冲突字段照计划写入；
 *   D 价格隔离：成本价格/运营价格/单品运费按**表头文字**定位，只进
 *     catalog_private.product_source_row_amounts；公共 cells/result/overview/item_state 不含价格值。
 *   D2（D 的补充，仅当快照价格列被脱敏/为空时尤其重要）：向价格列注入合成哨兵值后重跑，
 *     证明该值只存在于私有表、且任何公共 JSON 与公共表 jsonb 中都不出现。
 *
 * 隔离方式（参考 scripts/deploy/backup-instance.mjs）：
 *   pg_dump -Fc 现役库（只读）→ 同集群 createdb `iceos_fsprobe_<stamp>` → pg_restore → 需要时在
 *   scratch 上应用 db/catalog/015_product_source_sync.sql（现役库可能尚未迁移 015）→ 全部写操作
 *   只发生在 scratch → 结束 dropdb（--keep 时保留）。
 *
 * 用法：
 *   node scripts/catalog/feishu-source/verify-real-flow.mjs \
 *     --run-id run-20261026T211500Z-11a22b33 \
 *     --snapshot tests/catalog/fixtures/product-source/snapshot-001-redacted.json
 *   # 可选：--keep（保留 scratch 库）--out <证据目录> --label <证据标签>
 *
 * 证据：<out>/verify-real-flow.json（最新一次）+ <out>/verify-real-flow-<stamp>.json + <out>/verify-real-flow.log
 * 退出码：0 仅当 A/B/C/D（含 D2）全部断言通过；1 否则（证据与日志保留，scratch 仍会清理）。
 *
 * 约束：现役库只允许 SELECT/pg_dump；所有写操作使用 scratch 库；不重启任何现役进程；不访问外网。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { REPO_ROOT, safeEnv } from '../prepare.mjs';
import { createTsLoader } from './ts-loader.mjs';

const DEFAULT_VERIFY_DIR = path.join(REPO_ROOT, '.local/catalog/fs-catalog-real-20261110/verify');
const RUN_PATTERN = /^run-\d{8}T\d{6}Z-[a-f0-9]{8}$/;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
const ADMIN_ID = '11111111-1111-4111-8111-111111111101';
const APPLY_ACTION = 'apply_product_source_batch';
const SCRATCH_PREFIX = 'iceos_fsprobe_';
const MIGRATION_015 = 'db/catalog/015_product_source_sync.sql';
const SCRATCH_DB_NAME = /^[a-z0-9_]{1,63}$/;
const RESTRICTED_KEYS = ['costPrice', 'operatingPrice', 'shippingPrice'];
const PRICE_KEY_PATTERN = /costPrice|operatingPrice|shippingPrice|"amounts"/;
const RESTRICTED_LABELS = {
  costPrice: '成本价格',
  operatingPrice: '运营价格',
  shippingPrice: '单品运费（自由计算列）',
};
/** 与 src/features/catalog/product-source/service.ts 的 SOURCE_PROFILE 保持一致（避免引入 server-only）。 */
const SOURCE_PROFILE = {
  profileKey: 'feishu.ice-product-library.sheet1',
  documentKey: 'wiki:TC2AwLgRniqWKhkg9D2cEx79n0b',
  spreadsheetToken: 'EMZGs2eIhh0YQ1tPIqMcR8SPnQh',
  sheetId: '33bab4',
  sheetName: 'Sheet1',
  displayName: 'ICE产品库',
  sourceUrl: 'https://ygr1tb7cyf.feishu.cn/wiki/TC2AwLgRniqWKhkg9D2cEx79n0b',
  acquisitionMode: 'feishu_api',
};
const CONFLICT_SOURCE_FIELD_PREFERENCE = ['specification', 'englishName', 'factory', 'barcode', 'sourceNote', 'liquid'];
const CONFLICT_UPDATE_FIELD_PREFERENCE = ['factory', 'barcode', 'englishName', 'specification', 'sourceNote', 'liquid'];

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

const sha256Hex = (input) => crypto.createHash('sha256').update(input).digest('hex');
const sha256File = (file) => sha256Hex(fs.readFileSync(file));

function utcCompact(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

const isoLater = (baseMs, offsetMs) => new Date(baseMs + offsetMs).toISOString();
const jsonOf = (value) => JSON.stringify(value);

function countPlanResults(results) {
  const counts = { created: 0, updated: 0, unchanged: 0, needsReview: 0, failed: 0, missing: 0 };
  for (const result of results) {
    if (result.missing) counts.missing += 1;
    if (result.action === 'create') counts.created += 1;
    else if (result.action === 'update') counts.updated += 1;
    else if (result.action === 'unchanged') counts.unchanged += 1;
    else if (result.action === 'needs_review') counts.needsReview += 1;
    else if (result.action === 'failed') counts.failed += 1;
  }
  return counts;
}

function sameCounts(left, right) {
  if (!left || !right) return false;
  return ['created', 'updated', 'unchanged', 'needsReview', 'failed', 'missing'].every(
    (key) => Number(left[key] ?? 0) === Number(right[key] ?? 0),
  );
}

function sortedEntries(map) {
  return [...map.entries()].sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
}

function liveDbEnv(instance) {
  return {
    ...safeEnv(),
    PGPASSWORD: instance.bootstrapPassword,
    PGCONNECT_TIMEOUT: '15',
    PGCLIENTENCODING: 'UTF8',
  };
}

function toolExe(binDir, name) {
  return path.join(binDir, process.platform === 'win32' ? `${name}.exe` : name);
}

/**
 * 子进程输出直接写文件：本机 Windows 沙箱里 Node 的管道 stdio 会被拒绝（EPERM），
 * 文件重定向与 inherit 不受影响（与 scripts/deploy/backup-instance.mjs 的 runToLog 一致）。
 */
function runToLog(command, args, { logFile, env, timeout = 1_800_000 } = {}) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.appendFileSync(logFile, `\n$ ${path.basename(command)} ${args.join(' ')}\n`);
  const startedAt = Date.now();
  const fd = fs.openSync(logFile, 'a');
  try {
    const result = spawnSync(command, args, { cwd: REPO_ROOT, env, stdio: ['ignore', fd, fd], timeout, windowsHide: true });
    const durationMs = Date.now() - startedAt;
    if (result.error) throw new Error(`${path.basename(command)} 无法启动：${result.error.message}（日志 ${logFile}）`);
    if (result.status !== 0) throw new Error(`${path.basename(command)} 退出码 ${result.status}（日志 ${logFile}）`);
    return { durationMs, logFile };
  } finally {
    fs.closeSync(fd);
  }
}

async function main() {
  const rawArgs = parseArgs(process.argv.slice(2));
  const startedAt = new Date();
  const stamp = `${utcCompact(startedAt)}-${crypto.randomBytes(3).toString('hex')}`;
  const token = stamp.replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (!rawArgs.snapshot || typeof rawArgs.snapshot !== 'string') {
    throw new Error('用法：node scripts/catalog/feishu-source/verify-real-flow.mjs --run-id <run> --snapshot <快照 JSON> [--keep] [--out <dir>]');
  }
  const snapshotPath = path.resolve(rawArgs.snapshot);
  if (!fs.existsSync(snapshotPath)) throw new Error(`SNAPSHOT_NOT_FOUND: ${snapshotPath}`);
  const verifyDir = path.resolve(rawArgs.out ?? DEFAULT_VERIFY_DIR);
  fs.mkdirSync(verifyDir, { recursive: true });
  const logFile = path.join(verifyDir, 'verify-real-flow.log');
  const keep = rawArgs.keep === true;
  const label = typeof rawArgs.label === 'string' ? rawArgs.label : path.basename(snapshotPath);
  const log = (message) => {
    const line = `[${new Date().toISOString()}] ${message}`;
    process.stdout.write(`${line}\n`);
    fs.appendFileSync(logFile, `${line}\n`);
  };
  log(`verify-real-flow 启动：snapshot=${snapshotPath} keep=${keep} out=${verifyDir}`);

  // ts-loader 的输出路径以 cwd 为基准；固定到仓库根，保证脚本在任意目录可重复运行。
  const originalCwd = process.cwd();
  process.chdir(REPO_ROOT);
  const loaderTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iceos-verify-'));
  const loader = createTsLoader({ tempDir: loaderTempDir });
  const sourceDir = path.join(REPO_ROOT, 'src/features/catalog/product-source');
  const contract = await loader.load(path.join(sourceDir, 'contract.ts'));
  const reader = await loader.load(path.join(sourceDir, 'reader.ts'));
  const headersMod = await loader.load(path.join(sourceDir, 'headers.ts'));
  const normalizeMod = await loader.load(path.join(sourceDir, 'normalize.ts'));
  const planMod = await loader.load(path.join(sourceDir, 'plan.ts'));

  const evidence = {
    schemaVersion: 1,
    kind: 'iceos-product-source-scratch-verify',
    generatedAt: startedAt.toISOString(),
    durationMs: null,
    mode: label,
    ok: false,
    error: null,
    arguments: { runId: rawArgs['run-id'] ?? null, snapshot: snapshotPath, keep, out: verifyDir },
    snapshot: null,
    live: { readOnly: true, before: null, after: null },
    scratch: null,
    scenarios: {},
    assertions: [],
    notes: [
      '本脚本对现役库只执行只读统计与 pg_dump；所有写操作只发生在 scratch 库。',
      '结论只在 scratch 库成立；现役库未被写入、现役服务未被启停。',
      '价格值不写入证据文件：D/D2 只记录计数、布尔与快照哈希。',
    ],
  };
  const assertions = [];
  const record = (scenario, id, ok, detail) => {
    const item = { scenario, id, ok: Boolean(ok), detail: detail === undefined ? null : detail };
    assertions.push(item);
    if (!item.ok) log(`FAIL [${scenario}] ${id}${detail !== undefined ? `：${String(detail)}` : ''}`);
    return item.ok;
  };
  const scenarioPassed = (key) => {
    const rows = assertions.filter((entry) => entry.scenario === key);
    return rows.length > 0 && rows.every((entry) => entry.ok);
  };
  const finishScenarios = () => {
    for (const key of ['pre', 'setup', 'A', 'B', 'C', 'D', 'D2', 'live', 'cleanup']) {
      const rows = assertions.filter((entry) => entry.scenario === key);
      if (rows.length === 0) continue;
      evidence.scenarios[key] = {
        ...(evidence.scenarios[key] ?? {}),
        ok: rows.every((entry) => entry.ok),
        assertionCount: rows.length,
        failed: rows.filter((entry) => !entry.ok),
      };
    }
    evidence.assertions = assertions;
  };

  let instance = null;
  let scratchDb = null;
  let scratchCreated = false;
  let owner = null;
  const tempFiles = [];

  try {
    // ------------------------------------------------------------------
    // pre：实例 / 快照 / pg 工具
    // ------------------------------------------------------------------
    let runId = typeof rawArgs['run-id'] === 'string' ? rawArgs['run-id'] : null;
    if (!runId) {
      const catalogRoot = path.join(REPO_ROOT, '.local', 'catalog');
      const candidates = fs.existsSync(catalogRoot)
        ? fs.readdirSync(catalogRoot).filter((name) => RUN_PATTERN.test(name)
          && fs.existsSync(path.join(catalogRoot, name, 'instance', 'catalog-instance.json')))
        : [];
      if (candidates.length !== 1) throw new Error(`RUN_ID_REQUIRED: 找到 ${candidates.length} 个候选 run，请显式传 --run-id`);
      runId = candidates[0];
    }
    if (!RUN_PATTERN.test(runId)) throw new Error(`RUN_ID_INVALID: ${runId}`);
    const instanceFile = path.join(REPO_ROOT, '.local', 'catalog', runId, 'instance', 'catalog-instance.json');
    const envFile = path.join(REPO_ROOT, '.local', 'catalog', runId, 'instance', 'env.catalog.json');
    if (!fs.existsSync(instanceFile) || !fs.existsSync(envFile)) throw new Error(`INSTANCE_MISSING: ${runId}`);
    instance = JSON.parse(fs.readFileSync(instanceFile, 'utf8'));
    const envCatalog = JSON.parse(fs.readFileSync(envFile, 'utf8'));
    if (instance.runId !== runId || !LOOPBACK.has(instance.host) || !instance.pgBinDir) throw new Error('INSTANCE_INVALID');
    if (envCatalog.P0_02_RUN_ID !== runId || !envCatalog.P0_02_APP_DATABASE_URL) throw new Error('INSTANCE_ENV_INVALID');
    record('pre', 'instance', true, `${instance.host}:${instance.port}/${instance.dbName}`);
    evidence.arguments.runId = runId;

    const pgTools = ['pg_dump', 'pg_restore', 'createdb', 'dropdb'].map((name) => toolExe(instance.pgBinDir, name));
    const missingTools = pgTools.filter((file) => !fs.existsSync(file));
    record('pre', 'pg-tools', missingTools.length === 0, missingTools.length ? `缺少 ${missingTools.join(', ')}` : instance.pgBinDir);
    if (missingTools.length) throw new Error('PG_TOOLS_MISSING');
    const migrationPath = path.join(REPO_ROOT, MIGRATION_015);
    record('pre', 'migration-015-present', fs.existsSync(migrationPath), MIGRATION_015);
    if (!fs.existsSync(migrationPath)) throw new Error('MIGRATION_015_MISSING');

    // 快照结构 / 契约 / 内容哈希
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    reader.assertSnapshotShape(snapshot);
    record('pre', 'snapshot-contract', snapshot.contract === contract.SNAPSHOT_CONTRACT, snapshot.contract);
    record('pre', 'snapshot-key', reader.verifySnapshotKey(snapshot), `快照内容哈希与 snapshotKey 一致（${snapshot.snapshotKey.slice(0, 12)}…）`);
    record('pre', 'snapshot-complete', snapshot.collection.complete === true && snapshot.collection.truncated === false && snapshot.collection.readError === null,
      jsonOf({ complete: snapshot.collection.complete, truncated: snapshot.collection.truncated, readError: snapshot.collection.readError }));
    record('pre', 'snapshot-origin', snapshot.origin === 'real_capture', snapshot.origin);
    record('pre', 'snapshot-profile', snapshot.profileKey === SOURCE_PROFILE.profileKey, snapshot.profileKey);
    const headerResolution = headersMod.resolveHeaderMapping(snapshot.collection.headers);
    record('pre', 'snapshot-headers', headerResolution.ok, headerResolution.issues.map((issue) => issue.detail).join('; '));
    if (!headerResolution.ok) throw new Error('SNAPSHOT_HEADERS_INVALID');
    const businessRows = snapshot.rows.filter((row) => row.isBusinessRow);
    const uniqueCodes = new Set();
    for (const row of businessRows) {
      const code = row.fields?.iceCode?.state === 'observed' ? normalizeMod.normalizeCellText(row.fields.iceCode.raw) : '';
      if (code !== '') uniqueCodes.add(code);
    }
    evidence.snapshot = {
      file: snapshotPath,
      sha256: sha256File(snapshotPath),
      bytes: fs.statSync(snapshotPath).size,
      contract: snapshot.contract,
      origin: snapshot.origin,
      capturedAt: snapshot.capturedAt,
      snapshotKey: snapshot.snapshotKey,
      gridRows: snapshot.collection.gridRows,
      gridColumns: snapshot.collection.gridColumns,
      storedRows: snapshot.rows.length,
      businessRows: businessRows.length,
      emptyRows: snapshot.rows.length - businessRows.length,
      uniqueCodes: uniqueCodes.size,
      restrictedColumns: headerResolution.restrictedColumns,
      redaction: snapshot.redaction ?? null,
      simulation: snapshot.simulation ?? null,
    };
    log(`快照：${snapshot.origin} ${snapshot.collection.businessRowCount} 业务行 / ${uniqueCodes.size} 唯一货号 / 价格列 ${jsonOf(headerResolution.restrictedColumns)}`);

    const liveEnv = liveDbEnv(instance);
    const live = new Client({
      host: instance.host,
      port: instance.port,
      user: instance.bootstrapUser,
      password: instance.bootstrapPassword,
      database: instance.dbName,
      application_name: 'iceos-verify-live-readonly',
    });
    const liveQuery = async (sql, params = []) => {
      if (!/^\s*select\b/i.test(sql)) throw new Error('LIVE_WRITE_DENIED: 现役库只允许 SELECT');
      return (await live.query(sql, params)).rows;
    };
    await live.connect();
    const readLiveStats = async () => {
      await live.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        const has015 = Number((await liveQuery(
          `SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
           WHERE n.nspname='catalog' AND p.proname='apply_product_source_batch'`,
        ))[0].n) > 0;
        const stats = {
          database: (await liveQuery('SELECT current_database() AS database, inet_server_port() AS port'))[0],
          has015,
          catalogItem: Number((await liveQuery('SELECT count(*)::int AS n FROM catalog.catalog_item'))[0].n),
          catalogItemCode: Number((await liveQuery('SELECT count(*)::int AS n FROM catalog.catalog_item_code'))[0].n),
          itemRevision: Number((await liveQuery('SELECT count(*)::int AS n FROM catalog.item_revision'))[0].n),
          productSource: null,
        };
        if (has015) {
          const one = async (table) => Number((await liveQuery(`SELECT count(*)::int AS n FROM ${table}`))[0].n);
          stats.productSource = {
            profile: await one('catalog.product_source_profile'),
            batch: await one('catalog.product_source_batch'),
            binding: await one('catalog.product_source_binding'),
            adoption: await one('catalog.product_source_adoption'),
            result: await one('catalog.product_source_result'),
            issue: await one('catalog.product_source_issue'),
          };
        }
        return stats;
      } finally {
        await live.query('COMMIT');
      }
    };
    evidence.live.before = await readLiveStats();
    log(`现役库只读统计（before）：items=${evidence.live.before.catalogItem} revisions=${evidence.live.before.itemRevision} has015=${evidence.live.before.has015}`);

    // ------------------------------------------------------------------
    // setup：dump → createdb → pg_restore → (015) → app 身份
    // ------------------------------------------------------------------
    scratchDb = `${SCRATCH_PREFIX}${stamp.replace(/[-:tz]/gi, '').toLowerCase()}`.slice(0, 63);
    if (!SCRATCH_DB_NAME.test(scratchDb)) throw new Error(`SCRATCH_DB_NAME_INVALID: ${scratchDb}`);
    const dumpFile = path.join(verifyDir, `live-${stamp}.dump`);
    tempFiles.push(dumpFile);
    const logsDir = path.join(verifyDir, 'logs');
    const dump = runToLog(toolExe(instance.pgBinDir, 'pg_dump'), [
      '--host', instance.host,
      '--port', String(instance.port),
      '--username', instance.bootstrapUser,
      '--dbname', instance.dbName,
      '--format=custom',
      '--no-password',
      '--file', dumpFile,
    ], { env: liveEnv, logFile: path.join(logsDir, `pg_dump-${stamp}.log`) });
    const dumpBytes = fs.statSync(dumpFile).size;
    record('setup', 'dump', dumpBytes > 0, `${dumpBytes} bytes / ${dump.durationMs}ms`);
    if (dumpBytes === 0) throw new Error('DUMP_EMPTY');

    const created = runToLog(toolExe(instance.pgBinDir, 'createdb'), [
      '--host', instance.host,
      '--port', String(instance.port),
      '--username', instance.bootstrapUser,
      '--owner', instance.bootstrapUser,
      scratchDb,
    ], { env: liveEnv, logFile: path.join(logsDir, `createdb-${stamp}.log`) });
    scratchCreated = true;
    record('setup', 'createdb', true, `${scratchDb}（${created.durationMs}ms）`);
    const restored = runToLog(toolExe(instance.pgBinDir, 'pg_restore'), [
      '--host', instance.host,
      '--port', String(instance.port),
      '--username', instance.bootstrapUser,
      '--dbname', scratchDb,
      '--no-password',
      '--exit-on-error',
      dumpFile,
    ], { env: liveEnv, logFile: path.join(logsDir, `pg_restore-${stamp}.log`) });
    record('setup', 'restore', true, `${restored.durationMs}ms`);

    owner = new Client({
      host: instance.host,
      port: instance.port,
      user: instance.bootstrapUser,
      password: instance.bootstrapPassword,
      database: scratchDb,
      application_name: 'iceos-verify-scratch-owner',
    });
    await owner.connect();
    // owner 连接作为 superuser 绕过 RLS；仍然设置 admin claim，便于诊断与一致性。
    await owner.query(`SELECT set_config('request.jwt.claim.sub',$1,false)`, [ADMIN_ID]);
    const ownerQuery = async (sql, params = []) => (await owner.query(sql, params)).rows;
    const identityRow = (await ownerQuery('SELECT current_database() AS database, inet_server_port() AS port, current_user AS runtime'))[0];
    record('setup', 'scratch-target', identityRow.database === scratchDb && Number(identityRow.port) === Number(instance.port)
      && identityRow.database !== instance.dbName, jsonOf({ database: identityRow.database, port: Number(identityRow.port) }));
    if (identityRow.database !== scratchDb || identityRow.database === instance.dbName) throw new Error('SCRATCH_TARGET_MISMATCH');

    // 现役库可能尚未应用 015：scratch 里补上（只写 scratch；现役已含 015 时自动跳过）。
    let migrationApplied = false;
    const has015InScratch = Number((await ownerQuery(
      `SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='catalog' AND p.proname='apply_product_source_batch'`,
    ))[0].n) > 0;
    if (!has015InScratch) {
      const sql = fs.readFileSync(migrationPath, 'utf8');
      await owner.query(sql);
      await owner.query('RESET ROLE; RESET ALL');
      await owner.query(`SELECT set_config('request.jwt.claim.sub',$1,false)`, [ADMIN_ID]);
      migrationApplied = true;
      log(`scratch 已应用 ${MIGRATION_015}（现役库未包含 015 表/函数）`);
      evidence.notes.push('现役库未包含 015 产品来源表/函数：本轮在 scratch 上应用 015 后才验证，因此结论只证明 015 在复制库上的行为。');
    }
    const migrationReady = Number((await ownerQuery(
      `SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='catalog' AND p.proname IN('apply_product_source_batch','read_product_source_overview','read_product_source_item_state')`,
    ))[0].n) === 3;
    record('setup', 'migration-015', migrationReady, migrationApplied ? '在 scratch 上应用 015' : 'scratch 已含 015');
    if (!migrationReady) throw new Error('MIGRATION_015_NOT_READY');

    // app runner 连接（与现役 app 同一角色、同一集群，只换数据库名）
    const appUrl = new URL(envCatalog.P0_02_APP_DATABASE_URL);
    appUrl.pathname = `/${scratchDb}`;
    const withApp = async (identity, fn) => {
      const client = new Client({ connectionString: appUrl.toString(), application_name: 'iceos-verify-scratch-app' });
      await client.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`, [identity ?? '']);
        const value = await fn(client);
        await client.query('COMMIT');
        return value;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        await client.end();
      }
    };
    const appRow = async (sql, params = []) => withApp(ADMIN_ID, async (client) => (await client.query(sql, params)).rows);
    const adminOk = (await appRow('SELECT catalog.is_admin() AS ok'))[0].ok === true;
    record('setup', 'admin-identity', adminOk, `app runner + ${ADMIN_ID}（catalog.is_admin()=${adminOk}）`);
    if (!adminOk) throw new Error('ADMIN_IDENTITY_NOT_READY');

    const ctx = {
      instance, envCatalog, snapshot, snapshotPath, verifyDir, logFile, log, stamp, token,
      contract, reader, headersMod, normalizeMod, planMod,
      owner, ownerQuery, withApp, appRow, headerResolution,
      clockMs: Math.max(Date.now(), Date.parse(snapshot.capturedAt) + 60_000),
      profile: SOURCE_PROFILE,
      evidence,
    };
    evidence.scratch = {
      dbName: scratchDb,
      dump: { bytes: dumpBytes, sha256: sha256File(dumpFile), durationMs: dump.durationMs },
      restoreDurationMs: restored.durationMs,
      migrationApplied,
      kept: keep,
      dropped: false,
    };

    // ------------------------------------------------------------------
    // 计划输入读取（与 service.loadPlanInputs 完全相同的只读查询）
    // ------------------------------------------------------------------
    const loadPlanInputs = async () => withApp(ADMIN_ID, async (client) => {
      await client.query('SELECT catalog.require_admin()');
      const bindings = await client.query(
        `SELECT b.item_id, b.ice_code, b.state
         FROM catalog.product_source_binding b
         JOIN catalog.product_source_profile p ON p.id = b.profile_id
         WHERE p.profile_key = $1`,
        [SOURCE_PROFILE.profileKey],
      );
      const items = await client.query(
        `SELECT i.id, c.revision, r.ice_code_snapshot AS ice_code, r.name_cn, r.fields
         FROM catalog.catalog_item i
         JOIN catalog.item_current c ON c.item_id = i.id
         JOIN catalog.item_revision r ON r.item_id = i.id AND r.revision = c.revision`,
      );
      const adoptions = await client.query(
        `SELECT a.item_id, a.field_key, a.adopted_raw, a.adopted_state, a.unit_state
         FROM catalog.product_source_adoption a
         JOIN catalog.product_source_profile p ON p.id = a.profile_id
         WHERE p.profile_key = $1`,
        [SOURCE_PROFILE.profileKey],
      );
      const applied = await client.query(
        `SELECT b.snapshot_key, b.captured_at, b.status
         FROM catalog.product_source_batch b
         JOIN catalog.product_source_profile p ON p.id = b.profile_id
         WHERE p.profile_key = $1 AND b.status IN ('applied','partial')
         ORDER BY b.captured_at`,
        [SOURCE_PROFILE.profileKey],
      );
      return {
        bindings: bindings.rows.map((row) => ({ itemId: row.item_id, iceCode: row.ice_code, state: row.state })),
        items: items.rows.map((row) => ({
          itemId: row.id,
          revision: Number(row.revision),
          iceCode: row.ice_code,
          nameCn: row.name_cn,
          fields: row.fields ?? {},
        })),
        adoptions: adoptions.rows.map((row) => ({
          itemId: row.item_id,
          fieldKey: row.field_key,
          adoptedRaw: row.adopted_raw,
          adoptedState: row.adopted_state,
          unitState: row.unit_state,
        })),
        appliedSnapshots: applied.rows.map((row) => ({ snapshotKey: row.snapshot_key, capturedAt: row.captured_at, status: row.status })),
      };
    });
    const buildPlanFor = async (snapshotInput) => {
      const inputs = await loadPlanInputs();
      const plan = planMod.buildPlan({
        snapshot: snapshotInput,
        bindings: inputs.bindings,
        items: inputs.items,
        adoptions: inputs.adoptions,
        appliedSnapshots: inputs.appliedSnapshots,
        latestAppliedCapturedAt: inputs.appliedSnapshots.length
          ? inputs.appliedSnapshots[inputs.appliedSnapshots.length - 1].capturedAt
          : null,
      });
      return { plan, inputs };
    };
    ctx.buildPlanFor = buildPlanFor;

    // 证据工件与 p_batch/p_plan 构造（与 service.applySnapshot 同一调用链）
    const artifactList = (() => {
      const base = snapshotPath.replace(/\.json$/i, '');
      const candidates = [
        { file: snapshotPath, role: 'snapshot', format: 'json' },
        { file: `${base}.capture.tsv`, role: 'raw_capture', format: 'tsv' },
        { file: `${base}.capture-metadata.json`, role: 'metadata', format: 'json' },
      ];
      return candidates.filter((entry) => fs.existsSync(entry.file)).map((entry) => {
        const bytes = fs.readFileSync(entry.file);
        return {
          logicalName: path.basename(entry.file),
          sha256: sha256Hex(bytes),
          size: bytes.length,
          format: entry.format,
          storageHandle: `file://${entry.file.split(path.sep).join('/')}`,
          role: entry.role,
        };
      });
    })();
    const adoptionDigest = (plan) => sha256Hex(contract.canonicalJson(
      plan.results.map((result) => ({ sourceKey: result.sourceKey, adoptions: result.adoptions })),
    ));
    const buildBatchFor = (snapshotInput, plan) => planMod.buildBatchPayload({
      snapshot: snapshotInput,
      plan,
      artifacts: artifactList,
      adoptionSha256: adoptionDigest(plan),
      parentBatchId: null,
      retryOfBatchId: null,
    });
    const submitApply = async (batch, planPayload) => {
      const requestId = crypto.randomUUID();
      const intent = sha256Hex(jsonOf([
        'iceos-product-source-request-v1',
        ADMIN_ID,
        APPLY_ACTION,
        { profile: SOURCE_PROFILE, batch: batch.snapshotKey, plan: planPayload },
      ]));
      const payload = { profile: SOURCE_PROFILE, batch, plan: planPayload };
      const recorded = await appRow(
        'SELECT catalog.record_product_source_request_intent($1,$2,$3,$4,$5,$6::jsonb) AS result',
        [requestId, intent, APPLY_ACTION, SOURCE_PROFILE.profileKey, batch.snapshotKey, jsonOf(payload)],
      );
      const receipt = await appRow(
        'SELECT catalog.apply_product_source_batch($1,$2,$3::jsonb,$4::jsonb,$5::jsonb) AS result',
        [requestId, intent, jsonOf(SOURCE_PROFILE), jsonOf(batch), jsonOf(planPayload)],
      );
      return { requestId, intent, recorded: recorded[0].result, receipt: receipt[0].result };
    };
    const readOverview = async () => (await appRow('SELECT catalog.read_product_source_overview($1) AS result', [SOURCE_PROFILE.profileKey]))[0].result;
    const readItemState = async (itemId) => (await appRow('SELECT catalog.read_product_source_item_state($1) AS result', [itemId]))[0].result;
    const expectedAmountsOf = (snapshotInput, restricted) => {
      const rows = [];
      for (const row of snapshotInput.rows) {
        const payload = {};
        for (const key of RESTRICTED_KEYS) {
          const column = restricted[key];
          if (!column) continue;
          const raw = row.cells?.[column];
          if (typeof raw === 'string' && raw !== '') payload[key] = raw;
        }
        if (Object.keys(payload).length > 0) rows.push({ rowNumber: row.rowNumber, payload });
      }
      return rows;
    };
    const amountsEqual = (left, right) => contract.canonicalJson(left) === contract.canonicalJson(right);
    const priceValuesOf = (amounts) => {
      const values = new Set();
      for (const entry of amounts) {
        for (const value of Object.values(entry.payload)) if (typeof value === 'string' && value !== '') values.add(value);
      }
      return [...values];
    };
    const priceValueSetOf = (amounts) => new Set(
      priceValuesOf(amounts).map((value) => normalizeMod.normalizeCellText(value)).filter((value) => value !== ''),
    );
    const collectStrings = (value, out = []) => {
      if (typeof value === 'string') out.push(value);
      else if (Array.isArray(value)) { for (const item of value) collectStrings(item, out); }
      else if (value !== null && typeof value === 'object') {
        for (const [key, inner] of Object.entries(value)) { out.push(key); collectStrings(inner, out); }
      }
      return out;
    };
    /**
     * 只做“值完全相等”的比对，绝不使用子串包含：真实价格多为 0.5 / 5.18 这类短数字，
     * 子串匹配会把 10.5、100.5 等普通数值误判为价格泄漏。
     */
    const leaksExactValue = (payload, valueSet) => collectStrings(payload)
      .some((text) => valueSet.has(normalizeMod.normalizeCellText(text)));
    const cellValuesOf = (cells, restrictedColumns) => Object.entries(cells ?? {})
      .filter(([column]) => !restrictedColumns.includes(column))
      .map(([, raw]) => normalizeMod.normalizeCellText(String(raw)));

    // ------------------------------------------------------------------
    // 场景 A：真实快照首次采用
    // ------------------------------------------------------------------
    const scenarioA = async () => {
      const baselineRevisions = new Map();
      for (const row of await ownerQuery('SELECT item_id, revision FROM catalog.item_current')) {
        baselineRevisions.set(row.item_id, Number(row.revision));
      }
      const itemCountBefore = Number((await ownerQuery('SELECT count(*)::int AS n FROM catalog.catalog_item'))[0].n);
      const codeCountBefore = Number((await ownerQuery('SELECT count(*)::int AS n FROM catalog.catalog_item_code'))[0].n);

      const { plan } = await buildPlanFor(snapshot);
      record('A', 'decision-apply', plan.decision === 'apply', `decision=${plan.decision}`);
      if (plan.decision !== 'apply') {
        evidence.scenarios.A = { ...(evidence.scenarios.A ?? {}), planDecision: plan.decision };
        return;
      }
      const manualCounts = countPlanResults(plan.results);
      record('A', 'counts-hint-consistent', sameCounts(manualCounts, plan.countsHint),
        jsonOf({ manual: manualCounts, hint: plan.countsHint }));
      record('A', 'plan-has-results', plan.results.length > 0, `results=${plan.results.length}`);
      record('A', 'plan-status-hint', ['applied', 'partial', 'failed'].includes(plan.batchStatusHint), plan.batchStatusHint);

      const planPayload = planMod.toPlanPayload(plan);
      record('A', 'plan-json-price-free', !PRICE_KEY_PATTERN.test(jsonOf(planPayload)), null);
      record('A', 'plan-expected-revisions', plan.results.every((result) => {
        if (!result.itemId || !(result.changes ?? []).length) return true;
        if (result.action !== 'update' && result.action !== 'needs_review') return true;
        const baseline = baselineRevisions.get(result.itemId);
        return baseline !== undefined && Number(result.expectedRevision) === baseline;
      }), 'update/needs_review 的 expectedRevision 等于计划时的 item_current.revision');

      const batch = buildBatchFor(snapshot, plan);
      const restrictedColumns = new Set(Object.values(headerResolution.restrictedColumns));
      const leakedCells = batch.rows.filter((row) => Object.keys(row.cells).some((column) => restrictedColumns.has(column))).length;
      record('A', 'batch-public-cells-stripped', leakedCells === 0, `公共 cells 含价格列的行走数=${leakedCells}`);
      record('A', 'batch-rows-count', batch.rows.length === snapshot.rows.length, `${batch.rows.length}/${snapshot.rows.length}`);
      record('A', 'batch-rows-sha', /^[a-f0-9]{64}$/.test(batch.rowsSha256) && /^[a-f0-9]{64}$/.test(batch.adoptionSha256), null);

      const submitted = await submitApply(batch, planPayload);
      ctx.batchA = batch;
      ctx.planA = plan;
      ctx.receiptA = submitted.receipt;
      ctx.requestA = submitted.requestId;
      record('A', 'intent-recorded', submitted.recorded?.recorded === true, jsonOf(submitted.recorded ?? null));
      const receipt = submitted.receipt;
      record('A', 'receipt-status', receipt.status === plan.batchStatusHint, `receipt=${receipt.status} hint=${plan.batchStatusHint}`);
      record('A', 'receipt-counts', sameCounts(receipt.counts, plan.countsHint), jsonOf({ receipt: receipt.counts, plan: plan.countsHint }));
      record('A', 'receipt-results-count', (receipt.results ?? []).length === plan.results.length, `${(receipt.results ?? []).length}/${plan.results.length}`);

      const receiptByKey = new Map((receipt.results ?? []).map((row) => [row.sourceKey, row]));
      const mismatched = plan.results.filter((result) => {
        const dbRow = receiptByKey.get(result.sourceKey);
        if (!dbRow) return true;
        if (dbRow.action !== result.action) return true;
        if (String(dbRow.reasonCode ?? '') !== String(result.reasonCode ?? '')) return true;
        if ((result.itemId ?? null) !== (dbRow.itemId ?? null)) return true;
        return false;
      });
      record('A', 'receipt-results-match-plan', mismatched.length === 0, `不一致 ${mismatched.length} 项`);

      // item_current.revision：有且仅有计划中的变更
      const createdIds = new Set();
      for (const row of receipt.results ?? []) {
        if (row.action !== 'create') continue;
        if (!row.itemId) {
          record('A', 'create-item-id', false, `create 结果缺少 itemId：${row.sourceKey}`);
          continue;
        }
        createdIds.add(row.itemId);
      }
      const writes = new Set();
      for (const result of plan.results) {
        if (!result.itemId) continue;
        if ((result.changes ?? []).length === 0) continue;
        if (result.action === 'update' || result.action === 'needs_review') writes.add(result.itemId);
      }
      const afterRevisions = new Map();
      for (const row of await ownerQuery('SELECT item_id, revision FROM catalog.item_current')) {
        afterRevisions.set(row.item_id, Number(row.revision));
      }
      const expectedRevisions = new Map(baselineRevisions);
      for (const itemId of writes) {
        if (!baselineRevisions.has(itemId)) {
          record('A', 'write-target-existing', false, `写入目标不是既有商品：${itemId}`);
          continue;
        }
        expectedRevisions.set(itemId, baselineRevisions.get(itemId) + 1);
      }
      let createdRevisionOk = true;
      for (const itemId of createdIds) {
        if (baselineRevisions.has(itemId) || afterRevisions.get(itemId) !== 1) createdRevisionOk = false;
        expectedRevisions.set(itemId, 1);
      }
      record('A', 'created-items-fresh', createdRevisionOk, `新建 ${createdIds.size} 个，均为新 UUID 且 revision=1`);
      const expectedEntries = sortedEntries(expectedRevisions);
      const afterEntries = sortedEntries(afterRevisions);
      record('A', 'item-revisions-exact', jsonOf(expectedEntries) === jsonOf(afterEntries),
        `expected=${expectedEntries.length} after=${afterEntries.length}（应有 ${writes.size} 个 +1 修订，${createdIds.size} 个新建）`);

      const itemCountAfter = Number((await ownerQuery('SELECT count(*)::int AS n FROM catalog.catalog_item'))[0].n);
      const codeCountAfter = Number((await ownerQuery('SELECT count(*)::int AS n FROM catalog.catalog_item_code'))[0].n);
      record('A', 'no-extra-items', itemCountAfter - itemCountBefore === createdIds.size, `items +${itemCountAfter - itemCountBefore}，计划新建 ${createdIds.size}`);
      record('A', 'no-extra-codes', codeCountAfter - codeCountBefore === createdIds.size, `codes +${codeCountAfter - codeCountBefore}，计划新建 ${createdIds.size}`);
      const duplicateCodes = await ownerQuery('SELECT ice_code, count(*)::int AS n FROM catalog.catalog_item_code GROUP BY 1 HAVING count(*)>1');
      record('A', 'codes-unique', duplicateCodes.length === 0, `重复货号 ${duplicateCodes.length}`);

      // binding：只指向既有 UUID（或本次新建），集合等于计划中会绑定/更新的商品
      const bindsSet = new Set();
      for (const result of plan.results) {
        if (!result.itemId) continue;
        const willBind = result.action === 'create' || result.action === 'update' || result.action === 'unchanged'
          || (result.action === 'needs_review' && result.nextFields !== null);
        if (willBind) bindsSet.add(result.itemId);
      }
      for (const itemId of createdIds) bindsSet.add(itemId);
      const bindings = await ownerQuery(
        `SELECT b.item_id, b.ice_code, b.state FROM catalog.product_source_binding b
         JOIN catalog.product_source_profile p ON p.id=b.profile_id WHERE p.profile_key=$1`,
        [SOURCE_PROFILE.profileKey],
      );
      const bindingIds = new Set(bindings.map((row) => row.item_id));
      const bindingExtra = [...bindingIds].filter((itemId) => !bindsSet.has(itemId));
      const bindingMissing = [...bindsSet].filter((itemId) => !bindingIds.has(itemId));
      record('A', 'bindings-match-plan', bindingExtra.length === 0 && bindingMissing.length === 0,
        `多 ${bindingExtra.length} / 少 ${bindingMissing.length}`);
      record('A', 'bindings-existing-items', [...bindingIds].every((itemId) => afterRevisions.has(itemId)),
        `binding=${bindingIds.size}，全部指向 catalog_item 既有 UUID`);

      // adoption baseline：计划声明的采用值必须原样落库
      const dbAdoptions = await ownerQuery(
        `SELECT a.item_id, a.field_key, a.adopted_raw, a.adopted_state, a.unit_state
         FROM catalog.product_source_adoption a
         JOIN catalog.product_source_profile p ON p.id=a.profile_id WHERE p.profile_key=$1`,
        [SOURCE_PROFILE.profileKey],
      );
      const dbAdoptionMap = new Map(dbAdoptions.map((row) => [`${row.item_id}|${row.field_key}`, row]));
      /**
       * 只有真正写库的结果才落 adoption：create / update / unchanged /
       * needs_review（nextFields!==null 的部分写入）。needs_review 且 nextFields===null 表示
       * 整项延后（契约：不写修订、也不写采用基线），数据库按契约忽略该结果的 adoptions。
       */
      const adoptionWritten = (result) => Boolean(result.itemId) && (
        result.action === 'create' || result.action === 'update' || result.action === 'unchanged'
        || (result.action === 'needs_review' && result.nextFields !== null)
      );
      const expectedAdoptions = new Map();
      for (const result of plan.results) {
        if (!adoptionWritten(result)) continue;
        for (const adoption of result.adoptions ?? []) {
          expectedAdoptions.set(`${result.itemId}|${adoption.fieldKey}`, adoption);
        }
      }
      let adoptionMismatch = 0;
      const adoptionMismatchDetail = [];
      for (const [key, expected] of expectedAdoptions) {
        const dbRow = dbAdoptionMap.get(key);
        if (!dbRow) {
          adoptionMismatch += 1;
          if (adoptionMismatchDetail.length < 8) adoptionMismatchDetail.push({ key, reason: 'MISSING_IN_DB' });
          continue;
        }
        const dbRaw = dbRow.adopted_raw === null ? null : normalizeMod.normalizeCellText(dbRow.adopted_raw);
        const expectedRaw = expected.raw === null ? null : normalizeMod.normalizeCellText(expected.raw);
        const dbRawNorm = dbRaw === '' ? null : dbRaw;
        const expectedRawNorm = expectedRaw === '' ? null : expectedRaw;
        if (dbRawNorm !== expectedRawNorm || dbRow.adopted_state !== expected.state || dbRow.unit_state !== expected.unitState) {
          adoptionMismatch += 1;
          if (adoptionMismatchDetail.length < 8) {
            adoptionMismatchDetail.push({
              key,
              expected: { raw: expectedRawNorm, state: expected.state, unit: expected.unitState },
              actual: { raw: dbRawNorm, state: dbRow.adopted_state, unit: dbRow.unit_state },
            });
          }
        }
      }
      record('A', 'adoptions-match-plan', adoptionMismatch === 0,
        `校验 ${expectedAdoptions.size} 条，不一致 ${adoptionMismatch}${adoptionMismatchDetail.length ? `；样例 ${jsonOf(adoptionMismatchDetail)}` : ''}`);
      const deferred = plan.results.filter((result) => result.itemId && result.action === 'needs_review'
        && result.nextFields === null && (result.adoptions ?? []).length > 0);
      const deferredWroteAdoption = deferred.filter((result) => (result.adoptions ?? [])
        .some((adoption) => dbAdoptionMap.has(`${result.itemId}|${adoption.fieldKey}`)));
      record('A', 'deferred-review-keeps-no-adoption', deferredWroteAdoption.length === 0,
        `整项延后（needs_review+nextFields=null）结果 ${deferred.length} 个，数据库未写其采用基线（符合契约）`);
      const strayAdoptions = dbAdoptions.filter((row) => !createdIds.has(row.item_id) && !expectedAdoptions.has(`${row.item_id}|${row.field_key}`));
      record('A', 'adoptions-no-stray', strayAdoptions.length === 0, `非计划采用 ${strayAdoptions.length} 条（新建商品的可由 nextFields 推导）`);

      // 批次 / 行证据落库
      const batchRow = (await ownerQuery(
        `SELECT b.id,b.status,b.counts,b.rows_sha256,b.origin,b.captured_at,b.release_id,b.record_artifact_id
         FROM catalog.product_source_batch b
         JOIN catalog.product_source_profile p ON p.id=b.profile_id
         WHERE p.profile_key=$1 AND b.snapshot_key=$2 AND b.retry_of_batch_id IS NULL`,
        [SOURCE_PROFILE.profileKey, snapshot.snapshotKey],
      ))[0];
      record('A', 'batch-persisted', Boolean(batchRow) && batchRow.status === receipt.status && batchRow.rows_sha256 === batch.rowsSha256,
        batchRow ? `status=${batchRow.status} origin=${batchRow.origin}` : '找不到批次');
      record('A', 'batch-counts-persisted', Boolean(batchRow) && sameCounts(batchRow.counts, receipt.counts), jsonOf(batchRow?.counts ?? null));
      record('A', 'batch-evidence-linked', Boolean(batchRow?.release_id) && Boolean(batchRow?.record_artifact_id),
        jsonOf({ releaseId: Boolean(batchRow?.release_id), recordArtifactId: Boolean(batchRow?.record_artifact_id) }));
      const rowCounts = (await ownerQuery(
        `SELECT count(*)::int AS rows, count(*) FILTER (WHERE is_empty)::int AS empty
         FROM catalog.product_source_row r JOIN catalog.product_source_batch b ON b.id=r.batch_id
         WHERE b.snapshot_key=$1`,
        [snapshot.snapshotKey],
      ))[0];
      record('A', 'batch-rows-persisted', Number(rowCounts.rows) === snapshot.rows.length
        && Number(rowCounts.empty) === snapshot.rows.length - businessRows.length,
        `rows=${rowCounts.rows} empty=${rowCounts.empty}`);

      evidence.scenarios.A = {
        requestId: submitted.requestId,
        batchId: receipt.batchId,
        status: receipt.status,
        counts: receipt.counts,
        planCounts: plan.countsHint,
        planResults: plan.results.length,
        created: createdIds.size,
        writes: writes.size,
        bindingCount: bindingIds.size,
      };
      ctx.overviewAfterA = await readOverview();
      ctx.sampleItemId = (receipt.results ?? []).find((row) => row.action === 'update' || row.action === 'unchanged')?.itemId ?? null;
      ctx.itemStateAfterA = ctx.sampleItemId ? await readItemState(ctx.sampleItemId) : null;
    };

    // ------------------------------------------------------------------
    // 场景 B：同一快照重复应用（幂等）
    // ------------------------------------------------------------------
    const scenarioB = async () => {
      if (!ctx.receiptA) {
        record('B', 'precondition', false, '场景 A 未成功，无法验证重复应用');
        return;
      }
      const { plan } = await buildPlanFor(snapshot);
      record('B', 'decision-replay', plan.decision === 'replay', `decision=${plan.decision}`);
      record('B', 'plan-empty', plan.results.length === 0, `results=${plan.results.length}`);
      record('B', 'plan-already-applied-issue', (plan.issues ?? []).some((issue) => issue.kind === 'already_applied'), null);

      const countState = async () => ({
        items: Number((await ownerQuery('SELECT count(*)::int AS n FROM catalog.catalog_item'))[0].n),
        revisions: Number((await ownerQuery('SELECT count(*)::int AS n FROM catalog.item_revision'))[0].n),
        batches: Number((await ownerQuery('SELECT count(*)::int AS n FROM catalog.product_source_batch'))[0].n),
        results: Number((await ownerQuery('SELECT count(*)::int AS n FROM catalog.product_source_result'))[0].n),
        adoptions: Number((await ownerQuery('SELECT count(*)::int AS n FROM catalog.product_source_adoption'))[0].n),
      });
      const before = await countState();
      const submitted = await submitApply(ctx.batchA, planMod.toPlanPayload(plan));
      const receipt = submitted.receipt;
      record('B', 'receipt-duplicate', receipt.status === 'duplicate', `status=${receipt.status}`);
      record('B', 'receipt-original-status', String(receipt.originalStatus) === String(ctx.receiptA.status), `${receipt.originalStatus} vs ${ctx.receiptA.status}`);
      record('B', 'receipt-same-batch', receipt.batchId === ctx.receiptA.batchId, `${receipt.batchId ?? null}`);
      record('B', 'receipt-counts', sameCounts(receipt.counts, ctx.receiptA.counts), jsonOf({ duplicate: receipt.counts }));
      record('B', 'receipt-results-count', (receipt.results ?? []).length === (ctx.receiptA.results ?? []).length,
        `${(receipt.results ?? []).length}/${(ctx.receiptA.results ?? []).length}`);
      const after = await countState();
      record('B', 'no-new-rows', jsonOf(before) === jsonOf(after), jsonOf({ before, after }));
      evidence.scenarios.B = {
        requestId: submitted.requestId,
        status: receipt.status,
        originalStatus: receipt.originalStatus,
        counts: receipt.counts,
      };
    };

    // ------------------------------------------------------------------
    // 场景 D：真实快照价格隔离（按表头文字定位价格列）
    // ------------------------------------------------------------------
    const scenarioD = async () => {
      const restricted = headerResolution.restrictedColumns;
      const restrictedKeys = Object.keys(restricted).sort();
      record('D', 'restricted-keys', jsonOf(restrictedKeys) === jsonOf([...RESTRICTED_KEYS].sort()), jsonOf(restricted));
      const labelMatches = RESTRICTED_KEYS.every((key) => {
        const column = restricted[key];
        if (!column) return false;
        const label = headersMod.normalizeHeaderLabel(snapshot.collection.headers[column] ?? '');
        return label === RESTRICTED_LABELS[key];
      });
      record('D', 'restricted-by-header-text', labelMatches,
        `按表头文字定位：${RESTRICTED_KEYS.map((key) => `${RESTRICTED_LABELS[key]}→${restricted[key] ?? '缺失'}`).join(' / ')}`);
      const expectedAmounts = expectedAmountsOf(snapshot, restricted);
      const priceValueSet = priceValueSetOf(expectedAmounts);
      /*
       * 真实价格是 12.345… 这类普通数字，其中少数（如 4、5、0）会合法地同时出现在
       * 普通产品列（长/宽/数量…）里。只有“仅出现在价格列、在普通列中从不出现”的价格值
       * 才能作为泄漏指纹；普通列中也存在的值属于数值巧合，不能作为泄漏证据。
       */
      const restrictedColumnSet = new Set(Object.values(restricted));
      const nonRestrictedValues = new Set();
      for (const row of snapshot.rows) {
        for (const [column, raw] of Object.entries(row.cells ?? {})) {
          if (restrictedColumnSet.has(column) || typeof raw !== 'string') continue;
          const text = normalizeMod.normalizeCellText(raw);
          if (text !== '') nonRestrictedValues.add(text);
        }
      }
      const distinctivePriceValueSet = new Set([...priceValueSet].filter((value) => !nonRestrictedValues.has(value)));
      const coincidentPriceValues = [...priceValueSet].filter((value) => nonRestrictedValues.has(value));
      record('D', 'expected-amounts', true,
        `快照非空价格单元格行数=${expectedAmounts.length}；价格值=${priceValueSet.size}（可作泄漏指纹=${distinctivePriceValueSet.size}，普通列数值巧合=${coincidentPriceValues.length}）；脱敏=${Boolean(snapshot.redaction?.priceValuesRemoved)}`);

      if (ctx.batchA) {
        record('D', 'batch-amounts-exact', amountsEqual(ctx.batchA.amounts ?? [], expectedAmounts),
          `batch.amounts=${(ctx.batchA.amounts ?? []).length}/${expectedAmounts.length}`);
        const restrictedColumnSet = new Set(Object.values(restricted));
        const leaked = (ctx.batchA.rows ?? []).filter((row) => Object.keys(row.cells).some((column) => restrictedColumnSet.has(column)));
        record('D', 'batch-public-cells-stripped', leaked.length === 0, `泄漏 ${leaked.length} 行`);
      }

      const dbAmounts = await ownerQuery(
        `SELECT r.row_number, a.payload
         FROM catalog_private.product_source_row_amounts a
         JOIN catalog.product_source_row r ON r.id = a.row_id
         JOIN catalog.product_source_batch b ON b.id = r.batch_id
         WHERE b.snapshot_key = $1
         ORDER BY r.row_number`,
        [snapshot.snapshotKey],
      );
      record('D', 'db-private-amounts-exact', amountsEqual(
        dbAmounts.map((row) => ({ rowNumber: Number(row.row_number), payload: row.payload })),
        expectedAmounts,
      ), `私有表 ${dbAmounts.length} 行 / 快照非空价格行 ${expectedAmounts.length}`);
      const dbCells = await ownerQuery(
        `SELECT r.row_number, r.cells
         FROM catalog.product_source_row r
         JOIN catalog.product_source_batch b ON b.id = r.batch_id
         WHERE b.snapshot_key = $1
         ORDER BY r.row_number`,
        [snapshot.snapshotKey],
      );
      const restrictedColumns = Object.values(restricted);
      const cellsLeak = dbCells.filter((row) => restrictedColumns.some((column) => Object.prototype.hasOwnProperty.call(row.cells ?? {}, column)));
      record('D', 'db-public-cells-stripped', cellsLeak.length === 0, `公共 cells 含价格列的行数=${cellsLeak.length}`);
      // 公共 cells 必须等于“来源行 cells 去掉价格列”：不新增、不残留、不改写
      const snapshotCellsByRow = new Map(snapshot.rows.map((row) => [row.rowNumber, row.cells ?? {}]));
      const cellMismatch = [];
      for (const row of dbCells) {
        const sourceCells = snapshotCellsByRow.get(Number(row.row_number)) ?? {};
        const expectedCells = {};
        for (const [column, raw] of Object.entries(sourceCells)) if (!restrictedColumnSet.has(column)) expectedCells[column] = raw;
        if (contract.canonicalJson(row.cells ?? {}) !== contract.canonicalJson(expectedCells)) cellMismatch.push(Number(row.row_number));
      }
      record('D', 'db-public-cells-equal-source-minus-restricted', cellMismatch.length === 0,
        `公共 cells 与“来源 cells − 价格列”不一致的行数=${cellMismatch.length}`);
      // 额外：可作指纹的价格值不得出现在公共 cells（普通列数值巧合已排除）
      const cellsDistinctiveLeak = dbCells.filter((row) => cellValuesOf(row.cells, restrictedColumns)
        .some((value) => distinctivePriceValueSet.has(value))).length;
      record('D', 'db-public-cells-no-distinctive-values', cellsDistinctiveLeak === 0,
        `公共 cells 出现“仅价格列才有”的值的行数=${cellsDistinctiveLeak}`);

      const publicPayloads = [
        ['receipt-A', ctx.receiptA],
        ['overview', ctx.overviewAfterA ?? (await readOverview())],
        ['item-state', ctx.itemStateAfterA],
      ].filter(([, payload]) => payload !== null && payload !== undefined);
      const payloadLeak = publicPayloads.filter(([, payload]) => {
        const text = jsonOf(payload);
        return PRICE_KEY_PATTERN.test(text) || leaksExactValue(payload, distinctivePriceValueSet);
      }).map(([name]) => name);
      record('D', 'public-payloads-price-free', payloadLeak.length === 0, `含价格语义键/价格指纹的公共输出：${payloadLeak.join(',') || '无'}`);

      evidence.scenarios.D = {
        restrictedColumns: restricted,
        expectedAmountRows: expectedAmounts.length,
        priceValueCount: priceValueSet.size,
        distinctivePriceValueCount: distinctivePriceValueSet.size,
        coincidentPriceValueCount: coincidentPriceValues.length,
        privateAmountRows: dbAmounts.length,
        publicCellMismatchRows: cellMismatch.length,
        note: snapshot.redaction?.priceValuesRemoved
          ? 'fixture 已脱敏价格列（I/J/Y 置空），因此真实快照的“价格值”核对在 D2 用合成哨兵值补齐。'
          : '真实快照：价格值按“值完全相等”核对，且已排除普通产品列中也存在的数值巧合（coincidentPriceValueCount）。',
      };
    };

    // ------------------------------------------------------------------
    // 场景 C：人工修改冲突（来源同字段也变化且值不同）
    // ------------------------------------------------------------------
    const scenarioC = async () => {
      if (!ctx.receiptA) {
        record('C', 'precondition', false, '场景 A 未成功，无法构造人工修改冲突');
        return;
      }
      const adoptions = await ownerQuery(
        `SELECT a.item_id, a.field_key, a.adopted_raw, a.adopted_state, a.unit_state
         FROM catalog.product_source_adoption a
         JOIN catalog.product_source_profile p ON p.id=a.profile_id
         WHERE p.profile_key=$1`,
        [SOURCE_PROFILE.profileKey],
      );
      const currentItems = await ownerQuery(
        `SELECT ic.item_id, ic.revision, r.ice_code_snapshot AS ice_code, r.name_cn, r.fields
         FROM catalog.item_current ic
         JOIN catalog.item_revision r ON r.item_id=ic.item_id AND r.revision=ic.revision`,
      );
      const bindings = await ownerQuery(
        `SELECT b.item_id, b.ice_code FROM catalog.product_source_binding b
         JOIN catalog.product_source_profile p ON p.id=b.profile_id
         WHERE p.profile_key=$1 AND b.state='active'`,
        [SOURCE_PROFILE.profileKey],
      );
      const rowsByCode = new Map();
      for (const row of snapshot.rows) {
        if (!row.isBusinessRow) continue;
        const code = row.fields?.iceCode?.state === 'observed' ? normalizeMod.normalizeCellText(row.fields.iceCode.raw) : '';
        if (code === '') continue;
        if (rowsByCode.has(code)) rowsByCode.set(code, null);
        else rowsByCode.set(code, row);
      }
      const itemById = new Map(currentItems.map((row) => [row.item_id, row]));
      const adoptionByItem = new Map();
      for (const row of adoptions) {
        if (!adoptionByItem.has(row.item_id)) adoptionByItem.set(row.item_id, new Map());
        adoptionByItem.get(row.item_id).set(row.field_key, row);
      }
      const baseRawOf = (itemId, fieldKey) => {
        const adoption = adoptionByItem.get(itemId)?.get(fieldKey);
        if (!adoption || adoption.adopted_state !== 'observed' || adoption.adopted_raw === null) return null;
        const text = normalizeMod.normalizeCellText(adoption.adopted_raw);
        return text === '' ? null : text;
      };
      const localRawOf = (item, fieldKey) => normalizeMod.localRawOf(item.fields?.[fieldKey]);

      let candidate = null;
      for (const binding of bindings) {
        if (!binding.ice_code || !itemById.has(binding.item_id)) continue;
        const row = rowsByCode.get(binding.ice_code);
        if (!row) continue;
        const item = itemById.get(binding.item_id);
        const conflictField = CONFLICT_SOURCE_FIELD_PREFERENCE.find((fieldKey) => baseRawOf(item.item_id, fieldKey) !== null);
        if (!conflictField) continue;
        const updateField = CONFLICT_UPDATE_FIELD_PREFERENCE.find((fieldKey) => {
          if (fieldKey === conflictField) return false;
          const base = baseRawOf(item.item_id, fieldKey);
          if (base === null) return false;
          const local = localRawOf(item, fieldKey);
          return local !== null && normalizeMod.areSameFieldValue(fieldKey, local, base);
        });
        if (!updateField) continue;
        candidate = { binding, item, row, conflictField, updateField };
        break;
      }
      record('C', 'candidate-found', Boolean(candidate),
        candidate ? `${candidate.binding.ice_code} item=${candidate.binding.item_id} 冲突字段=${candidate.conflictField} 更新字段=${candidate.updateField}` : '没有同时满足“基线非空 + 本地等于基线”的字段对');
      if (!candidate) {
        evidence.scenarios.C = { blocked: 'NO_CANDIDATE_ITEM' };
        return;
      }
      const fieldColumns = headerResolution.fieldColumns;
      const conflictColumn = fieldColumns[candidate.conflictField];
      const updateColumn = fieldColumns[candidate.updateField];
      record('C', 'field-columns', Boolean(conflictColumn) && Boolean(updateColumn) && conflictColumn !== updateColumn,
        `冲突列=${conflictColumn} 更新列=${updateColumn}`);
      if (!conflictColumn || !updateColumn || conflictColumn === updateColumn) return;

      const localManual = `人工修改-${token.slice(-8)}`;
      const sourceConflict = `来源变化-${token.slice(-8)}`;
      const sourceUpdate = `来源更新-${token.slice(-8)}`;
      const baseConflict = baseRawOf(candidate.item.item_id, candidate.conflictField);
      const baseUpdate = baseRawOf(candidate.item.item_id, candidate.updateField);
      record('C', 'values-distinct', baseConflict !== null && baseUpdate !== null
        && new Set([baseConflict, localManual, sourceConflict]).size === 3,
        '人工值/来源新值/基线值三者互不相同');

      // 1) 模拟人工改资料：追加 item_revision 并推进 item_current
      const prevFields = JSON.parse(jsonOf(candidate.item.fields ?? {}));
      prevFields[candidate.conflictField] = {
        state: 'observed',
        raw: localManual,
        meaning: 'value',
        evidenceRef: `verify:manual-edit:${token}`,
      };
      const manualRevision = Number(candidate.item.revision) + 1;
      await owner.query('BEGIN');
      try {
        await owner.query(
          `INSERT INTO catalog.item_revision(item_id,revision,previous_revision,ice_code_snapshot,name_cn,fields,artifact_id,evidence_ref,reason,actor_id)
           VALUES($1,$2,$3,$4,$5,$6::jsonb,NULL,$7,$8,$9)`,
          [candidate.item.item_id, manualRevision, Number(candidate.item.revision), candidate.item.ice_code,
            candidate.item.name_cn, jsonOf(prevFields), `verify:manual-edit:${token}`, '人工修改资料（验证脚本模拟）', ADMIN_ID],
        );
        await owner.query('UPDATE catalog.item_current SET revision=$2 WHERE item_id=$1 AND revision=$3',
          [candidate.item.item_id, manualRevision, Number(candidate.item.revision)]);
        await owner.query('COMMIT');
      } catch (error) {
        await owner.query('ROLLBACK').catch(() => {});
        throw error;
      }
      const manualState = (await ownerQuery(
        `SELECT ic.revision, r.fields FROM catalog.item_current ic
         JOIN catalog.item_revision r ON r.item_id=ic.item_id AND r.revision=ic.revision WHERE ic.item_id=$1`,
        [candidate.item.item_id],
      ))[0];
      record('C', 'manual-edit', Number(manualState.revision) === manualRevision
        && normalizeMod.localRawOf(manualState.fields?.[candidate.conflictField]) === localManual,
        `item_current.revision=${manualState.revision}（人工值已落库）`);

      // 2) 构造来源同字段变化且值不同的快照副本（local_simulation）
      const variant = buildVariantSnapshot(ctx, {
        origin: 'local_simulation',
        capturedAt: isoLater(ctx.clockMs, 60_000),
        note: '人工修改冲突验证：来源同字段变化且与本地人工值不同',
        mutations: [{
          rowNumber: candidate.row.rowNumber,
          cells: { [conflictColumn]: sourceConflict, [updateColumn]: sourceUpdate },
          description: `${candidate.conflictField}/${candidate.updateField} 来源变化`,
        }],
        keepRedaction: snapshot.redaction ?? null,
      });
      const variantPath = path.join(verifyDir, `snapshot-conflict-${stamp}.json`);
      fs.writeFileSync(variantPath, `${jsonOf(variant)}\n`);
      ctx.conflictVariant = variant;
      ctx.conflictVariantPath = variantPath;
      record('C', 'variant-snapshot', reader.verifySnapshotKey(variant) && variant.origin === 'local_simulation',
        `快照副本 ${path.basename(variantPath)}（content-hash 自校验通过）`);

      const { plan } = await buildPlanFor(variant);
      const result = plan.results.find((entry) => entry.sourceKey === `code:${candidate.binding.ice_code}`);
      record('C', 'plan-decision', plan.decision === 'apply', plan.decision);
      record('C', 'plan-needs-review', Boolean(result) && result.action === 'needs_review', result ? `action=${result.action}` : '缺少该货号的结果');
      record('C', 'plan-reason-field-conflict', Boolean(result) && result.reasonCode === 'FIELD_CONFLICT', result?.reasonCode);
      const conflictIssue = (result?.issues ?? []).find((issue) => issue.kind === 'field_conflict' && issue.detail?.fieldKey === candidate.conflictField);
      record('C', 'plan-field-conflict-issue', Boolean(conflictIssue), conflictIssue ? `field_conflict detail.fieldKey=${candidate.conflictField}` : null);
      const updateChange = (result?.changes ?? []).find((change) => change.fieldKey === candidate.updateField);
      record('C', 'plan-updates-other-field', Boolean(updateChange) && updateChange.afterRaw === sourceUpdate,
        updateChange ? `${candidate.updateField} → ${sourceUpdate}` : '缺少无冲突字段的写入变更');
      record('C', 'plan-expected-revision', Boolean(result) && Number(result.expectedRevision) === manualRevision, `${result?.expectedRevision} vs ${manualRevision}`);
      if (!result || result.action !== 'needs_review' || !updateChange) {
        evidence.scenarios.C = { planResult: result ?? null, blocked: 'PLAN_NOT_CONFLICT' };
        return;
      }

      const batch = buildBatchFor(variant, plan);
      const submitted = await submitApply(batch, planMod.toPlanPayload(plan));
      const receipt = submitted.receipt;
      const receiptRow = (receipt.results ?? []).find((row) => row.sourceKey === result.sourceKey);
      record('C', 'receipt-result', Boolean(receiptRow) && receiptRow.action === 'needs_review' && receiptRow.reasonCode === 'FIELD_CONFLICT',
        receiptRow ? `action=${receiptRow.action} reasonCode=${receiptRow.reasonCode}` : '回执缺少该货号');
      record('C', 'receipt-wrote-revision', Boolean(receiptRow) && Number(receiptRow.itemRevision) === manualRevision + 1,
        `itemRevision=${receiptRow?.itemRevision}`);

      const after = (await ownerQuery(
        `SELECT ic.revision, r.fields FROM catalog.item_current ic
         JOIN catalog.item_revision r ON r.item_id=ic.item_id AND r.revision=ic.revision WHERE ic.item_id=$1`,
        [candidate.item.item_id],
      ))[0];
      record('C', 'revision-advanced', Number(after.revision) === manualRevision + 1, `revision=${after.revision}`);
      record('C', 'local-value-not-overwritten', normalizeMod.localRawOf(after.fields?.[candidate.conflictField]) === localManual,
        `本地人工值${normalizeMod.localRawOf(after.fields?.[candidate.conflictField]) === localManual ? '保留' : '被覆盖'}`);
      record('C', 'other-field-written', normalizeMod.localRawOf(after.fields?.[candidate.updateField]) === sourceUpdate,
        `${candidate.updateField}${normalizeMod.localRawOf(after.fields?.[candidate.updateField]) === sourceUpdate ? '已按计划写入' : '未写入'}`);
      const dbResult = (await ownerQuery(
        `SELECT r.classification, r.reason_code, r.item_revision, r.item_id
         FROM catalog.product_source_result r JOIN catalog.product_source_batch b ON b.id=r.batch_id
         WHERE b.snapshot_key=$1 AND r.source_key=$2`,
        [variant.snapshotKey, result.sourceKey],
      ))[0];
      record('C', 'db-result-needs-review', Boolean(dbResult) && dbResult.classification === 'needs_review'
        && dbResult.reason_code === 'FIELD_CONFLICT' && Number(dbResult.item_revision) === manualRevision + 1,
        dbResult ? `classification=${dbResult.classification} reason=${dbResult.reason_code} item_revision=${dbResult.item_revision}` : '缺少结果行');
      const dbIssue = await ownerQuery(
        `SELECT i.issue_kind, i.review_state, i.item_id, i.detail
         FROM catalog.product_source_issue i JOIN catalog.product_source_batch b ON b.id=i.batch_id
         WHERE b.snapshot_key=$1 AND i.source_key=$2 ORDER BY i.issue_kind`,
        [variant.snapshotKey, result.sourceKey],
      );
      const fieldConflict = dbIssue.find((row) => row.issue_kind === 'field_conflict');
      record('C', 'db-issue-open', Boolean(fieldConflict) && fieldConflict.review_state === 'open'
        && fieldConflict.item_id === candidate.item.item_id && fieldConflict.detail?.fieldKey === candidate.conflictField,
        `待核对项 ${dbIssue.length} 个（field_conflict=${Boolean(fieldConflict)}）`);
      const itemState = await readItemState(candidate.item.item_id);
      record('C', 'item-state-needs-review', itemState?.latestResult?.classification === 'needs_review',
        itemState?.latestResult?.classification ?? null);

      evidence.scenarios.C = {
        itemId: candidate.item.item_id,
        iceCode: candidate.binding.ice_code,
        conflictField: candidate.conflictField,
        updateField: candidate.updateField,
        manualRevision,
        newRevision: Number(after.revision),
        requestId: submitted.requestId,
        batchStatus: receipt.status,
        counts: receipt.counts,
        snapshotVariant: path.basename(variantPath),
      };
    };

    // ------------------------------------------------------------------
    // 场景 D2：价格列合成哨兵值 → 只进私有表（补足脱敏快照没有真实价格值）
    // ------------------------------------------------------------------
    const scenarioD2 = async () => {
      const restricted = headerResolution.restrictedColumns;
      if (RESTRICTED_KEYS.some((key) => !restricted[key])) {
        record('D2', 'restricted-columns', false, '缺少价格列，无法注入哨兵值');
        return;
      }
      // 以 C 的快照副本为产品字段基线，避免 D2 把 C 之后的商品字段再改回去（D2 只关心价格列）。
      const base = ctx.conflictVariant ?? snapshot;
      const baseBusiness = base.rows.filter((row) => row.isBusinessRow).slice(0, 3);
      if (baseBusiness.length === 0) {
        record('D2', 'business-rows', false, '没有业务行');
        return;
      }
      const sentinels = baseBusiness.map((row, index) => ({
        rowNumber: row.rowNumber,
        cells: {
          [restricted.costPrice]: `SENTINEL-COST-${token}-${index}`,
          [restricted.operatingPrice]: `SENTINEL-OPERATING-${token}-${index}`,
          [restricted.shippingPrice]: `SENTINEL-SHIPPING-${token}-${index}`,
        },
      }));
      const variant = buildVariantSnapshot(ctx, {
        baseSnapshot: base,
        origin: 'local_simulation',
        capturedAt: isoLater(ctx.clockMs, 120_000),
        note: '价格隔离验证：价格列注入合成哨兵值（非真实价格）',
        mutations: sentinels.map((entry) => ({
          rowNumber: entry.rowNumber,
          cells: entry.cells,
          description: '合成价格哨兵',
        })),
        keepRedaction: null,
      });
      const variantPath = path.join(verifyDir, `snapshot-price-sentinel-${stamp}.json`);
      fs.writeFileSync(variantPath, `${jsonOf(variant)}\n`);
      record('D2', 'variant-snapshot', reader.verifySnapshotKey(variant), path.basename(variantPath));

      const expectedAmounts = expectedAmountsOf(variant, restricted);
      const sentinelValueSet = new Set(sentinels.flatMap((entry) => Object.values(entry.cells))
        .map((value) => normalizeMod.normalizeCellText(String(value))));
      const sentinelExpected = expectedAmounts.filter((entry) => collectStrings(entry.payload)
        .some((value) => sentinelValueSet.has(normalizeMod.normalizeCellText(value))));
      record('D2', 'expected-amounts', sentinelExpected.length === sentinels.length
        && sentinelExpected.every((entry) => Object.keys(entry.payload).length === Object.keys(restricted).length),
        `非空价格行=${expectedAmounts.length}；含哨兵行=${sentinelExpected.length}；哨兵值=${sentinelValueSet.size}`);

      const { plan } = await buildPlanFor(variant);
      const batch = buildBatchFor(variant, plan);
      record('D2', 'batch-amounts-exact', amountsEqual(batch.amounts ?? [], expectedAmounts), `batch.amounts=${(batch.amounts ?? []).length}`);
      const restrictedColumnSet = new Set(Object.values(restricted));
      const batchCellLeak = (batch.rows ?? []).filter((row) => cellValuesOf(row.cells, [...restrictedColumnSet])
        .some((value) => sentinelValueSet.has(value)))
        .concat((batch.rows ?? []).filter((row) => Object.keys(row.cells).some((column) => restrictedColumnSet.has(column))))
        .length;
      record('D2', 'batch-public-cells-stripped', batchCellLeak === 0, `公共 batch rows 含价格列/哨兵值的行数=${batchCellLeak}`);
      const planPayload = planMod.toPlanPayload(plan);
      record('D2', 'plan-json-price-free', !PRICE_KEY_PATTERN.test(jsonOf(planPayload)) && !leaksExactValue(planPayload, sentinelValueSet), null);
      record('D2', 'batch-public-json-price-free', !leaksExactValue(batch.rows ?? [], sentinelValueSet), null);

      const submitted = await submitApply(batch, planPayload);
      const receipt = submitted.receipt;
      record('D2', 'receipt-status', ['applied', 'partial'].includes(receipt.status), receipt.status);

      const dbAmounts = await ownerQuery(
        `SELECT r.row_number, a.payload
         FROM catalog_private.product_source_row_amounts a
         JOIN catalog.product_source_row r ON r.id = a.row_id
         JOIN catalog.product_source_batch b ON b.id = r.batch_id
         WHERE b.snapshot_key = $1 ORDER BY r.row_number`,
        [variant.snapshotKey],
      );
      record('D2', 'db-private-amounts-exact', amountsEqual(
        dbAmounts.map((row) => ({ rowNumber: Number(row.row_number), payload: row.payload })),
        expectedAmounts,
      ), `私有表 ${dbAmounts.length} 行，与注入哨兵逐行一致`);

      const dbCells = await ownerQuery(
        `SELECT r.row_number, r.cells FROM catalog.product_source_row r
         JOIN catalog.product_source_batch b ON b.id = r.batch_id
         WHERE b.snapshot_key = $1 ORDER BY r.row_number`,
        [variant.snapshotKey],
      );
      const cellLeak = dbCells.filter((row) => cellValuesOf(row.cells, Object.values(restricted))
        .some((value) => sentinelValueSet.has(value))).length;
      record('D2', 'db-public-cells-stripped', cellLeak === 0, `公共 cells 出现哨兵值的行数=${cellLeak}`);

      // 公共表 jsonb 全量扫描（行/结果/待核对）
      const leakScan = await ownerQuery(
        `WITH target AS (
           SELECT r.cells::text AS a, r.fields::text AS b FROM catalog.product_source_row r
            JOIN catalog.product_source_batch b ON b.id=r.batch_id WHERE b.snapshot_key=$1
           UNION ALL
           SELECT r.changed_fields::text, r.detail::text FROM catalog.product_source_result r
            JOIN catalog.product_source_batch b ON b.id=r.batch_id WHERE b.snapshot_key=$1
           UNION ALL
           SELECT i.detail::text, NULL FROM catalog.product_source_issue i
            JOIN catalog.product_source_batch b ON b.id=i.batch_id WHERE b.snapshot_key=$1
         )
         SELECT count(*)::int AS n FROM target WHERE a LIKE '%SENTINEL-%' OR b LIKE '%SENTINEL-%'`,
        [variant.snapshotKey],
      );
      record('D2', 'db-public-tables-no-sentinel', Number(leakScan[0].n) === 0, `公共表命中 ${leakScan[0].n} 行`);

      const publicPayloads = [
        ['receipt', receipt],
        ['overview', await readOverview()],
        ['item-state', ctx.sampleItemId ? await readItemState(ctx.sampleItemId) : null],
      ].filter(([, payload]) => payload !== null && payload !== undefined);
      const payloadLeak = publicPayloads.filter(([, payload]) => {
        const text = jsonOf(payload);
        return PRICE_KEY_PATTERN.test(text) || leaksExactValue(payload, sentinelValueSet);
      }).map(([name]) => name);
      record('D2', 'public-payloads-price-free', payloadLeak.length === 0, `含哨兵值/语义键：${payloadLeak.join(',') || '无'}`);

      evidence.scenarios.D2 = {
        snapshotVariant: path.basename(variantPath),
        sentinelRows: sentinels.length,
        sentinelValueCount: sentinelValueSet.size,
        expectedAmountRows: expectedAmounts.length,
        privateAmountRows: dbAmounts.length,
        publicScanHits: Number(leakScan[0].n),
        receiptStatus: receipt.status,
        productWrites: receipt.counts?.updated ?? null,
      };
    };

    // 顺序执行：A → B → D（只读核对）→ C（人工冲突）→ D2（合成价格哨兵）
    for (const [key, fn] of [['A', scenarioA], ['B', scenarioB], ['D', scenarioD], ['C', scenarioC], ['D2', scenarioD2]]) {
      try {
        await fn();
      } catch (error) {
        record(key, 'exception', false, error instanceof Error ? error.message : String(error));
        log(`场景 ${key} 异常：${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      }
    }

    // 现役库只读复核（证明整轮未写现役库）
    evidence.live.after = await readLiveStats();
    record('live', 'readonly-only', true, '现役库仅执行 SELECT / pg_dump');
    const beforeLive = evidence.live.before;
    const afterLive = evidence.live.after;
    const liveComparable = ['catalogItem', 'catalogItemCode', 'itemRevision'];
    const liveCountsEqual = liveComparable.every((key) => beforeLive[key] === afterLive[key]);
    // 现役库可能在本轮运行期间被其他协作者补上 015（本脚本只读，不写现役库）；
    // 这种情况允许 productSource 由 null 变为全 0 的计数，但商品/修订数必须完全不变。
    let productSourceNote = null;
    let productSourceEqual = true;
    if (beforeLive.productSource === null && afterLive.productSource !== null) {
      productSourceEqual = Object.values(afterLive.productSource).every((value) => Number(value) === 0);
      productSourceNote = '运行期间现役库出现 015（其他协作者迁移，本脚本只读未写）；015 表计数全为 0';
      evidence.notes.push(productSourceNote);
    } else if (beforeLive.productSource !== null && afterLive.productSource === null) {
      productSourceEqual = false;
    } else {
      productSourceEqual = jsonOf(beforeLive.productSource) === jsonOf(afterLive.productSource);
    }
    record('live', 'unchanged', liveCountsEqual && productSourceEqual,
      jsonOf({ countsEqual: liveCountsEqual, productSourceEqual, note: productSourceNote, before: beforeLive, after: afterLive }));
    await live.end();
  } catch (error) {
    evidence.error = error instanceof Error ? `${error.message}` : String(error);
    log(`致命错误：${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  } finally {
    // 清理：关闭连接 → dropdb（除非 --keep）
    try {
      if (owner) await owner.end().catch(() => {});
    } catch { /* ignore */ }
    if (scratchDb && scratchCreated) {
      if (keep) {
        log(`--keep：保留 scratch 库 ${scratchDb}`);
        evidence.scratch = { ...(evidence.scratch ?? {}), dbName: scratchDb, kept: true, dropped: false };
        record('cleanup', 'kept', true, scratchDb);
      } else {
        try {
          const dropped = runToLog(toolExe(instance.pgBinDir, 'dropdb'), [
            '--host', instance.host,
            '--port', String(instance.port),
            '--username', instance.bootstrapUser,
            '--if-exists',
            scratchDb,
          ], { env: liveDbEnv(instance), logFile: path.join(verifyDir, 'logs', `dropdb-${stamp}.log`) });
          record('cleanup', 'dropped', true, `${scratchDb}（${dropped.durationMs}ms）`);
          evidence.scratch = { ...(evidence.scratch ?? {}), dbName: scratchDb, dropped: true };
          log(`scratch 库已清理：${scratchDb}`);
        } catch (error) {
          record('cleanup', 'dropped', false, error instanceof Error ? error.message : String(error));
          evidence.scratch = { ...(evidence.scratch ?? {}), dbName: scratchDb, dropped: false };
        }
      }
    }
    for (const file of tempFiles) {
      try {
        if (fs.existsSync(file)) fs.rmSync(file, { force: true });
      } catch { /* ignore */ }
    }
    try {
      fs.rmSync(loaderTempDir, { recursive: true, force: true });
    } catch { /* ignore */ }
    try {
      process.chdir(originalCwd);
    } catch { /* ignore */ }
  }

  // --------------------------------------------------------------------
  // 汇总 + 证据
  // --------------------------------------------------------------------
  finishScenarios();
  const required = ['pre', 'setup', 'A', 'B', 'C', 'D', 'D2', 'live', 'cleanup'];
  const ok = evidence.error === null && required.every((key) => scenarioPassed(key));
  evidence.ok = ok;
  evidence.durationMs = Date.now() - startedAt.getTime();
  const evidencePath = path.join(verifyDir, 'verify-real-flow.json');
  const stampedPath = path.join(verifyDir, `verify-real-flow-${stamp}.json`);
  fs.writeFileSync(stampedPath, `${JSON.stringify(evidence, null, 2)}\n`);
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

  const summary = {
    ok,
    mode: label,
    runId: evidence.arguments.runId,
    snapshot: evidence.snapshot
      ? {
        origin: evidence.snapshot.origin,
        snapshotKey: evidence.snapshot.snapshotKey,
        businessRows: evidence.snapshot.businessRows,
        uniqueCodes: evidence.snapshot.uniqueCodes,
      }
      : null,
    scratch: evidence.scratch,
    scenarios: Object.fromEntries(Object.entries(evidence.scenarios).map(([key, value]) => [key, {
      ok: value.ok,
      assertions: value.assertionCount,
      failed: (value.failed ?? []).map((entry) => entry.id),
      counts: value.counts ?? null,
      status: value.status ?? value.receiptStatus ?? null,
    }])),
    liveUntouched: evidence.live.after ? evidence.live.before.catalogItem === evidence.live.after.catalogItem : null,
    evidence: evidencePath,
    log: logFile,
  };
  log(`完成：ok=${ok}；证据 ${evidencePath}`);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return ok ? 0 : 1;
}

function buildVariantSnapshot(ctx, { baseSnapshot, origin, capturedAt, note, mutations, keepRedaction }) {
  const base = baseSnapshot ?? ctx.snapshot;
  const fieldColumns = ctx.headerResolution.fieldColumns;
  const rows = JSON.parse(jsonOf(base.rows));
  const rowByNumber = new Map(rows.map((row) => [row.rowNumber, row]));
  const changes = [];
  for (const mutation of mutations) {
    const row = rowByNumber.get(mutation.rowNumber);
    if (!row) throw new Error(`VARIANT_ROW_MISSING:${mutation.rowNumber}`);
    for (const [column, value] of Object.entries(mutation.cells)) row.cells[column] = value;
    row.fields = ctx.normalizeMod.buildRowFields(row.cells, fieldColumns);
    row.rowSha256 = ctx.reader.computeRowSha256({ rowNumber: row.rowNumber, cells: row.cells, fields: row.fields });
    changes.push({ kind: 'field_change', sourceKey: `row:${row.rowNumber}`, detail: mutation.description ?? '验证脚本构造' });
  }
  const variant = { ...JSON.parse(jsonOf(base)), rows };
  variant.origin = origin;
  variant.capturedAt = capturedAt;
  variant.redaction = keepRedaction;
  variant.simulation = { baseSnapshotKey: base.snapshotKey, note, changes };
  variant.snapshotKey = ctx.reader.computeSnapshotKey(variant);
  return variant;
}

main().then((code) => {
  process.exitCode = code;
}).catch((error) => {
  console.error(`verify-real-flow 失败：${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
