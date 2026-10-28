/**
 * Shared contract for the Feishu product-source simulation (v1).
 *
 * This module is the single source of truth for:
 * - snapshot shapes (`ice-product-source-snapshot-v1`),
 * - header label -> product field mapping (labels are authoritative; column
 *   letters are evidence only),
 * - field key whitelist / units / field groups,
 * - the apply-plan JSON shape consumed by `catalog.apply_product_source_batch`,
 * - the batch JSON shape (`p_batch`) submitted by the service layer.
 *
 * It is intentionally pure: no node builtins, no server-only import, so the
 * panel may import labels/units safely. Hashing helpers live in `reader.ts`.
 *
 * Restricted amount columns (I / J / Y) are never mapped into product fields.
 * Their raw values may only live inside `SourceRow.cells` / `BatchRow.cells`
 * (and the private `catalog_private.product_source_row_amounts` payload);
 * they must never appear in plans, results, issues, diffs or DTOs.
 */
import type { FieldObservation } from '../types';

export const SNAPSHOT_CONTRACT = 'ice-product-source-snapshot-v1';
export const PLAN_CONTRACT = 'ice-product-source-plan-v1';
export const SOURCE_SYSTEM = 'feishu';
export const SOURCE_PROFILE_KEY = 'feishu.ice-product-library.sheet1';
export const PARSER_VERSION = 'feishu-product-source-v1';

/** Snapshot origin. `local_simulation` is never a real Feishu modification. */
export type SnapshotOrigin = 'real_capture' | 'local_simulation';

/** Raw value of a restricted amount column. Evidence only, never adopted. */
export type RestrictedAmountKey = 'costPrice' | 'operatingPrice' | 'shippingPrice';
export const RESTRICTED_AMOUNT_KEYS = ['costPrice', 'operatingPrice', 'shippingPrice'] as const;
/** Column letters observed in run1 for the restricted amount headers (evidence only). */
export const RESTRICTED_COLUMN_KEYS = ['I', 'J', 'Y'] as const;
export const RESTRICTED_AMOUNT_COLUMNS: Readonly<Record<RestrictedAmountKey, string>> = {
  costPrice: 'I',
  operatingPrice: 'J',
  shippingPrice: 'Y',
};
export const RESTRICTED_AMOUNT_HEADERS: Readonly<Record<RestrictedAmountKey, string>> = {
  costPrice: '成本价格',
  operatingPrice: '运营价格',
  shippingPrice: '单品运费（自由计算列）',
};
export const RESTRICTED_AMOUNT_NOTE =
  '价格列（成本价格 I / 运营价格 J / 单品运费 Y）只作为受限来源证据保存，不进入商品字段、差异计划、待核对明细或页面。';

/** Source cell classification. */
export type SourceCellState = 'observed' | 'explicit_empty' | 'not_read' | 'parse_failed';
export interface SourceCell {
  /** Trimmed raw text for observed/parse_failed cells; '' otherwise. */
  raw: string;
  state: SourceCellState;
  meaning?: 'value' | 'explicit_empty';
  /** Machine reason for not_read / parse_failed cells. */
  reason?: string;
}

export const IMAGE_NOT_READ_BY_SNAPSHOT = 'IMAGE_NOT_READ_BY_SNAPSHOT';
export const SOURCE_FORMULA_ERROR = 'SOURCE_FORMULA_ERROR';
export const SOURCE_VALUE_NOT_NUMERIC = 'SOURCE_VALUE_NOT_NUMERIC';
export const INVALID_CARTON_QUANTITY = 'INVALID_CARTON_QUANTITY';

// ---------------------------------------------------------------------------
// Field whitelist
// ---------------------------------------------------------------------------

/** All mapped product fields, in specification §2 order (24 keys). */
export const PRODUCT_SOURCE_FIELD_KEYS = [
  'sourceDate',
  'nameCn',
  'specification',
  'englishName',
  'factory',
  'imageRef',
  'iceCode',
  'barcode',
  'length',
  'width',
  'height',
  'unitWeight',
  'cartonQuantity',
  'cartonLength',
  'cartonWidth',
  'cartonHeight',
  'cartonWeight',
  'liquid',
  'shelfLifeDays',
  'cartonVolume',
  'unitVolume',
  'factoryLeadDays',
  'shippingDays',
  'sourceNote',
] as const;
export type ProductSourceFieldKey = (typeof PRODUCT_SOURCE_FIELD_KEYS)[number];

/**
 * Fields that may be adopted into catalog item fields.
 * - `imageRef` is never read from a text clipboard (`not_read`).
 * - `sourceDate` is static reference material only; it is not a version or a
 *   modification time and must not create revisions when rows disagree.
 * - `iceCode` is identity/evidence only (used for grouping and matching); it is
 *   never written into catalog item fields.
 * => 21 adoptable keys.
 */
export const ADOPTABLE_FIELD_KEYS = [
  'nameCn',
  'specification',
  'englishName',
  'factory',
  'barcode',
  'length',
  'width',
  'height',
  'unitWeight',
  'cartonQuantity',
  'cartonLength',
  'cartonWidth',
  'cartonHeight',
  'cartonWeight',
  'liquid',
  'shelfLifeDays',
  'cartonVolume',
  'unitVolume',
  'factoryLeadDays',
  'shippingDays',
  'sourceNote',
] as const;
export type AdoptableFieldKey = (typeof ADOPTABLE_FIELD_KEYS)[number];

/** Fields compared when several rows share one code (blank-vs-value is not a conflict). */
export const CONSISTENCY_FIELD_KEYS = ADOPTABLE_FIELD_KEYS;

/** Fields whose raw text must parse as a finite number. */
export const NUMERIC_FIELD_KEYS = [
  'length',
  'width',
  'height',
  'unitWeight',
  'cartonQuantity',
  'cartonLength',
  'cartonWidth',
  'cartonHeight',
  'cartonWeight',
  'shelfLifeDays',
  'cartonVolume',
  'unitVolume',
  'factoryLeadDays',
  'shippingDays',
] as const;
export type NumericFieldKey = (typeof NUMERIC_FIELD_KEYS)[number];

/** Fields requiring a positive integer (件/箱). */
export const POSITIVE_INTEGER_FIELD_KEYS = ['cartonQuantity'] as const;

export function isAdoptableFieldKey(key: string): key is AdoptableFieldKey {
  return (ADOPTABLE_FIELD_KEYS as readonly string[]).includes(key);
}
export function isNumericFieldKey(key: string): key is NumericFieldKey {
  return (NUMERIC_FIELD_KEYS as readonly string[]).includes(key);
}
export function isProductSourceFieldKey(key: string): key is ProductSourceFieldKey {
  return (PRODUCT_SOURCE_FIELD_KEYS as readonly string[]).includes(key);
}

// ---------------------------------------------------------------------------
// Header label mapping
// ---------------------------------------------------------------------------

export interface HeaderContractEntry {
  /** Exact header text as observed (trimmed). Lookup is by this label only. */
  readonly label: string;
  /** Mapped product field, or null for restricted amount headers. */
  readonly fieldKey: ProductSourceFieldKey | null;
  /** Restricted amount key, or null for product field headers. */
  readonly restrictedKey: RestrictedAmountKey | null;
  /** Column letter observed in run1 (A1:AE404 evidence only, never used for lookup). */
  readonly evidenceColumn: string;
}

/** The 27 known headers in observed column order (A..AA). */
export const HEADER_CONTRACT = [
  { label: '日期', fieldKey: 'sourceDate', restrictedKey: null, evidenceColumn: 'A' },
  { label: '中文产品名称', fieldKey: 'nameCn', restrictedKey: null, evidenceColumn: 'B' },
  { label: '规格', fieldKey: 'specification', restrictedKey: null, evidenceColumn: 'C' },
  { label: '英文名称', fieldKey: 'englishName', restrictedKey: null, evidenceColumn: 'D' },
  { label: '生产工厂', fieldKey: 'factory', restrictedKey: null, evidenceColumn: 'E' },
  { label: '产品图片', fieldKey: 'imageRef', restrictedKey: null, evidenceColumn: 'F' },
  { label: '聚水潭内部货号', fieldKey: 'iceCode', restrictedKey: null, evidenceColumn: 'G' },
  { label: '69商品编码', fieldKey: 'barcode', restrictedKey: null, evidenceColumn: 'H' },
  { label: '成本价格', fieldKey: null, restrictedKey: 'costPrice', evidenceColumn: 'I' },
  { label: '运营价格', fieldKey: null, restrictedKey: 'operatingPrice', evidenceColumn: 'J' },
  { label: '备注', fieldKey: 'sourceNote', restrictedKey: null, evidenceColumn: 'K' },
  { label: '长(单产品/cm）', fieldKey: 'length', restrictedKey: null, evidenceColumn: 'L' },
  { label: '宽(单产品/cm）', fieldKey: 'width', restrictedKey: null, evidenceColumn: 'M' },
  { label: '高(单产品/cm）', fieldKey: 'height', restrictedKey: null, evidenceColumn: 'N' },
  { label: '单个产品重量(kg）', fieldKey: 'unitWeight', restrictedKey: null, evidenceColumn: 'O' },
  { label: '装箱数量', fieldKey: 'cartonQuantity', restrictedKey: null, evidenceColumn: 'P' },
  { label: '装箱长', fieldKey: 'cartonLength', restrictedKey: null, evidenceColumn: 'Q' },
  { label: '装箱宽', fieldKey: 'cartonWidth', restrictedKey: null, evidenceColumn: 'R' },
  { label: '装箱高', fieldKey: 'cartonHeight', restrictedKey: null, evidenceColumn: 'S' },
  { label: '单箱重量', fieldKey: 'cartonWeight', restrictedKey: null, evidenceColumn: 'T' },
  { label: '是否液体', fieldKey: 'liquid', restrictedKey: null, evidenceColumn: 'U' },
  { label: '有效期（天数)', fieldKey: 'shelfLifeDays', restrictedKey: null, evidenceColumn: 'V' },
  { label: '单箱立方', fieldKey: 'cartonVolume', restrictedKey: null, evidenceColumn: 'W' },
  { label: '单瓶立方', fieldKey: 'unitVolume', restrictedKey: null, evidenceColumn: 'X' },
  { label: '单品运费（自由计算列）', fieldKey: null, restrictedKey: 'shippingPrice', evidenceColumn: 'Y' },
  { label: '工厂生产货期(天）', fieldKey: 'factoryLeadDays', restrictedKey: null, evidenceColumn: 'Z' },
  { label: '运输时间（海运预估）', fieldKey: 'shippingDays', restrictedKey: null, evidenceColumn: 'AA' },
] as const satisfies readonly HeaderContractEntry[];

export const KNOWN_HEADER_LABELS: readonly string[] = HEADER_CONTRACT.map((entry) => entry.label);

/** Header label -> contract entry. Keyed by exact (trimmed) header text. */
export const HEADER_FIELD_MAP: Readonly<Record<string, HeaderContractEntry>> = Object.fromEntries(
  HEADER_CONTRACT.map((entry) => [entry.label, entry]),
);

// ---------------------------------------------------------------------------
// Units and field groups
// ---------------------------------------------------------------------------

export type FieldUnitState = 'confirmed' | 'unconfirmed' | 'not_applicable';

export interface FieldUnitContract {
  /** confirmed: header states the unit; unconfirmed: header has no unit; not_applicable: non-numeric. */
  readonly state: FieldUnitState;
  /** Unit label when confirmed, otherwise null. No conversion is ever performed. */
  readonly label: string | null;
}

export const FIELD_UNITS: Readonly<Record<ProductSourceFieldKey, FieldUnitContract>> = {
  sourceDate: { state: 'not_applicable', label: null },
  nameCn: { state: 'not_applicable', label: null },
  specification: { state: 'not_applicable', label: null },
  englishName: { state: 'not_applicable', label: null },
  factory: { state: 'not_applicable', label: null },
  imageRef: { state: 'not_applicable', label: null },
  iceCode: { state: 'not_applicable', label: null },
  barcode: { state: 'not_applicable', label: null },
  length: { state: 'confirmed', label: 'cm' },
  width: { state: 'confirmed', label: 'cm' },
  height: { state: 'confirmed', label: 'cm' },
  unitWeight: { state: 'confirmed', label: 'kg' },
  cartonQuantity: { state: 'confirmed', label: '件/箱' },
  cartonLength: { state: 'unconfirmed', label: null },
  cartonWidth: { state: 'unconfirmed', label: null },
  cartonHeight: { state: 'unconfirmed', label: null },
  cartonWeight: { state: 'unconfirmed', label: null },
  liquid: { state: 'not_applicable', label: null },
  shelfLifeDays: { state: 'confirmed', label: '天' },
  cartonVolume: { state: 'unconfirmed', label: null },
  unitVolume: { state: 'unconfirmed', label: null },
  factoryLeadDays: { state: 'confirmed', label: '天' },
  shippingDays: { state: 'confirmed', label: '天' },
  sourceNote: { state: 'not_applicable', label: null },
};

/** Related numeric fields. A conflict in a blocking group holds the whole group. */
export const FIELD_GROUPS = {
  cartonDimensions: ['cartonLength', 'cartonWidth', 'cartonHeight'],
  unitDimensions: ['length', 'width', 'height'],
  volumes: ['cartonVolume', 'unitVolume'],
} as const satisfies Readonly<Record<string, readonly ProductSourceFieldKey[]>>;
export type FieldGroupKey = keyof typeof FIELD_GROUPS;

/** Only the carton dimension group blocks as a unit in v1 (specification §4). */
export const CONFLICT_BLOCKING_FIELD_GROUPS = ['cartonDimensions'] as const satisfies readonly FieldGroupKey[];

export function fieldGroupOf(fieldKey: ProductSourceFieldKey): FieldGroupKey | null {
  for (const groupKey of Object.keys(FIELD_GROUPS) as FieldGroupKey[]) {
    if ((FIELD_GROUPS[groupKey] as readonly ProductSourceFieldKey[]).includes(fieldKey)) return groupKey;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Snapshot shapes
// ---------------------------------------------------------------------------

export interface SimulatedChange {
  kind:
    | 'field_change'
    | 'row_inserted'
    | 'row_removed'
    | 'code_duplicate'
    | 'code_missing'
    | 'code_suspected_changed'
    | 'rows_reordered'
    | 'columns_reordered'
    | 'formula_error'
    | 'blanked';
  /** `code:<ICE code>` or `row:<row number>` of the affected source row. */
  sourceKey: string;
  detail: string;
}

export interface SourceSimulationMeta {
  baseSnapshotKey: string;
  note: string;
  changes: SimulatedChange[];
}

export interface SourceSnapshotCollection {
  method: 'web_clipboard_copy' | 'mock_reader';
  url: string;
  worksheetTitle: string;
  headerRow: number;
  requestedRange: string;
  observedRange: string;
  gridRows: number;
  gridColumns: number;
  businessRowCount: number;
  emptyRowCount: number;
  complete: boolean;
  /** Column letter -> header text ('' for unknown/empty header columns). */
  headers: Record<string, string>;
  rawEvidenceSha256: string | null;
  rawEvidenceBytes: number | null;
  truncated: boolean;
  readError: string | null;
}

export interface SourceRow {
  /** Worksheet row number (1-based; header row is 1). Evidence only. */
  rowNumber: number;
  /** true when the name column (B) of this data row is non-empty. */
  isBusinessRow: boolean;
  /** Column letter -> trimmed raw text (restricted amount columns included). */
  cells: Record<string, string>;
  /** Mapped field -> cell classification (never contains restricted values; {} for empty rows). */
  fields: Record<string, SourceCell>;
  rowSha256: string;
}

/** Fixture-only marker: restricted amount columns were blanked for the repo copy. */
export interface SourceRedaction {
  restrictedColumns: string[];
  priceValuesRemoved: boolean;
  note: string;
}

export interface SourceSnapshot {
  contract: typeof SNAPSHOT_CONTRACT;
  profileKey: string;
  /** sha256 over the canonical rows+collection content version. */
  snapshotKey: string;
  origin: SnapshotOrigin;
  /** Capture time only — never a source document version. */
  capturedAt: string;
  /** Observed page label ("最新修改时间为10月20日"); display only. */
  documentModifiedLabel: string | null;
  collection: SourceSnapshotCollection;
  simulation?: SourceSimulationMeta | null;
  redaction?: SourceRedaction | null;
  rows: SourceRow[];
}

export function codeSourceKey(iceCode: string): string {
  return `code:${iceCode}`;
}
export function rowSourceKey(rowNumber: number): string {
  return `row:${rowNumber}`;
}

// ---------------------------------------------------------------------------
// Header / snapshot validation
// ---------------------------------------------------------------------------

export type SnapshotIssueCode =
  | 'HEADER_CONTRACT_INVALID'
  | 'CAPTURE_INCOMPLETE'
  | 'COLUMN_COUNT_INVALID'
  | 'SNAPSHOT_CONTRACT_INVALID'
  | 'SNAPSHOT_PROFILE_MISMATCH'
  | 'SNAPSHOT_ROW_INVALID'
  | 'SNAPSHOT_EMPTY_PAYLOAD';

export interface SnapshotIssue {
  code: SnapshotIssueCode;
  detail: string;
}

export interface SnapshotValidation {
  ok: boolean;
  status: 'validated' | 'failed';
  issues: SnapshotIssue[];
}

// ---------------------------------------------------------------------------
// Row grouping / evaluation
// ---------------------------------------------------------------------------

export interface CodeGroup {
  code: string;
  rows: SourceRow[];
}

export type RowEvaluationClass = 'consistent' | 'inconsistent' | 'missing_code';

export interface SourceFieldConflict {
  fieldKey: AdoptableFieldKey;
  /**
   * Per-row values that disagree. Consistency is strict: blank vs non-blank is
   * a difference (the blank row is listed with raw=null, state='explicit_empty').
   */
  values: { rowNumber: number; raw: string | null; state: SourceCellState }[];
}

export interface SourceFieldNote {
  rowNumber: number;
  fieldKey: ProductSourceFieldKey;
  reason: string;
  raw: string;
}

export interface SourceRowEvaluation {
  /** `code:<ICE code>` for coded rows, `row:<row number>` for missing-code rows. */
  sourceKey: string;
  iceCode: string | null;
  rowNumbers: number[];
  classification: RowEvaluationClass;
  reasonCode: ProductSourceReasonCode | null;
  /** Merged logical input for consistent groups; null for inconsistent/missing-code rows. */
  logicalFields: Record<ProductSourceFieldKey, SourceCell> | null;
  conflicts: SourceFieldConflict[];
  fieldIssues: SourceFieldNote[];
  notes: string[];
}

// ---------------------------------------------------------------------------
// Reason codes (internal English key + Chinese business text)
// ---------------------------------------------------------------------------

export const PRODUCT_SOURCE_REASON_CODES = [
  'INITIAL_SOURCE_BASELINE',
  'SOURCE_FIELD_UPDATE',
  'SOURCE_UNCHANGED',
  'SAME_VALUE_NO_REVISION',
  'DUPLICATE_CODE_INCONSISTENT',
  'MISSING_CODE',
  'MISSING_CODE_CANDIDATE',
  'SUSPECTED_CODE_CHANGE',
  'FIELD_CONFLICT',
  'FIELD_GROUP_CONFLICT',
  'INITIAL_BASELINE_DIFF',
  'UNIT_UNCONFIRMED',
  'SOURCE_FORMULA_ERROR',
  'SOURCE_VALUE_NOT_NUMERIC',
  'INVALID_CARTON_QUANTITY',
  'SOURCE_ROW_MISSING',
  'NEW_ITEM_CREATED',
  'NEW_ITEM_NAME_MISSING',
  'NEW_ITEM_VALUE_INVALID',
  'SNAPSHOT_HEADER_INVALID',
  'SNAPSHOT_INCOMPLETE',
  'SNAPSHOT_COLUMN_COUNT_INVALID',
  'SNAPSHOT_ALREADY_APPLIED',
  'SNAPSHOT_STALE',
  'SNAPSHOT_INVALID',
] as const;
export type ProductSourceReasonCode = (typeof PRODUCT_SOURCE_REASON_CODES)[number];

/** Named reason-code constants (import-friendly; values match PRODUCT_SOURCE_REASON_CODES). */
export const INITIAL_SOURCE_BASELINE: ProductSourceReasonCode = 'INITIAL_SOURCE_BASELINE';
export const SOURCE_FIELD_UPDATE: ProductSourceReasonCode = 'SOURCE_FIELD_UPDATE';
export const SOURCE_UNCHANGED: ProductSourceReasonCode = 'SOURCE_UNCHANGED';
export const SAME_VALUE_NO_REVISION: ProductSourceReasonCode = 'SAME_VALUE_NO_REVISION';
export const DUPLICATE_CODE_INCONSISTENT: ProductSourceReasonCode = 'DUPLICATE_CODE_INCONSISTENT';
export const MISSING_CODE: ProductSourceReasonCode = 'MISSING_CODE';
export const MISSING_CODE_CANDIDATE: ProductSourceReasonCode = 'MISSING_CODE_CANDIDATE';
export const SUSPECTED_CODE_CHANGE: ProductSourceReasonCode = 'SUSPECTED_CODE_CHANGE';
export const FIELD_CONFLICT: ProductSourceReasonCode = 'FIELD_CONFLICT';
export const FIELD_GROUP_CONFLICT: ProductSourceReasonCode = 'FIELD_GROUP_CONFLICT';
export const INITIAL_BASELINE_DIFF: ProductSourceReasonCode = 'INITIAL_BASELINE_DIFF';
export const UNIT_UNCONFIRMED: ProductSourceReasonCode = 'UNIT_UNCONFIRMED';
export const SOURCE_ROW_MISSING: ProductSourceReasonCode = 'SOURCE_ROW_MISSING';
export const NEW_ITEM_CREATED: ProductSourceReasonCode = 'NEW_ITEM_CREATED';
export const NEW_ITEM_NAME_MISSING: ProductSourceReasonCode = 'NEW_ITEM_NAME_MISSING';
export const NEW_ITEM_VALUE_INVALID: ProductSourceReasonCode = 'NEW_ITEM_VALUE_INVALID';
export const SNAPSHOT_HEADER_INVALID: ProductSourceReasonCode = 'SNAPSHOT_HEADER_INVALID';
export const SNAPSHOT_INCOMPLETE: ProductSourceReasonCode = 'SNAPSHOT_INCOMPLETE';
export const SNAPSHOT_COLUMN_COUNT_INVALID: ProductSourceReasonCode = 'SNAPSHOT_COLUMN_COUNT_INVALID';
export const SNAPSHOT_ALREADY_APPLIED: ProductSourceReasonCode = 'SNAPSHOT_ALREADY_APPLIED';
export const SNAPSHOT_STALE: ProductSourceReasonCode = 'SNAPSHOT_STALE';
export const SNAPSHOT_INVALID: ProductSourceReasonCode = 'SNAPSHOT_INVALID';

/** Chinese business reasons (written into item_revision.reason and shown in UI). */
export const REASON_TEXT: Readonly<Record<ProductSourceReasonCode, string>> = {
  INITIAL_SOURCE_BASELINE: '来源首轮基线',
  SOURCE_FIELD_UPDATE: '来源资料采用',
  SOURCE_UNCHANGED: '来源与当前一致，无修订',
  SAME_VALUE_NO_REVISION: '来源与本地一致，不追加修订',
  DUPLICATE_CODE_INCONSISTENT: '同号多行资料不一致，待人工核对',
  MISSING_CODE: '来源行缺少货号，待人工核对',
  MISSING_CODE_CANDIDATE: '来源缺码行疑似对应现有商品，待人工补号',
  SUSPECTED_CODE_CHANGE: '来源货号疑似变更，待人工核对',
  FIELD_CONFLICT: '本地与来源同时修改，保留本地值，待人工核对',
  FIELD_GROUP_CONFLICT: '外箱尺寸字段组存在冲突，整组保留本地值，待人工核对',
  INITIAL_BASELINE_DIFF: '来源首轮基线与本地资料不同，保留本地值并记录来源基线，待人工核对',
  UNIT_UNCONFIRMED: '来源单位未确认的字段与本地不同，保留本地值，待人工核对',
  SOURCE_FORMULA_ERROR: '来源单元格为公式错误值，未采用',
  SOURCE_VALUE_NOT_NUMERIC: '来源数值无法解析，未采用',
  INVALID_CARTON_QUANTITY: '装箱数量不是正整数，未采用',
  SOURCE_ROW_MISSING: '本次来源快照未见该已绑定商品，仅标记',
  NEW_ITEM_CREATED: '来源新品建档',
  NEW_ITEM_NAME_MISSING: '来源新品缺少中文名称，未建档',
  NEW_ITEM_VALUE_INVALID: '来源新品字段不合法，未建档',
  SNAPSHOT_HEADER_INVALID: '来源表头校验未通过',
  SNAPSHOT_INCOMPLETE: '来源采集不完整',
  SNAPSHOT_COLUMN_COUNT_INVALID: '来源数据列数与表头不一致',
  SNAPSHOT_ALREADY_APPLIED: '该来源快照已应用，直接返回原结果',
  SNAPSHOT_STALE: '来源快照早于最近批次，未应用',
  SNAPSHOT_INVALID: '来源快照不符契约',
};

// ---------------------------------------------------------------------------
// Issue kinds
// ---------------------------------------------------------------------------

export const ISSUE_KINDS = [
  'duplicate_code_inconsistent',
  'missing_code',
  'missing_code_candidate',
  'suspected_code_change',
  'field_conflict',
  'group_field_conflict',
  'initial_baseline_diff',
  'unit_unconfirmed',
  'formula_error',
  'invalid_value',
  'missing_row',
  'header_contract_invalid',
  'capture_incomplete',
  'column_count_invalid',
  'snapshot_invalid',
  'already_applied',
  'stale_snapshot',
] as const;
export type IssueKind = (typeof ISSUE_KINDS)[number];

export const ISSUE_KIND_LABELS: Readonly<Record<IssueKind, string>> = {
  duplicate_code_inconsistent: '同号多行不一致',
  missing_code: '来源缺码',
  missing_code_candidate: '缺码疑似已有商品',
  suspected_code_change: '疑似改码',
  field_conflict: '字段冲突',
  group_field_conflict: '字段组冲突',
  initial_baseline_diff: '首轮基线与本地不同',
  unit_unconfirmed: '单位未确认',
  formula_error: '公式错误',
  invalid_value: '字段值非法',
  missing_row: '本次未见',
  header_contract_invalid: '表头不符契约',
  capture_incomplete: '采集不完整',
  column_count_invalid: '列数不一致',
  snapshot_invalid: '快照不符契约',
  already_applied: '快照已应用',
  stale_snapshot: '旧快照',
};

// ---------------------------------------------------------------------------
// Apply plan (consumed by catalog.apply_product_source_batch)
// ---------------------------------------------------------------------------

export type PlanAction = 'update' | 'create' | 'unchanged' | 'needs_review' | 'failed';

export interface PlanCounts {
  created: number;
  updated: number;
  unchanged: number;
  needsReview: number;
  failed: number;
  missing: number;
}

export type PlanChangeKind = 'update' | 'initial_baseline' | 'unit_unconfirmed';

export interface PlanFieldChange {
  fieldKey: ProductSourceFieldKey;
  beforeRaw: string | null;
  afterRaw: string | null;
  kind: PlanChangeKind;
}

export interface PlanFieldAdoption {
  fieldKey: ProductSourceFieldKey;
  raw: string;
  state: 'observed' | 'explicit_empty';
  /** Unit state travels with the adoption only — never inside FieldObservation. */
  unitState: FieldUnitState;
}

export type PlanIssueDetail = Record<string, JsonValue>;
export interface PlanIssue {
  kind: IssueKind;
  detail: PlanIssueDetail;
}

/**
 * One apply-plan row.
 *
 * `action='needs_review'` has TWO forms (Lead decision 2026-10-25):
 * - `nextFields === null` → the whole item is deferred (duplicate-code
 *   inconsistency, missing code, suspected code change, invalid new item…);
 *   no item revision, no adoption is written for it.
 * - `nextFields !== null` (with `expectedRevision`) → the item is partially
 *   applied: only the non-conflicting fields in `changes` are written as a new
 *   revision while the result classification stays `needs_review` and the
 *   issues remain open (field conflict, first-round baseline diff, unconfirmed
 *   unit, invalid source value). `nextFields` is the COMPLETE FieldObservation
 *   map for the new revision (current local fields with the written fields
 *   overlaid).
 */
export interface ProductSourcePlanResult {
  /** `code:<ICE code>` or `row:<row number>`; `batch` for a rejected batch. */
  sourceKey: string;
  iceCode: string | null;
  /** Catalog item uuid for bound/existing items; null for new/unmatched rows. */
  itemId: string | null;
  action: PlanAction;
  reasonCode: ProductSourceReasonCode;
  /** Chinese business reason; will be written into item_revision.reason. */
  reasonText: string;
  rowNumbers: number[];
  /** item_current.revision when a revision may be written (update / partial review); null otherwise. */
  expectedRevision: number | null;
  /** Only actual product writes (beforeRaw -> afterRaw). Empty when nothing is written. */
  changes: PlanFieldChange[];
  /** Source-observed adoptions (baseline upserts), including values equal to base. */
  adoptions: PlanFieldAdoption[];
  /**
   * Complete FieldObservation map when the item is written (action update /
   * create / partial needs_review). Null when nothing is written.
   */
  nextFields: Record<string, FieldObservation> | null;
  nameCn: string | null;
  /** New item code for action=create; null otherwise. */
  createCode: string | null;
  issues: PlanIssue[];
  /** true = bound item not seen in this snapshot (mark only; never delete/unbind). */
  missing: boolean;
}

/** Exactly the `p_plan` JSON shape submitted to the database function. */
export interface ProductSourcePlanPayload {
  countsHint: PlanCounts;
  results: ProductSourcePlanResult[];
  seenItemIds: string[];
  batchStatusHint: 'applied' | 'partial' | 'failed';
}

export type PlanDecision = 'apply' | 'replay' | 'rejected_stale' | 'rejected_invalid';

export interface ProductSourcePlan extends ProductSourcePlanPayload {
  contract: typeof PLAN_CONTRACT;
  profileKey: string;
  snapshotKey: string;
  decision: PlanDecision;
  /** Batch-level issues (invalid snapshot / stale / replay). */
  issues: PlanIssue[];
}

export interface PlanBoundItem {
  itemId: string;
  /** Current catalog revision (item_current.revision). */
  revision: number;
  iceCode: string | null;
  nameCn: string;
  fields: Record<string, FieldObservation>;
}

export interface PlanBinding {
  itemId: string;
  iceCode: string;
  state?: 'active' | 'missing';
}

export interface PlanAdoptionRow {
  itemId: string;
  fieldKey: ProductSourceFieldKey;
  adoptedRaw: string | null;
  adoptedState: 'observed' | 'explicit_empty';
  unitState: FieldUnitState;
}

export interface PlanAppliedSnapshot {
  snapshotKey: string;
  capturedAt: string;
  status: 'collected' | 'validated' | 'applied' | 'partial' | 'failed' | 'rejected_stale';
}

export interface BuildPlanInput {
  snapshot: SourceSnapshot;
  /** Optional pre-computed evaluations; computed from the snapshot when omitted. */
  evaluations?: SourceRowEvaluation[];
  bindings: PlanBinding[];
  items: PlanBoundItem[];
  adoptions: PlanAdoptionRow[];
  /** itemId -> expected item_current.revision; falls back to PlanBoundItem.revision. */
  expectedRevisions?: Record<string, number>;
  appliedSnapshots?: PlanAppliedSnapshot[];
  latestAppliedCapturedAt?: string | null;
  /**
   * Retry of a partially failed batch: when provided, the replay decision is
   * skipped and the full plan is built first, then ONLY results whose sourceKey
   * is in this list are kept. `seenItemIds` stays the complete set of seen bound
   * items so the database does not mark successful items as missing. An empty
   * list yields decision='apply' with zero results (the service decides not to
   * submit). Stale / invalid snapshot rules are unchanged.
   */
  retryFailedSourceKeys?: readonly string[];
}

// ---------------------------------------------------------------------------
// Batch payload (p_batch) submitted by the service layer
// ---------------------------------------------------------------------------

export type BatchArtifactRole = 'snapshot' | 'raw_capture' | 'metadata';
export interface BatchArtifact {
  logicalName: string;
  sha256: string;
  size: number;
  format: string;
  storageHandle: string;
  role: BatchArtifactRole;
}

export interface ProductSourceBatchRow {
  rowNumber: number;
  isBusinessRow: boolean;
  iceCode: string | null;
  /**
   * Column letter -> raw text for NON-restricted columns only. Restricted amount
   * columns are resolved by header label (`resolveHeaderMapping(...).restrictedColumns`)
   * and removed from this public map; ordinary text in other columns (including
   * letters I/J/Y after a column reorder) is preserved.
   */
  cells: Record<string, string>;
  rowSha256: string;
}

export interface ProductSourceBatchAmountRow {
  rowNumber: number;
  /**
   * Semantic restricted amount keys resolved from the actual header mapping
   * (never fixed column letters). Only ever stored in the private evidence table.
   */
  payload: Partial<Record<RestrictedAmountKey, string>>;
}

export interface ProductSourceBatchPayload {
  snapshotKey: string;
  origin: SnapshotOrigin;
  capturedAt: string;
  sourceModifiedLabel: string | null;
  collection: SourceSnapshotCollection;
  /** sha256 over canonical batch rows. */
  rowsSha256: string;
  /** sha256 over the canonical adoption updates of the matching plan. */
  adoptionSha256: string;
  /** null for a normal batch; the retried batch id for a retry-of-failed-items batch. */
  retryOfBatchId: string | null;
  parentBatchId: string | null;
  simulationNote: string | null;
  artifacts: BatchArtifact[];
  rows: ProductSourceBatchRow[];
  amounts: ProductSourceBatchAmountRow[];
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/**
 * Deterministic JSON serialization (object keys sorted, no whitespace).
 * Used for every sha256 in this feature so hashes are stable across engines.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (type === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const item = record[key];
      if (item === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${canonicalJson(item)}`);
    }
    return `{${parts.join(',')}}`;
  }
  throw new Error(`CANONICAL_JSON_UNSUPPORTED:${type}`);
}

/** Snapshot content version payload (rows + collection, per specification §3). */
export function snapshotContentPayload(snapshot: Pick<SourceSnapshot, 'collection' | 'rows'>): string {
  return canonicalJson({ collection: snapshot.collection, rows: snapshot.rows });
}
