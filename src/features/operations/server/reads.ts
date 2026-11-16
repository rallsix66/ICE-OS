import 'server-only';

import { requireActiveAdmin } from '@/lib/auth';
import { withReadOnlyAppDb, type DbIdentity } from '@/lib/database/app-db';
import type {
  OperationActorDto,
  OperationCategory,
  OperationRecordDto,
  OperationRecordsPageDto,
} from '../types';

/**
 * 「操作记录」服务端读取层。
 *
 * - 服务端鉴权（启用中的管理员）→ app 角色只读事务（withReadOnlyAppDb）；
 * - 只调用 042 只读函数 catalog.read_operation_records，不读业务表、不写任何数据；
 * - 返回结构做一次外部边界校验：结构不对就报错（页面显示读取失败），不显示半份/伪造记录。
 */

export interface OperationRecordsReadInput {
  category: OperationCategory | 'all';
  actor: string;
  /** 已换算为 timestamptz 的边界（含起点、不含终点）；null = 不限。 */
  from: string | null;
  to: string | null;
  search: string;
  limit: number;
  offset: number;
}

export async function requireOperationsAdmin(): Promise<DbIdentity> {
  const actor = await requireActiveAdmin();
  return { profileUserId: actor.id };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('OPERATION_RECORDS_INVALID');
  return value as Record<string, unknown>;
}
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}
function asString(value: unknown): string {
  if (typeof value !== 'string') throw new Error('OPERATION_RECORDS_INVALID');
  return value;
}
function asCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('OPERATION_RECORDS_INVALID');
  return Math.max(0, Math.trunc(value));
}

function toRecord(raw: unknown): OperationRecordDto {
  const row = asRecord(raw);
  const category = asString(row.category);
  if (category !== 'catalog' && category !== 'inventory' && category !== 'shipment') {
    throw new Error('OPERATION_RECORDS_INVALID');
  }
  return {
    id: asString(row.id),
    at: asString(row.at),
    category,
    action: asString(row.action),
    actorId: asStringOrNull(row.actorId),
    actorName: asStringOrNull(row.actorName),
    objectKind: asString(row.objectKind),
    objectTitle: asString(row.objectTitle),
    objectRef: asStringOrNull(row.objectRef),
    itemId: asStringOrNull(row.itemId),
    ticketId: asStringOrNull(row.ticketId),
    batchId: asStringOrNull(row.batchId),
    iceCode: asStringOrNull(row.iceCode),
    externalSku: asStringOrNull(row.externalSku),
    ticketNo: asStringOrNull(row.ticketNo),
    market: asStringOrNull(row.market),
    detail: asRecord(row.detail),
  };
}

function toActor(raw: unknown): OperationActorDto {
  const row = asRecord(raw);
  return {
    actorId: asStringOrNull(row.actorId),
    name: asString(row.name),
    count: asCount(row.count),
  };
}

function toCategoryCounts(raw: unknown): Partial<Record<OperationCategory, number>> {
  const row = asRecord(raw);
  const counts: Partial<Record<OperationCategory, number>> = {};
  for (const key of ['catalog', 'inventory', 'shipment'] as const) {
    const value = row[key];
    if (typeof value === 'number' && Number.isFinite(value)) counts[key] = Math.max(0, Math.trunc(value));
  }
  return counts;
}

export async function getOperationRecords(
  identity: DbIdentity,
  input: OperationRecordsReadInput,
): Promise<OperationRecordsPageDto> {
  const raw = await withReadOnlyAppDb(identity, async (client) => {
    const result = await client.query<{ result: unknown }>(
      `SELECT catalog.read_operation_records($1::text,$2::uuid,$3::timestamptz,$4::timestamptz,$5::text,$6::integer,$7::integer) AS result`,
      [input.category, input.actor || null, input.from, input.to, input.search || null, input.limit, input.offset],
    );
    return result.rows[0]?.result;
  });
  const page = asRecord(raw);
  if (page.ok !== true) throw new Error('OPERATION_RECORDS_INVALID');
  return {
    total: asCount(page.total),
    offset: asCount(page.offset),
    limit: asCount(page.limit),
    rows: asArray(page.rows).map(toRecord),
    actors: asArray(page.actors).map(toActor),
    categoryCounts: toCategoryCounts(page.categoryCounts),
    readAt: asStringOrNull(page.readAt) ?? '',
  };
}
