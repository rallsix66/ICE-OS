#!/usr/bin/env node
/**
 * Build the real-capture snapshot and its redacted repository fixture from the
 * raw clipboard TSV + capture metadata.
 *
 * Outputs (per Lead decision 2026-10-25):
 *   <outDir>/snapshot-001-real.json                 full snapshot (contains I/J/Y raw prices; .local only)
 *   <outDir>/fixture-snapshot-001-redacted.json     redacted (I/J/Y blanked + redaction marker)
 *   <outDir>/snapshot-001-real.capture.tsv          exact copy of the raw clipboard TSV
 *   <outDir>/snapshot-001-real.capture-metadata.json exact copy of capture metadata
 *   <outDir>/manifest.json                          contract/profile/document/range/capturedAt/grid/rows/headers/sha256
 *   <fixtureDir>/snapshot-001-redacted.json         committed sanitized fixture (same bytes as fixture-...json)
 *   <fixtureDir>/manifest.json                      fixture manifest copy
 *
 * The raw TSV and the full snapshot are NEVER written outside `.local/`.
 *
 * Usage:
 *   node scripts/catalog/feishu-source/build-snapshot.mjs \
 *     --raw <clipboard.raw.tsv> --metadata <capture-metadata.json> \
 *     [--out <run snapshot dir>] [--fixture-dir <repo fixture dir>]
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTsLoader } from './ts-loader.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const DEFAULT_CAPTURE_DIR = path.join(
  REPO_ROOT,
  '.local/catalog/fs-catalog-sim-20261025/capture/run1',
);
const DEFAULT_OUT_DIR = path.join(
  REPO_ROOT,
  '.local/catalog/fs-catalog-sim-20261025/snapshots',
);
const DEFAULT_FIXTURE_DIR = path.join(REPO_ROOT, 'tests/catalog/fixtures/product-source');
const RESTRICTED_COLUMNS = ['I', 'J', 'Y'];

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

/** Excel clipboard TSV parser: handles quoted cells, doubled quotes, embedded tabs/newlines. */
export function parseClipboardTsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"') inQuotes = true;
    else if (character === '\t') pushField();
    else if (character === '\r') {
      if (text[index + 1] === '\n') index += 1;
      pushRow();
    } else if (character === '\n') pushRow();
    else field += character;
  }
  if (field !== '' || row.length > 0) pushRow();
  return rows;
}

function excelColumnName(index) {
  let value = index;
  let name = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function padRow(cells, columnCount) {
  if (cells.length > columnCount) {
    throw new Error(`TSV_COLUMN_OVERFLOW:${cells.length}>${columnCount}`);
  }
  const padded = [...cells];
  while (padded.length < columnCount) padded.push('');
  return padded;
}

function ensureInsideLocal(targetPath) {
  const resolved = path.resolve(targetPath);
  if (!resolved.includes(`${path.sep}.local${path.sep}`)) {
    throw new Error(`FULL_SNAPSHOT_OUTSIDE_LOCAL_DENIED:${resolved}`);
  }
  return resolved;
}

function redactSnapshot(snapshot, restrictedColumns) {
  const redaction = {
    restrictedColumns: [...restrictedColumns],
    priceValuesRemoved: true,
    note: '仓库 fixture 已置空成本价格/运营价格/单品运费三列（I/J/Y），真实价格只保存在 .local 受限证据中。',
  };
  const rows = snapshot.rows.map((row) => {
    const cells = { ...row.cells };
    for (const column of restrictedColumns) cells[column] = '';
    return { ...row, cells };
  });
  return { ...snapshot, redaction, rows };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rawPath = path.resolve(args.raw ?? args.tsv ?? path.join(DEFAULT_CAPTURE_DIR, 'clipboard.raw.tsv'));
  const metadataPath = path.resolve(args.metadata ?? path.join(DEFAULT_CAPTURE_DIR, 'capture-metadata.json'));
  const outDir = ensureInsideLocal(args.out ?? DEFAULT_OUT_DIR);
  const fixtureDir = path.resolve(args['fixture-dir'] ?? DEFAULT_FIXTURE_DIR);

  const rawBytes = await fs.readFile(rawPath);
  const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
  const rawSha256 = sha256Hex(rawBytes);
  if (metadata.rawClipboardSha256 && rawSha256 !== metadata.rawClipboardSha256) {
    throw new Error(`RAW_TSV_HASH_MISMATCH:${rawSha256}!==${metadata.rawClipboardSha256}`);
  }
  if (metadata.rawClipboardBytes && rawBytes.length !== metadata.rawClipboardBytes) {
    throw new Error(`RAW_TSV_BYTES_MISMATCH:${rawBytes.length}!==${metadata.rawClipboardBytes}`);
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-source-build-'));
  const loader = createTsLoader({ tempDir });
  const sourceDir = path.join(REPO_ROOT, 'src/features/catalog/product-source');
  const contract = await loader.load(path.join(sourceDir, 'contract.ts'));
  const headersModule = await loader.load(path.join(sourceDir, 'headers.ts'));
  const normalizeModule = await loader.load(path.join(sourceDir, 'normalize.ts'));
  const readerModule = await loader.load(path.join(sourceDir, 'reader.ts'));

  const text = rawBytes.toString('utf8');
  const table = parseClipboardTsv(text);
  const requestedRange = String(metadata.requestedRange ?? '');
  const expectedGridRows = Number(/:[A-Z]+(\d+)$/.exec(requestedRange)?.[1] ?? '0');
  if (!Number.isInteger(expectedGridRows) || expectedGridRows < 2) {
    throw new Error(`REQUESTED_RANGE_INVALID:${requestedRange}`);
  }
  while (table.length > expectedGridRows && table[table.length - 1].every((cell) => cell.trim() === '')) {
    table.pop(); // tolerate a trailing empty record caused by a final newline
  }
  if (table.length !== expectedGridRows) throw new Error(`TSV_GRID_ROWS_INVALID:${table.length}!==${expectedGridRows}`);
  if (table.length < 2) throw new Error('TSV_NO_DATA_ROWS');
  const columnCount = table[0].length;
  if (columnCount !== 31) throw new Error(`TSV_COLUMN_COUNT_INVALID:${columnCount}`);
  const headers = {};
  table[0].forEach((cell, index) => {
    headers[excelColumnName(index + 1)] = cell;
  });
  const resolution = headersModule.resolveHeaderMapping(headers);
  if (!resolution.ok) {
    throw new Error(`HEADER_CONTRACT_INVALID:${resolution.issues.map((issue) => issue.detail).join('; ')}`);
  }
  const dataRows = table.slice(1);
  const gridRows = dataRows.length + 1;
  if (gridRows !== expectedGridRows) throw new Error(`TSV_GRID_ROWS_INVALID:${gridRows}`);

  const fieldColumns = resolution.fieldColumns;
  const nameColumn = fieldColumns.nameCn;
  const businessRows = [];
  const rows = [];
  for (let index = 0; index < dataRows.length; index += 1) {
    const cells = padRow(dataRows[index], columnCount);
    const cellsRecord = {};
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
      cellsRecord[excelColumnName(columnIndex + 1)] = cells[columnIndex];
    }
    const nameCn = (cellsRecord[nameColumn] ?? '').trim();
    const isBusinessRow = nameCn !== '';
    const fields = isBusinessRow ? normalizeModule.buildRowFields(cellsRecord, fieldColumns) : {};
    const rowNumber = index + 2;
    if (isBusinessRow) businessRows.push({ rowNumber, cells: cellsRecord, fields });
    // All data rows are stored (including empty rows) so row counts and the DB
    // is_empty flag can be verified; empty rows carry no mapped fields.
    rows.push({
      rowNumber,
      isBusinessRow,
      cells: cellsRecord,
      fields,
      rowSha256: readerModule.computeRowSha256({ rowNumber, cells: cellsRecord, fields }),
    });
  }

  const restrictedColumns = Object.values(resolution.restrictedColumns);
  if (restrictedColumns.length !== RESTRICTED_COLUMNS.length) {
    throw new Error(`RESTRICTED_COLUMNS_INVALID:${JSON.stringify(resolution.restrictedColumns)}`);
  }
  const restrictedCells = rows.filter(
    (row) => row.isBusinessRow && restrictedColumns.some((column) => (row.cells[column] ?? '') !== ''),
  );
  if (restrictedCells.length === 0) throw new Error('RESTRICTED_EVIDENCE_MISSING');

  const collection = {
    method: 'web_clipboard_copy',
    url: metadata.capturedUrl ?? metadata.sourceUrl,
    worksheetTitle: metadata.worksheetTitle,
    headerRow: 1,
    requestedRange: metadata.requestedRange,
    observedRange: `A1:${excelColumnName(columnCount)}${gridRows}`,
    gridRows,
    gridColumns: columnCount,
    businessRowCount: businessRows.length,
    emptyRowCount: dataRows.length - businessRows.length,
    complete: true,
    headers,
    rawEvidenceSha256: rawSha256,
    rawEvidenceBytes: rawBytes.length,
    truncated: false,
    readError: null,
  };

  const realSnapshot = {
    contract: contract.SNAPSHOT_CONTRACT,
    profileKey: contract.SOURCE_PROFILE_KEY,
    snapshotKey: '',
    origin: 'real_capture',
    capturedAt: metadata.endedAt,
    documentModifiedLabel: metadata.documentModifiedLabel ?? null,
    collection,
    simulation: null,
    redaction: null,
    rows,
  };
  realSnapshot.snapshotKey = readerModule.computeSnapshotKey(realSnapshot);

  const redactedSnapshot = redactSnapshot(realSnapshot, restrictedColumns);
  redactedSnapshot.rows = redactedSnapshot.rows.map((row) => ({
    ...row,
    rowSha256: readerModule.computeRowSha256(row),
  }));
  redactedSnapshot.snapshotKey = readerModule.computeSnapshotKey(redactedSnapshot);

  // Sanity checks against the verified capture facts (specification §1).
  const codes = new Set();
  const codeCounts = new Map();
  const rowsWithoutCode = [];
  for (const row of redactedSnapshot.rows) {
    if (!row.isBusinessRow) continue;
    const code = row.fields.iceCode?.state === 'observed' ? row.fields.iceCode.raw.trim() : '';
    if (code === '') {
      rowsWithoutCode.push(row.rowNumber);
      continue;
    }
    codes.add(code);
    codeCounts.set(code, (codeCounts.get(code) ?? 0) + 1);
  }
  const duplicateCodes = [...codeCounts.entries()].filter(([, count]) => count > 1).map(([code]) => code);
  if (codes.size !== 125) throw new Error(`UNIQUE_CODE_COUNT_INVALID:${codes.size}`);
  if (rowsWithoutCode.length !== 1 || rowsWithoutCode[0] !== 122) {
    throw new Error(`MISSING_CODE_ROWS_INVALID:${JSON.stringify(rowsWithoutCode)}`);
  }
  if (duplicateCodes.length !== 5) throw new Error(`DUPLICATE_CODE_COUNT_INVALID:${duplicateCodes.length}`);

  const realSha256 = sha256Hex(await fs.readFile(rawPath));
  const manifest = {
    contract: contract.SNAPSHOT_CONTRACT,
    profileKey: contract.SOURCE_PROFILE_KEY,
    document: {
      title: metadata.title,
      wikiNodeKey: 'TC2AwLgRniqWKhkg9D2cEx79n0b',
      spreadsheetToken: 'EMZGs2eIhh0YQ1tPIqMcR8SPnQh',
      sheetId: '33bab4',
      worksheetTitle: metadata.worksheetTitle,
      sourceUrl: metadata.sourceUrl,
      documentModifiedLabel: metadata.documentModifiedLabel ?? null,
      readOnlyLabel: metadata.readOnlyLabel ?? null,
      note: 'wiki 节点与 spreadsheet_token/sheet_id 为用户确认事实；匿名读取只能看到 Sheet1 与表头，本轮未由 API 复核 token。',
    },
    capture: {
      method: 'web_clipboard_copy',
      requestedRange: metadata.requestedRange,
      observedRange: collection.observedRange,
      startedAt: metadata.startedAt,
      endedAt: metadata.endedAt,
      userAgent: metadata.userAgent,
      rawCaptureSha256: realSha256,
      rawCaptureBytes: rawBytes.length,
      consoleErrorCount: Array.isArray(metadata.consoleErrors) ? metadata.consoleErrors.length : 0,
    },
    grid: {
      gridRows,
      gridColumns: columnCount,
      headerRow: 1,
      dataRowCount: dataRows.length,
      storedRowCount: rows.length,
      businessRowCount: businessRows.length,
      emptyRowCount: dataRows.length - businessRows.length,
      uniqueCodeCount: codes.size,
      duplicateCodes,
      rowsWithoutCode,
      headers,
    },
    files: {
      rawCaptureTsv: 'snapshot-001-real.capture.tsv',
      rawCaptureMetadata: 'snapshot-001-real.capture-metadata.json',
      fullSnapshot: 'snapshot-001-real.json',
      redactedFixtureInOutDir: 'fixture-snapshot-001-redacted.json',
      redactedFixtureInRepo: 'snapshot-001-redacted.json',
    },
    hashes: {
      fullSnapshotSha256: realSnapshot.snapshotKey,
      redactedSnapshotSha256: redactedSnapshot.snapshotKey,
      rawCaptureSha256: realSha256,
    },
    restricted: {
      columns: restrictedColumns,
      note: '成本价格/运营价格/单品运费只保存在 .local 的完整快照 cells 中；仓库 fixture 已置空并标记 redaction。价格不进入商品字段、差异计划、待核对明细或页面。',
    },
    fixtures: {
      testSnapshot: 'tests/catalog/fixtures/product-source/snapshot-001-redacted.json',
    },
  };

  await fs.mkdir(outDir, { recursive: true });
  await fs.mkdir(fixtureDir, { recursive: true });
  const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
  const realPath = path.join(outDir, 'snapshot-001-real.json');
  const redactedInOutDir = path.join(outDir, 'fixture-snapshot-001-redacted.json');
  const fixturePath = path.join(fixtureDir, 'snapshot-001-redacted.json');
  const manifestPath = path.join(outDir, 'manifest.json');
  const fixtureManifestPath = path.join(fixtureDir, 'manifest.json');
  await fs.writeFile(realPath, json(realSnapshot), 'utf8');
  await fs.writeFile(redactedInOutDir, json(redactedSnapshot), 'utf8');
  // Repository fixture is minified to keep the committed test fixture small.
  await fs.writeFile(fixturePath, `${JSON.stringify(redactedSnapshot)}\n`, 'utf8');
  await fs.writeFile(manifestPath, json(manifest), 'utf8');
  await fs.writeFile(fixtureManifestPath, json(manifest), 'utf8');
  await fs.copyFile(rawPath, path.join(outDir, 'snapshot-001-real.capture.tsv'));
  await fs.copyFile(metadataPath, path.join(outDir, 'snapshot-001-real.capture-metadata.json'));

  const summary = {
    outDir,
    fixtureDir,
    realSnapshot: { file: realPath, snapshotKey: realSnapshot.snapshotKey, rows: rows.length },
    redactedSnapshot: { file: fixturePath, snapshotKey: redactedSnapshot.snapshotKey, rows: rows.length },
    manifest: manifestPath,
    files: await fs.readdir(outDir),
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  await fs.rm(tempDir, { recursive: true, force: true });
}

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
