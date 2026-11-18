import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REPO_ROOT, readArgs, openRun, newEvidence, writeJson, safeEnv, runCommand, assertLiveInstance,
} from './prepare.mjs';
import { syncCatalogSqlIncrements } from './catalog-sql-increments.mjs';

const LOCAL_SQL = [
  'db/catalog/009_local_display.sql',
  'db/catalog/010_local_display_security.sql',
  'db/catalog/011_local_display_read_rpc.sql',
  'db/catalog/012_local_display_table_rls.sql',
  'db/catalog/013_baseline_amounts_batch.sql',
  'db/catalog/015_product_source_sync.sql',
  'db/catalog/036_product_source_review_flow.sql',
  'db/catalog/037_product_source_interpretation.sql',
];

// 依赖 016-035 的表/函数的目录 SQL（先物流在途、再历史快照）。catalog-only 预览还没有这些表时跳过，
// 由 prepare-instance 在 016-035 之后按顺序安装；已含表的实例重跑预览会就地补齐，避免版本分叉。
// 顺序不能提前：038-040 的 DECLARE 直接引用 catalog.shipment_item，041 引用 inventory_batch。
const DEPENDENT_SQL = [
  {
    path: 'db/catalog/038_shipment_association_history.sql',
    requires: ['catalog.shipment_item', 'catalog.shipment_source_snapshot'],
  },
  {
    path: 'db/catalog/039_shipment_association_rule_preview.sql',
    requires: ['catalog.shipment_item'],
  },
  {
    path: 'db/catalog/040_shipment_association_rule_impact.sql',
    requires: ['catalog.shipment_item'],
  },
  {
    path: 'db/catalog/041_inventory_snapshot_reads.sql',
    requires: ['catalog.inventory_batch', 'catalog.inventory_batch_row'],
  },
  {
    // 操作记录只读汇合（042）：要读商品/库存/物流三类的历史行；表未就绪时由 prepare-instance 安装。
    path: 'db/catalog/042_operation_records.sql',
    requires: [
      'catalog.audit_event', 'catalog.item_revision', 'catalog.inventory_audit',
      'catalog.inventory_sku_mapping', 'catalog.shipment_item_association_revision',
      'catalog.shipment_item_manual_revision', 'catalog.shipment_grouping_review',
    ],
  },
  {
    // 权限设置 v1（043）：需要 016-042 的库存读模型、历史快照函数与 profiles；
    // 目录预览还没有这些对象时跳过，由 prepare-instance 在 042 之后按顺序安装。
    path: 'db/catalog/043_permissions_v1.sql',
    requires: [
      'public.profiles', 'catalog.inventory_warehouse', 'catalog.inventory_batch',
      'catalog.inventory_batch_row', 'catalog.inventory_sync_settings', 'catalog.inventory_scope',
    ],
    requiresFunctions: [
      'catalog.read_inventory_warehouse_states()',
      'catalog.read_inventory_warehouse_rows(text,text,text)',
      'catalog.read_inventory_product_summary(text,text,text,integer,integer)',
      'catalog.read_inventory_item(uuid,text,text,boolean)',
      'catalog.read_inventory_snapshot_batches(uuid,integer,integer)',
      'catalog.read_inventory_snapshot_rows(uuid,uuid,text,integer,integer)',
      'catalog.inventory_scope_payload(uuid)',
    ],
  },
  {
    // 权限设置 v1 首轮补修（044）：必须晚于 043；只替换函数/补策略，重复准备保留角色与仓库授权。
    path: 'db/catalog/044_permissions_v1_fixes.sql',
    requires: ['catalog.access_role', 'catalog.account_access', 'catalog.account_access_warehouse'],
    requiresFunctions: [
      'catalog.inventory_scope_payload(uuid)',
      'catalog.inventory_effective_rows(uuid,uuid[])',
      'catalog.read_inventory_item(uuid,text,text,boolean)',
    ],
  },
];

async function applyCatalogSql(run) {
  const instance = JSON.parse(fs.readFileSync(path.join(run.instanceRoot, 'catalog-instance.json'), 'utf8'));
  const ownerUrl = `postgres://${instance.bootstrapUser}:${instance.bootstrapPassword}@${instance.host}:${instance.port}/${instance.dbName}`;
  const { default: pg } = await import('pg');
  const owner = new pg.Client({ connectionString: ownerUrl });
  await owner.connect();
  const applied = [];
  const skipped = [];
  try {
    for (const relative of LOCAL_SQL) {
      const file = path.join(REPO_ROOT, relative);
      const sql = fs.readFileSync(file, 'utf8');
      await owner.query(sql);
      await owner.query('RESET ROLE; RESET ALL');
      applied.push({ path: relative, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') });
    }
    for (const entry of DEPENDENT_SQL) {
      const missing = [];
      for (const table of entry.requires) {
        const present = (await owner.query('SELECT to_regclass($1) IS NOT NULL AS present', [table])).rows[0]?.present === true;
        if (!present) missing.push(table);
      }
      for (const fn of entry.requiresFunctions ?? []) {
        const present = (await owner.query('SELECT to_regprocedure($1) IS NOT NULL AS present', [fn])).rows[0]?.present === true;
        if (!present) missing.push(fn);
      }
      if (missing.length > 0) {
        skipped.push({ path: entry.path, missing, reason: 'required tables/functions are created later by prepare-instance (016-042)' });
        continue;
      }
      const file = path.join(REPO_ROOT, entry.path);
      await owner.query(fs.readFileSync(file, 'utf8'));
      await owner.query('RESET ROLE; RESET ALL');
      applied.push({ path: entry.path, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') });
    }
  } finally {
    await owner.end();
  }
  return { applied, skipped };
}

export async function prepareLocalPreview(argv = process.argv.slice(2)) {
  const args = readArgs(argv);
  const evidenceDir = newEvidence(args.root, 'prepare-local-preview');
  runCommand(process.execPath, [path.join(REPO_ROOT, 'scripts/catalog/prepare.mjs'), '--run-id', args.runId], { env: safeEnv(), evidenceDir, name: 'catalog-base-prepare' });
  const run = openRun(args);
  const sqlResult = await applyCatalogSql(run);
  const applied = sqlResult.applied;
  const instance = JSON.parse(fs.readFileSync(path.join(run.instanceRoot, 'catalog-instance.json'), 'utf8'));
  const ownerUrl = `postgres://${instance.bootstrapUser}:${instance.bootstrapPassword}@${instance.host}:${instance.port}/${instance.dbName}`;
  const { default: pg } = await import('pg');
  const owner = new pg.Client({ connectionString: ownerUrl });
  await owner.connect();
  try {
    /* 走真实增量链：manifest 命中仍核 DB；缺 014 时实际执行 014，不再 recordOnly 虚报。 */
    await syncCatalogSqlIncrements(owner, run.instanceRoot);
  } finally {
    await owner.end();
  }
  writeJson(path.join(evidenceDir, 'local-display-sql.json'), {
    applied: sqlResult.applied,
    skipped: sqlResult.skipped,
    runId: args.runId,
  });
  const env = safeEnv({
    ...run.env,
    CATALOG_RUN_ROOT: run.root,
    CATALOG_SOURCE_ROOT: REPO_ROOT,
    CATALOG_EVIDENCE_ROOT: path.join(run.root, 'private-evidence'),
  });
  runCommand(process.execPath, [path.join(REPO_ROOT, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'vitest.config.catalog.mts', 'tests/catalog/local-preview-seed.postgres.test.ts'], { env, evidenceDir, name: 'local-preview-seed' });
  const marker = { ...JSON.parse(fs.readFileSync(path.join(run.instanceRoot, 'catalog-instance.json'), 'utf8')), label: 'catalog-local-preview-v1', previewReady: true, seededAt: new Date().toISOString() };
  fs.writeFileSync(path.join(run.instanceRoot, 'catalog-instance.json'), `${JSON.stringify(marker, null, 2)}\n`);
  writeJson(path.join(run.root, 'local-preview-manifest.json'), { runId: args.runId, host: marker.host, port: marker.port, database: marker.dbName, applied, login: { email: 'admin@catalog.test', note: '密码写入 instance/login.local-preview.txt（不入库）' } });
  fs.writeFileSync(path.join(run.instanceRoot, 'login.local-preview.txt'), 'admin@catalog.test / CatalogAdmin123!\n', 'utf8');
  await assertLiveInstance(run);
  console.log(`catalog local preview ready: ${args.runId} @ ${marker.host}:${marker.port}`);
  return run;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareLocalPreview().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
