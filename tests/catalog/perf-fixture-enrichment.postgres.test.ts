import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  basisDocumentSha256,
  buildCatalogDisplayOverview,
} from '@/features/catalog/local-display/service';
import { formatEstimatedValueCell, formatInventoryCell } from '@/features/catalog/local-display/list-row-display';
import { toCatalogListClientPayload } from '@/features/catalog/local-display/list-client-types';
import { buildCandidates, buildDifferences } from '@/features/catalog/candidate-service';
import { catalogRepository } from '@/features/catalog/repository';
import { withReadOnlyAppDb } from '@/lib/database/app-db';

const ADMIN = '11111111-1111-4111-8111-111111111101';
const FIXTURE_PATH = path.join(process.cwd(), '.local/catalog/ux-perf-u3-20261022/perf-sample-fixture.json');
const PAGE_SIZE = 20;
const identity = { profileUserId: ADMIN };

describe('perf fixture enrichment (read-only)', () => {
  it('augments perf-sample-fixture.json with list pages and WM0043 partition expectations', async () => {
    expect(fs.existsSync(FIXTURE_PATH)).toBe(true);
    const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
    const items: Array<{ iceCode: string; itemId: string }> = fixture.items ?? [];
    expect(items.length).toBeGreaterThanOrEqual(20);

    const overview = await withReadOnlyAppDb(identity, async () => (
      buildCatalogDisplayOverview(identity, { amountAllowed: true })
    ));
    expect(overview).not.toBeNull();
    const basisSha = await basisDocumentSha256();
    const clientPayload = toCatalogListClientPayload(overview!);
    const displayRows = clientPayload.rows.map((row) => {
      const valueLabel = formatEstimatedValueCell(row, 'all');
      const inventoryLabel = formatInventoryCell(row, 'all');
      const valuationMissing = !valueLabel.startsWith('¥');
      return {
        iceCode: row.iceCode ?? '',
        inventory: inventoryLabel,
        value: valuationMissing ? undefined : valueLabel,
        valuationMissing,
        valuationLabel: valueLabel,
      };
    }).filter((r) => r.iceCode);

    const totalPages = Math.ceil(displayRows.length / PAGE_SIZE);
    const listPages = [1, 2].filter((p) => p <= totalPages).map((page) => ({
      page,
      pageLabel: `第 ${page} / ${totalPages} 页`,
      rows: displayRows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    }));

    const wm = items.find((x) => x.iceCode === 'WM0043');
    expect(wm).toBeTruthy();
    const partition = await withReadOnlyAppDb(identity, async (client) => {
      const listed = await catalogRepository.listOnClient(client, identity, { baselinePublishedOnly: true });
      const wmItem = listed.find((row) => row.iceCode === 'WM0043');
      if (!wmItem) throw new Error('WM0043 missing from catalog list');
      const observations = await catalogRepository.observationsForItemOnClient(client, identity, wmItem);
      const candidates = {
        bigseller: buildCandidates(wmItem, observations, 'bigseller'),
        jushuitan: buildCandidates(wmItem, observations, 'jushuitan'),
      };
      const differences = buildDifferences(wmItem, observations);
      const related = new Set([
        ...candidates.bigseller,
        ...candidates.jushuitan,
      ].map((c) => c.observationId));
      const auditObservations = observations.filter((o) => related.has(o.observationId) || o.sourceSystem === 'feishu');
      const { rows: historyRows } = await client.query(
        `SELECT revision FROM catalog.item_revision WHERE item_id = $1 ORDER BY revision DESC`,
        [wmItem.itemId],
      );
      return {
        candidateIds: [
          ...candidates.bigseller,
          ...candidates.jushuitan,
        ].map((c) => c.observationId).sort(),
        historyRevisions: historyRows.map((row: { revision: number }) => row.revision),
        auditProjection: {
          differenceCount: differences.length,
          observationCount: auditObservations.length,
          differenceFields: [...new Set(differences.map((d) => d.field))].sort(),
          observationIds: auditObservations.map((o) => o.observationId).sort(),
        },
      };
    });
    const { candidateIds, historyRevisions, auditProjection } = partition;

    const enrichedItems = (fixture.items as Array<Record<string, unknown>>).map((item) => {
      if (item.iceCode !== 'WM0043') {
        return { ...item, basisDocumentSha256: basisSha };
      }
      return {
        ...item,
        basisDocumentSha256: basisSha,
        partitionExpect: {
          candidates: { observationIds: candidateIds, empty: candidateIds.length === 0 },
          history: { revisions: historyRevisions },
          auditJson: auditProjection,
        },
      };
    });

    const payload = {
      ...fixture,
      basisDocumentSha256: basisSha,
      basisDocumentPath: 'docs/catalog/local-sample-valuation-basis-20261021.json',
      listPages,
      items: enrichedItems,
      enrichedAt: new Date().toISOString(),
      enrichment: 'perf-fixture-enrichment.postgres.test.ts',
    };
    fs.writeFileSync(FIXTURE_PATH, `${JSON.stringify(payload, null, 2)}\n`);
    const sha256 = createHash('sha256').update(fs.readFileSync(FIXTURE_PATH)).digest('hex');
    expect(payload.listPages.length).toBeGreaterThanOrEqual(1);
    expect(payload.listPages[0]?.rows.length).toBe(PAGE_SIZE);
    expect(candidateIds.length).toBeGreaterThan(0);
    expect(historyRevisions.length).toBeGreaterThan(0);
    console.log(JSON.stringify({ ok: true, fixturePath: FIXTURE_PATH, sha256, wm0043Candidates: candidateIds.length }, null, 2));
  }, 120_000);
});
