'use client';

import Link from 'next/link';
import styles from './inventory.module.css';
import { StatusPill } from './display';
import {
  buildCatalogItemHref,
  buildInventoryMappingHref,
  detailTotalsDisplay,
  domesticReviewLabel,
  formatQuantity,
  formatQuantityOr,
  itemRowStatusDisplay,
  marketScopeLabel,
  scopedWarningsDisplay,
  timestampOr,
  warehouseRowLastKnownText,
  warehouseRowQuantitySummary,
  warehouseRowStatusDisplay,
  warehouseRowTitleDisplay,
  type InventoryQueryState,
  type Tone,
} from '../model';
import type {
  InventoryDomesticRowDto,
  InventoryItemDetailDto,
  InventoryItemWarehouseDto,
  InventoryWarehouseRowDto,
} from '../types';
import type { InventoryDetailTarget } from './detail-context';

function RowFacts({ row, query }: { row: InventoryWarehouseRowDto; query: InventoryQueryState }) {
  const title = warehouseRowTitleDisplay(row);
  const status = warehouseRowStatusDisplay(row);
  const quantity = warehouseRowQuantitySummary(row);
  const lastKnown = warehouseRowLastKnownText(row);
  const isDomestic = row.source === 'domestic';
  const needsMapping = !isDomestic
    && (row.status === 'unmapped' || row.status === 'pending_adoption' || row.status === 'inactive');
  const mappingStatusLabel = row.mappingStatus === 'confirmed'
    ? '对应已确认'
    : row.mappingStatus === 'recheck'
      ? '对应待重核'
      : row.mappingStatus === 'disabled'
        ? '对应已停用'
        : row.itemId ? '已关联商品' : '未建立对应';
  return (
    <div data-testid="inventory-row-facts">
      <p className={styles.detailLead}>
        {title.subtitle}
        <span className={styles.detailSub}>
          {row.warehouseName}
          {row.market ? ` · 市场 ${row.market}` : isDomestic ? '' : ' · 市场待确认'}
        </span>
      </p>
      <div className={styles.detailStatusLine}>
        <StatusPill tone={status.tone}>{status.label}</StatusPill>
        <span>{mappingStatusLabel}</span>
      </div>
      <dl className={styles.factGrid}>
        <div><dt>实物库存</dt><dd>{quantity.primary}</dd></div>
        <div><dt>{isDomestic ? '可用数（原表）' : '可售库存'}</dt><dd>{quantity.secondary ?? '—'}</dd></div>
        <div><dt>{isDomestic ? '运营云仓可用（原文）' : '订单锁定'}</dt><dd>{isDomestic ? (row.cloudAvailableText ?? '—') : formatQuantityOr(row.orderLocked, '—')}</dd></div>
        <div><dt>{isDomestic ? '文件日期' : '活动预留'}</dt><dd>{isDomestic ? (row.fileDate ?? '见原表') : formatQuantityOr(row.activityReserved, '—')}</dd></div>
        <div><dt>{isDomestic ? '原表行号' : '来源在途'}</dt><dd>{isDomestic ? (row.excelRow ?? '—') : formatQuantityOr(row.inTransit, '—')}</dd></div>
        <div><dt>数据时间</dt><dd>{isDomestic ? '原表未注明观测时间' : timestampOr(row.observationAt, '尚无成功观测')}</dd></div>
      </dl>
      {lastKnown ? <p className={styles.detailNote} data-testid="inventory-row-last-known">{lastKnown}</p> : null}
      {row.note ? <p className={styles.detailNote}>{row.note}</p> : null}
      {isDomestic ? (
        <p className={styles.detailNote}>
          国内冻结表格快照：保留原编码与原数量，原表未注明仓库、单位与观测时间；不并入海外合计，也不提供 BigSeller 绑定操作。
        </p>
      ) : (
        <details className={styles.detailMore}>
          <summary>来源批次与文件（按需展开）</summary>
          <dl className={styles.factGrid}>
            <div><dt>来源</dt><dd>BigSeller 自动读取</dd></div>
            <div><dt>原始数量文本</dt><dd>{row.rawOnHand ?? '来源未提供'}</dd></div>
            <div><dt>批次</dt><dd>{row.batchId ?? '—'}</dd></div>
            <div><dt>原表行号</dt><dd>{row.excelRow ?? '—'}</dd></div>
            <div><dt>69 编码</dt><dd>{row.gtin ?? '—'}</dd></div>
            <div><dt>商品资料版本</dt><dd>{row.itemRevision ?? '—'}</dd></div>
          </dl>
        </details>
      )}
      <div className={styles.detailActions}>
        {row.itemId ? (
          <Link className={styles.secondaryButton} href={buildCatalogItemHref(row.itemId, row.iceCode)} data-testid="inventory-detail-catalog-link">
            商品资料
          </Link>
        ) : null}
        {needsMapping ? (
          <Link
            className={styles.primaryButton}
            href={buildInventoryMappingHref(query, { itemId: row.itemId, warehouseId: row.warehouseId, externalSku: row.externalSku })}
            data-testid="inventory-detail-mapping-link"
          >
            处理对应
          </Link>
        ) : null}
      </div>
    </div>
  );
}

function DetailItemRow({ row }: { row: InventoryItemWarehouseDto }) {
  const display = itemRowStatusDisplay(row);
  const seenOldValue = row.status === 'unseen' && row.lastKnownQty !== null && row.lastKnownQty !== undefined;
  return (
    <tr data-testid="inventory-detail-item-row" data-status={row.status}>
      <td>
        {row.warehouseName}
        <span className={styles.rowSub}>{row.market ? `市场 ${row.market}` : '市场待确认'}</span>
      </td>
      <td>{row.externalSku}</td>
      <td className={styles.numCell}>
        {seenOldValue
          ? <span className={styles.quantityUnknown}>旧值 {formatQuantity(row.lastKnownQty)}</span>
          : formatQuantityOr(row.onHand, '—')}
      </td>
      <td className={styles.numCell}>{formatQuantityOr(row.warehouseAvailable, '—')}</td>
      <td>
        <StatusPill tone={display.tone as Tone}>{display.label}</StatusPill>
        {display.note ? <span className={styles.rowSub}>{display.note}</span> : null}
      </td>
      <td>{timestampOr(row.observedAt, '未记录')}</td>
    </tr>
  );
}

/**
 * 当前商品实际适用的短警告（不恢复说明墙）：
 * - 同仓多来源编码：给出仓与编码，并说明未并入确定合计（016 合计本就不含这些行）；
 * - 其余服务端 scopedWarnings（本次未见、失败旧值、待采用等）原样展示。
 */
function productWarnings(detail: InventoryItemDetailDto): string[] {
  const groups = new Map<string, { name: string; skus: string[] }>();
  for (const row of detail.warehouses ?? []) {
    if (row.status !== 'current') continue;
    const group = groups.get(row.warehouseId) ?? { name: row.warehouseName, skus: [] };
    if (!group.skus.includes(row.externalSku)) group.skus.push(row.externalSku);
    groups.set(row.warehouseId, group);
  }
  const derived: string[] = [];
  for (const group of groups.values()) {
    if (group.skus.length > 1) {
      derived.push(`${group.name}：${group.skus.join('、')} 各自保留，合计待核对（该仓未并入确定合计）。`);
    }
  }
  const server = scopedWarningsDisplay(detail.scopedWarnings)
    .filter((warning) => !(derived.length > 0 && warning.includes('多个来源编码')));
  return [...derived, ...server].slice(0, 5);
}

/** 国内冻结记录：只展示该商品国内原数量/编码/文件日期；不与海外相加，也不提供 BS 对应动作。 */
function DomesticRecords({ rows }: { rows: InventoryDomesticRowDto[] }) {
  if (rows.length === 0) {
    return (
      <p className={styles.detailNote} data-testid="inventory-detail-domestic-empty">
        该商品没有国内冻结记录（不显示 0，也不并入海外合计）。
      </p>
    );
  }
  const dates = [...new Set(rows.map((row) => row.fileDate).filter(Boolean))].sort();
  return (
    <div data-testid="inventory-detail-domestic">
      <p className={styles.detailNote}>
        国内表格快照（只读冻结）· 文件 {dates.join(' / ') || '日期见原表'} · {rows.length} 条记录；与海外分开计时、不相加。
      </p>
      <div className={styles.detailTableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>来源编码</th>
              <th>原表名称</th>
              <th className={styles.numericHead}>实际库存数</th>
              <th className={styles.numericHead}>可用数</th>
              <th>文件日期</th>
              <th>原表状态 / 说明</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.legacyCandidateId} data-testid="inventory-detail-domestic-row">
                <td>{row.externalSku}</td>
                <td className={styles.wrapCell}>{row.sourceName ?? row.itemNameCn ?? '原表未注明'}</td>
                <td className={styles.numCell}>
                  {formatQuantityOr(row.actualQty, row.rawActualText ? `原文「${row.rawActualText}」` : '原表为空')}
                  {row.quantityState !== 'ok' ? (
                    <span className={styles.rowSub}>
                      {row.quantityState === 'missing' ? '原表未注明数量' : row.quantityState === 'invalid' ? '原表不是整数' : '同商品多条记录冲突'}
                    </span>
                  ) : null}
                </td>
                <td className={styles.numCell}>{formatQuantityOr(row.availableQty, '—')}</td>
                <td>{row.fileDate || '见原表'}</td>
                <td className={styles.wrapCell}>
                  {domesticReviewLabel(row.reviewState)}
                  {row.note ? <span className={styles.rowSub}>{row.note}</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ProductDetail({
  target,
  detail,
  itemError,
  query,
  domesticRows,
  includeDomestic,
}: {
  target: Extract<InventoryDetailTarget, { kind: 'product' }>;
  detail: InventoryItemDetailDto | null;
  itemError: string | null;
  query: InventoryQueryState;
  domesticRows: InventoryDomesticRowDto[];
  includeDomestic: boolean;
}) {
  const includeOverseas = query.source !== 'domestic';
  const totals = detail ? detailTotalsDisplay(detail) : null;
  const warnings = detail && includeOverseas ? productWarnings(detail) : [];
  const scopeText = includeOverseas
    ? [
      query.market !== 'all' ? marketScopeLabel(query.market) : null,
      query.warehouse !== 'all' ? '已选仓库' : '全部参与仓',
    ].filter(Boolean).join(' · ')
    : '国内表格快照';
  return (
    <div data-testid="inventory-item-detail">
      <p className={styles.detailLead}>
        {target.sublabel ?? ''}
        <span className={styles.detailSub}>{scopeText}</span>
      </p>
      {itemError ? (
        <p className={styles.inlineError} data-testid="inventory-detail-error">
          读取该商品库存失败：{itemError}。这不等于没有库存，可关闭后重试。
        </p>
      ) : null}

      {includeOverseas ? (
        <>
          {warnings.length > 0 ? (
            <ul className={styles.noteList} data-testid="inventory-detail-warnings">
              {warnings.map((warning) => <li key={warning}>{warning}</li>)}
            </ul>
          ) : null}
          {totals ? (
            <div className={styles.detailTotals}>
              <span>{totals.label}：<strong>{totals.subtotalText}</strong></span>
              <span>{totals.coverageText}</span>
              <span>{totals.unitGroupsText}</span>
              {totals.gapText !== '缺口：无' ? <span className={styles.gapText}>{totals.gapText}</span> : null}
            </div>
          ) : !itemError ? (
            <p className={styles.detailLoading} data-testid="inventory-detail-loading">
              正在读取该商品在当前筛选范围的各仓库存…
            </p>
          ) : null}
          {detail ? (
            <>
              <h3 className={styles.subTitle}>海外（BigSeller）各仓</h3>
              <div className={styles.detailTableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>仓库</th>
                      <th>来源 SKU</th>
                      <th className={styles.numericHead}>实物</th>
                      <th className={styles.numericHead}>可售</th>
                      <th>状态</th>
                      <th>来源时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(detail.warehouses ?? []).map((row) => (
                      <DetailItemRow key={`${row.warehouseId}-${row.externalSku}-${row.status}`} row={row} />
                    ))}
                    {(detail.warehouses ?? []).length === 0 ? (
                      <tr>
                        <td colSpan={6} className={styles.wrapCell}>当前范围没有该商品的来源行；不显示为 0。</td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
              {(detail.history ?? []).length > 0 ? (
                <details className={styles.detailMore} data-testid="inventory-detail-history">
                  <summary>最近批次历史（{(detail.history ?? []).length} 条）</summary>
                  <ul className={styles.detailHistory}>
                    {(detail.history ?? []).slice(0, 12).map((entry, index) => (
                      <li key={`${entry.batchId}-${entry.externalSku}-${index}`}>
                        {timestampOr(entry.observationAt ?? entry.publishedAt, '时间未记录')} · {entry.warehouseName} · {entry.externalSku}
                        {' · 实物 '}{formatQuantityOr(entry.onHand, '—')}
                        {entry.unit ? ` ${entry.unit}` : ''}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}

      {includeDomestic ? (
        <>
          <h3 className={styles.subTitle}>国内（聚水潭表格快照）</h3>
          <DomesticRecords rows={domesticRows} />
        </>
      ) : null}

      <div className={styles.detailActions}>
        {includeOverseas ? (
          <Link
            className={styles.primaryButton}
            href={buildInventoryMappingHref(query, {
              itemId: target.itemId,
              warehouseId: query.warehouse !== 'all' ? query.warehouse : null,
              externalSku: '',
            })}
            data-testid="inventory-detail-mapping-link"
          >
            维护来源对应
          </Link>
        ) : null}
        <Link className={styles.secondaryButton} href={buildCatalogItemHref(target.itemId, target.sublabel)} data-testid="inventory-detail-catalog-link">
          商品资料
        </Link>
      </div>
    </div>
  );
}

/** 唯一的库存详情层：右侧抽屉 + 遮罩；关闭、Esc、浏览器后退都回原列表位置。 */
export function InventoryDetailPanel({
  target,
  query,
  itemDetail,
  itemError,
  domesticRows,
  domesticIncluded,
  onClose,
}: {
  target: InventoryDetailTarget | null;
  query: InventoryQueryState;
  itemDetail: InventoryItemDetailDto | null;
  itemError: string | null;
  domesticRows: InventoryDomesticRowDto[];
  /** 列表有效范围是否包含国内（与列/计数同一判断）。 */
  domesticIncluded: boolean;
  onClose: () => void;
}) {
  if (!target) return null;
  const row = target.kind === 'row' ? target.row : null;
  const productLabel = target.kind === 'product' ? target.label : null;
  const productSublabel = target.kind === 'product' ? target.sublabel : null;
  const domesticItem = domesticRows[0];
  const title = row
    ? warehouseRowTitleDisplay(row).title
    : (itemDetail?.item.nameCn ?? productLabel ?? domesticItem?.itemNameCn ?? domesticItem?.iceCode ?? '商品详情');
  const subtitle = row
    ? `${row.warehouseName} · 来源 SKU ${row.externalSku}`
    : [
      productSublabel ?? itemDetail?.item.iceCode ?? domesticItem?.iceCode ?? '未编号',
      query.source === 'domestic' ? '国内表格快照' : '各仓库存',
    ].filter(Boolean).join(' · ');
  return (
    <div className={styles.detailBackdrop} role="presentation" onClick={onClose} data-testid="inventory-detail-backdrop">
      <aside
        className={styles.detailDrawer}
        role="dialog"
        aria-modal="true"
        aria-label={`${title} 库存详情`}
        onClick={(event) => event.stopPropagation()}
        data-testid="inventory-detail-dialog"
        data-kind={target.kind}
      >
        <header className={styles.detailDrawerHead}>
          <div>
            <h2>{title}</h2>
            <p>{subtitle}</p>
          </div>
          <button type="button" className={styles.detailClose} onClick={onClose} data-testid="inventory-detail-close">
            关闭
          </button>
        </header>
        <div className={styles.detailDrawerBody}>
          {row
            ? <RowFacts row={row} query={query} />
            : (
              <ProductDetail
                target={target as Extract<InventoryDetailTarget, { kind: 'product' }>}
                detail={itemDetail}
                itemError={itemError}
                query={query}
                domesticRows={domesticRows}
                includeDomestic={domesticIncluded}
              />
            )}
        </div>
        <footer className={styles.detailDrawerFoot}>
          <span>关闭后回到原行/页码/筛选位置（Esc 同效）</span>
        </footer>
      </aside>
    </div>
  );
}
