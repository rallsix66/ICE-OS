/* eslint-disable @typescript-eslint/no-explicit-any -- PG RPC JSON is dynamic; test-only helper */
/**
 * Repair v2/v3 DB test fixture helpers (inventory sync 016/017/018).
 *
 * Tests run ONLY against a dedicated writable validation instance whose marker declares
 * `package: 'inventory-sync-v1', testWritable: true` (F5.4). The guard is checked before opening any
 * connection and the database identity is re-verified READ ONLY before the first write. There is no
 * fallback to `.local/catalog` / old 3031 / 50499 / 59532 targets.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import pg from 'pg';
import { assertConnectedTarget, assertWritableTestTarget } from '../../../scripts/inventory/test-target-guard.mjs';

export const ADMIN_ID = '11111111-1111-4111-8111-111111111101';
export const OPERATOR_ID = '11111111-1111-4111-8111-111111111104';
export const INACTIVE_ADMIN_ID = '11111111-1111-4111-8111-111111111106';

export const randomId = (): string => crypto.randomUUID();
export const intentHash = (): string => crypto.randomBytes(32).toString('hex');

const WRITE_RPCS = new Set([
  'update_inventory_sync_settings', 'request_inventory_manual_sync', 'confirm_inventory_mapping',
  'recheck_inventory_mapping', 'disable_inventory_mapping', 'begin_inventory_pending_action',
  'complete_inventory_pending_action', 'settle_inventory_pending_action', 'register_inventory_worker',
  'refresh_inventory_account_status', 'claim_inventory_run', 'update_inventory_run_phase',
  'register_inventory_export', 'publish_inventory_warehouse', 'finish_inventory_run',
  'fail_inventory_run',
]);

export function resolveInstanceDir(): string {
  const explicit = process.env.INVENTORY_INSTANCE_DIR;
  if (!explicit || !explicit.trim()) {
    throw new Error('INVENTORY_INSTANCE_DIR is required (no fallback to old/protected instances)');
  }
  const resolved = path.resolve(explicit.trim());
  const dir = fs.existsSync(path.join(resolved, 'instance', 'catalog-instance.json'))
    ? path.join(resolved, 'instance') : resolved;
  const instance = JSON.parse(fs.readFileSync(path.join(dir, 'catalog-instance.json'), 'utf8'));
  const envPath = path.join(dir, 'env.catalog.json');
  const env = fs.existsSync(envPath) ? JSON.parse(fs.readFileSync(envPath, 'utf8')) : null;
  assertWritableTestTarget({
    instanceRoot: explicit.trim(),
    runId: env?.P0_02_RUN_ID ?? env?.CATALOG_RUN_ID ?? instance.runId,
    instance,
    env,
    purpose: 'inventory-pg-suite',
  });
  return dir;
}

export function readInstanceDir(): string {
  return resolveInstanceDir();
}

export function readInstance(): { dir: string; instance: any; env: any } {
  const dir = readInstanceDir();
  return {
    dir,
    instance: JSON.parse(fs.readFileSync(path.join(dir, 'catalog-instance.json'), 'utf8')),
    env: JSON.parse(fs.readFileSync(path.join(dir, 'env.catalog.json'), 'utf8')),
  };
}

export interface WarehouseRef {
  id: string;
  external_warehouse_id: string;
  status?: string;
}

export interface RowFixture {
  excelRow: number;
  warehouseExternalId: string | null;
  warehouseName: string | null;
  externalSku: string;
  productName: string;
  gtin: string | null;
  onHand: number | null;
  orderLocked: number | null;
  warehouseAvailable: number | null;
  activityReserved: number | null;
  inTransit: number | null;
  onHandText: string;
  orderLockedText: string;
  warehouseAvailableText: string;
  activityReservedText: string;
  inTransitText: string;
  rawOnHand: string;
  rawOrderLocked: string;
  rawWarehouseAvailable: string;
  rawActivityReserved: string;
  rawInTransit: string;
  rowHash: string;
  parseStatus: string;
  reason: string | null;
  [extra: string]: any;
}

export class Harness {
  dir: string;
  instance: any;
  env: any;
  admin: pg.Client;
  sync: pg.Client;
  boot: pg.Client;
  accountId: string | null = null;
  suffix!: string;
  workerId: string | null = null;
  snapshot: any = null;
  guard: any = null;
  connectionVerifications: any = null;
  runSeq = 0;

  assertWritable(purpose: string): void {
    if (!this.guard) throw new Error('INVENTORY_TEST_TARGET_GUARD_NOT_READY');
    assertWritableTestTarget({
      instanceRoot: this.dir,
      runId: this.guard.runId,
      instance: this.instance,
      env: this.env,
      purpose,
    });
  }

  constructor() {
    const { dir, instance, env } = readInstance();
    this.dir = dir;
    this.instance = instance;
    this.env = env;
    this.admin = new pg.Client({ connectionString: env.P0_02_APP_DATABASE_URL });
    this.sync = new pg.Client({ connectionString: env.P0_02_SYNC_DATABASE_URL });
    this.boot = new pg.Client({
      host: instance.host, port: instance.port, user: instance.bootstrapUser,
      password: instance.bootstrapPassword, database: instance.dbName,
    });
  }

  async open(): Promise<void> {
    // F5.4: file-only guard first (marker/runId/db/port), then prove the live server identity in a
    // READ ONLY transaction before any write is allowed.
    this.guard = assertWritableTestTarget({
      instanceRoot: this.dir,
      runId: this.env.P0_02_RUN_ID ?? this.env.CATALOG_RUN_ID ?? undefined,
      instance: this.instance,
      env: this.env,
      purpose: 'inventory-pg-suite',
    });
    await Promise.all([this.admin.connect(), this.sync.connect(), this.boot.connect()]);
    // R4: every fixture connection proves the live server identity READ ONLY before any write — admin
    // and sync included (the boot connection below keeps its additional run_id read-only check).
    this.connectionVerifications = {
      admin: await assertConnectedTarget(this.admin, this.guard, 'inventory-pg-suite admin'),
      sync: await assertConnectedTarget(this.sync, this.guard, 'inventory-pg-suite sync'),
      boot: await assertConnectedTarget(this.boot, this.guard, 'inventory-pg-suite boot'),
    };
    await this.boot.query('BEGIN READ ONLY');
    let meta: any;
    try {
      meta = (await this.boot.query(
        `SELECT current_database() AS db, inet_server_port() AS port,
           (SELECT run_id FROM p0_02_meta.platform_instance LIMIT 1) AS run_id`)).rows[0];
    } catch (error) {
      await this.boot.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
    await this.boot.query('ROLLBACK');
    if (!meta || String(meta.db) !== this.guard.database.name
      || Number(meta.port) !== Number(this.guard.database.port)
      || String(meta.run_id) !== this.guard.runId) {
      throw new Error(
        `INVENTORY_TEST_TARGET_DB_VERIFY_MISMATCH: live=${JSON.stringify(meta)} `
        + `marker=${JSON.stringify({ db: this.guard.database.name, port: this.guard.database.port, runId: this.guard.runId })}`);
    }
    await this.admin.query(`SELECT set_config('request.jwt.claim.sub',$1,false)`, [ADMIN_ID]);
    const row: any = await this.bootOne(
      `SELECT id,account_label,external_account_code,status,last_login_ok_at,last_login_check_at,
        credential_state,source_system,created_at,updated_at
       FROM catalog.inventory_source_account ORDER BY created_at,id LIMIT 1`);
    if (row) {
      this.accountId = row.id as string;
    } else {
      const created: any = await this.bootOne(
        `INSERT INTO catalog.inventory_source_account(account_key,account_label,external_account_code,status)
         VALUES('bigseller-primary','laiguoyong@KNZX019402','KNZX019402','active') RETURNING id`);
      this.accountId = created.id as string;
    }
    const settings: any = await this.bootOne(
      `SELECT * FROM catalog.inventory_sync_settings WHERE account_id=$1`, [this.accountId]);
    const whs: any[] = await this.bootQuery(
      `SELECT id,external_warehouse_id,status FROM catalog.inventory_warehouse WHERE account_id=$1`,
      [this.accountId]);
    this.snapshot = {
      account: await this.bootOne(
        `SELECT account_label,external_account_code,status,last_login_ok_at,last_login_check_at,
          credential_state,source_system FROM catalog.inventory_source_account WHERE id=$1`,
        [this.accountId]),
      settings: settings ?? null,
      warehouses: whs,
    };
    this.suffix = crypto.randomBytes(3).toString('hex');
  }

  async close(): Promise<void> {
    await Promise.all([this.admin.end(), this.sync.end(), this.boot.end()]);
  }

  async restore(): Promise<void> {
    const a: any = this.snapshot.account;
    await this.bootQuery(
      `UPDATE catalog.inventory_source_account SET account_label=$2,external_account_code=$3,
        status=$4,last_login_ok_at=$5,last_login_check_at=$6,credential_state=$7,
        source_system=$8,updated_at=now() WHERE id=$1`,
      [this.accountId, a.account_label, a.external_account_code, a.status, a.last_login_ok_at,
        a.last_login_check_at, a.credential_state, a.source_system]);
    const s: any = this.snapshot.settings;
    if (s) {
      await this.bootQuery(
        `UPDATE catalog.inventory_sync_settings SET enabled=$2,interval_minutes=$3,scope_id=$4,
          next_run_at=$5,plan_anchor_at=$6,config_version=$7,updated_at=now(),updated_by=$8
         WHERE account_id=$1`,
        [this.accountId, s.enabled, s.interval_minutes, s.scope_id, s.next_run_at,
          s.plan_anchor_at, s.config_version, s.updated_by]);
    }
    for (const w of this.snapshot.warehouses as WarehouseRef[]) {
      await this.bootQuery(`UPDATE catalog.inventory_warehouse SET status=$2 WHERE id=$1`, [w.id, w.status]);
    }
    await this.bootQuery(
      `UPDATE catalog.inventory_sync_run SET status='failed',finished_at=now(),lease_owner=NULL,
        lease_token=NULL,lease_expires_at=NULL,error_code='TEST_ABORTED',updated_at=now()
       WHERE account_id=$1 AND status IN('queued','running','downloading','parsing','publishing','outcome_unknown')`,
      [this.accountId]);
  }

  // ---- raw helpers ----
  async adminSetIdentity(id: string): Promise<void> {
    await this.admin.query(`SELECT set_config('request.jwt.claim.sub',$1,false)`, [id]);
  }

  serializeArg(value: any): any {
    if (value === null || value === undefined) return null;
    if (Array.isArray(value)) {
      if (value.some((v: any) => v !== null && typeof v === 'object')) return JSON.stringify(value);
      return value;
    }
    if (typeof value === 'object' && !(value instanceof Date)) return JSON.stringify(value);
    return value;
  }

  async appCall(fn: string, args: any[] = []): Promise<any> {
    if (WRITE_RPCS.has(fn)) this.assertWritable(`rpc:${fn}`);
    const placeholders = args.map((_: any, i: number) => `$${i + 1}`).join(',');
    const res: any = await this.admin.query(`SELECT catalog.${fn}(${placeholders}) AS r`,
      args.map((a: any) => this.serializeArg(a)));
    return res.rows[0].r;
  }

  async syncCall(fn: string, args: any[] = []): Promise<any> {
    if (WRITE_RPCS.has(fn)) this.assertWritable(`rpc:${fn}`);
    const placeholders = args.map((_: any, i: number) => `$${i + 1}`).join(',');
    const res: any = await this.sync.query(`SELECT catalog.${fn}(${placeholders}) AS r`,
      args.map((a: any) => this.serializeArg(a)));
    return res.rows[0].r;
  }

  /** Fail active runs / pending writes left behind by an assertion failure (fixture account only). */
  async clearTestState(): Promise<void> {
    await this.bootQuery(
      `UPDATE catalog.inventory_pending_action SET status='failed',error_code='TEST_ABORTED',updated_at=now()
       WHERE account_id=$1 AND status='pending'`, [this.accountId]);
    await this.bootQuery(
      `UPDATE catalog.inventory_sync_run SET status='failed',finished_at=now(),lease_owner=NULL,
        lease_token=NULL,lease_expires_at=NULL,error_code='TEST_ABORTED',updated_at=now()
       WHERE account_id=$1 AND status IN('queued','running','downloading','parsing','publishing','outcome_unknown')`,
      [this.accountId]);
  }

  async adminSql(sql: string, params: any[] = []): Promise<any[]> {
    const res: any = await this.admin.query(sql, params);
    return res.rows as any[];
  }

  async syncSql(sql: string, params: any[] = []): Promise<any[]> {
    const res: any = await this.sync.query(sql, params);
    return res.rows as any[];
  }

  async bootQuery(sql: string, params: any[] = []): Promise<any[]> {
    if (/^\s*(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|SET\s+ROLE)\b/i.test(sql)) {
      this.assertWritable('owner-sql-write');
    }
    const res: any = await this.boot.query(sql, params);
    return res.rows as any[];
  }

  async bootOne(sql: string, params: any[] = []): Promise<any> {
    const rows: any[] = await this.bootQuery(sql, params);
    return rows[0] ?? null;
  }

  async expectError(fn: string, args: any[], pattern: string | RegExp): Promise<any> {
    let caught: any = null;
    try { await this.appCall(fn, args); } catch (e: any) { caught = e; }
    if (!caught) throw new Error(`expected ${fn} to fail with ${pattern}`);
    if (pattern instanceof RegExp) {
      if (!pattern.test(caught.message)) throw new Error(`expected ${fn} error ${pattern}, got ${caught.message}`);
    } else if (!String(caught.message).includes(pattern)) {
      throw new Error(`expected ${fn} error containing ${pattern}, got ${caught.message}`);
    }
    return caught;
  }

  async expectSyncError(fn: string, args: any[], pattern: string | RegExp): Promise<any> {
    let caught: any = null;
    try { await this.syncCall(fn, args); } catch (e: any) { caught = e; }
    if (!caught) throw new Error(`expected ${fn} to fail with ${pattern}`);
    if (pattern instanceof RegExp) {
      if (!pattern.test(caught.message)) throw new Error(`expected sync ${fn} error ${pattern}, got ${caught.message}`);
    } else if (!String(caught.message).includes(pattern)) {
      throw new Error(`expected sync ${fn} error ${pattern}, got ${caught.message}`);
    }
    return caught;
  }

  // ---- fixture builders ----
  async makeWarehouse(prefix: string,
    { market = null, status = 'candidate', name }: any = {}): Promise<WarehouseRef> {
    const ext = `FIX-${prefix}-${this.suffix}-${crypto.randomBytes(2).toString('hex')}`;
    const row: any = await this.bootOne(
      `INSERT INTO catalog.inventory_warehouse(account_id,external_warehouse_id,external_name,
        normalized_name,status,market,evidence)
       VALUES($1,$2,$3,lower($3),$4,$5,$6::jsonb) RETURNING id,external_warehouse_id`,
      [this.accountId, ext, name ?? ext, status, market,
        JSON.stringify({ source: 'test_fixture', prefix })]);
    return row as WarehouseRef;
  }

  async itemId(code: string): Promise<string> {
    const row: any = await this.bootOne(
      `SELECT item_id FROM catalog.catalog_item_code WHERE ice_code=$1`, [code]);
    if (!row) throw new Error(`seed item ${code} missing from this instance`);
    return row.item_id as string;
  }

  async itemCodes(): Promise<Array<{ ice_code: string; item_id: string }>> {
    return await this.bootQuery(
      `SELECT c.ice_code,c.item_id FROM catalog.catalog_item_code c
       WHERE c.ice_code IN ('LS101295','LS101302','WM0011','WM0026','WM0049')`) as
      Array<{ ice_code: string; item_id: string }>;
  }

  async setScope(warehouses: WarehouseRef[],
    { enabled = true, intervalMinutes = 30 }: any = {}): Promise<any> {
    return this.appCall('update_inventory_sync_settings',
      [randomId(), intentHash(), enabled, intervalMinutes, true,
        warehouses.map((w: WarehouseRef) => w.external_warehouse_id)]);
  }

  async registerWorker(workerId = `worker-${this.suffix}`): Promise<string> {
    await this.syncCall('register_inventory_worker', [workerId, '127.0.0.1', 1234, 'repair-v2-test']);
    this.workerId = workerId;
    return workerId;
  }

  async startRun(): Promise<{ runId: string; lease: string }> {
    if (!this.workerId) await this.registerWorker();
    const manual: any = await this.appCall('request_inventory_manual_sync', [randomId(), intentHash()]);
    const claim: any = await this.syncCall('claim_inventory_run', [this.workerId, 120]);
    if (!claim?.runId || claim.runId !== manual.runId) {
      throw new Error(`claim did not return the manual run (${JSON.stringify({ manual, claim })})`);
    }
    await this.syncCall('update_inventory_run_phase', [claim.runId, claim.leaseToken, 'parsing', {}]);
    return { runId: claim.runId as string, lease: claim.leaseToken as string };
  }

  row(excelRow: number, warehouseExternalId: string | null, externalSku: string,
    onHand: number | null, extra: any = {}): RowFixture {
    const num = (v: any) => (v === null || v === undefined ? null : v);
    return {
      excelRow, warehouseExternalId, warehouseName: warehouseExternalId, externalSku,
      productName: `fixture ${externalSku}`, gtin: null,
      onHand: num(onHand), orderLocked: 0, warehouseAvailable: num(onHand),
      activityReserved: 0, inTransit: 0,
      onHandText: onHand === null ? '' : String(onHand), orderLockedText: '0',
      warehouseAvailableText: onHand === null ? '' : String(onHand),
      activityReservedText: '0', inTransitText: '0',
      rawOnHand: onHand === null ? '' : String(onHand), rawOrderLocked: '0',
      rawWarehouseAvailable: onHand === null ? '' : String(onHand),
      rawActivityReserved: '0', rawInTransit: '0',
      rowHash: crypto.createHash('sha256')
        .update(JSON.stringify([excelRow, warehouseExternalId, externalSku, onHand, extra.hashSalt ?? '']))
        .digest('hex'),
      parseStatus: 'ok', reason: null,
      ...extra,
    } as RowFixture;
  }

  exportPayload(rows: RowFixture[],
    { sha, exportFinishedAt, exportStartedAt, discovery, identity, fileValidation,
      exportMark = 'fixture-export', header = ['仓库', 'SKU', '现有库存'], storageRelpath }: any = {}): any {
    const sha256 = sha ?? crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
    this.runSeq += 1;
    const observedAt = exportFinishedAt
      ?? new Date(Date.UTC(2026, 9, 20, 0, 10) + this.runSeq * 60_000).toISOString();
    return {
      exportMark,
      exportStartedAt: exportStartedAt ?? new Date(Date.parse(observedAt) - 10 * 60_000).toISOString(),
      exportFinishedAt: observedAt,
      accountIdentity: identity ?? {
        label: 'laiguoyong@KNZX019402', verified: true,
      },
      fileValidation: fileValidation ?? { blocked: false, headerOk: true },
      warehouseDiscovery: discovery ?? [...new Set(rows.map((r: RowFixture) => r.warehouseExternalId)
        .filter(Boolean))].map((externalId: any) => ({ externalId, name: externalId })),
      file: {
        sha256, sizeBytes: 1024, storageRelpath: storageRelpath ?? `fixtures/${sha256.slice(0, 8)}.xlsx`,
        sheetName: 'Sheet1', header, rowCount: rows.length, parserVersion: 'repair-v2-test',
        downloadedAt: new Date('2026-10-20T00:11:00.000Z').toISOString(),
      },
      blankRowCount: 0,
      rows,
    };
  }

  async registerExport(runId: string, lease: string, payload: any): Promise<any> {
    return this.syncCall('register_inventory_export', [runId, lease, payload]);
  }

  async publish(runId: string, lease: string, warehouseId: string, rows: RowFixture[]): Promise<any> {
    return this.syncCall('publish_inventory_warehouse',
      [runId, lease, { warehouseId, rowCount: rows.length }, rows]);
  }

  async finish(runId: string, lease: string, status = 'success', summary: any = {}): Promise<any> {
    return this.syncCall('finish_inventory_run', [runId, lease, status, summary]);
  }

  async fail(runId: string, lease: string, errorCode = 'TEST_FAILED', detail = 'fixture failure',
    needsLogin = false, outcomeUnknown = false): Promise<any> {
    return this.syncCall('fail_inventory_run', [runId, lease, errorCode, detail, needsLogin, outcomeUnknown]);
  }

  /** Create confirmed warehouse-level mappings through the app RPC (audited path). */
  async confirmMappings(mappings: any[]): Promise<any> {
    return this.appCall('confirm_inventory_mapping', [
      randomId(), intentHash(),
      mappings.map((m: any) => ({
        externalSku: m.sku, warehouseExternalId: m.warehouseExternalId, itemId: m.itemId,
        unit: m.unit ?? '件', reason: m.reason ?? 'fixture confirm',
        expectedVersion: m.expectedVersion ?? null,
        variantKey: m.variantKey ?? 'default',
        ...(m.verification ? { verification: true } : {}),
      })),
    ]);
  }

  /** One complete run: manual -> claim -> export -> publish every given warehouse -> finish. */
  async publishRun({ warehouses, rows, exportFinishedAt, sha, identity, fileValidation, discovery,
    publishOnly = null, finishStatus = 'success', summary = {}, exportMark }: any = {}): Promise<any> {
    const { runId, lease } = await this.startRun();
    const payload = this.exportPayload(rows, { sha, exportFinishedAt, identity, fileValidation,
      discovery, exportMark });
    const receipt = await this.registerExport(runId, lease, payload);
    const published: any[] = [];
    for (const wh of warehouses as WarehouseRef[]) {
      if (publishOnly && !(publishOnly as string[]).includes(wh.external_warehouse_id)) continue;
      const whRows = (rows as RowFixture[]).filter((r: RowFixture) =>
        r.warehouseExternalId === wh.external_warehouse_id && r.parseStatus === 'ok');
      published.push(await this.publish(runId, lease, wh.id, whRows));
    }
    const finished = await this.finish(runId, lease, finishStatus, summary);
    return { runId, lease, payload, receipt, published, finished };
  }

  async list(search: string | null = null, warehouse: string | null = null,
    market: string | null = null, limit = 50, offset = 0): Promise<any> {
    return this.appCall('read_inventory_list', [search, warehouse, market, limit, offset]);
  }

  async listItem(itemId: string): Promise<any> {
    const list: any = await this.list(null, null, null, 200, 0);
    return (list.items as any[]).find((i: any) => i.itemId === itemId) ?? null;
  }

  async detail(itemId: string, warehouse: string | null = null, market: string | null = null,
    allWarehouses = false): Promise<any> {
    return this.appCall('read_inventory_item', [itemId, warehouse, market, allWarehouses]);
  }

  async overview(): Promise<any> { return this.appCall('read_inventory_sync_overview'); }
  async runDetail(runId: string): Promise<any> { return this.appCall('read_inventory_sync_run', [runId]); }
  async mappingQueue(search: string | null = null, limit = 20, offset = 0): Promise<any> {
    return this.appCall('read_inventory_mapping_queue', [search, limit, offset]);
  }
  async searchItems(search: string, limit = 20): Promise<any[]> {
    return this.appCall('search_inventory_items', [search, limit]);
  }
  async pendingActions(): Promise<any> { return this.appCall('read_inventory_pending_actions'); }
}
