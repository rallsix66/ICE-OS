'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useState, useTransition } from 'react';
import type { CatalogPendingItem } from './types';
import type { CatalogPendingPreview } from './service';
import { CatalogPendingCards } from '../shell/catalog-pending-cards';
import cardStyles from '../shell/catalog-pending-entry.module.css';
import styles from './catalog-issues.module.css';

/**
 * 商品库完整待处理页（`/dashboard/catalog/issues`）：与顶部「待处理」弹窗、
 * 经营总览、商品库徽标**同一份数据与同一套卡片**（CatalogPendingPreview.items）。
 *
 * 进入方式：经营总览「查看商品资料」、弹窗底部「打开完整待处理页」、数据同步页入口。
 * 每张卡片可就地确认（同号多行选资料 / 缺货号采用飞书货号），确认后该条消失、数字刷新；
 * 最后一项处理完时，成功提示与「待处理已清空」同时可见。
 * 两条刷子历史只在对应商品详情查看，不计入本页数量。
 */
export function CatalogPendingPage({ preview }: { preview: CatalogPendingPreview }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [resolvedKeys, setResolvedKeys] = useState<string[]>([]);
  const [resultText, setResultText] = useState('');
  const retry = () => startTransition(() => router.refresh());

  const ok = preview.state === 'ok';
  const resolved = new Set(resolvedKeys);
  const items = ok ? preview.items.filter((item) => !resolved.has(item.key)) : [];
  const count = ok ? items.length : null;
  const itemCount = ok
    ? new Set(items.map((item) => item.itemId).filter((itemId): itemId is string => Boolean(itemId))).size
    : 0;

  const handleResolved = useCallback((item: CatalogPendingItem, _index: number, message: string) => {
    setResultText(message);
    setResolvedKeys((previous) => (previous.includes(item.key) ? previous : [...previous, item.key]));
    router.refresh();
  }, [router]);

  return (
    <div className={styles.page} data-testid="catalog-pending-page" data-issues-state={preview.state}>
      <header className={styles.header}>
        <div className={styles.headerMain}>
          <h1 className={styles.title}>待处理</h1>
          {ok ? (
            <p className={styles.headerCounts}>
              <span className={styles.count} data-testid="catalog-pending-page-count">
                {count} 项 / {itemCount} 款
              </span>
              {preview.brushCount > 0 ? (
                <span className={styles.unlinked} data-testid="catalog-pending-page-brush-note">
                  另有 {preview.brushCount} 条刷子历史仅在商品详情查看
                </span>
              ) : null}
            </p>
          ) : null}
        </div>
        <Link className={styles.backLink} href="/dashboard/catalog">返回商品库</Link>
      </header>

      {ok ? (
        <div className={cardStyles.panelBody} data-testid="catalog-pending-page-body">
          <p className={cardStyles.intro}>
            共 {count ?? 0} 项；每条确认后立即保存，并从本页与商品库顶部数量中移除。
            同号多行请选以后更新采用哪份资料；缺货号直接采用飞书补充的正式货号。
          </p>
          {resultText ? (
            <p className={cardStyles.result} role="status" data-testid="catalog-pending-page-result">
              {resultText}
            </p>
          ) : null}
          {items.length > 0 ? (
            <CatalogPendingCards items={items} onResolved={handleResolved} />
          ) : (
            <p className={cardStyles.empty} data-testid="catalog-pending-page-cleared">
              待处理已清空
            </p>
          )}
          <div className={cardStyles.footer}>
            <button
              type="button"
              className={styles.retryButton}
              onClick={retry}
              disabled={pending}
              data-testid="catalog-pending-page-refresh"
            >
              {pending ? '刷新中…' : '刷新清单'}
            </button>
          </div>
        </div>
      ) : (
        <section
          className={`${styles.stateCard} ${preview.state === 'read_failed' ? styles.stateCardAlert : ''}`}
          data-testid={`catalog-pending-page-${preview.state}`}
          role="alert"
        >
          <h2 className={styles.stateTitle}>
            {preview.state === 'read_failed' ? '待处理读取失败' : '无法查看待处理事项'}
          </h2>
          <p className={styles.stateText}>
            {preview.state === 'read_failed'
              ? '本次读取因网络、传输或环境异常中断；这不等于 0 项。'
              : '账号没有访问权限，或独立本地资料环境未启用。'}
          </p>
          <div className={styles.stateActions}>
            <button
              type="button"
              className={styles.retryButton}
              onClick={retry}
              disabled={pending}
              data-testid="catalog-pending-page-retry"
            >
              {pending ? '重试中…' : '重试'}
            </button>
            <Link className={styles.backLink} href="/dashboard/catalog">返回商品库</Link>
          </div>
        </section>
      )}
    </div>
  );
}
