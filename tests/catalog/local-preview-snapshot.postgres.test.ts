import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCatalogDisplayOverview } from '@/features/catalog/local-display/service';
import { collectWorkspaceSourceHashes } from '../../scripts/catalog/prepare.mjs';

const ADMIN = '11111111-1111-4111-8111-111111111101';
const identity = { profileUserId: ADMIN };

function canonicalProjection(overview: NonNullable<Awaited<ReturnType<typeof buildCatalogDisplayOverview>>>) {
  const rows = overview.rows
    .map((r) => ({
      iceCode: r.item.iceCode,
      itemId: r.item.itemId,
      adoptedUnitCostCny: r.adoptedUnitCost?.state === 'priced' ? r.adoptedUnitCost.amountCny : r.adoptedUnitCost?.state ?? null,
      bsConfirmedLines: r.bsSample.confirmedLineCount,
      valuationState: r.bsSample.valuationState,
      onHandTotal: r.bsSample.confirmedOnHandTotal,
    }))
    .sort((a, b) => (a.iceCode ?? '').localeCompare(b.iceCode ?? ''));
  const payload = {
    itemCount: rows.length,
    coverage: overview.coverage,
    rows,
  };
  const projectionSha256 = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  return { ...payload, projectionSha256 };
}

describe('local preview restart snapshot', () => {
  it('writes display projection when CATALOG_SNAPSHOT_OUT is set', async () => {
    const out = process.env.CATALOG_SNAPSHOT_OUT;
    if (!out) return;
    const overview = await buildCatalogDisplayOverview(identity, { amountAllowed: true });
    expect(overview).not.toBeNull();
    const body = canonicalProjection(overview!);
    const files = collectWorkspaceSourceHashes();
    const workspaceSourceSnapshotHash = createHash('sha256').update(JSON.stringify(files)).digest('hex');
    const record = {
      label: process.env.CATALOG_SNAPSHOT_LABEL ?? 'snapshot',
      capturedAt: new Date().toISOString(),
      workspaceSourceSnapshotHash,
      ...body,
    };
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
    expect(body.itemCount).toBe(126);
  }, 120_000);
});
