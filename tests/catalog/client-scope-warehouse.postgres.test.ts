import { describe, expect, it } from 'vitest';
import { buildCatalogDisplayOverview } from '@/features/catalog/local-display/service';
import { coverageForWarehouseFilter } from '@/features/catalog/local-display/client-scope';
import { seedDisplayForTests } from './local-preview-seed-helper';

const identity = { profileUserId: '11111111-1111-4111-8111-111111111101' };

function findWarehouse(options: string[], hint: string) {
  const hit = options.find((w) => w.includes(hint));
  if (!hit) throw new Error(`warehouse not found for hint ${hint}: ${options.join(', ')}`);
  return hit;
}

describe('warehouse scoped price coverage', () => {
  it('counts priced items only for rows with confirmed BS lines in that warehouse', async () => {
    await seedDisplayForTests();
    const overview = await buildCatalogDisplayOverview(identity, { amountAllowed: true });
    expect(overview).not.toBeNull();
    expect(overview!.coverage.pricedItemCount).toBe(124);
    expect(overview!.coverage.valuedItemCount).toBe(116);

    const wh = overview!.warehouseOptions;
    const expected: Array<{ hint: string; priced: number; lines: number }> = [
      { hint: 'DEE-龙仔厝', priced: 102, lines: 102 },
      { hint: 'PH-彩妆', priced: 2, lines: 2 },
      { hint: '印尼-DEE', priced: 101, lines: 101 },
      { hint: '喜运达MY', priced: 33, lines: 34 },
      { hint: '菲律宾-新创', priced: 106, lines: 108 },
      { hint: '越南', priced: 83, lines: 83 },
    ];
    for (const row of expected) {
      const warehouse = findWarehouse(wh, row.hint);
      const cov = coverageForWarehouseFilter(overview!, warehouse);
      expect(cov.pricedItemCount, warehouse).toBe(row.priced);
      expect(cov.bsConfirmedLines, warehouse).toBe(row.lines);
    }

    const allAgain = coverageForWarehouseFilter(overview!, 'all');
    expect(allAgain.pricedItemCount).toBe(124);
    expect(allAgain.valuedItemCount).toBe(116);
  }, 600_000);
});
