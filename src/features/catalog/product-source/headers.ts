/**
 * Header contract resolution and snapshot validation.
 *
 * Headers are matched strictly by their exact (trimmed, whitespace-collapsed)
 * Chinese label. Column letters are recorded only as evidence for this capture;
 * they are never used to decide which field a column holds, so column reorder
 * cannot change semantics.
 */
import {
  HEADER_CONTRACT,
  HEADER_FIELD_MAP,
  KNOWN_HEADER_LABELS,
  SNAPSHOT_CONTRACT,
  type ProductSourceFieldKey,
  type RestrictedAmountKey,
  type SnapshotIssue,
  type SnapshotValidation,
  type SourceSnapshot,
} from './contract';

export type HeaderMappingIssueCode = 'unknown_header' | 'duplicate_header' | 'missing_header';

export interface HeaderMappingIssue {
  code: HeaderMappingIssueCode;
  detail: string;
  label: string | null;
}

export interface HeaderResolution {
  ok: boolean;
  /** Product field key -> column letter in this snapshot. */
  fieldColumns: Partial<Record<ProductSourceFieldKey, string>>;
  /** Restricted amount key -> column letter in this snapshot (evidence only). */
  restrictedColumns: Partial<Record<RestrictedAmountKey, string>>;
  /** Non-empty headers that are not part of the 27-label contract (would be ignored). */
  unknownHeaders: { column: string; label: string }[];
  duplicateHeaders: { column: string; label: string }[];
  missingLabels: string[];
  issues: HeaderMappingIssue[];
}

/** Whitespace collapsing only: punctuation (full-width/ASCII parens) is significant. */
export function normalizeHeaderLabel(raw: string): string {
  return raw.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 1-based column index for A..Z, AA..AE style letters; throws on invalid input. */
export function columnIndex(column: string): number {
  const letters = normalizeHeaderLabel(column).toUpperCase();
  if (!/^[A-Z]+$/.test(letters)) throw new Error(`COLUMN_LETTER_INVALID:${column}`);
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index;
}

export function compareColumnLetters(left: string, right: string): number {
  return columnIndex(left) - columnIndex(right);
}

export function resolveHeaderMapping(headers: Record<string, string>): HeaderResolution {
  const fieldColumns: Partial<Record<ProductSourceFieldKey, string>> = {};
  const restrictedColumns: Partial<Record<RestrictedAmountKey, string>> = {};
  const unknownHeaders: { column: string; label: string }[] = [];
  const duplicateHeaders: { column: string; label: string }[] = [];
  const issues: HeaderMappingIssue[] = [];
  const assigned = new Map<string, string>();

  const columns = Object.keys(headers).sort(compareColumnLetters);
  for (const column of columns) {
    const label = normalizeHeaderLabel(headers[column] ?? '');
    if (label === '') continue; // Unknown empty header columns (AB..AE) are ignored.
    const entry = HEADER_FIELD_MAP[label];
    if (!entry) {
      unknownHeaders.push({ column, label });
      issues.push({ code: 'unknown_header', label, detail: `列 ${column} 的表头「${label}」不在 27 个已知表头内` });
      continue;
    }
    const previous = assigned.get(label);
    if (previous) {
      duplicateHeaders.push({ column, label });
      issues.push({ code: 'duplicate_header', label, detail: `表头「${label}」重复出现在 ${previous} 与 ${column}` });
      continue;
    }
    assigned.set(label, column);
    if (entry.fieldKey) fieldColumns[entry.fieldKey] = column;
    else if (entry.restrictedKey) restrictedColumns[entry.restrictedKey] = column;
  }

  const missingLabels = KNOWN_HEADER_LABELS.filter((label) => !assigned.has(label));
  for (const label of missingLabels) {
    issues.push({ code: 'missing_header', label, detail: `缺少已知表头「${label}」` });
  }

  return {
    ok: issues.length === 0,
    fieldColumns,
    restrictedColumns,
    unknownHeaders,
    duplicateHeaders,
    missingLabels,
    issues,
  };
}

export interface HeaderColumnResolution {
  columnsByField: Partial<Record<string, string>>;
  headers: Record<string, string>;
  issues: SnapshotIssue[];
}

/** Service-facing wrapper: resolve the field -> column mapping of one snapshot. */
export function resolveHeaderColumns(snapshot: SourceSnapshot): HeaderColumnResolution {
  const resolution = resolveHeaderMapping(snapshot.collection.headers);
  const issues: SnapshotIssue[] = resolution.issues.map((issue) => ({
    code: 'HEADER_CONTRACT_INVALID',
    detail: issue.detail,
  }));
  return { columnsByField: resolution.fieldColumns, headers: snapshot.collection.headers, issues };
}

const SNAPSHOT_ISSUE_ORDER: SnapshotIssue['code'][] = [
  'SNAPSHOT_CONTRACT_INVALID',
  'SNAPSHOT_PROFILE_MISMATCH',
  'HEADER_CONTRACT_INVALID',
  'COLUMN_COUNT_INVALID',
  'CAPTURE_INCOMPLETE',
  'SNAPSHOT_ROW_INVALID',
  'SNAPSHOT_EMPTY_PAYLOAD',
];

/**
 * Validate one captured snapshot before any plan is built.
 *
 * Header contract → column counts → capture completeness (complete &&
 * !truncated && no read error) → business/empty row arithmetic. Any issue makes
 * the batch fail (`rejected_invalid`); the previously applied data is untouched.
 */
export function validateSnapshot(snapshot: SourceSnapshot): SnapshotValidation {
  const issues: SnapshotIssue[] = [];
  const add = (code: SnapshotIssue['code'], detail: string) => {
    if (!issues.some((issue) => issue.code === code && issue.detail === detail)) issues.push({ code, detail });
  };

  if (snapshot.contract !== SNAPSHOT_CONTRACT) {
    add('SNAPSHOT_CONTRACT_INVALID', `快照契约应为 ${SNAPSHOT_CONTRACT}，实际为 ${String(snapshot.contract)}`);
  }
  if (!snapshot.profileKey || snapshot.profileKey !== snapshot.profileKey.trim()) {
    add('SNAPSHOT_PROFILE_MISMATCH', '来源 profileKey 缺失或首尾含空白');
  }

  const collection = snapshot.collection;
  if (!collection || typeof collection !== 'object') {
    add('SNAPSHOT_EMPTY_PAYLOAD', '快照缺少 collection');
    return { ok: false, status: 'failed', issues: sortIssues(issues) };
  }
  if (collection.headerRow !== 1) {
    add('HEADER_CONTRACT_INVALID', `表头行应为第 1 行，实际为 ${String(collection.headerRow)}`);
  }

  const resolution = resolveHeaderMapping(collection.headers ?? {});
  if (!resolution.ok) {
    for (const issue of resolution.issues) add('HEADER_CONTRACT_INVALID', issue.detail);
  }

  const headerColumns = Object.keys(collection.headers ?? {}).sort(compareColumnLetters);
  const headerSet = new Set(headerColumns);
  if (headerColumns.length !== collection.gridColumns) {
    add('COLUMN_COUNT_INVALID', `表头列数 ${headerColumns.length} 与网格列数 ${collection.gridColumns} 不一致`);
  }
  for (const row of snapshot.rows) {
    const cellColumns = Object.keys(row.cells);
    if (cellColumns.length !== collection.gridColumns) {
      add('COLUMN_COUNT_INVALID', `第 ${row.rowNumber} 行数据列数 ${cellColumns.length} 与表头列数 ${collection.gridColumns} 不一致`);
      continue;
    }
    if (cellColumns.some((column) => !headerSet.has(column))) {
      add('COLUMN_COUNT_INVALID', `第 ${row.rowNumber} 行含表头之外的列`);
    }
  }

  if (!collection.complete) add('CAPTURE_INCOMPLETE', '采集标记为不完整');
  if (collection.truncated) add('CAPTURE_INCOMPLETE', '采集内容被截断');
  if (collection.readError !== null) add('CAPTURE_INCOMPLETE', `采集读取失败：${collection.readError}`);

  const dataRowCount = collection.gridRows - collection.headerRow;
  if (snapshot.rows.length !== dataRowCount) {
    add('CAPTURE_INCOMPLETE', `快照行数 ${snapshot.rows.length} 与数据行总数 ${dataRowCount} 不一致`);
  }
  const businessRows = snapshot.rows.filter((row) => row.isBusinessRow);
  const emptyRows = snapshot.rows.filter((row) => !row.isBusinessRow);
  if (businessRows.length !== collection.businessRowCount) {
    add('CAPTURE_INCOMPLETE', `有效业务行数 ${businessRows.length} 与采集记录 ${collection.businessRowCount} 不一致`);
  }
  if (emptyRows.length !== collection.emptyRowCount) {
    add('CAPTURE_INCOMPLETE', `空行数 ${emptyRows.length} 与采集记录 ${collection.emptyRowCount} 不一致`);
  }
  if (businessRows.length === 0) add('SNAPSHOT_EMPTY_PAYLOAD', '快照没有有效业务行');

  const seenRowNumbers = new Set<number>();
  for (const row of snapshot.rows) {
    if (!Number.isInteger(row.rowNumber) || row.rowNumber <= collection.headerRow || row.rowNumber > collection.gridRows) {
      add('SNAPSHOT_ROW_INVALID', `行号 ${String(row.rowNumber)} 超出 1..${collection.gridRows} 的工作表范围`);
      continue;
    }
    if (seenRowNumbers.has(row.rowNumber)) add('SNAPSHOT_ROW_INVALID', `行号 ${row.rowNumber} 重复`);
    seenRowNumbers.add(row.rowNumber);
  }
  if (seenRowNumbers.size !== dataRowCount) {
    add('SNAPSHOT_ROW_INVALID', `已记录行号 ${seenRowNumbers.size} 未覆盖全部数据行 ${dataRowCount}`);
  }

  return { ok: issues.length === 0, status: issues.length === 0 ? 'validated' : 'failed', issues: sortIssues(issues) };
}

function sortIssues(issues: SnapshotIssue[]): SnapshotIssue[] {
  return [...issues].sort((left, right) => {
    const order = SNAPSHOT_ISSUE_ORDER.indexOf(left.code) - SNAPSHOT_ISSUE_ORDER.indexOf(right.code);
    return order !== 0 ? order : left.detail.localeCompare(right.detail);
  });
}

/** Evidence-only helper: observed column letter for a field in the contract order. */
export function contractColumnEvidence(fieldKey: ProductSourceFieldKey): string | null {
  const entry = HEADER_CONTRACT.find((candidate) => candidate.fieldKey === fieldKey);
  return entry ? entry.evidenceColumn : null;
}

export function restrictedColumnEvidence(restrictedKey: RestrictedAmountKey): string | null {
  const entry = HEADER_CONTRACT.find((candidate) => candidate.restrictedKey === restrictedKey);
  return entry ? entry.evidenceColumn : null;
}
