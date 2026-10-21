import 'server-only';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { catalogSourceRoot, payloadSha256, sha256, storePrivateArtifact } from '../evidence-store';
import type { FieldObservation, PreparedBaseline, PreparedDecision, PreparedItem, PreparedObservation, ScopeValue } from '../types';

export const BASELINE_DIRECTORY = '.local/p0-03/run-20261020-final-acceptance/evidence/final-2026-10-20T03-41-45-834059Z-cd7d4d19/delivery-final-v2';
export const BUNDLE_SHA256 = '28d8d81c7d62beb95b99ebd188467c8a8ec69a9a6a4fe17df5970d8a0c6816ae';
export const EFFECTIVE_CSV_SHA256 = '4428f4c80dcdde1c47508ac9eb433baa4f9a941934ae943cdd5e0116d3b49c14';
export const COMPLETE_MANIFEST_SHA256 = '38c20936f3638c3b7a261c934a4f656f1b9282f13f5ae23274069c6dbd41f9be';
export const BASELINE_PARSER_VERSION = 'catalog-baseline-v1';
export const BASELINE_RELEASE_KEY = 'p0-03-delivery-final-v2-20261020';
const pointerToken = (value: string) => value.replace(/~/g, '~0').replace(/\//g, '~1');
export const HISTORY_COLLECTIONS = ['correction_events', 'business_confirmation_events', 'jst_confirmation_events',
  'final_confirmation_events', 'resolved_business_pending_history', 'batch_version_confirmations',
  'batch_specification_resolutions', 'batch_brush_preservation', 'batch_bs_not_created',
  'batch_target_authorizations', 'unapplied_decisions'] as const;

type JsonRecord = Record<string, unknown>;
const record = (value: unknown): JsonRecord => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('BASELINE_OBJECT_INVALID');
  return value as JsonRecord;
};
const array = (value: unknown): unknown[] => { if (!Array.isArray(value)) throw new Error('BASELINE_ARRAY_INVALID'); return value; };
const string = (value: unknown): string => { if (typeof value !== 'string') throw new Error('BASELINE_STRING_INVALID'); return value; };
const integer = (value: unknown): number => { if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error('BASELINE_ROW_INVALID'); return value; };
export const unknownScope = (reason: string): ScopeValue => ({ state: 'unknown', raw: null, reason });

export function observedField(value: unknown, evidenceRef: string): FieldObservation {
  if (value === undefined) return { state: 'not_read', raw: null, reason: 'FIELD_ABSENT_FROM_FROZEN_PAYLOAD', evidenceRef };
  if (value === null) return { state: 'observed', raw: null, meaning: 'explicit_null', evidenceRef };
  if (typeof value !== 'string') return { state: 'parse_failed', raw: null, reason: 'NON_STRING_SOURCE_TYPE_RETAINED_IN_PRIVATE_ARTIFACT', evidenceRef };
  return { state: 'observed', raw: value, meaning: value === '' ? 'explicit_empty' : 'value', evidenceRef };
}

/** RFC4180 parser retains record ordering, empty fields and embedded newlines. */
export function parseCsvRecords(text: string): { header: string[]; records: { fields: string[]; physicalStart: number; physicalEnd: number }[] } {
  const rows: { fields: string[]; physicalStart: number; physicalEnd: number }[] = [];
  let fields: string[] = [], value = '', quoted = false, line = 1, start = 1;
  const input = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (char === '"') {
      if (quoted && input[i + 1] === '"') { value += '"'; i++; } else if (quoted || value === '') quoted = !quoted; else throw new Error('CSV_QUOTE_INVALID');
    } else if (char === ',' && !quoted) { fields.push(value); value = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) {
      fields.push(value); rows.push({ fields, physicalStart: start, physicalEnd: line });
      if (char === '\r' && input[i + 1] === '\n') i++;
      line++; start = line; fields = []; value = '';
    } else { value += char; if (char === '\n') line++; }
  }
  if (quoted) throw new Error('CSV_UNCLOSED_QUOTE');
  if (fields.length || value.length) { fields.push(value); rows.push({ fields, physicalStart: start, physicalEnd: line }); }
  if (!rows.length) throw new Error('CSV_EMPTY');
  const header = rows.shift()!.fields;
  if (rows.some((row) => row.fields.length !== header.length)) throw new Error('CSV_COLUMN_COUNT_INVALID');
  return { header, records: rows };
}

const itemFieldNames: Record<string, string> = {
  sourceDate: '日期', nameCn: '中文产品名称', specification: '规格', englishName: '英文名称', factory: '生产工厂',
  imageRef: '产品图片', barcode: '69商品编码', length: '长(单产品/cm）', width: '宽(单产品/cm）', height: '高(单产品/cm）',
  unitWeight: '单个产品重量(kg）', cartonQuantity: '装箱数量', cartonLength: '装箱长', cartonWidth: '装箱宽',
  cartonHeight: '装箱高', cartonWeight: '单箱重量', liquid: '是否液体', shelfLifeDays: '有效期（天数)',
  cartonVolume: '单箱立方', unitVolume: '单瓶立方', factoryLeadDays: '工厂生产货期(天）', shippingDays: '运输时间（海运预估）',
};

/** Parse only exact original bytes. Complete raw payloads remain in private artifacts. */
export function parseBaselineBytes(bundleBytes: Uint8Array, csvBytes: Uint8Array): Omit<PreparedBaseline, 'artifacts' | 'fullManifest' | 'subsetManifest' | 'contentSha256'> {
  if (sha256(bundleBytes) !== BUNDLE_SHA256 || sha256(csvBytes) !== EFFECTIVE_CSV_SHA256) throw new Error('BASELINE_PIN_MISMATCH');
  const bundle = record(JSON.parse(Buffer.from(bundleBytes).toString('utf8')));
  const masters = array(bundle.master_rows).map(record), provenance = array(bundle.master_provenance).map(record);
  const candidates = array(bundle.candidates).map(record);
  if (masters.length !== 126 || provenance.length !== 126 || candidates.length !== 1417) throw new Error('BASELINE_COLLECTION_COUNT_INVALID');
  const items: PreparedItem[] = masters.map((master, index) => {
    const source = provenance[index];
    if (source.row_index !== master.row_index || source.ice_code !== master.ice_code || source.name_cn !== master.name_cn) throw new Error('BASELINE_PROVENANCE_MISMATCH');
    const data = record(source.data), ref = `match-bundle.json#/master_provenance/${index}`;
    const fields = Object.fromEntries(Object.entries(itemFieldNames).map(([key, sourceKey]) => [key, observedField(data[sourceKey], `${ref}/data/${pointerToken(sourceKey)}`)]));
    const priceSelection = source.current_price_selection ? record(source.current_price_selection) : null;
    return { anchorPointer: `/master_rows/${index}`, rowPosition: integer(master.row_index),
      iceCode: string(master.ice_code) || null, nameCn: string(master.name_cn), newProductConfirmed: index === 117,
      fields, financial: { cost: observedField(data['成本价格'], `${ref}/data/成本价格`),
        operatingPrice: observedField(data['运营价格'], `${ref}/data/运营价格`),
        sourceRow: priceSelection ? integer(priceSelection.source_row) : typeof source.primary_row === 'number' ? source.primary_row : null,
        versions: array(source.price_versions).map((v, priceIndex) => { const version = record(v); return {
          sourceRow: integer(version.source_row), cost: observedField(version.cost, `${ref}/price_versions/${priceIndex}/cost`),
          operatingPrice: observedField(version.operating_price, `${ref}/price_versions/${priceIndex}/operating_price`) }; }),
        currency: 'unknown', unit: 'unknown', tax: 'unknown', freight: 'unknown', valuationAuthorized: false, rawRef: ref },
      payloadSha256: payloadSha256(source), rawRef: ref };
  });
  if (items.filter((item) => item.iceCode !== null).length !== 125 || new Set(items.flatMap((item) => item.iceCode ? [item.iceCode] : [])).size !== 125) throw new Error('BASELINE_CODES_INVALID');
  const newItem = items[117];
  if (newItem.rowPosition !== 122 || newItem.iceCode !== null || newItem.nameCn !== 'ICE LERSKIN 烟酰胺提亮精华水150ml' || newItem.fields.barcode.raw !== '' || newItem.fields.specification.raw !== '') throw new Error('BASELINE_NEW_PRODUCT_INVALID');
  const candidateIds = new Set(candidates.map((candidate) => string(candidate.candidate_id)));
  if (candidateIds.size !== 1417) throw new Error('BASELINE_CANDIDATE_IDS_INVALID');
  const observations: PreparedObservation[] = candidates.map((candidate, index) => {
    const source = record(candidate.source), extra = record(source.extra);
    const system = string(source.source_system);
    if (system !== 'bigseller' && system !== 'jushuitan') throw new Error('BASELINE_SYSTEM_INVALID');
    const ref = `match-bundle.json#/candidates/${index}`;
    const sourceRowKey = string(source.source_row_key), rowMatch = sourceRowKey.match(system === 'bigseller' ? /^bigseller:[^:]*:(\d+):/ : /^jushuitan:(\d+):/);
    const warehouse = source.warehouse;
    const fields = { sku: observedField(source.external_sku_raw, `${ref}/source/external_sku_raw`), name: observedField(source.external_name, `${ref}/source/external_name`),
      barcode: observedField(source.gtin_raw, `${ref}/source/gtin_raw`), specification: observedField(extra.spec, `${ref}/source/extra/spec`),
      warehouse: observedField(warehouse, `${ref}/source/warehouse`), styleCode: observedField(extra.style_code, `${ref}/source/extra/style_code`),
      productCode: observedField(extra.product_code, `${ref}/source/extra/product_code`) };
    return { system, entryKey: `/candidates/${index}`, legacyCandidateId: string(candidate.candidate_id),
      position: { sheet: typeof source.sheet_name === 'string' ? source.sheet_name : null, row: rowMatch ? Number(rowMatch[1]) : null, sourceRowKey },
      fields, amounts: {}, reviewState: string(candidate.review_state), rawRef: ref, payloadSha256: payloadSha256(candidate),
      scope: { account: unknownScope('FROZEN_SAMPLE_ACCOUNT_UNVERIFIED'), market: unknownScope('SOURCE_MARKET_UNVERIFIED'),
        warehouse: typeof warehouse === 'string' && warehouse !== '' ? { state: 'known', raw: warehouse, canonical: warehouse, evidenceRef: `${ref}/source/warehouse` } : unknownScope('SOURCE_WAREHOUSE_NOT_PROVIDED') } };
  });
  const decisions: PreparedDecision[] = candidates.map((candidate, index) => {
    const selected = candidate.selected_master ? record(candidate.selected_master) : null;
    const target = selected ? items.find((item) => item.rowPosition === selected.row_index && item.iceCode === selected.ice_code) : null;
    if (selected && !target) throw new Error('BASELINE_TARGET_UNRESOLVED');
    const jst = candidate.selected_jushuitan ? record(candidate.selected_jushuitan) : null;
    if (jst && !candidateIds.has(string(jst.candidate_id))) throw new Error('BASELINE_JST_REFERENCE_UNRESOLVED');
    return { entryKind: 'candidate_snapshot', entryKey: `/candidates/${index}`, observationEntryKey: `/candidates/${index}`,
      selectedItemAnchor: target?.anchorPointer ?? null, selectedJushuitanRef: jst ? `match-bundle.json#/candidates/${index}/selected_jushuitan` : null,
      selectedJushuitanSha256: jst ? payloadSha256(jst) : null, reviewState: string(candidate.review_state),
      payloadSha256: payloadSha256(candidate), rawRef: `match-bundle.json#/candidates/${index}`,
      summary: { legacyCandidateId: string(candidate.candidate_id), selectedMasterRow: selected ? integer(selected.row_index) : null,
        selectedMasterCode: selected ? string(selected.ice_code) : null, selectedJushuitanCandidateId: jst ? string(jst.candidate_id) : null,
        decisionRecordCount: array(candidate.decision_records).length,
        flags: array(candidate.flags).map(string) } };
  });
  // Index every occurrence, including duplicate/cleared/deferred records. No replay.
  candidates.forEach((candidate, candidateIndex) => array(candidate.decision_records).forEach((payload, sequence) => {
    const decision = record(payload), pointer = `/candidates/${candidateIndex}/decision_records/${sequence}`;
    const safeText = (key: string): string | null => typeof decision[key] === 'string' ? decision[key] as string : null;
    decisions.push({ entryKind: 'decision_record', entryKey: pointer, observationEntryKey: `/candidates/${candidateIndex}`,
      selectedItemAnchor: null, selectedJushuitanRef: null, selectedJushuitanSha256: null, reviewState: null,
      payloadSha256: payloadSha256(payload), rawRef: `match-bundle.json#${pointer}`,
      summary: { legacyCandidateId: string(candidate.candidate_id), sequence, decision: safeText('review_decision'),
        manualMasterRow: safeText('manual_master_row'), manualMasterCode: safeText('manual_master_ice'),
        manualJstCandidateId: safeText('manual_jst_candidate_id'), manualJstSku: safeText('manual_jst_sku') } });
  }));
  const csv = parseCsvRecords(Buffer.from(csvBytes).toString('utf8'));
  if (csv.header.join(',') !== 'candidate_id,review_decision,review_notes,manual_master_row,manual_master_ice,manual_jst_candidate_id,manual_jst_sku' || csv.records.length !== 3160) throw new Error('BASELINE_CSV_INVALID');
  csv.records.forEach((row, index) => decisions.push({ entryKind: 'effective_csv_record', entryKey: `record/${index + 1}`,
    observationEntryKey: null, selectedItemAnchor: null, selectedJushuitanRef: null, selectedJushuitanSha256: null, reviewState: null,
    payloadSha256: payloadSha256(Object.fromEntries(csv.header.map((header, column) => [header, row.fields[column]]))),
    rawRef: `manual-decisions.effective.csv#record/${index + 1}`, summary: { ordinal: index + 1, physicalStart: row.physicalStart, physicalEnd: row.physicalEnd } }));
  let historyEntries = 0;
  for (const collection of HISTORY_COLLECTIONS) array(bundle[collection]).forEach((payload, index) => {
    historyEntries++;
    let selectedItemAnchor: string | null = null;
    const summary: PreparedDecision['summary'] = { collection, ordinal: index };
    if (collection === 'batch_bs_not_created' || collection === 'batch_brush_preservation') {
      const history = record(payload), iceCode = string(history.ice_code), masterRow = integer(history.master_row);
      const target = items.find((item) => item.iceCode === iceCode && item.rowPosition === masterRow);
      if (!target) throw new Error('BASELINE_STATUS_HISTORY_TARGET_UNRESOLVED');
      selectedItemAnchor = target.anchorPointer;
      // Fixed, hash-pinned business-state evidence. This links historical context,
      // not a new selection or a formal relationship. Free-form notes stay raw.
      Object.assign(summary, { iceCode, masterRow, sourceSystem: typeof history.source_system === 'string' ? history.source_system : null,
        status: string(history.status), reason: string(history.reason) });
      if (collection === 'batch_brush_preservation') summary.doNotMerge = history.do_not_merge === true;
    }
    decisions.push({ entryKind: `history:${collection}`, entryKey: `/${collection}/${index}`, observationEntryKey: null,
      selectedItemAnchor, selectedJushuitanRef: null, selectedJushuitanSha256: null, reviewState: null,
      payloadSha256: payloadSha256(payload), rawRef: `match-bundle.json#/${collection}/${index}`, summary });
  });
  provenance.forEach((payload, index) => decisions.push({ entryKind: 'master_history', entryKey: `/master_provenance/${index}`,
    observationEntryKey: null, selectedItemAnchor: items[index].anchorPointer, selectedJushuitanRef: null, selectedJushuitanSha256: null,
    reviewState: null, payloadSha256: payloadSha256(payload), rawRef: `match-bundle.json#/master_provenance/${index}`, summary: { sourceRowCount: array(payload.source_rows).length } }));
  const selectedCount = decisions.filter((decision) => decision.entryKind === 'candidate_snapshot' && decision.reviewState === 'manual_selected').length;
  if (selectedCount !== 548 || observations.filter((o) => o.system === 'bigseller').length !== 530 || observations.filter((o) => o.system === 'jushuitan').length !== 887) throw new Error('BASELINE_SELECTION_COUNT_INVALID');
  return { releaseKey: BASELINE_RELEASE_KEY, bundleSha256: BUNDLE_SHA256, effectiveCsvSha256: EFFECTIVE_CSV_SHA256, parserVersion: BASELINE_PARSER_VERSION,
    items, observations, decisions, counts: { items: 126, coded: 125, observations: 1417, selected: 548, csvRecords: 3160, historyEntries } };
}

async function walk(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('BASELINE_LINK_DENIED');
    if (entry.isDirectory()) result.push(...await walk(absolute)); else if (entry.isFile()) result.push(absolute); else throw new Error('BASELINE_FILE_TYPE_INVALID');
  }
  return result;
}

export async function prepareBaseline(): Promise<PreparedBaseline> {
  const root = path.resolve(catalogSourceRoot(), BASELINE_DIRECTORY);
  const files = await walk(root);
  const entries = await Promise.all(files.map(async (absolute) => ({ logicalName: path.relative(root, absolute).split(path.sep).join('/'), bytes: await fs.readFile(absolute) })));
  entries.sort((a, b) => a.logicalName < b.logicalName ? -1 : a.logicalName > b.logicalName ? 1 : 0);
  const inputManifest = entries.map((entry) => ({ logicalName: entry.logicalName, sha256: sha256(entry.bytes), size: entry.bytes.length }));
  if (entries.length !== 147 || payloadSha256(inputManifest) !== COMPLETE_MANIFEST_SHA256) throw new Error('BASELINE_COMPLETE_MANIFEST_MISMATCH');
  const bundle = entries.find((entry) => entry.logicalName === 'match-bundle.json')!, csv = entries.find((entry) => entry.logicalName === 'manual-decisions.effective.csv')!;
  const parsed = parseBaselineBytes(bundle.bytes, csv.bytes);
  // Complete validation precedes any evidence store writes; all bytes stay private.
  const artifacts = [];
  for (const entry of entries) artifacts.push(await storePrivateArtifact(entry.logicalName, entry.bytes));
  const subsetManifest = artifacts.filter((artifact) => ['json', 'csv'].includes(artifact.format));
  if (subsetManifest.length !== 129) throw new Error('BASELINE_SUBSET_MANIFEST_MISMATCH');
  const result = { ...parsed, artifacts, fullManifest: artifacts, subsetManifest };
  return { ...result, contentSha256: payloadSha256(result) };
}
