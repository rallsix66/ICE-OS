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
  FIELD_GROUPS,
  FIELD_INTERPRETATION_RULE_LABELS,
  SOURCE_FORMULA_ERROR,
  canonicalJson,
  isAdoptableFieldKey,
  isFieldInterpretationRule,
  type BuildPlanInput,
  type PlanAdoptionRow,
  type PlanAppliedSnapshot,
  type PlanBinding,
  type PlanBoundItem,
  type PlanCounts,
  type PlanDuplicateDecision,
  type PlanFieldDecision,
  type PlanFieldInterpretation,
  type ProductSourcePlan,
  type ProductSourcePlanResult,
  type SourceCell,
  type SourceRow,
  type SourceSnapshot,
} from './contract';
import { duplicateBasisSha256, rowBusinessSha256 } from './anomaly';
import { resolveHeaderMapping, validateSnapshot } from './headers';
import { buildRowFields, normalizeCellText, normalizeIdentityName } from './normalize';
import { buildPlan, toPlanPayload, buildBatchPayload } from './plan';
import { createLocalSnapshotReader } from './local-reader';
import { captureFeishuProductSource } from './feishu-capture';
import { readReaderStatus } from './reader-status';
import type { ProductSourceReader } from './reader';
import { productSourceRepository, PRODUCT_SOURCE_APPLY_ACTION, sourceIntent } from './repository';
import {
  applyProductSourceSchema,
  assignProductSourceCodeSchema,
  decideDuplicateSourceRowSchema,
  deferProductSourceFieldSchema,
  overrideProductSourceFieldSchema,
  resolveProductSourceIssueSchema,
  restoreDuplicateSourceDecisionSchema,
  restoreProductSourceFieldDecisionSchema,
  retryProductSourceSchema,
  type ApplyProductSourceInput,
  type AssignProductSourceCodeInput,
  type DecideDuplicateSourceRowInput,
  type DeferProductSourceFieldInput,
  type OverrideProductSourceFieldInput,
  type ResolveProductSourceIssueInput,
  type RestoreDuplicateSourceDecisionInput,
  type RestoreProductSourceFieldDecisionInput,
} from './schema';
import type {
  ApplyReceipt,
  SourceBatchInput,
  SourceDuplicateDecisionRecord,
  SourceFieldDecisionRecord,
  SourceIssueDecisionContext,
  SourceIssueRecord,
  SourceIssueRowContext,
  SourceManualDecisionsRaw,
  SourceOverviewRaw,
  SourceProfileInput,
} from './server-types';
import type { ProductSourceCountsDto, ProductSourcePanelDto } from './panel-types';
import type { CatalogFormulaErrorGroup, CatalogFormulaErrorRow } from '../issues/types';

/** 文件来源固定身份：用户确认的文档/工作表事实 + 真实飞书开放接口只读采集。 */
export const SOURCE_PROFILE: SourceProfileInput = {
  profileKey: SOURCE_PROFILE_KEY,
  documentKey: 'wiki:TC2AwLgRniqWKhkg9D2cEx79n0b',
  spreadsheetToken: 'EMZGs2eIhh0YQ1tPIqMcR8SPnQh',
  sheetId: '33bab4',
  sheetName: 'Sheet1',
  displayName: 'ICE产品库',
  sourceUrl: 'https://ygr1tb7cyf.feishu.cn/wiki/TC2AwLgRniqWKhkg9D2cEx79n0b',
  acquisitionMode: 'feishu_api',
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
  fieldDecisions: PlanFieldDecision[];
  fieldInterpretations: PlanFieldInterpretation[];
  duplicateDecisions: PlanDuplicateDecision[];
}

/**
 * 036 人工决定读取失败的可降级错误：
 * - 42P01/42703/42883：迁移尚未应用（表/列/函数不存在）；
 * - 42501：036 已应用但新表尚未授权给 app runner（DB 侧待补 GRANT）。
 * 这些情况下返回空决定，保证来源面板/读取/预览仍可用；其他错误照常抛出。
 */
function isReviewFlowUnavailable(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : '';
  return code === '42P01' || code === '42703' || code === '42883' || code === '42501';
}

/**
 * 读取当前生效的人工决定（暂不处理 / 人工口径 / 按来源列解释 + 同号多行选择）。
 *
 * 每项单独事务：迁移未应用/授权缺失时不会拖垮整条读取链。
 */
async function loadActivePlanDecisions(
  identity: { profileUserId: string },
): Promise<Pick<PlanInputs, 'fieldDecisions' | 'fieldInterpretations' | 'duplicateDecisions'>> {
  const field = await (async (): Promise<{
    fieldDecisions: PlanFieldDecision[];
    fieldInterpretations: PlanFieldInterpretation[];
  }> => {
    try {
      return await withAppDb(identity, async (client) => {
        const result = await client.query<{
          item_id: string;
          field_key: string;
          action: string;
          value_raw: string | null;
          rule: string | null;
        }>(
          // to_jsonb avoids a hard dependency on the `rule` column before the
          // 036 follow-up migration is applied; it reads null in that case.
          `SELECT d.item_id, d.field_key, d.action, d.value_raw, to_jsonb(d)->>'rule' AS rule
           FROM catalog.product_source_field_decision d
           JOIN catalog.product_source_profile p ON p.id = d.profile_id
           WHERE p.profile_key = $1 AND d.state = 'active'`,
          [SOURCE_PROFILE_KEY],
        );
        const fieldDecisions: PlanFieldDecision[] = [];
        const fieldInterpretations: PlanFieldInterpretation[] = [];
        for (const row of result.rows) {
          if (!isAdoptableFieldKey(row.field_key)) continue;
          if (row.action === 'defer') {
            fieldDecisions.push({ itemId: row.item_id, fieldKey: row.field_key, action: 'defer', valueRaw: null });
          } else if (row.action === 'override') {
            fieldDecisions.push({ itemId: row.item_id, fieldKey: row.field_key, action: 'override', valueRaw: row.value_raw });
          } else if (row.action === 'interpret' && row.rule !== null && isFieldInterpretationRule(row.rule)) {
            fieldInterpretations.push({ itemId: row.item_id, fieldKey: row.field_key, rule: row.rule });
          }
        }
        return { fieldDecisions, fieldInterpretations };
      });
    } catch (error) {
      if (!isReviewFlowUnavailable(error)) throw error;
      return { fieldDecisions: [], fieldInterpretations: [] };
    }
  })();
  const duplicateDecisions = await (async (): Promise<PlanDuplicateDecision[]> => {
    try {
      return await withAppDb(identity, async (client) => {
        const result = await client.query<{ ice_code: string; chosen_row_sha256: string; basis_sha256: string }>(
          `SELECT d.ice_code, d.chosen_row_sha256, d.basis_sha256
           FROM catalog.product_source_duplicate_decision d
           JOIN catalog.product_source_profile p ON p.id = d.profile_id
           WHERE p.profile_key = $1 AND d.state = 'active'`,
          [SOURCE_PROFILE_KEY],
        );
        return result.rows.map((row) => ({
          iceCode: row.ice_code,
          chosenRowSha256: row.chosen_row_sha256,
          basisSha256: row.basis_sha256,
        }));
      });
    } catch (error) {
      if (!isReviewFlowUnavailable(error)) throw error;
      return [];
    }
  })();
  return { ...field, duplicateDecisions };
}

/** 读取计划所需的库内事实（只读；不涉及价格）。 */
async function loadPlanInputs(identity: { profileUserId: string }): Promise<PlanInputs> {
  const facts = await withAppDb(identity, async (client) => {
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
  return { ...facts, ...(await loadActivePlanDecisions(identity)) };
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
    { file: path.join(root, `${base}.capture.json`), role: 'raw_capture', format: 'json' },
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
    const stored = await storePrivateArtifact(`product-source/${base}-${candidate.role}.${candidate.format}`, bytes);
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
  const imageCount = snapshot.rows.filter((row) => row.fields.imageRef?.state === 'observed').length;
  return `表头校验通过（${headerCount} 列） · 有效业务行 ${snapshot.collection.businessRowCount} 行 · 来源编号 ${codeCount} 个`
    + (imageCount > 0 ? ` · 图片引用 ${imageCount} 张（仅证据，不写商品）` : '');
}

function captureCountsText(counts: { businessRows: number; uniqueCodes: number; imageCells: number; priceCells: number } | null): string {
  if (!counts) return '来源读取完成';
  return `有效业务行 ${counts.businessRows} 行 · 唯一编号 ${counts.uniqueCodes} 个 · 图片引用 ${counts.imageCells} 张 · 价格列 ${counts.priceCells} 个（仅受限证据）`;
}

function captureErrorLabel(code: string | null): string {
  switch (code) {
    case 'FEISHU_CLI_MISSING':
      return '本机未找到可用的 lark-cli（需已安装并授权）';
    case 'FEISHU_CLI_TIMEOUT':
      return '飞书读取超时（网络或接口响应慢）';
    case 'FEISHU_CLI_BAD_JSON':
    case 'FEISHU_CLI_FAILED':
      return '飞书接口读取失败（授权、权限或网络异常）';
    case 'FEISHU_DOC_INVALID':
      return '文档节点不是电子表格或 token 与登记不一致';
    case 'FEISHU_SHEET_MISSING':
      return '未找到登记的工作表 Sheet1（工作表可能已删除或改名）';
    case 'FEISHU_HEADER_INVALID':
      return '表头与 27 个已知表头不一致（列被改名/增删）';
    case 'FEISHU_GRID_INVALID':
    case 'FEISHU_READ_INCOMPLETE':
      return '读取范围不完整（行数/列数与工作表网格不一致）';
    case 'FEISHU_EMPTY_PAYLOAD':
      return '来源没有有效业务行';
    default:
      return '飞书来源读取失败';
  }
}

function readerResultLabel(result: string | null): string | null {
  if (result === 'captured') return '成功读取（生成新快照）';
  if (result === 'unchanged') return '成功读取（内容未变化）';
  if (result === 'failed') return '读取失败';
  return null;
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
  if (kind === 'missing_code_candidate') {
    const matchedItemName = typeof detail.matchedItemName === 'string' && detail.matchedItemName.trim()
      ? detail.matchedItemName
      : null;
    const sourceCode = typeof detail.sourceCode === 'string' && detail.sourceCode.trim() ? detail.sourceCode : null;
    if (matchedItemName) {
      const spaceNote = detail.matchedBy === 'normalizedName' ? '（仅空格不同）' : '';
      return `来源货号 ${sourceCode ?? '（未知）'} 与现有商品「${matchedItemName}」名称一致${spaceNote}；请人工确认是否为同一商品，未确认前不建档、不自动绑定`;
    }
    return '来源缺码行与现有缺码商品名称相近；请人工核对补号';
  }
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
    classificationLabel: classificationLabel(result.missing ? 'missing' : classificationOf(result.action)),
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

function reviewStateLabel(state: string): string {
  if (state === 'open') return '待核对';
  if (state === 'resolved') return '已处理';
  if (state === 'ignored') return '已忽略';
  if (state === 'superseded') return '已由新批次替代';
  return '状态未标注';
}

function issueSourceLabel(iceCode: string | null, rows: readonly number[], pendingCode: boolean): string {
  if (iceCode) return iceCode;
  if (rows.length) return `来源第 ${rows.join('、')} 行`;
  if (pendingCode) return '货号待确认';
  return '批次校验';
}

/** 036 的 overview 事项行号在 detail.rows（旧投影）或 detail.rowNumbers（新投影）中。 */
function issueRowNumbers(issue: SourceIssueRecord): number[] {
  if (issue.rows.length) return issue.rows;
  for (const key of ['rows', 'rowNumbers'] as const) {
    const value = issue.detail?.[key];
    if (!Array.isArray(value)) continue;
    const rows = value.filter((entry): entry is number => typeof entry === 'number');
    if (rows.length) return rows;
  }
  return [];
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** 同号多行的逐字段差异（detail.fields 由计划层生成；页面只展示中文标签与来源原值）。 */
function duplicateFieldsOf(issue: SourceIssueRecord): NonNullable<ProductSourcePanelDto['issues'][number]['duplicate']>['fields'] {
  const raw = issue.detail?.fields;
  if (!Array.isArray(raw)) return [];
  const fields: NonNullable<ProductSourcePanelDto['issues'][number]['duplicate']>['fields'] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const fieldKey = stringOrNull(record.fieldKey);
    if (!fieldKey) continue;
    const rawValues = Array.isArray(record.values) ? record.values : [];
    const values: Array<{ rowNumber: number; value: string; empty: boolean }> = [];
    for (const value of rawValues) {
      if (!value || typeof value !== 'object') continue;
      const item = value as Record<string, unknown>;
      if (typeof item.rowNumber !== 'number') continue;
      const rawValue = item.raw;
      values.push({
        rowNumber: item.rowNumber,
        value: typeof rawValue === 'string' ? rawValue : '',
        empty: typeof rawValue !== 'string' || rawValue.trim() === '',
      });
    }
    fields.push({ fieldKey, fieldLabel: fieldLabel(fieldKey), values });
  }
  return fields;
}

/** 已选来源行的业务字段（chosen_fields 是 fieldKey → SourceCell；排除图片引用与空值）。 */
function cellFieldValues(chosenFields: Record<string, unknown>): Array<{ fieldLabel: string; value: string }> {
  const values: Array<{ fieldLabel: string; value: string }> = [];
  for (const [fieldKey, cell] of Object.entries(chosenFields ?? {})) {
    if (fieldKey === 'imageRef') continue;
    const raw = cell && typeof cell === 'object' && typeof (cell as { raw?: unknown }).raw === 'string'
      ? (cell as { raw: string }).raw
      : '';
    if (!raw.trim()) continue;
    values.push({ fieldLabel: fieldLabel(fieldKey), value: raw });
  }
  return values;
}

/**
 * 历史批次的 chosen_fields 可能为空（写入时尚未归档行字段），
 * 此时用决定里保存的 comparison.fields 中该被选行的值兜底展示。
 */
function comparisonFieldValues(decision: SourceDuplicateDecisionRecord): Array<{ fieldLabel: string; value: string }> {
  if (decision.chosenRowNumber === null) return [];
  const raw = decision.comparison?.fields;
  if (!Array.isArray(raw)) return [];
  const values: Array<{ fieldLabel: string; value: string }> = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const fieldKey = stringOrNull(record.fieldKey);
    if (!fieldKey || fieldKey === 'imageRef') continue;
    const rowValues = Array.isArray(record.values) ? record.values : [];
    const match = rowValues.find((value) => value && typeof value === 'object'
      && (value as Record<string, unknown>).rowNumber === decision.chosenRowNumber);
    if (!match) continue;
    const rawValue = (match as Record<string, unknown>).raw;
    if (typeof rawValue !== 'string' || !rawValue.trim()) continue;
    values.push({ fieldLabel: fieldLabel(fieldKey), value: rawValue });
  }
  return values;
}

function chosenFieldValues(decision: SourceDuplicateDecisionRecord): Array<{ fieldLabel: string; value: string }> {
  const direct = cellFieldValues(decision.chosenFields);
  return direct.length > 0 ? direct : comparisonFieldValues(decision);
}

function decisionActionLabel(action: SourceFieldDecisionRecord['action']): string {
  if (action === 'defer') return '暂不处理';
  if (action === 'interpret') return '按来源列解释';
  return '人工口径';
}

function decisionRuleLabel(rule: string | null | undefined): string | null {
  if (!rule || !isFieldInterpretationRule(rule)) return null;
  return FIELD_INTERPRETATION_RULE_LABELS[rule];
}

function mapManualDecisions(raw: SourceManualDecisionsRaw): ProductSourcePanelDto['manualDecisions'] {
  return {
    fieldDecisions: raw.fieldDecisions.map((decision: SourceFieldDecisionRecord) => ({
      decisionId: decision.decisionId,
      itemId: decision.itemId,
      iceCode: decision.iceCode,
      nameCn: decision.nameCn,
      fieldKey: decision.fieldKey,
      fieldLabel: fieldLabel(decision.fieldKey),
      action: decision.action,
      actionLabel: decisionActionLabel(decision.action),
      rule: decision.rule ?? null,
      ruleLabel: decisionRuleLabel(decision.rule),
      valueRaw: decision.valueRaw,
      reason: decision.reason,
      note: decision.note,
      decidedAtDisplay: formatRecordedAtDisplay(decision.decidedAt),
    })),
    duplicateDecisions: raw.duplicateDecisions.map((decision: SourceDuplicateDecisionRecord) => ({
      decisionId: decision.decisionId,
      iceCode: decision.iceCode,
      nameCn: decision.nameCn,
      chosenRowNumber: decision.chosenRowNumber,
      decidedAtDisplay: formatRecordedAtDisplay(decision.decidedAt),
      note: decision.note,
      chosenFields: chosenFieldValues(decision),
    })),
  };
}

/** 同一商品已有 item 级缺号待办时，不再重复显示同商品的 batch 级缺码候选事项。 */
function dedupePendingCodeIssues(issues: SourceIssueRecord[]): SourceIssueRecord[] {
  const itemLevelMissing = new Set(
    issues
      .filter((issue) => issue.scope === 'item' && issue.kind === 'missing_code' && issue.itemId)
      .map((issue) => issue.itemId as string),
  );
  return issues.filter((issue) => !(
    issue.scope === 'batch'
    && issue.kind === 'missing_code_candidate'
    && issue.itemId !== null
    && itemLevelMissing.has(issue.itemId)
  ));
}

function mapIssues(
  issues: SourceIssueRecord[],
  manual: SourceManualDecisionsRaw,
  pendingCodeCandidates: Map<string, PendingSourceCodeCandidate>,
): ProductSourcePanelDto['issues'] {
  return issues.map((issue) => {
    const detail = issue.detail ?? {};
    const pendingCode = detail.pendingCode === true;
    const pendingCandidate = issue.itemId ? (pendingCodeCandidates.get(issue.itemId) ?? null) : null;
    const pendingCodeCandidate = pendingCandidate
      && (pendingCode || issue.kind === 'missing_code' || issue.kind === 'missing_code_candidate')
      ? pendingCandidate
      : null;
    const fieldKey = stringOrNull(detail.fieldKey);
    const rows = issueRowNumbers(issue);
    const duplicate: ProductSourcePanelDto['issues'][number]['duplicate'] =
      issue.kind === 'duplicate_code_inconsistent'
        ? {
          decisionStale: detail.decisionStale === true,
          fields: duplicateFieldsOf(issue),
          savedChoice: (() => {
            const saved = issue.iceCode
              ? manual.duplicateDecisions.find((decision) => decision.iceCode === issue.iceCode)
              : undefined;
            if (!saved) return null;
            return {
              chosenRowNumber: saved.chosenRowNumber,
              decidedAtDisplay: formatRecordedAtDisplay(saved.decidedAt),
              note: saved.note,
            };
          })(),
        }
        : null;
    const candidate: ProductSourcePanelDto['issues'][number]['candidate'] =
      issue.kind === 'missing_code_candidate'
        && (stringOrNull(detail.matchedItemId) !== null || stringOrNull(detail.matchedItemName) !== null)
        ? {
          itemId: stringOrNull(detail.matchedItemId),
          itemName: stringOrNull(detail.matchedItemName),
          itemCode: stringOrNull(detail.matchedItemCode),
          sourceCode: stringOrNull(detail.sourceCode),
          matchedBy: stringOrNull(detail.matchedBy),
          nameNormalized: detail.matchedBy === 'normalizedName',
        }
        : null;
    return {
      issueKey: issue.issueKey,
      sourceKeyLabel: issueSourceLabel(issue.iceCode, rows, pendingCode),
      iceCode: issue.iceCode,
      nameCn: issue.nameCn,
      kind: issue.kind,
      kindLabel: pendingCodeCandidate ? '货号待确认' : (ISSUE_KIND_LABELS[issue.kind as keyof typeof ISSUE_KIND_LABELS] ?? '待核对'),
      detailLabel: issueDetailLabel(issue.kind, detail),
      reviewState: issue.reviewState,
      reviewStateLabel: reviewStateLabel(issue.reviewState),
      rows,
      itemId: issue.itemId ?? null,
      itemRevision: issue.itemRevision ?? null,
      fieldKey,
      fieldLabel: fieldKey ? fieldLabel(fieldKey) : null,
      rawValue: stringOrNull(detail.raw),
      pendingCode,
      candidate,
      pendingCodeCandidate: pendingCodeCandidate
        ? {
          sourceCode: pendingCodeCandidate.sourceCode,
          matchedItemName: pendingCodeCandidate.matchedItemName,
          matchedBy: pendingCodeCandidate.matchedBy,
          rowNumbers: pendingCodeCandidate.rowNumbers,
          capturedAtDisplay: pendingCodeCandidate.capturedAtDisplay,
        }
        : null,
      duplicate,
    };
  });
}

/** 已登记决定只读取当前生效项；036 未迁移/未授权时面板主体照常可用。 */
async function loadPanelManualDecisions(identity: { profileUserId: string }): Promise<SourceManualDecisionsRaw> {
  try {
    return await productSourceRepository.manualDecisions(identity, SOURCE_PROFILE_KEY);
  } catch (error) {
    if (!isReviewFlowUnavailable(error)) throw error;
    return { fieldDecisions: [], duplicateDecisions: [] };
  }
}

/** 最新待应用快照 + 同一份真实计划（页面「本次更新」与「确认更新」共用这一份）。 */
interface PendingSnapshotPlan {
  snapshotKey: string;
  capturedAt: string;
  origin: 'real_capture' | 'local_simulation';
  captureSummary: string;
  plan: ProductSourcePlan | null;
  planError: string | null;
}

/** 最新待应用快照已读到的候选正式货号（只读；不写库、不要求先采用整批）。 */
export interface PendingSourceCodeCandidate {
  itemId: string;
  sourceCode: string;
  matchedItemName: string | null;
  matchedBy: string | null;
  rowNumbers: number[];
  capturedAtDisplay: string;
}

/**
 * 找到最新待应用快照，并按现有计划生成逻辑在内存中生成计划。
 * 只读：不写数据库、不应用批次；校验/生成失败只降级「本次更新」，不影响来源面板其它部分。
 */
async function loadPendingSnapshotPlan(): Promise<PendingSnapshotPlan | null> {
  const localReader = reader();
  const snapshots = await localReader.listSnapshots();
  if (!snapshots.length) return null;
  const overview = await overviewRaw();
  const applied = new Set((overview?.batches ?? [])
    .filter((batch) => batch.status === 'applied' || batch.status === 'partial')
    .map((batch) => batch.snapshotKey));
  const candidate = [...snapshots].reverse().find((snapshot) => !applied.has(snapshot.snapshotKey));
  if (!candidate) return null;
  const snapshot = await localReader.readSnapshot(candidate.snapshotKey);
  const validation = validateSnapshot(snapshot);
  const base = {
    snapshotKey: candidate.snapshotKey,
    capturedAt: candidate.capturedAt,
    origin: candidate.origin,
    captureSummary: validation.ok
      ? captureSummaryOf(snapshot)
      : `快照校验未通过：${validation.issues.map((issue) => issue.code).join('、')}`,
  };
  if (!validation.ok) {
    return { ...base, plan: null, planError: '来源快照校验未通过，本批不能生成更新计划。' };
  }
  try {
    const identity = await requireCatalogAdmin();
    const inputs = await loadPlanInputs(identity);
    return { ...base, plan: buildPlanForSnapshot(snapshot, inputs), planError: null };
  } catch (error) {
    return {
      ...base,
      plan: null,
      planError: error instanceof Error ? `生成更新计划失败：${error.message}` : '生成更新计划失败。',
    };
  }
}

const REVIEW_NOTE_REASONS: Readonly<Record<string, string>> = {
  formula_error: '公式错误（#REF!）',
  unit_unconfirmed: '单位未确认',
  field_group_conflict: '字段组冲突',
  invalid_value: '字段值非法',
  invalid_carton_quantity: '装箱数量非法',
  field_conflict: '本地与来源同时修改',
};

function planIssueFieldLabel(issue: { kind: string; detail: Record<string, unknown> }): string {
  if (issue.kind === 'duplicate_code_inconsistent') return '商品条码';
  if (issue.kind === 'missing_code_candidate' || issue.kind === 'suspected_code_change') return '正式货号';
  const fieldKey = stringOrNull(issue.detail.fieldKey);
  if (fieldKey) return fieldLabel(fieldKey);
  const group = stringOrNull(issue.detail.group);
  if (group) {
    const fields = FIELD_GROUPS[group as keyof typeof FIELD_GROUPS];
    if (fields && fields.length > 0) return fields.map((key) => fieldLabel(key)).join('、');
  }
  return '来源字段';
}

/** 本批需核对项按「字段 + 原因」聚合；不把待采用资料中的异常与已登记待办数量相加。 */
function planReviewNotes(plan: ProductSourcePlan): NonNullable<ProductSourcePanelDto['preview']>['reviewNotes'] {
  const buckets = new Map<string, { fieldLabel: string; reasonLabel: string; count: number }>();
  for (const result of plan.results) {
    if (result.action !== 'needs_review') continue;
    for (const issue of result.issues) {
      const reasonLabel = REVIEW_NOTE_REASONS[issue.kind];
      if (!reasonLabel) continue;
      const fieldLabelText = planIssueFieldLabel(issue);
      const key = `${fieldLabelText}\u0000${reasonLabel}`;
      const existing = buckets.get(key);
      if (existing) existing.count += 1;
      else buckets.set(key, { fieldLabel: fieldLabelText, reasonLabel, count: 1 });
    }
  }
  return [...buckets.values()].sort((left, right) => right.count - left.count).slice(0, 6);
}

function buildPanelPreview(pendingPlan: PendingSnapshotPlan | null): ProductSourcePanelDto['preview'] {
  if (!pendingPlan) return null;
  const plan = pendingPlan.plan;
  const base = {
    snapshotToken: pendingPlan.snapshotKey,
    capturedAtDisplay: formatRecordedAtDisplay(pendingPlan.capturedAt),
    originLabel: originLabel(pendingPlan.origin),
    captureSummary: pendingPlan.captureSummary,
  };
  if (!plan || plan.decision !== 'apply') {
    return {
      ...base,
      counts: emptyCountsDto(emptyCounts()),
      changed: [],
      unchangedCount: 0,
      reviewCount: 0,
      reviewNotes: [],
      canApply: false,
      disabledReason: pendingPlan.planError ?? (plan?.decision === 'replay'
        ? '该快照已经应用过，无需重复应用。'
        : plan?.decision === 'rejected_stale'
          ? '该快照早于最近成功批次，不会覆盖新结果。'
          : '来源快照不能生成可应用的更新计划。'),
    };
  }
  const counts = countRowsOf(plan.results);
  return {
    ...base,
    counts: emptyCountsDto(counts),
    changed: plan.results
      .filter((result) => result.changes.length > 0)
      .map((result) => ({
        itemKey: result.sourceKey,
        itemId: result.itemId,
        iceCode: result.iceCode,
        nameCn: result.nameCn,
        changes: result.changes.map((change) => ({
          fieldLabel: fieldLabel(change.fieldKey),
          before: change.beforeRaw ?? '',
          after: change.afterRaw ?? '',
          unitLabel: unitLabelOf(change.fieldKey),
        })),
      })),
    unchangedCount: counts.unchanged,
    reviewCount: counts.needsReview,
    reviewNotes: planReviewNotes(plan),
    canApply: true,
    disabledReason: null,
  };
}

function pendingCodeCandidatesFromPlan(
  pendingPlan: PendingSnapshotPlan | null,
): Map<string, PendingSourceCodeCandidate> {
  const candidates = new Map<string, PendingSourceCodeCandidate>();
  const plan = pendingPlan?.plan;
  if (!pendingPlan || !plan) return candidates;
  for (const result of plan.results) {
    for (const issue of result.issues) {
      if (issue.kind !== 'missing_code_candidate') continue;
      const itemId = stringOrNull(issue.detail.matchedItemId) ?? result.itemId;
      const sourceCode = stringOrNull(issue.detail.sourceCode) ?? result.iceCode;
      if (!itemId || !sourceCode) continue;
      candidates.set(itemId, {
        itemId,
        sourceCode,
        matchedItemName: stringOrNull(issue.detail.matchedItemName) ?? result.nameCn,
        matchedBy: stringOrNull(issue.detail.matchedBy),
        rowNumbers: result.rowNumbers,
        capturedAtDisplay: formatRecordedAtDisplay(pendingPlan.capturedAt),
      });
    }
  }
  return candidates;
}

/**
 * 待处理/来源面板共用：把最新待应用快照里读到的候选正式货号接到原商品。
 * 只读；没有待应用快照、快照校验失败或计划失败时返回空映射。
 */
export async function readPendingSourceCodeCandidates(): Promise<Map<string, PendingSourceCodeCandidate>> {
  try {
    return pendingCodeCandidatesFromPlan(await loadPendingSnapshotPlan());
  } catch {
    return new Map();
  }
}

/* ------------------------------------------------------------------ *
 * 飞书原表「生产工厂」公式错误（合并一条待处理，只读）
 * ------------------------------------------------------------------ */

/** 公式错误明细的纯派生结果（含快照原始时间，便于单测；展示层再格式化时间）。 */
export interface FactoryFormulaErrorData {
  count: number;
  capturedAt: string;
  rows: CatalogFormulaErrorRow[];
}

/**
 * 纯函数：从来源快照中收集「生产工厂」列（E 列）的公式错误行。
 *
 * 只认既有分类结果：fields.factory.state==='parse_failed' 且 reason===SOURCE_FORMULA_ERROR；
 * cell 用行号拼成 E<rowNumber>，错误原文取 E 列原文（缺失时回退 factory.raw），
 * 货号/品名取 G/B 列原文；非业务行与其它字段错误不计入。没有错误返回 null。
 */
export function collectFactoryFormulaErrors(
  snapshot: Pick<SourceSnapshot, 'rows' | 'capturedAt'>,
): FactoryFormulaErrorData | null {
  const rows: CatalogFormulaErrorRow[] = [];
  for (const row of snapshot.rows) {
    if (!row.isBusinessRow) continue;
    const factory = row.fields?.factory;
    if (!factory || factory.state !== 'parse_failed' || factory.reason !== SOURCE_FORMULA_ERROR) continue;
    const error = (row.cells?.E ?? factory.raw ?? '').trim() || '#REF!';
    rows.push({
      iceCode: (row.cells?.G ?? '').trim() || null,
      nameCn: (row.cells?.B ?? '').trim() || null,
      cell: `E${row.rowNumber}`,
      error,
    });
  }
  if (rows.length === 0) return null;
  return { count: rows.length, capturedAt: snapshot.capturedAt, rows };
}

/** 最近一次成功读取快照里「生产工厂」公式错误的三种真实状态。 */
export type FactoryFormulaErrorReadState =
  | { state: 'errors'; group: CatalogFormulaErrorGroup }
  /** 成功读到快照，且生产工厂列一个公式错误都没有。 */
  | { state: 'clean'; capturedAtDisplay: string }
  /** 没有完整快照 / 快照不完整 / 读取异常：不是“读到 0 个错误”。 */
  | { state: 'unavailable' };

/**
 * 读取最近一次成功读取的飞书原表快照里「生产工厂」公式错误状态。
 *
 * - 只读本地快照：listSnapshots 已按 capturedAt 升序，取最新一份完整快照（不是待应用计划）；
 * - 完整快照但没有公式错误 → `clean`（区分“读到 0 个错误”）；
 * - 没有完整快照 / 读取失败 → `unavailable`（调用方不得显示“已修好”）；
 * - 只投影货号、品名、单元格与错误原文，不包含价格等受限列。
 */
export async function readFactoryFormulaErrorState(): Promise<FactoryFormulaErrorReadState> {
  try {
    const localReader = reader();
    const summaries = await localReader.listSnapshots();
    const latest = [...summaries]
      .reverse()
      .find((summary) => summary.complete !== false);
    if (!latest) return { state: 'unavailable' };
    const snapshot = await localReader.readSnapshot(latest.snapshotKey);
    if (snapshot.collection.complete !== true || snapshot.collection.readError) {
      return { state: 'unavailable' };
    }
    const data = collectFactoryFormulaErrors(snapshot);
    if (!data) {
      return { state: 'clean', capturedAtDisplay: formatRecordedAtDisplay(snapshot.capturedAt) };
    }
    return {
      state: 'errors',
      group: {
        count: data.count,
        capturedAtDisplay: formatRecordedAtDisplay(data.capturedAt),
        rows: data.rows,
      },
    };
  } catch {
    return { state: 'unavailable' };
  }
}

/**
 * 兼容既有调用：只返回“仍有公式错误”的分组；读到 0 个或没读到快照都为 null。
 * 新代码请直接用 `readFactoryFormulaErrorState`，避免把“没读到快照”当成“已修好”。
 */
export async function readFactoryFormulaErrorGroup(): Promise<CatalogFormulaErrorGroup | null> {
  const state = await readFactoryFormulaErrorState();
  return state.state === 'errors' ? state.group : null;
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
  let pendingPlan: PendingSnapshotPlan | null = null;
  let pendingError: string | null = null;
  try {
    pendingPlan = await loadPendingSnapshotPlan();
    if (pendingPlan) {
      pending = {
        snapshotToken: pendingPlan.snapshotKey,
        capturedAtDisplay: formatRecordedAtDisplay(pendingPlan.capturedAt),
        originLabel: originLabel(pendingPlan.origin),
        captureSummary: pendingPlan.captureSummary,
      };
    }
  } catch (error) {
    pendingError = error instanceof Error ? error.message : '读取失败';
  }
  const latestCollection = latest?.collection as { headers?: Record<string, string>; businessRowCount?: number } | undefined;
  const latestCaptureSummary = latest && latestCollection
    ? `表头校验通过（${Object.values(latestCollection.headers ?? {}).filter((value) => value.trim().length > 0).length} 列） · 有效业务行 ${latestCollection.businessRowCount ?? 0} 行 · 来源编号 ${overview.bindingCount} 个`
    : null;
  const openIssues = dedupePendingCodeIssues(overview.issues.filter((issue) => issue.reviewState === 'open'));
  const manualDecisionsRaw = await loadPanelManualDecisions(identity);
  const manualDecisions = mapManualDecisions(manualDecisionsRaw);
  const pendingCodeCandidates = pendingCodeCandidatesFromPlan(pendingPlan);
  const simulation = Boolean(latest?.origin === 'local_simulation' || pending?.originLabel.includes('模拟'));
  /** 已采用 = 最近一次真正写入商品资料的批次（applied/partial）；与“已读取”分开。 */
  const appliedBatch = overview.batches.find((batch) => batch.status === 'applied' || batch.status === 'partial') ?? null;
  const readerStatus = (() => {
    try {
      return readReaderStatus(sourceRoot());
    } catch {
      // 状态文件缺失/目录不可读不影响来源面板主体：明确返回 null，不补造“运行中”。
      return null;
    }
  })();
  return {
    source: {
      profileKey: overview.source.profileKey,
      displayName: overview.source.displayName,
      documentLabel: `飞书云文档 · ${overview.source.sheetName}`,
      sheetName: overview.source.sheetName,
      mode: 'feishu_api',
      modeLabel: '飞书真实读取（只读）',
      simulation,
    },
    schedule: readerStatus
      ? {
        running: readerStatus.worker?.running === true,
        runningLabel: readerStatus.worker?.running === true ? '定时读取运行中' : '定时读取未运行',
        intervalMinutes: readerStatus.intervalMinutes,
        lastResultLabel: readerResultLabel(readerStatus.lastResult),
        lastRunAtDisplay: readerStatus.lastRunAt ? formatRecordedAtDisplay(readerStatus.lastRunAt) : null,
        nextRunAtDisplay: readerStatus.nextRunAt ? formatRecordedAtDisplay(readerStatus.nextRunAt) : null,
        errorLabel: readerStatus.errorCode ? captureErrorLabel(readerStatus.errorCode) : null,
      }
      : null,
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
    issues: mapIssues(openIssues, manualDecisionsRaw, pendingCodeCandidates),
    preview: buildPanelPreview(pendingPlan),
    manualDecisions,
    batchHistory: overview.batches.map((batch, index) => ({
      batchIdLabel: `第 ${index + 1} 批`,
      capturedAtDisplay: formatRecordedAtDisplay(batch.capturedAt),
      originLabel: originLabel(batch.origin),
      statusLabel: statusLabel(batch.status),
      countsSummary: summaryMessage(batch.counts),
    })),
    actions: {
      canApply: Boolean(pending),
      // 只有真正存在 failed 项才提供“补做失败商品”；partial 仅因待核对时不应给出会报“没有可补做”的按钮。
      canRetry: Boolean(latest && (latest.status === 'failed' || (latest.status === 'partial' && latest.counts.failed > 0))),
      canResolveIssues: openIssues.length > 0,
      canRead: true,
      disabledReason: pending
        ? null
        : pendingError
          ? `读取来源快照失败：${pendingError}`
          : '当前没有待应用的新来源快照。',
    },
    pending,
    read: {
      lastReadAtDisplay: readerStatus?.lastRunAt
        ? formatRecordedAtDisplay(readerStatus.lastRunAt)
        : latest
          ? formatRecordedAtDisplay(latest.capturedAt)
          : null,
      lastResultLabel: readerResultLabel(readerStatus?.lastResult ?? null),
      pendingAtDisplay: pending?.capturedAtDisplay ?? null,
    },
    applied: appliedBatch
      ? {
        capturedAtDisplay: formatRecordedAtDisplay(appliedBatch.capturedAt),
        statusLabel: statusLabel(appliedBatch.status),
        countsSummary: summaryMessage(appliedBatch.counts),
        counts: emptyCountsDto(appliedBatch.counts),
      }
      : null,
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
    fieldDecisions: inputs.fieldDecisions,
    fieldInterpretations: inputs.fieldInterpretations,
    duplicateDecisions: inputs.duplicateDecisions,
  } satisfies BuildPlanInput);
}

function receiptSummary(receipt: ApplyReceipt): string {
  const counts = receipt.counts ?? emptyCounts();
  return summaryMessage(counts);
}

/**
 * 带 counts 的回执说明：只解释状态，不再内嵌任何数字。
 * 真实数量统一由页面用 counts + writtenItems + writtenNeedsReview 渲染一套。
 */
function receiptExplanation(status: ApplyReceipt['status']): string {
  if (status === 'applied') return '本批处理完成；以下为该批的实际回执。';
  if (status === 'failed') return '本批未改商品资料；以下为该批的实际回执。';
  if (status === 'partial') return '本批部分完成；以下为该批的实际回执。';
  return '以下为该批的实际回执。';
}

/** 读取数据库回执里的计数；字段缺失/不是有限数字时返回 null，页面不得把缺失补成 0。 */
function receiptCounts(receipt: ApplyReceipt | null | undefined): PlanCounts | null {
  const raw = receipt?.counts as Partial<PlanCounts> | null | undefined;
  if (!raw || typeof raw !== 'object') return null;
  const keys: Array<keyof PlanCounts> = ['created', 'updated', 'unchanged', 'needsReview', 'failed', 'missing'];
  if (keys.some((key) => typeof raw[key] !== 'number' || !Number.isFinite(raw[key]))) return null;
  return {
    created: Number(raw.created),
    updated: Number(raw.updated),
    unchanged: Number(raw.unchanged),
    needsReview: Number(raw.needsReview),
    failed: Number(raw.failed),
    missing: Number(raw.missing),
  };
}

/**
 * 实际写入商品数：读取回执每条结果的 action/itemRevision。
 * `needs_review` 但已产生修订（部分字段已写入）也算实际写入；回执没有结果明细时返回 null。
 */
function receiptWrittenItems(receipt: ApplyReceipt | null | undefined): number | null {
  if (!receipt || !Array.isArray(receipt.results)) return null;
  let written = 0;
  for (const result of receipt.results) {
    if (result.action === 'create' || result.action === 'update') {
      written += 1;
      continue;
    }
    if (result.action === 'needs_review' && typeof result.itemRevision === 'number' && result.itemRevision > 0) {
      written += 1;
    }
  }
  return written;
}

/**
 * 实际写入中仍为 needs_review 的条数（与 receiptWrittenItems 同源）；
 * 回执没有结果明细时返回 null。
 */
function receiptWrittenNeedsReview(receipt: ApplyReceipt | null | undefined): number | null {
  if (!receipt || !Array.isArray(receipt.results)) return null;
  let writtenNeedsReview = 0;
  for (const result of receipt.results) {
    if (result.action === 'needs_review' && typeof result.itemRevision === 'number' && result.itemRevision > 0) {
      writtenNeedsReview += 1;
    }
  }
  return writtenNeedsReview;
}

/** 回执结果 → 页面需要的真实数量；缺少计数时 counts=null（页面只显示结果说明）。 */
function receiptResult(
  receipt: ApplyReceipt,
  status: ApplyProductSourceReceiptStatus,
  message: string,
): ApplyProductSourceSnapshotResult {
  return {
    message,
    status,
    // 原请求核对（status='reconciled'）时仍保留数据库回执自己的状态，
    // 页面据此显示「已确认的变更已写入，待核对字段保留原值」等真实结果。
    receiptStatus: receipt.status,
    counts: receiptCounts(receipt),
    writtenItems: receiptWrittenItems(receipt),
    writtenNeedsReview: receiptWrittenNeedsReview(receipt),
  };
}

/** 已保留原请求及完整意图：按原 requestId + 原 intent + 原载荷核对，绝不重新生成计划。 */
async function replayPreservedRequest(
  identity: Awaited<ReturnType<typeof requireCatalogAdmin>>,
  requestId: string,
  snapshotKey: string,
): Promise<ApplyProductSourceSnapshotResult | null> {
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
    if (receipt.status === 'rejected_stale') {
      return { message: '原请求回执为旧快照已拒绝；未覆盖新结果。', status: 'rejected_stale', counts: null, writtenItems: null, writtenNeedsReview: null };
    }
    return receiptResult(receipt, 'reconciled', '已核对到原请求回执；未重复修订。');
  }
  const receipt = await productSourceRepository.receiptByRequest(identity, requestId, PRODUCT_SOURCE_APPLY_ACTION);
  if (receipt) {
    if (receipt.status === 'rejected_stale') {
      return { message: '原请求回执为旧快照已拒绝；未覆盖新结果。', status: 'rejected_stale', counts: null, writtenItems: null, writtenNeedsReview: null };
    }
    return receiptResult(receipt, 'reconciled', '已核对到原请求回执；未重复修订。');
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

export type ApplyProductSourceReceiptStatus =
  | 'applied'
  | 'partial'
  | 'failed'
  | 'rejected_stale'
  | 'duplicate'
  | 'reconciled';

export interface ApplyProductSourceSnapshotResult {
  message: string;
  /** 数据库实际回执状态（reconciled = 按原请求核对到回执）；页面据此显示真实结果而非预览。 */
  status?: ApplyProductSourceReceiptStatus;
  /** 数据库回执自己的状态（核对原请求时 status='reconciled'，这里仍是 partial/applied…）。 */
  receiptStatus?: ApplyProductSourceReceiptStatus;
  /** 数据库中该批次的计数；回执缺少数量时为 null，页面不得补成 0。 */
  counts?: PlanCounts | null;
  /** 本次实际写入字段的商品数（含部分采用但已产生修订的商品）；回执无结果明细时为 null。 */
  writtenItems?: number | null;
  /** 实际写入中仍为 needs_review 的条数（与 writtenItems 同源）；回执无结果明细时为 null。 */
  writtenNeedsReview?: number | null;
}

async function applySnapshot(snapshotKey: string, requestId: string): Promise<ApplyProductSourceSnapshotResult> {
  const identity = await requireCatalogAdmin();
  const reconciled = await replayPreservedRequest(identity, requestId, snapshotKey);
  if (reconciled !== null) return reconciled;
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
  if (receipt.status === 'rejected_stale') {
    // 旧快照：回执计数全是 0，但不代表“更新完成 0 款”，页面只显示拒绝说明。
    return { message: '该快照早于最近成功批次，已拒绝，未覆盖新结果。', status: 'rejected_stale', counts: null, writtenItems: null, writtenNeedsReview: null };
  }
  if (receipt.status === 'duplicate') {
    return receiptResult(
      receipt,
      'duplicate',
      '该来源快照已经采用过；本次未重复建立商品或追加修订，以下为该批次的原始结果。',
    );
  }
  return receiptResult(receipt, receipt.status, receiptExplanation(receipt.status));
}

export async function applyProductSourceSnapshot(input: unknown): Promise<ApplyProductSourceSnapshotResult> {
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
  if (reconciled !== null) return { message: reconciled.message };

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

/** true when the two names differ only by whitespace (review hint, never auto-bind). */
function namesDifferOnlyBySpaces(left: string | null, right: string | null): boolean {
  if (!left || !right) return false;
  return normalizeIdentityName(left) === normalizeIdentityName(right)
    && normalizeCellText(left) !== normalizeCellText(right);
}

/**
 * 预览中的“名称关系待确认”提示：同名（含仅空格差异）货源与现有缺货号商品
 * 只提示人工确认，不自动新建/绑定。按来源货号去重，最多展示 3 条。
 */
function identityConfirmationNotes(plan: ProductSourcePlan): string[] {
  const notes: string[] = [];
  const seen = new Set<string>();
  for (const result of plan.results) {
    if (result.action !== 'needs_review') continue;
    for (const issue of result.issues) {
      if (issue.kind !== 'missing_code_candidate') continue;
      const sourceCode = stringOrNull(issue.detail.sourceCode);
      const matchedItemName = stringOrNull(issue.detail.matchedItemName);
      if (!sourceCode || !matchedItemName) continue;
      const key = `${sourceCode}\u0000${matchedItemName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const spaceNote = namesDifferOnlyBySpaces(result.nameCn, matchedItemName) ? '（仅空格不同）' : '';
      notes.push(`需人工确认：来源货号 ${sourceCode} 与现有商品「${matchedItemName}」名称一致${spaceNote}，确认同一商品后再补号；不会自动新建或绑定。`);
    }
  }
  return notes;
}

function previewMessage(plan: ProductSourcePlan): string {
  if (!plan.decision || plan.decision !== 'apply') {
    if (plan.decision === 'replay') return '该快照已经应用过，无需重复应用。';
    if (plan.decision === 'rejected_stale') return '该快照早于最近成功批次，属于旧快照，不会覆盖新结果。';
    return `快照校验未通过：${plan.issues.map((issue) => issue.kind).join('、') || '无法应用'}`;
  }
  const counts = countRowsOf(plan.results);
  const notes = identityConfirmationNotes(plan);
  const shown = notes.slice(0, 3);
  const overflow = notes.length > shown.length ? ` 等 ${notes.length} 项。` : '';
  const confirmText = shown.length > 0 ? ` ${shown.join(' ')}${overflow}` : '';
  return `可应用：${summaryMessage(counts)}。${confirmText}`;
}

export async function refreshProductSourceSnapshot(input: unknown): Promise<{ message: string }> {
  const parsed = applyProductSourceSchema.pick({ requestId: true }).parse(input);
  void parsed;
  const localReader = reader();
  const summaries = await localReader.listSnapshots();
  if (!summaries.length) return { message: '当前还没有已保存的来源快照；请先点“立即读取飞书来源”。' };
  const overview = await overviewRaw();
  const applied = new Set((overview?.batches ?? []).filter((batch) => batch.status === 'applied' || batch.status === 'partial').map((batch) => batch.snapshotKey));
  const candidate = [...summaries].reverse().find((summary) => !applied.has(summary.snapshotKey));
  if (!candidate) return { message: '当前没有待应用的新来源快照；可点“立即读取飞书来源”检查是否有新变化。' };
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

/**
 * 手动真实读取飞书商品来源（只读飞书、只生成待应用快照）。
 *
 * 读取失败不抛错也不回退旧数据：返回明确失败原因，页面保留上次成功批次；
 * 读取成功只做预览（差异计划），商品资料要等“应用本批”才写入。
 */
export async function readProductSourceNow(): Promise<{
  message: string;
  status: 'captured' | 'unchanged' | 'failed';
  capturedAt: string;
}> {
  const identity = await requireCatalogAdmin();
  const snapshotDir = sourceRoot();
  const result = await captureFeishuProductSource({ snapshotDir });
  if (result.status === 'failed') {
    return {
      status: 'failed',
      capturedAt: result.capturedAt,
      message: `飞书读取失败：${captureErrorLabel(result.errorCode)}；本次没有生成新快照，也没有改动商品资料，仍保留上次成功数据。`,
    };
  }
  if (result.status === 'unchanged') {
    return {
      status: 'unchanged',
      capturedAt: result.capturedAt,
      message: `飞书读取完成（${captureCountsText(result.counts)}）；来源内容与最近快照一致，未生成新批次。`,
    };
  }
  if (!result.snapshotKey) {
    return { status: 'failed', capturedAt: result.capturedAt, message: '飞书读取没有生成可用的来源快照，本次未改动商品资料。' };
  }
  const prepared = await loadSnapshotByKey(result.snapshotKey);
  const validation = validateSnapshot(prepared.snapshot);
  if (!validation.ok) {
    return {
      status: 'captured',
      capturedAt: result.capturedAt,
      message: `飞书读取完成，但快照校验未通过：${validation.issues.map((issue) => issue.code).join('、')}；本批不会应用。`,
    };
  }
  const inputs = await loadPlanInputs(identity);
  const plan = buildPlanForSnapshot(prepared.snapshot, inputs);
  return {
    status: 'captured',
    capturedAt: result.capturedAt,
    message: `飞书读取完成（${captureSummaryOf(prepared.snapshot)}）。${previewMessage(plan)}`,
  };
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
  await productSourceRepository.assignCode(identity, parsed.requestId, parsed.itemId, parsed.expectedRevision, parsed.code, parsed.reason, 'product-source:manual-code');
  return { message: `已为原商品补录编号 ${parsed.code}（保留原商品身份）。` };
}

/** 字段级“暂不处理”：登记后本字段的同类事项不再催办，保留现有商品资料值。 */
export async function deferProductSourceField(input: unknown): Promise<{ message: string }> {
  const parsed: DeferProductSourceFieldInput = deferProductSourceFieldSchema.parse(input);
  const identity = await requireCatalogAdmin();
  await productSourceRepository.setFieldDecision(identity, parsed.requestId, parsed.issueId, 'defer', null, parsed.reason, parsed.note ?? null);
  return { message: '已登记暂不处理该字段；后续批次不再催办，可在已登记决定中恢复。' };
}

/** 字段级“人工口径”：用人工确认的来源值参与后续读取/应用。 */
export async function overrideProductSourceField(input: unknown): Promise<{ message: string }> {
  const parsed: OverrideProductSourceFieldInput = overrideProductSourceFieldSchema.parse(input);
  const identity = await requireCatalogAdmin();
  await productSourceRepository.setFieldDecision(identity, parsed.requestId, parsed.issueId, 'override', parsed.value, parsed.reason, parsed.note ?? null);
  return { message: '已登记人工口径并关闭本条事项；下次读取/应用按该口径采用。' };
}

/** 恢复字段级人工决定：下次读取/应用重新提示。 */
export async function restoreProductSourceFieldDecision(input: unknown): Promise<{ message: string }> {
  const parsed: RestoreProductSourceFieldDecisionInput = restoreProductSourceFieldDecisionSchema.parse(input);
  const identity = await requireCatalogAdmin();
  await productSourceRepository.revokeFieldDecision(identity, parsed.requestId, parsed.decisionId, parsed.note ?? null);
  return { message: '已恢复处理；下次读取/应用会重新提示。' };
}

/**
 * 历史批次（036 之前）的 `product_source_row.fields` 为空：
 * 用批次的 collection.headers 还原字段列映射，再由公共 cells 重建行字段。
 * 内容指纹必须来自真实来源字段，不能用空对象代替。
 */
function rebuildRowFields(context: SourceIssueDecisionContext, row: SourceIssueRowContext): Record<string, SourceCell> {
  if (Object.keys(row.fields).length > 0) return row.fields;
  const headers = (context.collection as { headers?: unknown } | null)?.headers;
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return row.fields;
  const mapping = resolveHeaderMapping(headers as Record<string, string>);
  if (Object.keys(mapping.fieldColumns).length === 0) return row.fields;
  return buildRowFields(row.cells, mapping.fieldColumns);
}

function rowsForDuplicateDecision(context: SourceIssueDecisionContext): SourceIssueRowContext[] {
  return context.rows.map((row) => ({ ...row, fields: rebuildRowFields(context, row) }));
}

/** 单元格原值：明确空/未读都按“未填写”表达，不补推测值。 */
function sourceCellRaw(cell: SourceCell | undefined): string {
  if (!cell || cell.state === 'explicit_empty' || cell.state === 'not_read') return '';
  return cell.raw.trim();
}

/**
 * 回执直接写清「以后更新用哪份资料」：取两行真实不一致的字段（优先商品条码），
 * 写明所选那一行的字段值或「未填写」，例如
 * 「已保存，以后更新使用商品条码 757577407380 的这份资料（来源第 127 行）」。
 * 只使用来源行里已有的字段值，不猜、不合并。
 */
function duplicateDecisionMessage(rows: SourceIssueRowContext[], chosen: SourceIssueRowContext): string {
  const keys = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row.fields ?? {})) keys.add(key);
  const differing = [...keys].filter((key) => new Set(
    rows.map((row) => sourceCellRaw(row.fields?.[key])),
  ).size > 1);
  const fieldKey = differing.find((key) => key === 'barcode') ?? differing[0] ?? 'barcode';
  const label = CATALOG_FIELD_LABELS[fieldKey] ?? '该字段';
  const value = sourceCellRaw(chosen.fields?.[fieldKey]);
  return value
    ? `已保存，以后更新使用${label} ${value} 的这份资料（来源第 ${chosen.rowNumber} 行）。`
    : `已保存，以后更新使用${label}未填写的这份资料（来源第 ${chosen.rowNumber} 行）。`;
}

/** 同号多行人工选择：按来源内容指纹保存“以哪一行为准”。 */
export async function decideDuplicateSourceRow(input: unknown): Promise<{ message: string }> {
  const parsed: DecideDuplicateSourceRowInput = decideDuplicateSourceRowSchema.parse(input);
  const identity = await requireCatalogAdmin();
  const context = await productSourceRepository.issueDecisionContext(identity, parsed.issueId);
  if (!context) throw new Error('CATALOG_SOURCE_ISSUE_NOT_OPEN');
  if (context.reviewState !== 'open') throw new Error('CATALOG_SOURCE_ISSUE_NOT_OPEN');
  if (context.issueKind !== 'duplicate_code_inconsistent' || !context.sourceKey.startsWith('code:')) {
    throw new Error('CATALOG_SOURCE_ISSUE_NOT_DUPLICATE');
  }
  const rows = rowsForDuplicateDecision(context);
  const chosen = rows.find((row) => row.rowNumber === parsed.chosenRowNumber);
  if (!chosen) throw new Error('CATALOG_SOURCE_ROW_NOT_FOUND');
  const hasAllFields = rows.every((row) => row.fields && typeof row.fields === 'object' && Object.keys(row.fields).length > 0);
  if (!hasAllFields) throw new Error('CATALOG_SOURCE_ROW_CHANGED');
  const chosenRowSha256 = rowBusinessSha256(chosen.fields);
  const basisSha256 = duplicateBasisSha256(rows.map((row): SourceRow => ({
    rowNumber: row.rowNumber,
    isBusinessRow: true,
    cells: row.cells,
    fields: row.fields,
    rowSha256: row.rowSha256 ?? '',
  })));
  await productSourceRepository.decideDuplicate(
    identity,
    parsed.requestId,
    parsed.issueId,
    parsed.chosenRowNumber,
    chosenRowSha256,
    basisSha256,
    chosen.rowSha256,
    parsed.note ?? null,
  );
  return { message: duplicateDecisionMessage(rows, chosen) };
}

/** 撤销同号多行人工选择：下次读取/应用重新提示。 */
export async function restoreDuplicateSourceDecision(input: unknown): Promise<{ message: string }> {
  const parsed: RestoreDuplicateSourceDecisionInput = restoreDuplicateSourceDecisionSchema.parse(input);
  const identity = await requireCatalogAdmin();
  await productSourceRepository.revokeDuplicateDecision(identity, parsed.requestId, parsed.decisionId, parsed.note ?? null);
  return { message: '已撤销同号多行选择；下次读取/应用会重新提示。' };
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
