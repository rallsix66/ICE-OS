import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  detailTotalsDisplay,
  listCoverageDisplay,
  quantityHeaderDisplay,
} from '@/features/inventory/model';
import {
  normalizeItemDetail,
  normalizeList,
  normalizeMappingQueue,
  normalizeOverview,
  normalizeRunDetail,
} from '@/features/inventory/normalize';

/**
 * 用修复实例真实 app 读 RPC 返回（`tests/inventory/fixtures/inventory-real-shape.json`，
 * 采集自 run-20261026T013000Z-b4d7f2e1，已裁剪）做归一化回归：
 * - overview：warehouses 是账号全部仓库、scope 单独计数、marketOptions 只来自参与范围；
 * - list：LS101295 已知合计 1028；候选/未见商品 hasCurrentData=false 不显示 0；
 * - detail：016 的“每仓 rows[]”展开为逐仓×SKU 行，totals/mapping/history 保留；
 * - run：扁平身份、文件校验对象表头、逐仓 invalidRows/duplicateSkuRows；
 * - queue：候选 ∪ run 对，字段可驱动手动确认。
 * 证据原始 JSON 在 `.local/inventory-sync-repair-20261026/web-probe/`（不入库提交范围外）。
 */

const fixturePath = path.join(process.cwd(), 'tests/inventory/fixtures/inventory-real-shape.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as {
  overview: unknown;
  list: { items: Array<Record<string, unknown>>; total: number };
  detail: unknown;
  detailAll: unknown;
  run: unknown;
  queue: unknown;
};

describe('真实 016 读取 JSON → 页面 DTO', () => {
  it('overview：账号全部仓库 + scope 单独 + marketOptions 只来自参与范围', () => {
    const overview = normalizeOverview(fixture.overview);
    const rawScopeIds = (fixture.overview as { scope: { warehouseIds: string[] } }).scope.warehouseIds;
    expect(overview.warehouses.length).toBeGreaterThanOrEqual(rawScopeIds.length);
    expect(overview.scope.warehouseIds).toEqual(rawScopeIds);
    expect(overview.settings.scopeWarehouseCount).toBe(rawScopeIds.length);
    expect(overview.marketOptions.length).toBeGreaterThan(0);
    expect(overview.marketOptions.every((option) => option.warehouseNames.length > 0)).toBe(true);
    const excluded = overview.warehouses.filter((warehouse) => warehouse.status === 'excluded').map((warehouse) => warehouse.name);
    for (const option of overview.marketOptions) {
      for (const name of option.warehouseNames) expect(excluded).not.toContain(name);
    }
  });

  it('list：LS101295 已知合计 1028；候选/未见商品不显示 0', () => {
    const list = normalizeList(fixture.list);
    const sample = list.items.find((item) => item.iceCode === 'LS101295');
    expect(sample).toBeTruthy();
    expect(sample!.knownSubtotal).toBe(1028);
    expect(sample!.unitGroups[0].knownSubtotal).toBe(1028);
    expect(listCoverageDisplay(sample!).subtotalText).toBe('1,028');
    expect(sample!.mapped).toBe(true);

    const noData = list.items.filter((item) => item.hasCurrentData === false);
    expect(noData.length).toBeGreaterThan(0);
    const coverage = listCoverageDisplay(noData[0]);
    expect(coverage.subtotalText).toMatch(/尚无当前库存|未对应/);
    expect(coverage.gapText).toContain('不显示为 0');
  });

  it('detail：逐仓×SKU 展开、合计/映射/历史存在', () => {
    const raw = fixture.detail as {
      warehouses: Array<{ rows?: unknown[] }>;
      item: { iceCode: string };
      scope: { allWarehouses: boolean };
    };
    const detail = normalizeItemDetail(raw);
    const expectedRows = raw.warehouses.reduce((sum, warehouse) => sum + (warehouse.rows?.length ?? 1), 0);
    expect(detail.item.iceCode).toBe(raw.item.iceCode);
    expect(detail.warehouses).toHaveLength(expectedRows);
    expect(detail.scopeMode).toBe(raw.scope.allWarehouses ? 'all' : 'filtered');
    expect(detail.totals.byUnit.length).toBeGreaterThan(0);
    expect(detail.totals.knownSubtotal).toBeGreaterThan(0);
    expect(detail.mapping.length).toBeGreaterThan(0);
    expect(detail.mapping[0].warehouseExternalId).toBeTruthy();
    expect(detail.history.length).toBeGreaterThan(0);
    expect(detailTotalsDisplay(detail).subtotalText).not.toBe('0');

    const allScope = normalizeItemDetail(fixture.detailAll);
    expect(allScope.scopeMode).toBe('all');
  });

  it('run detail：扁平身份/文件校验对象表头/逐仓坏行', () => {
    const run = normalizeRunDetail(fixture.run);
    expect(run.accountIdentity?.status).toBe('verified');
    expect(run.warehouses?.length).toBeGreaterThan(0);
    for (const warehouse of run.warehouses ?? []) {
      expect(typeof warehouse.invalidRows).toBe('number');
      expect(typeof warehouse.duplicateSkuRows).toBe('number');
    }
    if (run.fileValidation) {
      expect(quantityHeaderDisplay(run.fileValidation.quantityHeader)).toMatch(/现有库存|未标注/);
    }
  });

  it('mapping queue：候选 ∪ run 对，字段可驱动手动确认', () => {
    const queue = normalizeMappingQueue(fixture.queue);
    expect(queue.items.length).toBeGreaterThan(0);
    for (const item of queue.items) {
      expect(item.externalSku).toBeTruthy();
      expect(typeof item.warehouseName).toBe('string');
    }
    const candidateOnly = queue.items.find((item) => item.candidateStatus === 'pending' && item.rowCount === 0);
    if (candidateOnly) {
      expect(candidateOnly.latestRunAt).toBeNull();
      expect(candidateOnly.warehouseExternalId).toBeTruthy();
    }
  });
});
