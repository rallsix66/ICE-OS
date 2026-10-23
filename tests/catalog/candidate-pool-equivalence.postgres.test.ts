import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCandidates } from '@/features/catalog/candidate-service';
import { scopeObservationsForItemAudit } from '@/features/catalog/candidate-service';
import { catalogRepository } from '@/features/catalog/repository';
import { withReadOnlyAppDb, type ReadOnlyDbSessionEvidence } from '@/lib/database/app-db';

const ADMIN = '11111111-1111-4111-8111-111111111101';
const attemptId = process.env.CATALOG_EQUIVALENCE_ATTEMPT_ID
  ?? `attempt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const runId = process.env.CATALOG_EQUIVALENCE_RUN_ID ?? process.env.CATALOG_RUN_ID ?? null;
const OUT_DIR = path.join(process.cwd(), '.local/catalog/ux-perf-u3-20261022/attempts', attemptId);
const OUT_PATH = path.join(OUT_DIR, 'candidate-equivalence.json');
const identity = { profileUserId: ADMIN };

/** Every progress write keeps this attempt's identity (attemptId/runId/phase/status). */
function progressIdentity(phase: string, complete: boolean) {
  return {
    attemptId,
    runId,
    phase,
    status: complete ? 'complete' : 'in_progress',
    entry: 'tests/catalog/candidate-pool-equivalence.postgres.test.ts',
  };
}

/** Observation shape `buildCandidates` actually consumes (shared by the narrow pool and the audit scope). */
type CandidateInputObservation = Parameters<typeof buildCandidates>[1][number];

function candidateFingerprint(
  item: Awaited<ReturnType<typeof catalogRepository.list>>[number],
  observations: CandidateInputObservation[],
) {
  const eligible = observations.filter((o) => o.sourceSystem === 'bigseller' || o.sourceSystem === 'jushuitan');
  return {
    bigseller: buildCandidates(item, eligible, 'bigseller').map((c) => JSON.stringify(c)).sort(),
    jushuitan: buildCandidates(item, eligible, 'jushuitan').map((c) => JSON.stringify(c)).sort(),
  };
}

function writeProgress(payload: Record<string, unknown>) {
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, `${JSON.stringify(payload, null, 2)}\n`);
}

describe.sequential('catalog candidate narrow pool equivalence', () => {
  it('matches full-pool scoped candidates for all 126 items (differenceGroups=0)', async () => {
    const started = Date.now();
    writeProgress({
      ...progressIdentity('started', false),
      at: new Date().toISOString(),
      complete: false,
      readOnly: true,
    });
    const timings: Array<{ index: number; iceCode: string | null; itemId: string; ms: number; phase?: string }> = [];
    // The evidence is produced inside the read-only session callback, so read it from the returned value
    // instead of relying on a side-effect assignment TypeScript cannot narrow.
    const listed = await withReadOnlyAppDb(identity, async (client, evidence) => ({
      items: await catalogRepository.listOnClient(client, identity, { baselinePublishedOnly: true }),
      evidence,
    }));
    const items = listed.items;
    const readOnlyEvidence: ReadOnlyDbSessionEvidence | null = listed.evidence;
    const all = await withReadOnlyAppDb(identity, async (client) => (
      catalogRepository.allObservationsWithDecisionsOnClient(client, identity)
    ));
    expect(items).toHaveLength(126);
    expect(readOnlyEvidence?.transactionReadOnly).toBe('on');
    const mismatches: string[] = [];
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]!;
      const itemStarted = Date.now();
      const narrow = await withReadOnlyAppDb(identity, async (client, evidence) => {
        expect(evidence.transactionReadOnly).toBe('on');
        return catalogRepository.observationsForItemOnClient(client, identity, item);
      });
      timings.push({
        index: index + 1,
        iceCode: item.iceCode,
        itemId: item.itemId,
        ms: Date.now() - itemStarted,
        phase: 'observationsForItem',
      });
      const fullScoped = scopeObservationsForItemAudit(item, all, { verifyEquivalence: false });
      const narrowFp = candidateFingerprint(item, narrow);
      const fullFp = candidateFingerprint(item, fullScoped);
      for (const source of ['bigseller', 'jushuitan'] as const) {
        if (JSON.stringify(narrowFp[source]) !== JSON.stringify(fullFp[source])) {
          mismatches.push(`${item.iceCode ?? item.itemId}:${source}`);
        }
      }
      writeProgress({
        ...progressIdentity('item-progress', index + 1 === items.length),
        at: new Date().toISOString(),
        readOnly: true,
        readOnlyEvidence,
        serial: true,
        itemCount: items.length,
        sourceGroupsChecked: (index + 1) * 2,
        completed: index + 1,
        differenceGroups: mismatches.length,
        elapsedMs: Date.now() - started,
        mismatches: mismatches.slice(0, 50),
        timingsTail: timings.slice(-8),
        complete: index + 1 === items.length,
      });
    }
    const payload = {
      ...progressIdentity('finished', true),
      at: new Date().toISOString(),
      readOnly: true,
      readOnlyEvidence,
      serial: true,
      itemCount: items.length,
      sourceGroupsChecked: items.length * 2,
      completed: items.length,
      differenceGroups: mismatches.length,
      elapsedMs: Date.now() - started,
      mismatches: mismatches.slice(0, 50),
      timings,
      complete: true,
    };
    writeProgress(payload);
    if (process.env.CATALOG_EQUIVALENCE_RUNNER_MANAGED !== '1') {
      const latestPointerPath = path.join(process.cwd(), '.local/catalog/ux-perf-u3-20261022/candidate-equivalence-latest.json');
      fs.mkdirSync(path.dirname(latestPointerPath), { recursive: true });
      fs.writeFileSync(latestPointerPath, `${JSON.stringify({
        attemptId,
        runId,
        canonicalPath: OUT_PATH,
        complete: true,
        exitCode: 0,
        at: payload.at,
      }, null, 2)}\n`);
    }
    expect({ differenceGroups: mismatches.length, mismatches: mismatches.slice(0, 20) }).toEqual({ differenceGroups: 0, mismatches: [] });
  }, 1_800_000);
});
