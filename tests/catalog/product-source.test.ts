/**
 * Pure unit tests for the Feishu product-source simulation core (v1).
 *
 * Covers: header mapping, snapshot validation, strict duplicate-code consistency,
 * tolerance comparison, three-way diff rules (first round / later / conflict /
 * unconfirmed unit / blocking field group / blank source), needs_review with and
 * without partial writes, missing-code / suspected-code / new-item handling,
 * replay & stale decisions, batch payload shape, price non-leakage, readers and
 * the simulation/TS-script cross-check.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { FieldObservation } from '@/features/catalog/types';
import {
  ADOPTABLE_FIELD_KEYS,
  FIELD_GROUPS,
  FIELD_UNITS,
  HEADER_CONTRACT,
  KNOWN_HEADER_LABELS,
  PRODUCT_SOURCE_FIELD_KEYS,
  SOURCE_PROFILE_KEY,
  SNAPSHOT_CONTRACT,
  canonicalJson,
  codeSourceKey,
  rowSourceKey,
  type BatchArtifact,
  type BuildPlanInput,
  type PlanAdoptionRow,
  type PlanBinding,
  type PlanBoundItem,
  type ProductSourcePlan,
  type SourceRow,
  type SourceSnapshot,
} from '@/features/catalog/product-source/contract';
import {
  compareColumnLetters,
  resolveHeaderColumns,
  resolveHeaderMapping,
  validateSnapshot,
} from '@/features/catalog/product-source/headers';
import {
  areSameFieldValue,
  buildRowFields,
  classifyFieldCell,
  isSourceFormulaError,
  normalizeCellText,
} from '@/features/catalog/product-source/normalize';
import { groupByCodeMap, groupSourceRows } from '@/features/catalog/product-source/grouping';
import {
  evaluateSourceRows,
  matchUncodedItemByName,
  detectSuspectedCodeChange,
} from '@/features/catalog/product-source/anomaly';
import { diffField, diffItem } from '@/features/catalog/product-source/diff';
import {
  buildBatchPayload,
  buildPlan,
  toPlanPayload,
} from '@/features/catalog/product-source/plan';
import {
  assertSnapshotShape,
  computeAdoptionDigest,
  computeRowSha256,
  computeRowsSha256,
  computeSnapshotKey,
  verifySnapshotKey,
} from '@/features/catalog/product-source/reader';
import { createLocalSnapshotReader } from '@/features/catalog/product-source/local-reader';
import { createFeishuApiReader, FEISHU_API_NOT_CONFIGURED } from '@/features/catalog/product-source/api-reader';
import { buildSimulatedSnapshots, describeSimulations } from '@/features/catalog/product-source/simulate';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
const FIXTURE_DIR = path.join(REPO_ROOT, 'tests/catalog/fixtures/product-source');
const SNAPSHOT_PATH = path.join(FIXTURE_DIR, 'snapshot-001-redacted.json');
const MANIFEST_PATH = path.join(FIXTURE_DIR, 'manifest.json');
const RAW_TSV_PATH = path.join(
  REPO_ROOT,
  '.local/catalog/fs-catalog-sim-20261025/capture/run1/clipboard.raw.tsv',
);
const RAW_METADATA_PATH = path.join(
  REPO_ROOT,
  '.local/catalog/fs-catalog-sim-20261025/capture/run1/capture-metadata.json',
);

const RESTRICTED_LABELS = ['成本价格', '运营价格', '单品运费（自由计算列）'];
const RESTRICTED_KEYS = ['costPrice', 'operatingPrice', 'shippingPrice'];

const fixture = assertSnapshotShape(JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as unknown);
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as {
  grid: { businessRowCount: number; emptyRowCount: number; uniqueCodeCount: number; duplicateCodes: string[] };
  hashes: { fullSnapshotSha256: string; redactedSnapshotSha256: string; rawCaptureSha256: string };
  restricted: { columns: string[] };
};
const fixtureMapping = resolveHeaderColumns(fixture).columnsByField as Record<string, string | undefined>;
const evaluations = evaluateSourceRows(fixture);
const evaluationByCode = new Map(
  evaluations.filter((evaluation) => evaluation.iceCode !== null).map((evaluation) => [evaluation.iceCode, evaluation]),
);
const uniqueSourceCodes: string[] = [...evaluationByCode.keys()]
  .filter((code): code is string => code !== null)
  .sort();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CatalogState {
  items: PlanBoundItem[];
  bindings: PlanBinding[];
  adoptions: PlanAdoptionRow[];
}

function makeCatalogState(): CatalogState {
  const items: PlanBoundItem[] = uniqueSourceCodes.map((code) => {
    const logical = evaluationByCode.get(code)?.logicalFields;
    const nameCn = logical?.nameCn?.state === 'observed' ? normalizeCellText(logical.nameCn.raw) : `LOCAL-${code}`;
    return { itemId: `item-${code}`, revision: 1, iceCode: code, nameCn, fields: {} };
  });
  const bindings: PlanBinding[] = uniqueSourceCodes.map((code) => ({ itemId: `item-${code}`, iceCode: code }));
  return { items, bindings, adoptions: [] };
}

function applyPlan(state: CatalogState, plan: ProductSourcePlan): CatalogState {
  const resultByItem = new Map(
    plan.results
      .filter((result) => result.itemId !== null)
      .map((result) => [result.itemId as string, result]),
  );
  const items = state.items.map((item) => {
    const result = resultByItem.get(item.itemId);
    if (!result || result.nextFields === null) return item;
    const nameField = result.nextFields.nameCn;
    const nameCn =
      nameField && nameField.state === 'observed' && nameField.raw !== null ? nameField.raw : item.nameCn;
    return { ...item, revision: item.revision + 1, fields: result.nextFields, nameCn };
  });
  const createdResults = plan.results.filter((result) => result.action === 'create' && result.createCode !== null);
  const createdItems: PlanBoundItem[] = createdResults.map((result) => ({
    itemId: `item-${result.createCode as string}`,
    revision: 1,
    iceCode: result.createCode,
    nameCn: result.nameCn ?? '',
    fields: result.nextFields ?? {},
  }));
  const createdBindings: PlanBinding[] = createdResults.map((result) => ({
    itemId: `item-${result.createCode as string}`,
    iceCode: result.createCode as string,
  }));
  const adoptions = new Map<string, PlanAdoptionRow>(
    state.adoptions.map((adoption) => [`${adoption.itemId}:${adoption.fieldKey}`, adoption]),
  );
  for (const result of plan.results) {
    const itemId = result.itemId ?? (result.createCode !== null ? `item-${result.createCode}` : null);
    if (itemId === null) continue;
    for (const adoption of result.adoptions) {
      adoptions.set(`${itemId}:${adoption.fieldKey}`, {
        itemId,
        fieldKey: adoption.fieldKey,
        adoptedRaw: adoption.raw,
        adoptedState: adoption.state,
        unitState: adoption.unitState,
      });
    }
  }
  return { items: [...items, ...createdItems], bindings: [...state.bindings, ...createdBindings], adoptions: [...adoptions.values()] };
}

function baseline(): { state: CatalogState; plan: ProductSourcePlan } {
  const state = makeCatalogState();
  const plan = buildPlan({ snapshot: fixture, ...state });
  return { state: applyPlan(state, plan), plan };
}

function clampState(state: CatalogState, itemId: string, fields: Record<string, FieldObservation>): CatalogState {
  return {
    ...state,
    items: state.items.map((item) => (item.itemId === itemId ? { ...item, fields } : item)),
  };
}

function withAdoption(state: CatalogState, itemId: string, fieldKey: PlanAdoptionRow['fieldKey'], raw: string): CatalogState {
  const rest = state.adoptions.filter((adoption) => !(adoption.itemId === itemId && adoption.fieldKey === fieldKey));
  return {
    ...state,
    adoptions: [
      ...rest,
      { itemId, fieldKey, adoptedRaw: raw, adoptedState: 'observed', unitState: FIELD_UNITS[fieldKey].state },
    ],
  };
}

function observed(raw: string): FieldObservation {
  return { state: 'observed', raw, meaning: 'value', evidenceRef: 'test:local' };
}

function sourceCell(raw: string): { raw: string; state: 'observed'; meaning: 'value' } {
  return { raw, state: 'observed', meaning: 'value' };
}

function emptyCell(): { raw: string; state: 'explicit_empty'; meaning: 'explicit_empty' } {
  return { raw: '', state: 'explicit_empty', meaning: 'explicit_empty' };
}

function cloneSnapshotCells(snapshot: SourceSnapshot, mutate: (rows: { rowNumber: number; isBusinessRow: boolean; cells: Record<string, string> }[]) => void): SourceSnapshot {
  const rows = snapshot.rows.map((row) => ({
    rowNumber: row.rowNumber,
    isBusinessRow: row.isBusinessRow,
    cells: { ...row.cells },
  }));
  mutate(rows);
  const rebuilt: SourceRow[] = rows.map((row) => {
    const fields = row.isBusinessRow ? buildRowFields(row.cells, fixtureMapping) : {};
    return {
      rowNumber: row.rowNumber,
      isBusinessRow: row.isBusinessRow,
      cells: row.cells,
      fields,
      rowSha256: computeRowSha256({ rowNumber: row.rowNumber, cells: row.cells, fields }),
    };
  });
  const businessRowCount = rebuilt.filter((row) => row.isBusinessRow).length;
  const collection = {
    ...snapshot.collection,
    businessRowCount,
    emptyRowCount: rebuilt.length - businessRowCount,
  };
  const draft: SourceSnapshot = { ...snapshot, collection, rows: rebuilt, snapshotKey: '' };
  return { ...draft, snapshotKey: computeSnapshotKey(draft) };
}

function changeRowsOfCode(
  snapshot: SourceSnapshot,
  code: string,
  fieldKey: string,
  raw: string,
): SourceSnapshot {
  const codeColumn = fixtureMapping.iceCode;
  const column = fixtureMapping[fieldKey];
  if (!codeColumn || !column) throw new Error(`TEST_MAPPING_MISSING:${fieldKey}`);
  return cloneSnapshotCells(snapshot, (rows) => {
    for (const row of rows) {
      if (normalizeCellText(row.cells[codeColumn] ?? '') === code) row.cells[column] = raw;
    }
  });
}

function blankRowCode(snapshot: SourceSnapshot, code: string): SourceSnapshot {
  return changeRowsOfCode(snapshot, code, 'iceCode', '');
}

function renameCode(snapshot: SourceSnapshot, code: string, newCode: string): SourceSnapshot {
  return changeRowsOfCode(snapshot, code, 'iceCode', newCode);
}

function duplicateRowWith(
  snapshot: SourceSnapshot,
  code: string,
  patch: { code?: string; fields?: Record<string, string> },
): SourceSnapshot {
  const codeColumn = fixtureMapping.iceCode;
  if (!codeColumn) throw new Error('TEST_MAPPING_MISSING:iceCode');
  const sourceRow = snapshot.rows.find((row) => normalizeCellText(row.cells[codeColumn] ?? '') === code);
  if (!sourceRow) throw new Error(`TEST_ROW_NOT_FOUND:${code}`);
  const cells: Record<string, string> = { ...sourceRow.cells };
  if (patch.code !== undefined) cells[codeColumn] = patch.code;
  for (const [fieldKey, raw] of Object.entries(patch.fields ?? {})) {
    const column = fixtureMapping[fieldKey];
    if (!column) throw new Error(`TEST_MAPPING_MISSING:${fieldKey}`);
    cells[column] = raw;
  }
  const rowNumber = snapshot.collection.gridRows + 1;
  const fields = buildRowFields(cells, fixtureMapping);
  const row: SourceRow = {
    rowNumber,
    isBusinessRow: true,
    cells,
    fields,
    rowSha256: computeRowSha256({ rowNumber, cells, fields }),
  };
  const collection = {
    ...snapshot.collection,
    gridRows: rowNumber,
    businessRowCount: snapshot.collection.businessRowCount + 1,
    observedRange: `A1:AE${rowNumber}`,
  };
  const draft: SourceSnapshot = { ...snapshot, collection, rows: [...snapshot.rows, row], snapshotKey: '' };
  return { ...draft, snapshotKey: computeSnapshotKey(draft) };
}

function restrictedColumnsOf(snapshot: SourceSnapshot): Record<'costPrice' | 'operatingPrice' | 'shippingPrice', string> {
  const restricted = resolveHeaderMapping(snapshot.collection.headers).restrictedColumns;
  if (!restricted.costPrice || !restricted.operatingPrice || !restricted.shippingPrice) {
    throw new Error('TEST_RESTRICTED_COLUMNS_MISSING');
  }
  return {
    costPrice: restricted.costPrice,
    operatingPrice: restricted.operatingPrice,
    shippingPrice: restricted.shippingPrice,
  };
}

/** Synthetic restricted values on one row (test-only values, never real prices). */
function withRestrictedValues(
  snapshot: SourceSnapshot,
  values: { costPrice?: string; operatingPrice?: string; shippingPrice?: string },
  rowNumber = 2,
): SourceSnapshot {
  const columns = restrictedColumnsOf(snapshot);
  return cloneSnapshotCells(snapshot, (rows) => {
    const row = rows.find((candidate) => candidate.rowNumber === rowNumber);
    if (!row) throw new Error(`TEST_ROW_NOT_FOUND:${rowNumber}`);
    if (values.costPrice !== undefined) row.cells[columns.costPrice] = values.costPrice;
    if (values.operatingPrice !== undefined) row.cells[columns.operatingPrice] = values.operatingPrice;
    if (values.shippingPrice !== undefined) row.cells[columns.shippingPrice] = values.shippingPrice;
  });
}

/**
 * Move the restricted amount headers to AB/AC/AD (empty header columns in the
 * real capture) and put ordinary text into I/J/Y. This proves the boundary uses
 * header labels, not fixed letters.
 */
function moveRestrictedColumnsToAbCd(snapshot: SourceSnapshot): SourceSnapshot {
  const columns = restrictedColumnsOf(snapshot);
  const permutation = new Map<string, string>([
    [columns.costPrice, 'AB'],
    [columns.operatingPrice, 'AC'],
    [columns.shippingPrice, 'AD'],
    ['AB', columns.costPrice],
    ['AC', columns.operatingPrice],
    ['AD', columns.shippingPrice],
  ]);
  const headers: Record<string, string> = {};
  for (const [oldColumn, label] of Object.entries(snapshot.collection.headers)) {
    headers[permutation.get(oldColumn) ?? oldColumn] = label;
  }
  const resolution = resolveHeaderMapping(headers);
  if (!resolution.ok) throw new Error('TEST_REORDERED_HEADERS_INVALID');
  const rows: SourceRow[] = snapshot.rows.map((row) => {
    const cells: Record<string, string> = {};
    for (const [oldColumn, raw] of Object.entries(row.cells)) {
      cells[permutation.get(oldColumn) ?? oldColumn] = raw;
    }
    const fields = row.isBusinessRow ? buildRowFields(cells, resolution.fieldColumns) : {};
    return {
      rowNumber: row.rowNumber,
      isBusinessRow: row.isBusinessRow,
      cells,
      fields,
      rowSha256: computeRowSha256({ rowNumber: row.rowNumber, cells, fields }),
    };
  });
  const draft: SourceSnapshot = {
    ...snapshot,
    collection: { ...snapshot.collection, headers },
    rows,
    snapshotKey: '',
  };
  return { ...draft, snapshotKey: computeSnapshotKey(draft) };
}

function expectNoRestrictedContent(value: unknown): void {
  const serialized = canonicalJson(value);
  for (const label of RESTRICTED_LABELS) expect(serialized.includes(label)).toBe(false);
  for (const key of RESTRICTED_KEYS) expect(serialized.includes(key)).toBe(false);
}

function firstObservedRowCode(): string {
  const code = fixture.rows
    .map((row) => row.fields.iceCode)
    .find((cell) => cell?.state === 'observed' && cell.raw !== '');
  return code ? normalizeCellText(code.raw) : '';
}

// ---------------------------------------------------------------------------
// Contract and headers
// ---------------------------------------------------------------------------

describe('contract', () => {
  it('exports the frozen snapshot contract, profile key and 27 header labels', () => {
    expect(fixture.contract).toBe(SNAPSHOT_CONTRACT);
    expect(fixture.profileKey).toBe(SOURCE_PROFILE_KEY);
    expect(HEADER_CONTRACT).toHaveLength(27);
    expect(KNOWN_HEADER_LABELS).toHaveLength(27);
    expect(new Set(KNOWN_HEADER_LABELS).size).toBe(27);
  });

  it('excludes imageRef, sourceDate and iceCode from adoptable fields', () => {
    expect(PRODUCT_SOURCE_FIELD_KEYS).toHaveLength(24);
    expect(ADOPTABLE_FIELD_KEYS).toHaveLength(21);
    expect(ADOPTABLE_FIELD_KEYS).not.toContain('imageRef');
    expect(ADOPTABLE_FIELD_KEYS).not.toContain('sourceDate');
    expect(ADOPTABLE_FIELD_KEYS).not.toContain('iceCode');
  });

  it('declares confirmed / unconfirmed units and the blocking carton dimension group', () => {
    expect(FIELD_UNITS.length.state).toBe('confirmed');
    expect(FIELD_UNITS.unitWeight.state).toBe('confirmed');
    expect(FIELD_UNITS.cartonQuantity.label).toBe('件/箱');
    expect(FIELD_UNITS.cartonLength.state).toBe('unconfirmed');
    expect(FIELD_UNITS.unitVolume.state).toBe('unconfirmed');
    expect([...FIELD_GROUPS.cartonDimensions]).toEqual(['cartonLength', 'cartonWidth', 'cartonHeight']);
  });
});

describe('headers', () => {
  it('resolves the real capture headers by exact label (mixed full-width parens included)', () => {
    const resolution = resolveHeaderMapping(fixture.collection.headers);
    expect(resolution.ok).toBe(true);
    expect(resolution.issues).toEqual([]);
    expect(resolution.fieldColumns.nameCn).toBe('B');
    expect(resolution.fieldColumns.iceCode).toBe('G');
    expect(resolution.fieldColumns.cartonQuantity).toBe('P');
    expect(resolution.fieldColumns.length).toBe('L');
    expect(resolution.restrictedColumns).toEqual({ costPrice: 'I', operatingPrice: 'J', shippingPrice: 'Y' });
    expect(Object.keys(resolution.fieldColumns)).toHaveLength(24);
    expect(Object.keys(resolution.restrictedColumns)).toHaveLength(3);
  });

  it('maps board labels to columns, not the other way around (column reorder keeps semantics)', () => {
    const columns = Object.keys(fixture.collection.headers).sort(compareColumnLetters);
    const reversed = [...columns].reverse();
    const headers: Record<string, string> = {};
    for (let index = 0; index < columns.length; index += 1) {
      headers[reversed[index]] = fixture.collection.headers[columns[index]] ?? '';
    }
    const resolution = resolveHeaderMapping(headers);
    expect(resolution.ok).toBe(true);
    expect(resolution.fieldColumns.iceCode).not.toBe('G');
    expect(headers[resolution.fieldColumns.iceCode as string]).toBe('聚水潭内部货号');
  });

  it('rejects missing, duplicate and unknown non-empty headers', () => {
    const missing = resolveHeaderMapping({ ...fixture.collection.headers, B: '' });
    expect(missing.ok).toBe(false);
    expect(missing.missingLabels).toContain('中文产品名称');

    const duplicate = resolveHeaderMapping({ ...fixture.collection.headers, C: '中文产品名称' });
    expect(duplicate.ok).toBe(false);
    expect(duplicate.issues.some((issue) => issue.code === 'duplicate_header')).toBe(true);

    const unknown = resolveHeaderMapping({ ...fixture.collection.headers, AB: '未知列' });
    expect(unknown.ok).toBe(false);
    expect(unknown.unknownHeaders).toEqual([{ column: 'AB', label: '未知列' }]);
  });

  it('validates the real fixture snapshot', () => {
    const validation = validateSnapshot(fixture);
    expect(validation.ok).toBe(true);
    expect(validation.status).toBe('validated');
    expect(validation.issues).toEqual([]);
    expect(resolveHeaderColumns(fixture).issues).toEqual([]);
  });

  it('fails incomplete / truncated / read-error captures', () => {
    const incomplete = { ...fixture, collection: { ...fixture.collection, complete: false } };
    expect(validateSnapshot(incomplete).issues.map((issue) => issue.code)).toContain('CAPTURE_INCOMPLETE');

    const truncated = { ...fixture, collection: { ...fixture.collection, truncated: true } };
    expect(validateSnapshot(truncated).issues.map((issue) => issue.code)).toContain('CAPTURE_INCOMPLETE');

    const readError = { ...fixture, collection: { ...fixture.collection, readError: '401' } };
    expect(validateSnapshot(readError).issues.map((issue) => issue.code)).toContain('CAPTURE_INCOMPLETE');
  });

  it('fails mismatched business/empty row arithmetic and column counts', () => {
    const fewerRows = { ...fixture, rows: fixture.rows.slice(0, 100) };
    expect(validateSnapshot(fewerRows).issues.map((issue) => issue.code)).toContain('CAPTURE_INCOMPLETE');

    const badColumnRow: SourceRow = {
      ...fixture.rows[0],
      cells: { ...fixture.rows[0].cells },
      rowSha256: fixture.rows[0].rowSha256,
    };
    delete badColumnRow.cells.AE;
    const badColumns = { ...fixture, rows: [badColumnRow, ...fixture.rows.slice(1)] };
    expect(validateSnapshot(badColumns).issues.map((issue) => issue.code)).toContain('COLUMN_COUNT_INVALID');
  });

  it('fails a wrong contract / duplicate header snapshot', () => {
    const wrongContract = { ...fixture, contract: 'other-contract' } as unknown as SourceSnapshot;
    expect(validateSnapshot(wrongContract).issues.map((issue) => issue.code)).toContain('SNAPSHOT_CONTRACT_INVALID');

    const duplicateHeader = {
      ...fixture,
      collection: { ...fixture.collection, headers: { ...fixture.collection.headers, C: '中文产品名称' } },
    };
    expect(validateSnapshot(duplicateHeader).issues.map((issue) => issue.code)).toContain('HEADER_CONTRACT_INVALID');
  });
});

// ---------------------------------------------------------------------------
// Fixture integrity
// ---------------------------------------------------------------------------

describe('fixture integrity', () => {
  it('matches the verified capture facts', () => {
    expect(fixture.origin).toBe('real_capture');
    expect(fixture.collection.gridRows).toBe(404);
    expect(fixture.collection.gridColumns).toBe(31);
    expect(fixture.collection.businessRowCount).toBe(131);
    expect(fixture.collection.emptyRowCount).toBe(272);
    // All 403 data rows are stored (including empty rows) so DB row/is_empty counts can be checked.
    expect(fixture.rows).toHaveLength(403);
    expect(fixture.rows.filter((row) => row.isBusinessRow)).toHaveLength(131);
    expect(fixture.rows.filter((row) => !row.isBusinessRow)).toHaveLength(272);
    expect(fixture.rows.map((row) => row.rowNumber)).toEqual(
      Array.from({ length: 403 }, (_unused, index) => index + 2),
    );
    expect(uniqueSourceCodes).toHaveLength(125);
    const grouping = groupSourceRows(fixture);
    expect(grouping.missingCodeRows.map((row) => row.rowNumber)).toEqual([122]);
    expect(grouping.codeGroups.filter((group) => group.rows.length > 1).map((group) => group.code)).toEqual([
      'WM0069',
      'WM0070',
      'WM0071',
      'WM0072',
      'WM0073',
    ]);
    expect(manifest.grid.businessRowCount).toBe(131);
    expect(manifest.grid.uniqueCodeCount).toBe(125);
    expect(manifest.grid.duplicateCodes).toEqual(['WM0069', 'WM0070', 'WM0071', 'WM0072', 'WM0073']);
  });

  it('keeps row and snapshot hashes reproducible', () => {
    for (const row of fixture.rows) {
      expect(row.rowSha256).toBe(computeRowSha256({ rowNumber: row.rowNumber, cells: row.cells, fields: row.fields }));
    }
    expect(computeSnapshotKey(fixture)).toBe(fixture.snapshotKey);
    expect(verifySnapshotKey(fixture)).toBe(true);
    expect(manifest.hashes.redactedSnapshotSha256).toBe(fixture.snapshotKey);
    expect(fixture.snapshotKey).toMatch(/^[a-f0-9]{64}$/);
  });

  it('stores mapped fields exactly as normalize.ts builds them from the cells', () => {
    for (const row of fixture.rows.filter((candidate) => candidate.isBusinessRow)) {
      expect(row.fields).toEqual(buildRowFields(row.cells, fixtureMapping));
    }
    for (const row of fixture.rows.filter((candidate) => !candidate.isBusinessRow)) {
      expect(row.fields).toEqual({});
    }
  });

  it('is redacted: restricted columns are blank and declared, no price enters fields', () => {
    expect(fixture.redaction?.restrictedColumns).toEqual(['I', 'J', 'Y']);
    expect(fixture.redaction?.priceValuesRemoved).toBe(true);
    for (const row of fixture.rows) {
      for (const column of ['I', 'J', 'Y']) expect(row.cells[column] ?? '').toBe('');
      for (const key of PRODUCT_SOURCE_FIELD_KEYS) {
        expect(RESTRICTED_KEYS).not.toContain(key);
      }
    }
    expect(manifest.restricted.columns).toEqual(['I', 'J', 'Y']);
  });

  it('marks imageRef as not_read and sourceDate as static evidence only', () => {
    for (const row of fixture.rows.filter((candidate) => candidate.isBusinessRow)) {
      expect(row.fields.imageRef.state).toBe('not_read');
      expect(row.fields.imageRef.reason).toBe('IMAGE_NOT_READ_BY_SNAPSHOT');
    }
  });
});

// ---------------------------------------------------------------------------
// Grouping / anomaly
// ---------------------------------------------------------------------------

describe('grouping and anomaly detection', () => {
  it('groups by trimmed case-sensitive code and keeps all original rows', () => {
    const grouping = groupByCodeMap(fixture.rows);
    expect(grouping.codeGroups.size).toBe(125);
    expect(grouping.missingCodeRows).toHaveLength(1);
    expect(grouping.codeGroups.get('WM0072')?.map((row) => row.rowNumber)).toEqual([66, 131]);
    expect([...grouping.codeGroups.keys()].sort()).toEqual(uniqueSourceCodes);
  });

  it('evaluates 121 consistent groups, 4 inconsistent codes and one missing-code row', () => {
    const consistent = evaluations.filter((evaluation) => evaluation.classification === 'consistent');
    const inconsistent = evaluations.filter((evaluation) => evaluation.classification === 'inconsistent');
    const missing = evaluations.filter((evaluation) => evaluation.classification === 'missing_code');
    expect(consistent).toHaveLength(121);
    expect(inconsistent.map((evaluation) => evaluation.iceCode).sort()).toEqual(['WM0069', 'WM0070', 'WM0071', 'WM0073']);
    expect(missing.map((evaluation) => evaluation.sourceKey)).toEqual([rowSourceKey(122)]);
    expect(evaluations[0]?.sourceKey).toBe(codeSourceKey('LS101274'));
    expect(evaluations[evaluations.length - 1]?.sourceKey).toBe(rowSourceKey(122));
    expect(evaluations.filter((evaluation) => evaluation.iceCode !== null).map((evaluation) => evaluation.iceCode)).toEqual(
      [...uniqueSourceCodes],
    );
  });

  it('treats blank vs non-blank barcode as a strict inconsistency, keeps WM0072 mergeable', () => {
    const wm0069 = evaluationByCode.get('WM0069');
    expect(wm0069?.classification).toBe('inconsistent');
    expect(wm0069?.logicalFields).toBeNull();
    expect(wm0069?.conflicts).toEqual([
      {
        fieldKey: 'barcode',
        values: [
          { rowNumber: 63, raw: null, state: 'explicit_empty' },
          { rowNumber: 128, raw: '757577407380', state: 'observed' },
        ],
      },
    ]);
    const wm0072 = evaluationByCode.get('WM0072');
    expect(wm0072?.classification).toBe('consistent');
    expect(wm0072?.conflicts).toEqual([]);
    expect(wm0072?.rowNumbers).toEqual([66, 131]);
    expect(wm0072?.logicalFields?.nameCn?.state).toBe('observed');
  });

  it('records parse failures as field issues without prices', () => {
    const shipping = evaluations.find((evaluation) => evaluation.iceCode === 'LS101302')?.fieldIssues ?? [];
    expect(shipping.some((issue) => issue.fieldKey === 'shippingDays' && issue.reason === 'SOURCE_VALUE_NOT_NUMERIC')).toBe(true);
    const unitWeight = evaluations.flatMap((evaluation) => evaluation.fieldIssues).find((issue) => issue.rowNumber === 8);
    expect(unitWeight?.fieldKey).toBe('unitWeight');
    const formula = evaluations
      .flatMap((evaluation) => evaluation.fieldIssues)
      .find((issue) => issue.reason === 'SOURCE_FORMULA_ERROR');
    expect(formula).toBeDefined();
    expectNoRestrictedContent(evaluations);
  });

  it('detects a duplicated row with a different name as inconsistent (synthetic)', () => {
    const snapshot = duplicateRowWith(fixture, 'WM0072', { fields: { nameCn: '模拟冲突名称' } });
    const evaluation = evaluateSourceRows(snapshot).find((candidate) => candidate.iceCode === 'WM0072');
    expect(evaluation?.classification).toBe('inconsistent');
    expect(evaluation?.conflicts.map((conflict) => conflict.fieldKey)).toContain('nameCn');
  });

  it('uses numeric tolerance for consistency but strict blank-vs-value comparison', () => {
    const codeColumn = fixtureMapping.iceCode;
    const unitWeightColumn = fixtureMapping.unitWeight;
    if (!codeColumn || !unitWeightColumn) throw new Error('TEST_MAPPING_MISSING');
    const template = fixture.rows.find((row) => normalizeCellText(row.cells[codeColumn] ?? '') === 'WM0072');
    if (!template) throw new Error('TEST_ROW_NOT_FOUND:WM0072');
    const makeRow = (rowNumber: number, cells: Record<string, string>): SourceRow => {
      const fields = buildRowFields(cells, fixtureMapping);
      return { rowNumber, isBusinessRow: true, cells, fields, rowSha256: computeRowSha256({ rowNumber, cells, fields }) };
    };
    const firstCells = { ...template.cells, [unitWeightColumn]: '0.000169384421052632' };
    const secondCells = { ...template.cells, [unitWeightColumn]: '0.000169384' };
    const tolerantSnapshot: SourceSnapshot = {
      ...fixture,
      rows: [makeRow(2, firstCells), makeRow(3, secondCells)],
      snapshotKey: '',
    };
    const tolerant = evaluateSourceRows({
      ...tolerantSnapshot,
      snapshotKey: computeSnapshotKey(tolerantSnapshot),
    }).find((evaluation) => evaluation.iceCode === 'WM0072');
    expect(tolerant?.classification).toBe('consistent');

    const strictSnapshot: SourceSnapshot = {
      ...fixture,
      rows: [makeRow(2, firstCells), makeRow(3, { ...template.cells, [unitWeightColumn]: '' })],
      snapshotKey: '',
    };
    const strict = evaluateSourceRows({
      ...strictSnapshot,
      snapshotKey: computeSnapshotKey(strictSnapshot),
    }).find((evaluation) => evaluation.iceCode === 'WM0072');
    expect(strict?.classification).toBe('inconsistent');
    expect(strict?.conflicts[0]?.values).toHaveLength(2);
  });

  it('matches missing-code rows to uncoded items by exact name only', () => {
    expect(matchUncodedItemByName(' 不存在名称 ', [{ itemId: 'a', nameCn: '存在' }])).toBeNull();
    expect(
      matchUncodedItemByName('ICE LERSKIN 烟酰胺提亮精华水150ml', [
        { itemId: 'b', nameCn: 'ICE LERSKIN 烟酰胺提亮精华水150ml' },
      ]),
    ).toEqual({ itemId: 'b', nameCn: 'ICE LERSKIN 烟酰胺提亮精华水150ml' });
  });

  it('flags suspected code changes by barcode or name, without re-binding', () => {
    const candidate = {
      itemId: 'item-WM0072',
      iceCode: 'WM0072',
      nameCn: 'ICE LERSKIN 护发精油 (桂花) 80ml-橙色-泰国特供版',
      barcode: '757577983006',
      adoptionNameCn: null,
      adoptionBarcode: null,
    };
    const wm0072Logical = evaluationByCode.get('WM0072')?.logicalFields;
    if (!wm0072Logical) throw new Error('TEST_LOGICAL_FIELDS_MISSING:WM0072');
    const byName = detectSuspectedCodeChange({
      iceCode: 'WM9009',
      logicalFields: { ...wm0072Logical, barcode: emptyCell() },
      candidates: [candidate],
    });
    expect(byName).toEqual({ suspected: true, matchedItemId: 'item-WM0072', matchedBy: 'nameCn' });
  });
});

// ---------------------------------------------------------------------------
// Three-way diff rules
// ---------------------------------------------------------------------------

describe('three-way field diff', () => {
  it('first round: adopts when local empty, adoption-only when equal, review when different', () => {
    expect(diffField({ fieldKey: 'nameCn', source: sourceCell('新名称'), local: undefined, base: undefined })).toMatchObject({
      outcome: 'initial_adopt',
      adopt: true,
      write: true,
      afterRaw: '新名称',
      reasonCode: 'INITIAL_SOURCE_BASELINE',
    });
    expect(diffField({ fieldKey: 'nameCn', source: sourceCell('名称'), local: observed('名称'), base: undefined })).toMatchObject({
      outcome: 'initial_baseline_equal',
      adopt: true,
      write: false,
    });
    expect(
      diffField({ fieldKey: 'nameCn', source: sourceCell('来源名称'), local: observed('本地名称'), base: undefined }),
    ).toMatchObject({
      outcome: 'initial_baseline_diff',
      adopt: true,
      write: false,
      issue: 'initial_baseline_diff',
    });
  });

  it('later rounds: base equal keeps local, local equal base adopts, local equal source converges, else conflict', () => {
    const base = { itemId: 'i', fieldKey: 'nameCn' as const, adoptedRaw: '基线', adoptedState: 'observed' as const, unitState: 'not_applicable' as const };
    expect(diffField({ fieldKey: 'nameCn', source: sourceCell('基线'), local: observed('本地改'), base })).toMatchObject({
      outcome: 'unchanged_base',
      adopt: false,
      write: false,
    });
    // local still baseline, source changed -> update
    expect(diffField({ fieldKey: 'nameCn', source: sourceCell('新来源'), local: observed('基线'), base })).toMatchObject({
      outcome: 'update',
      adopt: true,
      write: true,
      afterRaw: '新来源',
    });
    // local missing -> update
    expect(diffField({ fieldKey: 'nameCn', source: sourceCell('新来源'), local: undefined, base })).toMatchObject({
      outcome: 'update',
      write: true,
    });
    // local and source converged without base -> adoption only
    expect(diffField({ fieldKey: 'nameCn', source: sourceCell('来源'), local: observed('来源'), base })).toMatchObject({
      outcome: 'converged',
      adopt: true,
      write: false,
    });
    // true conflict keeps local, adoption unchanged
    expect(diffField({ fieldKey: 'nameCn', source: sourceCell('来源'), local: observed('本地'), base })).toMatchObject({
      outcome: 'conflict',
      adopt: false,
      write: false,
      issue: 'field_conflict',
    });
  });

  it('never overwrites local when the source cell is blank / not read / parse failed', () => {
    for (const source of [emptyCell(), { raw: '', state: 'not_read' as const, reason: 'X' }, { raw: '#N/A', state: 'parse_failed' as const, reason: 'SOURCE_FORMULA_ERROR' }]) {
      const diff = diffField({
        fieldKey: 'nameCn',
        source,
        local: observed('本地'),
        base: { itemId: 'i', fieldKey: 'nameCn', adoptedRaw: '基线', adoptedState: 'observed', unitState: 'not_applicable' },
      });
      expect(diff.outcome).toBe('kept_blank');
      expect(diff.adopt).toBe(false);
      expect(diff.write).toBe(false);
    }
  });

  it('never adopts or writes unconfirmed-unit fields', () => {
    // local non-empty & different: keep local, no adopt/write, review issue with source raw.
    const differ = diffField({
      fieldKey: 'cartonWeight',
      source: sourceCell('20'),
      local: observed('15'),
      base: { itemId: 'i', fieldKey: 'cartonWeight', adoptedRaw: '15', adoptedState: 'observed', unitState: 'unconfirmed' },
    });
    expect(differ).toMatchObject({
      outcome: 'unit_unconfirmed',
      adopt: false,
      write: false,
      afterRaw: null,
      issue: 'unit_unconfirmed',
    });
    expect(differ.source.raw).toBe('20');

    // local empty & source non-empty: still no adopt/write, review issue.
    const emptyLocal = diffField({ fieldKey: 'cartonWeight', source: sourceCell('20'), local: undefined, base: undefined });
    expect(emptyLocal).toMatchObject({ outcome: 'unit_unconfirmed', adopt: false, write: false, issue: 'unit_unconfirmed' });

    // local equal to source: no-op, no issue, no adoption.
    const equal = diffField({ fieldKey: 'cartonWeight', source: sourceCell('15'), local: observed('15'), base: undefined });
    expect(equal).toMatchObject({ outcome: 'unit_unconfirmed_equal', adopt: false, write: false, issue: null });

    // observed but empty source raw: no-op (no issue for an empty source value).
    const emptySource = diffField({
      fieldKey: 'cartonWeight',
      source: { raw: '', state: 'observed', meaning: 'value' },
      local: observed('15'),
      base: undefined,
    });
    expect(emptySource).toMatchObject({ outcome: 'unit_unconfirmed_equal', adopt: false, write: false, issue: null });
  });

  it('treats numeric values within tolerance as equal (no fake revision)', () => {
    expect(areSameFieldValue('unitVolume', '0.000169384421052632', '0.000169384')).toBe(true);
    expect(areSameFieldValue('unitWeight', '100', '100.000001')).toBe(true);
    expect(areSameFieldValue('unitWeight', '100', '100.1')).toBe(false);
    expect(areSameFieldValue('cartonQuantity', '300', '300')).toBe(true);
    expect(areSameFieldValue('cartonQuantity', '300', '300.0')).toBe(false);
    expect(areSameFieldValue('nameCn', '名称 A', '名称 A')).toBe(true);
    expect(areSameFieldValue('nameCn', '名称 A', '名称a')).toBe(false);
  });

  it('blocks the whole carton dimension group but keeps other fields processable', () => {
    const baseAdoptions: PlanAdoptionRow[] = [
      { itemId: 'i', fieldKey: 'cartonLength', adoptedRaw: '50', adoptedState: 'observed', unitState: 'unconfirmed' },
      { itemId: 'i', fieldKey: 'cartonWidth', adoptedRaw: '40', adoptedState: 'observed', unitState: 'unconfirmed' },
      { itemId: 'i', fieldKey: 'cartonHeight', adoptedRaw: '30', adoptedState: 'observed', unitState: 'unconfirmed' },
      { itemId: 'i', fieldKey: 'nameCn', adoptedRaw: '旧名称', adoptedState: 'observed', unitState: 'not_applicable' },
    ];
    const itemDiff = diffItem({
      sourceFields: {
        cartonLength: sourceCell('55'),
        cartonWidth: sourceCell('45'),
        cartonHeight: sourceCell('30'),
        nameCn: sourceCell('新名称'),
      },
      localFields: {
        cartonLength: observed('50'),
        cartonWidth: observed('40'),
        cartonHeight: observed('30'),
        nameCn: observed('旧名称'),
      },
      adoptions: baseAdoptions,
    });
    expect(itemDiff.blockedGroups).toEqual(['cartonDimensions']);
    const byKey = new Map(itemDiff.fields.map((field) => [field.fieldKey, field]));
    // Unconfirmed-unit fields keep the local value and record adoption of the source value;
    // the group still blocks any write for its members.
    expect(byKey.get('cartonLength')?.outcome).toBe('unit_unconfirmed');
    expect(byKey.get('cartonWidth')?.outcome).toBe('unit_unconfirmed');
    expect(byKey.get('nameCn')?.outcome).toBe('update');
    expect(itemDiff.writeFields.map((field) => field.fieldKey)).toEqual(['nameCn']);
    expect(itemDiff.writeFields.some((field) => (FIELD_GROUPS.cartonDimensions as readonly string[]).includes(field.fieldKey))).toBe(false);
  });

  it('maps parse-failed cells to precise reasons (formula / numeric / carton quantity)', () => {
    expect(isSourceFormulaError('#DIV/0!')).toBe(true);
    expect(classifyFieldCell('cartonVolume', '#VALUE!')).toMatchObject({ state: 'parse_failed', reason: 'SOURCE_FORMULA_ERROR' });
    expect(classifyFieldCell('unitWeight', '0.05/件')).toMatchObject({ state: 'parse_failed', reason: 'SOURCE_VALUE_NOT_NUMERIC' });
    expect(classifyFieldCell('cartonQuantity', 'abc')).toMatchObject({ state: 'parse_failed', reason: 'INVALID_CARTON_QUANTITY' });
    expect(classifyFieldCell('cartonQuantity', '0')).toMatchObject({ state: 'parse_failed', reason: 'INVALID_CARTON_QUANTITY' });
    expect(classifyFieldCell('cartonQuantity', '120')).toMatchObject({ state: 'observed' });
    expect(classifyFieldCell('nameCn', '')).toMatchObject({ state: 'explicit_empty' });
  });
});

// ---------------------------------------------------------------------------
// Plan building
// ---------------------------------------------------------------------------

function planWith(snapshot: SourceSnapshot, state: CatalogState, extra: Partial<BuildPlanInput> = {}): ProductSourcePlan {
  return buildPlan({ snapshot, ...state, ...extra });
}

describe('apply plan (baseline, idempotency, replay/stale)', () => {
  it('builds the first-round plan: confirmed fields adopt, unconfirmed units are held for review', () => {
    const { plan } = baseline();
    expect(plan.decision).toBe('apply');
    expect(plan.countsHint.created).toBe(0);
    expect(plan.countsHint.missing).toBe(0);
    expect(plan.countsHint.failed).toBe(0);
    // Unconfirmed-unit source values are never adopted, so most first-round items
    // become needs_review (with partial writes of their confirmed fields).
    expect(plan.countsHint.updated).toBe(4);
    expect(plan.countsHint.unchanged).toBe(1);
    expect(plan.countsHint.needsReview).toBe(121);
    expect(plan.countsHint.updated + plan.countsHint.needsReview + plan.countsHint.unchanged).toBe(126);
    expect(plan.seenItemIds).toHaveLength(125);
    expect(plan.batchStatusHint).toBe('partial');

    for (const code of ['WM0069', 'WM0070', 'WM0071', 'WM0073']) {
      const result = plan.results.find((candidate) => candidate.sourceKey === codeSourceKey(code));
      expect(result?.action).toBe('needs_review');
      expect(result?.reasonCode).toBe('DUPLICATE_CODE_INCONSISTENT');
      expect(result?.nextFields).toBeNull();
      expect(result?.expectedRevision).toBeNull();
      expect(result?.issues.some((issue) => issue.kind === 'duplicate_code_inconsistent')).toBe(true);
    }
    const missingCodeResult = plan.results.find((candidate) => candidate.sourceKey === rowSourceKey(122));
    expect(missingCodeResult?.action).toBe('needs_review');
    expect(missingCodeResult?.reasonCode).toBe('MISSING_CODE');
    expect(missingCodeResult?.itemId).toBeNull();
    expect(missingCodeResult?.nextFields).toBeNull();

    const updateResult = plan.results.find((candidate) => candidate.action === 'update');
    expect(updateResult?.itemId).not.toBeNull();
    expect(updateResult?.expectedRevision).toBe(1);
    expect(updateResult?.nextFields).not.toBeNull();
    expect(updateResult?.changes.length).toBeGreaterThan(0);
    expect(updateResult?.changes.every((change) => change.kind === 'initial_baseline')).toBe(true);
    expect(updateResult?.adoptions.some((adoption) => adoption.fieldKey === 'nameCn')).toBe(true);
    expect(updateResult?.nextFields?.iceCode).toBeUndefined();
    expect(updateResult?.nextFields?.sourceDate).toBeUndefined();

    // WM0072 has only a name in the source and the local name already matches:
    // first-round baseline adoption only, no revision.
    const unchangedResult = plan.results.find((candidate) => candidate.sourceKey === codeSourceKey('WM0072'));
    expect(unchangedResult?.action).toBe('unchanged');
    expect(unchangedResult?.changes).toEqual([]);
    expect(unchangedResult?.nextFields).toBeNull();
    expect(unchangedResult?.adoptions.some((adoption) => adoption.fieldKey === 'nameCn')).toBe(true);

    // No unconfirmed-unit field may be adopted or written anywhere in the plan.
    for (const result of plan.results) {
      for (const adoption of result.adoptions) expect(adoption.unitState).not.toBe('unconfirmed');
      for (const change of result.changes) expect(FIELD_UNITS[change.fieldKey].state).not.toBe('unconfirmed');
    }
    // The held unit fields appear as review issues that retain the source raw.
    const heldUnit = plan.results.find(
      (result) =>
        result.action === 'needs_review' && result.issues.some((issue) => issue.kind === 'unit_unconfirmed'),
    );
    expect(heldUnit).toBeDefined();
    const unitIssue = heldUnit?.issues.find((issue) => issue.kind === 'unit_unconfirmed');
    expect(typeof unitIssue?.detail.fieldKey).toBe('string');
    expect(typeof unitIssue?.detail.sourceRaw).toBe('string');
    expect(toPlanPayload(plan).results.every((result) => result.nextFields?.iceCode === undefined)).toBe(true);
    expectNoRestrictedContent(toPlanPayload(plan));
  });

  it('is stable on a second pass: no revisions, only unchanged/review results', () => {
    const first = baseline();
    const second = planWith(fixture, first.state);
    expect(second.decision).toBe('apply');
    expect(second.countsHint.updated).toBe(0);
    expect(second.countsHint.created).toBe(0);
    expect(second.countsHint.missing).toBe(0);
    expect(second.countsHint.needsReview).toBe(121);
    expect(second.countsHint.unchanged).toBe(5);
    for (const result of second.results) {
      if (result.action === 'unchanged') expect(result.changes).toEqual([]);
      expect(result.action).not.toBe('update');
    }
  });

  it('replays an already applied snapshot without rebuilding results', () => {
    const { state } = baseline();
    const plan = planWith(fixture, state, {
      appliedSnapshots: [{ snapshotKey: fixture.snapshotKey, capturedAt: fixture.capturedAt, status: 'applied' }],
    });
    expect(plan.decision).toBe('replay');
    expect(plan.results).toEqual([]);
    expect(plan.countsHint).toEqual({ created: 0, updated: 0, unchanged: 0, needsReview: 0, failed: 0, missing: 0 });
    expect(plan.issues.map((issue) => issue.kind)).toEqual(['already_applied']);
  });

  it('treats a re-collected snapshot with identical content as the same snapshot (capturedAt is not content)', () => {
    const recollected: SourceSnapshot = {
      ...fixture,
      capturedAt: '2026-10-26T09:00:00.000Z',
      snapshotKey: computeSnapshotKey({ collection: fixture.collection, rows: fixture.rows }),
    };
    expect(recollected.snapshotKey).toBe(fixture.snapshotKey);
    const plan = planWith(recollected, makeCatalogState(), {
      appliedSnapshots: [{ snapshotKey: fixture.snapshotKey, capturedAt: fixture.capturedAt, status: 'partial' }],
    });
    expect(plan.decision).toBe('replay');
  });

  it('rejects a snapshot older than the latest applied batch', () => {
    const plan = buildPlan({
      snapshot: fixture,
      ...makeCatalogState(),
      latestAppliedCapturedAt: '2026-12-01T00:00:00.000Z',
    });
    expect(plan.decision).toBe('rejected_stale');
    expect(plan.results).toEqual([]);
    expect(plan.issues.map((issue) => issue.kind)).toEqual(['stale_snapshot']);
  });

  it('rejects an invalid snapshot and still yields a buildable failed batch payload', () => {
    const invalid: SourceSnapshot = {
      ...fixture,
      collection: { ...fixture.collection, complete: false, truncated: true },
    };
    const plan = buildPlan({ snapshot: invalid, ...makeCatalogState() });
    expect(plan.decision).toBe('rejected_invalid');
    expect(plan.batchStatusHint).toBe('failed');
    expect(plan.countsHint.failed).toBe(1);
    expect(plan.results).toHaveLength(1);
    const failed = plan.results[0];
    expect(failed?.sourceKey).toBe('batch');
    expect(failed?.action).toBe('failed');
    expect(failed?.issues.some((issue) => issue.kind === 'capture_incomplete')).toBe(true);

    const artifacts: BatchArtifact[] = [
      { logicalName: 'snapshot.json', sha256: 'a'.repeat(64), size: 10, format: 'application/json', storageHandle: 'h', role: 'snapshot' },
    ];
    const payload = buildBatchPayload({
      snapshot: invalid,
      plan,
      artifacts,
      adoptionSha256: computeAdoptionDigest(toPlanPayload(plan)),
    });
    expect(payload.rows).toHaveLength(403);
    expect(payload.rows.filter((row) => row.isBusinessRow)).toHaveLength(131);
    expect(payload.rowsSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(payload.snapshotKey).toBe(invalid.snapshotKey);
  });

  it('marks bound items missing in this snapshot without deleting/unbinding them', () => {
    const { state } = baseline();
    const code = 'WM0072';
    const snapshot = blankRowCode(fixture, code);
    const plan = planWith(snapshot, state);
    const result = plan.results.find((candidate) => candidate.sourceKey === codeSourceKey(code));
    expect(result?.missing).toBe(true);
    expect(result?.action).toBe('unchanged');
    expect(result?.reasonCode).toBe('SOURCE_ROW_MISSING');
    expect(result?.nextFields).toBeNull();
    expect(result?.changes).toEqual([]);
    expect(result?.adoptions).toEqual([]);
    expect(plan.countsHint.missing).toBe(1);
    expect(plan.seenItemIds).not.toContain(`item-${code}`);
    // The blanked row itself becomes a missing-code review row.
    expect(plan.results.some((candidate) => candidate.reasonCode === 'MISSING_CODE')).toBe(true);
  });

  it('creates a new item once and keeps it stable on a repeat pass', () => {
    const first = baseline();
    const simulations = buildSimulatedSnapshots(fixture);
    const createPlan = planWith(simulations[0], first.state);
    const created = createPlan.results.filter((result) => result.action === 'create');
    expect(created).toHaveLength(1);
    expect(created[0]?.createCode).toBe('WM9001');
    expect(created[0]?.itemId).toBeNull();
    expect(created[0]?.expectedRevision).toBeNull();
    expect(created[0]?.nameCn).toBe('ICE LERSKIN 模拟新品精华 30ml');
    expect(created[0]?.nextFields?.nameCn).toMatchObject({ state: 'observed' });
    expect(created[0]?.nextFields?.imageRef).toMatchObject({ state: 'not_read' });
    expect(created[0]?.nextFields?.iceCode).toBeUndefined();
    expect(created[0]?.nextFields?.sourceDate).toBeUndefined();

    // All six unconfirmed-unit source values are excluded from the create writes
    // but each non-empty value opens a unit_unconfirmed issue.
    const unconfirmedKeys = ADOPTABLE_FIELD_KEYS.filter((fieldKey) => FIELD_UNITS[fieldKey].state === 'unconfirmed');
    expect(unconfirmedKeys).toHaveLength(6);
    for (const fieldKey of unconfirmedKeys) {
      expect(created[0]?.nextFields?.[fieldKey]).toBeUndefined();
      expect(created[0]?.changes.map((change) => change.fieldKey)).not.toContain(fieldKey);
      expect(created[0]?.adoptions.map((adoption) => adoption.fieldKey)).not.toContain(fieldKey);
    }
    const unitIssues = created[0]?.issues.filter((issue) => issue.kind === 'unit_unconfirmed') ?? [];
    expect(unitIssues.map((issue) => issue.detail.fieldKey).sort()).toEqual([...unconfirmedKeys].sort());
    for (const issue of unitIssues) {
      expect(typeof issue.detail.sourceRaw).toBe('string');
      expect((issue.detail.sourceRaw as string).length).toBeGreaterThan(0);
    }
    // Other confirmed fields are still created.
    expect(created[0]?.changes.map((change) => change.fieldKey)).toContain('cartonQuantity');

    const afterCreate = applyPlan(first.state, createPlan);
    const repeat = planWith(simulations[0], afterCreate, {
      appliedSnapshots: [{ snapshotKey: simulations[0].snapshotKey, capturedAt: simulations[0].capturedAt, status: 'applied' }],
    });
    expect(repeat.decision).toBe('replay');
  });

  it('suspected code change becomes needs_review (no create, no re-bind)', () => {
    const { state } = baseline();
    const renamed = renameCode(fixture, 'WM0072', 'WM9072');
    const plan = planWith(renamed, state);
    const suspected = plan.results.find((result) => result.reasonCode === 'SUSPECTED_CODE_CHANGE');
    expect(suspected?.action).toBe('needs_review');
    expect(suspected?.createCode).toBeNull();
    expect(suspected?.itemId).toBeNull();
    expect(suspected?.nextFields).toBeNull();
    expect(suspected?.issues.some((issue) => issue.kind === 'suspected_code_change')).toBe(true);
    expect(plan.results.find((result) => result.sourceKey === codeSourceKey('WM0072'))?.missing).toBe(true);
  });

  it('suggests a missing-code candidate by exact name without creating or auto-assigning', () => {
    const state = makeCatalogState();
    const uncodedName = 'ICE LERSKIN 烟酰胺提亮精华水150ml';
    const withUncoded: CatalogState = {
      ...state,
      items: [
        ...state.items,
        { itemId: 'item-uncoded', revision: 2, iceCode: null, nameCn: uncodedName, fields: {} },
      ],
    };
    const withUncodedRow = duplicateRowWith(fixture, 'WM0072', { code: '', fields: { nameCn: uncodedName } });
    const plan = planWith(withUncodedRow, withUncoded);
    const candidate = plan.results.find((result) => result.reasonCode === 'MISSING_CODE_CANDIDATE');
    expect(candidate?.action).toBe('needs_review');
    expect(candidate?.itemId).toBe('item-uncoded');
    expect(candidate?.nextFields).toBeNull();
    expect(plan.results.some((result) => result.action === 'create')).toBe(false);
  });

  it('reports a field conflict while still writing other non-conflicting fields', () => {
    const first = baseline();
    const itemId = 'item-WM0072';
    const withLocalEdit = clampState(first.state, itemId, {
      ...(first.state.items.find((item) => item.itemId === itemId)?.fields ?? {}),
      nameCn: observed('本地手工改名'),
    });
    const source = changeRowsOfCode(
      changeRowsOfCode(fixture, 'WM0072', 'nameCn', '来源改名'),
      'WM0072',
      'cartonQuantity',
      '321',
    );
    const plan = planWith(source, withLocalEdit);
    const result = plan.results.find((candidate) => candidate.itemId === itemId);
    expect(result?.action).toBe('needs_review');
    expect(result?.reasonCode).toBe('FIELD_CONFLICT');
    expect(result?.expectedRevision).not.toBeNull();
    expect(result?.nextFields).not.toBeNull();
    expect(result?.changes.map((change) => change.fieldKey)).toEqual(['cartonQuantity']);
    expect(result?.issues.some((issue) => issue.kind === 'field_conflict')).toBe(true);
    // Local value preserved in nextFields.
    const nextName = result?.nextFields?.nameCn;
    expect(nextName?.state === 'observed' ? nextName.raw : null).toBe('本地手工改名');
  });

  it('defers the whole item when the only outcome is a conflict', () => {
    const state = makeCatalogState();
    const itemId = 'item-WM0072';
    const manual = clampState(state, itemId, { nameCn: observed('本地名称'), barcode: observed('6900000000001') });
    const withBase: CatalogState = {
      ...manual,
      adoptions: [
        ...manual.adoptions,
        { itemId, fieldKey: 'nameCn', adoptedRaw: '基线名称', adoptedState: 'observed', unitState: 'not_applicable' },
        { itemId, fieldKey: 'barcode', adoptedRaw: '6900000000000', adoptedState: 'observed', unitState: 'not_applicable' },
      ],
    };
    const source = changeRowsOfCode(changeRowsOfCode(fixture, 'WM0072', 'nameCn', '来源名称'), 'WM0072', 'barcode', '6900000000002');
    const plan = planWith(source, withBase);
    const result = plan.results.find((candidate) => candidate.itemId === itemId);
    expect(result?.action).toBe('needs_review');
    expect(result?.nextFields).toBeNull();
    expect(result?.expectedRevision).toBeNull();
    expect(result?.changes).toEqual([]);
  });

  it('records invalid carton quantity as invalid_value review while other fields update', () => {
    const first = baseline();
    const source = changeRowsOfCode(
      changeRowsOfCode(fixture, 'WM0072', 'cartonQuantity', 'abc'),
      'WM0072',
      'nameCn',
      '无效数量同批改名',
    );
    const plan = planWith(source, first.state);
    const result = plan.results.find((candidate) => candidate.itemId === 'item-WM0072');
    expect(result?.action).toBe('needs_review');
    expect(result?.reasonCode).toBe('INVALID_CARTON_QUANTITY');
    expect(result?.issues.some((issue) => issue.kind === 'invalid_value')).toBe(true);
    expect(result?.nextFields).not.toBeNull();
    expect(result?.changes.map((change) => change.fieldKey)).toEqual(['nameCn']);
  });

  it('records unit-unconfirmed differences as review while still writing other fields', () => {
    const first = baseline();
    const itemId = 'item-WM0072';
    const withLocalUnit = clampState(first.state, itemId, {
      ...(first.state.items.find((item) => item.itemId === itemId)?.fields ?? {}),
      cartonWeight: observed('15'),
    });
    const withUnitBase = withAdoption(withLocalUnit, itemId, 'cartonWeight', '15');
    const source = changeRowsOfCode(
      changeRowsOfCode(fixture, 'WM0072', 'cartonWeight', '20'),
      'WM0072',
      'cartonQuantity',
      '321',
    );
    const plan = planWith(source, withUnitBase);
    const result = plan.results.find((candidate) => candidate.itemId === itemId);
    expect(result?.action).toBe('needs_review');
    expect(result?.issues.some((issue) => issue.kind === 'unit_unconfirmed')).toBe(true);
    expect(result?.nextFields).not.toBeNull();
    expect(result?.changes.map((change) => change.fieldKey)).toEqual(['cartonQuantity']);
    const nextWeight = result?.nextFields?.cartonWeight;
    expect(nextWeight?.state === 'observed' ? nextWeight.raw : null).toBe('15');
  });

  it('builds a deterministic batch payload whose only restricted data is cells/amounts', () => {
    const first = baseline();
    const payload = buildBatchPayload({
      snapshot: fixture,
      plan: first.plan,
      artifacts: [],
      adoptionSha256: computeAdoptionDigest(toPlanPayload(first.plan)),
    });
    expect(payload.rows).toHaveLength(403);
    expect(payload.rows.filter((row) => row.isBusinessRow)).toHaveLength(131);
    expect(payload.rows.filter((row) => !row.isBusinessRow)).toHaveLength(272);
    expect(payload.rows[0]?.iceCode).toBe(firstObservedRowCode());
    expect(payload.rows.filter((row) => !row.isBusinessRow).every((row) => row.iceCode === null)).toBe(true);
    expect(payload.rowsSha256).toBe(computeRowsSha256(payload.rows));
    expect(payload.rowsSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(payload.origin).toBe('real_capture');
    expect(payload.simulationNote).toBeNull();
    expect(payload.parentBatchId).toBeNull();
    expect(payload.amounts).toEqual([]); // redacted fixture: no restricted values
    expect(payload.collection).toEqual(fixture.collection);
    // Plan JSON (counts/results/issues/changes) never carries restricted labels/keys.
    expectNoRestrictedContent(toPlanPayload(first.plan));
    expectNoRestrictedContent(first.plan.issues);
  });

  it('computes a stable adoption digest', () => {
    const first = baseline();
    const payload = toPlanPayload(first.plan);
    const digest = computeAdoptionDigest(payload);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(computeAdoptionDigest(payload)).toBe(digest);
    const changed = toPlanPayload(planWith(fixture, first.state));
    expect(computeAdoptionDigest(changed)).not.toBe(digest);
  });
});

// ---------------------------------------------------------------------------
// Simulations
// ---------------------------------------------------------------------------

describe('simulated snapshots', () => {
  it('builds two local simulations with recomputed keys and no restricted values', () => {
    const simulations = buildSimulatedSnapshots(fixture);
    expect(simulations).toHaveLength(2);
    const kinds = new Set(simulations[0]?.simulation?.changes.map((change) => change.kind));
    for (const kind of ['field_change', 'row_inserted', 'code_missing', 'code_suspected_changed', 'formula_error', 'blanked', 'code_duplicate']) {
      expect(kinds.has(kind as never)).toBe(true);
    }
    expect(simulations[1]?.simulation?.changes.some((change) => change.kind === 'rows_reordered')).toBe(true);
    expect(simulations[1]?.simulation?.changes.some((change) => change.kind === 'columns_reordered')).toBe(true);
    for (const snapshot of simulations) {
      expect(snapshot.origin).toBe('local_simulation');
      expect(snapshot.simulation?.baseSnapshotKey).toBe(fixture.snapshotKey);
      expect(snapshot.snapshotKey).toMatch(/^[a-f0-9]{64}$/);
      expect(verifySnapshotKey(snapshot)).toBe(true);
      expect(validateSnapshot(snapshot).ok).toBe(true);
      expectNoRestrictedContent(snapshot.simulation?.changes ?? []);
      expect(describeSimulations([snapshot])[0]?.snapshotKey).toBe(snapshot.snapshotKey);
    }
    expect(simulations[0]?.snapshotKey).not.toBe(simulations[1]?.snapshotKey);
    expect(simulations[0]?.simulation?.note).toContain('本地模拟变化，非飞书真实修改');
    expect(simulations[1]?.simulation?.note).toContain('本地模拟变化，非飞书真实修改');
  });

  it('produces no false revisions when the reordered snapshot is applied after the changed one', () => {
    const first = baseline();
    const simulations = buildSimulatedSnapshots(fixture);
    const plan002 = planWith(simulations[0] as SourceSnapshot, first.state);
    expect(plan002.countsHint.created).toBe(1);
    // Business changes are written through partial needs_review results because
    // unconfirmed-unit values are always held.
    expect(plan002.results.some((result) => result.changes.length > 0)).toBe(true);
    expect(plan002.results.some((result) => result.changes.some((change) => change.fieldKey === 'cartonQuantity'))).toBe(true);
    const after002 = applyPlan(first.state, plan002);
    const plan003 = planWith(simulations[1] as SourceSnapshot, after002, {
      appliedSnapshots: [
        { snapshotKey: simulations[0]?.snapshotKey as string, capturedAt: simulations[0]?.capturedAt as string, status: 'applied' },
      ],
      latestAppliedCapturedAt: simulations[0]?.capturedAt as string,
    });
    expect(plan003.decision).toBe('apply');
    expect(plan003.countsHint.created).toBe(0);
    expect(plan003.countsHint.updated).toBe(0);
    expect(plan003.countsHint.failed).toBe(0);
    for (const result of plan003.results) expect(result.action).not.toBe('update');
    // Reorder must not add anomalies: 003 reviews = 002 reviews + the item created
    // by 002 (its unconfirmed-unit values are held for review once it is bound).
    const reviewCodes002 = plan002.results.filter((result) => result.action === 'needs_review').map((result) => result.sourceKey).sort();
    const reviewCodes003 = plan003.results.filter((result) => result.action === 'needs_review').map((result) => result.sourceKey).sort();
    expect(reviewCodes003.filter((code) => !reviewCodes002.includes(code))).toEqual(['code:WM9001']);
    expect(reviewCodes002.every((code) => reviewCodes003.includes(code))).toBe(true);
  });

  it('keeps the same UUID path for rename and value changes (no create on rename)', () => {
    const first = baseline();
    // Rename an existing coded item: same itemId, a name change, no new item.
    const renamed = changeRowsOfCode(fixture, 'WM0072', 'nameCn', '来源改名（同 UUID）');
    const renamePlan = planWith(renamed, first.state);
    const renameResult = renamePlan.results.find((result) => result.itemId === 'item-WM0072');
    expect(renameResult?.action).toBe('update');
    expect(renameResult?.createCode).toBeNull();
    expect(renameResult?.expectedRevision).toBe(1);
    expect(renameResult?.changes.map((change) => change.fieldKey)).toEqual(['nameCn']);
    expect(renamePlan.results.some((result) => result.createCode === 'WM0072')).toBe(false);

    // Value change on an existing coded item: bound itemId, non-null revision.
    const firstPlanChanges = first.plan.results.find((result) => result.action === 'update');
    const targetCode = firstPlanChanges?.iceCode === null || firstPlanChanges?.iceCode === undefined
      ? 'LS101274'
      : firstPlanChanges.iceCode;
    const currentQuantity = firstPlanChanges?.changes.find((change) => change.fieldKey === 'cartonQuantity')?.afterRaw ?? '100';
    const changed = changeRowsOfCode(fixture, targetCode, 'cartonQuantity', String(Number(currentQuantity) + 7));
    const valuePlan = planWith(changed, first.state);
    const valueResult = valuePlan.results.find((result) => result.itemId === `item-${targetCode}`);
    expect(valueResult).not.toBeUndefined();
    expect(valueResult?.createCode).toBeNull();
    expect(valueResult?.expectedRevision).not.toBeNull();
    expect(valueResult?.changes.some((change) => change.fieldKey === 'cartonQuantity')).toBe(true);
    expect(valuePlan.results.some((result) => result.action === 'create')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Restricted amount isolation and retry planning
// ---------------------------------------------------------------------------

describe('restricted amount isolation and retry planning', () => {
  it('strips price columns by header mapping and keeps ordinary text (normal order)', () => {
    const snapshot = withRestrictedValues(
      fixture,
      { costPrice: '11.11', operatingPrice: '22.22', shippingPrice: '33.33' },
      2,
    );
    const plan = planWith(snapshot, makeCatalogState());
    const payload = buildBatchPayload({
      snapshot,
      plan,
      artifacts: [],
      adoptionSha256: computeAdoptionDigest(toPlanPayload(plan)),
    });
    const restrictedLetters = new Set(Object.values(restrictedColumnsOf(snapshot)));
    const rowTwo = payload.rows.find((row) => row.rowNumber === 2);
    expect(rowTwo).toBeDefined();
    for (const letter of restrictedLetters) expect(rowTwo?.cells[letter]).toBeUndefined();
    expect(rowTwo?.cells.B).toBeDefined();
    expect(JSON.stringify(rowTwo?.cells)).not.toContain('11.11');
    expect(payload.amounts).toEqual([
      {
        rowNumber: 2,
        payload: { costPrice: '11.11', operatingPrice: '22.22', shippingPrice: '33.33' },
      },
    ]);
    for (const row of payload.rows) {
      for (const letter of restrictedLetters) expect(row.cells[letter]).toBeUndefined();
    }
    expect(payload.retryOfBatchId).toBeNull();
    expectNoRestrictedContent(toPlanPayload(plan));
    expect(JSON.stringify(toPlanPayload(plan))).not.toContain('11.11');
  });

  it('resolves price columns after a column reorder and preserves ordinary text in I/J/Y', () => {
    const reordered = moveRestrictedColumnsToAbCd(fixture);
    expect(restrictedColumnsOf(reordered)).toEqual({ costPrice: 'AB', operatingPrice: 'AC', shippingPrice: 'AD' });
    const withValues = cloneSnapshotCells(reordered, (rows) => {
      const row = rows.find((candidate) => candidate.rowNumber === 2);
      if (!row) throw new Error('TEST_ROW_NOT_FOUND:2');
      row.cells.AB = '11.11';
      row.cells.AC = '22.22';
      row.cells.AD = '33.33';
      row.cells.I = '普通I文本';
      row.cells.J = '普通J文本';
      row.cells.Y = '普通Y文本';
    });
    const plan = planWith(withValues, makeCatalogState());
    const payload = buildBatchPayload({
      snapshot: withValues,
      plan,
      artifacts: [],
      adoptionSha256: computeAdoptionDigest(toPlanPayload(plan)),
    });
    const rowTwo = payload.rows.find((row) => row.rowNumber === 2);
    expect(rowTwo?.cells.AB).toBeUndefined();
    expect(rowTwo?.cells.AC).toBeUndefined();
    expect(rowTwo?.cells.AD).toBeUndefined();
    expect(rowTwo?.cells.I).toBe('普通I文本');
    expect(rowTwo?.cells.J).toBe('普通J文本');
    expect(rowTwo?.cells.Y).toBe('普通Y文本');
    expect(payload.amounts).toEqual([
      {
        rowNumber: 2,
        payload: { costPrice: '11.11', operatingPrice: '22.22', shippingPrice: '33.33' },
      },
    ]);
    expect(JSON.stringify(rowTwo?.cells)).not.toContain('11.11');
    const original = fixture.rows.find((row) => row.rowNumber === 2);
    const reorderedRow = withValues.rows.find((row) => row.rowNumber === 2);
    expect(reorderedRow?.fields.nameCn?.raw).toBe(original?.fields.nameCn?.raw);
    expectNoRestrictedContent(toPlanPayload(plan));
  });

  it('carries retryOfBatchId through buildBatchPayload', () => {
    const plan = planWith(fixture, makeCatalogState());
    const payload = buildBatchPayload({
      snapshot: fixture,
      plan,
      artifacts: [],
      adoptionSha256: computeAdoptionDigest(toPlanPayload(plan)),
      retryOfBatchId: 'batch-retry-1',
    });
    expect(payload.retryOfBatchId).toBe('batch-retry-1');
  });

  it('filters retried results to the requested keys, keeps full seenItemIds and skips replay', () => {
    const state = makeCatalogState();
    const withFakeBinding: CatalogState = {
      ...state,
      bindings: [...state.bindings, { itemId: 'item-missing', iceCode: 'WM9999' }],
    };
    const full = planWith(fixture, withFakeBinding);
    const failed = full.results.filter((result) => result.action === 'failed');
    expect(failed.map((result) => result.sourceKey)).toEqual(['code:WM9999']);
    const retry = planWith(fixture, withFakeBinding, { retryFailedSourceKeys: ['code:WM9999'] });
    expect(retry.decision).toBe('apply');
    expect(retry.results.map((result) => result.sourceKey)).toEqual(['code:WM9999']);
    expect(retry.countsHint.failed).toBe(1);
    expect(retry.seenItemIds).toEqual(full.seenItemIds);
    expect(retry.seenItemIds).toHaveLength(125);

    const reviewRetry = planWith(fixture, withFakeBinding, { retryFailedSourceKeys: ['row:122'] });
    expect(reviewRetry.results.map((result) => result.sourceKey)).toEqual(['row:122']);

    const replayRetry = planWith(fixture, makeCatalogState(), {
      retryFailedSourceKeys: ['row:122'],
      appliedSnapshots: [{ snapshotKey: fixture.snapshotKey, capturedAt: fixture.capturedAt, status: 'applied' }],
    });
    expect(replayRetry.decision).toBe('apply');
    expect(replayRetry.results.map((result) => result.sourceKey)).toEqual(['row:122']);

    const emptyRetry = planWith(fixture, makeCatalogState(), { retryFailedSourceKeys: [] });
    expect(emptyRetry.decision).toBe('apply');
    expect(emptyRetry.results).toEqual([]);
    expect(emptyRetry.seenItemIds).toHaveLength(makeCatalogState().items.length);
  });

  it('holds existing-item unconfirmed unit values without adopting or writing them', () => {
    const { plan } = baseline();
    const held = plan.results.filter((result) => result.issues.some((issue) => issue.kind === 'unit_unconfirmed'));
    expect(held.length).toBeGreaterThan(0);
    for (const result of held) {
      expect(result.adoptions.every((adoption) => adoption.unitState !== 'unconfirmed')).toBe(true);
      expect(result.changes.every((change) => FIELD_UNITS[change.fieldKey].state !== 'unconfirmed')).toBe(true);
    }
    const issue = held[0]?.issues.find((candidate) => candidate.kind === 'unit_unconfirmed');
    expect(issue?.detail.beforeRaw).toBeNull();
    expect(typeof issue?.detail.sourceRaw).toBe('string');
    expect((issue?.detail.sourceRaw as string).length).toBeGreaterThan(0);
    expect(Array.isArray(issue?.detail.rows)).toBe(true);
  });

  it('does not create unit_unconfirmed issues for empty unconfirmed source values on a new item', () => {
    const unconfirmedKeys = ADOPTABLE_FIELD_KEYS.filter((fieldKey) => FIELD_UNITS[fieldKey].state === 'unconfirmed');
    const newRowSnapshot = duplicateRowWith(fixture, 'WM0072', {
      code: 'WM9002',
      fields: { nameCn: '模拟空单位新品', cartonQuantity: '60', barcode: '6900000000099' },
    });
    const codeColumn = fixtureMapping.iceCode;
    if (!codeColumn) throw new Error('TEST_MAPPING_MISSING:iceCode');
    const cleared = cloneSnapshotCells(newRowSnapshot, (rows) => {
      const row = rows.find((candidate) => normalizeCellText(candidate.cells[codeColumn] ?? '') === 'WM9002');
      if (!row) throw new Error('TEST_ROW_NOT_FOUND:WM9002');
      for (const fieldKey of unconfirmedKeys) {
        const column = fixtureMapping[fieldKey];
        if (column) row.cells[column] = '';
      }
    });
    const plan = planWith(cleared, makeCatalogState());
    const created = plan.results.find((result) => result.createCode === 'WM9002');
    expect(created?.action).toBe('create');
    expect(created?.issues.filter((issue) => issue.kind === 'unit_unconfirmed')).toEqual([]);
    for (const fieldKey of unconfirmedKeys) expect(created?.nextFields?.[fieldKey]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

describe('readers', () => {
  it('local reader lists/reads the committed fixture and ignores manifest/non-snapshot JSON', async () => {
    const reader = createLocalSnapshotReader({ rootDir: FIXTURE_DIR });
    expect(reader.profileKey).toBe(SOURCE_PROFILE_KEY);
    expect(reader.describe()).toMatchObject({ mode: 'local_snapshot' });
    const summaries = await reader.listSnapshots();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      snapshotKey: fixture.snapshotKey,
      capturedAt: fixture.capturedAt,
      origin: 'real_capture',
      complete: true,
      fileName: 'snapshot-001-redacted.json',
    });
    const snapshot = await reader.readSnapshot(fixture.snapshotKey);
    expect(snapshot.snapshotKey).toBe(fixture.snapshotKey);
    await expect(reader.readSnapshot('f'.repeat(64))).rejects.toMatchObject({ code: 'SOURCE_SNAPSHOT_NOT_FOUND' });
    await expect(reader.readSnapshot('not-a-key')).rejects.toMatchObject({ code: 'SOURCE_SNAPSHOT_NOT_FOUND' });
  });

  it('rejects a tampered snapshot whose key no longer matches its content', async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'product-source-reader-'));
    try {
      const tampered = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as SourceSnapshot;
      tampered.rows[0].cells.B = `${tampered.rows[0].cells.B}（篡改）`;
      writeFileSync(path.join(tempDir, 'tampered.json'), JSON.stringify(tampered), 'utf8');
      writeFileSync(path.join(tempDir, 'manifest.json'), '{}', 'utf8');
      writeFileSync(path.join(tempDir, 'notes.json'), JSON.stringify({ contract: 'other' }), 'utf8');
      const reader = createLocalSnapshotReader({ rootDir: tempDir });
      await expect(reader.listSnapshots()).rejects.toMatchObject({ code: 'SOURCE_SNAPSHOT_KEY_MISMATCH' });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('reports a missing snapshot directory instead of silently returning nothing', async () => {
    const reader = createLocalSnapshotReader({ rootDir: path.join(os.tmpdir(), 'definitely-missing-source-dir') });
    await expect(reader.listSnapshots()).rejects.toMatchObject({ code: 'SOURCE_SNAPSHOT_DIR_MISSING' });
  });

  it('API reader always reports FEISHU_API_NOT_CONFIGURED', async () => {
    const reader = createFeishuApiReader();
    expect(reader.describe()).toMatchObject({ mode: 'feishu_api' });
    await expect(reader.listSnapshots()).rejects.toMatchObject({ code: FEISHU_API_NOT_CONFIGURED });
    await expect(reader.readSnapshot(fixture.snapshotKey)).rejects.toMatchObject({ code: FEISHU_API_NOT_CONFIGURED });
  });

  it('assertSnapshotShape rejects non-snapshot payloads', () => {
    expect(() => assertSnapshotShape({ hello: 'world' })).toThrowError(/SOURCE_SNAPSHOT_INVALID/);
    expect(() => assertSnapshotShape({ ...fixture, snapshotKey: 'short' })).toThrowError(/SOURCE_SNAPSHOT_INVALID/);
  });
});

// ---------------------------------------------------------------------------
// Script cross-checks
// ---------------------------------------------------------------------------

describe('build scripts', () => {
  it('build-simulations.mjs reuses simulate.ts (identical snapshot keys and changes)', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'product-source-sim-'));
    try {
      const result = spawnSync(
        process.execPath,
        [path.join(REPO_ROOT, 'scripts/catalog/feishu-source/build-simulations.mjs'), '--snapshot', SNAPSHOT_PATH, '--out', tempDir],
        { cwd: REPO_ROOT, encoding: 'utf8' },
      );
      expect(result.status, result.stderr).toBe(0);
      const tsSimulations = buildSimulatedSnapshots(fixture);
      for (const [index, name] of ['snapshot-002-simulated.json', 'snapshot-003-simulated.json'].entries()) {
        const scriptSimulation = assertSnapshotShape(
          JSON.parse(readFileSync(path.join(tempDir, name), 'utf8')) as unknown,
        );
        expect(scriptSimulation.snapshotKey).toBe(tsSimulations[index]?.snapshotKey);
        expect(scriptSimulation.simulation?.changes).toEqual(tsSimulations[index]?.simulation?.changes);
        expect(scriptSimulation.capturedAt).toBe(tsSimulations[index]?.capturedAt);
      }
      const changeLog = JSON.parse(readFileSync(path.join(tempDir, 'simulation-changes.json'), 'utf8')) as {
        simulations: { snapshotKey: string; changes: unknown[] }[];
      };
      expect(changeLog.simulations.map((entry) => entry.snapshotKey)).toEqual(
        tsSimulations.map((snapshot) => snapshot.snapshotKey),
      );
      expect(existsSync(path.join(tempDir, 'simulation-changes.md'))).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.skipIf(!existsSync(RAW_TSV_PATH))('build-snapshot.mjs reproduces the committed fixture hashes', () => {
    const outDir = path.join(REPO_ROOT, '.local/catalog/fs-catalog-sim-20261025/run/verify-tmp');
    const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'product-source-fixture-'));
    try {
      rmSync(outDir, { recursive: true, force: true });
      const result = spawnSync(
        process.execPath,
        [
          path.join(REPO_ROOT, 'scripts/catalog/feishu-source/build-snapshot.mjs'),
          '--raw',
          RAW_TSV_PATH,
          '--metadata',
          RAW_METADATA_PATH,
          '--out',
          outDir,
          '--fixture-dir',
          fixtureDir,
        ],
        { cwd: REPO_ROOT, encoding: 'utf8' },
      );
      expect(result.status, result.stderr).toBe(0);
      const rebuiltManifest = JSON.parse(readFileSync(path.join(outDir, 'manifest.json'), 'utf8')) as {
        hashes: { fullSnapshotSha256: string; redactedSnapshotSha256: string };
        grid: { businessRowCount: number; uniqueCodeCount: number };
      };
      const rebuiltFixture = assertSnapshotShape(
        JSON.parse(readFileSync(path.join(fixtureDir, 'snapshot-001-redacted.json'), 'utf8')) as unknown,
      );
      expect(rebuiltFixture.snapshotKey).toBe(manifest.hashes.redactedSnapshotSha256);
      expect(rebuiltManifest.hashes.redactedSnapshotSha256).toBe(fixture.snapshotKey);
      expect(rebuiltManifest.grid.businessRowCount).toBe(131);
      expect(rebuiltManifest.grid.uniqueCodeCount).toBe(125);
      expect(rebuiltManifest.hashes.fullSnapshotSha256).toBe(manifest.hashes.fullSnapshotSha256);
      // Real capture copy is byte-identical to the source TSV.
      expect(readFileSync(path.join(outDir, 'snapshot-001-real.capture.tsv'))).toEqual(readFileSync(RAW_TSV_PATH));
      expect(existsSync(path.join(outDir, 'fixture-snapshot-001-redacted.json'))).toBe(true);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
