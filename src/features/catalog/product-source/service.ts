import 'server-only';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { requireCatalogAdmin } from '../authorization';
import { withAppDb } from '@/lib/database/app-db';
import { storePrivateArtifact } from '../evidence-store';
import { CATALOG_FIELD_LABELS } from '../local-display/field-labels';
import { formatRecordedAtDisplay } from '../history-display';
import {
  SOURCE_PROFILE_KEY,
  REASON_TEXT,
  ISSUE_KIND_LABELS,
  FIELD_UNITS,
  canonicalJson,
  type BuildPlanInput,
  type PlanAdoptionRow,
  type PlanAppliedSnapshot,
  type PlanBinding,
  type PlanBoundItem,
  type PlanCounts,
  type ProductSourcePlan,
  type ProductSourcePlanResult,
} from './contract';
import { validateSnapshot } from './headers';
import { buildPlan, toPlanPayload, buildBatchPayload } from './plan';
import { createLocalSnapshotReader } from './local-reader';
import type { ProductSourceReader } from './reader';
import { productSourceRepository, PRODUCT_SOURCE_APPLY_ACTION, sourceIntent } from './repository';
import {
  applyProductSourceSchema,
  assignProductSourceCodeSchema,
  resolveProductSourceIssueSchema,
  retryProductSourceSchema,
  type ApplyProductSourceInput,
  type AssignProductSourceCodeInput,
  type ResolveProductSourceIssueInput,
} from './schema';
import type {
  ApplyReceipt,
  SourceBatchInput,
  SourceOverviewRaw,
  SourceProfileInput,
} from './server-types';
import type { ProductSourceCountsDto, ProductSourcePanelDto } from './panel-types';

/** 文件来源固定身份：用户确认的文档/工作表事实 + 匿名只读采集方式。 */
export const SOURCE_PROFILE: SourceProfileInput = {
  profileKey: SOURCE_PROFILE_KEY,
  documentKey: 'wiki:TC2AwLgRniqWKhkg9D2cEx79n0b',
  spreadsheetToken: 'EMZGs2eIhh0YQ1tPIqMcR8SPnQh',
  sheetId: '33bab4',
  sheetName: 'Sheet1',
  displayName: 'ICE产品库',
  sourceUrl: 'https://ygr1tb7cyf.feishu.cn/wiki/TC2AwLgRniqWKhkg9D2cEx79n0b',
  acquisitionMode: 'local_snapshot',
};

const EMPTY_COUNTS: PlanCounts = { created: 0, updated: 0, unchanged: 0, needsReview: 0, failed: 0, missing: 0 };

export function emptyCounts(): PlanCounts {
  return { ...EMPTY_COUNTS };
}

function emptyCountsDto(counts: PlanCounts): ProductSourceCountsDto {
  return {
    created: counts.created,
    updated: counts.updated,
    unchanged: counts.unchanged,
    needsReview: counts.needsReview,
    failed: counts.failed,
    missing: counts.missing,
  };
}

interface PlanInputs {
  bindings: PlanBinding[];
  items: PlanBoundItem[];
  adoptions: PlanAdoptionRow[];
  appliedSnapshots: PlanAppliedSnapshot[];
}

/** 读取计划所需的库内事实（只读；不涉及价格）。 */
async function loadPlanInputs(identity: { profileUserId: string }): Promise<PlanInputs> {
  return withAppDb(identity, async (client) => {
    await client.query('SELECT catalog.require_admin()');
    const bindings = await client.query<{ item_id: string; ice_code: string; state: 'active' | 'missing' }>(
      `SELECT b.item_id, b.ice_code, b.state
       FROM catalog.product_source_binding b
       JOIN catalog.product_source_profile p ON p.id = b.profile_id
       WHERE p.profile_key = $1`,
      [SOURCE_PROFILE_KEY],
    );
    const items = await client.query<{ id: string; revision: number; ice_code: string | null; name_cn: string; fields: unknown }>(
      `SELECT i.id, c.revision, r.ice_code_snapshot AS ice_code, r.name_cn, r.fields
       FROM catalog.catalog_item i
       JOIN catalog.item_current c ON c.item_id = i.id
       JOIN catalog.item_revision r ON r.item_id = i.id AND r.revision = c.revision`,
    );
    const adoptions = await client.query<{ item_id: string; field_key: string; adopted_raw: string | null; adopted_state: 'observed' | 'explicit_empty'; unit_state: string }>(
      `SELECT a.item_id, a.field_key, a.adopted_raw, a.adopted_state, a.unit_state
       FROM catalog.product_source_adoption a
       JOIN catalog.product_source_profile p ON p.id = a.profile_id
       WHERE p.profile_key = $1`,
      [SOURCE_PROFILE_KEY],
    );
    const applied = await client.query<{ snapshot_key: string; captured_at: string; status: PlanAppliedSnapshot['status'] }>(
      `SELECT b.snapshot_key, b.captured_at, b.status
       FROM catalog.product_source_batch b
       JOIN catalog.product_source_profile p ON p.id = b.profile_id
       WHERE p.profile_key = $1 AND b.status IN ('applied','partial')
       ORDER BY b.captured_at`,
      [SOURCE_PROFILE_KEY],
    );
    return {
      bindings: bindings.rows.map((row) => ({ itemId: row.item_id, iceCode: row.ice_code, state: row.state })),
      items: items.rows.map((row) => ({
        itemId: row.id,
        revision: Number(row.revision),
        iceCode: row.ice_code,
        nameCn: row.name_cn,
        fields: (row.fields ?? {}) as PlanBoundItem['fields'],
      })),
      adoptions: adoptions.rows.map((row) => ({
        itemId: row.item_id,
        fieldKey: row.field_key as PlanAdoptionRow['fieldKey'],
        adoptedRaw: row.adopted_raw,
        adoptedState: row.adopted_state,
        unitState: row.unit_state as PlanAdoptionRow['unitState'],
      })),
      appliedSnapshots: applied.rows.map((row) => ({ snapshotKey: row.snapshot_key, capturedAt: row.captured_at, status: row.status })),
    };
  });
}

function reader(): ProductSourceReader {
  return createLocalSnapshotReader();
}

function sourceRoot(): string {
  const runRoot = process.env.CATALOG_RUN_ROOT;
  if (!runRoot) throw new Error('CATALOG_UNAVAILABLE');
  return path.join(runRoot, 'source-snapshots');
}

interface SnapshotEvidenceArtifact {
  logicalName: string;
  sha256: string;
  size: number;
  format: string;
  storageHandle: string;
  role: 'snapshot' | 'raw_capture' | 'metadata';
}

async function storeSnapshotEvidence(fileName: string): Promise<SnapshotEvidenceArtifact[]> {
  const root = sourceRoot();
  const base = path.basename(fileName, '.json');
  const candidates: Array<{ file: string; role: SnapshotEvidenceArtifact['role']; format: string }> = [
    { file: path.join(root, fileName), role: 'snapshot', format: 'json' },
    { file: path.join(root, `${base}.capture.tsv`), role: 'raw_capture', format: 'tsv' },
    { file: path.join(root, `${base}.capture-metadata.json`), role: 'metadata', format: 'json' },
  ];
  const artifacts: SnapshotEvidenceArtifact[] = [];
  for (const candidate of candidates) {
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(candidate.file);
    } catch {
      continue;
    }
    const stored = await storePrivateArtifact(`product-source/${base}.${candidate.format}`, bytes);
    artifacts.push({
      logicalName: stored.logicalName,
      sha256: stored.sha256,
      size: stored.size,
      format: stored.format,
      storageHandle: stored.storageHandle,
      role: candidate.role,
    });
  }
  return artifacts;
}

function adoptionDigest(plan: { results: ProductSourcePlanResult[] }): string {
  return createHash('sha256')
    .update(canonicalJson(plan.results.map((result) => ({ sourceKey: result.sourceKey, adoptions: result.adoptions }))))
    .digest('hex');
}

function captureSummaryOf(snapshot: { collection: { headers: Record<string, string>; businessRowCount: number }; rows: Array<{ fields: Record<string, { state: string; raw: string }> }> }): string {
  const headerCount = Object.values(snapshot.collection.headers ?? {}).filter((value) => value.trim().length > 0).length;
  const codeCount = snapshot.rows.filter((row) => {
    const code = row.fields.iceCode;
    return code?.state === 'observed' && typeof code.raw === 'string' && code.raw.trim().length > 0;
  }).length;
  return `表头校验通过（${headerCount} 列） · 有效业务行 ${snapshot.collection.businessRowCount} 行 · 来源编号 ${codeCount} 个`;
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    collected: '已采集',
    validated: '已校验',
    applied: '已应用',
    partial: '部分完成（含待核对/失败项）',
    failed: '失败（未改商品资料）',
    rejected_stale: '旧快照已拒绝',
  };
  return labels[status] ?? '状态未标注';
}

function originLabel(origin: string): string {
  return origin === 'local_simulation' ? '本地模拟变化（非飞书真实修改）' : '真实来源快照';
}

function classificationLabel(classification: string): string {
  const labels: Record<string, string> = {
    updated: '已更新',
    created: '新品进入',
    unchanged: '无变化',
    needs_review: '待核对',
    missing: '本次未见',
    failed: '失败',
  };
  return labels[classification] ?? '状态未标注';
}

/** DB 的 action（update/create…）与页面分类（updated/created…）是两套词表。 */
function classificationOf(action: string): ProductSourcePanelDto['results'][number]['classification'] {
  if (action === 'update') return 'updated';
  if (action === 'create') return 'created';
  if (action === 'needs_review') return 'needs_review';
  if (action === 'unchanged') return 'unchanged';
  return 'failed';
}

function fieldLabel(key: string): string {
  return CATALOG_FIELD_LABELS[key] ?? '其他资料字段';
}

function unitLabelOf(key: string): string | null {
  const unit = FIELD_UNITS[key as keyof typeof FIELD_UNITS];
  if (!unit) return null;
  if (unit.state === 'unconfirmed') return '单位未确认';
  return unit.label;
}

function issueDetailLabel(kind: string, detail: Record<string, unknown>): string {
  if (kind === 'duplicate_code_inconsistent') {
    const conflicts = Array.isArray(detail.conflicts) ? detail.conflicts.length : 0;
    return conflicts > 0 ? `同一编号多行，${conflicts} 个字段资料不一致；未自动更新` : '同一编号多行资料不一致；未自动更新';
  }
  if (kind === 'field_conflict') {
    const keys = Array.isArray(detail.fieldKeys) ? detail.fieldKeys.map((key) => fieldLabel(String(key))) : [];
    return keys.length ? `本地与来源同时修改：${keys.join('、')}；保留本地值` : '本地与来源同时修改；保留本地值';
  }
  if (kind === 'field_group_conflict') return '外箱尺寸字段组存在冲突；整组保留本地值';
  if (kind === 'unit_unconfirmed') {
    const sourceRaw = typeof detail.sourceRaw === 'string' ? detail.sourceRaw.trim() : '';
    return sourceRaw
      ? `来源数值单位未确认，来源原文「${sourceRaw}」与待核对提示保留；不采用、不换算`
      : '来源数值单位未确认，来源原文与待核对提示保留；不采用、不换算';
  }
  if (kind === 'missing_code') return '来源行没有商品编号；未按名称自动建档或合并';
  if (kind === 'missing_code_candidate') return '来源缺码行与现有缺码商品名称相近；请人工核对补号';
  if (kind === 'suspected_code_change') return '来源编号与现有商品条码/名称关系相近但编号不同；未自动换号或建档';
  if (kind === 'invalid_carton_quantity') return '装箱数量不是正整数；未采用该字段';
  if (kind === 'formula_error') return '来源单元格是公式错误值；未采用';
  if (kind === 'invalid_value') return '来源数值无法解析；未采用';
  if (kind === 'capture_incomplete') return '来源采集不完整或被截断；整批未应用';
  if (kind === 'header_contract_invalid') return '来源表头与字段契约不符；整批未应用';
  if (kind === 'missing_row') return '本次来源快照未见该商品；仅标记，不删除';
  return ISSUE_KIND_LABELS[kind as keyof typeof ISSUE_KIND_LABELS] ?? '待核对';
}

function countRowsOf(results: ReadonlyArray<Pick<ProductSourcePlanResult, 'action' | 'missing'>>): PlanCounts {
  const counts = emptyCounts();
  for (const result of results) {
    if (result.missing) counts.missing += 1;
    if (result.action === 'create') counts.created += 1;
    else if (result.action === 'update') counts.updated += 1;
    else if (result.action === 'unchanged') counts.unchanged += 1;
    else if (result.action === 'needs_review') counts.needsReview += 1;
    else if (result.action === 'failed') counts.failed += 1;
  }
  return counts;
}

function summaryMessage(counts: PlanCounts): string {
  return `新品 ${counts.created} · 已更新 ${counts.updated} · 无变化 ${counts.unchanged} · 待核对 ${counts.needsReview} · 失败 ${counts.failed} · 本次未见 ${counts.missing}`;
}

function resultSourceLabel(result: ProductSourcePlanResult): string {
  if (result.iceCode) return result.iceCode;
  if (result.rowNumbers.length === 1) return `来源第 ${result.rowNumbers[0]} 行`;
  if (result.rowNumbers.length > 1) return `来源第 ${result.rowNumbers.join('、')} 行`;
  return '批次校验';
}

function mapResults(results: ProductSourcePlanResult[]): ProductSourcePanelDto['results'] {
  return results.map((result) => ({
    sourceKeyLabel: resultSourceLabel(result),
    iceCode: result.iceCode,
    nameCn: result.nameCn,
    classification: result.missing ? 'missing' : classificationOf(result.action),
    classificationLabel: classificationLabel(result.missing ? 'missing' : result.action),
    reasonLabel: REASON_TEXT[result.reasonCode] ?? '来源处理',
    rowNumbers: result.rowNumbers,
    changes: result.changes.map((change) => ({
      fieldLabel: fieldLabel(change.fieldKey),
      before: change.beforeRaw ?? '未提供',
      after: change.afterRaw ?? '未提供',
      unitLabel: unitLabelOf(change.fieldKey),
    })),
  }));
}

/** 最近可用但尚未应用的快照（页面初始加载时的“可应用”入口）。 */
async function pendingSnapshotSummary(): Promise<{
  snapshotKey: string;
  capturedAt: string;
  origin: 'real_capture' | 'local_simulation';
  captureSummary: string;
} | null> {
  const localReader = reader();
  const snapshots = await localReader.listSnapshots();
  if (!snapshots.length) return null;
  const overview = await overviewRaw();
  const applied = new Set((overview?.batches ?? []).filter((batch) => batch.status === 'applied' || batch.status === 'partial').map((batch) => batch.snapshotKey));
  const candidate = [...snapshots].reverse().find((snapshot) => !applied.has(snapshot.snapshotKey));
  if (!candidate) return null;
  const snapshot = await localReader.readSnapshot(candidate.snapshotKey);
  const validation = validateSnapshot(snapshot);
  return {
    snapshotKey: candidate.snapshotKey,
    capturedAt: candidate.capturedAt,
    origin: candidate.origin,
    captureSummary: validation.ok ? captureSummaryOf(snapshot) : `快照校验未通过：${validation.issues.map((issue) => issue.code).join('、')}`,
  };
}

async function overviewRaw(): Promise<SourceOverviewRaw | null> {
  const identity = await requireCatalogAdmin();
  try {
    return await productSourceRepository.overview(identity, SOURCE_PROFILE_KEY);
  } catch {
    return null;
  }
}

export interface ProductSourcePendingDto {
  snapshotToken: string;
  capturedAtDisplay: string;
  originLabel: string;
  captureSummary: string;
}

export async function getProductSourcePanel(): Promise<ProductSourcePanelDto> {
  const identity = await requireCatalogAdmin();
  const overview = await productSourceRepository.overview(identity, SOURCE_PROFILE_KEY);
  const latest = overview.latest;
  let pending: ProductSourcePendingDto | null = null;
  let pendingError: string | null = null;
  try {
    const candidate = await pendingSnapshotSummary();
    if (candidate) {
      pending = {
        snapshotToken: candidate.snapshotKey,
        capturedAtDisplay: formatRecordedAtDisplay(candidate.capturedAt),
        originLabel: originLabel(candidate.origin),
        captureSummary: candidate.captureSummary,
      };
    }
  } catch (error) {
    pendingError = error instanceof Error ? error.message : '读取失败';
  }
  const latestCollection = latest?.collection as { headers?: Record<string, string>; businessRowCount?: number } | undefined;
  const latestCaptureSummary = latest && latestCollection
    ? `表头校验通过（${Object.values(latestCollection.headers ?? {}).filter((value) => value.trim().length > 0).length} 列） · 有效业务行 ${latestCollection.businessRowCount ?? 0} 行 · 来源编号 ${overview.bindingCount} 个`
    : null;
  const openIssues = overview.issues.filter((issue) => issue.reviewState === 'open');
  const simulation = Boolean(latest?.origin === 'local_simulation' || pending?.originLabel.includes('模拟'));
  return {
    source: {
      profileKey: overview.source.profileKey,
      displayName: overview.source.displayName,
      documentLabel: `飞书云文档 · ${overview.source.sheetName}`,
      sheetName: overview.source.sheetName,
      mode: overview.source.acquisitionMode,
      modeLabel: overview.source.acquisitionMode === 'local_snapshot' ? '本地模拟读取（未开通飞书 API）' : '飞书 API 读取',
      simulation,
    },
    latest: latest
      ? {
        batchIdLabel: `第 ${overview.batches.length} 批`,
        snapshotToken: latest.snapshotKey,
        capturedAtDisplay: formatRecordedAtDisplay(latest.capturedAt),
        originLabel: originLabel(latest.origin),
        status: latest.status,
        statusLabel: statusLabel(latest.status),
        counts: emptyCountsDto(latest.counts),
        message: latest.message,
        captureSummary: latestCaptureSummary,
      }
      : null,
    results: mapResults(overview.results as unknown as ProductSourcePlanResult[]),
    issues: openIssues.map((issue) => ({
      issueKey: issue.issueKey,
      sourceKeyLabel: issue.iceCode ?? (issue.rows.length ? `来源第 ${issue.rows.join('、')} 行` : '批次校验'),
      iceCode: issue.iceCode,
      nameCn: issue.nameCn,
      kind: issue.kind,
      kindLabel: ISSUE_KIND_LABELS[issue.kind as keyof typeof ISSUE_KIND_LABELS] ?? '待核对',
      detailLabel: issueDetailLabel(issue.kind, issue.detail),
      reviewState: issue.reviewState,
      reviewStateLabel: issue.reviewState === 'open' ? '待核对' : issue.reviewState === 'resolved' ? '已处理' : '已忽略',
      rows: issue.rows,
    })),
    batchHistory: overview.batches.map((batch, index) => ({
      batchIdLabel: `第 ${index + 1} 批`,
      capturedAtDisplay: formatRecordedAtDisplay(batch.capturedAt),
      originLabel: originLabel(batch.origin),
      statusLabel: statusLabel(batch.status),
      countsSummary: summaryMessage(batch.counts),
    })),
    actions: {
      canApply: Boolean(pending),
      canRetry: Boolean(latest && (latest.status === 'failed' || latest.status === 'partial')),
      canResolveIssues: openIssues.length > 0,
      disabledReason: pending
        ? null
        : pendingError
          ? `读取来源快照失败：${pendingError}`
          : '当前没有待应用的新来源快照。',
    },
    pending,
  };
}

interface PreparedSnapshot {
  snapshot: Awaited<ReturnType<ProductSourceReader['readSnapshot']>>;
  fileName: string;
}

async function loadSnapshotByKey(snapshotKey: string): Promise<PreparedSnapshot> {
  const localReader = reader();
  const summaries = await localReader.listSnapshots();
  const summary = summaries.find((entry) => entry.snapshotKey === snapshotKey);
  if (!summary) throw new Error('PRODUCT_SOURCE_SNAPSHOT_NOT_FOUND');
  const snapshot = await localReader.readSnapshot(summary.snapshotKey);
  return { snapshot, fileName: summary.fileName };
}

function buildPlanForSnapshot(
  snapshot: PreparedSnapshot['snapshot'],
  inputs: PlanInputs,
  retryFailedSourceKeys?: readonly string[],
) {
  return buildPlan({
    snapshot,
    bindings: inputs.bindings,
    items: inputs.items,
    adoptions: inputs.adoptions,
    appliedSnapshots: inputs.appliedSnapshots,
    latestAppliedCapturedAt: inputs.appliedSnapshots.length
      ? inputs.appliedSnapshots[inputs.appliedSnapshots.length - 1].capturedAt
      : null,
    retryFailedSourceKeys,
  } satisfies BuildPlanInput);
}

function receiptSummary(receipt: ApplyReceipt): string {
  const counts = receipt.counts ?? emptyCounts();
  return summaryMessage(counts);
}

function receiptPrefix(status: ApplyReceipt['status']): string {
  if (status === 'applied') return '本批处理完成';
  if (status === 'failed') return '本批未改商品资料';
  if (status === 'partial') return '本批部分完成';
  if (status === 'rejected_stale') return '该快照早于最近成功批次，已拒绝，未覆盖新结果';
  return '该来源快照已应用，未重复建立商品或追加相同修订';
}

/** 已保留原请求及完整意图：按原 requestId + 原 intent + 原载荷核对，绝不重新生成计划。 */
async function replayPreservedRequest(
  identity: Awaited<ReturnType<typeof requireCatalogAdmin>>,
  requestId: string,
  snapshotKey: string,
): Promise<string | null> {
  const stored = await productSourceRepository.readIntent(identity, requestId);
  if (stored) {
    if (stored.action !== PRODUCT_SOURCE_APPLY_ACTION || stored.snapshotKey !== snapshotKey) {
      throw new Error('CATALOG_REQUEST_CONFLICT');
    }
    const receipt = await productSourceRepository.applyWithIntent(
      identity,
      requestId,
      stored.intentSha256,
      stored.payload.profile,
      stored.payload.batch,
      stored.payload.plan,
    );
    if (receipt.status === 'rejected_stale') return '原请求回执为旧快照已拒绝；未覆盖新结果。';
    return `已核对到原请求回执（${statusLabel(receipt.status)}）：${receiptSummary(receipt)}；未重复修订。`;
  }
  const receipt = await productSourceRepository.receiptByRequest(identity, requestId, PRODUCT_SOURCE_APPLY_ACTION);
  if (receipt) {
    if (receipt.status === 'rejected_stale') return '原请求回执为旧快照已拒绝；未覆盖新结果。';
    return `已核对到原请求回执（${statusLabel(receipt.status)}）：${receiptSummary(receipt)}；未重复修订。`;
  }
  return null;
}

async function submitPrepared(
  identity: Awaited<ReturnType<typeof requireCatalogAdmin>>,
  requestId: string,
  batch: SourceBatchInput,
  planPayload: ReturnType<typeof toPlanPayload>,
): Promise<ApplyReceipt> {
  // 先保留原请求及完整意图，再提交；提交结果未知时可按原样核对。
  const intent = sourceIntent(identity, PRODUCT_SOURCE_APPLY_ACTION, {
    profile: SOURCE_PROFILE,
    batch: batch.snapshotKey,
    plan: planPayload,
  });
  await productSourceRepository.recordIntent(
    identity,
    requestId,
    PRODUCT_SOURCE_APPLY_ACTION,
    intent,
    SOURCE_PROFILE.profileKey,
    batch.snapshotKey,
    { profile: SOURCE_PROFILE, batch, plan: planPayload },
  );
  return productSourceRepository.applyWithIntent(identity, requestId, intent, SOURCE_PROFILE, batch, planPayload);
}

async function applySnapshot(snapshotKey: string, requestId: string): Promise<{ message: string }> {
  const identity = await requireCatalogAdmin();
  const reconciled = await replayPreservedRequest(identity, requestId, snapshotKey);
  if (reconciled !== null) return { message: reconciled };
  const prepared = await loadSnapshotByKey(snapshotKey);
  const inputs = await loadPlanInputs(identity);
  const plan = buildPlanForSnapshot(prepared.snapshot, inputs);
  const adoptionSha256 = adoptionDigest(plan);
  const artifacts = await storeSnapshotEvidence(prepared.fileName);
  const batch = buildBatchPayload({
    snapshot: prepared.snapshot,
    plan,
    artifacts,
    adoptionSha256,
    retryOfBatchId: null,
  }) as unknown as SourceBatchInput;
  const receipt = await submitPrepared(identity, requestId, batch, toPlanPayload(plan));
  if (receipt.status === 'rejected_stale') return { message: '该快照早于最近成功批次，已拒绝，未覆盖新结果。' };
  if (receipt.status === 'duplicate') return { message: '该快照已经应用过，未重复建立商品或追加相同修订。' };
  return { message: `${receiptPrefix(receipt.status)}：${receiptSummary(receipt)}。` };
}

export async function applyProductSourceSnapshot(input: unknown): Promise<{ message: string }> {
  const parsed: ApplyProductSourceInput = applyProductSourceSchema.parse(input);
  return applySnapshot(parsed.snapshotKey, parsed.requestId);
}

/**
 * 恢复链：
 * - 已保留原请求（结果未知）：按原 requestId + 原 intent + 完整原载荷核对，不重新生成计划；
 * - 已知部分失败：只补做失败商品，成功商品不在计划中，因此不会重复修订。
 */
export async function retryProductSourceSnapshot(input: unknown): Promise<{ message: string }> {
  const parsed = retryProductSourceSchema.parse(input);
  const identity = await requireCatalogAdmin();
  const reconciled = await replayPreservedRequest(identity, parsed.requestId, parsed.snapshotKey);
  if (reconciled !== null) return { message: reconciled };

  const overview = await productSourceRepository.overview(identity, SOURCE_PROFILE_KEY);
  const latest = overview.latest;
  if (!latest || (latest.status !== 'partial' && latest.status !== 'failed')) {
    throw new Error('CATALOG_SOURCE_RETRY_NOT_APPLICABLE');
  }
  if (latest.snapshotKey !== parsed.snapshotKey) throw new Error('CATALOG_SOURCE_RETRY_NOT_APPLICABLE');
  const failedSourceKeys = overview.results
    .filter((result) => result.action === 'failed' && result.sourceKey !== 'batch')
    .map((result) => result.sourceKey);
  if (failedSourceKeys.length === 0) throw new Error('CATALOG_SOURCE_RETRY_NOTHING');

  const prepared = await loadSnapshotByKey(latest.snapshotKey);
  const inputs = await loadPlanInputs(identity);
  const plan = buildPlanForSnapshot(prepared.snapshot, inputs, failedSourceKeys);
  if (plan.decision !== 'apply' || plan.results.length === 0) {
    throw new Error('CATALOG_SOURCE_RETRY_NOTHING');
  }
  const adoptionSha256 = adoptionDigest(plan);
  const artifacts = await storeSnapshotEvidence(prepared.fileName);
  const batch = buildBatchPayload({
    snapshot: prepared.snapshot,
    plan,
    artifacts,
    adoptionSha256,
    retryOfBatchId: latest.batchId,
  }) as unknown as SourceBatchInput;
  const receipt = await submitPrepared(identity, parsed.requestId, batch, toPlanPayload(plan));
  const prefix = receipt.status === 'partial'
    ? '失败项补做后仍有待核对或失败项'
    : receipt.status === 'failed'
      ? '失败项补做未成功'
      : '失败项补做完成';
  return { message: `${prefix}：${receiptSummary(receipt)}；成功商品未重复修订。` };
}

function previewMessage(plan: ProductSourcePlan): string {
  if (!plan.decision || plan.decision !== 'apply') {
    if (plan.decision === 'replay') return '该快照已经应用过，无需重复应用。';
    if (plan.decision === 'rejected_stale') return '该快照早于最近成功批次，属于旧快照，不会覆盖新结果。';
    return `快照校验未通过：${plan.issues.map((issue) => issue.kind).join('、') || '无法应用'}`;
  }
  const counts = countRowsOf(plan.results);
  return `可应用：${summaryMessage(counts)}。`;
}

export async function refreshProductSourceSnapshot(input: unknown): Promise<{ message: string }> {
  const parsed = applyProductSourceSchema.pick({ requestId: true }).parse(input);
  void parsed;
  const localReader = reader();
  const summaries = await localReader.listSnapshots();
  if (!summaries.length) throw new Error('PRODUCT_SOURCE_SNAPSHOT_NOT_FOUND');
  const overview = await overviewRaw();
  const applied = new Set((overview?.batches ?? []).filter((batch) => batch.status === 'applied' || batch.status === 'partial').map((batch) => batch.snapshotKey));
  const candidate = [...summaries].reverse().find((summary) => !applied.has(summary.snapshotKey));
  if (!candidate) return { message: '当前没有待应用的新来源快照。' };
  const snapshot = await localReader.readSnapshot(candidate.snapshotKey);
  const validation = validateSnapshot(snapshot);
  if (!validation.ok) {
    return { message: `来源快照读取完成，但校验未通过：${validation.issues.map((issue) => issue.code).join('、')}；本批不会应用。` };
  }
  const identity = await requireCatalogAdmin();
  const inputs = await loadPlanInputs(identity);
  const plan = buildPlanForSnapshot(snapshot, inputs);
  return { message: `${captureSummaryOf(snapshot)}。${previewMessage(plan)}` };
}

export async function resolveProductSourceIssueById(input: unknown): Promise<{ message: string }> {
  const parsed: ResolveProductSourceIssueInput = resolveProductSourceIssueSchema.parse(input);
  const identity = await requireCatalogAdmin();
  await productSourceRepository.resolveIssue(identity, parsed.requestId, parsed.issueId, parsed.resolution, parsed.note);
  return { message: parsed.resolution === 'resolved' ? '待核对项已标记为已处理。' : '待核对项已忽略。' };
}

export async function assignSourceCodeToItem(input: unknown): Promise<{ message: string }> {
  const parsed: AssignProductSourceCodeInput = assignProductSourceCodeSchema.parse(input);
  const identity = await requireCatalogAdmin();
  await productSourceRepository.assignCode(identity, parsed.requestId, parsed.itemId, parsed.expectedRevision, parsed.code, parsed.reason, `product-source:${parsed.code}`);
  return { message: `已为原商品补录编号 ${parsed.code}（保留原商品身份）。` };
}

/** 超时后按原 requestId 核对真实回执；找不到就是找不到，不触发重发。 */
export async function checkProductSourceRequestOutcome(requestId: string): Promise<{ found: boolean; message: string }> {
  const identity = await requireCatalogAdmin();
  const receipt = await withAppDb(identity, async (client) => {
    const result = await client.query<{ result: ApplyReceipt }>(
      `SELECT result FROM catalog.product_source_request WHERE request_id=$1 AND actor_id=$2 AND action=$3`,
      [requestId, identity.profileUserId, PRODUCT_SOURCE_APPLY_ACTION],
    );
    return result.rows[0]?.result ?? null;
  });
  if (!receipt) {
    let preserved = false;
    try {
      preserved = (await productSourceRepository.readIntent(identity, requestId)) !== null;
    } catch {
      preserved = false;
    }
    return preserved
      ? { found: false, message: '已保留原请求及完整意图，但还没有查到成功回执；可继续按原请求核对，不要新建另一请求。' }
      : { found: false, message: '还没有查到该请求的成功回执；这不代表事务未提交，请保留原请求编号核对。' };
  }
  const counts = receipt.counts ?? emptyCounts();
  return { found: true, message: `已核对到原请求回执（${statusLabel(receipt.status)}）：${summaryMessage(counts)}。` };
}

/** 商品详情/来源视图使用：该商品当前来源绑定与最近一次处理结果。 */
export async function getProductSourceItemState(itemId: string) {
  const identity = await requireCatalogAdmin();
  const state = await productSourceRepository.itemState(identity, itemId);
  if (!state) return null;
  return {
    classificationLabel: state.latestResult ? classificationLabel(state.latestResult.classification) : null,
    reasonLabel: state.latestResult ? REASON_TEXT[state.latestResult.reasonCode as keyof typeof REASON_TEXT] ?? null : null,
    capturedAtDisplay: state.latestResult ? formatRecordedAtDisplay(state.latestResult.capturedAt) : null,
    originLabel: state.latestResult ? originLabel(state.latestResult.origin) : null,
    bindingState: state.binding ? (state.binding.state === 'active' ? '来源对应有效' : '本次未见') : null,
  };
}
