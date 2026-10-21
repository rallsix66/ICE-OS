import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client, Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prepareBaseline, BASELINE_DIRECTORY } from '@/features/catalog/sources/baseline-adapter';
import { loadFrozenFeishu } from '@/features/catalog/sources/frozen-feishu-adapter';
import { readPrivateArtifact } from '@/features/catalog/evidence-store';
import { withAppDb } from '@/lib/database/app-db';
import { closeP002Pools } from '@/lib/independent-platform/p0-02-pools';
import type { PreparedBaseline } from '@/features/catalog/types';
import { catalogRepository } from '@/features/catalog/repository';

const ADMIN = '11111111-1111-4111-8111-111111111101';
const OPERATOR = '11111111-1111-4111-8111-111111111104';
const INACTIVE = '11111111-1111-4111-8111-111111111106';
const runRoot = process.env.CATALOG_RUN_ROOT!;
const evidenceDir = process.env.CATALOG_TEST_EVIDENCE_DIR!;
const instance = JSON.parse(fs.readFileSync(path.join(runRoot, 'instance/catalog-instance.json'), 'utf8'));
const owner = new Pool({ connectionString: `postgres://${instance.bootstrapUser}:${instance.bootstrapPassword}@${instance.host}:${instance.port}/${instance.dbName}`, max: 2 });
const app = new Pool({ connectionString: process.env.P0_02_APP_DATABASE_URL, max: 2 });
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const receipt = (name: string, value: unknown) => fs.writeFileSync(path.join(evidenceDir, name), `${JSON.stringify(value, null, 2)}\n`);
let prepared: PreparedBaseline;
let newItemId: string;
let wmId: string;
let initialAnchors: unknown[];

async function tx<T>(identity: string | null, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await app.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`, [identity ?? '']);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
const publish = (payload = prepared, request = randomUUID(), intent = hash(payload)) => tx(ADMIN, async (client) => (await client.query('SELECT catalog.publish_baseline($1,$2,$3::jsonb) AS result', [request, intent, JSON.stringify(payload)])).rows[0].result);
const getCounts = async () => (await owner.query(`SELECT (SELECT count(*)::int FROM catalog.catalog_item) AS items,(SELECT count(*)::int FROM catalog.source_observation) AS observations,(SELECT count(*)::int FROM catalog.decision_evidence) AS decisions,(SELECT count(*)::int FROM catalog.audit_event) AS audits,(SELECT count(*)::int FROM catalog.baseline_release) AS releases,(SELECT count(*)::int FROM catalog.baseline_release WHERE published) AS published`)).rows[0];

async function checkRevisionAuditProjection(itemId: string, receiptName: string) {
  const saved = (await owner.query(`SELECT revision,ice_code_snapshot,fields,reason,actor_id,recorded_at,evidence_ref
    FROM catalog.item_revision WHERE item_id=$1 ORDER BY revision DESC`, [itemId])).rows;
  const history = await catalogRepository.history({ profileUserId: ADMIN }, itemId);
  expect(history).toHaveLength(saved.length);
  const comparisons = saved.map((revision) => {
    const actual = history.find((entry) => entry.revision === revision.revision)!;
    expect(actual.itemId).toBe(itemId); expect(actual.iceCode).toBe(revision.ice_code_snapshot);
    expect(actual.fields).toEqual(revision.fields);
    const expected = { reason: revision.reason, actorId: revision.actor_id,
      recordedAt: revision.recorded_at.toISOString(), evidenceRef: revision.evidence_ref };
    expect(actual.revisionAudit).toEqual(expected);
    expect(Object.keys(actual.revisionAudit).sort()).toEqual(['actorId', 'evidenceRef', 'reason', 'recordedAt']);
    for (const forbidden of ['financial', 'amounts', 'cost', 'operatingPrice', 'session', 'credentials', 'actorProfile']) expect(actual).not.toHaveProperty(forbidden);
    return { revision: revision.revision, codeSnapshot: actual.iceCode, database: expected, projected: actual.revisionAudit, exact: true };
  });
  for (const actor of [OPERATOR, INACTIVE]) await expect(catalogRepository.history({ profileUserId: actor }, itemId)).rejects.toMatchObject({ code: '42501' });
  receipt(receiptName, { itemId, timeMeaning: 'recordedAt is database system record time, not source business update time',
    comparisons, exactFourAuditFields: true, noPrivateAmountsOrAuthenticationPayload: true, operatorAndInactiveHistoryDenied: true });
}

describe.sequential('catalog real isolated PostgreSQL', () => {
  beforeAll(async () => { prepared = await prepareBaseline(); });
  afterAll(async () => { await Promise.all([app.end(), owner.end(), closeP002Pools()]); });

  it('uses the fresh marker, nonowner nonbypass runtime, FORCE RLS, guarded private amounts and strict preparation guards', async () => {
    const identity = (await app.query(`SELECT current_database() AS database, current_user AS runtime, r.rolsuper,r.rolbypassrls,(SELECT run_id FROM p0_02_meta.platform_instance LIMIT 1) AS run FROM pg_roles r WHERE rolname=current_user`)).rows[0];
    expect(identity).toMatchObject({ database: instance.dbName, runtime: 'ice_p0_02_app_runner', rolsuper: false, rolbypassrls: false, run: instance.runId });
    const tables = (await owner.query(`SELECT n.nspname AS schema,c.relname,c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('catalog','catalog_private') AND c.relkind='r'`)).rows;
    expect(tables.length).toBeGreaterThan(12);
    for (const table of tables) { expect(table.relrowsecurity).toBe(true); expect(table.relforcerowsecurity).toBe(true); expect(table.owner).not.toBe(identity.runtime); }
    await expect(tx(ADMIN, (c) => c.query('SELECT * FROM catalog_private.item_financial_revision'))).rejects.toMatchObject({ code: '42501' });
    for (const actor of [null, OPERATOR, INACTIVE, '11111111-1111-4111-8111-111111111199']) await expect(tx(actor, (c) => c.query('SELECT catalog.require_admin()'))).rejects.toMatchObject({ code: '42501' });
    await expect(tx(ADMIN, (c) => c.query('INSERT INTO catalog.catalog_item(first_release_id) VALUES($1)', [randomUUID()]))).rejects.toMatchObject({ code: '42501' });
    receipt('runtime-rls.json', { identity, tables, privateDirectReadDenied: true, noIdentityOperatorInactiveDenied: true });
  });

  it('rejects missing/old/nonloopback/nonempty/existing targets before DDL and preserves old and current instance markers', async () => {
    const repo = process.env.CATALOG_SOURCE_ROOT!;
    const oldRoot = path.join(repo, '.local/p0-02/run-20261014-r2');
    const protectedFiles = [path.join(oldRoot, 'instance.json'), path.join(oldRoot, 'env.p0-02.json'), path.join(oldRoot, 'established.json'), path.join(runRoot, 'instance/catalog-instance.json'), path.join(runRoot, 'instance/env.catalog.json')].filter((file) => fs.existsSync(file));
    const fingerprints = () => Object.fromEntries(protectedFiles.map((file) => [file, createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
    const before = fingerprints();
    const schemaBefore = (await owner.query(`SELECT n.nspname,c.relname,c.relkind,c.relowner,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('catalog','catalog_private') ORDER BY n.nspname,c.relname`)).rows;
    const cases = [
      { name: 'missing-run', args: [] }, { name: 'old-p0-run', args: ['--run-id', 'run-20261014-r2'] },
      { name: 'nonloopback', args: ['--run-id', instance.runId, '--host', '203.0.113.1'] },
      { name: 'nonempty-target-and-existing-instance', args: ['--run-id', instance.runId] },
    ];
    const environment = {} as NodeJS.ProcessEnv;
    for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'ComSpec', 'WINDIR']) if (process.env[key]) environment[key] = process.env[key]!;
    const results = cases.map((entry) => {
      const result = spawnSync(process.execPath, [path.join(repo, 'scripts/catalog/prepare.mjs'), ...entry.args], { cwd: repo, env: environment, encoding: 'utf8', windowsHide: true });
      expect(result.status).toBe(1); expect(result.stderr).toMatch(/CATALOG_(RUN_ID_REQUIRED|NON_LOOPBACK_DENIED|NONEMPTY_TARGET_DENIED)/);
      return { ...entry, exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
    });
    expect(fingerprints()).toEqual(before);
    expect((await owner.query(`SELECT n.nspname,c.relname,c.relkind,c.relowner,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('catalog','catalog_private') ORDER BY n.nspname,c.relname`)).rows).toEqual(schemaBefore);
    receipt('prepare-guard-negatives.json', { results, markerHashesBefore: before, markerHashesAfter: fingerprints(), schemaObjectsUnchanged: true, oldInstanceNeverConnected: true });
  });

  it('validates 147 complete artifacts separately from 129 JSON/CSV and keeps every exact byte privately', async () => {
    expect(prepared.fullManifest).toHaveLength(147); expect(prepared.subsetManifest).toHaveLength(129);
    const checks = [];
    for (const artifact of prepared.fullManifest) {
      const stored = await readPrivateArtifact(artifact);
      const original = fs.readFileSync(path.join(process.env.CATALOG_SOURCE_ROOT!, BASELINE_DIRECTORY, artifact.logicalName));
      expect(stored.equals(original)).toBe(true); checks.push({ logicalName: artifact.logicalName, sha256: artifact.sha256, size: artifact.size, equal: true });
    }
    receipt('input-manifest-complete147.json', { artifacts: checks });
    receipt('input-manifest-jsoncsv129.json', { artifacts: prepared.subsetManifest });
  });

  it('rolls back a failure after item/observation inserts and leaves no half release or success audit', async () => {
    const before = await getCounts();
    expect(before).toEqual({ items: 0, observations: 0, decisions: 0, audits: 0, releases: 0, published: 0 });
    const invalid = structuredClone(prepared);
    const lastSelection = invalid.decisions.filter((d) => d.entryKind === 'candidate_snapshot' && d.selectedItemAnchor).at(-1)!;
    lastSelection.selectedItemAnchor = '/master_rows/not-present';
    let failureCode: string | undefined;
    try { await publish(invalid); } catch (error) { failureCode = (error as { code: string }).code; }
    expect(failureCode).toBeDefined(); expect(await getCounts()).toEqual(before);
    receipt('atomic-midpublish-failure.json', { injected: 'last selected target cannot resolve after item/observation inserts', failureCode, before, after: await getCounts(), noPublishedOrAudit: true });
  });

  it('rejects wrong pins, missing original artifact and an untraceable JST reference without half publication', async () => {
    const before = await getCounts();
    const wrongPin = { ...prepared, bundleSha256: '0'.repeat(64) };
    const missingArtifact = { ...prepared, artifacts: prepared.artifacts.filter((a) => a.logicalName !== 'match-bundle.json') };
    const unresolvedJst = structuredClone(prepared);
    const jstDecision = unresolvedJst.decisions.find((d) => d.entryKind === 'candidate_snapshot' && d.selectedJushuitanRef)!;
    jstDecision.selectedJushuitanRef = 'match-bundle.json#/candidates/not-present/selected_jushuitan';
    const unknownJstId = structuredClone(prepared);
    unknownJstId.decisions.find((d) => d.entryKind === 'candidate_snapshot' && d.selectedJushuitanRef)!.summary.selectedJushuitanCandidateId = 'ISOLATED-UNTRACEABLE-JST-CANDIDATE';
    const invalidJstSha = structuredClone(prepared);
    invalidJstSha.decisions.find((d) => d.entryKind === 'candidate_snapshot' && d.selectedJushuitanRef)!.selectedJushuitanSha256 = 'not-a-sha256';
    const invalidJstNull = structuredClone(prepared);
    invalidJstNull.decisions.find((d) => d.entryKind === 'candidate_snapshot' && d.selectedJushuitanRef)!.selectedJushuitanRef = null;
    const scenarios = [{ name: 'wrong-bundle-pin', value: wrongPin }, { name: 'missing-bundle-artifact', value: missingArtifact }, { name: 'untraceable-jst-reference', value: unresolvedJst }, { name: 'missing-jst-candidate-lookup', value: unknownJstId }, { name: 'invalid-jst-sha', value: invalidJstSha }, { name: 'inconsistent-null-jst-reference', value: invalidJstNull }];
    const failures = [];
    for (const scenario of scenarios) {
      let code: string | null = null;
      try { await publish(scenario.value); } catch (error) { code = String((error as { code?: string }).code ?? 'UNKNOWN'); }
      expect(code).not.toBeNull(); expect(await getCounts()).toEqual(before);
      failures.push({ scenario: scenario.name, code, noVisiblePartialResult: true });
    }
    receipt('invalid-input-and-jst-failures.json', { failures, before, after: await getCounts(), noSuccessAudit: true });
  });

  it('rejects another existing anchor and missing or conflicting original target metadata with no release, item, observation, decision or success audit', async () => {
    const before = await getCounts();
    expect(before).toEqual({ items: 0, observations: 0, decisions: 0, audits: 0, releases: 0, published: 0 });
    const original = prepared.decisions.find((d) => d.entryKind === 'candidate_snapshot' && d.entryKey === '/candidates/0')!;
    expect(original.selectedItemAnchor).toBe('/master_rows/87');
    expect(original.summary).toMatchObject({ selectedMasterRow: 92, selectedMasterCode: 'WM0098' });
    const wrongExistingTarget = prepared.items.find((item) => item.anchorPointer === '/master_rows/0')!;
    expect(wrongExistingTarget).toMatchObject({ rowPosition: 2, iceCode: 'LS101311' });
    const cases: { name: string; mutate: (decision: PreparedBaseline['decisions'][number]) => void }[] = [
      { name: 'different-existing-anchor-with-original-summary-and-hashes', mutate: (d) => { d.selectedItemAnchor = '/master_rows/0'; } },
      { name: 'missing-selected-row', mutate: (d) => { delete d.summary.selectedMasterRow; } },
      { name: 'null-selected-row', mutate: (d) => { d.summary.selectedMasterRow = null; } },
      { name: 'conflicting-selected-row', mutate: (d) => { d.summary.selectedMasterRow = 2; } },
      { name: 'string-instead-of-original-numeric-row', mutate: (d) => { d.summary.selectedMasterRow = '92'; } },
      { name: 'missing-selected-code', mutate: (d) => { delete d.summary.selectedMasterCode; } },
      { name: 'null-selected-code', mutate: (d) => { d.summary.selectedMasterCode = null; } },
      { name: 'conflicting-selected-code', mutate: (d) => { d.summary.selectedMasterCode = 'LS101311'; } },
      { name: 'numeric-instead-of-original-string-code', mutate: (d) => { d.summary.selectedMasterCode = 98; } },
    ];
    const failures = [];
    for (const scenario of cases) {
      const invalid = structuredClone(prepared);
      const changed = invalid.decisions.find((d) => d.entryKind === 'candidate_snapshot' && d.entryKey === original.entryKey)!;
      scenario.mutate(changed);
      // Do not rewrite frozen source summaries or hashes to legitimize a bad FK.
      expect(changed.payloadSha256).toBe(original.payloadSha256);
      expect(invalid.contentSha256).toBe(prepared.contentSha256);
      expect(invalid.bundleSha256).toBe(prepared.bundleSha256);
      expect(invalid.effectiveCsvSha256).toBe(prepared.effectiveCsvSha256);
      if (scenario.name === cases[0].name) expect(changed.summary).toEqual(original.summary);
      let failure: { code?: string; message?: string } | null = null;
      try { await publish(invalid); } catch (error) { failure = error as { code?: string; message?: string }; }
      expect(failure).toMatchObject({ code: '22023', message: 'CATALOG_BASELINE_TARGET_INVALID' });
      expect(await getCounts()).toEqual(before);
      failures.push({ scenario: scenario.name, candidate: changed.entryKey, originalAnchor: original.selectedItemAnchor,
        suppliedAnchor: changed.selectedItemAnchor, summary: changed.summary, payloadSha256: changed.payloadSha256,
        contentSha256: invalid.contentSha256, failureCode: failure?.code, failureMessage: failure?.message,
        after: await getCounts(), completeRollback: true });
    }
    const unselected = structuredClone(prepared);
    const noTarget = unselected.decisions.find((d) => d.entryKind === 'candidate_snapshot' && d.selectedItemAnchor === null)!;
    noTarget.summary.selectedMasterRow = 92; noTarget.summary.selectedMasterCode = 'WM0098';
    await expect(publish(unselected)).rejects.toMatchObject({ code: '22023', message: 'CATALOG_BASELINE_TARGET_INVALID' });
    expect(await getCounts()).toEqual(before);
    receipt('invalid-existing-target-and-metadata.json', { authority: 'unchanged frozen bundle/effective CSV bytes and pins',
      scope: 'fixed baseline publication consistency; not a permanent matching or formal relationship rule',
      originalCandidate: original.entryKey, originalAnchor: original.selectedItemAnchor, originalSummary: original.summary,
      wrongExistingTarget: { anchor: wrongExistingTarget.anchorPointer, row: wrongExistingTarget.rowPosition, code: wrongExistingTarget.iceCode },
      before, failures, unselectedWithConflictingTargetMetadataRejected: true, after: await getCounts(), noUnpublishedReleaseOrSuccessAudit: true });
  });

  it('publishes atomically, preserves all 126 anchors, 1417 candidates, 548 exact targets/JST references and every history occurrence', async () => {
    const request = randomUUID(); const result = await publish(prepared, request);
    expect(result).toMatchObject({ published: true, itemCount: 126, observationCount: 1417, selectedCount: 548 });
    const anchors = (await owner.query(`SELECT a.json_pointer,a.item_id,a.row_position,a.payload_sha256,c.ice_code FROM catalog.baseline_item_anchor a LEFT JOIN catalog.catalog_item_code c USING(item_id) ORDER BY a.row_position`)).rows;
    expect(anchors).toHaveLength(126); expect(new Set(anchors.map((a) => a.item_id)).size).toBe(126);
    expect(anchors.filter((a) => a.ice_code !== null)).toHaveLength(125);
    for (const item of prepared.items) {
      const actual = anchors.find((a) => a.json_pointer === item.anchorPointer)!;
      expect(actual).toMatchObject({ row_position: item.rowPosition, ice_code: item.iceCode, payload_sha256: item.payloadSha256 });
    }
    initialAnchors = anchors; newItemId = anchors.find((a) => a.row_position === 122)!.item_id;
    wmId = anchors.find((a) => a.ice_code === 'WM0072')!.item_id;
    const actualDecisions = (await owner.query(`SELECT d.*,a.json_pointer AS selected_anchor FROM catalog.decision_evidence d LEFT JOIN catalog.baseline_item_anchor a ON a.item_id=d.selected_item_id AND a.release_id=d.release_id ORDER BY d.entry_kind,d.entry_key`)).rows;
    expect(actualDecisions).toHaveLength(prepared.decisions.length);
    const rawBundle = JSON.parse(fs.readFileSync(path.join(process.env.CATALOG_SOURCE_ROOT!, BASELINE_DIRECTORY, 'match-bundle.json'), 'utf8'));
    const exact548 = [];
    for (const expected of prepared.decisions) {
      const actual = actualDecisions.find((d) => d.entry_kind === expected.entryKind && d.entry_key === expected.entryKey)!;
      expect(actual).toBeDefined();
      expect(actual.payload_sha256).toBe(expected.payloadSha256); expect(actual.raw_ref).toBe(expected.rawRef);
      expect(actual.selected_anchor).toBe(expected.selectedItemAnchor); expect(actual.selected_jushuitan_ref).toBe(expected.selectedJushuitanRef);
      expect(actual.summary).toEqual(expected.summary);
      expect(actual.selected_jushuitan_sha256).toBe(expected.selectedJushuitanSha256);
      if (expected.entryKind === 'candidate_snapshot' && expected.reviewState === 'manual_selected') {
        const index = Number(expected.entryKey.split('/').at(-1)); const candidate = rawBundle.candidates[index];
        const anchor = anchors.find((a) => a.item_id === actual.selected_item_id)!;
        expect(anchor.row_position).toBe(candidate.selected_master.row_index); expect(anchor.ice_code).toBe(candidate.selected_master.ice_code);
        expect(actual.summary.selectedJushuitanCandidateId).toBe(candidate.selected_jushuitan?.candidate_id ?? null);
        expect(actual.summary.decisionRecordCount).toBe(candidate.decision_records.length);
        exact548.push({ candidateId: candidate.candidate_id, originalTarget: candidate.selected_master, selectedItemId: actual.selected_item_id, selectedAnchor: actual.selected_anchor, jstRef: actual.selected_jushuitan_ref, jstSha256: expected.selectedJushuitanSha256, decisionHistoryOccurrences: candidate.decision_records.length, fullCandidatePayloadSha256: actual.payload_sha256, equal: true });
      }
    }
    expect(exact548).toHaveLength(548);
    const countByKind = Object.fromEntries([...new Set(actualDecisions.map((d) => d.entry_kind))].map((kind) => [kind, actualDecisions.filter((d) => d.entry_kind === kind).length]));
    expect(countByKind.effective_csv_record).toBe(3160); expect(countByKind.master_history).toBe(126);
    const notCreated = actualDecisions.filter((d) => d.entry_kind === 'history:batch_bs_not_created');
    const brushes = actualDecisions.filter((d) => d.entry_kind === 'history:batch_brush_preservation');
    expect(notCreated).toHaveLength(2); expect(brushes).toHaveLength(2);
    expect(notCreated.map((d) => d.summary.iceCode).sort()).toEqual(['WM0070', 'WM0072']);
    for (const d of notCreated) {
      expect(d.selected_item_id).not.toBeNull(); expect(d.summary.status).toBe('user_confirmed_not_created');
      expect(d.summary.sourceSystem).toBe('bigseller'); expect(d.observation_id).toBeNull();
    }
    expect(new Set(brushes.map((d) => d.selected_item_id)).size).toBe(2);
    for (const d of brushes) { expect(d.selected_item_id).not.toBeNull(); expect(d.summary.status).toBe('pending_confirmation'); expect(d.summary.doNotMerge).toBe(true); }
    receipt('anchor-to-uuid126.json', anchors); receipt('exact-548-target-jst-history.json', exact548);
    receipt('all-history-preservation.json', { totalOccurrences: actualDecisions.length, countByKind, allExpectedPointersHashesSummariesEqual: true, rawArtifactsBytesEqual: true, csvOnlyEvidenceNotReplayed: true });
    receipt('explicit-existing-statuses.json', { notCreated, brushes, distinctBrushItemIds: true, noPlaceholderObservation: true, historyOnlyNotFormalRelationships: true });
    const again = await publish(prepared, request); expect(again).toEqual(result);
    await expect(publish(prepared, request, hash('different-intent'))).rejects.toMatchObject({ code: '23505' });
    await expect(publish({ ...prepared, contentSha256: hash('changed-adoption-with-same-pins') })).rejects.toMatchObject({ code: '23505' });
    const beforeBadReimport = await getCounts();
    await expect(publish({ ...prepared, releaseKey: 'ISOLATED-WRONG-RELEASE-KEY' })).rejects.toMatchObject({ code: '23505' });
    await expect(publish({ ...prepared, effectiveCsvSha256: '0'.repeat(64) })).rejects.toMatchObject({ code: '22023' });
    expect(await getCounts()).toEqual(beforeBadReimport);
    receipt('publish-and-request-idempotency.json', { request, first: result, repeated: again, intentMismatchRejected: true });
  });

  it('imports exactly159 frozen partial observations idempotently and protects adopted amounts and nonamount JSON', async () => {
    const frozen = await loadFrozenFeishu();
    const importFrozen = async () => tx(ADMIN, async (c) => (await c.query('SELECT catalog.import_frozen_observations($1,$2,$3::jsonb) AS result', [randomUUID(), hash(frozen), JSON.stringify(frozen)])).rows[0].result);
    const imported = await importFrozen(); const repeated = await importFrozen(); expect(repeated).toEqual(imported);
    expect(await getCounts()).toMatchObject({ items: 126, observations: 1576, published: 1 });
    const amounts = await tx(ADMIN, async (c) => (await c.query('SELECT catalog.read_item_amounts($1) AS payload', [wmId])).rows[0].payload);
    expect(amounts.cost.raw).toBe('5.18'); expect(amounts.operatingPrice.raw).toBe('5.68'); expect(amounts.sourceRow).toBe(216);
    expect(amounts.versions.map((v: { sourceRow: number }) => v.sourceRow)).toEqual(expect.arrayContaining([66, 216]));
    const row66 = await tx(ADMIN, async (c) => (await c.query(`SELECT o.position,catalog.read_observation_amounts(o.id) AS amounts FROM catalog.source_observation o JOIN catalog.observation_batch b ON b.id=o.batch_id JOIN catalog.source_dataset d ON d.id=b.dataset_id JOIN catalog.source_namespace n ON n.id=d.namespace_id WHERE n.system='feishu' AND o.position->>'cell' IN('I66','J66') ORDER BY o.position->>'cell'`)).rows);
    expect(row66).toHaveLength(2); expect(row66.map((r) => Object.values(r.amounts as Record<string, { raw: string }>)[0].raw)).toEqual(['5', '5.5']);
    const publicFields = (await owner.query(`SELECT fields FROM catalog.source_observation WHERE position->>'cell' IN('I66','J66')`)).rows;
    for (const row of publicFields) expect(JSON.stringify(row.fields)).not.toMatch(/"5(?:\.5)?"/);
    for (const actor of [null, OPERATOR, INACTIVE]) {
      await expect(tx(actor, (c) => c.query('SELECT catalog.read_item_amounts($1)', [wmId]))).rejects.toMatchObject({ code: '42501' });
      expect(await tx(actor, async (c) => (await c.query('SELECT * FROM catalog.catalog_item')).rowCount)).toBe(0);
    }
    receipt('wm0072-price-and-partial159.json', { adopted: amounts, sourceObservations: row66, frozenCoverage: frozen.coverage, imported, repeated, defaultFieldsNoAmountValues: true, deniedActors: ['anonymous', 'operator', 'inactive'] });
  });

  it('commits one concurrent first code, keeps old revision missing and financial pointer, rejects conflicting code/request', async () => {
    const before = (await owner.query('SELECT * FROM catalog.item_current WHERE item_id=$1', [newItemId])).rows[0];
    expect(before.revision).toBe(1); expect(before.financial_revision).toBeNull();
    const invalidInputs: unknown[][] = [
      [newItemId, null, 'TEST-NULL-CAS', 'fixture', 'fixture:code'],
      [newItemId, 0, 'TEST-ZERO-CAS', 'fixture', 'fixture:code'],
      [newItemId, 1, 'TEST-NULL-REASON', null, 'fixture:code'],
      [newItemId, 1, 'TEST-NULL-EVIDENCE', 'fixture', null],
      [newItemId, 1, '\tTEST-SPACE', 'fixture', 'fixture:code'],
    ];
    for (const parameters of invalidInputs) await expect(tx(ADMIN, (c) => c.query('SELECT catalog.assign_initial_code($1,$2,$3,$4,$5,$6,$7)', [randomUUID(), hash(parameters), ...parameters]))).rejects.toMatchObject({ code: '22023' });
    await expect(tx(ADMIN, (c) => c.query('SELECT catalog.assign_initial_code($1,$2,$3,1,$4,$5,$6)', [randomUUID(), hash('duplicate-code'), newItemId, 'WM0072', 'fixture', 'fixture:duplicate']))).rejects.toMatchObject({ code: '23505' });
    expect((await owner.query('SELECT * FROM catalog.item_current WHERE item_id=$1', [newItemId])).rows[0]).toEqual(before);
    const requests = [randomUUID(), randomUUID()];
    const attempts = await Promise.allSettled(requests.map((request, index) => tx(ADMIN, async (c) => (await c.query('SELECT catalog.assign_initial_code($1,$2,$3,1,$4,$5,$6) AS result', [request, hash({ code: index }), newItemId, `TEST-PG-NEW122-${index}`, 'ISOLATED TEST ONLY', 'fixture:pg-code'])).rows[0].result)));
    expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1); expect(attempts.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const success = attempts.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{ iceCode: string; revision: number }>;
    expect(success.value.revision).toBe(2);
    const oldRevision = (await owner.query('SELECT ice_code_snapshot FROM catalog.item_revision WHERE item_id=$1 AND revision=1', [newItemId])).rows[0];
    expect(oldRevision.ice_code_snapshot).toBeNull();
    const after = (await owner.query('SELECT * FROM catalog.item_current WHERE item_id=$1', [newItemId])).rows[0];
    expect(after.financial_revision).toBe(before.financial_revision);
    expect((await owner.query('SELECT count(*)::int AS n FROM catalog.catalog_item')).rows[0].n).toBe(126);
    await expect(tx(ADMIN, (c) => c.query('SELECT catalog.assign_initial_code($1,$2,$3,2,$4,$5,$6)', [randomUUID(), hash('another'), newItemId, 'TEST-SECOND-CODE', 'fixture', 'fixture:code']))).rejects.toMatchObject({ code: '23505' });
    await checkRevisionAuditProjection(newItemId, 'revision-audit-projection-first-code.json');
    receipt('concurrent-first-code.json', { itemId: newItemId, before, after, oldRevision, nullZeroCASNullReasonNullEvidenceEdgeWhitespaceRejected: true, anotherItemsCodeRejected: true, attempts: attempts.map((r) => r.status === 'fulfilled' ? { status: r.status, result: r.value } : { status: r.status, code: r.reason.code }), exactlyOneCommitted: true, testCodeOnly: true });
  });

  it('preserves money pointer across concurrent nonprice CAS, rejects price edits and malformed field unions, and baseline reimport never resets current data', async () => {
    const before = (await owner.query('SELECT * FROM catalog.item_current WHERE item_id=$1', [wmId])).rows[0];
    const makeField = (raw: string) => ({ state: 'observed', raw, meaning: 'value', evidenceRef: 'fixture:nonprice' });
    await expect(tx(ADMIN, (c) => c.query('SELECT catalog.append_nonprice_revision($1,$2,$3,NULL,$4::jsonb,$5,$6)', [randomUUID(), hash('null-revision'), wmId, JSON.stringify({ factory: makeField('TEST') }), 'fixture', 'fixture:invalid']))).rejects.toMatchObject({ code: '22023' });
    const attempts = await Promise.allSettled([0, 1].map((index) => tx(ADMIN, async (c) => (await c.query('SELECT catalog.append_nonprice_revision($1,$2,$3,$4,$5::jsonb,$6,$7) AS result', [randomUUID(), hash({ index }), wmId, before.revision, JSON.stringify({ factory: makeField(`TEST-FACTORY-${index}`) }), 'ISOLATED TEST ONLY', 'fixture:revision'])).rows[0].result)));
    expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const after = (await owner.query('SELECT * FROM catalog.item_current WHERE item_id=$1', [wmId])).rows[0];
    expect(after.revision).toBe(before.revision + 1); expect(after.financial_revision).toBe(before.financial_revision);
    for (const fields of [{ cost: makeField('0') }, { factory: { state: 'not_read', raw: '0', reason: 'missing', evidenceRef: 'fixture:x' } }, { factory: { state: 'no_text', raw: null, meaning: 'value', evidenceRef: 'fixture:x' } }]) {
      await expect(tx(ADMIN, (c) => c.query('SELECT catalog.append_nonprice_revision($1,$2,$3,$4,$5::jsonb,$6,$7)', [randomUUID(), hash(fields), wmId, after.revision, JSON.stringify(fields), 'fixture', 'fixture:invalid']))).rejects.toMatchObject({ code: '22023' });
    }
    const states = (await owner.query(`SELECT catalog.valid_field($1::jsonb) AS explicit_zero,catalog.valid_field($2::jsonb) AS not_read,catalog.valid_field($3::jsonb) AS failed,catalog.valid_field($4::jsonb) AS missing,catalog.valid_field($5::jsonb) AS malformed`, [JSON.stringify(makeField('0')), JSON.stringify({ state: 'not_read', raw: null, reason: 'not requested', evidenceRef: 'fixture:unread' }), JSON.stringify({ state: 'parse_failed', raw: null, reason: 'parse error', evidenceRef: 'fixture:failed' }), JSON.stringify({ state: 'observed', raw: '', meaning: 'explicit_empty', evidenceRef: 'fixture:empty' }), JSON.stringify({ state: 'observed', raw: null, meaning: 'value', evidenceRef: 'fixture:bad' })])).rows[0];
    expect(states).toEqual({ explicit_zero: true, not_read: true, failed: true, missing: true, malformed: false });
    const currentBefore = (await owner.query('SELECT * FROM catalog.item_current ORDER BY item_id')).rows;
    const codesBefore = (await owner.query('SELECT * FROM catalog.catalog_item_code ORDER BY item_id')).rows;
    const anchorsBefore = (await owner.query('SELECT json_pointer,item_id FROM catalog.baseline_item_anchor ORDER BY json_pointer')).rows;
    await publish();
    expect((await owner.query('SELECT * FROM catalog.item_current ORDER BY item_id')).rows).toEqual(currentBefore);
    expect((await owner.query('SELECT * FROM catalog.catalog_item_code ORDER BY item_id')).rows).toEqual(codesBefore);
    expect((await owner.query('SELECT json_pointer,item_id FROM catalog.baseline_item_anchor ORDER BY json_pointer')).rows).toEqual(anchorsBefore);
    const money = await tx(ADMIN, async (c) => (await c.query('SELECT catalog.read_item_amounts($1) AS payload', [wmId])).rows[0].payload);
    expect(money.cost.raw).toBe('5.18'); expect(money.operatingPrice.raw).toBe('5.68');
    await checkRevisionAuditProjection(wmId, 'revision-audit-projection-nonprice.json');
    receipt('revision-reimport-values.json', { wmItemId: wmId, before, after, exactlyOneNonpriceRevision: true, fieldStates: states, currentAndCodeAndAnchorUnchangedAfterReimport: true, financialPointerPreserved: true, acceptedAmounts: money });
  });

  it('keeps isolated account/scope duplicates without Variant/CN placeholders and never creates formal source identity tables', async () => {
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      const base = (await client.query('SELECT id,release_id,artifact_id FROM catalog.observation_batch LIMIT 1')).rows[0];
      const ids = [];
      for (const account of ['TEST-ACCOUNT-A', 'TEST-ACCOUNT-B']) {
        const namespace = (await client.query(`INSERT INTO catalog.source_namespace(system,local_key,account_scope) VALUES('jushuitan',$1,$2::jsonb) RETURNING id`, [account, JSON.stringify({ state: 'known', raw: account, canonical: account, evidenceRef: 'fixture:account' })])).rows[0].id;
        const dataset = (await client.query(`INSERT INTO catalog.source_dataset(namespace_id,local_dataset_key,resource_identity,key_contract) VALUES($1,'fixture','{}','{"mode":"observe_only"}') RETURNING id`, [namespace])).rows[0].id;
        const batch = (await client.query(`INSERT INTO catalog.observation_batch(dataset_id,release_id,artifact_id,snapshot_key,content_sha256,coverage) VALUES($1,$2,$3,'fixture','fixture','{"complete":false}') RETURNING id`, [dataset, base.release_id, base.artifact_id])).rows[0].id;
        const unknown = { state: 'unknown', raw: null, reason: 'JST metadata has no market/warehouse' };
        const observation = (await client.query(`INSERT INTO catalog.source_observation(batch_id,artifact_id,entry_key,position,scope,fields,raw_ref,payload_sha256) VALUES($1,$2,'same-position','{"row":1}',$3::jsonb,$4::jsonb,'fixture:duplicate','fixture') RETURNING id,fields,scope`, [batch, base.artifact_id, JSON.stringify({ account: { state: 'known', raw: account, canonical: account, evidenceRef: 'fixture:account' }, market: unknown, warehouse: unknown }), JSON.stringify({ sku: { state: 'observed', raw: 'SAME-SKU', meaning: 'value', evidenceRef: 'fixture:sku' } })])).rows[0];
        ids.push(observation);
      }
      expect(ids[0].id).not.toBe(ids[1].id); expect(ids.map((r) => r.fields.sku.raw)).toEqual(['SAME-SKU', 'SAME-SKU']);
      expect(ids.every((r) => r.scope.market.state === 'unknown' && r.scope.warehouse.state === 'unknown')).toBe(true);
      const future = (await client.query(`SELECT to_regclass('catalog.source_record') AS record,to_regclass('catalog.identity_claim') AS claim,to_regclass('catalog.observation_record_link') AS link`)).rows[0];
      expect(future).toEqual({ record: null, claim: null, link: null });
      receipt('scope-duplicates-no-variant.json', { temporaryFixtureObservations: ids, fixtureRolledBack: true, futureTablesAbsent: future, noCountryOrVariantColumns: true });
    } finally { await client.query('ROLLBACK'); client.release(); }
  });

  it('clears transaction-local identity after commit/rollback, connection reuse, revocation and unknown commit request verification', async () => {
    const pids = [];
    for (const actor of [ADMIN, OPERATOR, INACTIVE, null, ADMIN]) {
      pids.push(await withAppDb(actor ? { profileUserId: actor } : null, async (c) => {
        const result = (await c.query(`SELECT pg_backend_pid() AS pid,current_setting('request.jwt.claim.sub',true) AS identity,catalog.is_admin() AS allowed`)).rows[0];
        expect(result.identity).toBe(actor ?? ''); expect(result.allowed).toBe(actor === ADMIN); return result;
      }));
    }
    await expect(withAppDb({ profileUserId: ADMIN }, async () => { throw new Error('INJECTED_TX_FAILURE'); })).rejects.toThrow('INJECTED_TX_FAILURE');
    await withAppDb(null, async (c) => { expect((await c.query('SELECT catalog.is_admin() AS allowed')).rows[0].allowed).toBe(false); });
    expect(new Set(pids.map((p) => p.pid)).size).toBe(1);
    try {
      await owner.query('UPDATE public.profiles SET is_active=false WHERE id=$1', [ADMIN]);
      await expect(tx(ADMIN, (c) => c.query('SELECT catalog.read_item_amounts($1)', [wmId]))).rejects.toMatchObject({ code: '42501' });
    } finally { await owner.query('UPDATE public.profiles SET is_active=true WHERE id=$1', [ADMIN]); }
    const request = randomUUID();
    const queryPrototype = Client.prototype as unknown as { query: (...args: unknown[]) => Promise<unknown> };
    const realQuery = queryPrototype.query;
    let injectCommit = true; let acknowledgementsLost = 0; const queryTrace: string[] = [];
    const spy = vi.spyOn(queryPrototype, 'query').mockImplementation(function (this: unknown, ...args: unknown[]) {
      const sql = typeof args[0] === 'string' ? args[0] : '';
      queryTrace.push(sql.includes('audit_event') ? 'audit_lookup' : sql.includes('publish_baseline') ? 'publish_rpc' : sql === 'COMMIT' ? 'commit' : 'other');
      const result = realQuery.apply(this, args);
      if (injectCommit && sql === 'COMMIT') {
        injectCommit = false;
        return Promise.resolve(result).then(() => { acknowledgementsLost++; throw Object.assign(new Error('INJECTED_COMMIT_ACK_LOST'), { code: 'ECONNRESET' }); });
      }
      return result;
    });
    let reconciled;
    try { reconciled = await catalogRepository.publish({ profileUserId: ADMIN }, request, prepared); }
    finally { spy.mockRestore(); }
    expect(acknowledgementsLost).toBe(1); expect(reconciled?.published).toBe(true);
    expect(queryTrace.filter((s) => s === 'publish_rpc')).toHaveLength(1);
    expect(queryTrace.indexOf('audit_lookup')).toBeGreaterThan(queryTrace.indexOf('commit'));
    const verified = await catalogRepository.request({ profileUserId: ADMIN }, request);
    expect(verified?.result).toEqual(reconciled);
    expect((await owner.query('SELECT count(*)::int AS n FROM catalog.audit_event WHERE request_id=$1', [request])).rows[0].n).toBe(1);
    const finalAnchors = (await owner.query(`SELECT a.json_pointer,a.item_id,a.row_position,a.payload_sha256,c.ice_code FROM catalog.baseline_item_anchor a LEFT JOIN catalog.catalog_item_code c USING(item_id) ORDER BY a.row_position`)).rows;
    expect(finalAnchors.map((a) => [a.json_pointer, a.item_id])).toEqual((initialAnchors as { json_pointer: string; item_id: string }[]).map((a) => [a.json_pointer, a.item_id]));
    const final = await getCounts(); expect(final).toMatchObject({ items: 126, observations: 1576, published: 1 });
    receipt('pool-unknown-commit-final.json', { connectionReused: pids, rollbackCleared: true, revokedAdminDenied: true, unknownCommit: { request, verified, reconciled, acknowledgementsLost, queryTrace, publishRpcExecutedOnce: true, auditLookupAfterLostCommitAcknowledgement: true }, final, canonicalAnchorUUIDsUnchanged: true });
  });
});
