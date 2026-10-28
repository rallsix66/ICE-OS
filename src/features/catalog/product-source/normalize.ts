/**
 * Source value normalization.
 *
 * Rules (specification §2/§4):
 * - every mapped cell is classified as observed / explicit_empty / not_read /
 *   parse_failed; only `observed` values may ever be adopted;
 * - blank cells never clear local values;
 * - formula error text is parse_failed with SOURCE_FORMULA_ERROR;
 * - numeric fields must parse as finite numbers; cartonQuantity must be a
 *   positive integer (validated as 件/箱, no unit conversion is performed);
 * - restricted amount columns are never classified here.
 */
import type { FieldObservation } from '../types';
import {
  FIELD_UNITS,
  IMAGE_NOT_READ_BY_SNAPSHOT,
  INVALID_CARTON_QUANTITY,
  PRODUCT_SOURCE_FIELD_KEYS,
  SOURCE_FORMULA_ERROR,
  SOURCE_VALUE_NOT_NUMERIC,
  isNumericFieldKey,
  type ProductSourceFieldKey,
  type SourceCell,
} from './contract';

export const SOURCE_FORMULA_ERROR_PATTERN = /^#(N\/A|REF!|VALUE!|DIV\/0!|NAME\?|NUM!|NULL!)$/;
/** Accepts plain decimals and scientific notation (B2/Excel exports use `8.50e-05`). */
const NUMERIC_TEXT_PATTERN = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?$/;
const POSITIVE_INTEGER_TEXT_PATTERN = /^[1-9]\d*$/;

export function isSourceFormulaError(raw: string): boolean {
  return SOURCE_FORMULA_ERROR_PATTERN.test(normalizeCellText(raw));
}

/** Outer whitespace only; internal text (including line breaks) is preserved. */
export function normalizeCellText(raw: string): string {
  return raw.replace(/\u00a0/g, ' ').trim();
}

export function parseNumericValue(raw: string): number | null {
  const text = normalizeCellText(raw);
  if (!NUMERIC_TEXT_PATTERN.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

export function isPositiveIntegerText(raw: string): boolean {
  const text = normalizeCellText(raw);
  if (!POSITIVE_INTEGER_TEXT_PATTERN.test(text)) return false;
  const value = Number(text);
  return Number.isSafeInteger(value) && value > 0;
}

/** Canonical comparison text. Numeric fields compare by value, not by spelling. */
export function normalizeForCompare(fieldKey: ProductSourceFieldKey, raw: string | null): string | null {
  if (raw === null) return null;
  const text = normalizeCellText(raw);
  if (text === '') return null;
  if (isNumericFieldKey(fieldKey)) {
    const value = parseNumericValue(text);
    if (value === null) return text;
    return String(value);
  }
  return text;
}

/**
 * Value equality used for three-way comparison and duplicate-row consistency.
 *
 * Numeric adoptable fields compare with tolerance (`|a-b| <= 1e-9` or relative
 * difference `<= 1e-5`) so display-precision drift such as
 * `0.000169384421052632` vs `0.000169384` does not create fake revisions.
 * `cartonQuantity` compares strictly (positive integer). Non-numeric text
 * compares after trimming only (case and internal whitespace are significant;
 * iceCode is case-sensitive by contract).
 */
export const NUMERIC_ABS_TOLERANCE = 1e-9;
export const NUMERIC_REL_TOLERANCE = 1e-5;

export function numericValuesMatch(left: number, right: number): boolean {
  const difference = Math.abs(left - right);
  if (difference <= NUMERIC_ABS_TOLERANCE) return true;
  const scale = Math.max(Math.abs(left), Math.abs(right));
  return scale > 0 && difference / scale <= NUMERIC_REL_TOLERANCE;
}

export function areSameFieldValue(
  fieldKey: ProductSourceFieldKey,
  leftRaw: string | null,
  rightRaw: string | null,
): boolean {
  const left = leftRaw === null ? null : normalizeCellText(leftRaw);
  const right = rightRaw === null ? null : normalizeCellText(rightRaw);
  if (left === null || left === '') return right === null || right === '';
  if (right === null || right === '') return false;
  if (fieldKey === 'cartonQuantity') {
    return isPositiveIntegerText(left) && isPositiveIntegerText(right) ? Number(left) === Number(right) : left === right;
  }
  if (isNumericFieldKey(fieldKey)) {
    const leftNumber = parseNumericValue(left);
    const rightNumber = parseNumericValue(right);
    if (leftNumber !== null && rightNumber !== null) return numericValuesMatch(leftNumber, rightNumber);
    return left === right;
  }
  return left === right;
}

export function areSameValue(fieldKey: ProductSourceFieldKey, left: string | null, right: string | null): boolean {
  return areSameFieldValue(fieldKey, left, right);
}

/** Classify one mapped source cell. Restricted amount columns never reach here. */
export function classifyFieldCell(fieldKey: ProductSourceFieldKey, raw: string): SourceCell {
  if (fieldKey === 'imageRef') {
    return { raw: '', state: 'not_read', reason: IMAGE_NOT_READ_BY_SNAPSHOT };
  }
  const text = normalizeCellText(raw);
  if (text === '') return { raw: '', state: 'explicit_empty', meaning: 'explicit_empty' };
  if (isSourceFormulaError(text)) return { raw: text, state: 'parse_failed', reason: SOURCE_FORMULA_ERROR };
  if (fieldKey === 'cartonQuantity') {
    if (!isPositiveIntegerText(text)) return { raw: text, state: 'parse_failed', reason: INVALID_CARTON_QUANTITY };
  } else if (isNumericFieldKey(fieldKey)) {
    if (parseNumericValue(text) === null) return { raw: text, state: 'parse_failed', reason: SOURCE_VALUE_NOT_NUMERIC };
  }
  return { raw: text, state: 'observed', meaning: 'value' };
}

/** Build the mapped field map for one source row from its cells. */
export function buildRowFields(
  cells: Record<string, string>,
  fieldColumns: Partial<Record<ProductSourceFieldKey, string>>,
): Record<string, SourceCell> {
  const fields: Record<string, SourceCell> = {};
  for (const fieldKey of PRODUCT_SOURCE_FIELD_KEYS) {
    const column = fieldColumns[fieldKey];
    if (!column) {
      fields[fieldKey] = { raw: '', state: 'not_read', reason: 'HEADER_COLUMN_NOT_MAPPED' };
      continue;
    }
    fields[fieldKey] = classifyFieldCell(fieldKey, cells[column] ?? '');
  }
  return fields;
}

export function sourceEvidenceRef(snapshotKey: string, rowNumber: number, fieldKey: string): string {
  return `source:${snapshotKey}#row=${rowNumber}&field=${fieldKey}`;
}

/**
 * Convert an observed source cell into the catalog FieldObservation contract.
 * Returns null for cells that must never be adopted (blank / not read / failed);
 * unit state is never placed inside FieldObservation.
 */
export function fieldObservationFromSource(cell: SourceCell, evidenceRef: string): FieldObservation | null {
  if (cell.state === 'observed') {
    return { state: 'observed', raw: cell.raw, meaning: cell.meaning ?? 'value', evidenceRef };
  }
  if (cell.state === 'not_read') {
    return { state: 'not_read', raw: null, reason: cell.reason ?? IMAGE_NOT_READ_BY_SNAPSHOT, evidenceRef };
  }
  if (cell.state === 'parse_failed') {
    return { state: 'parse_failed', raw: null, reason: cell.reason ?? SOURCE_VALUE_NOT_NUMERIC, evidenceRef };
  }
  return null;
}

export function localRawOf(observation: FieldObservation | undefined | null): string | null {
  if (!observation) return null;
  if (observation.state !== 'observed') return null;
  if (observation.raw === null) return null;
  const text = normalizeCellText(observation.raw);
  return text === '' ? null : text;
}

export function isLocalFieldEmpty(observation: FieldObservation | undefined | null): boolean {
  return localRawOf(observation) === null;
}

export function unitStateOf(fieldKey: ProductSourceFieldKey) {
  return FIELD_UNITS[fieldKey].state;
}

export function unitLabelOf(fieldKey: ProductSourceFieldKey): string | null {
  return FIELD_UNITS[fieldKey].label;
}
