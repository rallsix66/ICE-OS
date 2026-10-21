import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { adoptedUnitCostFromFinancial } from '../local-display/adopted-price';
import type { getCatalogItemBsSample } from '../service';

type BsSampleDetail = NonNullable<Awaited<ReturnType<typeof getCatalogItemBsSample>>>;

export function CatalogBsSampleErrorPanel({ message, code }: { message: string; code: 'forbidden' | 'read_failed' }) {
  return <section className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900" role="alert" data-testid="catalog-bs-sample-error">
    <h2 className="font-semibold">BS 样表库存读取失败</h2>
    <p>{message}</p>
    <p className="text-xs mt-1">{code === 'forbidden' ? '权限不足，不是「尚未导入」。' : '请检查实例 SQL 与隔离工作区估值口径文件。'}</p>
  </section>;
}

export function CatalogBsSamplePanel({ itemId, panel, warehouse }: { itemId: string; panel: Extract<BsSampleDetail, { status: 'loaded' }>; warehouse?: string }) {
  const adopted = adoptedUnitCostFromFinancial(panel.adoptedUnitCost);
  const exportLabel = typeof panel.exportLabel === 'string' ? panel.exportLabel : 'BS 样表';
  const rows = panel.rows as Array<Record<string, unknown>>;
  const filtered = warehouse ? rows.filter((r) => r.warehouse === warehouse) : rows;
  const valuation = panel.valuation;
  return <section className="rounded-lg border p-4 space-y-3" aria-label="BS样表库存" data-testid="catalog-bs-sample-panel">
    <h2 className="font-semibold">BS 样表库存（本地预览）</h2>
    <p className="text-sm text-gray-600">{exportLabel} · 人民币单品进货价（不含运费、不含税）· 在途单独列示</p>
    {warehouse && <p className="text-sm">当前仓库：<strong>{warehouse}</strong> · <Link className="underline" href={`/dashboard/catalog/${itemId}`}>查看全部仓库</Link></p>}
    <p className="text-sm">采用进货价：{adopted.state === 'priced' ? <span data-testid="bs-adopted-unit-cost">{adopted.amountCny} CNY</span> : adopted.reason ?? '缺价'}</p>
    <p className="text-sm">估算货值（{warehouse ?? '全部仓库'}）：
      {valuation.valuationState === 'valued' ? <strong data-testid="bs-estimated-value">{valuation.estimatedValueCny} CNY</strong>
        : valuation.valuationReason ?? valuation.valuationState}
    </p>
    <p className="text-xs text-gray-500" data-testid="bs-basis-sha">估值口径 SHA256：{panel.basisDocumentSha256 ?? '—'}</p>
    {!filtered.length && <p className="text-sm text-amber-800">{warehouse ? '本仓无对应 BS 样表行（不当作 0）' : '暂无样表行'}</p>}
    {filtered.length > 0 && <Table>
      <TableHeader><TableRow>
        <TableHead>仓库</TableHead><TableHead>SKU</TableHead><TableHead>选择</TableHead><TableHead>现有</TableHead>
        <TableHead>订单已锁</TableHead><TableHead>整仓可用</TableHead><TableHead>活动预留</TableHead><TableHead>在途</TableHead>
      </TableRow></TableHeader>
      <TableBody>{filtered.map((r) => <TableRow key={`${String(r.excelRow)}-${String(r.warehouse)}`}>
        <TableCell>{String(r.warehouse)}</TableCell>
        <TableCell>{String(r.sku)}</TableCell>
        <TableCell><Badge variant="outline">{String(r.selectionState)}</Badge></TableCell>
        <TableCell>{r.onHand == null ? '—' : String(r.onHand)}</TableCell>
        <TableCell>{r.orderLocked == null ? '—' : String(r.orderLocked)}</TableCell>
        <TableCell>{r.warehouseAvailable == null ? '—' : String(r.warehouseAvailable)}</TableCell>
        <TableCell>{r.activityReserved == null ? '—' : String(r.activityReserved)}</TableCell>
        <TableCell>{r.inTransit == null ? '—' : String(r.inTransit)}</TableCell>
      </TableRow>)}</TableBody>
    </Table>}
    <p className="text-xs text-gray-500">样表数量不等于实时 BS 账号状态；BS 尚未建档的商品不将缺行当作库存 0。</p>
  </section>;
}
