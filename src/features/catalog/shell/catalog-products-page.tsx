'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { Package, Search } from 'lucide-react';
import demoStyles from '@/ui/ice-v4/ice-v4.module.css';
import { EmptyState, Pill, SectionHeading } from '@/ui/ice-v4/primitives';
import type { CatalogListClientPayload, CatalogListClientRow } from '../local-display/list-client-types';
import { clientRowAsDisplayRow } from '../local-display/list-client-types';
import { applyWarehouseScopeToDisplayRow, coverageForWarehouseFilter } from '../local-display/client-scope';
import type { AdoptedUnitCost } from '../local-display/adopted-price';
import { formatEstimatedValueCell, formatInventoryCell } from '../local-display/list-row-display';
import type { useCatalogUrlState } from './use-catalog-url-state';

function moneyFromAdopted(adopted: AdoptedUnitCost | null): string {
  if (!adopted || adopted.state !== 'priced') return adopted ? '成本待补充' : '—';
  return `¥${adopted.amountCny}`;
}

type DisplayAvailability = 'not_imported' | 'read_failed' | 'forbidden' | undefined;

function statusPill(row: CatalogListClientRow) {
  if (row.materialStatus.includes('待补货号')) return <Pill tone="amber">新品，待补货号</Pill>;
  if (row.materialStatus.includes('尚未建档')) return <Pill tone="amber">BS尚未建档</Pill>;
  return <Pill tone="green">资料已承接</Pill>;
}

function fieldOrPending(value: string | null | undefined, pendingLabel = '待补') {
  const trimmed = value?.trim();
  return trimmed ? trimmed : pendingLabel;
}

type UrlApi = ReturnType<typeof useCatalogUrlState>;

export function CatalogProductsPage({
  payload,
  displayStatus,
  displayError,
  itemCount,
  auxiliaryErrors,
  url,
}: {
  payload: CatalogListClientPayload | null;
  displayStatus: 'loaded' | 'not_imported' | 'read_failed' | 'forbidden';
  displayError: string | null;
  itemCount: number;
  auxiliaryErrors: string[];
  url: UrlApi;
}) {
  const { q: query, warehouse, page, setQuery, setWarehouse, setPage, resetFilters, openDetail } = url;
  const pageSize = 20;

  const displayOverview = useMemo(() => {
    if (!payload) return null;
    return {
      ...payload,
      rows: payload.rows.map((r) => clientRowAsDisplayRow(r)),
    };
  }, [payload]);

  const viewRows = useMemo(() => {
    const rows = payload?.rows ?? [];
    if (!displayOverview || warehouse === 'all') return rows;
    return rows.map((row) => {
      const scoped = applyWarehouseScopeToDisplayRow(clientRowAsDisplayRow(row), warehouse);
      return {
        ...row,
        bsSample: {
          ...row.bsSample,
          confirmedOnHandTotal: scoped.bsSample.confirmedOnHandTotal,
          confirmedLineCount: scoped.bsSample.confirmedLineCount,
          estimatedValueCny: scoped.bsSample.estimatedValueCny,
          valuationState: scoped.bsSample.valuationState,
          valuationReason: scoped.bsSample.valuationReason,
        },
      };
    });
  }, [payload, warehouse, displayOverview]);

  const filtered = useMemo(() => viewRows.filter((row) => {
    const tokens = row.sourceSearchTokens?.join(' ') ?? '';
    const hay = `${row.nameCn} ${row.iceCode ?? ''} ${row.specificationText} ${row.englishName ?? ''} ${row.barcodeText ?? ''} ${tokens}`.toLowerCase();
    return hay.includes(query.toLowerCase());
  }), [viewRows, query]);

  const pageRows = filtered.slice((page - 1) * pageSize, page * pageSize);
  const coverage = displayOverview && payload ? coverageForWarehouseFilter(displayOverview, warehouse) : null;
  const exportLabel = payload?.exportLabel ?? null;
  const projectionUnavailable: DisplayAvailability = displayStatus === 'loaded' ? undefined : displayStatus;

  return (
    <>
      <div className={demoStyles.filters} style={{ marginBottom: 16 }}>
        <label className={demoStyles.searchInput}>
          <Search size={16} />
          <input aria-label="搜索货号、中英文名、69编码或已确认来源SKU" placeholder="货号 / 名称 / 69编码 / 来源SKU" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        {payload && (
          <select aria-label="仓库筛选" value={warehouse} onChange={(e) => setWarehouse(e.target.value)}>
            <option value="all">全部仓库</option>
            {payload.warehouseOptions.map((wh) => <option key={wh} value={wh}>{wh}</option>)}
          </select>
        )}
        <button type="button" className={demoStyles.secondaryButton} onClick={() => resetFilters()}>清空</button>
        <Link className={demoStyles.textLink} href="/dashboard/catalog/intake">持续新品资料</Link>
      </div>

      {auxiliaryErrors.map((msg) => <p key={msg} className={demoStyles.notice} role="status">{msg}</p>)}
      {displayStatus === 'forbidden' && <p className={demoStyles.notice} role="alert">BS 样表库存投影读取被拒绝（权限不足）。</p>}
      {displayStatus === 'read_failed' && <p className={demoStyles.notice} role="alert">{displayError ?? 'BS 样表库存投影读取失败'}</p>}

      {displayStatus === 'loaded' && payload && coverage && (
        <section className={demoStyles.panel} data-testid="catalog-display-banner" style={{ marginBottom: 16 }}>
          <p><strong>{exportLabel ?? 'BS 样表'}</strong> · 已确认 BS 库存行 {coverage.bsConfirmedLines} · 未选择 {coverage.bsUnselectedLines}{warehouse !== 'all' ? ` · 仓库 ${warehouse}` : ''}</p>
          <p className={demoStyles.subtle}>本地估算：样表现有库存 × 采用人民币单品进货价（不含运费、不含税）。</p>
          <p>{warehouse !== 'all' ? '本仓统计 · ' : ''}有数值进货价 {coverage.pricedItemCount} 份 · 可估值 {coverage.valuedItemCount} 份 · 缺价：{coverage.missingPriceIceCodes.join('、') || '无'}</p>
        </section>
      )}
      {displayStatus === 'not_imported' && <p className={demoStyles.subtle}>尚未载入 BS 样表库存投影。</p>}

      <p data-testid="catalog-counts" className={demoStyles.subtle} style={{ marginBottom: 12 }}>默认展示 {itemCount} 份真实主资料（不含测试建档 C127 流程产物）</p>

      <section className={demoStyles.panel}>
        <SectionHeading title={`商品资料 · ${filtered.length} 款`} action={<span className={demoStyles.subtle}>每行一款商品，点击查看完整身份与来源</span>} />
        {filtered.length === 0 ? (
          <EmptyState onReset={() => resetFilters()} />
        ) : (
          <div className={demoStyles.tableScroll}>
            <table className={demoStyles.table}>
              <thead>
                <tr>
                  <th>商品 / 公司货号</th>
                  <th>69编码</th>
                  <th>中文名称 / 英文名称</th>
                  <th>规格 / 单位 / 分类</th>
                  <th>来源对应关系</th>
                  <th>单位参考成本</th>
                  <th>BS样表库存</th>
                  <th>估算货值（人民币）</th>
                  <th>状态</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {pageRows.map((row) => {
                  const shareHref = `/dashboard/catalog/${row.itemId}${warehouse !== 'all' ? `?warehouse=${encodeURIComponent(warehouse)}` : ''}`;
                  const english = fieldOrPending(row.englishName);
                  const category = fieldOrPending(row.categoryText);
                  const barcode = fieldOrPending(row.barcodeText);
                  const unit = fieldOrPending(row.unitText, '—');
                  const choices = row.humanChoices.bigseller + row.humanChoices.jushuitan;
                  const unitCostLabel = moneyFromAdopted(row.adoptedUnitCost);
                  const inventoryLabel = formatInventoryCell(row, warehouse, projectionUnavailable);
                  const estimatedLabel = formatEstimatedValueCell(row, warehouse, projectionUnavailable);
                  return (
                    <tr key={row.itemId} data-testid={row.iceCode ? `catalog-row-${row.iceCode}` : undefined}>
                      <td>
                        <button type="button" className={demoStyles.productName} style={{ border: 'none', background: 'transparent', textAlign: 'left', width: '100%', cursor: 'pointer' }} onClick={() => openDetail(row.itemId)}>
                          <span className={demoStyles.productArt} aria-hidden><Package size={20} strokeWidth={1.3} /></span>
                          <span><strong>{row.nameCn}</strong><small>{fieldOrPending(row.iceCode, '待补货号')} <span className={demoStyles.faint}>/ {row.specificationText || '—'}</span></small></span>
                        </button>
                      </td>
                      <td className={demoStyles.codeCell}>{barcode}</td>
                      <td><span>{row.nameCn}</span><small className={demoStyles.cellSub}>{english}</small></td>
                      <td>{row.specificationText || '—'} / {unit}<small className={demoStyles.cellSub}>{category}</small></td>
                      <td>{choices} 条本批已确认<small className={demoStyles.cellSub}>正式长期关系未启用</small></td>
                      <td data-testid="catalog-unit-cost">{unitCostLabel}</td>
                      <td data-testid="catalog-bs-inventory">{inventoryLabel}</td>
                      <td data-testid="catalog-estimated-value">{estimatedLabel}</td>
                      <td>{statusPill(row)}</td>
                      <td>
                        <button type="button" className={demoStyles.smallButton} onClick={() => openDetail(row.itemId)}>查看详情</button>
                        <Link href={shareHref} className={demoStyles.textLink} style={{ marginLeft: 8 }} target="_blank" rel="noreferrer">新标签</Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {filtered.length > pageSize && (
          <div className={demoStyles.buttonRow}>
            <button type="button" className={demoStyles.secondaryButton} disabled={page <= 1} aria-label="上一页" onClick={() => setPage(page - 1)}>上一页</button>
            <span className={demoStyles.subtle} aria-live="polite">第 {page} / {Math.ceil(filtered.length / pageSize)} 页</span>
            <button type="button" className={demoStyles.secondaryButton} disabled={page >= Math.ceil(filtered.length / pageSize)} aria-label="下一页" onClick={() => setPage(page + 1)}>下一页</button>
          </div>
        )}
        <p className={demoStyles.tableFootnote}>商品资料为统一身份档案；缺失字段显示待补，不用演示数据填充。审计与技术说明见「管理与审计」或详情展开区。</p>
      </section>
    </>
  );
}
