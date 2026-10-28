import Link from 'next/link';
import styles from './inventory.module.css';
import {
  buildInventoryListHref,
  inventoryPageNumbers,
  inventoryPageRange,
  type InventoryQueryState,
} from '../model';

/**
 * 表格固定底栏分页：总数 + 页码直达 + 上一/下一页 + 跳页。
 * 翻页保留当前搜索/来源/仓库/市场，不重新引入第二套分页机制。
 */
export function InventoryPagination({
  query,
  total,
  limit,
  page,
}: {
  query: InventoryQueryState;
  total: number;
  limit: number;
  page: number;
}) {
  const range = inventoryPageRange(total, limit, page);
  const hrefFor = (next: number) => buildInventoryListHref({
    q: query.q,
    warehouse: query.warehouse,
    market: query.market,
    view: query.view,
    source: query.source,
    focus: query.focus,
    page: next,
  });
  const pages = inventoryPageNumbers(range.page, range.pageCount);

  return (
    <div className={styles.tableFooter} data-testid="inventory-pagination">
      <span className={styles.pageSummary}>
        第 {range.from}–{range.to} 条，共 {range.total} 条 · 第 {range.page}/{range.pageCount} 页
      </span>
      <nav className={styles.pageLinks} aria-label="分页">
        {range.hasPrev ? (
          <Link className={styles.pageLink} href={hrefFor(range.page - 1)} data-testid="inventory-page-prev">上一页</Link>
        ) : <span className={styles.pageLinkDisabled} aria-disabled="true">上一页</span>}
        {pages.map((value, index) => value === 'gap' ? (
          <span key={`gap-${index}`} className={styles.pageGap}>…</span>
        ) : value === range.page ? (
          <span key={value} className={styles.pageLinkCurrent} aria-current="page" data-testid={`inventory-page-current`}>{value}</span>
        ) : (
          <Link key={value} className={styles.pageLink} href={hrefFor(value)} data-testid={`inventory-page-link-${value}`}>{value}</Link>
        ))}
        {range.hasNext ? (
          <Link className={styles.pageLink} href={hrefFor(range.page + 1)} data-testid="inventory-page-next">下一页</Link>
        ) : <span className={styles.pageLinkDisabled} aria-disabled="true">下一页</span>}
      </nav>
      <form className={styles.pageJump} method="get" action="/dashboard/inventory" data-testid="inventory-page-jump-form">
        {query.q ? <input type="hidden" name="q" value={query.q} /> : null}
        {query.warehouse !== 'all' ? <input type="hidden" name="warehouse" value={query.warehouse} /> : null}
        {query.market !== 'all' ? <input type="hidden" name="market" value={query.market} /> : null}
        {query.view === 'product' ? <input type="hidden" name="view" value="product" /> : null}
        {query.source !== 'all' ? <input type="hidden" name="source" value={query.source} /> : null}
        <label>
          <span className={styles.srOnly}>跳转到页码</span>
          <input
            type="number"
            name="page"
            min={1}
            max={range.pageCount}
            defaultValue={range.page}
            inputMode="numeric"
            data-testid="inventory-page-jump"
            aria-label="跳转到页码"
          />
        </label>
        <button type="submit" className={styles.pageJumpButton} data-testid="inventory-page-jump-button">跳转</button>
      </form>
    </div>
  );
}
