'use client';

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { PendingEntry } from '@/ui/ice-v4/pending-entry';
import type { LocalViewerIdentity } from '../client-pending';
import { getInventoryPendingBindingCountAction } from '../server/actions';
import { PendingBindingsPanel } from './pending-bindings-panel';

/**
 * 商品库存工具栏「待处理」入口（客户端）：
 * - 页面首屏不再等服务端待绑定清单/计数（那 5 页队列读取要 ~1s），先让所选视图和数据出现；
 *   徽标数量在挂载后由 server action 异步读取（与弹窗/经营总览同一口径），失败显示「读取失败」；
 * - 完整清单在打开弹窗时才由 PendingBindingsPanel 懒加载（不阻塞视图切换）；
 * - 支持 /dashboard/inventory?pending=open 首次挂载后自动打开（经营总览直达）。
 */
export function InventoryPendingEntry({
  autoOpen,
  viewer,
  pendingLocked,
}: {
  autoOpen: boolean;
  viewer: LocalViewerIdentity | null;
  pendingLocked: boolean;
}) {
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const autoOpenedRef = useRef(false);
  const [count, setCount] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  // 保存成功后按成功条数即时下调徽标（不整页刷新，避免弹窗被卸载、丢失当场结果）。
  const [removedCount, setRemovedCount] = useState(0);
  const displayCount = count === null ? null : Math.max(0, count - removedCount);

  /** 徽标数量：首屏渲染后再读，避免把队列读取塞进视图切换的关键路径。 */
  const loadCount = useCallback(() => {
    let cancelled = false;
    void getInventoryPendingBindingCountAction()
      .then((result) => {
        if (cancelled) return;
        if (result.state === 'ok') {
          setFailed(false);
          setCount(result.count);
        } else {
          setFailed(true);
          setCount(null);
        }
      })
      .catch(() => {
        if (cancelled) return;
        setFailed(true);
        setCount(null);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const release = loadCount();
    return release;
  }, [loadCount]);

  // 只认首次挂载时的 pending=open：点击真实按钮打开弹窗后立即从地址栏移除该参数，
  // 关闭后不自动重开、刷新页面也不再重开；不改 PendingEntry（统一按钮）的既有逻辑。
  useEffect(() => {
    if (!autoOpen || autoOpenedRef.current) return;
    autoOpenedRef.current = true;
    const trigger = document.querySelector<HTMLButtonElement>('[data-testid="inventory-pending-open"]');
    if (!trigger) return;
    trigger.click();
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.has('pending')) {
        url.searchParams.delete('pending');
        window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
      }
    } catch {
      /* 地址清理失败不影响已打开的弹窗。 */
    }
  }, [autoOpen]);

  return (
    <PendingEntry
      count={failed ? null : displayCount}
      state={failed ? 'failed' : 'ok'}
      label="待处理"
      testId="inventory-pending-open"
      panelTitle="待绑定商品的海外仓记录"
      panelHint="按来源 SKU 分组；确认商品并勾选本次要绑定的仓后保存"
      panelWidth={920}
      emptyText="暂无待绑定商品的海外仓记录"
      failureText="读取失败"
      panel={({ close }) => (
        <PendingBindingsPanel
          viewer={viewer}
          pendingLocked={pendingLocked}
          onClose={close}
          onSaved={(savedRows) => setRemovedCount((value) => value + savedRows)}
        />
      )}
      onRetry={() => {
        setFailed(false);
        startRefresh(() => { loadCount(); router.refresh(); });
      }}
      retrying={refreshing}
    />
  );
}
