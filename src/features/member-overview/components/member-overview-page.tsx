import Link from 'next/link';
import { ArrowRight, Boxes, Clock3, Ship, Warehouse, ShieldAlert } from 'lucide-react';
import { EmptyState, PageHeading } from '@/ui/ice-v4/data-surface';
import { formatHomeQuantity } from '@/features/overview/model';
import { formatTimestamp } from '@/features/inventory/model';
import { marketLabel } from '@/features/access/types';
import type {
  MemberInventorySummaryDto,
  MemberShipmentSummaryDto,
} from '../types';
import type { MemberOverviewSection } from '../server/reads';
import styles from './member-overview.module.css';

function quantity(value: number | null): string {
  return value === null ? '—' : formatHomeQuantity(value);
}

function time(value: string | null): string {
  return formatTimestamp(value) || '尚无成功数据';
}

function InventorySection({
  data,
  error,
}: {
  data: MemberOverviewSection<MemberInventorySummaryDto>;
  error: string | null;
}) {
  const summary = data.data;
  return (
    <section className={styles.section} data-testid="member-inventory-section" aria-label="我的海外库存">
      <header className={styles.sectionHead}>
        <span className={styles.sectionIcon}><Boxes size={17} aria-hidden /></span>
        <div className={styles.sectionTitle}>
          <h2>海外库存</h2>
          <p>BigSeller · 仅汇总当前账号获授的仓库</p>
        </div>
        <Link className={styles.sectionLink} href="/dashboard/inventory?source=overseas">
          查看商品库存 <ArrowRight size={14} aria-hidden />
        </Link>
      </header>

      {error ? (
        <div className={styles.error} role="status">{error}</div>
      ) : summary ? (
        <>
          <div className={styles.metrics}>
            <div className={styles.metric}>
              <span>实物数量</span>
              <strong data-testid="member-inventory-onhand">{quantity(summary.onHand)}</strong>
              <small>
                {summary.contributingWarehouseCount} 个参与汇总的授权仓
                {summary.pendingProductCount > 0 ? ` · 已排除 ${summary.pendingProductCount} 款待核` : ''}
              </small>
            </div>
            <div className={styles.metric}>
              <span>可售数量</span>
              <strong data-testid="member-inventory-available">{quantity(summary.available)}</strong>
              <small>
                {summary.availableUnknownRows > 0
                  ? `${summary.availableUnknownRows} 条可售缺失未计入`
                  : '来源可售字段合计'}
                {summary.pendingProductCount > 0 ? ` · 已排除 ${summary.pendingProductCount} 款待核` : ''}
              </small>
            </div>
            <div className={styles.metric}>
              <span>数据时间</span>
              <strong className={styles.timeValue} data-testid="member-inventory-time">
                {time(summary.dataTime)}
              </strong>
              <small>实际参与汇总的 {summary.contributingWarehouseCount} 个授权仓</small>
            </div>
            {summary.canViewAmount ? (
              <div className={styles.metric}>
                <span>已知估算货值</span>
                <strong data-testid="member-inventory-value">
                  {summary.amountError ? '读取失败' : (summary.estimatedValueCny ?? '—')}
                </strong>
                <small data-testid="member-inventory-missing-cost">
                  {summary.amountError
                    ? summary.amountError
                    : summary.missingCostProducts > 0
                      ? `${summary.missingCostProducts} 款缺价未计入`
                      : '采用进货价 × 可明确计入数量'}
                  {!summary.amountError && summary.pendingProductCount > 0
                    ? ` · 已排除 ${summary.pendingProductCount} 款待核`
                    : ''}
                </small>
              </div>
            ) : null}
          </div>

          {summary.warehouses.length === 0 ? (
            <EmptyState title="暂无授权仓库" hint="当前账号还没有库存仓库范围，请联系管理员分配。" />
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table} data-testid="member-inventory-table">
                <thead>
                  <tr>
                    <th scope="col">仓库</th>
                    <th scope="col">市场</th>
                    <th scope="col" className={styles.num}>实物</th>
                    <th scope="col" className={styles.num}>可售</th>
                    <th scope="col">数据时间</th>
                    {summary.canViewAmount ? <th scope="col" className={styles.num}>估算货值</th> : null}
                    <th scope="col"><span className={styles.srOnly}>查看</span></th>
                  </tr>
                </thead>
                <tbody>
                  {summary.warehouses.map((row) => (
                    <tr key={row.warehouseId} data-testid="member-inventory-row" data-warehouse-id={row.warehouseId}>
                      <td>
                        <Link
                          className={styles.rowLink}
                          href={`/dashboard/inventory?source=overseas&view=warehouse&warehouse=${encodeURIComponent(row.warehouseId)}`}
                        >
                          {row.name}
                        </Link>
                        {row.unmappedRows > 0 ? <small className={styles.cellSub}>{row.unmappedRows} 条未对应未计入</small> : null}
                      </td>
                      <td>{row.market ? marketLabel(row.market) : <span className={styles.muted}>市场待确认</span>}</td>
                      <td className={styles.num} data-field="onHand">
                        {quantity(row.onHand)}
                        {row.pendingProductCount > 0
                          ? <small className={styles.cellSub}>已排除 {row.pendingProductCount} 款待核</small>
                          : null}
                      </td>
                      <td className={styles.num} data-field="available">
                        {quantity(row.available)}
                        {row.pendingProductCount > 0
                          ? <small className={styles.cellSub}>待核可售 {formatHomeQuantity(row.pendingAvailable)}</small>
                          : row.availableUnknownRows > 0
                            ? <small className={styles.cellSub}>{row.availableUnknownRows} 条缺失</small>
                            : null}
                      </td>
                      <td data-field="dataTime">{time(row.dataTime)}</td>
                      {summary.canViewAmount ? (
                        <td className={styles.num} data-field="value">
                          {row.estimatedValueCny ?? '—'}
                          {row.missingCostProducts > 0 ? <small className={styles.cellSub}>{row.missingCostProducts} 款缺价</small> : null}
                        </td>
                      ) : null}
                      <td>
                        <Link
                          className={styles.rowAction}
                          href={`/dashboard/inventory?source=overseas&view=warehouse&warehouse=${encodeURIComponent(row.warehouseId)}`}
                        >
                          查看 <ArrowRight size={13} aria-hidden />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {summary.pendingProductCount > 0 ? (
            <section className={styles.pendingBox} data-testid="member-inventory-pending">
              <header className={styles.pendingHead}>
                <strong>待核商品 {summary.pendingProductCount} 款（未计入首页合计）</strong>
                <span>
                  原始待核：实物 {formatHomeQuantity(summary.pendingOnHand)}
                  {' · '}可售 {formatHomeQuantity(summary.pendingAvailable)}
                </span>
              </header>
              <div className={styles.tableWrap}>
                <table className={styles.table} data-testid="member-inventory-pending-table">
                  <thead>
                    <tr>
                      <th scope="col">商品</th>
                      <th scope="col">授权仓</th>
                      <th scope="col">待核原因</th>
                      <th scope="col" className={styles.num}>待核实</th>
                      <th scope="col" className={styles.num}>待核可售</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.pendingProducts.map((product) => (
                      <tr key={product.itemId} data-testid="member-pending-product" data-item-id={product.itemId}>
                        <td>
                          <span className={styles.rowLink}>{product.iceCode ?? '缺货号'}</span>
                          <small className={styles.cellSub}>{product.nameCn ?? '未命名商品'}</small>
                        </td>
                        <td>{product.warehouseNames.join('、')}</td>
                        <td>{product.reasons.join(' · ')}</td>
                        <td className={styles.num}>{formatHomeQuantity(product.pendingOnHand)}</td>
                        <td className={styles.num}>{formatHomeQuantity(product.pendingAvailable)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}

          <p className={styles.footNote}>
            只统计商品汇总可明确计入的已采用行；待核部分已从实物、可售和货值中排除，
            同款商品在其他仓可明确计入的数量仍然保留。未对应 {summary.unmappedRows} 条不进入数量。
            {summary.canViewAmount
              ? summary.missingCostProducts > 0
                ? ` 缺价 ${summary.missingCostProducts} 款只计数量、不计金额。`
                : ''
              : ' 当前账号没有库存金额权限，不显示估算货值。'}
          </p>
        </>
      ) : null}
    </section>
  );
}

function ShipmentSection({
  data,
  error,
}: {
  data: MemberOverviewSection<MemberShipmentSummaryDto>;
  error: string | null;
}) {
  const summary = data.data;
  return (
    <section className={styles.section} data-testid="member-shipment-section" aria-label="我的物流在途">
      <header className={styles.sectionHead}>
        <span className={styles.sectionIcon}><Ship size={17} aria-hidden /></span>
        <div className={styles.sectionTitle}>
          <h2>物流在途</h2>
          <p>飞书物流情况表 · 仅当前账号获授的物流市场</p>
        </div>
        <Link className={styles.sectionLink} href="/dashboard/in-transit">
          查看物流在途 <ArrowRight size={14} aria-hidden />
        </Link>
      </header>

      {error ? (
        <div className={styles.error} role="status">{error}</div>
      ) : summary ? (
        <>
          <div className={styles.metrics}>
            <div className={styles.metric}>
              <span>当前货票</span>
              <strong data-testid="member-shipment-tickets">{formatHomeQuantity(summary.ticketCount)}</strong>
              <small>{summary.markets.length} 个授权物流市场</small>
            </div>
            <div className={styles.metric}>
              <span>已知剩余在途</span>
              <strong data-testid="member-shipment-remaining">
                {summary.ticketCount === 0 ? 0 : (summary.knownRemaining === null ? '待核' : formatHomeQuantity(summary.knownRemaining))}
              </strong>
              <small>只加数量明确的明细</small>
            </div>
            <div className={styles.metric}>
              <span>待核明细</span>
              <strong data-testid="member-shipment-pending">{formatHomeQuantity(summary.pendingItemCount)}</strong>
              <small>数量未知或人工数量冲突</small>
            </div>
            <div className={styles.metric}>
              <span>最近成功读取</span>
              <strong className={styles.timeValue} data-testid="member-shipment-time">
                {time(summary.latestReadAt)}
              </strong>
              <small>飞书物流来源</small>
            </div>
          </div>

          {summary.markets.length === 0 ? (
            <EmptyState title="暂无授权物流市场" hint="当前账号还没有物流市场范围，请联系管理员分配。" />
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table} data-testid="member-shipment-table">
                <thead>
                  <tr>
                    <th scope="col">市场</th>
                    <th scope="col" className={styles.num}>当前货票</th>
                    <th scope="col" className={styles.num}>已知剩余在途</th>
                    <th scope="col" className={styles.num}>待核明细</th>
                    <th scope="col">最近成功读取</th>
                    <th scope="col"><span className={styles.srOnly}>查看</span></th>
                  </tr>
                </thead>
                <tbody>
                  {summary.markets.map((row) => (
                    <tr key={row.market} data-testid="member-shipment-row" data-market={row.market}>
                      <td>
                        <Link className={styles.rowLink} href={`/dashboard/in-transit?market=${encodeURIComponent(row.market)}`}>
                          {row.market}
                        </Link>
                        <small className={styles.cellSub}>{row.itemCount} 条明细</small>
                      </td>
                      <td className={styles.num} data-field="tickets">{formatHomeQuantity(row.ticketCount)}</td>
                      <td className={styles.num} data-field="remaining">
                        {row.ticketCount === 0 ? 0 : (row.knownRemaining === null ? <span className={styles.pendingText}>待核</span> : formatHomeQuantity(row.knownRemaining))}
                      </td>
                      <td className={styles.num} data-field="pending">
                        {row.pendingItemCount > 0
                          ? <span className={styles.pendingText}>{formatHomeQuantity(row.pendingItemCount)}</span>
                          : 0}
                      </td>
                      <td data-field="latestReadAt">{time(row.latestReadAt)}</td>
                      <td>
                        <Link className={styles.rowAction} href={`/dashboard/in-transit?market=${encodeURIComponent(row.market)}`}>
                          查看货票 <ArrowRight size={13} aria-hidden />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className={styles.footNote}>
            数量未知或人工数量冲突的明细归入待核，不计入已知剩余在途；成员只读，不显示货值。
          </p>
        </>
      ) : null}
    </section>
  );
}

export function MemberOverviewPage({
  canViewInventory,
  canViewShipment,
  inventory,
  shipment,
  accessError = null,
}: {
  canViewInventory: boolean;
  canViewShipment: boolean;
  inventory: MemberOverviewSection<MemberInventorySummaryDto>;
  shipment: MemberOverviewSection<MemberShipmentSummaryDto>;
  accessError?: string | null;
}) {
  const hasAny = canViewInventory || canViewShipment;
  return (
    <div className={styles.page} data-testid="member-overview-page">
      <PageHeading
        title="经营总览"
        meta="只看当前账号获授的海外库存与物流在途；两边分别列数，不跨来源相加。"
      />

      {accessError ? (
        <section className={styles.error} role="status" data-testid="member-overview-access-error">
          {accessError}
        </section>
      ) : !hasAny ? (
        <section className={styles.emptyState} data-testid="member-overview-empty">
          <span className={styles.emptyIcon}><ShieldAlert size={24} aria-hidden /></span>
          <h2>暂无业务授权</h2>
          <p>当前账号还没有库存仓库或物流市场授权。请联系管理员在「权限设置 → 账号管理」中分配后再查看。</p>
        </section>
      ) : (
        <>
          {canViewInventory ? (
            <InventorySection data={inventory} error={inventory.error} />
          ) : (
            <section className={styles.notGranted} data-testid="member-inventory-not-granted">
              <Warehouse size={16} aria-hidden />
              <span>当前账号未获授库存仓库，暂不显示海外库存。</span>
            </section>
          )}
          {canViewShipment ? (
            <ShipmentSection data={shipment} error={shipment.error} />
          ) : (
            <section className={styles.notGranted} data-testid="member-shipment-not-granted">
              <Ship size={16} aria-hidden />
              <span>当前账号未获授物流市场，暂不显示物流在途。</span>
            </section>
          )}
        </>
      )}

      {hasAny && !accessError ? (
        <p className={styles.pageFoot}>
          <Clock3 size={13} aria-hidden />
          数据来自现有成员读取入口：库存按授权仓库、物流按授权市场分别收窄；板块之间不合计。
        </p>
      ) : null}
    </div>
  );
}
