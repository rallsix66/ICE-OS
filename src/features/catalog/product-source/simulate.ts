/**
 * Local simulation generator.
 *
 * Builds the two simulated snapshots (002 business changes, 003 identical content
 * with rows+columns reordered) from a real captured snapshot. Simulated snapshots
 * are always `origin: 'local_simulation'` with `simulation.baseSnapshotKey` set,
 * and are never written back to the real snapshot. Restricted amount columns are
 * never simulated/changed; they stay blank in the redacted fixture base.
 *
 * Wording is always "本地模拟变化，非飞书真实修改".
 */
import { SNAPSHOT_CONTRACT, type SimulatedChange, type SourceRow, type SourceSnapshot } from './contract';
import { compareColumnLetters, resolveHeaderMapping } from './headers';
import { buildRowFields, normalizeCellText, parseNumericValue } from './normalize';
import { computeRowSha256, computeSnapshotKey } from './reader';

const SIMULATION_NOTE = '本地模拟变化，非飞书真实修改';

interface GridRow {
  rowNumber: number;
  isBusinessRow: boolean;
  cells: Record<string, string>;
}

interface Grid {
  headers: Record<string, string>;
  rows: GridRow[];
  gridRows: number;
  emptyRowCount: number;
}

function gridFromSnapshot(snapshot: SourceSnapshot): Grid {
  return {
    headers: { ...snapshot.collection.headers },
    rows: snapshot.rows.map((row) => ({
      rowNumber: row.rowNumber,
      isBusinessRow: row.isBusinessRow,
      cells: { ...row.cells },
    })),
    gridRows: snapshot.collection.gridRows,
    emptyRowCount: snapshot.collection.emptyRowCount,
  };
}

function columnOf(headers: Record<string, string>, fieldKey: string): string | null {
  const resolution = resolveHeaderMapping(headers);
  const columns = resolution.fieldColumns as Record<string, string | undefined>;
  return columns[fieldKey] ?? null;
}

function finalize(
  base: SourceSnapshot,
  grid: Grid,
  params: { capturedAt: string; note: string; changes: SimulatedChange[] },
): SourceSnapshot {
  const resolution = resolveHeaderMapping(grid.headers);
  if (!resolution.ok) throw new Error('SIMULATION_HEADER_INVALID');
  const rows: SourceRow[] = grid.rows.map((row) => {
    const fields = row.isBusinessRow ? buildRowFields(row.cells, resolution.fieldColumns) : {};
    return {
      rowNumber: row.rowNumber,
      isBusinessRow: row.isBusinessRow,
      cells: row.cells,
      fields,
      rowSha256: computeRowSha256({ rowNumber: row.rowNumber, cells: row.cells, fields }),
    };
  });
  const gridColumns = Object.keys(grid.headers).length;
  const lastColumn = Object.keys(grid.headers).sort(compareColumnLetters).at(-1) ?? 'AE';
  const businessRowCount = rows.filter((row) => row.isBusinessRow).length;
  const snapshot: SourceSnapshot = {
    contract: SNAPSHOT_CONTRACT,
    profileKey: base.profileKey,
    snapshotKey: '',
    origin: 'local_simulation',
    capturedAt: params.capturedAt,
    documentModifiedLabel: base.documentModifiedLabel,
    collection: {
      ...base.collection,
      headers: grid.headers,
      gridRows: grid.gridRows,
      gridColumns,
      businessRowCount,
      emptyRowCount: rows.length - businessRowCount,
      observedRange: `A1:${lastColumn}${grid.gridRows}`,
      complete: true,
      truncated: false,
      readError: null,
    },
    simulation: { baseSnapshotKey: base.snapshotKey, note: params.note, changes: params.changes },
    redaction: base.redaction ?? null,
    rows,
  };
  snapshot.snapshotKey = computeSnapshotKey(snapshot);
  return snapshot;
}

function codeOfRow(headers: Record<string, string>, row: GridRow): string | null {
  if (!row.isBusinessRow) return null;
  const codeColumn = columnOf(headers, 'iceCode');
  if (codeColumn === null) return null;
  const code = normalizeCellText(row.cells[codeColumn] ?? '');
  return code === '' ? null : code;
}

function uniqueCodes(grid: Grid): string[] {
  const counts = new Map<string, number>();
  for (const row of grid.rows) {
    const code = codeOfRow(grid.headers, row);
    if (code === null) continue;
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, count]) => count === 1).map(([code]) => code).sort();
}

function rowsOfCode(grid: Grid, code: string): GridRow[] {
  return grid.rows.filter((row) => codeOfRow(grid.headers, row) === code);
}

function setFieldOnRows(grid: Grid, rows: readonly GridRow[], fieldKey: string, raw: string): void {
  const column = columnOf(grid.headers, fieldKey);
  if (column === null) throw new Error(`SIMULATION_FIELD_COLUMN_MISSING:${fieldKey}`);
  for (const row of rows) row.cells[column] = raw;
}

function cellHasNumericValue(grid: Grid, row: GridRow | undefined, fieldKey: string): boolean {
  if (!row) return false;
  const column = columnOf(grid.headers, fieldKey);
  if (column === null) return false;
  return parseNumericValue(row.cells[column] ?? '') !== null;
}

function cellHasTextValue(grid: Grid, row: GridRow | undefined, fieldKey: string): boolean {
  if (!row) return false;
  const column = columnOf(grid.headers, fieldKey);
  if (column === null) return false;
  return normalizeCellText(row.cells[column] ?? '') !== '';
}

function incrementNumericCell(raw: string, delta: number): string {
  const value = parseNumericValue(raw);
  if (value === null) return String(delta);
  return String(Math.round((value + delta) * 1e6) / 1e6);
}

function nextCode(seed: string, existing: ReadonlySet<string>): string {
  const digits = seed.replace(/^[A-Za-z]+/, '');
  const base = `WM9${digits}`;
  if (!existing.has(base)) return base;
  let suffix = 1;
  while (existing.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function insertBusinessRow(grid: Grid, cells: Record<string, string>): GridRow {
  const rowNumber = grid.gridRows + 1;
  grid.gridRows = rowNumber;
  const row: GridRow = { rowNumber, isBusinessRow: true, cells };
  grid.rows.push(row);
  return row;
}

function clearedCellsForNewRow(grid: Grid): Record<string, string> {
  const template = grid.rows.find((row) => row.isBusinessRow) ?? grid.rows[0];
  const templateCells = template ? template.cells : {};
  const cells: Record<string, string> = {};
  for (const column of Object.keys(grid.headers)) cells[column] = templateCells[column] ?? '';
  const resolution = resolveHeaderMapping(grid.headers);
  for (const column of Object.values(resolution.fieldColumns)) {
    if (column) cells[column] = '';
  }
  for (const column of Object.values(resolution.restrictedColumns)) {
    if (column) cells[column] = '';
  }
  return cells;
}

function applyBusinessChanges(grid: Grid): SimulatedChange[] {
  const changes: SimulatedChange[] = [];
  const push = (entry: SimulatedChange) => changes.push(entry);

  const counts = new Map<string, number>();
  for (const row of grid.rows) {
    const code = codeOfRow(grid.headers, row);
    if (code === null) continue;
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  const unique = uniqueCodes(grid);
  const used = new Set<string>();
  const pickCode = (predicate: (row: GridRow | undefined) => boolean, preferred?: string): string => {
    if (preferred && unique.includes(preferred) && !used.has(preferred)) {
      if (predicate(rowsOfCode(grid, preferred)[0])) {
        used.add(preferred);
        return preferred;
      }
    }
    for (const code of unique) {
      if (used.has(code)) continue;
      if (!predicate(rowsOfCode(grid, code)[0])) continue;
      used.add(code);
      return code;
    }
    return '';
  };
  const firstRaw = (code: string, fieldKey: string): string => {
    const rows = rowsOfCode(grid, code);
    const column = columnOf(grid.headers, fieldKey);
    return column === null ? '' : normalizeCellText(rows[0]?.cells[column] ?? '');
  };

  // 1) Existing item: cartonQuantity value change.
  const changeCode = pickCode((row) => cellHasNumericValue(grid, row, 'cartonQuantity'), 'WM0072');
  if (changeCode !== '') {
    const rows = rowsOfCode(grid, changeCode);
    const before = firstRaw(changeCode, 'cartonQuantity');
    const after = incrementNumericCell(before, 20);
    setFieldOnRows(grid, rows, 'cartonQuantity', after);
    push({
      kind: 'field_change',
      sourceKey: `code:${changeCode}`,
      detail: `${changeCode} 装箱数量 ${before || '(空)'}→${after}（共 ${rows.length} 行）`,
    });
  }

  // 2) Same item rename: same UUID must be kept.
  const renameCode = pickCode(() => true, 'WM0072');
  if (renameCode !== '') {
    const rows = rowsOfCode(grid, renameCode);
    const before = firstRaw(renameCode, 'nameCn');
    const after = `${before}（模拟改名）`;
    setFieldOnRows(grid, rows, 'nameCn', after);
    push({
      kind: 'field_change',
      sourceKey: `code:${renameCode}`,
      detail: `${renameCode} 中文产品名称「${before}」→「${after}」（共 ${rows.length} 行）`,
    });
  }

  // 3) Specification column change on another existing item.
  const specCode = pickCode((row) => cellHasTextValue(grid, row, 'specification'));
  if (specCode !== '') {
    const before = firstRaw(specCode, 'specification');
    const after = `${before}（模拟规格）`;
    setFieldOnRows(grid, rowsOfCode(grid, specCode), 'specification', after);
    push({
      kind: 'field_change',
      sourceKey: `code:${specCode}`,
      detail: `${specCode} 规格「${before}」→「${after}」`,
    });
  }

  // 4) New item row (no prices).
  const newItemCells = clearedCellsForNewRow(grid);
  const newItemValues: Record<string, string> = {
    sourceDate: '2026/10/25',
    nameCn: 'ICE LERSKIN 模拟新品精华 30ml',
    specification: '30ml/瓶',
    englishName: 'ICE LERSKIN SIMULATED NEW SERUM 30ml',
    factory: '广州模拟化妆品有限公司',
    iceCode: 'WM9001',
    barcode: '6900000000019',
    length: '12',
    width: '4',
    height: '4',
    unitWeight: '0.12',
    cartonQuantity: '120',
    cartonLength: '50',
    cartonWidth: '38',
    cartonHeight: '22',
    cartonWeight: '15.5',
    liquid: '是',
    shelfLifeDays: '1095',
    cartonVolume: '0.0418',
    unitVolume: '0.000192',
    factoryLeadDays: '15',
    shippingDays: '20',
    sourceNote: '本地模拟新品，非飞书真实修改',
  };
  for (const [fieldKey, raw] of Object.entries(newItemValues)) {
    const column = columnOf(grid.headers, fieldKey);
    if (column) newItemCells[column] = raw;
  }
  const inserted = insertBusinessRow(grid, newItemCells);
  push({
    kind: 'row_inserted',
    sourceKey: 'code:WM9001',
    detail: `新增来源行（工作行 ${inserted.rowNumber}）：WM9001 ICE LERSKIN 模拟新品精华 30ml`,
  });

  // 5) Missing code: blank one unique item's code (it becomes a missing-code row).
  const missingCode = pickCode(() => true);
  if (missingCode !== '') {
    const rows = rowsOfCode(grid, missingCode);
    setFieldOnRows(grid, rows, 'iceCode', '');
    push({
      kind: 'code_missing',
      sourceKey: `code:${missingCode}`,
      detail: `${missingCode} 的货号被清空（行 ${rows.map((row) => row.rowNumber).join(',')}），已有商品本次未见`,
    });
  }

  // 6) Suspected code change: a known item keeps name/barcode but gets a new code.
  const suspectedCode = pickCode((row) => cellHasTextValue(grid, row, 'nameCn'));
  if (suspectedCode !== '') {
    const existing = new Set([...counts.keys(), 'WM9001']);
    const newCode = nextCode(suspectedCode, existing);
    setFieldOnRows(grid, rowsOfCode(grid, suspectedCode), 'iceCode', newCode);
    push({
      kind: 'code_suspected_changed',
      sourceKey: `code:${suspectedCode}`,
      detail: `${suspectedCode}→${newCode}（名称/条码不变，原货号本次未见，疑似改码）`,
    });
  }

  // 7) Formula error on an existing item.
  const formulaCode = pickCode((row) => cellHasNumericValue(grid, row, 'cartonVolume'));
  if (formulaCode !== '') {
    setFieldOnRows(grid, rowsOfCode(grid, formulaCode), 'cartonVolume', '#DIV/0!');
    push({
      kind: 'formula_error',
      sourceKey: `code:${formulaCode}`,
      detail: `${formulaCode} 单箱立方被改为公式错误值 #DIV/0!（不得采用）`,
    });
  }

  // 8) Blanked source field (source "cleared") on an existing item.
  const blankCode = pickCode((row) => cellHasTextValue(grid, row, 'factory'));
  if (blankCode !== '') {
    setFieldOnRows(grid, rowsOfCode(grid, blankCode), 'factory', '');
    push({
      kind: 'blanked',
      sourceKey: `code:${blankCode}`,
      detail: `${blankCode} 生产工厂被清空（来源空白不得覆盖本地值）`,
    });
  }

  // 9) Unconfirmed-unit field change on an existing item (cartonWeight: unit
  // unconfirmed and outside the blocking carton-dimensions group).
  const unitCode = pickCode((row) => cellHasNumericValue(grid, row, 'cartonWeight'));
  if (unitCode !== '') {
    const before = firstRaw(unitCode, 'cartonWeight');
    const after = incrementNumericCell(before, 5);
    setFieldOnRows(grid, rowsOfCode(grid, unitCode), 'cartonWeight', after);
    push({
      kind: 'field_change',
      sourceKey: `code:${unitCode}`,
      detail: `${unitCode} 单箱重量 ${before}→${after}（表头无单位，未确认单位字段）`,
    });
  }

  // 10) Invalid numeric value on an existing item (cartonQuantity must be a positive integer).
  const invalidCode = pickCode((row) => cellHasNumericValue(grid, row, 'cartonQuantity'));
  if (invalidCode !== '' && invalidCode !== changeCode) {
    setFieldOnRows(grid, rowsOfCode(grid, invalidCode), 'cartonQuantity', 'abc');
    push({
      kind: 'field_change',
      sourceKey: `code:${invalidCode}`,
      detail: `${invalidCode} 装箱数量被改为非整数文本「abc」（不得采用）`,
    });
  }

  // 11) Duplicate-code inconsistency: add a second row with the same code but a different name.
  const duplicateSeed = pickCode(() => true);
  if (duplicateSeed !== '') {
    const sourceRow = rowsOfCode(grid, duplicateSeed)[0];
    if (sourceRow) {
      const cells: Record<string, string> = { ...sourceRow.cells };
      const nameColumn = columnOf(grid.headers, 'nameCn');
      if (nameColumn) cells[nameColumn] = `${normalizeCellText(cells[nameColumn] ?? '')}（模拟同号不一致）`;
      const insertedDuplicate = insertBusinessRow(grid, cells);
      push({
        kind: 'code_duplicate',
        sourceKey: `code:${duplicateSeed}`,
        detail: `${duplicateSeed} 新增重复行（工作行 ${insertedDuplicate.rowNumber}），中文产品名称与首行不一致`,
      });
    }
  }

  return changes;
}

function reverseRows(grid: Grid): void {
  grid.rows = [...grid.rows].reverse();
}

function reverseColumns(grid: Grid): void {
  const columns = Object.keys(grid.headers).sort(compareColumnLetters);
  const reversed = [...columns].reverse();
  const newHeaders: Record<string, string> = {};
  for (let index = 0; index < columns.length; index += 1) {
    newHeaders[reversed[index]] = grid.headers[columns[index]] ?? '';
  }
  grid.rows = grid.rows.map((row) => {
    const cells: Record<string, string> = {};
    for (let index = 0; index < columns.length; index += 1) {
      cells[reversed[index]] = row.cells[columns[index]] ?? '';
    }
    return { rowNumber: row.rowNumber, isBusinessRow: row.isBusinessRow, cells };
  });
  grid.headers = newHeaders;
}

export interface SimulationOptions {
  /** capturedAt of snapshot-002; defaults to base.capturedAt + 1 day (deterministic). */
  capturedAtBase?: string;
}

/**
 * Fixed-order simulated snapshots:
 * - [0] snapshot-002: business changes (value change, rename, specification change,
 *   new row, missing code, suspected code change, formula error, blanked field,
 *   unconfirmed-unit change, invalid numeric value, duplicate inconsistency);
 * - [1] snapshot-003: identical content to 002 with rows and columns reordered
 *   (must not produce fake revisions when applied after 002).
 */
export function buildSimulatedSnapshots(base: SourceSnapshot, options: SimulationOptions = {}): SourceSnapshot[] {
  const capturedAtBase =
    options.capturedAtBase ?? new Date(Date.parse(base.capturedAt) + 86_400_000).toISOString();
  const grid = gridFromSnapshot(base);
  const changes = applyBusinessChanges(grid);
  const snapshot002 = finalize(base, grid, {
    capturedAt: capturedAtBase,
    note: `${SIMULATION_NOTE}（002 业务变化批次）`,
    changes,
  });

  const reorderedGrid = gridFromSnapshot(snapshot002);
  reverseRows(reorderedGrid);
  reverseColumns(reorderedGrid);
  const reorderChanges: SimulatedChange[] = [
    ...changes,
    { kind: 'rows_reordered', sourceKey: 'rows', detail: '业务行顺序整体反转（行号仅证据，不参与身份匹配）' },
    { kind: 'columns_reordered', sourceKey: 'columns', detail: '列顺序整体反转（按表头文字解析，列字母仅证据）' },
  ];
  const snapshot003 = finalize(base, reorderedGrid, {
    capturedAt: new Date(Date.parse(capturedAtBase) + 30 * 60_000).toISOString(),
    note: `${SIMULATION_NOTE}（003 重排批次，内容与 002 相同）`,
    changes: reorderChanges,
  });

  return [snapshot002, snapshot003];
}

export function describeSimulations(snapshots: readonly SourceSnapshot[]): Array<{
  snapshotKey: string;
  capturedAt: string;
  changes: SimulatedChange[];
}> {
  return snapshots.map((snapshot) => ({
    snapshotKey: snapshot.snapshotKey,
    capturedAt: snapshot.capturedAt,
    changes: snapshot.simulation?.changes ?? [],
  }));
}
