import 'server-only';

import { requireCatalogAdmin } from './authorization';
import { catalogRepository } from './repository';
import { prepareBaseline } from './sources/baseline-adapter';
import { loadFrozenFeishu } from './sources/frozen-feishu-adapter';
import { buildCandidates, buildDifferences } from './candidate-service';
import { appendNonPriceRevisionSchema, assignInitialCodeSchema, importFrozenObservationsSchema, publishBaselineSchema } from './schema';
import { assignNewItemCode, appendNewItemRevision, getNewItemWriteContext, recoverNewItemRequest } from './new-item/service';
import { basisDocumentSha256, buildCatalogDisplayOverview, buildCatalogListFallbackFromItems, CatalogDisplayReadError, prepareBsSampleImportPayload } from './local-display/service';
import { toCatalogListClientPayload } from './local-display/list-client-types';
import { warehouseScopeView } from './local-display/warehouse-valuation';
async function writeAccess(identity: Parameters<typeof catalogRepository.originKind>[0], itemId: string) {
  const kind = await catalogRepository.originKind(identity, itemId);
  if (kind === 'baseline') return { isScoped: false, canWrite: true };
  const context = kind === 'new_item' ? await getNewItemWriteContext(itemId).catch(() => null) : null;
  return { isScoped: kind === 'new_item', canWrite: Boolean(context) };
}

export async function getCatalogOverview() {
  const identity = await requireCatalogAdmin();
  const amountAllowed = await requireCatalogAdmin('amount:read').then(() => true).catch(() => false);
  const [release, stats, displayStatusBundle] = await Promise.all([
    catalogRepository.release(identity),
    catalogRepository.adminSummaryCounts(identity),
    (async () => {
      let display: Awaited<ReturnType<typeof buildCatalogDisplayOverview>> = null;
      let displayStatus: 'loaded' | 'not_imported' | 'read_failed' | 'forbidden' = 'not_imported';
      let displayError: string | null = null;
      try {
        display = await buildCatalogDisplayOverview(identity, { amountAllowed });
        displayStatus = display ? 'loaded' : 'not_imported';
      } catch (error) {
        if (error instanceof CatalogDisplayReadError) {
          displayStatus = error.code === 'forbidden' ? 'forbidden' : 'read_failed';
          displayError = error.message;
        } else {
          displayStatus = 'read_failed';
          displayError = 'BS 样表库存投影读取失败';
        }
      }
      return { display, displayStatus, displayError };
    })(),
  ]);
  return {
    release,
    display: displayStatusBundle.display,
    displayStatus: displayStatusBundle.displayStatus,
    displayError: displayStatusBundle.displayError,
    stats: {
      items: stats.items,
      coded: stats.coded,
      observations: release?.observationCount ?? stats.observations,
      choices: stats.choices,
      history: stats.history,
    },
  };
}

export async function getCatalogAdminDecisionsPage(offset: number, limit: number) {
  const identity = await requireCatalogAdmin();
  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLimit = Math.min(200, Math.max(1, Math.floor(limit)));
  return catalogRepository.decisionsPage(identity, { offset: safeOffset, limit: safeLimit });
}

export async function getCatalogAdminObservationsPage(offset: number, limit: number) {
  const identity = await requireCatalogAdmin();
  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)));
  return catalogRepository.observationsPage(identity, { offset: safeOffset, limit: safeLimit });
}

export async function getCatalogListPage() {
  const identity = await requireCatalogAdmin();
  const amountAllowed = await requireCatalogAdmin('amount:read').then(() => true).catch(() => false);
  let items: Awaited<ReturnType<typeof catalogRepository.list>>;
  try {
    items = await catalogRepository.list(identity, { baselinePublishedOnly: true });
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: string }).code) : '';
    return {
      itemsLoadFailed: true as const,
      itemsLoadError: code === '42501' ? '主商品资料读取被拒绝（权限不足）' : '主商品资料读取失败',
      displayStatus: 'read_failed' as const,
      displayError: null,
      itemCount: 0,
      amountAllowed,
      payload: null,
      auxiliaryErrors: [] as string[],
    };
  }
  let sourceSearchTokens = new Map<string, string[]>();
  let bsNotCreatedIds = new Set<string>();
  const auxiliaryErrors: string[] = [];
  await Promise.all([
    catalogRepository.sourceSearchTokensByItem(identity).then((tokens) => { sourceSearchTokens = tokens; }).catch(() => {
      auxiliaryErrors.push('已确认来源 SKU 检索索引读取失败；主资料仍可用，来源 SKU 搜索可能不完整。');
    }),
    catalogRepository.bsNotCreatedItemIds(identity).then((ids) => { bsNotCreatedIds = ids; }).catch(() => {
      auxiliaryErrors.push('BS 未建档标记读取失败；主资料仍可用，状态标记可能不完整。');
    }),
  ]);
  let display: Awaited<ReturnType<typeof buildCatalogDisplayOverview>> = null;
  let displayStatus: 'loaded' | 'not_imported' | 'read_failed' | 'forbidden' = 'not_imported';
  let displayError: string | null = null;
  try {
    display = await buildCatalogDisplayOverview(identity, { amountAllowed, preload: { items, bsNotCreatedIds } });
    displayStatus = display ? 'loaded' : 'not_imported';
  } catch (error) {
    if (error instanceof CatalogDisplayReadError) {
      displayStatus = error.code === 'forbidden' ? 'forbidden' : 'read_failed';
      displayError = error.message;
    } else {
      displayStatus = 'read_failed';
      displayError = 'BS 样表库存投影读取失败';
    }
  }
  const payload = display
    ? toCatalogListClientPayload(display, sourceSearchTokens)
    : await buildCatalogListFallbackFromItems(identity, items, amountAllowed, { bsNotCreatedIds, sourceSearchTokens });
  return {
    itemsLoadFailed: false as const,
    payload,
    displayStatus,
    displayError,
    itemCount: items.length,
    amountAllowed,
    auxiliaryErrors,
  };
}

export async function importCatalogBsSampleInventory(input: unknown) {
  const identity = await requireCatalogAdmin('catalog:write');
  const parsed = typeof input === 'object' && input !== null && 'requestId' in input && 'extractedPath' in input
    ? { requestId: String((input as { requestId: string }).requestId), extractedPath: String((input as { extractedPath: string }).extractedPath) }
    : null;
  if (!parsed?.requestId.match(/^[a-f\d-]{36}$/i)) throw new Error('CATALOG_INVALID_INPUT');
  const prepared = await prepareBsSampleImportPayload(parsed.extractedPath);
  return catalogRepository.importBsSampleInventory(identity, parsed.requestId, prepared as unknown as Record<string, unknown>);
}

export async function getCatalogItemBsSample(itemId: string, warehouse?: string) {
  const identity = await requireCatalogAdmin();
  const amountAllowed = await requireCatalogAdmin('amount:read').then(() => true).catch(() => false);
  if (!/^[a-f\d-]{36}$/i.test(itemId)) throw new Error('CATALOG_INVALID_INPUT');
  let rows;
  let meta;
  try {
    [rows, meta] = await Promise.all([
      catalogRepository.itemBsSampleRows(identity, itemId, warehouse),
      catalogRepository.bsSampleMeta(identity),
    ]);
  } catch (error) {
    if (error instanceof CatalogDisplayReadError) throw error;
    const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: string }).code) : '';
    if (code === '42501') throw new CatalogDisplayReadError('forbidden', '应用身份无权读取 BS 样表库存投影', error);
    throw new CatalogDisplayReadError('read_failed', 'BS 样表库存投影读取失败', error);
  }
  if (!meta) return { status: 'not_imported' as const, exportLabel: null, rows: [], adoptedUnitCost: null, valuation: null, basisDocumentSha256: null };
  const [financial, flags] = await Promise.all([
    amountAllowed ? catalogRepository.amounts(identity, itemId) : Promise.resolve(null),
    catalogRepository.itemStatusFlags(identity, itemId),
  ]);
  const notCreatedBs = flags.bsNotCreated;
  const inventorySlices = (rows as Array<Record<string, unknown>>).map((r) => ({
    itemId,
    warehouse: String(r.warehouse),
    onHand: r.onHand == null ? null : String(r.onHand),
    selectionState: String(r.selectionState),
  }));
  const scope = warehouseScopeView(inventorySlices, itemId, warehouse, financial, amountAllowed, notCreatedBs);
  const basisHash = await basisDocumentSha256().catch(() => null);
  return {
    status: 'loaded' as const,
    exportLabel: meta.exportLabel ?? null,
    rows,
    adoptedUnitCost: financial,
    basisDocumentSha256: basisHash ?? (typeof meta.basisDocumentSha256 === 'string' ? meta.basisDocumentSha256 : null),
    valuation: scope,
  };
}

export async function getCatalogDetailCore(itemId: string, options: { revision?: number } = {}) {
  if (!/^[a-f\d-]{36}$/i.test(itemId) || (options.revision !== undefined && (!Number.isInteger(options.revision) || options.revision < 1))) throw new Error('CATALOG_INVALID_INPUT');
  const identity = await requireCatalogAdmin('history:read');
  const [item, flags, access] = await Promise.all([
    catalogRepository.get(identity, itemId, options.revision),
    catalogRepository.itemStatusFlags(identity, itemId),
    writeAccess(identity, itemId),
  ]);
  if (!item) throw new Error('CATALOG_NOT_FOUND');
  return { item, flags, writeAccess: access, historical: options.revision !== undefined };
}

export async function getCatalogDetailHistory(itemId: string) {
  if (!/^[a-f\d-]{36}$/i.test(itemId)) throw new Error('CATALOG_INVALID_INPUT');
  const identity = await requireCatalogAdmin('history:read');
  return catalogRepository.history(identity, itemId);
}

export async function getCatalogDetailAudit(itemId: string) {
  if (!/^[a-f\d-]{36}$/i.test(itemId)) throw new Error('CATALOG_INVALID_INPUT');
  const identity = await requireCatalogAdmin('history:read');
  const item = await catalogRepository.get(identity, itemId);
  if (!item) throw new Error('CATALOG_NOT_FOUND');
  const [observations, decisions] = await Promise.all([
    catalogRepository.observationsForItem(identity, item),
    catalogRepository.decisions(identity, itemId),
  ]);
  const artifacts: Awaited<ReturnType<typeof catalogRepository.artifacts>> = [];
  const candidates = { bigseller: buildCandidates(item, observations, 'bigseller'), jushuitan: buildCandidates(item, observations, 'jushuitan') };
  const related = new Set([...candidates.bigseller, ...candidates.jushuitan].map((c) => c.observationId));
  return {
    candidates,
    decisions,
    observations: observations.filter((o) => related.has(o.observationId) || o.sourceSystem === 'feishu'),
    differences: buildDifferences(item, observations),
    artifacts,
  };
}

export async function getCatalogDetail(itemId: string, options: { revision?: number } = {}) {
  const core = await getCatalogDetailCore(itemId, options);
  const history = core.historical ? await getCatalogDetailHistory(itemId) : [];
  return {
    item: core.item,
    history,
    candidates: { bigseller: [], jushuitan: [] },
    decisions: [],
    observations: [],
    differences: [],
    artifacts: [],
    flags: core.flags,
    writeAccess: core.writeAccess,
  };
}

export async function getCatalogDetailView(itemId: string, warehouse?: string) {
  const core = await getCatalogDetailCore(itemId);
  let bsSample: Awaited<ReturnType<typeof getCatalogItemBsSample>> | null = null;
  let bsSampleError: CatalogDisplayReadError | null = null;
  if (!core.historical) {
    try {
      bsSample = await getCatalogItemBsSample(itemId, warehouse);
    } catch (error) {
      bsSampleError = error instanceof CatalogDisplayReadError
        ? error
        : new CatalogDisplayReadError('read_failed', 'BS 样表库存投影读取失败', error);
    }
  }
  return {
    ...core,
    bsSample,
    bsSampleError: bsSampleError ? { code: bsSampleError.code, message: bsSampleError.message } : null,
  };
}

export async function prepareCatalogBaseline() {
  await requireCatalogAdmin('catalog:write');
  const baseline = await prepareBaseline();
  return { previewId: baseline.contentSha256, counts: baseline.counts, fullManifestCount: baseline.fullManifest.length, subsetManifestCount: baseline.subsetManifest.length };
}

export async function publishCatalogBaseline(input: unknown) {
  const identity = await requireCatalogAdmin('catalog:write');
  const parsed = publishBaselineSchema.parse(input);
  const baseline = await prepareBaseline();
  if (baseline.contentSha256 !== parsed.previewId) throw new Error('CATALOG_PREVIEW_CHANGED');
  return catalogRepository.publish(identity, parsed.requestId, baseline);
}

export async function importCatalogFrozenObservations(input: unknown) {
  const identity = await requireCatalogAdmin('catalog:write');
  const parsed = importFrozenObservationsSchema.parse(input);
  const frozen = await loadFrozenFeishu();
  if (frozen.approvedSnapshotId !== parsed.approvedSnapshotId) throw new Error('CATALOG_SNAPSHOT_CHANGED');
  return catalogRepository.importFrozen(identity, parsed.requestId, frozen);
}

export async function assignCatalogInitialCode(input: unknown) {
  const identity = await requireCatalogAdmin('catalog:write');
  const parsed = assignInitialCodeSchema.parse(input);
  if (await catalogRepository.originKind(identity, parsed.itemId) === 'new_item') {
    const context = await getNewItemWriteContext(parsed.itemId);
    if (!context) throw new Error('NEW_ITEM_SCOPED_ACTION_REQUIRED');
    const { reason, ...fields } = parsed;
    return assignNewItemCode({ ...fields, scopeId: context.scopeId, privateReason: reason });
  }
  return catalogRepository.assignInitialCode(identity, parsed);
}

export async function appendCatalogNonPriceRevision(input: unknown) {
  const identity = await requireCatalogAdmin('catalog:write');
  const parsed = appendNonPriceRevisionSchema.parse(input);
  if (await catalogRepository.originKind(identity, parsed.itemId) === 'new_item') {
    const context = await getNewItemWriteContext(parsed.itemId);
    if (!context) throw new Error('NEW_ITEM_SCOPED_ACTION_REQUIRED');
    const { reason, ...fields } = parsed;
    return appendNewItemRevision({ ...fields, scopeId: context.scopeId, privateReason: reason });
  }
  return catalogRepository.appendNonPriceRevision(identity, parsed);
}

export async function recoverCatalogNewItemRequest(request: { kind: 'initial_code' | 'nonprice_revision'; input: unknown }) {
  if (!request || typeof request !== 'object' || Object.keys(request).sort().join('|') !== 'input|kind'
    || !['initial_code', 'nonprice_revision'].includes(request.kind)) throw new Error('CATALOG_INVALID_INPUT');
  const identity = await requireCatalogAdmin('catalog:write');
  const parsed = request.kind === 'initial_code' ? assignInitialCodeSchema.parse(request.input) : appendNonPriceRevisionSchema.parse(request.input);
  if (await catalogRepository.originKind(identity, parsed.itemId) !== 'new_item') throw new Error('NEW_ITEM_SCOPED_ACTION_REQUIRED');
  const context = await getNewItemWriteContext(parsed.itemId);
  if (!context) throw new Error('NEW_ITEM_SCOPED_ACTION_REQUIRED');
  const { reason, ...fields } = parsed;
  return recoverNewItemRequest({ action: request.kind === 'initial_code' ? 'assign_initial_code' : 'append_nonprice_revision',
    input: { ...fields, scopeId: context.scopeId, privateReason: reason } });
}

export async function getCatalogAmounts(itemId: string) {
  const identity = await requireCatalogAdmin('amount:read');
  if (!/^[a-f\d-]{36}$/i.test(itemId)) throw new Error('CATALOG_INVALID_INPUT');
  const item = await catalogRepository.get(identity, itemId);
  if (!item) throw new Error('CATALOG_NOT_FOUND');
  const adopted = await catalogRepository.amounts(identity, itemId);
  const observations = await catalogRepository.observations(identity);
  const differences = buildDifferences(item, observations);
  const refs = new Set(differences.map((d) => d.observationId));
  const relevant = observations.filter((o) => o.selectedItemId === itemId || refs.has(o.observationId));
  const observationAmounts = await Promise.all(relevant.map(async (o) => ({ observationId: o.observationId,
    position: o.position, amounts: await catalogRepository.observationAmounts(identity, o.observationId) })));
  return { adopted, observations: observationAmounts };
}

export async function getCatalogDetailArtifacts() {
  const identity = await requireCatalogAdmin('history:read');
  return catalogRepository.artifacts(identity);
}

export async function getEvidenceArtifact(artifactId: string) {
  const identity = await requireCatalogAdmin('evidence:read');
  await requireCatalogAdmin('amount:read');
  if (!/^[a-f\d-]{36}$/i.test(artifactId)) throw new Error('CATALOG_INVALID_INPUT');
  const artifact = await catalogRepository.evidence(identity, artifactId);
  if (!artifact) throw new Error('CATALOG_NOT_FOUND');
  return artifact;
}
