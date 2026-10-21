import { beforeAll, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fieldObservationSchema, initialCodeSchema, nonPriceFieldsSchema, scopeValueSchema } from '../../src/features/catalog/schema';
import { inspectIdentity, type IdentityInspectionInput } from '../../src/features/catalog/identity-contract';
import { findCandidates, buildCandidates, buildDifferences } from '../../src/features/catalog/candidate-service';
import { BASELINE_DIRECTORY, parseBaselineBytes, parseCsvRecords, prepareBaseline, HISTORY_COLLECTIONS } from '../../src/features/catalog/sources/baseline-adapter';
import { FEISHU_SNAPSHOT_DIRECTORY, FEISHU_SNAPSHOT_NAME, parseFrozenFeishuBytes, loadFrozenFeishu } from '../../src/features/catalog/sources/frozen-feishu-adapter';
import { payloadSha256, privateEvidenceRoot, readPrivateArtifact } from '../../src/features/catalog/evidence-store';
import type { CatalogItemDto, FieldObservation, PreparedObservation } from '../../src/features/catalog/types';

const actionMocks = vi.hoisted(() => ({ assign: vi.fn(), revalidate: vi.fn() }));
const repositoryMocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../src/lib/database/app-db', () => ({
  withAppDb: async (_identity: unknown, operation: (client: { query: typeof repositoryMocks.query }) => Promise<unknown>) => operation({ query: repositoryMocks.query }),
}));
vi.mock('../../src/features/catalog/service', () => ({
  assignCatalogInitialCode: actionMocks.assign, appendCatalogNonPriceRevision: vi.fn(), getCatalogAmounts: vi.fn(),
  importCatalogFrozenObservations: vi.fn(), prepareCatalogBaseline: vi.fn(), publishCatalogBaseline: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: actionMocks.revalidate }));

const field = (raw: string): FieldObservation => ({ state: 'observed', raw, meaning: raw === '' ? 'explicit_empty' : 'value', evidenceRef: 'fixture' });
let baseline: ReturnType<typeof parseBaselineBytes>;
let frozen: ReturnType<typeof parseFrozenFeishuBytes>;
let bundle: Record<string, unknown>;
beforeAll(async () => {
  const [bundleBytes, csvBytes, feishuBytes] = await Promise.all([
    readFile(path.join(BASELINE_DIRECTORY, 'match-bundle.json')), readFile(path.join(BASELINE_DIRECTORY, 'manual-decisions.effective.csv')),
    readFile(path.join(FEISHU_SNAPSHOT_DIRECTORY, FEISHU_SNAPSHOT_NAME)),
  ]);
  baseline = parseBaselineBytes(bundleBytes, csvBytes); frozen = parseFrozenFeishuBytes(feishuBytes); bundle = JSON.parse(bundleBytes.toString('utf8'));
});

describe('strict field states', () => {
  it.each([
    { state: 'observed', meaning: 'value', raw: '0', evidenceRef: 'e' },
    { state: 'observed', meaning: 'explicit_empty', raw: '', evidenceRef: 'e' },
    { state: 'observed', meaning: 'explicit_null', raw: null, evidenceRef: 'e' },
    { state: 'no_text', raw: null, evidenceRef: 'e' },
    { state: 'not_read', raw: null, reason: 'unread', evidenceRef: 'e' },
    { state: 'parse_failed', raw: null, reason: 'failed', evidenceRef: 'e' },
  ])('accepts only its stated meaning %#', (value) => expect(fieldObservationSchema.parse(value)).toEqual(value));
  it.each([
    { state: 'observed', meaning: 'value', raw: '' }, { state: 'observed', meaning: 'value', raw: null },
    { state: 'observed', meaning: 'explicit_empty', raw: '0' }, { state: 'observed', meaning: 'explicit_empty', raw: null },
    { state: 'observed', meaning: 'explicit_null', raw: '' }, { state: 'observed', meaning: 'explicit_null', raw: '0' },
    { state: 'no_text', raw: '0' }, { state: 'not_read', raw: '0', reason: 'x' },
    { state: 'parse_failed', raw: null }, { state: 'no_text', raw: null, meaning: 'explicit_null' },
    { state: 'observed', meaning: 'value', raw: '1', formula: '=1' },
  ])('rejects mixed or invented state %#', (value) => expect(fieldObservationSchema.safeParse({ ...value, evidenceRef: 'e' }).success).toBe(false));
  it('rejects amount/raw/code edits and edge whitespace business codes', () => {
    for (const key of ['cost', 'operatingPrice', 'iceCode', 'raw', 'price']) expect(nonPriceFieldsSchema.safeParse({ [key]: field('0') }).success).toBe(false);
    for (const value of ['', ' ', ' WM1', 'WM1 ', 'x'.repeat(51)]) expect(initialCodeSchema.safeParse(value).success).toBe(false);
    expect(initialCodeSchema.parse('LS101275')).toBe('LS101275');
  });
});

describe('frozen canonical adoption', () => {
  it('keeps one missing-code product and does not infer its specification', () => {
    expect(baseline.counts).toMatchObject({ items: 126, coded: 125, observations: 1417, selected: 548, csvRecords: 3160 });
    const item = baseline.items[117];
    expect(item).toMatchObject({ anchorPointer: '/master_rows/117', rowPosition: 122, iceCode: null, newProductConfirmed: true });
    expect(item.nameCn).toBe('ICE LERSKIN 烟酰胺提亮精华水150ml');
    expect(item.fields.specification).toMatchObject({ meaning: 'explicit_empty', raw: '' });
    expect(item.fields.barcode.raw).toBe(''); expect(item.fields.cartonQuantity.raw).toBe('96');
    expect(item.fields.sourceDate.raw).toBe('2026-10-12 00:00:00');
    expect(baseline.decisions.filter((d) => d.entryKind === 'candidate_snapshot' && d.selectedItemAnchor === item.anchorPointer)).toHaveLength(0);
  });
  it('compares each of all 548 exact original targets and JST references', () => {
    const candidates = bundle.candidates as Record<string, unknown>[];
    const selected = baseline.decisions.filter((d) => d.entryKind === 'candidate_snapshot' && d.reviewState === 'manual_selected');
    expect(selected).toHaveLength(548);
    for (const decision of selected) {
      const original = candidates[Number(decision.entryKey.split('/').at(-1))];
      const target = baseline.items.find((item) => item.anchorPointer === decision.selectedItemAnchor)!;
      expect(original.selected_master).toMatchObject({ row_index: target.rowPosition, ice_code: target.iceCode });
      expect(decision.payloadSha256).toBe(payloadSha256(original));
      expect(decision.selectedJushuitanSha256).toBe(original.selected_jushuitan ? payloadSha256(original.selected_jushuitan) : null);
      expect(decision.summary.decisionRecordCount).toBe((original.decision_records as unknown[]).length);
    }
  });
  it('preserves all history collection occurrences and CSV without command replay', () => {
    let historyCount = 0;
    for (const key of HISTORY_COLLECTIONS) {
      const values = bundle[key] as unknown[];
      expect(baseline.decisions.filter((d) => d.entryKind === `history:${key}`).map((d) => d.payloadSha256)).toEqual(values.map(payloadSha256));
      historyCount += values.length;
    }
    expect(baseline.counts.historyEntries).toBe(historyCount);
    expect(baseline.decisions.filter((d) => d.entryKind === 'effective_csv_record')).toHaveLength(3160);
    const candidates = bundle.candidates as Record<string, unknown>[];
    const recordCount = candidates.reduce((count, candidate) => count + (candidate.decision_records as unknown[]).length, 0);
    expect(baseline.decisions.filter((d) => d.entryKind === 'decision_record')).toHaveLength(recordCount);
    expect(baseline.decisions.filter((d) => d.entryKind === 'master_history')).toHaveLength(126);
  });
  it('preserves WM0072 independent adopted financial version and both source prices', () => {
    const item = baseline.items.find((row) => row.iceCode === 'WM0072')!;
    expect(item.financial.cost.raw).toBe('5.18'); expect(item.financial.operatingPrice.raw).toBe('5.68');
    expect(item.financial.sourceRow).toBe(216);
    expect(item.financial.versions.map((version) => [version.sourceRow, version.cost.raw, version.operatingPrice.raw])).toEqual([[66, '5', '5.5'], [216, '5.18', '5.68']]);
    expect(item.fields).not.toHaveProperty('cost'); expect(item.fields).not.toHaveProperty('operatingPrice');
    expect(baseline.items.some((row) => row.iceCode === 'WM0081')).toBe(true);
    expect(baseline.items.some((row) => row.iceCode === 'brush')).toBe(true);
  });
  it('links explicit BS not-created history to the original WM0070 and WM0072 items without adding choices', () => {
    const history = baseline.decisions.filter((decision) => decision.entryKind === 'history:batch_bs_not_created');
    expect(history).toHaveLength(2);
    for (const [code, row] of [['WM0070', 214], ['WM0072', 66]] as const) {
      const item = baseline.items.find((entry) => entry.iceCode === code && entry.rowPosition === row)!;
      const state = history.find((entry) => entry.selectedItemAnchor === item.anchorPointer)!;
      expect(state.summary).toMatchObject({ iceCode: code, masterRow: row, sourceSystem: 'bigseller', status: 'user_confirmed_not_created' });
      expect(state.observationEntryKey).toBeNull(); expect(state.reviewState).toBeNull();
      expect(state.payloadSha256).toBe(payloadSha256((bundle.batch_bs_not_created as Record<string, unknown>[]).find((entry) => entry.ice_code === code)));
    }
    expect(baseline.decisions.filter((entry) => entry.entryKind === 'candidate_snapshot' && entry.reviewState === 'manual_selected')).toHaveLength(548);
  });
  it('links two independent brush pending states to distinct preserved original items', () => {
    const history = baseline.decisions.filter((decision) => decision.entryKind === 'history:batch_brush_preservation');
    expect(history).toHaveLength(2); expect(new Set(history.map((entry) => entry.selectedItemAnchor)).size).toBe(2);
    for (const [code, row] of [['WM0081', 62], ['brush', 107]] as const) {
      const item = baseline.items.find((entry) => entry.iceCode === code && entry.rowPosition === row)!;
      const state = history.find((entry) => entry.selectedItemAnchor === item.anchorPointer)!;
      expect(state.summary).toMatchObject({ iceCode: code, masterRow: row, status: 'pending_confirmation', doNotMerge: true });
      expect(state.observationEntryKey).toBeNull(); expect(state.selectedJushuitanRef).toBeNull();
    }
  });
  it('rejects any mutated or unpinned original bytes before parse', () => expect(() => parseBaselineBytes(Buffer.from('{}'), Buffer.from(''))).toThrow('BASELINE_PIN_MISMATCH'));
  it('resolves every original item field reference as RFC6901 including slash-bearing column names', () => {
    for (const item of baseline.items) for (const observation of Object.values(item.fields)) {
      const pointer = observation.evidenceRef.split('#')[1];
      let value: unknown = bundle;
      for (const token of pointer.slice(1).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))) value = (value as Record<string, unknown>)[token];
      if (observation.state === 'observed') expect(value).toBe(observation.raw);
      else expect(observation.state).toBe('parse_failed');
    }
  });
  it('parses multiline RFC4180 as ordered evidence rather than state transitions', () => {
    const csv = parseCsvRecords('a,b\r\nx,"line1\nline2"\r\nx,"a""b"\r\n');
    expect(csv.records).toEqual([{ fields: ['x', 'line1\nline2'], physicalStart: 2, physicalEnd: 3 }, { fields: ['x', 'a"b'], physicalStart: 4, physicalEnd: 4 }]);
    expect(() => parseCsvRecords('a,b\nx,"unterminated')).toThrow('CSV_UNCLOSED_QUOTE');
  });
  it('stages all 147 artifact bytes and separately identifies 129 JSON/CSV files', async () => {
    const prepared = await prepareBaseline();
    expect(prepared.fullManifest).toHaveLength(147); expect(prepared.subsetManifest).toHaveLength(129);
    expect(prepared.fullManifest.filter((artifact) => artifact.format === 'xlsx')).toHaveLength(10);
    expect((await readPrivateArtifact(prepared.artifacts.find((artifact) => artifact.logicalName === 'match-bundle.json')!)).length).toBeGreaterThan(0);
    expect(prepared.contentSha256).toBe((await prepareBaseline()).contentSha256);
  }, 60000);
});

describe('partial Feishu cells and private monetary observations', () => {
  it('keeps 159 cells/16 positions, no_text distinct from empty, no source cursor or stable ID', () => {
    expect(frozen.coverage).toMatchObject({ complete: false, cells: 159, headers: 27, sourceUpdatedAt: null, cursor: null, stableRecordId: null });
    expect(frozen.coverage.dataRowPositions).toHaveLength(16);
    const noText = frozen.observations.filter((observation) => Object.values({ ...observation.fields, ...observation.amounts }).some((value) => value.state === 'no_text'));
    expect(noText).toHaveLength(38);
    const prices = frozen.observations.filter((observation) => observation.position.row! > 1 && /^[IJY]\d+$/.test(observation.position.cell!));
    for (const observation of prices) expect(observation.fields).toEqual({});
    expect(frozen.observations.find((observation) => observation.position.cell === 'I66')!.amounts.I.raw).toBe('5');
    expect(frozen.observations.find((observation) => observation.position.cell === 'J66')!.amounts.J.raw).toBe('5.5');
  });
  it('stages raw originals including seven repeat observations without claiming seven extra cells', async () => {
    const result = await loadFrozenFeishu(); expect(result.artifacts).toHaveLength(6);
    const repeat = result.artifacts.find((artifact) => artifact.logicalName === 'feishu-repeat-cells.raw.json')!;
    expect(JSON.parse((await readPrivateArtifact(repeat)).toString('utf8'))).toHaveLength(7);
    expect(result.observations).toHaveLength(159);
  });
  it('returns safe WM0072 diffs and restricted references without exposing price values', () => {
    const item = baseline.items.find((row) => row.iceCode === 'WM0072')!;
    const observations = frozen.observations.map((observation, index) => ({ ...observation, observationId: `obs-${index}`, sourceSystem: observation.system }));
    const diffs = buildDifferences(item, observations);
    expect(diffs.filter((diff) => diff.field === 'restricted_amount')).toHaveLength(2);
    expect(diffs.filter((diff) => diff.field === 'restricted_amount').every((diff) => diff.adopted === null && diff.observed === null)).toBe(true);
    expect(buildDifferences(baseline.items[117], observations)).toEqual([]);
  });
});

describe('identity inspection and independent candidate boundaries', () => {
  const input = (): IdentityInspectionInput => ({ mode: 'observe_only', namespace: 'account-a', dataset: 'products', entityKind: 'product', contractVersion: 'v1',
    vendorRecordIdRaw: null, businessKeyFields: [{ name: 'sku', value: '001a' }], scope: { account: { state: 'known', raw: 'account-a', canonical: 'account-a', evidenceRef: 'account-proof' } },
    requiredScope: ['account'], evidence: { stableIdVerified: false, businessKeyVerified: true, evidenceRefs: ['stability-unique-reuse-proof'] } });
  it('allows verified scoped business key as future path but never creates usable identity', () => {
    expect(inspectIdentity(input())).toMatchObject({ strategy: 'scoped_business_key', eligibleForFutureRegistration: true, sourceRecordId: null, sourceIdentityVerified: false, relationshipUsable: false });
    const stable = input(); stable.vendorRecordIdRaw = 'vendor-1'; stable.evidence.stableIdVerified = true;
    expect(inspectIdentity(stable).strategy).toBe('vendor_stable_id');
    const unknown = input(); unknown.businessKeyFields = [];
    expect(inspectIdentity(unknown)).toMatchObject({ strategy: 'observation_only', sourceRecordId: null, eligibleForFutureRegistration: false });
  });
  it('preserves opaque IDs, scopes same SKU by account, and refuses missing required range', () => {
    const first = inspectIdentity(input());
    const upper = input(); upper.businessKeyFields[0].value = '001A'; expect(inspectIdentity(upper).canonicalKey).not.toBe(first.canonicalKey);
    const other = input(); other.namespace = 'account-b'; expect(inspectIdentity(other).canonicalKey).not.toBe(first.canonicalKey);
    const missing = input(); missing.scope.account = { state: 'unknown', raw: null, reason: 'not verified' };
    expect(inspectIdentity(missing).eligibleForFutureRegistration).toBe(false);
    expect(scopeValueSchema.safeParse({ state: 'unknown', raw: 'CN', reason: 'fake' }).success).toBe(false);
  });
  it('never uses row/name/barcode to cross-batch identify and candidates do not wait for other system', () => {
    const item: Pick<CatalogItemDto, 'itemId' | 'iceCode' | 'nameCn' | 'barcodeRefs'> = { itemId: 'item', iceCode: null, nameCn: 'New Product', barcodeRefs: [] };
    const observations = [{ observationId: 'jst-1', sourceSystem: 'jushuitan' as const, fields: { name: field('New Product') }, reviewState: 'pending' }];
    expect(findCandidates(item, 'jushuitan', observations)).toHaveLength(1); expect(findCandidates(item, 'bigseller', observations)).toEqual([]);
    expect(findCandidates(item, 'jushuitan', observations)[0]).toMatchObject({ relationshipUsable: false, sourceRecordId: null, basis: ['name_hint'] });
    const sameBarcodes = [{ ...observations[0], fields: { name: field('version one'), barcode: field('123') } }, { ...observations[0], observationId: 'jst-2', fields: { name: field('version two'), barcode: field('123') } }];
    expect(findCandidates({ ...item, barcodeRefs: [field('123')] }, 'jushuitan', sameBarcodes)).toHaveLength(2);
    const reordered: PreparedObservation[] = [...frozen.observations].reverse();
    expect(new Set(reordered.map((observation) => observation.entryKey)).size).toBe(159);
  });
  it('shows shared barcode versions, packaging and preserved flags without merging or declaring scoped identity', () => {
    const item: CatalogItemDto = { itemId: 'item', revision: 1, iceCode: 'WM-TEST', codeState: 'coded', newProductConfirmed: false,
      nameCn: 'Fixture Product', specification: field('150ml/瓶'), barcodeRefs: [field('00123')], fields: { packaging: field('瓶') },
      humanChoices: { bigseller: 0, jushuitan: 0 }, sourceRecordId: null, sourceIdentityVerified: false, relationshipUsable: false, provenanceRefs: [] };
    const observation = { observationId: 'one', sourceSystem: 'jushuitan' as const, fields: { sku: field('WM-TEST'), barcode: field('00123'),
      name: field('Fixture Product'), specification: field('150ml/盒'), packaging: field('盒') }, position: { row: 1 }, rawRef: 'fixture:one',
      reviewState: 'ignored', selectedItemId: 'other', existingDecisionRef: 'old-choice', conflicts: ['MANY_TO_ONE', 'unsafe free text 5.18'] };
    const candidates = buildCandidates(item, [observation, { ...observation, observationId: 'two', position: { row: 2 } }], 'jushuitan');
    expect(candidates).toHaveLength(2);
    for (const candidate of candidates) {
      expect(candidate.conflicts).toEqual(expect.arrayContaining(['MANY_TO_ONE', 'SOURCE_SKU_REPEATED_REVIEW_SCOPE', 'BARCODE_SHARED_REVIEW_VERSION',
        'SPECIFICATION_DIFF_REVIEW_VERSION_OR_PACKAGING', 'PACKAGING_DIFFERENCE_REQUIRES_REVIEW', 'EXISTING_CHOICE_OTHER_ITEM', 'PRESERVED_IGNORED']));
      expect(candidate.conflicts).not.toContain('unsafe free text 5.18'); expect(candidate.relationshipUsable).toBe(false); expect(candidate.sourceRecordId).toBeNull();
    }
    expect(buildCandidates(item, [observation], 'bigseller')).toEqual([]);
  });
  it('denies arbitrary evidence handles and requires explicit isolated run', async () => {
    await expect(readPrivateArtifact({ sha256: 'x', size: 1, storageHandle: '../../secret' })).rejects.toThrow('EVIDENCE_HANDLE_DENIED');
    const prior = process.env.CATALOG_RUN_ID; delete process.env.CATALOG_RUN_ID;
    try { expect(() => privateEvidenceRoot()).toThrow('CATALOG_ISOLATED_RUN_REQUIRED'); }
    finally { if (prior) process.env.CATALOG_RUN_ID = prior; }
  });
  it('refuses server evidence roots outside the computed isolated run', () => {
    const prior = process.env.CATALOG_EVIDENCE_ROOT; process.env.CATALOG_EVIDENCE_ROOT = path.resolve('.local/foreign');
    try { expect(() => privateEvidenceRoot()).toThrow('CATALOG_EVIDENCE_ROOT_MISMATCH'); }
    finally { if (prior) process.env.CATALOG_EVIDENCE_ROOT = prior; else delete process.env.CATALOG_EVIDENCE_ROOT; }
  });
});

describe('server action failure projections', () => {
  it('returns an explicit static revision conflict without PostgreSQL details', async () => {
    const { assignInitialCodeAction } = await import('../../src/features/catalog/actions');
    const error = Object.assign(new Error('CATALOG_REVISION_CONFLICT'), { code: '40001', detail: 'cost 5.18 SQL private raw secret' });
    actionMocks.assign.mockRejectedValueOnce(error);
    const result = await assignInitialCodeAction({});
    expect(result).toMatchObject({ success: false, error: '资料版本已变化，本次操作冲突；请刷新后核对。' });
    expect(JSON.stringify(result)).not.toMatch(/5\.18|SQL|private raw secret/);
  });
  it('marks unknown commit outcome distinctly so UI can retain the original full request', async () => {
    const { assignInitialCodeAction } = await import('../../src/features/catalog/actions');
    actionMocks.assign.mockRejectedValueOnce(new Error('CATALOG_REQUEST_OUTCOME_UNKNOWN'));
    const result = await assignInitialCodeAction({});
    expect(result).toMatchObject({ success: false, outcome: 'unknown' });
    expect(result.error).toContain('勿创建新请求重复操作');
  });
  it('redacts arbitrary parser, raw, SQL and price-bearing error messages', async () => {
    const { assignInitialCodeAction } = await import('../../src/features/catalog/actions');
    actionMocks.assign.mockRejectedValueOnce(new Error('unexpected error raw cost=5.18 SQL /private/evidence'));
    const result = await assignInitialCodeAction({});
    expect(result.success).toBe(false); expect(result).not.toHaveProperty('outcome');
    expect(JSON.stringify(result)).not.toMatch(/5\.18|SQL|private\/evidence/);
  });
});

describe('non-amount revision audit projection', () => {
  it('returns only stored audit fields while keeping ordinary item DTOs minimal', async () => {
    const { catalogRepository } = await import('../../src/features/catalog/repository');
    const actorId = '11111111-1111-4111-8111-111111111101';
    const recordedAt = new Date('2026-10-20T09:10:49.865Z');
    repositoryMocks.query.mockResolvedValue({ rows: [{ item_id: 'fixture-item', revision: 2, ice_code_snapshot: null,
      new_product_confirmed: true, name_cn: 'Fixture missing-code item', fields: { factory: field('Fixture factory') },
      evidence_ref: 'manual-request:fixture-request', bigseller: '0', jushuitan: '0',
      reason: 'Fixture stored reason', actor_id: actorId, recorded_at: recordedAt,
      session_token: 'must-not-leak', private_amount_row: { cost: '5.18' }, storage_handle: 'must-not-leak' }] });
    const identity = { profileUserId: actorId };
    const history = await catalogRepository.history(identity, 'fixture-item');
    expect(history[0].revisionAudit).toEqual({ reason: 'Fixture stored reason', actorId,
      recordedAt: recordedAt.toISOString(), evidenceRef: 'manual-request:fixture-request' });
    expect(history[0].iceCode).toBeNull();
    expect(JSON.stringify(history)).not.toMatch(/session_token|must-not-leak|private_amount_row|storage_handle|5\.18/);
    expect(repositoryMocks.query.mock.calls[0][0]).toBe('SELECT catalog.require_admin()');
    expect(repositoryMocks.query.mock.calls[1][0]).toMatch(/r\.reason,r\.actor_id,r\.recorded_at/);
    const ordinary = await catalogRepository.get(identity, 'fixture-item');
    expect(ordinary).not.toHaveProperty('revisionAudit');
    expect(ordinary).not.toHaveProperty('actor_id');
  });
});
