import Link from 'next/link';
import type { ProductSourcePanelDto } from '../product-source/panel-types';
import { ProductSourcePanel, ProductSourcePanelFallback } from './product-source-panel';
import pageStyles from './catalog-content.module.css';
import styles from './product-source-panel.module.css';

/**
 * 「数据同步」页的飞书商品资料来源入口（日常使用入口）。
 *
 * - 摘要只读展示服务端 DTO：已读取 / 已读取待应用 / 已采用 / 下次计划 / 待核对；
 * - 「已读取」只表示生成了待应用快照，「已采用」只表示真正写入了商品资料，两者不混用；
 * - 读取、预览、采用仍复用现有 ProductSourcePanel 与既有 server actions，不新建第二套写动作；
 * - 摘要与面板之间的锚点让「数据同步 → 商品来源 → 预览/结果」一步可达。
 */
export function FeishuProductSourceSection({
  dto,
  fallbackReason,
}: {
  dto: ProductSourcePanelDto | null;
  fallbackReason: 'forbidden' | 'read_failed';
}) {
  if (!dto) {
    return (
      <div id="product-source" data-testid="sync-product-source-section">
        <ProductSourcePanelFallback reason={fallbackReason} />
      </div>
    );
  }

  const openIssueCount = dto.issues.length;
  const readFailed = dto.read.lastResultLabel === '读取失败' || Boolean(dto.schedule?.errorLabel);
  let statusLabel = '未读取';
  let statusClass = '';
  if (readFailed) {
    statusLabel = '读取失败';
    statusClass = styles.badgeDanger;
  } else if (dto.read.pendingAtDisplay) {
    statusLabel = '已读取待采用';
    statusClass = pageStyles.badgeWarn;
  } else if (dto.applied) {
    statusLabel = '已采用';
    statusClass = styles.badgePositive;
  } else if (dto.read.lastReadAtDisplay) {
    statusLabel = '已读取';
    statusClass = pageStyles.badgeIndigo;
  }

  return (
    <section className={styles.syncCard} id="product-source" data-testid="sync-product-source-section" aria-label="飞书商品资料">
      <header className={styles.syncHead}>
        <div>
          <h2 className={styles.syncTitle}>飞书商品资料</h2>
          <p className={styles.syncNote}>
            来源：{dto.source.displayName} · 工作表 {dto.source.sheetName}；只读飞书，不写回原表。
          </p>
        </div>
        <span className={`${pageStyles.badge} ${statusClass}`} data-testid="sync-product-source-status">
          {statusLabel}
        </span>
      </header>

      <dl className={styles.syncFacts}>
        <div data-testid="sync-product-source-read">
          <dt>已读取</dt>
          <dd>
            {dto.read.lastReadAtDisplay ?? '还没有读取记录'}
            {dto.read.lastResultLabel ? ` · ${dto.read.lastResultLabel}` : ''}
          </dd>
        </div>
        <div data-testid="sync-product-source-pending">
          <dt>已读取待应用</dt>
          <dd>{dto.read.pendingAtDisplay ? `1 批（${dto.read.pendingAtDisplay}）` : '没有待应用的新快照'}</dd>
        </div>
        <div data-testid="sync-product-source-applied">
          <dt>已采用</dt>
          <dd>
            {dto.applied
              ? `${dto.applied.capturedAtDisplay} · ${dto.applied.statusLabel} · ${dto.applied.countsSummary}`
              : '还没有采用任何来源批次'}
          </dd>
        </div>
        <div data-testid="sync-product-source-next">
          <dt>下次计划</dt>
          <dd>{dto.schedule?.nextRunAtDisplay ?? (dto.schedule ? '暂无执行计划' : '定时读取未运行')}</dd>
        </div>
        <div data-testid="sync-product-source-issues">
          <dt>待核对</dt>
          <dd>
            <Link href="/dashboard/catalog/issues" className={styles.syncLink}>
              {openIssueCount} 项
            </Link>
          </dd>
        </div>
      </dl>

      <div className={styles.syncActions}>
        <a className={styles.syncLink} href="#product-source-panel" data-testid="sync-product-source-enter">
          读取 / 预览 / 采用
        </a>
        <Link className={styles.syncLink} href="/dashboard/catalog/issues" data-testid="sync-product-source-open-issues">
          查看待处理
        </Link>
      </div>

      <div id="product-source-panel" className={styles.syncPanelMount}>
        <ProductSourcePanel dto={dto} />
      </div>
    </section>
  );
}
