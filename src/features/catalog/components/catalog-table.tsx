'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Pagination } from '@/components/ui/pagination';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { getCatalogOverview } from '../service';
import { applyWarehouseScopeToDisplayRow, coverageForWarehouseFilter } from '../local-display/client-scope';
import type { CatalogDisplayRow } from '../local-display/display-types';

type Overview = Awaited<ReturnType<typeof getCatalogOverview>>;

function inventoryCell(row: CatalogDisplayRow) {
  const sample = row.bsSample;
  if (sample.valuationState === 'no_warehouse_line') return '本仓无对应';
  if (sample.confirmedOnHandTotal !== null) return sample.confirmedOnHandTotal;
  if (sample.valuationReason?.includes('尚未建档')) return '未建档';
  return '—';
}

export function CatalogTable({ overview }: { overview: Overview }) {
  const [search, setSearch] = useState('');
  const [warehouse, setWarehouse] = useState<string>('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const display = overview.display;
  const coverage = useMemo(() => (display ? coverageForWarehouseFilter(display, warehouse) : null), [display, warehouse]);
  const rows = display?.rows ?? overview.items.map((item) => ({
    item,
    specificationText: item.specification.state === 'observed' && item.specification.meaning === 'value' ? item.specification.raw : '—',
    adoptedUnitCost: null,
    bsSample: { exportLabel: null, confirmedOnHandTotal: null, confirmedLineCount: 0, warehouseOnHand: {}, warehouseScopes: {}, estimatedValueCny: null, valuationState: 'not_applicable' as const, valuationReason: null },
    materialStatus: '资料已承接',
  }));
  const viewRows = useMemo(() => {
    if (!display || warehouse === 'all') return rows;
    return rows.map((row) => applyWarehouseScopeToDisplayRow(row, warehouse));
  }, [rows, warehouse, display]);
  const filtered = useMemo(() => viewRows.filter((row) => {
    const hay = `${row.item.nameCn} ${row.item.iceCode ?? ''} ${row.specificationText}`.toLowerCase();
    return hay.includes(search.toLowerCase());
  }), [viewRows, search]);
  const exportLabel = display?.exportLabel ?? null;
  const displayBanner = overview.displayStatus === 'loaded' && display;
  return <div className="space-y-4">
    <div className="flex flex-wrap gap-3 items-center text-sm">
      <Link className="underline" href="/dashboard/catalog/intake">持续新品资料工作区</Link>
      <Link className="underline" href="/dashboard/catalog/admin">管理与审计入口</Link>
      <Link className="underline" href="/dashboard/catalog/sources">来源核实</Link>
    </div>
    {overview.displayStatus === 'forbidden' && <p className="text-sm text-red-800" role="alert">BS 样表库存投影读取被拒绝（权限不足）。这不是「尚未导入」。</p>}
    {overview.displayStatus === 'read_failed' && <p className="text-sm text-red-800" role="alert">{overview.displayError ?? 'BS 样表库存投影读取失败'}</p>}
    {displayBanner ? <section className="rounded-lg border p-4 space-y-2 text-sm" data-testid="catalog-display-banner">
      <p><strong>{exportLabel ?? 'BS 样表'}</strong> · 已确认 BS 库存行 {coverage!.bsConfirmedLines} · 未选择 {coverage!.bsUnselectedLines}{warehouse !== 'all' ? ` · 仓库 ${warehouse}` : ''}</p>
      <p className="text-gray-600">本地估算：历史样表现有库存 × 当前采用人民币单品进货价（不含运费、不含税）。不是 2026-10-15 当时货值或实时资产。</p>
      <p>{warehouse !== 'all' ? '本仓统计 · ' : ''}有数值进货价 {coverage!.pricedItemCount} 份 · 可估值 {coverage!.valuedItemCount} 份 · 缺价：{coverage!.missingPriceIceCodes.join('、') || '无'}</p>
      <label className="inline-flex items-center gap-2">仓库筛选（详情页按仓展示）
        <select className="border rounded px-2 py-1" value={warehouse} onChange={(e) => { setWarehouse(e.target.value); setPage(1); }}>
          <option value="all">全部</option>
          {display!.warehouseOptions.map((wh) => <option key={wh} value={wh}>{wh}</option>)}
        </select>
      </label>
    </section> : overview.displayStatus === 'not_imported' ? <p className="text-sm text-amber-800">尚未载入 BS 样表库存投影；请使用本地预览实例或管理入口完成基线发布与样表导入。</p> : null}
    <p data-testid="catalog-counts">默认展示 {overview.stats.items} 份真实主资料（不含测试建档 C127 流程产物）</p>
    <label className="block max-w-md text-sm">搜索名称、ICE货号或规格<Input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} /></label>
    <Table>
      <TableHeader><TableRow>
        <TableHead>名称</TableHead><TableHead>ICE货号</TableHead><TableHead>规格</TableHead><TableHead>进货价(CNY)</TableHead>
        <TableHead>BS样表现有库存</TableHead><TableHead>估算货值(CNY)</TableHead><TableHead>资料状态</TableHead>
      </TableRow></TableHeader>
      <TableBody>{filtered.slice((page - 1) * pageSize, page * pageSize).map((row) => <TableRow key={row.item.itemId} data-testid={row.item.iceCode ? `catalog-row-${row.item.iceCode}` : undefined}>
        <TableCell><Link className="underline" href={`/dashboard/catalog/${row.item.itemId}${warehouse !== 'all' ? `?warehouse=${encodeURIComponent(warehouse)}` : ''}`}>{row.item.nameCn}</Link></TableCell>
        <TableCell>{row.item.iceCode ?? '待补货号'}</TableCell>
        <TableCell>{row.specificationText || '—'}</TableCell>
        <TableCell>{row.adoptedUnitCost?.state === 'priced' ? row.adoptedUnitCost.amountCny : row.adoptedUnitCost ? '缺价' : '—'}</TableCell>
        <TableCell>{inventoryCell(row)}</TableCell>
        <TableCell>{row.bsSample.estimatedValueCny ?? (row.bsSample.valuationState === 'no_warehouse_line' ? '—' : row.bsSample.valuationState === 'no_price' ? '缺价' : '—')}</TableCell>
        <TableCell><Badge variant="outline">{row.materialStatus}</Badge></TableCell>
      </TableRow>)}</TableBody>
    </Table>
    {!filtered.length && <p>当前范围暂无资料。</p>}
    <Pagination total={filtered.length} page={page} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={(s) => { setPageSize(s); setPage(1); }} />
  </div>;
}
