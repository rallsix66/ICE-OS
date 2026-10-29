'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import {
  buildInventoryListHref,
  buildInventoryRowDetailHref,
  isUuid,
  type InventoryQueryState,
} from '../model';
import type { InventoryDomesticRowDto, InventoryItemDetailDto, InventoryWarehouseRowDto, SourceBindingDto } from '../types';
import type { InventoryDetailTarget } from './detail-context';
import { InventoryDetailContext } from './detail-context';
import { InventoryDetailPanel } from './inventory-detail-panel';

function initialTargetOf(
  query: InventoryQueryState,
  detailRow: InventoryWarehouseRowDto | null,
  itemDetail: InventoryItemDetailDto | null,
): InventoryDetailTarget | null {
  if (detailRow) return { kind: 'row', row: detailRow };
  if (isUuid(query.item)) {
    return {
      kind: 'product',
      itemId: query.item,
      label: itemDetail?.item.nameCn ?? null,
      sublabel: itemDetail?.item.iceCode ?? null,
    };
  }
  return null;
}

/**
 * 库存唯一详情入口的客户端外壳：
 * - 点击行/商品即打开右侧可见详情层（无需滚到主表下方）；
 * - URL 记录 item/row，刷新与直接打开可还原；Esc/关闭/浏览器后退回到原列表；
 * - 仓库行直接用行内事实渲染；商品汇总行按标准商品读取当前范围各仓库存（由页面按 URL 读取后下发）。
 */
export function InventoryDetailLayer({
  query,
  detailRow,
  itemDetail,
  itemError,
  domesticRows,
  domesticIncluded,
  sourceBinding,
  sourceBindingError,
  bindingReady,
  viewer,
  pendingLocked,
  children,
}: {
  query: InventoryQueryState;
  detailRow: InventoryWarehouseRowDto | null;
  itemDetail: InventoryItemDetailDto | null;
  itemError: string | null;
  /** 当前商品的国内冻结记录（仅国内/全部来源时由页面传入；仅海外为空）。 */
  domesticRows: InventoryDomesticRowDto[];
  /** 列表有效范围是否包含国内（与列/计数同一判断；失败仓/明确仓市场下钻不带国内）。 */
  domesticIncluded: boolean;
  /** 当前打开仓库行的固定来源绑定（服务端读取；用于详情内直接绑定/更换商品）。 */
  sourceBinding: SourceBindingDto | null;
  sourceBindingError: string | null;
  /** 服务端已针对当前行尝试读取绑定（false = 页面读取尚未返回）。 */
  bindingReady: boolean;
  /** 当前会话身份（绑定写入登记与本地恢复记录归属校验用）。 */
  viewer: { actorId: string; accountId: string | null } | null;
  /** 服务端存在未完成原请求时禁止发起新写。 */
  pendingLocked: boolean;
  children: ReactNode;
}) {
  const router = useRouter();
  const [target, setTarget] = useState<InventoryDetailTarget | null>(() => initialTargetOf(query, detailRow, itemDetail));
  const targetRef = useRef(target);
  const pushedRef = useRef(false);
  useEffect(() => { targetRef.current = target; }, [target]);

  const listHref = useMemo(
    () => buildInventoryListHref({
      q: query.q,
      warehouse: query.warehouse,
      market: query.market,
      view: query.view,
      source: query.source,
      focus: query.focus,
      page: query.page,
    }),
    [query.q, query.warehouse, query.market, query.view, query.source, query.focus, query.page],
  );

  const close = useCallback(() => {
    if (!targetRef.current) return;
    targetRef.current = null;
    setTarget(null);
    if (pushedRef.current) {
      pushedRef.current = false;
      router.back();
    } else {
      router.replace(listHref, { scroll: false });
    }
  }, [router, listHref]);

  const openRow = useCallback((row: InventoryWarehouseRowDto) => {
    pushedRef.current = true;
    const next: InventoryDetailTarget = { kind: 'row', row };
    targetRef.current = next;
    setTarget(next);
    router.push(buildInventoryRowDetailHref(query, { rowKey: row.rowKey, itemId: row.itemId }), { scroll: false });
  }, [router, query]);

  const openProduct = useCallback((next: { itemId: string; label: string | null; sublabel: string | null }) => {
    pushedRef.current = true;
    const value: InventoryDetailTarget = { kind: 'product', ...next };
    targetRef.current = value;
    setTarget(value);
    router.push(buildInventoryRowDetailHref(query, { rowKey: '', itemId: next.itemId }), { scroll: false });
  }, [router, query]);

  const api = useMemo(() => ({ openRow, openProduct }), [openRow, openProduct]);

  // 浏览器后退/前进：URL 不再带 item/row 时关闭弹层（页面仍在原列表）。
  useEffect(() => {
    const onPopState = () => {
      const params = new URLSearchParams(window.location.search);
      if (!params.get('item') && !params.get('row')) {
        targetRef.current = null;
        setTarget(null);
        pushedRef.current = false;
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // Esc 关闭 + 打开时锁背景滚动。
  useEffect(() => {
    if (!target) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.documentElement.style.overflow = previousOverflow;
    };
  }, [target, close]);

  return (
    <InventoryDetailContext.Provider value={api}>
      {children}
      <InventoryDetailPanel
        target={target}
        query={query}
        itemDetail={itemDetail}
        itemError={itemError}
        domesticRows={domesticRows}
        domesticIncluded={domesticIncluded}
        sourceBinding={sourceBinding}
        sourceBindingError={sourceBindingError}
        bindingReady={bindingReady}
        viewer={viewer}
        pendingLocked={pendingLocked}
        onClose={close}
      />
    </InventoryDetailContext.Provider>
  );
}
