import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';

/**
 * 只读验证 v3 页面的数据库最终效果。
 * - 读实例目录 instance/env.catalog.json 的 P0_02_APP_DATABASE_URL；
 * - 连接后立即 `BEGIN TRANSACTION READ ONLY`，并按主审只读方式设置 request.jwt.claim.sub；
 * - 只 SELECT，不写业务数据、不打印连接串/密码；
 * - F4 解锁失败/他人 pending fixture 仅在 Lead 显式授权（INVENTORY_DB_GRANT_ALLOWED=1）时写权限/受控 fixture。
 */
export interface InstanceDb {
  client: Client;
  adminProfileId: string;
  close: () => Promise<void>;
}

export interface InstanceEnv {
  dir: string;
  appDbUrl: string;
  ownerDbUrl: string | null;
  database: string;
  appRole: string;
  webPort: number;
}

const DEFAULT_ADMIN_PROFILE_ID = '11111111-1111-4111-8111-111111111101';

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
  const database = typeof inventory.database === 'string' ? inventory.database : catalog.P0_02_EXPECTED_DATABASE;
  const ownerDbUrl = typeof inventory.ownerDbUrl === 'string' ? inventory.ownerDbUrl : null;
  return {
    dir,
    appDbUrl,
    ownerDbUrl,
    database,
    appRole: new URL(appDbUrl).username,
    webPort: typeof inventory.webPort === 'number' ? inventory.webPort : 3033,
  };
}

export async function openInstanceDb(env: InstanceEnv = readInstanceEnv()): Promise<InstanceDb> {
  const adminProfileId = process.env.INVENTORY_ADMIN_PROFILE_ID ?? DEFAULT_ADMIN_PROFILE_ID;
  const client = new Client({ connectionString: env.appDbUrl, database: env.database });
  await client.connect();
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
  itemIceCode: string | null;
  itemName: string | null;
}

/** 指定 (externalSku × 仓库外部编码) 的最新 mapping（任一状态）。 */
export async function readMapping(
  db: InstanceDb,
  externalSku: string,
  warehouseExternalId: string,
): Promise<MappingDbInfo | null> {
  const result = await db.client.query<{
    id: string; version: number; status: string; unit: string; evidence: Record<string, unknown> | null;
    ice_code: string | null; name_cn: string | null;
  }>(
    `SELECT m.id, m.version, m.status, m.unit, m.evidence, c.ice_code, ir.name_cn
       FROM catalog.inventory_sku_mapping m
       JOIN catalog.inventory_warehouse w ON w.id = m.warehouse_id
       LEFT JOIN catalog.catalog_item_code c ON c.item_id = m.item_id
       LEFT JOIN catalog.item_current ic ON ic.item_id = m.item_id
       LEFT JOIN catalog.item_revision ir ON ir.item_id = ic.item_id AND ir.revision = ic.revision
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
    itemIceCode: row.ice_code,
    itemName: row.name_cn,
  };
}

export async function readWarehouseId(db: InstanceDb, externalWarehouseId: string): Promise<string | null> {
  const result = await db.client.query<{ id: string }>(
    'SELECT id FROM catalog.inventory_warehouse WHERE external_warehouse_id = $1 LIMIT 1',
    [externalWarehouseId],
  );
  return result.rowCount ? result.rows[0].id : null;
}

export async function countMappings(
  db: InstanceDb,
  externalSku: string,
  warehouseExternalId: string,
): Promise<number> {
  const result = await db.client.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM catalog.inventory_sku_mapping m
       JOIN catalog.inventory_warehouse w ON w.id = m.warehouse_id
      WHERE m.external_sku = $1 AND w.external_warehouse_id = $2 AND m.status = 'confirmed'`,
    [externalSku, warehouseExternalId],
  );
  return Number(result.rows[0]?.count ?? '0');
}

export async function setCompleteExecuteAllowed(env: InstanceEnv, allowed: boolean): Promise<void> {
  if (process.env.INVENTORY_DB_GRANT_ALLOWED !== '1') {
    throw new Error('INVENTORY_DB_GRANT_ALLOWED_REQUIRED（解锁失败用例需要 Lead 明确授权临时 REVOKE/GRANT）');
  }
  if (!env.ownerDbUrl) throw new Error('INVENTORY_OWNER_DB_URL_MISSING');
  const client = new Client({ connectionString: env.ownerDbUrl, database: env.database });
  await client.connect();
  try {
    const sql = `${allowed ? 'GRANT' : 'REVOKE'} EXECUTE ON FUNCTION catalog.complete_inventory_pending_action(uuid,text,jsonb,text) ${allowed ? 'TO' : 'FROM'} ${env.appRole}`;
    await client.query(sql);
  } finally {
    await client.end();
  }
}

export async function deleteOwnTestPending(env: InstanceEnv, requestId: string): Promise<boolean> {
  if (process.env.INVENTORY_DB_GRANT_ALLOWED !== '1') throw new Error('INVENTORY_DB_GRANT_ALLOWED_REQUIRED');
  if (!env.ownerDbUrl) throw new Error('INVENTORY_OWNER_DB_URL_MISSING');
  const client = new Client({ connectionString: env.ownerDbUrl, database: env.database });
  await client.connect();
  try {
    const r = await client.query(
      "DELETE FROM catalog.inventory_pending_action WHERE request_id=$1 AND status='pending' RETURNING request_id",
      [requestId],
    );
    return (r.rowCount ?? 0) > 0;
  } finally {
    await client.end();
  }
}

/** 仅测试实例：清理上一轮失败用例遗留的 pending（Lead 授权的受控 fixture 清理）。 */
export async function deleteAllTestPending(env: InstanceEnv): Promise<string[]> {
  if (process.env.INVENTORY_DB_GRANT_ALLOWED !== '1') throw new Error('INVENTORY_DB_GRANT_ALLOWED_REQUIRED');
  if (!env.ownerDbUrl) throw new Error('INVENTORY_OWNER_DB_URL_MISSING');
  const client = new Client({ connectionString: env.ownerDbUrl, database: env.database });
  await client.connect();
  try {
    const r = await client.query(
      "DELETE FROM catalog.inventory_pending_action WHERE status='pending' RETURNING request_id",
    );
    return r.rows.map((row: { request_id: string }) => row.request_id);
  } finally {
    await client.end();
  }
}

/** 恢复后必须断言 app 角色重新拥有 EXECUTE（Lead 授权要求）。 */
export async function assertCompleteExecutePrivilege(env: InstanceEnv): Promise<boolean> {
  if (!env.ownerDbUrl) throw new Error('INVENTORY_OWNER_DB_URL_MISSING');
  const client = new Client({ connectionString: env.ownerDbUrl, database: env.database });
  await client.connect();
  try {
    const result = await client.query<{ ok: boolean }>(
      "SELECT has_function_privilege($1,'catalog.complete_inventory_pending_action(uuid,text,jsonb,text)','EXECUTE') AS ok",
      [env.appRole],
    );
    return result.rows[0]?.ok === true;
  } finally {
    await client.end();
  }
}

export interface ForeignPendingFixture {
  requestId: string;
  actorId: string;
  sqlLog: string[];
  cleanup: () => Promise<void>;
}

/**
 * 他人 pending 隔离 fixture（Lead 授权，仅新实例；不登录第二管理员）：
 * - 临时建 active admin profile（actor）；
 * - 以 seed 账号 + 该 actor 插一条 pending（每账号唯一，会阻塞主管理员写入，故放在最后一个用例）。
 * 清理：先 DELETE pending，再 DELETE 临时 profile；返回执行 SQL 供报告。
 */
export async function insertForeignPendingFixture(env: InstanceEnv): Promise<ForeignPendingFixture> {
  if (process.env.INVENTORY_DB_GRANT_ALLOWED !== '1') {
    throw new Error('INVENTORY_DB_GRANT_ALLOWED_REQUIRED（他人 pending fixture 需 Lead 明确授权）');
  }
  if (!env.ownerDbUrl) throw new Error('INVENTORY_OWNER_DB_URL_MISSING');
  const client = new Client({ connectionString: env.ownerDbUrl, database: env.database });
  await client.connect();
  const requestId = crypto.randomUUID();
  const actorId = crypto.randomUUID();
  const sqlLog: string[] = [];
  try {
    const role = await client.query<{ id: string }>("SELECT id FROM public.role WHERE name='admin'");
    if (role.rowCount !== 1) throw new Error('ADMIN_ROLE_NOT_FOUND');
    const adminRoleId = role.rows[0].id;
    // profiles.id FK → auth.users；先建临时 auth user，再建 profile。
    await client.query(
      'INSERT INTO auth.users (id, email) VALUES ($1, $2)',
      [actorId, `pending-fixture-${actorId}@isolated.test`],
    );
    sqlLog.push(`INSERT INTO auth.users(id,email) VALUES('${actorId}','pending-fixture-${actorId}@isolated.test')`);
    await client.query(
      'INSERT INTO public.profiles (id, display_name, role_id, is_active) VALUES ($1, $2, $3, true)',
      [actorId, 'ISOLATED TEST temp admin (pending fixture)', adminRoleId],
    );
    sqlLog.push(`INSERT INTO public.profiles(id,display_name,role_id,is_active) VALUES('${actorId}','ISOLATED TEST temp admin (pending fixture)','${adminRoleId}',true)`);
    const account = await client.query<{ id: string }>('SELECT id FROM catalog.inventory_source_account ORDER BY created_at LIMIT 1');
    if (account.rowCount !== 1) throw new Error('INVENTORY_SOURCE_ACCOUNT_NOT_FOUND');
    const accountId = account.rows[0].id;
    // 清理可能的历史 fixture（同一账号最多一个 pending）。
    await client.query("DELETE FROM catalog.inventory_pending_action WHERE status='pending'");
    const intent = '0'.repeat(64);
    await client.query(
      `INSERT INTO catalog.inventory_pending_action (request_id, account_id, actor_id, action, intent_hash, payload, status)
       VALUES ($1,$2,$3,'update_inventory_sync_settings',$4,'{}'::jsonb,'pending')`,
      [requestId, accountId, actorId, intent],
    );
    sqlLog.push(`INSERT INTO catalog.inventory_pending_action(request_id,account_id,actor_id,action,intent_hash,payload,status) VALUES('${requestId}','${accountId}','${actorId}','update_inventory_sync_settings','${intent}','{}','pending')`);
    return {
      requestId,
      actorId,
      sqlLog,
      cleanup: async () => {
        try {
          await client.query('DELETE FROM catalog.inventory_pending_action WHERE request_id=$1', [requestId]);
          await client.query('DELETE FROM public.profiles WHERE id=$1', [actorId]);
          await client.query('DELETE FROM auth.users WHERE id=$1', [actorId]);
          sqlLog.push(`DELETE FROM catalog.inventory_pending_action WHERE request_id='${requestId}'`, `DELETE FROM public.profiles WHERE id='${actorId}'`, `DELETE FROM auth.users WHERE id='${actorId}'`);
        } finally {
          await client.end();
        }
      },
    };
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }
}
