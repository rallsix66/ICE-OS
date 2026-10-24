import 'server-only';

import { requireCatalogAdmin } from './authorization';
import { catalogRepository, intentHash } from './repository';
import { prepareBaseline } from './sources/baseline-adapter';
import { loadFrozenFeishu } from './sources/frozen-feishu-adapter';
import { buildCandidates, buildDifferences } from './candidate-service';
import { appendNonPriceRevisionSchema, assignInitialCodeSchema, importFrozenObservationsSchema, publishBaselineSchema } from './schema';
import { assignNewItemCode, appendNewItemRevision, getNewItemWriteContext, recoverNewItemRequest } from './new-item/service';
import { newItemIntent, newItemRepository } from './new-item/repository';
import { basisDocumentSha256, buildCatalogDisplayOverview, buildCatalogListFallbackFromItems, CatalogDisplayReadError, prepareBsSampleImportPayload } from './local-display/service';
import { toCatalogListClientPayload } from './local-display/list-client-types';
import { warehouseScopeView } from './local-display/warehouse-valuation';
import { buildRevisionHistoryDisplay } from './history-display';
import { parseRequestOutcomeInput, resolveCatalogRequestOutcome, REQUEST_ACTION_BY_KIND } from './reconcile';
import type { CatalogDetailRevisionView, CatalogRequestOutcome, CatalogRevisionEvidenceDto, CatalogRevisionHistoryDto } from './types';
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
          displayError = 'BS 样表库存读取失败';
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
      displayError = 'BS 样表库存读取失败';
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
  let allRows;
  let meta;
  try {
    [allRows, meta] = await Promise.all([
      /* V5-02：列表按完整库存行计算“本仓无对应”等状态；详情若先按当前仓筛选，
         同一空仓会被算成两种状态并触发假同步提示。统一先读完整行，展示时再筛当前仓。 */
      catalogRepository.itemBsSampleRows(identity, itemId, null),
      catalogRepository.bsSampleMeta(identity),
    ]);
  } catch (error) {
    if (error instanceof CatalogDisplayReadError) throw error;
    const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: string }).code) : '';
    if (code === '42501') throw new CatalogDisplayReadError('forbidden', '应用身份无权读取 BS 样表库存', error);
    throw new CatalogDisplayReadError('read_failed', 'BS 样表库存读取失败', error);
  }
  if (!meta) return { status: 'not_imported' as const, exportLabel: null, rows: [], adoptedUnitCost: null, valuation: null, basisDocumentSha256: null };
  const [financial, flags] = await Promise.all([
    amountAllowed ? catalogRepository.amounts(identity, itemId) : Promise.resolve(null),
    catalogRepository.itemStatusFlags(identity, itemId),
  ]);
  const notCreatedBs = flags.bsNotCreated;
  const inventorySlices = (allRows as Array<Record<string, unknown>>).map((r) => ({
    itemId,
    warehouse: String(r.warehouse),
    onHand: r.onHand == null ? null : String(r.onHand),
    selectionState: String(r.selectionState),
  }));
  const scope = warehouseScopeView(inventorySlices, itemId, warehouse, financial, amountAllowed, notCreatedBs);
  const rows = warehouse
    ? (allRows as Array<Record<string, unknown>>).filter((r) => String(r.warehouse) === warehouse)
    : allRows;
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

/**
 * V3-01.3 历史记录日常投影：原始审计事实留在服务端，
 * 客户端只拿中文理由、可核实显示名（或 null）、确定性本地时间、字段级差异与“有无证据”。
 * 不含 actor UUID、证据路径、内部英文 reason、原始 ISO 时间。
 */
export async function getCatalogDetailHistoryDisplay(itemId: string): Promise<CatalogRevisionHistoryDto[]> {
  if (!/^[a-f\d-]{36}$/i.test(itemId)) throw new Error('CATALOG_INVALID_INPUT');
  const identity = await requireCatalogAdmin('history:read');
  const rows = await catalogRepository.history(identity, itemId);
  if (!rows.length) return [];
  const [currentRevision, originKind] = await Promise.all([
    catalogRepository.currentRevision(identity, itemId),
    catalogRepository.originKind(identity, itemId),
  ]);
  /* 显示名仅为展示补充：读取失败（例如无 profiles 读取权）降级为 null，不编造操作者，也不影响历史事实。 */
  const actorLabels = await catalogRepository
    .profileDisplayNames(identity, rows.map((row) => row.revisionAudit.actorId))
    .catch(() => new Map<string, string>());
  return buildRevisionHistoryDisplay({ rows, currentRevision: currentRevision ?? rows[0].revision, originKind, actorLabels });
}

/**
 * V3-01.6 历史版本核心视图：沿用 getCatalogDetailCore(itemId,{revision})，
 * 只读、不带 BS 样表投影（历史不混入当前库存/价格）；版本不存在时抛错，绝不静默回退当前版本。
 */
export async function getCatalogDetailRevision(itemId: string, revision: number): Promise<CatalogDetailRevisionView> {
  if (!Number.isInteger(revision) || revision < 1) throw new Error('CATALOG_INVALID_INPUT');
  const core = await getCatalogDetailCore(itemId, { revision });
  return {
    item: core.item,
    flags: core.flags,
    writeAccess: core.writeAccess,
    historical: true,
    bsSample: null,
    bsSampleError: null,
  };
}

/**
 * 授权原始证据（V3-01.4）：只在弹窗内“来源与证据”子视图按需读取，权限同 history:read。
 * 日常历史投影不经过这里，也不缓存到日常 payload。
 */
export async function getCatalogRevisionEvidence(itemId: string, revision: number): Promise<CatalogRevisionEvidenceDto | null> {
  if (!/^[a-f\d-]{36}$/i.test(itemId) || !Number.isInteger(revision) || revision < 1) throw new Error('CATALOG_INVALID_INPUT');
  const identity = await requireCatalogAdmin('history:read');
  const row = await catalogRepository.historyRevision(identity, itemId, revision);
  if (!row) return null;
  return {
    reason: row.revisionAudit.reason,
    actorId: row.revisionAudit.actorId,
    evidenceRef: row.revisionAudit.evidenceRef,
    recordedAt: row.revisionAudit.recordedAt,
  };
}

/**
 * V3-04.5 只读核对原请求回执：查 catalog.audit_event(request_id+actor_id) 与既有版本事实，
 * 只读、不重发、不写业务。找不到回执回 no_receipt（不等于“未提交”）；范围不一致回 scope_mismatch；
 * 当前账户没有核对权限回 not_authorized（撤权不等于原事务失败）。
 */
export async function checkCatalogRequestOutcome(input: unknown): Promise<CatalogRequestOutcome> {
  const parsed = parseRequestOutcomeInput(input);
  const identity = await requireCatalogAdmin('history:read').catch((error: unknown) => {
    // 模块未启用是环境状态而非“没有核对权限”，保持原有错误语义交由调用方分类展示。
    if (error instanceof Error && error.message === 'CATALOG_UNAVAILABLE') throw error;
    return null;
  });
  if (!identity) return { status: 'not_authorized', revision: null, actionLabel: null };

  const originKind = await catalogRepository.originKind(identity, parsed.itemId);
  if (originKind === 'new_item') {
    /* scoped 新品的真实回执在 catalog.new_item_request；没有发布权就无法核对，明确回无权而不是猜成功/未提交。 */
    const context = await getNewItemWriteContext(parsed.itemId).catch(() => null);
    if (!context) return { status: 'not_authorized', revision: null, actionLabel: null };
    const action = parsed.kind === 'initial_code' ? 'assign_initial_code' : 'append_nonprice_revision';
    const payload = parsed.kind === 'initial_code'
      ? { itemId: parsed.itemId, expectedRevision: parsed.expectedRevision, code: parsed.code, privateReason: parsed.reason }
      : { itemId: parsed.itemId, expectedRevision: parsed.expectedRevision, fields: parsed.fields, privateReason: parsed.reason };
    let scopedReceipt: { itemId?: string; revision?: number } | null;
    try {
      scopedReceipt = await newItemRepository.receipt(
        identity,
        parsed.requestId,
        context.scopeId,
        action,
        newItemIntent(identity, context.scopeId, action, payload),
      );
    } catch {
      return { status: 'not_authorized', revision: null, actionLabel: null };
    }
    return resolveCatalogRequestOutcome({
      actorId: identity.profileUserId,
      expectedBaselineIntent: '',
      readReceipt: async () => null,
      readOriginKind: async () => 'new_item',
      readScopedReceipt: async () => scopedReceipt
        ? { itemId: scopedReceipt.itemId ?? null, result: scopedReceipt }
        : null,
    }, parsed);
  }

  /* 与写入侧一致：intent 只覆盖 schema 解析后的完整原意图，不包含客户端用于分流的 kind。 */
  const { kind: parsedKind, ...baselineIntentInput } = parsed;
  const expectedBaselineIntent = intentHash(REQUEST_ACTION_BY_KIND[parsedKind], baselineIntentInput);
  return resolveCatalogRequestOutcome({
    actorId: identity.profileUserId,
    expectedBaselineIntent,
    readReceipt: (requestId) => catalogRepository.request(identity, requestId),
    readOriginKind: async () => originKind,
    readScopedReceipt: async () => null,
  }, parsed);
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
        : new CatalogDisplayReadError('read_failed', 'BS 样表库存读取失败', error);
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
