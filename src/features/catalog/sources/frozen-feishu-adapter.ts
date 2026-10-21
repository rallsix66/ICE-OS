import 'server-only';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { catalogSourceRoot, payloadSha256, sha256, storePrivateArtifact } from '../evidence-store';
import { observedField, unknownScope } from './baseline-adapter';
import type { FieldObservation, PreparedFrozenObservations, PreparedObservation } from '../types';

export const FEISHU_SNAPSHOT_DIRECTORY = '.local/product-library-discovery/run-20261020T065606Z-78ecad79/evidence';
export const FEISHU_SNAPSHOT_NAME = 'feishu-observations.parsed.v2.json';
export const FEISHU_SNAPSHOT_SHA256 = '3baa83cf4dcb7cde50511148d230b5dd947053685a21857d502358491216a640';
const rawPins: Record<string, string> = {
  'feishu-header-cells.raw.json': '1ceb1ac72535307c86eecf9f28974d4c5f749cd9d6a8ccb252ca7fc0c537928b',
  'feishu-header-extra.raw.json': 'ad18389c545793c48ab7c6e959496031063d9bdf031104ae19364c9aa3f6ebcc',
  'feishu-sample-cells.raw.json': 'f37b65d29e280b441805c0a6b0bc110beb51b92359d9ef662d997dffb62fef52',
  'feishu-targeted-cells.raw.json': '9f784215cf871ff77b7d23f4f557f7f8f08cd35df8c2c79e7a735c318911acec',
  'feishu-repeat-cells.raw.json': '6509a2633568d5d7793209483da6d2994b3bc3cfe0746c48373e3396c1d5c2d4',
};
interface FrozenCell { address: string; collected_at: string; status: string; formula_bar_text: string | null; evidence: string }
interface FrozenSnapshot { parser: string; complete: boolean; source_url: string; cells: FrozenCell[];
  observed_headers: Record<string, string>; observed_data_rows: number[]; collected_at_start: string; collected_at_end: string }

export function parseFrozenFeishuBytes(bytes: Uint8Array): Omit<PreparedFrozenObservations, 'artifact' | 'artifacts' | 'contentSha256'> {
  if (sha256(bytes) !== FEISHU_SNAPSHOT_SHA256) throw new Error('FEISHU_SNAPSHOT_PIN_MISMATCH');
  const snapshot = JSON.parse(Buffer.from(bytes).toString('utf8')) as FrozenSnapshot;
  if (snapshot.complete !== false || snapshot.cells.length !== 159 || Object.keys(snapshot.observed_headers).length !== 27 || snapshot.observed_data_rows.length !== 16) throw new Error('FEISHU_PARTIAL_COVERAGE_INVALID');
  const observations: PreparedObservation[] = snapshot.cells.map((cell, index) => {
    const match = /^([A-Z]+)([1-9]\d*)$/.exec(cell.address);
    if (!match) throw new Error('FEISHU_CELL_POSITION_INVALID');
    const ref = `${FEISHU_SNAPSHOT_NAME}#/cells/${index}`;
    let value: FieldObservation;
    if (cell.status === 'formula_bar_no_text' && cell.formula_bar_text === null) value = { state: 'no_text', raw: null, evidenceRef: ref };
    else if (cell.status === 'observed_formula_bar_text' && typeof cell.formula_bar_text === 'string') value = observedField(cell.formula_bar_text, ref);
    else throw new Error('FEISHU_CELL_STATE_INVALID');
    const row = Number(match[2]), column = match[1];
    // Header labels are not amount values. Every data I/J/Y observation is private.
    const amount = row > 1 && ['I', 'J', 'Y'].includes(column);
    const fields: Record<string, FieldObservation> = amount ? {} : { value };
    const amounts: Record<string, FieldObservation> = amount ? { [column]: value } : {};
    return { system: 'feishu', entryKey: `/cells/${index}`, legacyCandidateId: null,
      position: { sheet: 'Sheet1', row, cell: cell.address },
      fields, amounts,
      reviewState: null, rawRef: ref, payloadSha256: payloadSha256(cell),
      scope: { account: unknownScope('WIKI_OWNER_LABEL_IS_NOT_VERIFIED_ACCOUNT_ID'),
        market: unknownScope('SHARED_TABLE_MARKET_UNVERIFIED'), warehouse: unknownScope('SHARED_TABLE_WAREHOUSE_UNVERIFIED') } };
  });
  if (new Set(observations.map((observation) => observation.position.cell)).size !== 159) throw new Error('FEISHU_DUPLICATE_CELL');
  return { approvedSnapshotId: 'feishu-partial-20261020-v2', snapshotKey: FEISHU_SNAPSHOT_SHA256, parserVersion: 'catalog-frozen-feishu-v1', observations,
    coverage: { complete: false, headers: 27, dataRowPositions: snapshot.observed_data_rows, cells: 159,
      sourceUrl: snapshot.source_url, collectedAtStart: snapshot.collected_at_start, collectedAtEnd: snapshot.collected_at_end,
      sourceUpdatedAt: null, cursor: null, stableRecordId: null } };
}

export async function loadFrozenFeishu(): Promise<PreparedFrozenObservations> {
  const root = path.resolve(catalogSourceRoot(), FEISHU_SNAPSHOT_DIRECTORY);
  const names = [FEISHU_SNAPSHOT_NAME, ...Object.keys(rawPins)];
  const inputs = [];
  for (const name of names) {
    const file = path.join(root, name);
    if ((await fs.lstat(file)).isSymbolicLink()) throw new Error('FEISHU_INPUT_LINK_DENIED');
    const bytes = await fs.readFile(file);
    if (sha256(bytes) !== (name === FEISHU_SNAPSHOT_NAME ? FEISHU_SNAPSHOT_SHA256 : rawPins[name])) throw new Error('FEISHU_EVIDENCE_PIN_MISMATCH');
    inputs.push({ name, bytes });
  }
  const parsed = parseFrozenFeishuBytes(inputs[0].bytes);
  const artifacts = [];
  for (const input of inputs) artifacts.push(await storePrivateArtifact(input.name, input.bytes));
  const result = { ...parsed, artifact: artifacts[0], artifacts };
  return { ...result, contentSha256: payloadSha256(result) };
}

export interface NonPriceDifference { field: string; adopted: FieldObservation; observed: FieldObservation; status: 'different' | 'unresolved'; evidenceRef: string }

/** Only exact source code+name permits a preview association; it is never binding. */
export function previewFrozenDifferences(item: { iceCode: string | null; nameCn: string; fields: Record<string, FieldObservation> }, observations: PreparedObservation[]): NonPriceDifference[] {
  if (!item.iceCode) return [];
  const byRow = new Map<number, Map<string, PreparedObservation>>();
  for (const observation of observations) {
    const row = observation.position.row, cell = observation.position.cell;
    if (row === null || row === 1 || !cell) continue;
    if (!byRow.has(row)) byRow.set(row, new Map());
    byRow.get(row)!.set(cell.replace(/\d+$/, ''), observation);
  }
  const differences: NonPriceDifference[] = [];
  for (const columns of byRow.values()) {
    if (columns.get('G')?.fields.value?.raw !== item.iceCode || columns.get('B')?.fields.value?.raw !== item.nameCn) continue;
    for (const [column, key] of [['A', 'sourceDate'], ['C', 'specification'], ['E', 'factory'], ['F', 'imageRef'], ['H', 'barcode']] as const) {
      const observed = columns.get(column)?.fields.value, adopted = item.fields[key];
      if (!observed || !adopted || (observed.state === 'observed' && observed.raw === adopted.raw)) continue;
      differences.push({ field: key, adopted, observed, status: observed.state === 'observed' ? 'different' : 'unresolved', evidenceRef: observed.evidenceRef });
    }
  }
  return differences;
}
