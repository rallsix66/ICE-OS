'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { PendingEntry } from '@/ui/ice-v4/pending-entry';
import type { CatalogPendingPreview } from '../issues/service';
import type { CatalogPendingItem } from '../issues/types';
import { CatalogPendingCards } from './catalog-pending-cards';
import styles from './catalog-pending-entry.module.css';

/**
 * ICE 商品库顶部「待处理」：与其余主页面同一按钮；点击打开整页居中弹窗。
 *
 * 数据与经营总览、商品库徽标、完整待处理页**同一份**（CatalogPendingPreview.items，
 * 已排除仅在商品详情查看的刷子历史），因此四处数字一致。
 * 卡片与动作见 catalog-pending-cards.tsx（整页待处理界面复用同一套）。
 *
 * 每次操作使用 crypto.randomUUID() 生成 requestId 并在重试时复用同一 requestId（幂等）；
 * 成功后就地显示结果一句、把该条从清单移除、徽标数量同步 -1、router.refresh 刷新服务端数据，
 * 焦点移动到下一款；最后一项处理完时成功提示与「待处理已清空」同时可见。
 */

export function CatalogPendingEntry({
  preview,
  retrying,
  onRetry,
  autoOpen = false,
}: {
  preview: CatalogPendingPreview | null;
  retrying: boolean;
  onRetry: () => void;
  /** /dashboard/catalog?pending=open 时自动打开一次（经营总览直达）；不新增历史记录。 */
  autoOpen?: boolean;
}) {
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const autoOpenedRef = useRef(false);
  /** 已在本机确认成功的条目：服务端 refresh 前先从清单移除，保证数量与行数一致。 */
  const [resolvedKeys, setResolvedKeys] = useState<string[]>([]);
  const [resultText, setResultText] = useState('');

  const ok = preview !== null && preview.state === 'ok';
  const resolved = new Set(resolvedKeys);
  const items = ok ? preview.items.filter((item) => !resolved.has(item.key)) : [];
  const count = ok ? items.length : null;

  useEffect(() => {
    if (!autoOpen || autoOpenedRef.current) return;
    if (!ok || preview.issueCount === 0) return;
    autoOpenedRef.current = true;
    const frame = requestAnimationFrame(() => {
      containerRef.current
        ?.querySelector<HTMLButtonElement>('button[data-testid="catalog-pending-open"]')
        ?.click();
    });
    return () => cancelAnimationFrame(frame);
  }, [autoOpen, ok, preview]);

  /** 确认成功后把焦点移到下一款（同一位置的下一条，已是最后一条则停在最后一条）。 */
  const focusNextCard = useCallback((removedIndex: number) => {
    requestAnimationFrame(() => {
      const dialog = document.querySelector<HTMLElement>('[data-testid="catalog-pending-open-panel"]');
      if (!dialog) return;
      const cards = dialog.querySelectorAll<HTMLElement>('[data-testid="catalog-pending-card"]');
      if (cards.length === 0) return;
      const target = cards[Math.min(removedIndex, cards.length - 1)];
      const firstControl = target?.querySelector<HTMLElement>('button:not([disabled]), a[href]');
      (firstControl ?? target)?.focus({ preventScroll: true });
    });
  }, []);

  const handleResolved = useCallback((item: CatalogPendingItem, index: number, message: string) => {
    setResultText(message);
    setResolvedKeys((previous) => (previous.includes(item.key) ? previous : [...previous, item.key]));
    focusNextCard(index);
    router.refresh();
  }, [focusNextCard, router]);

  return (
    <div ref={containerRef}>
      <PendingEntry
        count={count}
        state={ok ? 'ok' : 'failed'}
        onRetry={ok ? undefined : onRetry}
        retrying={retrying}
        testId="catalog-pending-open"
        panelTitle="商品库待处理"
        panelHint={count !== null ? `${count} 项 · 逐条确认后立即生效` : undefined}
        emptyText="本次处理已完成"
        renderPanelWhenEmpty
        panel={({ close }) => (
          <div className={styles.panelBody}>
            <p className={styles.intro}>
              共 {count ?? 0} 项；每条确认后立即保存，并从本清单与顶部数量中移除。
              飞书商品资料的两条刷子历史只在对应商品详情查看，不计入这里。
            </p>
            {resultText ? (
              <p className={styles.result} role="status" data-testid="catalog-pending-result">{resultText}</p>
            ) : null}
            {items.length > 0 ? (
              <CatalogPendingCards
                items={items}
                onResolved={handleResolved}
                onNavigate={close}
              />
            ) : (
              <p className={styles.empty} data-testid="catalog-pending-cleared">
                待处理已清空
              </p>
            )}
            <div className={styles.footer}>
              <Link
                href="/dashboard/catalog/issues"
                onClick={close}
                className={styles.footerLink}
                data-testid="catalog-pending-open-issues"
              >
                打开完整待处理页
              </Link>
            </div>
          </div>
        )}
      />
    </div>
  );
}
