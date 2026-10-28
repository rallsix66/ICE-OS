/**
 * 服务端读取结果 → 页面 DTO 的归一化（纯函数，无 DB / 无环境变量）。
 *
 * 背景：修复包 v2 的 016 读函数在并行开发中，返回键可能与契约写法有别名差异
 * （`warehouseName|name`、`lastKnownQty|previousOnHand`、`notMappedWarehouses|unmappedWarehouses` 等）。
 * 这里做一层**只改变形状、不改业务口径**的归一化，组件只用规范字段；
 * 数量合计/缺口一律采信服务端字段，不在页面另算（缺失时退回“未提供”而不是猜 0）。
 */

import type {
  InventoryAccountDto,
  InventoryCurrentMappingDto,
  InventoryDiscoveredWarehouseDto,
  InventoryFileValidationDto,
  InventoryItemDetailDto,
  InventoryItemHistoryDto,
  InventoryItemMappingDto,
  InventoryItemRowStatus,
  InventoryItemTotalsDto,
  InventoryItemWarehouseDto,
  InventoryListDto,
  InventoryListItemDto,
  InventoryListUnitGroupDto,
  InventoryListWarehouseRefDto,
  InventoryMappingQueueDto,
  InventoryMappingQueueItemDto,
  InventoryMappingSuggestionDto,
  InventoryMarketOptionDto,
  InventoryOverviewDto,
  InventoryPendingActionDto,
  InventoryPendingAdoptionWarehouseDto,
  InventoryPendingSourceRowDto,
  InventoryPendingSourceWarehouseDto,
  InventoryProductDomesticCellDto,
  InventoryProductMarketCellDto,
  InventoryProductSummaryDto,
  InventoryProductSummaryRowDto,
  InventoryRunDetailDto,
  InventoryRunFileDto,
  InventoryRunIssueDto,
  InventoryRunSummaryDto,
  InventoryRunWarehouseDto,
  InventoryScopeDto,
  InventorySettingsDto,
  InventoryWarehouseDto,
  InventoryWarehouseReadStateV2Dto,
  InventoryWarehouseRowDto,
  InventoryWarehouseRowStatus,
  InventoryWarehouseRowsDto,
  InventoryWarehouseStateDto,
  InventoryWorkerDto,
} from './types';

type Raw = Record<string, unknown>;

function asRecord(value: unknown): Raw {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Raw : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function asNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function asIntOrNull(value: unknown): number | null {
  const parsed = asNumberOrNull(value);
  return parsed === null ? null : Math.trunc(parsed);
}

function asBool(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  return fallback;
}

function pick(source: Raw, ...keys: string[]): unknown {
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) return source[key];
  }
  return undefined;
}

function pickString(source: Raw, ...keys: string[]): string {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

function pickStringOrNull(source: Raw, ...keys: string[]): string | null {
  const value = pickString(source, ...keys);
  return value ? value : null;
}

/* ------------------------------------------------------------------ *
 * 总览
 * ------------------------------------------------------------------ */

export function normalizeAccount(raw: unknown): InventoryAccountDto {
  const record = asRecord(raw);
  return {
    accountId: pickStringOrNull(record, 'accountId', 'account_id'),
    label: pickString(record, 'label', 'accountLabel', 'name') || '尚未绑定 BigSeller 账号',
    status: pickString(record, 'status', 'accountStatus') || 'unknown',
    lastLoginOkAt: asStringOrNull(pick(record, 'lastLoginOkAt', 'last_login_ok_at')),
    lastLoginCheckAt: asStringOrNull(pick(record, 'lastLoginCheckAt', 'last_login_check_at')),
    externalAccountCode: asStringOrNull(pick(record, 'externalAccountCode', 'external_account_code', 'accountCode')),
  };
}

export function normalizeWarehouse(raw: unknown): InventoryWarehouseDto {
  const record = asRecord(raw);
  return {
    id: pickString(record, 'id', 'warehouseId', 'warehouse_id'),
    externalId: pickString(record, 'externalId', 'external_id', 'externalWarehouseId', 'external_warehouse_id'),
    name: pickString(record, 'name', 'warehouseName', 'externalName', 'external_name') || '未命名仓库',
    status: pickString(record, 'status') || 'candidate',
    market: pickStringOrNull(record, 'market'),
    marketEvidence: pick(record, 'marketEvidence', 'market_evidence'),
  };
}

export function normalizeScope(raw: unknown, fallbackWarehouses: InventoryWarehouseDto[] = []): InventoryScopeDto {
  const record = asRecord(raw);
  const warehouseIdsRaw = pick(record, 'warehouseIds', 'warehouse_ids');
  const ids = asArray(warehouseIdsRaw).map((entry) => asString(entry)).filter(Boolean);
  const labelsRaw = asArray(pick(record, 'labels', 'warehouseLabels', 'warehouse_labels'))
    .map((entry) => asString(entry))
    .filter(Boolean);
  const labels = labelsRaw.length > 0
    ? labelsRaw
    : fallbackWarehouses.filter((warehouse) => ids.includes(warehouse.id)).map((warehouse) => warehouse.name);
  const warehouseCount = asIntOrNull(pick(record, 'warehouseCount', 'warehouse_count')) ?? ids.length;
  const empty = asBool(pick(record, 'empty'), warehouseCount === 0 && ids.length === 0);
  return {
    id: pickString(record, 'id', 'scopeId', 'scope_id'),
    version: asIntOrNull(pick(record, 'version')) ?? 0,
    warehouseIds: ids,
    labels,
    warehouseCount: Math.max(warehouseCount, 0),
    empty,
    lastAllSuccessAt: asStringOrNull(pick(record, 'lastAllSuccessAt', 'last_all_success_at')),
  };
}

export function normalizeSettings(raw: unknown): InventorySettingsDto {
  const record = asRecord(raw);
  return {
    enabled: asBool(pick(record, 'enabled')),
    intervalMinutes: asIntOrNull(pick(record, 'intervalMinutes', 'interval_minutes')) ?? 60,
    nextRunAt: asStringOrNull(pick(record, 'nextRunAt', 'next_run_at')),
    configVersion: asIntOrNull(pick(record, 'configVersion', 'config_version')) ?? 0,
    planAnchorAt: asStringOrNull(pick(record, 'planAnchorAt', 'plan_anchor_at')),
    scopeId: asStringOrNull(pick(record, 'scopeId', 'scope_id')),
    scopeWarehouseCount: asIntOrNull(pick(record, 'scopeWarehouseCount', 'scope_warehouse_count', 'warehouseCount', 'warehouse_count')) ?? undefined,
    scopeEmpty: typeof pick(record, 'scopeEmpty', 'scope_empty') === 'boolean'
      ? asBool(pick(record, 'scopeEmpty', 'scope_empty'))
      : undefined,
  };
}

export function normalizeWorker(raw: unknown): InventoryWorkerDto | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = asRecord(raw);
  return {
    online: asBool(pick(record, 'online', 'isOnline')),
    lastSeenAt: asStringOrNull(pick(record, 'lastSeenAt', 'last_seen_at')),
    host: asStringOrNull(pick(record, 'host')),
    pid: asIntOrNull(pick(record, 'pid')),
  };
}

export function normalizeRunSummary(raw: unknown): InventoryRunSummaryDto {
  const record = asRecord(raw);
  const summary = asRecord(pick(record, 'warehouseSummary', 'warehouse_summary'));
  return {
    id: pickString(record, 'id', 'runId', 'run_id'),
    status: pickString(record, 'status') || 'unknown',
    triggerKind: pickString(record, 'triggerKind', 'trigger_kind') || 'unknown',
    plannedFor: asStringOrNull(pick(record, 'plannedFor', 'planned_for')),
    startedAt: asStringOrNull(pick(record, 'startedAt', 'started_at')),
    finishedAt: asStringOrNull(pick(record, 'finishedAt', 'finished_at')),
    warehouseSummary: {
      published: asIntOrNull(pick(summary, 'published')) ?? undefined,
      failed: asIntOrNull(pick(summary, 'failed')) ?? undefined,
      noRows: asIntOrNull(pick(summary, 'noRows', 'no_rows')) ?? undefined,
      blocked: asIntOrNull(pick(summary, 'blocked')) ?? undefined,
    },
    errorCode: asStringOrNull(pick(record, 'errorCode', 'error_code')),
  };
}

export function normalizeWarehouseState(raw: unknown): InventoryWarehouseStateDto {
  const record = asRecord(raw);
  const lastRunStatus = pickStringOrNull(record, 'lastRunStatus', 'last_run_status', 'latestRunStatus', 'latest_run_status');
  const lastSuccessAt = asStringOrNull(pick(record, 'lastSuccessAt', 'last_success_at'));
  const staleFlag = pick(record, 'stale');
  const failedFlag = pick(record, 'failed');
  const failed = typeof failedFlag === 'boolean'
    ? failedFlag
    : Boolean(lastSuccessAt && lastRunStatus && !['success', 'published'].includes(lastRunStatus));
  return {
    warehouseId: pickString(record, 'warehouseId', 'warehouse_id', 'id'),
    name: pickString(record, 'name', 'warehouseName', 'warehouse_name') || '未命名仓库',
    lastSuccessAt,
    lastPublishAt: asStringOrNull(pick(record, 'lastPublishAt', 'last_publish_at')),
    lastRunStatus,
    stale: typeof staleFlag === 'boolean' ? staleFlag : failed,
    failed,
    lastErrorCode: asStringOrNull(pick(record, 'lastErrorCode', 'last_error_code', 'errorCode')),
  };
}

export function normalizeMarketOptions(raw: unknown): InventoryMarketOptionDto[] {
  return asArray(raw)
    .map((entry) => {
      const record = asRecord(entry);
      const market = pickString(record, 'market');
      if (!market) return null;
      const warehouses = asArray(pick(record, 'warehouses'));
      const warehouseNames = asArray(pick(record, 'warehouseNames', 'warehouse_names'))
        .map((name) => asString(name))
        .filter(Boolean);
      const namesFromObjects = warehouses
        .map((warehouse) => pickString(asRecord(warehouse), 'name', 'warehouseName', 'warehouse_name'))
        .filter(Boolean);
      const names = warehouseNames.length > 0 ? warehouseNames : namesFromObjects;
      const warehouseCount = asIntOrNull(pick(record, 'warehouseCount', 'warehouse_count')) ?? names.length;
      return { market, warehouseNames: [...new Set(names)], warehouseCount: Math.max(warehouseCount, names.length) };
    })
    .filter((entry): entry is InventoryMarketOptionDto => Boolean(entry))
    .sort((a, b) => {
      if (a.market === b.market) return 0;
      return a.market < b.market ? -1 : 1;
    });
}

export function normalizeDiscoveredWarehouses(raw: unknown): InventoryDiscoveredWarehouseDto[] {
  const result: InventoryDiscoveredWarehouseDto[] = [];
  for (const entry of asArray(raw)) {
    const record = asRecord(entry);
    const name = pickString(record, 'name', 'externalName', 'external_name');
    if (!name) continue;
    result.push({
      externalId: pickString(record, 'externalId', 'external_id', 'externalWarehouseId'),
      name,
      status: pickStringOrNull(record, 'status') ?? undefined,
    });
  }
  return result;
}

export function normalizePendingAction(raw: unknown): InventoryPendingActionDto | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = asRecord(raw);
  const foreign = asBool(pick(record, 'foreign')) || asBool(pick(record, 'mine'), true) === false;
  const requestId = pickString(record, 'requestId', 'request_id');
  if (!requestId && !foreign) return null;
  return {
    requestId: requestId || null,
    action: pickString(record, 'action', 'actionKind') || 'unknown',
    createdAt: asStringOrNull(pick(record, 'createdAt', 'created_at')),
    payload: asRecord(pick(record, 'payload')),
    intent: asStringOrNull(pick(record, 'intent', 'intentHash', 'intent_hash')),
    foreign,
    mine: !foreign,
    actorId: asStringOrNull(pick(record, 'actorId', 'actor_id')),
    accountId: asStringOrNull(pick(record, 'accountId', 'account_id')),
    status: pickStringOrNull(record, 'status'),
  };
}

export function normalizePendingActions(raw: unknown): InventoryPendingActionDto[] {
  const source = Array.isArray(raw) ? raw : asArray(asRecord(raw).items);
  return source
    .map((entry) => normalizePendingAction(entry))
    .filter((entry): entry is InventoryPendingActionDto => Boolean(entry));
}

export function normalizeOverview(raw: unknown): InventoryOverviewDto {
  const record = asRecord(raw);
  const warehouses = asArray(pick(record, 'warehouses')).map(normalizeWarehouse);
  const scope = normalizeScope(pick(record, 'scope'), warehouses);
  const settings = normalizeSettings(pick(record, 'settings'));
  const lastRunRaw = pick(record, 'lastRun', 'last_run');
  const runs = asArray(pick(record, 'runs')).map(normalizeRunSummary);
  const unmappedCount = asIntOrNull(pick(record, 'unmappedCount', 'unmapped_count')) ?? 0;
  const queueTotal = asIntOrNull(pick(record, 'mappingQueueTotal', 'mapping_queue_total')) ?? unmappedCount;
  return {
    account: normalizeAccount(pick(record, 'account')),
    warehouses,
    scope: {
      ...scope,
      empty: scope.empty || (settings.scopeEmpty === true) || (scope.warehouseCount === 0),
      lastAllSuccessAt: scope.lastAllSuccessAt
        ?? asStringOrNull(pick(record, 'scopeLastAllSuccessAt', 'scope_last_all_success_at')),
    },
    settings: {
      ...settings,
      scopeEmpty: settings.scopeEmpty ?? (scope.warehouseCount === 0),
      scopeWarehouseCount: settings.scopeWarehouseCount ?? scope.warehouseCount,
      scopeId: settings.scopeId ?? (scope.id || null),
    },
    worker: normalizeWorker(pick(record, 'worker')),
    lastRun: lastRunRaw ? normalizeRunSummary(lastRunRaw) : (runs[0] ?? null),
    runs,
    warehouseState: asArray(pick(record, 'warehouseState', 'warehouse_state')).map(normalizeWarehouseState),
    scopeLastAllSuccessAt: asStringOrNull(pick(record, 'scopeLastAllSuccessAt', 'scope_last_all_success_at')),
    unmappedCount,
    mappingQueueTotal: queueTotal,
    marketOptions: normalizeMarketOptions(pick(record, 'marketOptions', 'market_options')),
    pendingAction: normalizePendingAction(pick(record, 'pendingAction', 'pending_action')),
    discoveredWarehouses: normalizeDiscoveredWarehouses(pick(record, 'discoveredWarehouses', 'discovered_warehouses')),
  };
}

/* ------------------------------------------------------------------ *
 * 对应复核队列
 * ------------------------------------------------------------------ */

function normalizeSuggestion(raw: unknown): InventoryMappingSuggestionDto | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = asRecord(raw);
  const itemId = pickString(record, 'itemId', 'item_id');
  if (!itemId) return null;
  return {
    itemId,
    iceCode: pickStringOrNull(record, 'iceCode', 'ice_code'),
    nameCn: pickStringOrNull(record, 'nameCn', 'name_cn', 'name'),
    evidence: pickStringOrNull(record, 'evidence', 'evidenceText'),
    sourceSku: pickStringOrNull(record, 'sourceSku', 'source_sku'),
    sourceWarehouse: pickStringOrNull(record, 'sourceWarehouse', 'source_warehouse'),
    source: pickStringOrNull(record, 'source'),
  };
}

function normalizeCurrentMapping(raw: unknown): InventoryCurrentMappingDto | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = asRecord(raw);
  const id = pickString(record, 'id', 'mappingId', 'mapping_id');
  if (!id) return null;
  return {
    id,
    version: asIntOrNull(pick(record, 'version')) ?? 1,
    itemId: pickString(record, 'itemId', 'item_id'),
    itemLabel: pickStringOrNull(record, 'itemLabel', 'item_label'),
    unit: pickString(record, 'unit'),
    status: pickString(record, 'status') || 'confirmed',
  };
}

export function normalizeMappingQueueItem(raw: unknown): InventoryMappingQueueItemDto {
  const record = asRecord(raw);
  const legacyOption = asRecord(asArray(pick(record, 'warehouseOptions', 'warehouse_options'))[0]);
  const warehouseId = pickString(record, 'warehouseId', 'warehouse_id') || pickString(legacyOption, 'warehouseId', 'warehouse_id');
  return {
    externalSku: pickString(record, 'externalSku', 'external_sku', 'sku'),
    warehouseId,
    warehouseExternalId: pickString(record, 'warehouseExternalId', 'warehouse_external_id')
      || pickString(legacyOption, 'externalId', 'external_id'),
    warehouseName: pickString(record, 'warehouseName', 'warehouse_name')
      || pickString(legacyOption, 'name')
      || '未命名仓库',
    market: pickStringOrNull(record, 'market') ?? pickStringOrNull(legacyOption, 'market'),
    rowCount: asIntOrNull(pick(record, 'rowCount', 'row_count', 'occurrences')) ?? 0,
    latestRunAt: asStringOrNull(pick(record, 'latestRunAt', 'latest_run_at', 'latestWarehouseRunAt')),
    suggestion: normalizeSuggestion(pick(record, 'suggestion')),
    candidateId: pickStringOrNull(record, 'candidateId', 'candidate_id'),
    candidateStatus: pickStringOrNull(record, 'candidateStatus', 'candidate_status'),
    mappingStatus: pickStringOrNull(record, 'mappingStatus', 'mapping_status'),
    currentMapping: normalizeCurrentMapping(pick(record, 'currentMapping', 'current_mapping')),
    verification: asBool(pick(record, 'verification'), false),
    unitUnconfirmed: asBool(pick(record, 'unitUnconfirmed', 'unit_unconfirmed'), false),
    reason: pickStringOrNull(record, 'reason', 'note'),
  };
}

export function normalizeMappingQueue(raw: unknown): InventoryMappingQueueDto {
  const record = asRecord(raw);
  const items = asArray(pick(record, 'items')).map(normalizeMappingQueueItem);
  const limit = asIntOrNull(pick(record, 'limit')) ?? 20;
  return {
    items,
    total: asIntOrNull(pick(record, 'total')) ?? items.length,
    offset: asIntOrNull(pick(record, 'offset')) ?? 0,
    limit,
  };
}

/* ------------------------------------------------------------------ *
 * 库存列表
 * ------------------------------------------------------------------ */

function normalizePendingSourceRow(raw: unknown): InventoryPendingSourceRowDto {
  const record = asRecord(raw);
  return {
    externalSku: pickString(record, 'externalSku', 'external_sku', 'sku'),
    excelRow: asIntOrNull(pick(record, 'excelRow', 'excel_row')),
    onHand: asNumberOrNull(pick(record, 'onHand', 'on_hand')),
    mapped: asBool(pick(record, 'mapped'), false),
    mappingId: pickStringOrNull(record, 'mappingId', 'mapping_id'),
  };
}

function normalizePendingSourceWarehouse(raw: unknown): InventoryPendingSourceWarehouseDto {
  const record = asRecord(raw);
  const rows: InventoryPendingSourceRowDto[] = asArray(pick(record, 'pendingSourceRows', 'pending_source_rows'))
    .map(normalizePendingSourceRow);
  return {
    warehouseId: pickString(record, 'warehouseId', 'warehouse_id', 'id'),
    externalId: pickStringOrNull(record, 'externalId', 'external_id'),
    name: pickString(record, 'name', 'warehouseName', 'warehouse_name') || '未命名仓库',
    sourceRowCount: asIntOrNull(pick(record, 'sourceRowCount', 'source_row_count')) ?? rows.length,
    pendingSourceRowCount: asIntOrNull(pick(record, 'pendingSourceRowCount', 'pending_source_row_count'))
      ?? rows.filter((row) => !row.mapped).length,
    pendingSkus: asArray(pick(record, 'pendingSkus', 'pending_skus')).map((entry) => asString(entry)).filter(Boolean),
    mappedSkus: asArray(pick(record, 'mappedSkus', 'mapped_skus')).map((entry) => asString(entry)).filter(Boolean),
    adoptedSkus: asArray(pick(record, 'adoptedSkus', 'adopted_skus')).map((entry) => asString(entry)).filter(Boolean),
    pendingSourceRows: rows,
  };
}

function normalizeStringArray(record: Raw, ...keys: string[]): string[] {
  return asArray(pick(record, ...keys)).map((entry) => asString(entry)).filter(Boolean);
}

/**
 * 对应已确认、等待下一次完整同步采用。服务端给 pendingAdoptionSkus；若缺失则按契约
 * mappedSkus − adoptedSkus 兜底（只改形状，不猜数量、不补映射）。
 */
function normalizePendingAdoptionWarehouse(raw: unknown): InventoryPendingAdoptionWarehouseDto {
  const record = asRecord(raw);
  const adoptedSkus = normalizeStringArray(record, 'adoptedSkus', 'adopted_skus');
  const mappedSkus = normalizeStringArray(record, 'mappedSkus', 'mapped_skus');
  const explicit = normalizeStringArray(record, 'pendingAdoptionSkus', 'pending_adoption_skus');
  const pendingAdoptionSkus = explicit.length > 0
    ? explicit
    : mappedSkus.filter((sku) => !adoptedSkus.includes(sku));
  return {
    warehouseId: pickString(record, 'warehouseId', 'warehouse_id', 'id'),
    externalId: pickStringOrNull(record, 'externalId', 'external_id'),
    name: pickString(record, 'name', 'warehouseName', 'warehouse_name') || '未命名仓库',
    adoptedSkus,
    mappedSkus: mappedSkus.length > 0
      ? mappedSkus
      : [...new Set([...adoptedSkus, ...pendingAdoptionSkus])].sort(),
    pendingAdoptionSkus,
  };
}

function normalizeWarehouseRef(raw: unknown): InventoryListWarehouseRefDto {
  const record = asRecord(raw);
  return {
    warehouseId: pickString(record, 'warehouseId', 'warehouse_id', 'id'),
    externalId: pickStringOrNull(record, 'externalId', 'external_id'),
    name: pickString(record, 'name', 'warehouseName', 'warehouse_name') || '未命名仓库',
    reason: pickStringOrNull(record, 'reason'),
    sourceRowCount: asIntOrNull(pick(record, 'sourceRowCount', 'source_row_count')),
    sourceSkus: asArray(pick(record, 'sourceSkus', 'source_skus')).map((entry) => asString(entry)).filter(Boolean),
    pendingSourceRows: asArray(pick(record, 'pendingSourceRows', 'pending_source_rows')).map(normalizePendingSourceRow),
    lastKnownQty: asNumberOrNull(pick(record, 'lastKnownQty', 'last_known_qty', 'previousOnHand', 'previous_on_hand')),
    lastKnownAt: asStringOrNull(pick(record, 'lastKnownAt', 'last_known_at', 'lastKnownObservedAt')),
    lastSuccessAt: asStringOrNull(pick(record, 'lastSuccessAt', 'last_success_at')),
    lastErrorCode: asStringOrNull(pick(record, 'lastErrorCode', 'last_error_code')),
  };
}

function normalizeUnitGroup(raw: unknown): InventoryListUnitGroupDto {
  const record = asRecord(raw);
  return {
    unit: pickStringOrNull(record, 'unit'),
    knownSubtotal: asNumberOrNull(pick(record, 'knownSubtotal', 'known_subtotal', 'subtotal', 'knownOnHand', 'known_on_hand')),
    rowCount: asIntOrNull(pick(record, 'rowCount', 'row_count')) ?? 0,
  };
}

export function normalizeListItem(raw: unknown): InventoryListItemDto {
  const record = asRecord(raw);
  const covered = asIntOrNull(pick(record, 'coveredWarehouseCount', 'covered_warehouse_count', 'warehouseCount', 'warehouse_count')) ?? 0;
  const scopeCount = asIntOrNull(pick(record, 'scopeWarehouseCount', 'scope_warehouse_count')) ?? 0;
  const legacyUnknown = asArray(pick(record, 'unknownWarehouses', 'unknown_warehouses'))
    .map((entry) => asString(entry))
    .filter(Boolean)
    .map((name) => ({ warehouseId: '', name, lastKnownQty: null, lastKnownAt: null }));
  const notMappedRaw = asArray(pick(record, 'notMappedWarehouses', 'not_mapped_warehouses', 'unmappedWarehouses', 'unmapped_warehouses'))
    .map(normalizeWarehouseRef);
  const notMappedWarehouses = notMappedRaw.length > 0 ? notMappedRaw : legacyUnknown;
  const unitGroups = asArray(pick(record, 'unitGroups', 'unit_groups')).map(normalizeUnitGroup);
  const knownSubtotal = asNumberOrNull(pick(record, 'knownSubtotal', 'known_subtotal'));
  const coverageRaw = asRecord(pick(record, 'coverage'));
  const coverage = {
    scopeWarehouses: asIntOrNull(pick(coverageRaw, 'scopeWarehouses', 'scope_warehouses')) ?? scopeCount,
    coveredWarehouses: asIntOrNull(pick(coverageRaw, 'coveredWarehouses', 'covered_warehouses')) ?? covered,
  };
  return {
    itemId: pickString(record, 'itemId', 'item_id', 'id'),
    iceCode: pickStringOrNull(record, 'iceCode', 'ice_code'),
    nameCn: pickStringOrNull(record, 'nameCn', 'name_cn', 'name'),
    gtin: pickStringOrNull(record, 'gtin', 'barcode'),
    market: pickStringOrNull(record, 'market'),
    knownSubtotal,
    unitConflict: asBool(pick(record, 'unitConflict', 'unit_conflict'), unitGroups.length > 1),
    hasPendingTotal: asBool(pick(record, 'hasPendingTotal', 'has_pending_total'), false),
    knownSubtotalComplete: typeof pick(record, 'knownSubtotalComplete', 'known_subtotal_complete') === 'boolean'
      ? asBool(pick(record, 'knownSubtotalComplete', 'known_subtotal_complete'))
      : !asBool(pick(record, 'hasPendingTotal', 'has_pending_total'), false),
    pendingTotalWarehouses: asArray(pick(record, 'pendingTotalWarehouses', 'pending_total_warehouses')).map((entry) => {
      const group = asRecord(entry);
      return {
        warehouseId: pickString(group, 'warehouseId', 'warehouse_id'),
        externalId: pickStringOrNull(group, 'externalId', 'external_id'),
        name: pickString(group, 'name', 'warehouseName', 'warehouse_name'),
        unit: pickStringOrNull(group, 'unit'),
        rowCount: asIntOrNull(pick(group, 'rowCount', 'row_count')) ?? 0,
        rows: asArray(pick(group, 'rows')).map((line) => {
          const row = asRecord(line);
          return {
            externalSku: pickString(row, 'externalSku', 'external_sku'),
            onHand: asNumberOrNull(pick(row, 'onHand', 'on_hand')),
            excelRow: asIntOrNull(pick(row, 'excelRow', 'excel_row')),
          };
        }),
      };
    }),
    unitGroups,
    coveredWarehouseCount: covered,
    scopeWarehouseCount: scopeCount,
    coverage,
    hasCurrentData: typeof pick(record, 'hasCurrentData', 'has_current_data') === 'boolean'
      ? asBool(pick(record, 'hasCurrentData', 'has_current_data'))
      : (covered > 0 || unitGroups.length > 0),
    unitCount: asIntOrNull(pick(record, 'unitCount', 'unit_count')) ?? unitGroups.length,
    notMappedWarehouses,
    unseenWarehouses: asArray(pick(record, 'unseenWarehouses', 'unseen_warehouses')).map(normalizeWarehouseRef),
    failedWarehouses: asArray(pick(record, 'failedWarehouses', 'failed_warehouses')).map(normalizeWarehouseRef),
    pendingSourceWarehouses: asArray(pick(record, 'pendingSourceWarehouses', 'pending_source_warehouses'))
      .map(normalizePendingSourceWarehouse),
    hasPendingSourceWarehouses: asBool(
      pick(record, 'hasPendingSourceWarehouses', 'has_pending_source_warehouses'),
      asArray(pick(record, 'pendingSourceWarehouses', 'pending_source_warehouses')).length > 0,
    ),
    pendingAdoptionWarehouses: asArray(pick(record, 'pendingAdoptionWarehouses', 'pending_adoption_warehouses'))
      .map(normalizePendingAdoptionWarehouse),
    hasPendingAdoptionWarehouses: asBool(
      pick(record, 'hasPendingAdoptionWarehouses', 'has_pending_adoption_warehouses'),
      asArray(pick(record, 'pendingAdoptionWarehouses', 'pending_adoption_warehouses')).length > 0,
    ),
    markets: asArray(pick(record, 'markets')).map((entry) => asString(entry)).filter(Boolean),
    hasUnknownMarket: asBool(pick(record, 'hasUnknownMarket', 'has_unknown_market'), false),
    verificationOnly: asBool(pick(record, 'verificationOnly', 'verification_only'), false),
    unitUnconfirmed: asBool(pick(record, 'unitUnconfirmed', 'unit_unconfirmed'), false),
    itemRevisionMissing: asIntOrNull(pick(record, 'itemRevisionMissing', 'item_revision_missing')) ?? 0,
    lastObservedAt: asStringOrNull(pick(record, 'lastObservedAt', 'last_observed_at', 'lastObserved')),
    mapped: asBool(pick(record, 'mapped'), notMappedWarehouses.length === 0),
  };
}

export function normalizeList(raw: unknown): InventoryListDto {
  const record = asRecord(raw);
  const scopeRaw = asRecord(pick(record, 'scope'));
  const items = asArray(pick(record, 'items')).map(normalizeListItem);
  return {
    total: asIntOrNull(pick(record, 'total')) ?? items.length,
    offset: asIntOrNull(pick(record, 'offset')) ?? 0,
    limit: asIntOrNull(pick(record, 'limit')) ?? 50,
    items,
    scope: {
      warehouseCount: asIntOrNull(pick(scopeRaw, 'warehouseCount', 'warehouse_count')) ?? 0,
      lastAllSuccessAt: asStringOrNull(pick(scopeRaw, 'lastAllSuccessAt', 'last_all_success_at')),
      empty: asBool(pick(scopeRaw, 'empty')),
    },
    marketOptions: pick(record, 'marketOptions', 'market_options') !== undefined
      ? normalizeMarketOptions(pick(record, 'marketOptions', 'market_options'))
      : undefined,
    domestic: pickString(record, 'domestic') || 'not_connected',
    inTransit: pickString(record, 'inTransit', 'in_transit') || 'not_connected',
  };
}

/* ------------------------------------------------------------------ *
 * 商品详情
 * ------------------------------------------------------------------ */

function normalizeRowStatus(value: unknown): InventoryItemRowStatus {
  const status = asString(value);
  if (status === 'current') return 'current';
  if (status === 'stale') return 'stale';
  if (status === 'failed') return 'failed';
  if (status === 'not_mapped' || status === 'unmapped') return 'not_mapped';
  // 旧实现用 no_current 表示“没有当前值”；修复包改称“本次未见”。
  return 'unseen';
}

export function normalizeItemWarehouseRow(raw: unknown): InventoryItemWarehouseDto {
  const record = asRecord(raw);
  return {
    warehouseId: pickString(record, 'warehouseId', 'warehouse_id', 'id'),
    warehouseName: pickString(record, 'warehouseName', 'warehouse_name', 'name') || '未命名仓库',
    externalId: pickStringOrNull(record, 'externalId', 'external_id'),
    market: pickStringOrNull(record, 'market'),
    externalSku: pickString(record, 'externalSku', 'external_sku', 'sku'),
    unit: pickStringOrNull(record, 'unit'),
    onHand: asNumberOrNull(pick(record, 'onHand', 'on_hand')),
    orderLocked: asNumberOrNull(pick(record, 'orderLocked', 'order_locked')),
    warehouseAvailable: asNumberOrNull(pick(record, 'warehouseAvailable', 'warehouse_available')),
    activityReserved: asNumberOrNull(pick(record, 'activityReserved', 'activity_reserved')),
    inTransit: asNumberOrNull(pick(record, 'inTransit', 'in_transit')),
    gtin: pickStringOrNull(record, 'gtin'),
    observedAt: asStringOrNull(pick(record, 'observedAt', 'observed_at')),
    batchId: pickStringOrNull(record, 'batchId', 'batch_id'),
    excelRow: asIntOrNull(pick(record, 'excelRow', 'excel_row')),
    itemRevision: asIntOrNull(pick(record, 'itemRevision', 'item_revision')),
    status: normalizeRowStatus(pick(record, 'status')),
    reason: pickStringOrNull(record, 'reason'),
    gapReason: pickStringOrNull(record, 'gapReason', 'gap_reason'),
    sourceRowCount: asIntOrNull(pick(record, 'sourceRowCount', 'source_row_count')),
    sourceSkus: asArray(pick(record, 'sourceSkus', 'source_skus')).map((entry) => asString(entry)).filter(Boolean),
    pendingSourceRows: asArray(pick(record, 'pendingSourceRows', 'pending_source_rows')).map(normalizePendingSourceRow),
    pendingSourceRowCount: asIntOrNull(pick(record, 'pendingSourceRowCount', 'pending_source_row_count')),
    pendingSkus: asArray(pick(record, 'pendingSkus', 'pending_skus')).map((entry) => asString(entry)).filter(Boolean),
    mappedSkus: asArray(pick(record, 'mappedSkus', 'mapped_skus')).map((entry) => asString(entry)).filter(Boolean),
    adoptedSkus: asArray(pick(record, 'adoptedSkus', 'adopted_skus')).map((entry) => asString(entry)).filter(Boolean),
    pendingAdoptionSkus: asArray(pick(record, 'pendingAdoptionSkus', 'pending_adoption_skus'))
      .map((entry) => asString(entry)).filter(Boolean),
    lastKnownQty: asNumberOrNull(pick(record, 'lastKnownQty', 'last_known_qty', 'previousOnHand', 'previous_on_hand')),
    lastKnownAt: asStringOrNull(pick(record, 'lastKnownAt', 'last_known_at', 'lastKnownObservedAt')),
    failed: asBool(pick(record, 'failed'), false),
    lastSuccessAt: asStringOrNull(pick(record, 'lastSuccessAt', 'last_success_at')),
    lastObservationAt: asStringOrNull(pick(record, 'lastObservationAt', 'last_observation_at')),
    lastErrorCode: asStringOrNull(pick(record, 'lastErrorCode', 'last_error_code')),
    stale: asBool(pick(record, 'stale'), false),
  };
}

export function normalizeItemHistory(raw: unknown): InventoryItemHistoryDto {
  const record = asRecord(raw);
  return {
    batchId: pickString(record, 'batchId', 'batch_id'),
    warehouseName: pickString(record, 'warehouseName', 'warehouse_name') || '未命名仓库',
    runId: pickString(record, 'runId', 'run_id'),
    publishedAt: pickString(record, 'publishedAt', 'published_at'),
    observationAt: asStringOrNull(pick(record, 'observationAt', 'observation_at')),
    onHand: asNumberOrNull(pick(record, 'onHand', 'on_hand')),
    previousOnHand: asNumberOrNull(pick(record, 'previousOnHand', 'previous_on_hand')),
    externalSku: pickString(record, 'externalSku', 'external_sku', 'sku'),
    unit: pickStringOrNull(record, 'unit'),
    itemRevision: asIntOrNull(pick(record, 'itemRevision', 'item_revision')),
    rowStatus: pickString(record, 'rowStatus', 'row_status', 'status') || 'unknown',
  };
}

export function normalizeItemMapping(raw: unknown): InventoryItemMappingDto {
  const record = asRecord(raw);
  const evidence = asRecord(pick(record, 'evidence'));
  const verification = record.verification !== undefined
    ? asBool(record.verification)
    : asBool(pick(evidence, 'verification'), false);
  const unitUnconfirmed = record.unitUnconfirmed !== undefined
    ? asBool(pick(record, 'unitUnconfirmed', 'unit_unconfirmed'))
    : pick(evidence, 'unitConfirmed') === false;
  return {
    id: pickString(record, 'id', 'mappingId', 'mapping_id'),
    externalSku: pickString(record, 'externalSku', 'external_sku', 'sku'),
    warehouseId: pickStringOrNull(record, 'warehouseId', 'warehouse_id'),
    warehouseExternalId: pickStringOrNull(record, 'warehouseExternalId', 'warehouse_external_id'),
    warehouseName: pickStringOrNull(record, 'warehouseName', 'warehouse_name'),
    version: asIntOrNull(pick(record, 'version')) ?? 1,
    unit: pickStringOrNull(record, 'unit'),
    status: pickString(record, 'status') || 'confirmed',
    confirmedAt: asStringOrNull(pick(record, 'confirmedAt', 'confirmed_at', 'createdAt')),
    itemRevision: asIntOrNull(pick(record, 'itemRevision', 'item_revision')),
    actorLabel: pickStringOrNull(record, 'actorLabel', 'actor_label', 'actor'),
    reason: pickStringOrNull(record, 'reason', 'note'),
    accountLevel: asBool(pick(record, 'accountLevel', 'account_level')),
    verification,
    unitUnconfirmed,
  };
}

/** 服务端 totals 缺失时的展示兜底：只按 status=current 行、同单位分组（不跨单位相加）。 */
export function fallbackTotalsFromRows(rows: InventoryItemWarehouseDto[]): InventoryItemTotalsDto {
  const current = rows.filter((row) => row.status === 'current' && typeof row.onHand === 'number' && Number.isFinite(row.onHand));
  const byUnitMap = new Map<string, { unit: string | null; knownSubtotal: number; rowCount: number }>();
  for (const row of current) {
    const key = (row.unit ?? '').trim();
    const entry = byUnitMap.get(key) ?? { unit: row.unit, knownSubtotal: 0, rowCount: 0 };
    entry.knownSubtotal += row.onHand as number;
    entry.rowCount += 1;
    byUnitMap.set(key, entry);
  }
  const byUnit = [...byUnitMap.values()];
  const unitConflict = byUnit.length > 1;
  return {
    byUnit,
    knownSubtotal: unitConflict || byUnit.length === 0 ? null : byUnit[0].knownSubtotal,
    unitConflict,
  };
}

/** 016 详情按仓返回 rows[]（每仓多来源 SKU）；这里展开为“每仓×SKU 一行”，不丢同仓第二个 SKU。 */
function flattenItemWarehouses(raw: unknown): InventoryItemWarehouseDto[] {
  const result: InventoryItemWarehouseDto[] = [];
  for (const entry of asArray(raw)) {
    const warehouse = asRecord(entry);
    const rows = asArray(pick(warehouse, 'rows'));
    const status = pickString(warehouse, 'status');
    if (rows.length > 0) {
      for (const rawRow of rows) {
        const row = asRecord(rawRow);
        const warehouseId = pickString(warehouse, 'warehouseId', 'warehouse_id', 'id');
        result.push(normalizeItemWarehouseRow({
          ...warehouse,
          ...row,
          warehouseId,
          status,
          failed: asBool(pick(warehouse, 'stale'), false) || asBool(pick(warehouse, 'failed'), false),
        }));
      }
      continue;
    }
    result.push(normalizeItemWarehouseRow({
      ...warehouse,
      status,
      failed: asBool(pick(warehouse, 'stale'), false) || asBool(pick(warehouse, 'failed'), false),
    }));
  }
  return result;
}

export function normalizeItemDetail(raw: unknown): InventoryItemDetailDto {
  const record = asRecord(raw);
  const item = asRecord(pick(record, 'item'));
  const warehouses = flattenItemWarehouses(pick(record, 'warehouses', 'rows'));
  const totalsRaw = asRecord(pick(record, 'totals'));
  const hasTotals = Object.keys(totalsRaw).length > 0;
  const totals: InventoryItemTotalsDto = hasTotals
    ? {
      byUnit: asArray(pick(totalsRaw, 'byUnit', 'by_unit')).map(normalizeUnitGroup),
      knownSubtotal: asNumberOrNull(pick(totalsRaw, 'knownSubtotal', 'known_subtotal')),
      unitConflict: asBool(pick(totalsRaw, 'unitConflict', 'unit_conflict')),
    }
    : fallbackTotalsFromRows(warehouses);
  const scope = asRecord(pick(record, 'scope'));
  const scopeModeRaw = pickString(record, 'scopeMode', 'scope_mode');
  const allWarehouses = asBool(pick(scope, 'allWarehouses', 'all_warehouses'))
    || scopeModeRaw === 'all';
  const coverageRaw = asRecord(pick(record, 'coverage'));
  const warehouseCount = warehouses.filter((row) => row.status === 'current' || row.status === 'stale').length;
  return {
    item: {
      id: pickString(item, 'id', 'itemId', 'item_id'),
      iceCode: pickStringOrNull(item, 'iceCode', 'ice_code'),
      nameCn: pickStringOrNull(item, 'nameCn', 'name_cn', 'name'),
      gtin: pickStringOrNull(item, 'gtin'),
    },
    scopeMode: allWarehouses ? 'all' : 'filtered',
    warehouses,
    totals,
    coverage: {
      scopeWarehouses: asIntOrNull(pick(coverageRaw, 'scopeWarehouses', 'scope_warehouses')) ?? 0,
      coveredWarehouses: asIntOrNull(pick(coverageRaw, 'coveredWarehouses', 'covered_warehouses')) ?? warehouseCount,
    },
    markets: asArray(pick(record, 'markets')).map((entry) => asString(entry)).filter(Boolean),
    hasUnknownMarket: asBool(pick(record, 'hasUnknownMarket', 'has_unknown_market'), false),
    pendingSourceWarehouses: asArray(pick(record, 'pendingSourceWarehouses', 'pending_source_warehouses'))
      .map(normalizePendingSourceWarehouse),
    hasPendingSourceWarehouses: asBool(
      pick(record, 'hasPendingSourceWarehouses', 'has_pending_source_warehouses'),
      asArray(pick(record, 'pendingSourceWarehouses', 'pending_source_warehouses')).length > 0,
    ),
    pendingAdoptionWarehouses: asArray(pick(record, 'pendingAdoptionWarehouses', 'pending_adoption_warehouses'))
      .map(normalizePendingAdoptionWarehouse),
    hasPendingAdoptionWarehouses: asBool(
      pick(record, 'hasPendingAdoptionWarehouses', 'has_pending_adoption_warehouses'),
      asArray(pick(record, 'pendingAdoptionWarehouses', 'pending_adoption_warehouses')).length > 0,
    ),
    verificationOnly: asBool(pick(record, 'verificationOnly', 'verification_only'), false),
    unitUnconfirmed: asBool(pick(record, 'unitUnconfirmed', 'unit_unconfirmed'), false),
    itemRevisionMissing: asIntOrNull(pick(record, 'itemRevisionMissing', 'item_revision_missing')) ?? 0,
    history: asArray(pick(record, 'history')).map(normalizeItemHistory),
    mapping: asArray(pick(record, 'mapping', 'mappings')).map(normalizeItemMapping),
    scopedWarnings: asArray(pick(record, 'scopedWarnings', 'scoped_warnings'))
      .map((entry) => asString(entry))
      .filter(Boolean),
  };
}

/* ------------------------------------------------------------------ *
 * 任务详情
 * ------------------------------------------------------------------ */

function normalizeFileValidation(raw: unknown): InventoryFileValidationDto | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = asRecord(raw);
  const blocked = asBool(pick(record, 'blocked'));
  const headerOk = pick(record, 'headerOk', 'header_ok');
  const explicitStatus = pickString(record, 'status');
  const hasMeaningfulContent = explicitStatus !== ''
    || blocked
    || headerOk === false
    || record.blocked !== undefined
    || record.headerOk !== undefined
    || asArray(record.missingColumns).length > 0
    || asArray(record.ambiguousColumns).length > 0
    || asArray(record.duplicateColumns).length > 0
    || record.comboRowCount !== undefined
    || record.unattributableRowCount !== undefined;
  if (!hasMeaningfulContent) return null;
  const status = explicitStatus || (blocked || headerOk === false ? 'blocked' : 'ok');
  const quantityHeaderRaw = pick(record, 'quantityHeader', 'quantity_header');
  const quantityHeader = typeof quantityHeaderRaw === 'string'
    ? quantityHeaderRaw
    : (quantityHeaderRaw && typeof quantityHeaderRaw === 'object'
      ? Object.fromEntries(Object.entries(asRecord(quantityHeaderRaw)).map(([key, value]) => [key, asString(value)]))
      : null);
  return {
    status,
    missingColumns: asArray(pick(record, 'missingColumns', 'missing_columns')).map((entry) => asString(entry)).filter(Boolean),
    ambiguousColumns: asArray(pick(record, 'ambiguousColumns', 'ambiguous_columns')).map((entry) => asString(entry)).filter(Boolean),
    duplicateColumns: asArray(pick(record, 'duplicateColumns', 'duplicate_columns')).map((entry) => asString(entry)).filter(Boolean),
    quantityHeader,
    comboRowCount: asIntOrNull(pick(record, 'comboRowCount', 'combo_row_count')) ?? undefined,
    unattributableRowCount: asIntOrNull(pick(record, 'unattributableRowCount', 'unattributable_row_count')) ?? undefined,
    reason: pickStringOrNull(record, 'reason'),
  };
}

function normalizeRunFile(raw: unknown): InventoryRunFileDto | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = asRecord(raw);
  return {
    sha256: pickStringOrNull(record, 'sha256', 'sha256Full', 'sha256_full'),
    sha256Prefix: pickStringOrNull(record, 'sha256Prefix', 'sha256_prefix'),
    rowCount: asIntOrNull(pick(record, 'rowCount', 'row_count')),
    blankRowCount: asIntOrNull(pick(record, 'blankRowCount', 'blank_row_count')),
    downloadedAt: asStringOrNull(pick(record, 'downloadedAt', 'downloaded_at')),
    sheetName: pickStringOrNull(record, 'sheetName', 'sheet_name'),
    header: pick(record, 'header') as InventoryRunFileDto['header'],
  };
}

export function normalizeRunWarehouse(raw: unknown): InventoryRunWarehouseDto {
  const record = asRecord(raw);
  return {
    warehouseId: pickString(record, 'warehouseId', 'warehouse_id', 'id'),
    warehouseName: pickStringOrNull(record, 'warehouseName', 'warehouse_name'),
    name: pickStringOrNull(record, 'name'),
    status: pickString(record, 'status') || 'unknown',
    rows: asIntOrNull(pick(record, 'rows', 'rowCount', 'row_count')),
    adopted: asIntOrNull(pick(record, 'adopted')),
    unmapped: asIntOrNull(pick(record, 'unmapped')),
    invalidRows: asIntOrNull(pick(record, 'invalidRows', 'invalid_rows')),
    duplicateSkuRows: asIntOrNull(pick(record, 'duplicateSkuRows', 'duplicate_sku_rows')),
    observationAt: asStringOrNull(pick(record, 'observationAt', 'observation_at')),
    batchId: pickStringOrNull(record, 'batchId', 'batch_id'),
    publishedAt: asStringOrNull(pick(record, 'publishedAt', 'published_at')),
    errorCode: asStringOrNull(pick(record, 'errorCode', 'error_code')),
    reason: pickStringOrNull(record, 'reason'),
  };
}

export function normalizeRunIssue(raw: unknown): InventoryRunIssueDto {
  const record = asRecord(raw);
  return {
    excelRow: asIntOrNull(pick(record, 'excelRow', 'excel_row')) ?? 0,
    warehouseName: pickStringOrNull(record, 'warehouseName', 'warehouse_name'),
    externalSku: pickStringOrNull(record, 'externalSku', 'external_sku'),
    parseStatus: pickString(record, 'parseStatus', 'parse_status') || 'unknown',
    reason: pickStringOrNull(record, 'reason'),
  };
}

export function normalizeRunDetail(raw: unknown): InventoryRunDetailDto {
  const record = asRecord(raw);
  const identity = asRecord(pick(record, 'accountIdentity', 'account_identity'));
  const accountIdentityStatus = pickString(record, 'accountIdentityStatus', 'account_identity_status')
    || pickString(identity, 'status')
    || 'unknown';
  const accountIdentityLabel = pickStringOrNull(record, 'accountIdentityLabel', 'account_identity_label')
    ?? pickStringOrNull(identity, 'label', 'accountLabel');
  const groups = asArray(pick(record, 'groups'));
  const groupByExternalId = new Map<string, Record<string, unknown>>();
  for (const entry of groups) {
    const group = asRecord(entry);
    const externalId = pickString(group, 'warehouseExternalId', 'warehouse_external_id', 'externalId');
    if (externalId) groupByExternalId.set(externalId, group);
  }
  const warehouses = asArray(pick(record, 'warehouses')).map((entry) => {
    const warehouse = normalizeRunWarehouse(entry);
    const group = groupByExternalId.get(pickString(asRecord(entry), 'externalId', 'external_id'));
    if (!group) return warehouse;
    const groupRows = asIntOrNull(pick(group, 'rowCount', 'row_count'));
    const okRows = asIntOrNull(pick(group, 'okRowCount', 'ok_row_count'));
    return {
      ...warehouse,
      sourceRowCount: groupRows ?? warehouse.rows ?? null,
      invalidRows: warehouse.invalidRows ?? (groupRows !== null && okRows !== null ? Math.max(0, groupRows - okRows) : null),
      reason: warehouse.reason ?? pickStringOrNull(group, 'blockedReason', 'blocked_reason'),
    } as InventoryRunWarehouseDto;
  });
  return {
    id: pickString(record, 'id', 'runId', 'run_id'),
    status: pickString(record, 'status') || 'unknown',
    triggerKind: pickString(record, 'triggerKind', 'trigger_kind') || 'unknown',
    plannedFor: asStringOrNull(pick(record, 'plannedFor', 'planned_for')),
    startedAt: asStringOrNull(pick(record, 'startedAt', 'started_at')),
    finishedAt: asStringOrNull(pick(record, 'finishedAt', 'finished_at')),
    errorCode: asStringOrNull(pick(record, 'errorCode', 'error_code')),
    errorDetail: pickStringOrNull(record, 'errorDetail', 'error_detail'),
    coveredSlots: asArray(pick(record, 'coveredSlots', 'covered_slots')).map((entry) => asString(entry)).filter(Boolean),
    observationAt: asStringOrNull(pick(record, 'observationAt', 'observation_at')),
    accountIdentity: {
      status: accountIdentityStatus,
      label: accountIdentityLabel,
    },
    fileValidation: normalizeFileValidation(pick(record, 'fileValidation', 'file_validation')),
    warehouseDiscovery: normalizeDiscoveredWarehouses(pick(record, 'warehouseDiscovery', 'warehouse_discovery')),
    file: normalizeRunFile(pick(record, 'file')),
    warehouses,
    issues: asArray(pick(record, 'issues')).map(normalizeRunIssue),
    lease: pick(record, 'lease') as InventoryRunDetailDto['lease'],
    summary: asRecord(pick(record, 'summary')),
    requestId: pickStringOrNull(record, 'requestId', 'request_id'),
  };
}

/* ------------------------------------------------------------------ *
 * 商品库存双视图 v1：仓库明细 / 商品汇总 / 逐仓读取状态
 *
 * 三个 DB 只读函数（022）返回的 JSON 经这里归一化：
 * - 只改形状（字段别名、缺省），不改业务口径；数量缺失保持 null，不转 0；
 * - 行状态只认 adopted / pending_adoption / inactive / unmapped（旧别名 adopted_inactive 归入 inactive），
 *   缺失时按“有无标准商品”回退；只有 adopted 计入合计，其余状态都保留来源行但不计入；
 * - 商品汇总的合计/缺口一律采信服务端 summary 字段，不在前端另算；市场格不含“整仓可用”合计。
 * ------------------------------------------------------------------ */

function asTextOrNull(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

export function normalizeWarehouseReadStateV2(raw: unknown): InventoryWarehouseReadStateV2Dto {
  const record = asRecord(raw);
  return {
    warehouseId: pickString(record, 'warehouseId', 'warehouse_id', 'id'),
    externalId: pickString(record, 'externalId', 'external_id', 'externalWarehouseId', 'external_warehouse_id'),
    name: pickString(record, 'name', 'warehouseName', 'warehouse_name') || '未命名仓库',
    market: pickStringOrNull(record, 'market'),
    warehouseStatus: pickString(record, 'warehouseStatus', 'warehouse_status', 'status') || 'confirmed',
    lastSuccessAt: asStringOrNull(pick(record, 'lastSuccessAt', 'last_success_at')),
    lastBatchId: pickStringOrNull(record, 'lastBatchId', 'last_batch_id'),
    batchRows: asIntOrNull(pick(record, 'batchRows', 'batch_rows')) ?? 0,
    adoptedRows: asIntOrNull(pick(record, 'adoptedRows', 'adopted_rows')) ?? 0,
    unmappedRows: asIntOrNull(pick(record, 'unmappedRows', 'unmapped_rows')) ?? 0,
    observationAt: asStringOrNull(pick(record, 'observationAt', 'observation_at')),
    publishedAt: asStringOrNull(pick(record, 'publishedAt', 'published_at')),
    failed: asBool(pick(record, 'failed'), false),
    stale: asBool(pick(record, 'stale'), false),
    lastErrorCode: pickStringOrNull(record, 'lastErrorCode', 'last_error_code', 'errorCode'),
    latestRunStatus: pickStringOrNull(record, 'latestRunStatus', 'latest_run_status', 'lastRunStatus'),
    pendingMappingRows: asIntOrNull(pick(record, 'pendingMappingRows', 'pending_mapping_rows'))
      ?? (asIntOrNull(pick(record, 'unmappedRows', 'unmapped_rows')) ?? 0),
  };
}

export function normalizeWarehouseStates(raw: unknown): InventoryWarehouseReadStateV2Dto[] {
  const source = Array.isArray(raw) ? raw : asArray(asRecord(raw).warehouses);
  return source
    .map(normalizeWarehouseReadStateV2)
    .filter((state) => Boolean(state.warehouseId || state.externalId || state.name !== '未命名仓库'));
}

/** 海外行状态：adopted / pending_adoption / inactive / unmapped；缺失时按有无标准商品回退（不把未知当 0 行）。 */
function normalizeWarehouseRowStatus(value: unknown, hasMappedItem: boolean): InventoryWarehouseRowStatus {
  const status = asString(value);
  if (status === 'adopted' || status === 'unmapped' || status === 'pending_adoption' || status === 'inactive') return status;
  if (status === 'adopted_inactive' || status === 'inactive_adopted') return 'inactive';
  if (status === 'pending-adoption' || status === 'pendingAdoption' || status === 'pending') return 'pending_adoption';
  if (status === 'mapped' || status === 'confirmed' || status === 'current') return 'adopted';
  return hasMappedItem ? 'adopted' : 'unmapped';
}

export function normalizeWarehouseRow(raw: unknown): InventoryWarehouseRowDto {
  const record = asRecord(raw);
  const source = asString(pick(record, 'source')) === 'domestic' ? 'domestic' : 'bigseller';
  const warehouseId = pickStringOrNull(record, 'warehouseId', 'warehouse_id');
  const externalSku = pickString(record, 'externalSku', 'external_sku', 'sku');
  const itemId = pickStringOrNull(record, 'itemId', 'item_id');
  const rowKey = pickStringOrNull(record, 'rowKey', 'row_key')
    ?? `${source}:${warehouseId ?? ''}:${externalSku}`;
  return {
    source,
    rowKey,
    warehouseId,
    warehouseExternalId: pickStringOrNull(record, 'warehouseExternalId', 'warehouse_external_id', 'externalId', 'external_id'),
    warehouseName: pickString(record, 'warehouseName', 'warehouse_name', 'name') || '未命名仓库',
    market: pickStringOrNull(record, 'market'),
    status: normalizeWarehouseRowStatus(pick(record, 'status'), Boolean(itemId)),
    itemId,
    iceCode: pickStringOrNull(record, 'iceCode', 'ice_code'),
    itemName: pickStringOrNull(record, 'itemName', 'item_name', 'nameCn', 'name_cn'),
    sourceName: pickStringOrNull(record, 'sourceName', 'source_name', 'productName', 'product_name'),
    externalSku,
    gtin: pickStringOrNull(record, 'gtin', 'barcode'),
    unit: pickStringOrNull(record, 'unit'),
    onHand: asNumberOrNull(pick(record, 'onHand', 'on_hand')),
    orderLocked: asNumberOrNull(pick(record, 'orderLocked', 'order_locked')),
    warehouseAvailable: asNumberOrNull(pick(record, 'warehouseAvailable', 'warehouse_available')),
    activityReserved: asNumberOrNull(pick(record, 'activityReserved', 'activity_reserved')),
    inTransit: asNumberOrNull(pick(record, 'inTransit', 'in_transit')),
    observationAt: asStringOrNull(pick(record, 'observationAt', 'observation_at')),
    batchId: pickStringOrNull(record, 'batchId', 'batch_id'),
    excelRow: asIntOrNull(pick(record, 'excelRow', 'excel_row')),
    mappingStatus: pickStringOrNull(record, 'mappingStatus', 'mapping_status'),
    itemRevision: asIntOrNull(pick(record, 'itemRevision', 'item_revision')),
    rawOnHand: asTextOrNull(pick(record, 'rawOnHand', 'raw_on_hand')),
    lastKnownQty: asNumberOrNull(pick(record, 'lastKnownQty', 'last_known_qty')),
    lastKnownAt: asStringOrNull(pick(record, 'lastKnownAt', 'last_known_at', 'lastKnownObservedAt')),
    note: pickStringOrNull(record, 'note', 'reason'),
    fileDate: pickStringOrNull(record, 'fileDate', 'file_date'),
    fileName: pickStringOrNull(record, 'fileName', 'file_name'),
    cloudAvailableText: pickStringOrNull(record, 'cloudAvailableText', 'cloud_available_text'),
  };
}

export function normalizeWarehouseRows(raw: unknown): InventoryWarehouseRowsDto {
  const record = asRecord(raw);
  const rows = asArray(pick(record, 'rows')).map(normalizeWarehouseRow);
  const scopeRaw = asRecord(pick(record, 'scope'));
  const countsRaw = asRecord(pick(record, 'counts'));
  const counted = (status: InventoryWarehouseRowStatus): number => rows.filter((row) => row.status === status).length;
  return {
    total: asIntOrNull(pick(record, 'total')) ?? rows.length,
    offset: asIntOrNull(pick(record, 'offset')) ?? 0,
    limit: asIntOrNull(pick(record, 'limit')) ?? rows.length,
    rows,
    scope: {
      warehouseCount: asIntOrNull(pick(scopeRaw, 'warehouseCount', 'warehouse_count'))
        ?? new Set(rows.map((row) => row.warehouseId).filter(Boolean)).size,
      lastAllSuccessAt: asStringOrNull(pick(scopeRaw, 'lastAllSuccessAt', 'last_all_success_at')),
      empty: asBool(pick(scopeRaw, 'empty'), rows.length === 0),
    },
    marketOptions: normalizeMarketOptions(pick(record, 'marketOptions', 'market_options')),
    warehouses: normalizeWarehouseStates(pick(record, 'warehouses')),
    counts: {
      adopted: asIntOrNull(pick(countsRaw, 'adopted')) ?? counted('adopted'),
      unmapped: asIntOrNull(pick(countsRaw, 'unmapped')) ?? counted('unmapped'),
      pendingAdoption: asIntOrNull(pick(countsRaw, 'pendingAdoption', 'pending_adoption')) ?? counted('pending_adoption'),
      inactive: asIntOrNull(pick(countsRaw, 'inactive')) ?? counted('inactive'),
    },
  };
}

function normalizeMarketCell(raw: unknown): InventoryProductMarketCellDto {
  const record = asRecord(raw);
  return {
    market: pickStringOrNull(record, 'market'),
    onHand: asNumberOrNull(pick(record, 'onHand', 'on_hand')),
    skuCount: asIntOrNull(pick(record, 'skuCount', 'sku_count')) ?? 0,
    warehouseCount: asIntOrNull(pick(record, 'warehouseCount', 'warehouse_count')) ?? 0,
    hasPendingTotal: asBool(pick(record, 'hasPendingTotal', 'has_pending_total'), false),
  };
}

function normalizeDomesticCell(raw: unknown): InventoryProductDomesticCellDto | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = asRecord(raw);
  return {
    onHand: asNumberOrNull(pick(record, 'onHand', 'on_hand')),
    available: asNumberOrNull(pick(record, 'available', 'availableQty', 'available_qty')),
    rowCount: asIntOrNull(pick(record, 'rowCount', 'row_count')) ?? 0,
    fileDates: asArray(pick(record, 'fileDates', 'file_dates')).map((entry) => asString(entry)).filter(Boolean),
    hasQuantityAnomaly: asBool(pick(record, 'hasQuantityAnomaly', 'has_quantity_anomaly'), false),
  };
}

export function normalizeProductSummaryRow(raw: unknown): InventoryProductSummaryRowDto {
  const record = asRecord(raw);
  const item = normalizeListItem(record);
  // 显式返回 null（多单位/待合计不凑数）要保留 null，不能回退成 knownSubtotal
  const overseasKey = ['overseasOnHand', 'overseas_on_hand'].find((key) => record[key] !== undefined);
  return {
    ...item,
    marketCells: asArray(pick(record, 'marketCells', 'market_cells')).map(normalizeMarketCell),
    overseasOnHand: overseasKey ? asNumberOrNull(record[overseasKey]) : item.knownSubtotal,
    overseasSkuCount: asIntOrNull(pick(record, 'overseasSkuCount', 'overseas_sku_count')) ?? 0,
    domestic: normalizeDomesticCell(pick(record, 'domestic')),
  };
}

export function normalizeProductSummary(raw: unknown): InventoryProductSummaryDto {
  const record = asRecord(raw);
  const rows = asArray(pick(record, 'rows')).map(normalizeProductSummaryRow);
  const scopeRaw = asRecord(pick(record, 'scope'));
  return {
    total: asIntOrNull(pick(record, 'total')) ?? rows.length,
    offset: asIntOrNull(pick(record, 'offset')) ?? 0,
    limit: asIntOrNull(pick(record, 'limit')) ?? 50,
    rows,
    scope: {
      warehouseCount: asIntOrNull(pick(scopeRaw, 'warehouseCount', 'warehouse_count')) ?? 0,
      lastAllSuccessAt: asStringOrNull(pick(scopeRaw, 'lastAllSuccessAt', 'last_all_success_at')),
      empty: asBool(pick(scopeRaw, 'empty'), false),
      marketFilter: pickStringOrNull(scopeRaw, 'marketFilter', 'market_filter'),
      warehouseFilter: pickStringOrNull(scopeRaw, 'warehouseFilter', 'warehouse_filter'),
    },
    marketOptions: normalizeMarketOptions(pick(record, 'marketOptions', 'market_options')),
    warehouses: normalizeWarehouseStates(pick(record, 'warehouses')),
    unmappedOverseasRows: asIntOrNull(pick(record, 'unmappedOverseasRows', 'unmapped_overseas_rows')) ?? 0,
    unmappedDomesticRows: asIntOrNull(pick(record, 'unmappedDomesticRows', 'unmapped_domestic_rows')) ?? 0,
    domesticAvailable: asBool(pick(record, 'domesticAvailable', 'domestic_available'), false),
    domesticReason: pickStringOrNull(record, 'domesticReason', 'domestic_reason'),
  };
}

export { asArray, asBool, asIntOrNull, asNumberOrNull, asRecord, asString, asStringOrNull, pick, pickString, pickStringOrNull };

