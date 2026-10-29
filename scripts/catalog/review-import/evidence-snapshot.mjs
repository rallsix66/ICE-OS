#!/usr/bin/env node
/**
 * DATA-1 证据快照 / 备份工具。
 *
 * 模式：
 *   --mode state   --db <dbName> --out <dir> --label <name>
 *       导出当前库映射/请求/国内决定/国内读链的指纹与逐行 CSV（用于前后对比、幂等核对）。
 *   --mode backup  --db <formal db> --out <dir>
 *       先 pg_dump（-Fc）到系统临时目录，再经服务端 lo_import/lo_export 把整库备份与
 *       430 条 confirmed 前值写进 evidence 目录（当前会话命令沙箱不允许子进程直接写 .local）。
 *
 * owner 连接使用正式实例 bootstrap 用户（同一 PG 集群，仅换库名）；不写业务表。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const INSTANCE_FILE = path.join(REPO_ROOT, '.local', 'catalog', 'run-20261026T211500Z-11a22b33', 'instance', 'catalog-instance.json');
const PG_BIN = path.join(REPO_ROOT, '.local', 'p0-02', 'run-20261014-r2', 'pg', 'pgsql', 'bin');

function readArgs(argv) {
  const args = { mode: 'state' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`missing value for ${a}`);
      return argv[i];
    };
    if (a === '--mode') args.mode = next();
    else if (a === '--db') args.db = next();
    else if (a === '--out') args.out = next();
    else if (a === '--label') args.label = next();
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!['state', 'backup'].includes(args.mode)) throw new Error(`invalid --mode ${args.mode}`);
  if (!args.db) throw new Error('--db is required');
  if (!args.out) throw new Error('--out is required');
  return args;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function toCsv(columns, rows) {
  const lines = [columns.map((c) => csvEscape(c.label)).join(',')];
  for (const row of rows) lines.push(columns.map((c) => csvEscape(c.value(row))).join(','));
  return `${lines.join('\n')}\n`;
}

async function writeServerFile(owner, evidenceDir, name, content) {
  const absolute = path.resolve(evidenceDir, name).replace(/\\/g, '/');
  const { rows } = await owner.query("SELECT lo_from_bytea(0, convert_to($1,'UTF8')) AS oid", [content]);
  try {
    await owner.query('SELECT lo_export($1,$2)', [rows[0].oid, absolute]);
  } finally {
    await owner.query('SELECT lo_unlink($1)', [rows[0].oid]);
  }
  return absolute;
}

async function writeServerBinaryFile(owner, evidenceDir, name, absoluteSourcePath) {
  const absolute = path.resolve(evidenceDir, name).replace(/\\/g, '/');
  const imported = await owner.query('SELECT lo_import($1) AS oid', [absoluteSourcePath.replace(/\\/g, '/')]);
  try {
    await owner.query('SELECT lo_export($1,$2)', [imported.rows[0].oid, absolute]);
  } finally {
    await owner.query('SELECT lo_unlink($1)', [imported.rows[0].oid]);
  }
  return absolute;
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  const instance = JSON.parse(await readFile(INSTANCE_FILE, 'utf8'));
  const ownerUrl = `postgres://${instance.bootstrapUser}:${instance.bootstrapPassword}@${instance.host}:${instance.port}/${args.db}`;
  const { default: pg } = await import('pg');
  const owner = new pg.Client({ connectionString: ownerUrl });
  await owner.connect();
  // 只读快照需要管理员声明（read_inventory_domestic_links 内部 require_admin），仅用于证据导出。
  const adminRows = await owner.query(`
    SELECT p.id FROM public.profiles p JOIN public.role r ON r.id=p.role_id
    WHERE p.is_active AND r.name='admin' ORDER BY p.created_at,p.id LIMIT 1`);
  if (adminRows.rowCount !== 1) throw new Error('EVIDENCE_SNAPSHOT_ADMIN_MISSING');
  await owner.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [adminRows.rows[0].id]);
  const evidenceDir = path.resolve(REPO_ROOT, args.out);
  const generatedAt = new Date().toISOString();
  try {
    if (args.mode === 'state') {
      const stateRow = (await owner.query(`
        SELECT current_database() AS database,
               (SELECT count(*) FROM catalog.inventory_sku_mapping) AS mappings_total,
               (SELECT count(*) FROM catalog.inventory_sku_mapping WHERE status='confirmed') AS mappings_confirmed,
               (SELECT count(*) FROM catalog.inventory_sku_mapping WHERE status='disabled') AS mappings_disabled,
               (SELECT count(*) FROM catalog.inventory_sku_mapping WHERE status='recheck') AS mappings_recheck,
               (SELECT count(*) FROM catalog.inventory_request) AS requests,
               (SELECT count(*) FROM catalog.inventory_audit) AS audits,
               (SELECT count(*) FROM catalog.catalog_item) AS items,
               (SELECT count(*) FROM catalog.inventory_warehouse) AS warehouses`)).rows[0];
      const hasDecisionTable = (await owner.query(
        "SELECT to_regclass('catalog.domestic_review_decision') IS NOT NULL AS ok")).rows[0].ok;
      stateRow.decisions = hasDecisionTable
        ? (await owner.query('SELECT count(*) FROM catalog.domestic_review_decision')).rows[0].count
        : '0';
      const versions = (await owner.query(
        `SELECT version,status,count(*) AS n FROM catalog.inventory_sku_mapping GROUP BY version,status ORDER BY version,status`)).rows;
      const requests = (await owner.query(
        `SELECT action,count(*) AS n FROM catalog.inventory_request GROUP BY action ORDER BY action`)).rows;
      const decisions = hasDecisionTable ? (await owner.query(
        `SELECT dataset_sha256,count(*) AS n,min(recorded_at) AS first_at,max(recorded_at) AS last_at
         FROM catalog.domestic_review_decision GROUP BY dataset_sha256`)).rows : [];
      const mappings = (await owner.query(`
        SELECT m.id,m.external_sku,w.external_warehouse_id,i.id AS item_id,
               v.ice_code_snapshot AS ice_code,m.unit,m.version,m.status,m.actor_id,
               m.created_at,m.note
        FROM catalog.inventory_sku_mapping m
        JOIN catalog.inventory_warehouse w ON w.id=m.warehouse_id
        JOIN catalog.catalog_item i ON i.id=m.item_id
        JOIN catalog.item_current c ON c.item_id=i.id
        JOIN catalog.item_revision v ON v.item_id=c.item_id AND v.revision=c.revision
        ORDER BY w.external_warehouse_id,m.external_sku,m.version`)).rows;
      const links = (await owner.query('SELECT catalog.read_inventory_domestic_links() AS links')).rows[0].links;
      const domestic = {
        recordCount: links.length,
        selectedCount: links.filter((l) => l.reviewState === 'manual_selected').length,
        linkedSelectedCount: links.filter((l) => l.reviewState === 'manual_selected' && l.itemId).length,
        linkedItemCount: new Set(links.filter((l) => l.itemId).map((l) => l.itemId)).size,
      };
      const mappingCsv = toCsv([
        { label: 'mappingId', value: (r) => r.id },
        { label: 'warehouseExternalId', value: (r) => r.external_warehouse_id },
        { label: 'externalSku', value: (r) => r.external_sku },
        { label: 'itemId', value: (r) => r.item_id },
        { label: 'iceCode', value: (r) => r.ice_code },
        { label: 'unit', value: (r) => r.unit },
        { label: 'version', value: (r) => r.version },
        { label: 'status', value: (r) => r.status },
        { label: 'actorId', value: (r) => r.actor_id },
        { label: 'createdAt', value: (r) => r.created_at },
        { label: 'note', value: (r) => r.note },
      ], mappings);
      const fingerprint = sha256(mappingCsv);
      const state = {
        generatedAt,
        label: args.label ?? null,
        database: stateRow.database,
        counts: stateRow,
        versions,
        requests,
        decisions,
        domestic,
        mappingCsvSha256: fingerprint,
        files: {},
      };
      state.files.mappings = await writeServerFile(owner, evidenceDir, 'mappings.csv', mappingCsv);
      state.files.domesticLinks = await writeServerFile(owner, evidenceDir, 'domestic-links.json',
        `${JSON.stringify({ generatedAt, domestic, links }, null, 2)}\n`);
      state.files.state = await writeServerFile(owner, evidenceDir, 'db-state.json', `${JSON.stringify(state, null, 2)}\n`);
      console.log(JSON.stringify(state, null, 2));
      return;
    }

    // backup：整库 dump + 430 confirmed 前值
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const tempDir = await mkdtemp(path.join(tmpdir(), 'iceos-data1-backup-'));
    const dumpPath = path.join(tempDir, `${args.db}-${stamp}.dump`);
    const pgDump = path.join(PG_BIN, 'pg_dump.exe');
    const dumpResult = spawnSync(pgDump, [
      '-h', instance.host, '-p', String(instance.port), '-U', instance.bootstrapUser,
      '-d', args.db, '-Fc', '-f', dumpPath,
    ], {
      env: { ...process.env, PGPASSWORD: instance.bootstrapPassword },
      stdio: 'ignore',
      windowsHide: true,
    });
    if (dumpResult.status !== 0) throw new Error(`PG_DUMP_FAILED:${dumpResult.status}`);
    const dumpStat = await stat(dumpPath);
    const dumpSha = sha256(await readFile(dumpPath));
    const dumpName = `formal-before-review-import-${stamp}.dump`;
    const dumpTarget = await writeServerBinaryFile(owner, evidenceDir, dumpName, dumpPath);
    await rm(tempDir, { recursive: true, force: true });

    const mappings = (await owner.query(`
      SELECT m.id,m.external_sku,w.external_warehouse_id,i.id AS item_id,
             v.ice_code_snapshot AS ice_code,m.unit,m.version,m.status,m.actor_id,m.created_at,m.note
      FROM catalog.inventory_sku_mapping m
      JOIN catalog.inventory_warehouse w ON w.id=m.warehouse_id
      JOIN catalog.catalog_item i ON i.id=m.item_id
      JOIN catalog.item_current c ON c.item_id=i.id
      JOIN catalog.item_revision v ON v.item_id=c.item_id AND v.revision=c.revision
      WHERE m.status='confirmed'
      ORDER BY w.external_warehouse_id,m.external_sku,m.version`)).rows;
    const mappingCsv = toCsv([
      { label: 'mappingId', value: (r) => r.id },
      { label: 'warehouseExternalId', value: (r) => r.external_warehouse_id },
      { label: 'externalSku', value: (r) => r.external_sku },
      { label: 'itemId', value: (r) => r.item_id },
      { label: 'iceCode', value: (r) => r.ice_code },
      { label: 'unit', value: (r) => r.unit },
      { label: 'version', value: (r) => r.version },
      { label: 'createdAt', value: (r) => r.created_at },
      { label: 'note', value: (r) => r.note },
    ], mappings);
    const links = (await owner.query('SELECT catalog.read_inventory_domestic_links() AS links')).rows[0].links;
    const meta = {
      generatedAt,
      database: (await owner.query('SELECT current_database() AS db')).rows[0].db,
      dumpFile: path.basename(dumpTarget),
      dumpBytes: dumpStat.size,
      dumpSha256: dumpSha,
      confirmedMappings: mappings.length,
      confirmedMappingsSha256: sha256(mappingCsv),
      domesticLinks: links.length,
      domesticSelected: links.filter((l) => l.reviewState === 'manual_selected').length,
      files: {},
    };
    meta.files.dump = dumpTarget;
    meta.files.confirmedMappings = await writeServerFile(owner, evidenceDir, 'confirmed-mappings-before.csv', mappingCsv);
    meta.files.domesticLinks = await writeServerFile(owner, evidenceDir, 'domestic-links-before.json',
      `${JSON.stringify({ generatedAt, links }, null, 2)}\n`);
    meta.files.meta = await writeServerFile(owner, evidenceDir, 'backup-meta.json', `${JSON.stringify(meta, null, 2)}\n`);
    console.log(JSON.stringify(meta, null, 2));
  } finally {
    await owner.end().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error.stack ?? String(error));
  process.exitCode = 1;
});
