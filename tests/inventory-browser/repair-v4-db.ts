import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Client } from 'pg';
import {
  assertWritableTestTarget,
  assertConnectedTarget,
} from '../../scripts/inventory/test-target-guard.mjs';

/**
 * v4 页面验证的数据库辅助（从 v3 复制成 v4 版本，全部只连新隔离实例）。
 * - 连接前：assertWritableTestTarget（marker.testWritable / runId / loopback / 端口 / 库名）；
 * - 连接后：assertConnectedTarget（BEGIN READ ONLY 查 current_database/inet_server_addr/inet_server_port）；
 * - 默认只读事务（BEGIN TRANSACTION READ ONLY + request.jwt.claim.sub）；
 * - 受控 fixture 写入（旧 v3 指纹 pending、第二管理员角色）只在 INVENTORY_DB_GRANT_ALLOWED=1 时允许，
 *   且只用 owner/marker 指向的实例；不打印连接串/密码。
 */

export interface InstanceEnv {
  dir: string;
  runRoot: string;
  runId: string;
  appDbUrl: string;
  ownerDbUrl: string | null;
  database: string;
  appRole: string;
  webPort: number;
  guard: {
    runId: string;
    database: { host: string; port: number; name: string };
  };
  guardVerification: unknown;
}

export interface InstanceDb {
  client: Client;
  adminProfileId: string;
  close: () => Promise<void>;
}

const DEFAULT_ADMIN_PROFILE_ID = '11111111-1111-4111-8111-111111111101';
const OPERATOR_PROFILE_ID = '11111111-1111-4111-8111-111111111104';

export function readInstanceEnv(): InstanceEnv {
  const dir = process.env.INVENTORY_INSTANCE_DIR;
  if (!dir) throw new Error('INVENTORY_INSTANCE_DIR_REQUIRED（指向实例 instance 目录）');
  const envPath = path.join(dir, 'env.catalog.json');
  const inventoryEnvPath = path.join(dir, 'env.inventory.json');
  if (!fs.existsSync(envPath) || !fs.existsSync(inventoryEnvPath)) {
    throw new Error(`INVENTORY_INSTANCE_DIR_INVALID: ${dir}`);
  }
  const catalog = JSON.parse(fs.readFileSync(envPath, 'utf8')) as Record<string, string>;
  const inventory = JSON.parse(fs.readFileSync(inventoryEnvPath, 'utf8')) as Record<string, unknown>;
  const appDbUrl = catalog.P0_02_APP_DATABASE_URL;
  if (!appDbUrl) throw new Error('P0_02_APP_DATABASE_URL_MISSING');
  const runId = typeof inventory.runId === 'string' ? inventory.runId : '';
  if (!runId) throw new Error('INVENTORY_RUN_ID_MISSING');
  const expectedRunId = process.env.INVENTORY_EXPECTED_RUN_ID;
  if (expectedRunId && expectedRunId !== runId) {
    throw new Error(`INVENTORY_INSTANCE_RUN_MISMATCH: ${runId} != ${expectedRunId}`);
  }
  // 连接前守卫：marker 必须 testWritable=true、runId/端口/库名一致、非保护实例。
  const guard = assertWritableTestTarget({
    instanceRoot: dir,
    runId,
    instance: {
      runId,
      host: typeof inventory.host === 'string' ? inventory.host : undefined,
      port: typeof inventory.port === 'number' ? inventory.port : undefined,
      dbName: typeof inventory.database === 'string' ? inventory.database : undefined,
    },
    env: catalog,
    purpose: 'inventory-repair-v4.browser',
  });
  return {
    dir,
    runRoot: typeof inventory.runRoot === 'string' ? inventory.runRoot : path.dirname(dir),
    runId,
    appDbUrl,
    ownerDbUrl: typeof inventory.ownerDbUrl === 'string' ? inventory.ownerDbUrl : null,
    database: typeof inventory.database === 'string' ? inventory.database : catalog.P0_02_EXPECTED_DATABASE,
    appRole: new URL(appDbUrl).username,
    webPort: typeof inventory.webPort === 'number' ? inventory.webPort : 3034,
    guard: {
      runId: guard.runId,
      database: guard.database as { host: string; port: number; name: string },
    },
    guardVerification: guard,
  };
}

export async function openInstanceDb(env: InstanceEnv = readInstanceEnv()): Promise<InstanceDb> {
  const adminProfileId = process.env.INVENTORY_ADMIN_PROFILE_ID ?? DEFAULT_ADMIN_PROFILE_ID;
  const client = new Client({ connectionString: env.appDbUrl, database: env.database });
  await client.connect();
  // 连接后实际身份核对（只读）；不一致会抛 INVENTORY_TEST_TARGET_DB_VERIFY_MISMATCH。
  const verification = await assertConnectedTarget(client, env.guard, 'browser-suite-readonly');
  env.guardVerification = { ...(env.guardVerification as object), connectedTarget: verification };
  // 只读事务 + 主审同款身份 claim；任何写语句都会被数据库拒绝。
  await client.query('BEGIN TRANSACTION READ ONLY');
  await client.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [adminProfileId]);
  return {
    client,
    adminProfileId,
    close: async () => {
      try {
        await client.query('ROLLBACK');
      } finally {
        await client.end();
      }
    },
  };
}

/** 受控 fixture 才允许写：必须显式授权 + 新隔离实例（ownerDbUrl 来自 marker 实例）。 */
function requireFixtureWrite(env: InstanceEnv): string {
  if (process.env.INVENTORY_DB_GRANT_ALLOWED !== '1') {
    throw new Error('INVENTORY_DB_GRANT_ALLOWED_REQUIRED（受控 fixture 需要 Lead 明确授权）');
  }
  if (!env.ownerDbUrl) throw new Error('INVENTORY_OWNER_DB_URL_MISSING');
  return env.ownerDbUrl;
}

async function openVerifiedClient(env: InstanceEnv, connectionString: string, purpose: string): Promise<Client> {
  const client = new Client({ connectionString, database: env.database });
  await client.connect();
  await assertConnectedTarget(client, env.guard, purpose);
  return client;
}

export interface SettingRow {
  enabled: boolean;
  intervalMinutes: number;
  configVersion: number;
}

export async function readSettings(db: InstanceDb): Promise<SettingRow> {
  const result = await db.client.query<{ enabled: boolean; interval_minutes: number; config_version: number }>(
    'SELECT enabled, interval_minutes, config_version FROM catalog.inventory_sync_settings ORDER BY updated_at DESC LIMIT 1',
  );
  if (result.rowCount !== 1) throw new Error('INVENTORY_SETTINGS_ROW_MISSING');
  const row = result.rows[0];
  return { enabled: row.enabled, intervalMinutes: row.interval_minutes, configVersion: row.config_version };
}

export interface RequestDbInfo {
  requestCount: number;
  pendingStatus: string | null;
  requestAction: string | null;
  requestIntent: string | null;
  hasResponse: boolean;
}

export async function readRequest(db: InstanceDb, requestId: string): Promise<RequestDbInfo> {
  const request = await db.client.query<{ action: string; intent_hash: string; response: unknown }>(
    'SELECT action, intent_hash, response FROM catalog.inventory_request WHERE request_id = $1',
    [requestId],
  );
  const pending = await db.client.query<{ status: string }>(
    'SELECT status FROM catalog.inventory_pending_action WHERE request_id = $1',
    [requestId],
  );
  return {
    requestCount: request.rowCount ?? 0,
    pendingStatus: pending.rowCount ? pending.rows[0].status : null,
    requestAction: request.rowCount ? request.rows[0].action : null,
    requestIntent: request.rowCount ? request.rows[0].intent_hash : null,
    hasResponse: Boolean(request.rowCount && request.rows[0].response),
  };
}

export interface MappingDbInfo {
  id: string;
  version: number;
  status: string;
  unit: string;
  verification: boolean;
  unitConfirmed: boolean | null;
  evidenceSource: string | null;
  itemId: string;
  itemIceCode: string | null;
}

/** 指定 (externalSku × 仓库外部编码) 的最新 mapping（任一状态）。 */
export async function readMapping(
  db: InstanceDb,
  externalSku: string,
  warehouseExternalId: string,
): Promise<MappingDbInfo | null> {
  const result = await db.client.query<{
    id: string; version: number; status: string; unit: string; evidence: Record<string, unknown> | null;
    item_id: string; ice_code: string | null;
  }>(
    `SELECT m.id, m.version, m.status, m.unit, m.evidence, m.item_id, c.ice_code
       FROM catalog.inventory_sku_mapping m
       JOIN catalog.inventory_warehouse w ON w.id = m.warehouse_id
       LEFT JOIN catalog.catalog_item_code c ON c.item_id = m.item_id
      WHERE m.external_sku = $1 AND w.external_warehouse_id = $2
      ORDER BY m.version DESC LIMIT 1`,
    [externalSku, warehouseExternalId],
  );
  if (result.rowCount === 0) return null;
  const row = result.rows[0];
  const evidence = row.evidence ?? {};
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    unit: row.unit,
    verification: evidence.verification === true,
    unitConfirmed: typeof evidence.unitConfirmed === 'boolean' ? evidence.unitConfirmed : null,
    evidenceSource: typeof evidence.source === 'string' ? evidence.source : null,
    itemId: row.item_id,
    itemIceCode: row.ice_code,
  };
}

export async function readWarehouseId(db: InstanceDb, externalWarehouseId: string): Promise<string | null> {
  const result = await db.client.query<{ id: string }>(
    'SELECT id FROM catalog.inventory_warehouse WHERE external_warehouse_id = $1 LIMIT 1',
    [externalWarehouseId],
  );
  return result.rowCount ? result.rows[0].id : null;
}

export async function readItemIdByIceCode(db: InstanceDb, iceCode: string): Promise<string | null> {
  const result = await db.client.query<{ item_id: string }>(
    'SELECT item_id FROM catalog.catalog_item_code WHERE ice_code = $1 LIMIT 1',
    [iceCode],
  );
  return result.rowCount ? result.rows[0].item_id : null;
}

export async function readBoundAccountId(db: InstanceDb, profileId: string): Promise<string | null> {
  const result = await db.client.query<{ account_id: string }>(
    `SELECT a.id AS account_id FROM catalog.inventory_source_account a
      ORDER BY a.created_at LIMIT 1`,
  );
  void profileId;
  return result.rowCount ? result.rows[0].account_id : null;
}

/** 任一 confirmed mapping（用于 R2-1 详情维护锁断言）；不依赖固定种子 SKU。 */
export async function readFirstConfirmedMapping(db: InstanceDb): Promise<{
  externalSku: string;
  warehouseExternalId: string;
  warehouseName: string;
  itemId: string;
  itemIceCode: string | null;
} | null> {
  const result = await db.client.query<{
    external_sku: string; external_warehouse_id: string; warehouse_name: string;
    item_id: string; ice_code: string | null;
  }>(
    `SELECT m.external_sku, w.external_warehouse_id, w.external_name AS warehouse_name, m.item_id, c.ice_code
       FROM catalog.inventory_sku_mapping m
       JOIN catalog.inventory_warehouse w ON w.id = m.warehouse_id
       LEFT JOIN catalog.catalog_item_code c ON c.item_id = m.item_id
      WHERE m.status='confirmed' AND c.ice_code IS NOT NULL
      ORDER BY m.created_at DESC, m.id LIMIT 1`,
  );
  if (result.rowCount === 0) return null;
  const row = result.rows[0];
  return {
    externalSku: row.external_sku,
    warehouseExternalId: row.external_warehouse_id,
    warehouseName: row.warehouse_name,
    itemId: row.item_id,
    itemIceCode: row.ice_code,
  };
}

/** 两个不同商品 id（R2-5 旧指纹碰撞反例用）。 */
export async function readTwoItemIds(db: InstanceDb): Promise<[string, string] | null> {
  const result = await db.client.query<{ id: string }>(
    'SELECT id FROM catalog.catalog_item ORDER BY id LIMIT 2',
  );
  if ((result.rowCount ?? 0) < 2) return null;
  return [result.rows[0].id, result.rows[1].id];
}

/* ------------------------------------------------------------------ *
 * 受控 fixture（仅 INVENTORY_DB_GRANT_ALLOWED=1；只写新隔离实例）
 * ------------------------------------------------------------------ */

export interface PendingFixture {
  requestId: string;
  actorId: string;
  accountId: string;
  intent: string;
  sqlLog: string[];
}

/** 造一条“旧 v3 指纹”的本人 pending（模拟旧版本遗留、服务端持久内容可信）。 */
export async function insertLegacyPendingFixture(
  env: InstanceEnv,
  db: InstanceDb,
  input: {
    action: string;
    intent: string;
    payload: Record<string, unknown>;
    requestId?: string;
  },
): Promise<PendingFixture> {
  const ownerDbUrl = requireFixtureWrite(env);
  const actorId = db.adminProfileId;
  const accountId = await readBoundAccountId(db, actorId);
  if (!accountId) throw new Error('INVENTORY_SOURCE_ACCOUNT_NOT_FOUND');
  const requestId = input.requestId ?? crypto.randomUUID();
  const client = await openVerifiedClient(env, ownerDbUrl, 'fixture-insert-legacy-pending');
  const sqlLog: string[] = [];
  try {
    await client.query("DELETE FROM catalog.inventory_pending_action WHERE status='pending'");
    await client.query(
      `INSERT INTO catalog.inventory_pending_action
         (request_id, account_id, actor_id, action, intent_hash, payload, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,'pending',now(),now())`,
      [requestId, accountId, actorId, input.action, input.intent, JSON.stringify(input.payload)],
    );
    sqlLog.push(`INSERT catalog.inventory_pending_action request_id=${requestId} action=${input.action} intent=${input.intent} status=pending`);
    return { requestId, actorId, accountId, intent: input.intent, sqlLog };
  } finally {
    await client.end();
  }
}

export async function deletePendingByRequestId(env: InstanceEnv, requestId: string): Promise<void> {
  const ownerDbUrl = requireFixtureWrite(env);
  const client = await openVerifiedClient(env, ownerDbUrl, 'fixture-delete-pending');
  try {
    await client.query('DELETE FROM catalog.inventory_pending_action WHERE request_id=$1', [requestId]);
  } finally {
    await client.end();
  }
}

export async function deleteAllTestPending(env: InstanceEnv): Promise<string[]> {
  const ownerDbUrl = requireFixtureWrite(env);
  const client = await openVerifiedClient(env, ownerDbUrl, 'fixture-delete-all-pending');
  try {
    const result = await client.query(
      "DELETE FROM catalog.inventory_pending_action WHERE status='pending' RETURNING request_id",
    );
    return result.rows.map((row: { request_id: string }) => row.request_id);
  } finally {
    await client.end();
  }
}

export interface PendingRowInfo {
  status: string;
  actorId: string | null;
  intentHash: string;
  payload: Record<string, unknown>;
}

export async function readPendingRow(db: InstanceDb, requestId: string): Promise<PendingRowInfo | null> {
  const result = await db.client.query<{
    status: string; actor_id: string | null; intent_hash: string; payload: Record<string, unknown>;
  }>(
    'SELECT status, actor_id, intent_hash, payload FROM catalog.inventory_pending_action WHERE request_id=$1',
    [requestId],
  );
  if (result.rowCount === 0) return null;
  const row = result.rows[0];
  return { status: row.status, actorId: row.actor_id, intentHash: row.intent_hash, payload: row.payload };
}

/** 以 app 角色真实调用 begin RPC（登记/重放/冲突证据）；返回错误码而不是吞掉。 */
export async function callBeginPending(
  env: InstanceEnv,
  input: {
    requestId: string;
    intent: string;
    action: string;
    payload: Record<string, unknown>;
    profileId: string;
  },
): Promise<{ ok: boolean; code: string | null; message: string; result: unknown }> {
  const client = new Client({ connectionString: env.appDbUrl, database: env.database });
  await client.connect();
  try {
    await assertConnectedTarget(client, env.guard, 'fixture-begin-pending');
    await client.query('BEGIN');
    await client.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [input.profileId]);
    try {
      const result = await client.query(
        'SELECT catalog.begin_inventory_pending_action($1,$2,$3,$4::jsonb) AS result',
        [input.requestId, input.intent, input.action, JSON.stringify(input.payload)],
      );
      await client.query('ROLLBACK');
      const row = result.rows[0]?.result;
      return { ok: true, code: null, message: 'ok', result: row };
    } catch (error) {
      const record = error as { code?: string; message?: string };
      await client.query('ROLLBACK').catch(() => undefined);
      return { ok: false, code: record.code ?? null, message: record.message ?? String(error), result: null };
    }
  } finally {
    await client.end();
  }
}

/** 第二管理员：把种子 operator 临时提升为 active admin（R2-2 换管理员真实登录），结束后恢复。 */
export async function promoteOperatorToAdmin(env: InstanceEnv): Promise<{ sqlLog: string[] }> {
  const ownerDbUrl = requireFixtureWrite(env);
  const client = await openVerifiedClient(env, ownerDbUrl, 'fixture-promote-operator');
  const sqlLog: string[] = [];
  try {
    await client.query(
      `UPDATE public.profiles SET role_id=(SELECT id FROM public.role WHERE name='admin'), is_active=true
        WHERE id=$1`,
      [OPERATOR_PROFILE_ID],
    );
    sqlLog.push(`UPDATE public.profiles SET role_id=admin,is_active=true WHERE id='${OPERATOR_PROFILE_ID}'`);
    return { sqlLog };
  } finally {
    await client.end();
  }
}

export async function restoreOperatorRole(env: InstanceEnv): Promise<void> {
  const ownerDbUrl = requireFixtureWrite(env);
  const client = await openVerifiedClient(env, ownerDbUrl, 'fixture-restore-operator');
  try {
    await client.query(
      `UPDATE public.profiles SET role_id=(SELECT id FROM public.role WHERE name='operator')
        WHERE id=$1`,
      [OPERATOR_PROFILE_ID],
    );
  } finally {
    await client.end();
  }
}

/* ------------------------------------------------------------------ *
 * 旧 v3 指纹（只用于“同旧指纹不同内容被拒”的定向反例与旧 pending 恢复）
 * ------------------------------------------------------------------ */

export interface LegacyConfirmMapping {
  externalSku: string;
  warehouseExternalId: string;
  itemId: string;
  unit: string;
  expectedVersion: number | null;
  reason: string;
  note?: string | null;
  verification?: boolean;
}

function sha256Hex(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** 旧 confirm v3 文本（未转义 | 拼接）——只用于复现旧指纹与构造兼容 fixture，不用于新写。 */
export function legacyConfirmV3Text(mappings: LegacyConfirmMapping[]): string {
  const items = mappings
    .map((mapping) => [
      (mapping.externalSku ?? '').trim(),
      (mapping.warehouseExternalId ?? '').trim(),
      (mapping.itemId ?? '').trim(),
      (mapping.unit ?? '').trim(),
      mapping.expectedVersion === null || mapping.expectedVersion === undefined ? '' : String(Math.trunc(mapping.expectedVersion)),
      (mapping.reason ?? '').trim(),
      (mapping.note ?? '').trim(),
      mapping.verification === true ? 'verification=true' : 'verification=false',
    ].join('|'))
    .sort();
  return `inventory.confirm_mappings.v3|${items.join(';')}`;
}

export function legacyConfirmV3Intent(mappings: LegacyConfirmMapping[]): string {
  return sha256Hex(legacyConfirmV3Text(mappings));
}

/** 旧 manual v2 指纹（历史 pending 兼容验证）。 */
export function legacyManualV2Intent(): string {
  return sha256Hex('inventory.manual_sync.v2');
}

/**
 * R2-5 定向反例：同一条旧 v3 指纹文本，一条 mapping 的备注内嵌了第二条 mapping 的拼接文本。
 * 旧编码下两者文本完全相等；v4 结构化编码下必须不同。
 */
export function legacyFingerprintCollisionFixture(itemA: string, itemB: string): {
  one: LegacyConfirmMapping;
  two: LegacyConfirmMapping[];
  legacyTextOne: string;
  legacyTextTwo: string;
} {
  const secondLine = ['SKU-B', 'W-B', itemB, '件', '', '验证确认 B', '备注 B'].join('|');
  const one: LegacyConfirmMapping = {
    externalSku: 'SKU-A',
    warehouseExternalId: 'W-A',
    itemId: itemA,
    unit: '件',
    expectedVersion: null,
    reason: '验证确认 A',
    note: `备注 A|verification=true;${secondLine}`,
    verification: true,
  };
  const two: LegacyConfirmMapping[] = [
    {
      externalSku: 'SKU-A',
      warehouseExternalId: 'W-A',
      itemId: itemA,
      unit: '件',
      expectedVersion: null,
      reason: '验证确认 A',
      note: '备注 A',
      verification: true,
    },
    {
      externalSku: 'SKU-B',
      warehouseExternalId: 'W-B',
      itemId: itemB,
      unit: '件',
      expectedVersion: null,
      reason: '验证确认 B',
      note: '备注 B',
      verification: true,
    },
  ];
  return {
    one,
    two,
    legacyTextOne: legacyConfirmV3Text([one]),
    legacyTextTwo: legacyConfirmV3Text(two),
  };
}
