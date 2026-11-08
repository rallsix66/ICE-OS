import Link from 'next/link';
import surface from '@/ui/ice-v4/data-surface.module.css';
import {
  buildShipmentListHref,
  shipmentPageNumbers,
  shipmentPageRange,
  type ShipmentQueryState,
} from '../model';

/**
 * 表格底栏分页：总数 + 页码直达 + 上一/下一页 + 跳页。
 * 翻页保留市场/状态/关键词/商品筛选；关闭详情后回到同一页。
 */
export function ShipmentPagination({
  query,
  total,
  limit,
  page,
}: {
  query: ShipmentQueryState;
  total: number;
  limit: number;
  page: number;
}) {
  const range = shipmentPageRange(total, limit, page);
  const hrefFor = (next: number) => buildShipmentListHref({
    market: query.market,
    status: query.status,
    q: query.q,
    product: query.product,
    includeAbsent: query.includeAbsent,
    page: next,
    limit,
  });
  const pages = shipmentPageNumbers(range.page, range.pageCount);

  return (
    <div className={surface.pager} data-testid="shipment-pagination">
      <span className={surface.pagerInfo}>
        第 {range.from}–{range.to} 票，共 {range.total} 票 · 第 {range.page}/{range.pageCount} 页
      </span>
      <nav className={surface.pagerNav} aria-label="分页">
        {range.hasPrev ? (
          <Link className={surface.pageBtn} href={hrefFor(range.page - 1)} data-testid="shipment-page-prev">上一页</Link>
        ) : (
          <span className={`${surface.pageBtn} ${surface.pageBtnDisabled}`} aria-disabled="true">上一页</span>
        )}
        {pages.map((value, index) => value === 'gap' ? (
          <span key={`gap-${index}`} className={surface.pageGap}>…</span>
        ) : value === range.page ? (
          <span
            key={value}
            className={`${surface.pageBtn} ${surface.pageBtnCurrent}`}
            aria-current="page"
            data-testid="shipment-page-current"
          >
            {value}
          </span>
        ) : (
          <Link key={value} className={surface.pageBtn} href={hrefFor(value)} data-testid={`shipment-page-link-${value}`}>
            {value}
          </Link>
        ))}
        {range.hasNext ? (
          <Link className={surface.pageBtn} href={hrefFor(range.page + 1)} data-testid="shipment-page-next">下一页</Link>
        ) : (
          <span className={`${surface.pageBtn} ${surface.pageBtnDisabled}`} aria-disabled="true">下一页</span>
        )}
      </nav>
      <form className={surface.pagerJump} method="get" action="/dashboard/in-transit" data-testid="shipment-page-jump-form">
        {query.market !== 'all' ? <input type="hidden" name="market" value={query.market} /> : null}
        {query.status !== 'all' ? <input type="hidden" name="status" value={query.status} /> : null}
        {query.q ? <input type="hidden" name="q" value={query.q} /> : null}
        {query.product ? <input type="hidden" name="product" value={query.product} /> : null}
        {query.includeAbsent ? <input type="hidden" name="absent" value="1" /> : null}
        {limit !== 50 ? <input type="hidden" name="limit" value={String(limit)} /> : null}
        <label>
          <span className={surface.srOnly}>跳转到页码</span>
          <input
            className={surface.pagerJumpInput}
            type="number"
            name="page"
            min={1}
            max={range.pageCount}
            defaultValue={range.page}
            inputMode="numeric"
            data-testid="shipment-page-jump"
            aria-label="跳转到页码"
          />
        </label>
        <button type="submit" className={surface.pagerJumpButton} data-testid="shipment-page-jump-button">跳转</button>
      </form>
    </div>
  );
}
