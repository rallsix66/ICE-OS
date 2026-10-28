/**
 * Duplicate-code / missing-code / suspected-code anomaly detection and row
 * evaluation. This is the single place that decides whether a logical source
 * row may feed the three-way diff.
 *
 * Duplicate-code consistency is STRICT (Lead decision 2026-10-25): any adoptable
 * field that differs between rows — including blank vs non-blank — makes the
 * whole code inconsistent. There is no "take the first/last/highest-date row"
 * merging. Real WM0069/WM0070/WM0071/WM0073 therefore become needs_review
 * (barcode blank vs value), while WM0072 (barcode consistent) can merge.
 */
import type {
  AdoptableFieldKey,
  CodeGroup,
  ProductSourceFieldKey,
  ProductSourceReasonCode,
  SourceCell,
  SourceFieldConflict,
  SourceFieldNote,
  SourceRow,
  SourceRowEvaluation,
  SourceSnapshot,
} from './contract';
import {
  CONSISTENCY_FIELD_KEYS,
  DUPLICATE_CODE_INCONSISTENT,
  IMAGE_NOT_READ_BY_SNAPSHOT,
  INVALID_CARTON_QUANTITY,
  MISSING_CODE,
  PRODUCT_SOURCE_FIELD_KEYS,
  SOURCE_FORMULA_ERROR,
  SOURCE_VALUE_NOT_NUMERIC,
  codeSourceKey,
  rowSourceKey,
} from './contract';
import { areSameFieldValue, normalizeCellText } from './normalize';
import { groupSourceRows, type SnapshotGrouping } from './grouping';

export { validateSnapshot, resolveHeaderColumns, resolveHeaderMapping } from './headers';

function cellSignature(cell: SourceCell): string {
  switch (cell.state) {
    case 'observed':
      return `v:${cell.raw}`;
    case 'explicit_empty':
      return 'e';
    case 'parse_failed':
      return `f:${cell.reason ?? ''}`;
    case 'not_read':
      return `n:${cell.reason ?? ''}`;
    default:
      return 'unknown';
  }
}

/** True when two cells of the same field are equivalent under contract equality. */
export function cellsEquivalent(fieldKey: ProductSourceFieldKey, left: SourceCell, right: SourceCell): boolean {
  if (left.state !== right.state) {
    // explicit_empty vs observed-blank are the same thing; treat observed '' as empty.
    const leftEmpty = left.state === 'explicit_empty' || (left.state === 'observed' && normalizeCellText(left.raw) === '');
    const rightEmpty = right.state === 'explicit_empty' || (right.state === 'observed' && normalizeCellText(right.raw) === '');
    if (leftEmpty && rightEmpty) return true;
    return false;
  }
  if (left.state === 'observed') return areSameFieldValue(fieldKey, left.raw, right.raw);
  return cellSignature(left) === cellSignature(right);
}

function conflictValues(rows: SourceRow[], fieldKey: AdoptableFieldKey): SourceFieldConflict['values'] {
  const values: SourceFieldConflict['values'] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const cell = row.fields[fieldKey] ?? { raw: '', state: 'explicit_empty' as const };
    const signature = cellSignature(cell);
    if (seen.has(signature)) continue;
    seen.add(signature);
    values.push({
      rowNumber: row.rowNumber,
      raw: cell.state === 'observed' ? cell.raw : null,
      state: cell.state,
    });
  }
  return values;
}

function rowFieldIssues(row: SourceRow): SourceFieldNote[] {
  const notes: SourceFieldNote[] = [];
  for (const fieldKey of PRODUCT_SOURCE_FIELD_KEYS) {
    if (fieldKey === 'imageRef') continue;
    const cell = row.fields[fieldKey];
    if (!cell || cell.state !== 'parse_failed') continue;
    notes.push({ rowNumber: row.rowNumber, fieldKey, reason: cell.reason ?? SOURCE_VALUE_NOT_NUMERIC, raw: cell.raw });
  }
  return notes;
}

/** Merge equivalent duplicate rows into one logical input (rows must be consistent). */
function mergeConsistentRows(rows: SourceRow[]): Record<ProductSourceFieldKey, SourceCell> {
  const merged = {} as Record<ProductSourceFieldKey, SourceCell>;
  const first = rows[0];
  if (!first) throw new Error('MERGE_REQUIRES_AT_LEAST_ONE_ROW');
  for (const fieldKey of PRODUCT_SOURCE_FIELD_KEYS) {
    if (fieldKey === 'imageRef') {
      merged[fieldKey] = { raw: '', state: 'not_read', reason: IMAGE_NOT_READ_BY_SNAPSHOT };
      continue;
    }
    if (fieldKey === 'sourceDate' || !CONSISTENCY_FIELD_KEYS.includes(fieldKey as AdoptableFieldKey)) {
      // Static evidence fields: take the first observed cell (never adopted / never compared).
      const observed = rows.find((row) => row.fields[fieldKey]?.state === 'observed');
      merged[fieldKey] = observed ? observed.fields[fieldKey] : first.fields[fieldKey];
      continue;
    }
    const observed = rows.find((row) => row.fields[fieldKey]?.state === 'observed');
    if (observed) {
      merged[fieldKey] = observed.fields[fieldKey];
      continue;
    }
    merged[fieldKey] = first.fields[fieldKey];
  }
  return merged;
}

function mergeSingleRow(row: SourceRow): Record<ProductSourceFieldKey, SourceCell> {
  return mergeConsistentRows([row]);
}

export function evaluateCodeGroup(group: CodeGroup): SourceRowEvaluation {
  const rows = [...group.rows].sort((left, right) => left.rowNumber - right.rowNumber);
  const conflicts: SourceFieldConflict[] = [];
  for (const fieldKey of CONSISTENCY_FIELD_KEYS) {
    const reference = rows[0]?.fields[fieldKey];
    if (!reference) continue;
    const inconsistent = rows.some((row) => {
      const cell = row.fields[fieldKey];
      return !cell || !cellsEquivalent(fieldKey, reference, cell);
    });
    if (!inconsistent) continue;
    const values = conflictValues(rows, fieldKey);
    if (values.length > 1) conflicts.push({ fieldKey, values });
  }

  const fieldIssues = rows.flatMap(rowFieldIssues);
  const notes: string[] = [];
  if (rows.length > 1) notes.push(`同号共 ${rows.length} 行`);
  const sourceDates = new Set(
    rows.map((row) => row.fields.sourceDate?.raw ?? '').filter((raw) => normalizeCellText(raw) !== ''),
  );
  if (sourceDates.size > 1) notes.push('同号多行日期不同；日期仅作静态资料，不参与一致性比较与采用');

  const rowNumbers = rows.map((row) => row.rowNumber);
  if (conflicts.length > 0) {
    return {
      sourceKey: codeSourceKey(group.code),
      iceCode: group.code,
      rowNumbers,
      classification: 'inconsistent',
      reasonCode: DUPLICATE_CODE_INCONSISTENT,
      logicalFields: null,
      conflicts,
      fieldIssues,
      notes,
    };
  }
  return {
    sourceKey: codeSourceKey(group.code),
    iceCode: group.code,
    rowNumbers,
    classification: 'consistent',
    reasonCode: null,
    logicalFields: mergeConsistentRows(rows),
    conflicts: [],
    fieldIssues,
    notes,
  };
}

export function evaluateMissingCodeRow(row: SourceRow): SourceRowEvaluation {
  return {
    sourceKey: rowSourceKey(row.rowNumber),
    iceCode: null,
    rowNumbers: [row.rowNumber],
    classification: 'missing_code',
    reasonCode: MISSING_CODE,
    logicalFields: mergeSingleRow(row),
    conflicts: [],
    fieldIssues: rowFieldIssues(row),
    notes: [],
  };
}

/** Evaluate every business row: code groups by code asc, then missing-code rows by row number. */
export function evaluateSourceRows(snapshot: SourceSnapshot): SourceRowEvaluation[] {
  const grouping: SnapshotGrouping = groupSourceRows(snapshot);
  const codeEvaluations = grouping.codeGroups.map(evaluateCodeGroup);
  const missingEvaluations = grouping.missingCodeRows.map(evaluateMissingCodeRow);
  return [...codeEvaluations, ...missingEvaluations];
}

export interface SuspectedCodeCandidate {
  itemId: string;
  iceCode: string;
  nameCn: string;
  barcode: string | null;
  /** Last adopted source name (baseline), when known. */
  adoptionNameCn: string | null;
  /** Last adopted source barcode (baseline), when known. */
  adoptionBarcode: string | null;
}

export interface SuspectedCodeMatch {
  suspected: boolean;
  matchedItemId: string | null;
  matchedBy: 'barcode' | 'nameCn' | null;
}

/**
 * Detect a suspected code change: an unbound source code whose barcode or
 * Chinese name equals a bound item's current/baseline value. Never create or
 * re-bind automatically.
 */
export function detectSuspectedCodeChange(input: {
  iceCode: string;
  logicalFields: Record<ProductSourceFieldKey, SourceCell>;
  candidates: SuspectedCodeCandidate[];
}): SuspectedCodeMatch {
  const barcodeCell = input.logicalFields.barcode;
  const nameCell = input.logicalFields.nameCn;
  const barcode = barcodeCell?.state === 'observed' ? normalizeCellText(barcodeCell.raw) : '';
  const nameCn = nameCell?.state === 'observed' ? normalizeCellText(nameCell.raw) : '';
  const candidates = [...input.candidates]
    .filter((candidate) => candidate.iceCode !== input.iceCode)
    .sort((left, right) => (left.itemId < right.itemId ? -1 : left.itemId > right.itemId ? 1 : 0));

  if (barcode !== '') {
    for (const candidate of candidates) {
      if (candidate.barcode !== null && normalizeCellText(candidate.barcode) === barcode) {
        return { suspected: true, matchedItemId: candidate.itemId, matchedBy: 'barcode' };
      }
      if (candidate.adoptionBarcode !== null && normalizeCellText(candidate.adoptionBarcode) === barcode) {
        return { suspected: true, matchedItemId: candidate.itemId, matchedBy: 'barcode' };
      }
    }
  }
  if (nameCn !== '') {
    for (const candidate of candidates) {
      if (normalizeCellText(candidate.nameCn) === nameCn) {
        return { suspected: true, matchedItemId: candidate.itemId, matchedBy: 'nameCn' };
      }
      if (candidate.adoptionNameCn !== null && normalizeCellText(candidate.adoptionNameCn) === nameCn) {
        return { suspected: true, matchedItemId: candidate.itemId, matchedBy: 'nameCn' };
      }
    }
  }
  return { suspected: false, matchedItemId: null, matchedBy: null };
}

/** Exact-name hint for a missing-code row against existing items that still have no code. */
export function matchUncodedItemByName(
  nameCn: string,
  uncodedItems: { itemId: string; nameCn: string }[],
): { itemId: string; nameCn: string } | null {
  const target = normalizeCellText(nameCn);
  if (target === '') return null;
  const matches = uncodedItems
    .filter((item) => normalizeCellText(item.nameCn) === target)
    .sort((left, right) => (left.itemId < right.itemId ? -1 : left.itemId > right.itemId ? 1 : 0));
  return matches[0] ?? null;
}

/** Field-level issue kind mapping for parse failures (no price values involved). */
export function fieldIssueKind(reason: string): 'formula_error' | 'invalid_value' {
  return reason === SOURCE_FORMULA_ERROR ? 'formula_error' : 'invalid_value';
}

/** Reason code for one parse-failed field (used for result reason selection). */
export function fieldIssueReasonCode(reason: string): ProductSourceReasonCode {
  if (reason === SOURCE_FORMULA_ERROR) return SOURCE_FORMULA_ERROR;
  if (reason === INVALID_CARTON_QUANTITY) return INVALID_CARTON_QUANTITY;
  return SOURCE_VALUE_NOT_NUMERIC;
}
