import type { getCatalogDetailView } from '../service';
import type { CatalogListClientRow } from '../local-display/list-client-types';
import type { WarehouseScopeView } from '../local-display/display-types';

export type CatalogDetailView = Awaited<ReturnType<typeof getCatalogDetailView>>;

/** Client cache entries older than this are not served as fresh. */
export const DETAIL_CACHE_MAX_AGE_MS = 30 * 60 * 1000;

/** Client-side session binding: principal + amount permission + display projection generation. */
export type CatalogDetailCacheContext = {
  principalKey: string;
  amountAllowed: boolean;
  displayBasisSha256: string;
};

export type CatalogDetailScope = {
  itemId: string;
  warehouse: string;
  itemRevision: number;
  /** List-compatible aggregate projection (server list row authority). */
  listProjectionToken: string;
  /** Detail inventory fingerprint including line-level quantities. */
  detailProjectionToken: string;
  authToken: string;
  displayBasisSha256: string;
};

export type InventoryProjectionRow = {
  warehouse: string;
  sku: string;
  onHand?: string | null;
  orderLocked?: string | null;
  warehouseAvailable?: string | null;
  activityReserved?: string | null;
  inTransit?: string | null;
};

export type DetailFetchFailureKind = 'forbidden' | 'network' | 'read_failed';

export function normalizeDetailWarehouse(warehouse?: string): string {
  const trimmed = warehouse?.trim();
  return trimmed && trimmed !== 'all' ? trimmed : 'all';
}

export function detailScopeKey(scope: Pick<CatalogDetailScope, 'itemId' | 'warehouse'>): string {
  return `${scope.itemId}\0${normalizeDetailWarehouse(scope.warehouse === 'all' ? undefined : scope.warehouse)}`;
}

export function buildDetailAuthToken(context: CatalogDetailCacheContext): string {
  return `${context.principalKey}\0${context.amountAllowed ? '1' : '0'}`;
}

type BsInventoryRow = {
  warehouse?: unknown;
  sku?: unknown;
  onHand?: unknown;
  orderLocked?: unknown;
  warehouseAvailable?: unknown;
  activityReserved?: unknown;
  inTransit?: unknown;
};

function warehouseScopeForList(
  row: Pick<CatalogListClientRow, 'bsSample'>,
  warehouse: string,
): WarehouseScopeView & { confirmedOnHandTotal: string | null } {
  const wh = normalizeDetailWarehouse(warehouse);
  if (wh === 'all') {
    return {
      confirmedOnHandTotal: row.bsSample.confirmedOnHandTotal,
      estimatedValueCny: row.bsSample.estimatedValueCny,
      valuationState: row.bsSample.valuationState,
      valuationReason: row.bsSample.valuationReason,
      confirmedLineCount: row.bsSample.confirmedLineCount,
    };
  }
  const scoped = row.bsSample.warehouseScopes[wh];
  return scoped ?? {
    confirmedOnHandTotal: null,
    estimatedValueCny: null,
    valuationState: 'no_warehouse_line',
    valuationReason: null,
    confirmedLineCount: 0,
  };
}

function valuationScopeToken(scope: Pick<WarehouseScopeView, 'valuationState' | 'estimatedValueCny' | 'confirmedOnHandTotal' | 'confirmedLineCount'>): string {
  return `${scope.valuationState}\0${scope.estimatedValueCny ?? ''}\0${scope.confirmedOnHandTotal ?? ''}\0${scope.confirmedLineCount}`;
}

function inventoryLinesToken(rows: BsInventoryRow[], warehouse: string): string {
  const wh = normalizeDetailWarehouse(warehouse);
  const filtered = rows.filter((row) => {
    const rowWh = String(row.warehouse ?? '');
    return wh === 'all' || rowWh === wh;
  });
  return filtered
    .map((row) => [
      String(row.warehouse ?? ''),
      String(row.sku ?? ''),
      row.onHand == null ? '' : String(row.onHand),
      row.orderLocked == null ? '' : String(row.orderLocked),
      row.warehouseAvailable == null ? '' : String(row.warehouseAvailable),
      row.activityReserved == null ? '' : String(row.activityReserved),
      row.inTransit == null ? '' : String(row.inTransit),
    ].join('|'))
    .sort()
    .join('\n');
}

/** Aggregate list projection — must match server list payload for the same warehouse. */
export function buildListProjectionToken(
  row: Pick<CatalogListClientRow, 'bsSample'>,
  warehouse: string | undefined,
  amountAllowed: boolean,
): string {
  const wh = normalizeDetailWarehouse(warehouse);
  const scope = warehouseScopeForList(row, wh);
  return `${wh}\0${amountAllowed ? '1' : '0'}\0${valuationScopeToken(scope)}`;
}

export function buildListProjectionTokenFromView(
  view: Pick<CatalogDetailView, 'bsSample' | 'bsSampleError'>,
  warehouse: string | undefined,
  amountAllowed: boolean,
): string {
  const wh = normalizeDetailWarehouse(warehouse);
  if (view.bsSampleError) return `${wh}\0${amountAllowed ? '1' : '0'}\0err:${view.bsSampleError.code}`;
  const sample = view.bsSample;
  if (!sample || sample.status !== 'loaded') return `${wh}\0${amountAllowed ? '1' : '0'}\0sample:${sample?.status ?? 'null'}`;
  const v = sample.valuation;
  return `${wh}\0${amountAllowed ? '1' : '0'}\0${valuationScopeToken({
    valuationState: v.valuationState,
    estimatedValueCny: v.estimatedValueCny,
    confirmedOnHandTotal: v.confirmedOnHandTotal,
    confirmedLineCount: v.confirmedLineCount,
  })}`;
}

export function buildDetailInventoryProjectionToken(
  view: Pick<CatalogDetailView, 'bsSample' | 'bsSampleError'>,
  warehouse?: string,
): string {
  const wh = normalizeDetailWarehouse(warehouse);
  if (view.bsSampleError) return `err:${view.bsSampleError.code}`;
  const sample = view.bsSample;
  if (!sample || sample.status !== 'loaded') return `sample:${sample?.status ?? 'null'}`;
  const rows = (sample.rows ?? []) as BsInventoryRow[];
  return `${wh}\0${inventoryLinesToken(rows, wh)}`;
}

export function buildDetailInventoryProjectionTokenFromRows(
  rows: InventoryProjectionRow[],
  warehouse?: string,
): string {
  const wh = normalizeDetailWarehouse(warehouse);
  const mapped = rows.map((row) => ({
    warehouse: row.warehouse,
    sku: row.sku,
    onHand: row.onHand,
    orderLocked: row.orderLocked,
    warehouseAvailable: row.warehouseAvailable,
    activityReserved: row.activityReserved,
    inTransit: row.inTransit,
  }));
  return `${wh}\0${inventoryLinesToken(mapped, wh)}`;
}

export function buildDetailProjectionToken(
  view: Pick<CatalogDetailView, 'bsSample' | 'bsSampleError'>,
  warehouse?: string,
  amountAllowed?: boolean,
): string {
  const listPart = buildListProjectionTokenFromView(view, warehouse, amountAllowed ?? true);
  const invPart = buildDetailInventoryProjectionToken(view, warehouse);
  return `${listPart}\0inv:${invPart}`;
}

export function detailInventoryTokenFromProjection(detailProjectionToken: string): string {
  const idx = detailProjectionToken.indexOf('\0inv:');
  return idx >= 0 ? detailProjectionToken.slice(idx + 5) : detailProjectionToken;
}

export function listAuthorityMatchesLoadedScope(
  loaded: CatalogDetailScope,
  expected: Pick<CatalogDetailScope, 'itemId' | 'warehouse' | 'itemRevision' | 'listProjectionToken' | 'detailProjectionToken' | 'authToken' | 'displayBasisSha256'>,
): boolean {
  if (loaded.itemId !== expected.itemId) return false;
  if (loaded.warehouse !== normalizeDetailWarehouse(expected.warehouse === 'all' ? undefined : expected.warehouse)) return false;
  if (loaded.itemRevision !== expected.itemRevision) return false;
  if (loaded.listProjectionToken !== expected.listProjectionToken) return false;
  if (loaded.authToken !== expected.authToken) return false;
  if (loaded.displayBasisSha256 !== expected.displayBasisSha256) return false;
  const loadedInv = detailInventoryTokenFromProjection(loaded.detailProjectionToken);
  const expectedInv = detailInventoryTokenFromProjection(expected.detailProjectionToken);
  return loadedInv === expectedInv;
}

export function expectedScopeFromListRow(
  detailId: string,
  warehouse: string | undefined,
  listRow: Pick<CatalogListClientRow, 'itemId' | 'itemRevision' | 'bsSample' | 'inventoryProjectionByWarehouse'> | undefined,
  context: CatalogDetailCacheContext,
): Pick<CatalogDetailScope, 'itemRevision' | 'listProjectionToken' | 'detailProjectionToken' | 'displayBasisSha256'> | null {
  if (!listRow || listRow.itemId !== detailId) return null;
  const wh = normalizeDetailWarehouse(warehouse);
  const listPart = buildListProjectionToken(listRow, warehouse, context.amountAllowed);
  const invPart = listRow.inventoryProjectionByWarehouse?.[wh]
    ?? listRow.inventoryProjectionByWarehouse?.all
    ?? 'missing';
  return {
    itemRevision: listRow.itemRevision,
    listProjectionToken: listPart,
    detailProjectionToken: `${listPart}\0inv:${invPart}`,
    displayBasisSha256: context.displayBasisSha256,
  };
}

export function authoritativeExpectedFromList(
  detailId: string,
  warehouse: string | undefined,
  listRow: Parameters<typeof expectedScopeFromListRow>[2],
  context: CatalogDetailCacheContext,
): Pick<CatalogDetailScope, 'itemId' | 'warehouse' | 'itemRevision' | 'listProjectionToken' | 'detailProjectionToken' | 'authToken' | 'displayBasisSha256'> | null {
  const fromList = expectedScopeFromListRow(detailId, warehouse, listRow, context);
  if (!fromList) return null;
  return {
    itemId: detailId,
    warehouse: normalizeDetailWarehouse(warehouse),
    authToken: buildDetailAuthToken(context),
    ...fromList,
  };
}

export function responseDisplayBasisSha256(
  view: Pick<CatalogDetailView, 'bsSample' | 'bsSampleError'>,
): string | null {
  const sample = view.bsSample;
  if (!sample || sample.status !== 'loaded') return null;
  const fromResponse = sample.basisDocumentSha256;
  return typeof fromResponse === 'string' && fromResponse.length > 0 ? fromResponse : null;
}

export function detailScopeFromView(
  view: CatalogDetailView,
  warehouse: string | undefined,
  context: CatalogDetailCacheContext,
): CatalogDetailScope {
  const warehouseNorm = normalizeDetailWarehouse(warehouse);
  const basisFromResponse = responseDisplayBasisSha256(view);
  return {
    itemId: view.item.itemId,
    warehouse: warehouseNorm,
    itemRevision: view.item.revision,
    listProjectionToken: buildListProjectionTokenFromView(view, warehouse, context.amountAllowed),
    detailProjectionToken: buildDetailProjectionToken(view, warehouse, context.amountAllowed),
    authToken: buildDetailAuthToken(context),
    displayBasisSha256: basisFromResponse ?? context.displayBasisSha256,
  };
}

export function scopesMatch(
  a: CatalogDetailScope | null,
  b: Pick<CatalogDetailScope, 'itemId' | 'warehouse' | 'itemRevision' | 'listProjectionToken' | 'detailProjectionToken' | 'authToken' | 'displayBasisSha256'>,
): boolean {
  if (!a) return false;
  if (a.itemId !== b.itemId) return false;
  if (normalizeDetailWarehouse(b.warehouse === 'all' ? undefined : b.warehouse) !== a.warehouse) return false;
  if (b.itemRevision !== undefined && b.itemRevision !== a.itemRevision) return false;
  if (b.listProjectionToken !== undefined && b.listProjectionToken !== a.listProjectionToken) return false;
  if (b.detailProjectionToken !== undefined && b.detailProjectionToken !== a.detailProjectionToken) return false;
  if (b.authToken !== undefined && b.authToken !== a.authToken) return false;
  if (b.displayBasisSha256 !== undefined && b.displayBasisSha256 !== a.displayBasisSha256) return false;
  return true;
}

/**
 * V3-03：已取得“全部仓库”明细时，同一商品版本/权限/口径下的单仓视图可本地派生：
 * 明细按仓筛选，汇总取列表同版本对应仓投影（服务端已按同一精确规则计算）。
 * 单仓响应不能推断其他仓；数据不完整时返回 null，由调用方局部读取。
 */
export function allWarehouseAuthorityMatches(
  view: CatalogDetailView,
  listRow: Pick<CatalogListClientRow, 'itemId' | 'itemRevision' | 'bsSample' | 'inventoryProjectionByWarehouse'> | undefined,
  context: CatalogDetailCacheContext,
): boolean {
  if (!listRow || listRow.itemId !== view.item.itemId) return false;
  if (listRow.itemRevision !== view.item.revision) return false;
  const sample = view.bsSample;
  if (!sample || sample.status !== 'loaded') return false;
  /* V4-05：全仓总数相同不能证明分仓/锁定/在途明细未变；必须核完整的全仓明细投影。 */
  const serverAll = listRow.inventoryProjectionByWarehouse?.all;
  if (!serverAll) return false;
  const viewAll = buildDetailInventoryProjectionTokenFromRows(
    (sample.rows ?? []) as InventoryProjectionRow[],
    'all',
  );
  if (viewAll !== serverAll) return false;
  const viewToken = buildListProjectionTokenFromView(view, 'all', context.amountAllowed);
  const listToken = buildListProjectionToken(listRow, 'all', context.amountAllowed);
  if (viewToken !== listToken) return false;
  const responseBasis = responseDisplayBasisSha256(view);
  return !responseBasis || responseBasis === context.displayBasisSha256;
}

export function deriveWarehouseView(params: {
  view: CatalogDetailView;
  target: string;
  listRow: Pick<CatalogListClientRow, 'itemId' | 'itemRevision' | 'bsSample' | 'inventoryProjectionByWarehouse'> | undefined;
  context: CatalogDetailCacheContext;
}): CatalogDetailView | null {
  const { view, listRow } = params;
  const wh = normalizeDetailWarehouse(params.target);
  if (wh === 'all') return null;
  if (view.historical) return null;
  if (view.bsSampleError) return null;
  const sample = view.bsSample;
  if (!sample || sample.status !== 'loaded') return null;
  if (!listRow || listRow.itemId !== view.item.itemId || listRow.itemRevision !== view.item.revision) return null;
  const scoped = listRow.bsSample.warehouseScopes?.[wh];
  if (!scoped) return null;
  const rows = (sample.rows ?? []) as BsInventoryRow[];
  /* 派生结果必须再次核对目标仓的完整明细投影；不能用全仓合计掩盖分仓行变化。 */
  const targetRows = rows.filter((row) => String(row.warehouse ?? '') === wh);
  const serverTarget = listRow.inventoryProjectionByWarehouse?.[wh];
  if (!serverTarget) return null;
  if (buildDetailInventoryProjectionTokenFromRows(targetRows as InventoryProjectionRow[], wh) !== serverTarget) return null;
  /* 目标仓汇总显示有已确认行，但全仓明细里拿不到该仓行：数据不完整，必须局部读取。 */
  if (scoped.confirmedLineCount > 0 && targetRows.length === 0) return null;
  /* 全仓明细必须确实包含多个仓（单仓响应不能冒充全仓）。 */
  const warehouses = new Set(rows.map((row) => String(row.warehouse ?? '')).filter(Boolean));
  if (warehouses.size < 2) return null;
  return {
    ...view,
    bsSample: { ...sample, rows: targetRows, valuation: scoped },
  } as CatalogDetailView;
}

export type CacheEntry = {
  view: CatalogDetailView;
  scope: CatalogDetailScope;
  storedAt: number;
  confirmedAt: number;
  stale: boolean;
};

const cache = new Map<string, CacheEntry>();
const MAX = 48;

export function readDetailCache(
  scope: Pick<CatalogDetailScope, 'itemId' | 'warehouse'>,
  context: CatalogDetailCacheContext,
  expected?: Pick<CatalogDetailScope, 'itemRevision' | 'listProjectionToken' | 'detailProjectionToken' | 'displayBasisSha256'>,
): CacheEntry | null {
  const key = detailScopeKey(scope);
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.scope.itemId !== scope.itemId) return null;
  if (hit.scope.authToken !== buildDetailAuthToken(context)) return null;
  if (hit.scope.displayBasisSha256 !== context.displayBasisSha256) return null;
  if (!hit.confirmedAt || hit.confirmedAt <= 0) return null;
  if (Date.now() - hit.confirmedAt > DETAIL_CACHE_MAX_AGE_MS) return null;
  if (expected?.itemRevision !== undefined && hit.scope.itemRevision !== expected.itemRevision) return null;
  if (expected?.listProjectionToken !== undefined && hit.scope.listProjectionToken !== expected.listProjectionToken) return null;
  if (expected?.detailProjectionToken !== undefined) {
    const hitInv = detailInventoryTokenFromProjection(hit.scope.detailProjectionToken);
    const expInv = detailInventoryTokenFromProjection(expected.detailProjectionToken);
    if (hitInv !== expInv) return null;
  }
  if (expected?.displayBasisSha256 !== undefined && hit.scope.displayBasisSha256 !== expected.displayBasisSha256) return null;
  if (hit.stale) return null;
  return hit;
}

export function writeDetailCache(
  view: CatalogDetailView,
  warehouse: string | undefined,
  context: CatalogDetailCacheContext,
): CacheEntry {
  const scope = detailScopeFromView(view, warehouse, context);
  const key = detailScopeKey(scope);
  const now = Date.now();
  const entry: CacheEntry = { view, scope, storedAt: now, confirmedAt: now, stale: false };
  cache.set(key, entry);
  if (cache.size > MAX) {
    const oldest = [...cache.entries()].sort((x, y) => x[1].storedAt - y[1].storedAt)[0];
    if (oldest) cache.delete(oldest[0]);
  }
  return entry;
}

export function markDetailCacheStale(itemId: string, warehouse?: string): void {
  const prefix = warehouse
    ? detailScopeKey({ itemId, warehouse })
    : `${itemId}\0`;
  for (const [key, entry] of cache.entries()) {
    if (warehouse ? key === prefix : key.startsWith(prefix)) {
      cache.set(key, { ...entry, stale: true });
    }
  }
}

export function invalidateDetailCacheItem(itemId: string): void {
  for (const key of cache.keys()) {
    if (key.startsWith(`${itemId}\0`)) cache.delete(key);
  }
}

export function invalidateDetailCacheForPrincipal(principalKey?: string): void {
  if (!principalKey) {
    cache.clear();
    return;
  }
  for (const [key, entry] of cache.entries()) {
    if (entry.scope.authToken.startsWith(`${principalKey}\0`)) cache.delete(key);
  }
}

export function clearDetailCache(): void {
  cache.clear();
}

/** Strip protected valuation/cost fields after auth failure while keeping non-sensitive identity. */
export function maskDetailViewForAuthFailure(view: CatalogDetailView): CatalogDetailView {
  const masked = {
    ...view,
    bsSampleError: view.bsSampleError ?? { code: 'forbidden', message: '当前账户无权读取金额或库存数据。' },
  } as CatalogDetailView;
  if (view.bsSample && view.bsSample.status === 'loaded') {
    masked.bsSample = {
      ...view.bsSample,
      adoptedUnitCost: null,
      valuation: {
        ...view.bsSample.valuation,
        estimatedValueCny: null,
        valuationState: 'no_price',
        valuationReason: '金额读取权限已失效',
      },
    };
  } else {
    masked.bsSample = view.bsSample;
  }
  return masked;
}

export function classifyDetailFetchFailure(error?: string | null): DetailFetchFailureKind {
  const text = error ?? '';
  if (text.includes('无权') || text.includes('权限') || text.includes('停用') || text.includes('登录')) return 'forbidden';
  return 'read_failed';
}

export function resolveBackgroundDetailFetch(params: {
  success: boolean;
  data?: CatalogDetailView | null;
  error?: string | null;
  cachedView: CatalogDetailView | null;
  failureKind?: DetailFetchFailureKind;
}):
  | { kind: 'success'; view: CatalogDetailView }
  | { kind: 'failure'; failure: DetailFetchFailureKind; error: string; retainMasked?: CatalogDetailView } {
  if (params.success && params.data) {
    return { kind: 'success', view: params.data };
  }
  const failure = params.failureKind ?? classifyDetailFetchFailure(params.error);
  if (failure === 'forbidden' && params.cachedView) {
    return {
      kind: 'failure',
      failure,
      error: params.error ?? '当前账户无权访问商品资料。',
      retainMasked: maskDetailViewForAuthFailure(params.cachedView),
    };
  }
  return {
    kind: 'failure',
    failure,
    error: params.error ?? '详情读取失败',
  };
}
