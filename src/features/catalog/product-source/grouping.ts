/**
 * Source row grouping by ICE code.
 *
 * Identity is the trimmed, case-sensitive ICE code (G column). Row numbers are
 * evidence only and never participate in identity, so row reorder cannot change
 * which rows belong to one logical code. Rows without a code are kept apart and
 * handled as `missing_code` candidates.
 */
import type { CodeGroup, SourceRow, SourceSnapshot } from './contract';
import { normalizeCellText } from './normalize';

export interface SnapshotGrouping {
  codeGroups: CodeGroup[];
  missingCodeRows: SourceRow[];
  emptyRowCount: number;
}

export interface CodeGrouping {
  codeGroups: Map<string, SourceRow[]>;
  missingCodeRows: SourceRow[];
}

/** Trimmed ICE code of a source row, or null when the row has no code. */
export function sourceIceCode(row: SourceRow): string | null {
  const cell = row.fields.iceCode;
  if (!cell || cell.state !== 'observed') return null;
  const code = normalizeCellText(cell.raw);
  return code === '' ? null : code;
}

export function groupByCodeMap(rows: readonly SourceRow[]): CodeGrouping {
  const codeGroups = new Map<string, SourceRow[]>();
  const missingCodeRows: SourceRow[] = [];
  for (const row of rows) {
    if (!row.isBusinessRow) continue;
    const code = sourceIceCode(row);
    if (code === null) {
      missingCodeRows.push(row);
      continue;
    }
    const existing = codeGroups.get(code);
    if (existing) existing.push(row);
    else codeGroups.set(code, [row]);
  }
  return { codeGroups, missingCodeRows };
}

/** Group a snapshot's business rows; code groups and missing-code rows are both deterministic. */
export function groupSourceRows(snapshot: SourceSnapshot): SnapshotGrouping {
  const grouped = groupByCodeMap(snapshot.rows);
  const codeGroups: CodeGroup[] = [...grouped.codeGroups.entries()]
    .map(([code, rows]) => ({ code, rows: [...rows].sort((left, right) => left.rowNumber - right.rowNumber) }))
    .sort((left, right) => (left.code < right.code ? -1 : left.code > right.code ? 1 : 0));
  const missingCodeRows = [...grouped.missingCodeRows].sort((left, right) => left.rowNumber - right.rowNumber);
  return { codeGroups, missingCodeRows, emptyRowCount: snapshot.collection.emptyRowCount };
}

/** Row-only helper (no snapshot collection); emptyRowCount is not applicable. */
export function groupByCode(rows: readonly SourceRow[]): SnapshotGrouping {
  const grouped = groupByCodeMap(rows);
  return {
    codeGroups: [...grouped.codeGroups.entries()]
      .map(([code, groupRows]) => ({ code, rows: [...groupRows].sort((left, right) => left.rowNumber - right.rowNumber) }))
      .sort((left, right) => (left.code < right.code ? -1 : left.code > right.code ? 1 : 0)),
    missingCodeRows: [...grouped.missingCodeRows].sort((left, right) => left.rowNumber - right.rowNumber),
    emptyRowCount: 0,
  };
}
