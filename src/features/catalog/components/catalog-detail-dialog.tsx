'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { X } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import demoStyles from '@/ui/ice-v4/ice-v4.module.css';
import { fetchCatalogDetailAttachmentsAction, fetchCatalogDetailRevisionAction, fetchCatalogDetailViewAction } from '../actions';
import type { CatalogListClientPayload, CatalogListClientRow } from '../local-display/list-client-types';
import type { useCatalogUrlState } from '../shell/use-catalog-url-state';
import { buildCatalogListPath } from '../shell/catalog-url-params';
import {
  authoritativeExpectedFromList,
  detailScopeFromView,
  expectedScopeFromListRow,
  listAuthorityMatchesLoadedScope,
  invalidateDetailCacheItem,
  markDetailCacheStale,
  normalizeDetailWarehouse,
  readDetailCache,
  resolveBackgroundDetailFetch,
  writeDetailCache,
  type CatalogDetailCacheContext,
  type CatalogDetailScope,
  type CatalogDetailView,
} from '../shell/catalog-detail-cache';
import { CatalogDetail, catalogSpecFact, warehouseLabelOf, type CatalogDetailSection } from './catalog-detail';
import { type DetailAttachmentsModel } from './detail-attachments';
import { ItemEvidencePanel, type EvidenceValuationState } from './item-evidence-panel';
import { useDialogFocusTrap } from './use-dialog-focus-trap';
import styles from './catalog-detail.module.css';

type UrlApi = ReturnType<typeof useCatalogUrlState>;
type CloseGuardRef = { current: () => void };

type LeaveIntent = 'close' | 'edit' | 'back' | 'revision' | null;

/** list-ui 在 useCatalogUrlState 上提供；未接线时（旧调用方）退化为不拦截 popstate。 */
type UrlNavigateGuardApi = {
  registerNavigationGuard?: (guard: (() => boolean) | null) => void;
};

function matchesListAuthority(
  scope: CatalogDetailScope,
  auth: NonNullable<ReturnType<typeof authoritativeExpectedFromList>>,
  listHasInventoryAuthority: boolean,
): boolean {
  if (listHasInventoryAuthority) return listAuthorityMatchesLoadedScope(scope, auth);
  return scope.itemId === auth.itemId
    && scope.warehouse === normalizeDetailWarehouse(auth.warehouse === 'all' ? undefined : auth.warehouse)
    && scope.itemRevision === auth.itemRevision
    && scope.listProjectionToken === auth.listProjectionToken
    && scope.authToken === auth.authToken
    && scope.displayBasisSha256 === auth.displayBasisSha256;
}

function CatalogDetailLoader({
  detailId,
  revision,
  revisionInvalid,
  warehouseFilter,
  listRow,
  cacheContext,
  onClose,
  closeGuardRef,
  listHref,
  warehouseOptions,
  onWarehouseChange,
  onSelectRevision,
  onBackToCurrent,
  evidenceOpen,
  fromHref,
  onEvidenceOpen,
  onEvidenceClose,
  navigateGuard,
}: {
  detailId: string;
  revision: number;
  revisionInvalid: boolean;
  warehouseFilter?: string;
  listRow?: CatalogListClientRow;
  cacheContext: CatalogDetailCacheContext;
  onClose: () => void;
  closeGuardRef: CloseGuardRef;
  listHref: string;
  warehouseOptions: string[];
  onWarehouseChange: (warehouse: string) => void;
  onSelectRevision: (revision: number) => void;
  onBackToCurrent: () => void;
  evidenceOpen: boolean;
  /** 安全内部来源页（旧直链/待处理/来源页带 from 时）：关闭回该页。 */
  fromHref?: string;
  onEvidenceOpen: () => void;
  onEvidenceClose: () => void;
  navigateGuard?: UrlNavigateGuardApi;
}) {
  const warehouseNorm = normalizeDetailWarehouse(warehouseFilter);
  const isHistorical = revision > 0 && !revisionInvalid;
  const scopeProbe = { itemId: detailId, warehouse: warehouseNorm };
  const listExpected = expectedScopeFromListRow(detailId, warehouseFilter, listRow, cacheContext);
  const initialCache = isHistorical ? null : readDetailCache(scopeProbe, cacheContext, listExpected ?? undefined);
  const [view, setView] = useState<CatalogDetailView | null>(() => initialCache?.view ?? null);
  const [loadedScope, setLoadedScope] = useState<CatalogDetailScope | null>(() => initialCache?.scope ?? null);
  const [historicalScope, setHistoricalScope] = useState<CatalogDetailScope | null>(null);
  const [contentFresh, setContentFresh] = useState(() => Boolean(initialCache));
  const [error, setError] = useState<string | null>(null);
  const [revisionAttempt, setRevisionAttempt] = useState(0);
  const [staleNotice, setStaleNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const requestSeq = useRef(0);
  const viewRef = useRef<CatalogDetailView | null>(view);
  useEffect(() => { viewRef.current = view; }, [view]);

  /* 编辑入口与未保存离开提示（F13/R4/V3-04）：关闭、收起、后退、切分区、切版本统一保护。 */
  const [editing, setEditing] = useState(false);
  /* 历史版本读取期间内容会暂时卸载；分区放在 loader 里，重挂载后仍回到用户原来所在分区。 */
  const [detailSection, setDetailSection] = useState<CatalogDetailSection>('material');
  const [dirty, setDirty] = useState(false);
  const [leaveIntent, setLeaveIntent] = useState<LeaveIntent>(null);
  const [pendingRevision, setPendingRevision] = useState<number | null>(null);
  const dirtyRef = useRef(false);
  const leaveIntentRef = useRef<LeaveIntent>(null);
  const closeRequestedRef = useRef(false);
  /** 已批准的离开/关闭：允许一次 history 回退通过导航守卫。 */
  const allowPopRef = useRef(false);
  const allowPopTimer = useRef<number | null>(null);

  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);
  useEffect(() => { leaveIntentRef.current = leaveIntent; }, [leaveIntent]);

  const approveNavigation = useCallback(() => {
    allowPopRef.current = true;
    if (allowPopTimer.current !== null) window.clearTimeout(allowPopTimer.current);
    allowPopTimer.current = window.setTimeout(() => { allowPopRef.current = false; allowPopTimer.current = null; }, 800);
  }, []);

  useEffect(() => () => {
    if (allowPopTimer.current !== null) window.clearTimeout(allowPopTimer.current);
  }, []);

  const requestClose = useCallback(() => {
    if (closeRequestedRef.current) return;
    if (leaveIntentRef.current) { setLeaveIntent(null); return; }
    if (dirtyRef.current) { setLeaveIntent('close'); return; }
    closeRequestedRef.current = true;
    approveNavigation();
    onClose();
  }, [approveNavigation, onClose]);

  useEffect(() => { closeGuardRef.current = requestClose; }, [requestClose, closeGuardRef]);

  useEffect(() => {
    if (!navigateGuard?.registerNavigationGuard) return;
    navigateGuard.registerNavigationGuard(() => {
      if (allowPopRef.current) { allowPopRef.current = false; return true; }
      if (!dirtyRef.current) return true;
      setLeaveIntent('back');
      return false;
    });
    return () => navigateGuard.registerNavigationGuard?.(null);
  }, [navigateGuard]);

  /**
   * 打开弹层时把键盘起点放在滚动体本身：滚轮/PageDown/方向键直接滚 `.detailBody`，
   * 而不是滚到弹层后面的页面。`preventScroll` 保证这是焦点落点，不是"靠自动定位把内容带出来"。
   */
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => bodyRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const requestToggleEditing = () => {
    if (editing) {
      if (dirtyRef.current) { setLeaveIntent('edit'); return; }
      setEditing(false);
      return;
    }
    if (isHistorical) { onBackToCurrent(); return; }
    setEditing(true);
  };

  /** V3-01：切换历史版本也属于离开当前编辑，必须先保护未保存草稿。 */
  const requestRevisionChange = (next: number) => {
    setPendingEvidenceRevision(null);
    if (editing && dirtyRef.current) {
      setPendingRevision(next);
      setLeaveIntent('revision');
      return;
    }
    if (editing) setEditing(false);
    onSelectRevision(next);
  };

  const abandonAndLeave = () => {
    const intent = leaveIntentRef.current;
    const nextRevision = pendingRevision;
    setLeaveIntent(null);
    setPendingRevision(null);
    setEditing(false);
    setDirty(false);
    if (intent === 'revision' && nextRevision !== null) {
      onSelectRevision(nextRevision);
      return;
    }
    if (intent === 'close' || intent === 'back') {
      closeRequestedRef.current = true;
      approveNavigation();
      onClose();
    }
  };

  const router = useRouter();
  const listAuthority = authoritativeExpectedFromList(detailId, warehouseFilter, listRow, cacheContext);
  const listHasInventoryAuthority = Boolean(
    listRow?.inventoryProjectionByWarehouse
    && Object.keys(listRow.inventoryProjectionByWarehouse).length > 0,
  );
  const scopeFresh = Boolean(
    !isHistorical
    && view
    && loadedScope
    && listAuthority
    && matchesListAuthority(loadedScope, listAuthority, listHasInventoryAuthority),
  );
  /** Server action returned success for the current in-flight request (not a stale cache pose). */
  const authoritativeDetail = Boolean(view && loadedScope && contentFresh && !error);
  const switchPending = Boolean(
    !isHistorical && authoritativeDetail && loadedScope
    && normalizeDetailWarehouse(loadedScope.warehouse === 'all' ? undefined : loadedScope.warehouse) !== warehouseNorm
    && !staleNotice,
  );
  /* 历史快照不与“当前仓库列表投影”比较：历史本来就不是当前仓数据，不能提示“正在同步列表”。 */
  const listProjectionOutOfSync = Boolean(!isHistorical && authoritativeDetail && listAuthority && !scopeFresh && !switchPending);
  /* 历史模式只展示“确实是目标 revision 的历史快照”：当前数据/上一历史版本都不能冒充。 */
  const activeView = isHistorical
    ? (view?.historical && view.item.revision === revision ? view : null)
    : (view?.historical ? null : view);
  /* 版本切换时当前/历史各用各自的 scope，避免“新版本标题配旧仓数字”。 */
  const activeScope = isHistorical ? historicalScope : loadedScope;
  const displayReady = Boolean(activeView && activeScope) && !revisionInvalid && !error && !staleNotice;
  const contentFreshForMetrics = Boolean(activeView && activeScope) && contentFresh && (isHistorical || (scopeFresh && !staleNotice));

  const applyCached = (entry: NonNullable<ReturnType<typeof readDetailCache>>) => {
    viewRef.current = entry.view;
    setView(entry.view);
    setLoadedScope(entry.scope);
    setError(null);
    setStaleNotice(null);
    setContentFresh(true);
  };

  const applySuccess = (data: CatalogDetailView, wh: string | undefined, seq: number) => {
    if (seq !== requestSeq.current) return;
    const scope = detailScopeFromView(data, wh, cacheContext);
    writeDetailCache(data, wh, cacheContext);
    viewRef.current = data;
    setView(data);
    setLoadedScope(scope);
    setError(null);
    setStaleNotice(null);
    setContentFresh(true);
    if (listRow && listRow.itemRevision !== data.item.revision) {
      router.refresh();
    }
  };

  const runFetch = (wh: string | undefined, background: boolean, seq: number) => {
    const whNorm = normalizeDetailWarehouse(wh);
    if (!background) {
      setError(null);
      setStaleNotice(null);
    }
    startTransition(async () => {
      try {
        const result = await fetchCatalogDetailViewAction(detailId, whNorm === 'all' ? undefined : whNorm);
        if (seq !== requestSeq.current) return;
        if (!result.success || !result.data) {
          const resolution = resolveBackgroundDetailFetch({
            success: false,
            error: result.error,
            cachedView: viewRef.current,
          });
          if (background) {
            markDetailCacheStaled(detailId, whNorm, resolution.kind === 'failure' && resolution.failure === 'forbidden');
            if (resolution.kind === 'failure' && resolution.retainMasked) {
              viewRef.current = resolution.retainMasked;
              setView(resolution.retainMasked);
              setLoadedScope(detailScopeFromView(resolution.retainMasked, wh, cacheContext));
              setError(resolution.error);
              setStaleNotice(null);
              setContentFresh(false);
              return;
            }
            setStaleNotice(resolution.kind === 'failure' ? resolution.error : '详情读取失败，请重试。');
            setContentFresh(false);
            return;
          }
          setView(null);
          setLoadedScope(null);
          setError(resolution.kind === 'failure' ? resolution.error : '详情读取失败，请重试。');
          setContentFresh(false);
          return;
        }
        applySuccess(result.data, wh, seq);
      } catch {
        if (seq !== requestSeq.current) return;
        const resolution = resolveBackgroundDetailFetch({
          success: false,
          error: '详情读取失败，请重试。',
          cachedView: viewRef.current,
          failureKind: 'network',
        });
        if (background) {
          markDetailCacheStaled(detailId, whNorm, false);
          setStaleNotice(resolution.kind === 'failure' ? resolution.error : '详情读取失败，请重试。');
          setContentFresh(false);
          return;
        }
        setView(null);
        setLoadedScope(null);
        setError(resolution.kind === 'failure' ? resolution.error : '详情读取失败，请重试。');
        setContentFresh(false);
      }
    });
  };

  const markDetailCacheStaled = (itemId: string, wh: string, forbidden: boolean) => {
    markDetailCacheStale(itemId, wh);
    if (forbidden) invalidateDetailCacheItem(itemId);
  };

  /* V3-03：切仓在事件处理内立即接管目标仓视图，URL 更新后的 effect 不再重复请求/重复应用。 */
  const skipNextWarehouseEffect = useRef(false);
  const switchWarehouseWithImmediateDisplay = (next: string) => {
    const nextNorm = normalizeDetailWarehouse(next);
    if (nextNorm === warehouseNorm) { onWarehouseChange(next); return; }
    const expected = expectedScopeFromListRow(detailId, next, listRow, cacheContext);
    const auth = authoritativeExpectedFromList(detailId, next, listRow, cacheContext);
    const hit = readDetailCache({ itemId: detailId, warehouse: nextNorm }, cacheContext, expected ?? undefined);
    if (hit && (!auth || matchesListAuthority(hit.scope, auth, listHasInventoryAuthority))) {
      applyCached(hit);
      skipNextWarehouseEffect.current = true;
      onWarehouseChange(next);
      return;
    }
    onWarehouseChange(next);
  };

  useEffect(() => {
    if (skipNextWarehouseEffect.current) {
      skipNextWarehouseEffect.current = false;
      return () => { requestSeq.current += 1; };
    }
    requestSeq.current += 1;
    const seq = requestSeq.current;
    if (revisionInvalid) {
      /* 非法版本：不读取任何版本，也不把上一次缓存当作该版本内容（由 displayReady 门控）。 */
      return () => { requestSeq.current += 1; };
    }
    if (isHistorical) {
      startTransition(async () => {
        setError(null);
        try {
          const result = await fetchCatalogDetailRevisionAction(detailId, revision);
          if (seq !== requestSeq.current) return;
          if (!result.success || !result.data) {
            setError(result.error ?? '资料版本读取失败，请重试。');
            return;
          }
          const historicalView = result.data as unknown as CatalogDetailView;
          viewRef.current = historicalView;
          setView(historicalView);
          setHistoricalScope(detailScopeFromView(historicalView, undefined, cacheContext));
          setError(null);
          setStaleNotice(null);
          setContentFresh(true);
        } catch {
          if (seq === requestSeq.current) setError('资料版本读取失败，请重试。');
        }
      });
      return () => { requestSeq.current += 1; };
    }

    const expected = expectedScopeFromListRow(detailId, warehouseFilter, listRow, cacheContext);
    const auth = authoritativeExpectedFromList(detailId, warehouseFilter, listRow, cacheContext);
    /* 切仓（或首次进入已有其它仓视图）时只做展示接管，不再重取整份详情。 */
    const switchingWarehouse = Boolean(
      viewRef.current && loadedScope
      && normalizeDetailWarehouse(loadedScope.warehouse === 'all' ? undefined : loadedScope.warehouse) !== warehouseNorm,
    );
    const hit = readDetailCache(scopeProbe, cacheContext, expected ?? undefined);
    /* V3-03：目标仓缓存（同主体/权限/版本/投影/口径）立即接管显示，不再等待重新读取整份详情。 */
    if (hit && (!auth || matchesListAuthority(hit.scope, auth, listHasInventoryAuthority))) {
      const cached = hit;
      queueMicrotask(() => { if (seq === requestSeq.current) applyCached(cached); });
      /* 同一 scope 的暖复开：先完成展示，再做一次后台校验（撤权/口径漂移仍能被发现），
         但校验延后到内容已呈现之后，避免把后台请求算进“内容可见”时间。 */
      const backgroundTimer = !switchingWarehouse
        ? window.setTimeout(() => {
          if (seq === requestSeq.current) runFetch(warehouseFilter, true, seq);
        }, 300)
        : null;
      return () => {
        if (backgroundTimer !== null) window.clearTimeout(backgroundTimer);
        requestSeq.current += 1;
      };
    }
    runFetch(warehouseFilter, Boolean(viewRef.current), seq);
    return () => {
      requestSeq.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch keyed by detailId + revision + warehouseNorm + cacheContext + list projection
  }, [detailId, revision, revisionAttempt, revisionInvalid, isHistorical, warehouseNorm, warehouseFilter, listRow?.itemRevision, listRow?.inventory.knownSubtotal, listRow?.inventory.hasPendingTotal, listRow?.inventoryProjectionByWarehouse, cacheContext.principalKey, cacheContext.amountAllowed, cacheContext.displayBasisSha256]);

  /* ---- 来源与证据：同一弹窗内容区子视图（授权后按需读取） ---- */
  const savedScrollRef = useRef(0);
  const evidenceTriggerRef = useRef<HTMLElement | null>(null);
  const evidenceTriggerSelectorRef = useRef<string | null>(null);
  const [pendingEvidenceRevision, setPendingEvidenceRevision] = useState<number | null>(null);
  /**
   * 从历史列表进入“数据来源”前的原上下文：版本、是否原为当前资料、滚动与触发按钮。
   * V5-04：返回“当前 r2”必须恢复 current 身份（revision=0），不能只恢复数字 2 后变成历史只读。
   */
  type EvidenceReturnContext = { revision: number; scrollTop: number; current: boolean; triggerSelector: string | null };
  const evidenceReturnRef = useRef<EvidenceReturnContext | null>(null);
  const pendingScrollRestoreRef = useRef<EvidenceReturnContext | null>(null);

  const captureEvidenceTrigger = () => {
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const revisionTrigger = active?.closest<HTMLElement>('[data-evidence-revision]') ?? null;
    evidenceTriggerSelectorRef.current = revisionTrigger
      ? `[data-evidence-revision="${revisionTrigger.getAttribute('data-evidence-revision')}"]`
      : null;
    const details = active?.closest('details') ?? null;
    /* 菜单项点开后菜单会收起，焦点应回到“更多”触发按钮（summary），而不是已隐藏的菜单项。 */
    evidenceTriggerRef.current = details
      ? (details.querySelector('summary') as HTMLElement | null) ?? active
      : active;
  };

  const openEvidenceForCurrent = () => {
    setPendingEvidenceRevision(null);
    evidenceReturnRef.current = null;
    savedScrollRef.current = bodyRef.current?.scrollTop ?? 0;
    captureEvidenceTrigger();
    onEvidenceOpen();
  };

  const openEvidenceAt = (target?: number) => {
    if (target && activeView && target !== activeView.item.revision) {
      /* 从历史列表点旧版本“数据来源”：记住原查看版本/current 身份与滚动，返回时恢复原上下文。 */
      const scrollTop = bodyRef.current?.scrollTop ?? 0;
      captureEvidenceTrigger();
      evidenceReturnRef.current = {
        revision: activeView.item.revision,
        scrollTop,
        current: !isHistorical,
        triggerSelector: evidenceTriggerSelectorRef.current,
      };
      savedScrollRef.current = scrollTop;
      setPendingEvidenceRevision(target);
      onSelectRevision(target);
      return;
    }
    openEvidenceForCurrent();
  };

  useEffect(() => {
    if (!pendingEvidenceRevision || evidenceOpen) return;
    if (activeView && activeView.item.revision === pendingEvidenceRevision) onEvidenceOpen();
  }, [pendingEvidenceRevision, evidenceOpen, activeView, onEvidenceOpen]);

  const focusEvidenceTrigger = (selector: string | null) => {
    const bySelector = selector ? document.querySelector<HTMLElement>(selector) : null;
    const trigger = bySelector ?? evidenceTriggerRef.current;
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    window.setTimeout(() => {
      const late = selector ? document.querySelector<HTMLElement>(selector) : null;
      const fallback = late ?? (trigger?.isConnected ? trigger : null);
      fallback?.focus({ preventScroll: true });
    }, 60);
    return trigger;
  };

  /* 历史跨版本来源返回：先恢复原 revision/current 身份，等目标版本真正就绪后再恢复滚动与触发焦点。 */
  useEffect(() => {
    if (evidenceOpen) return;
    const pending = pendingScrollRestoreRef.current;
    if (!pending || !activeView || activeView.item.revision !== pending.revision) return;
    if (pending.current && isHistorical) return;
    if (!pending.current && !isHistorical) return;
    pendingScrollRestoreRef.current = null;
    const frame = window.requestAnimationFrame(() => {
      if (bodyRef.current) bodyRef.current.scrollTop = pending.scrollTop;
      focusEvidenceTrigger(pending.triggerSelector);
    });
    /* 返回当前资料时变更记录可能还在重载；内容高度不足会把刚设置的位置 clamp 为 0。
       只在用户尚未滚动（仍为 0）时补一次，不覆盖用户之后主动滚动的位置。 */
    const retryScroll = pending.scrollTop > 0
      ? window.setTimeout(() => {
        const body = bodyRef.current;
        if (body && body.scrollTop === 0) body.scrollTop = pending.scrollTop;
      }, 180)
      : null;
    return () => {
      window.cancelAnimationFrame(frame);
      if (retryScroll !== null) window.clearTimeout(retryScroll);
    };
  }, [evidenceOpen, activeView, isHistorical]);

  const closeEvidence = () => {
    setPendingEvidenceRevision(null);
    const trigger = evidenceTriggerRef.current;
    const returnContext = evidenceReturnRef.current;
    evidenceReturnRef.current = null;
    /* 先把焦点交给触发按钮，再关闭子视图；弹层焦点陷阱若在卸载时接管，下一帧再夺回。 */
    trigger?.focus?.({ preventScroll: true });
    onEvidenceClose();
    if (returnContext) {
      pendingScrollRestoreRef.current = returnContext;
      /* 先让子视图关闭提交，再恢复原版本/current 身份；避免同一次批处理里版本更新被吞掉。 */
      window.setTimeout(() => {
        onSelectRevision(returnContext.current ? 0 : returnContext.revision);
        setRevisionAttempt((n) => n + 1);
      }, 0);
      return;
    }
    window.requestAnimationFrame(() => {
      if (bodyRef.current) bodyRef.current.scrollTop = savedScrollRef.current;
      focusEvidenceTrigger(evidenceTriggerSelectorRef.current);
    });
  };

  /* Esc：证据子视图优先返回原分区；否则走关闭守卫。捕获阶段拦截，避免弹层自身也处理 Esc。 */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (evidenceOpen) {
        event.preventDefault();
        event.stopPropagation();
        closeEvidence();
        return;
      }
      requestClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- closeEvidence 只读取当前 props/refs
  }, [requestClose, evidenceOpen, onEvidenceClose]);

  const loadAttachmentPanels = useCallback(async (): Promise<DetailAttachmentsModel | null> => {
    try {
      return await fetchCatalogDetailAttachmentsAction(detailId);
    } catch {
      return null;
    }
  }, [detailId]);

  const summaryTitle = listRow && !isHistorical
    ? `${listRow.iceCode ?? '待补货号'} · ${listRow.nameCn}`
    : activeView
      ? `${activeView.item.iceCode ?? '待补货号'} · ${activeView.item.nameCn}`
      : '商品详情';

  const headerWarehouse = activeScope && activeScope.warehouse !== 'all' ? activeScope.warehouse : undefined;
  const evidenceValuation: EvidenceValuationState = isHistorical
    ? { status: 'historical' }
    : activeView?.bsSampleError
      ? { status: 'read_failed', message: activeView.bsSampleError.message }
      : activeView?.bsSample?.status === 'loaded'
        ? { status: 'loaded', sha256: typeof activeView.bsSample.basisDocumentSha256 === 'string' ? activeView.bsSample.basisDocumentSha256 : null }
        : { status: 'not_imported' };

  return (
    <>
      <header className={`${demoStyles.detailHeader} ${styles.dialogHeader}`}>
        <div className={styles.dialogTitleBlock}>
          <DialogTitle data-testid="catalog-detail-title">{summaryTitle}</DialogTitle>
          <DialogDescription id="catalog-detail-desc" className={styles.dialogMeta}>
            <span data-testid="catalog-detail-spec">
              {activeView ? catalogSpecFact(activeView.item).value : (listRow?.specificationText || '规格待补')}
            </span>
            {' · '}
            资料版本 <span data-testid="catalog-detail-version">{activeView?.item.revision ?? '—'}</span>
            {' '}
            {isHistorical || revisionInvalid ? (
              <span className={styles.historyBadge} data-testid="catalog-detail-history-badge">
                {revisionInvalid ? '版本参数无效' : '历史只读'}
              </span>
            ) : (
              <span className={styles.currentBadge} data-testid="catalog-detail-current-badge">当前</span>
            )}
            {!isHistorical && !revisionInvalid && (
              <>
                {' · '}
                <span data-testid="catalog-detail-warehouse">{warehouseLabelOf(headerWarehouse)}</span>
                {switchPending && (
                  <>
                    {' '}
                    <span className={styles.switchNotice} role="status" data-testid="catalog-detail-warehouse-switch">
                      正在切换到 {warehouseLabelOf(warehouseFilter)}
                    </span>
                  </>
                )}
              </>
            )}
          </DialogDescription>
        </div>
        <div className={styles.headerActions}>
          {isHistorical && (
            <button type="button" className={styles.headerButton} data-testid="catalog-detail-back-current" onClick={() => requestRevisionChange(0)}>
              返回当前资料
            </button>
          )}
          {!isHistorical && !revisionInvalid && displayReady && activeView && activeView.writeAccess.canWrite && !activeView.historical && (
            <button
              type="button"
              className={styles.headerButton}
              aria-pressed={editing}
              onClick={requestToggleEditing}
            >
              {editing ? '收起编辑' : '编辑资料'}
            </button>
          )}
          {fromHref && (
            <button
              type="button"
              className={styles.headerButton}
              data-testid="catalog-detail-back-from"
              onClick={requestClose}
              title="关闭并返回进入本页前的站内页面"
            >
              返回原页面
            </button>
          )}
          {displayReady && activeView && (
            <details className={styles.moreMenu} data-testid="catalog-detail-more">
              <summary className={styles.headerButton} aria-label="更多操作">更多</summary>
              <div className={styles.morePanel} role="menu" aria-label="更多操作">
                <button
                  type="button"
                  className={styles.moreItem}
                  role="menuitem"
                  data-testid="catalog-more-evidence"
                  onClick={(event) => {
                    const menu = event.currentTarget.closest('details');
                    if (menu instanceof HTMLDetailsElement) menu.open = false;
                    openEvidenceForCurrent();
                  }}
                >
                  数据来源
                </button>
              </div>
            </details>
          )}
          <button type="button" aria-label="关闭商品详情" data-testid="catalog-detail-close" className={demoStyles.iconButton} onClick={requestClose}><X size={20} /></button>
        </div>
      </header>

      {leaveIntent && (
        <div className={styles.leaveNotice} role="alert" data-testid="catalog-detail-leave-notice">
          <span>
            {leaveIntent === 'close'
              ? '有尚未保存的资料修改，关闭后输入会暂存，可再次打开继续。'
              : leaveIntent === 'back'
                ? '浏览器后退已取消：有尚未保存的资料修改。'
                : leaveIntent === 'revision'
                  ? '有尚未保存的资料修改；切换资料版本会离开编辑。'
                  : '有尚未保存的资料修改，收起编辑后可再次进入继续。'}
          </span>
          <button type="button" className={styles.headerButton} onClick={() => { setLeaveIntent(null); setPendingRevision(null); }}>继续编辑</button>
          <button type="button" className={styles.headerButton} onClick={abandonAndLeave}>
            {leaveIntent === 'revision' ? '放弃修改并切换' : leaveIntent === 'edit' ? '放弃修改并收起' : '放弃修改并关闭'}
          </button>
        </div>
      )}

      <div className={styles.dialogBodyWrap}>
        {!displayReady && (listRow || pending || error || staleNotice || revisionInvalid) && (
          <div className={styles.dialogStatus}>
            {revisionInvalid && (
              <section className={styles.statusLine} role="alert" data-testid="catalog-detail-revision-error">
                <span>资料版本参数无效，本次未读取任何版本；不会静默当作当前资料。</span>
                <button type="button" className={demoStyles.textLink} onClick={onBackToCurrent}>查看当前资料</button>
              </section>
            )}
            {!revisionInvalid && listRow && !displayReady && (
              <section className={styles.statusLine} aria-label="列表摘要" data-testid="catalog-detail-list-summary">
                <span><strong>{listRow.nameCn}</strong> · {listRow.iceCode ?? '待补货号'} · 69 {listRow.barcodeText ?? '待补'}</span>
                <span role="status">
                  {isHistorical
                    ? `正在读取资料版本 ${revision}…`
                    : pending || !activeView ? '正在读取商品详情…' : '正在切换仓库…'}
                </span>
              </section>
            )}
            {!revisionInvalid && !listRow && pending && !displayReady && (
              <p className={styles.statusLine} role="status">{isHistorical ? `正在读取资料版本 ${revision}…` : '加载商品详情…'}</p>
            )}
            {staleNotice && (
              <p className={`${styles.statusLine} ${styles.statusLineStale}`} role="status" data-testid="catalog-detail-stale-notice">
                {staleNotice}
                {' '}
                <button type="button" className={demoStyles.textLink} onClick={() => runFetch(warehouseFilter, false, ++requestSeq.current)}>重试</button>
              </p>
            )}
            {error && (
              <p className={`${styles.statusLine} ${styles.statusLineError}`} role="alert" data-testid="catalog-detail-fetch-error">
                {error}
                {' '}
                {!isHistorical && <button type="button" className={demoStyles.textLink} onClick={() => runFetch(warehouseFilter, false, ++requestSeq.current)}>重试</button>}
                {isHistorical && <button type="button" className={demoStyles.textLink} onClick={() => { setError(null); setRevisionAttempt((n) => n + 1); }}>重试</button>}
                {isHistorical && <button type="button" className={demoStyles.textLink} onClick={onBackToCurrent}>返回当前资料</button>}
              </p>
            )}
          </div>
        )}
        {displayReady && activeView && (
          <>
            <div
              className={styles.coreReady}
              data-testid="catalog-detail-core-ready"
              data-warehouse={activeScope?.warehouse ?? warehouseNorm}
              data-content-fresh={contentFreshForMetrics ? 'true' : 'false'}
              data-list-projection-synced={scopeFresh ? 'true' : 'false'}
              data-warehouse-switch={switchPending ? 'pending' : 'idle'}
              data-revision={isHistorical ? String(activeView.item.revision) : 'current'}
              hidden={evidenceOpen}
            >
              <CatalogDetail
                /* R4/U1：key 只按商品与权限上下文重挂载。
                   - 资料版本变化（保存/刷新/历史切换）不重挂载：否则当前分区与编辑草稿被重置；
                   - 仓库变化也不重挂载：用户在「库存明细」里切仓时应停在原分区，由组件内 effect 重置滚动位置。
                   - 权限/金额/估值口径变化仍会重挂载，避免缓存跨权限串用。 */
                key={`${activeView.item.itemId}-${cacheContext.principalKey}-${cacheContext.amountAllowed ? '1' : '0'}-${cacheContext.displayBasisSha256}`}
                core={activeView}
                principalKey={cacheContext.principalKey}
                bsSample={activeView.bsSample}
                bsSampleError={activeView.bsSampleError}
                /* 仓库标签跟随“已加载的那份数据”的 scope，避免切仓请求返回前出现新仓名配旧数量。 */
                warehouseFilter={activeScope && activeScope.warehouse !== 'all' ? activeScope.warehouse : undefined}
                embedded
                warehouseOptions={warehouseOptions}
                onWarehouseChange={switchWarehouseWithImmediateDisplay}
                onRetry={() => runFetch(warehouseFilter, false, ++requestSeq.current)}
                editing={editing}
                onEditingChange={(next) => {
                  if (!next) setEditing(false);
                  else setEditing(true);
                }}
                onDirtyChange={setDirty}
                defaultSection={detailSection}
                onSectionChange={setDetailSection}
                attachmentLoad={loadAttachmentPanels}
                listHref={listHref}
                onSelectRevision={requestRevisionChange}
                onBackToCurrent={isHistorical ? () => requestRevisionChange(0) : undefined}
                onOpenEvidence={openEvidenceAt}
                bodyRef={bodyRef}
                notices={listProjectionOutOfSync ? (
                  <p className={styles.statusLine} role="status" data-testid="catalog-detail-list-sync-notice">
                    列表数据尚未与详情一致，正在更新…
                    {' '}
                    <button type="button" className={demoStyles.textLink} onClick={() => router.refresh()}>刷新列表</button>
                  </p>
                ) : null}
                onRevisionSaved={() => {
                  invalidateDetailCacheItem(detailId);
                  runFetch(warehouseFilter, false, ++requestSeq.current);
                }}
              />
            </div>
            {evidenceOpen && (
              <div className={styles.evidenceLayer} data-testid="catalog-detail-evidence-layer">
                <div className={styles.evidenceScroll}>
                  <ItemEvidencePanel
                    key={`${activeView.item.itemId}-${activeView.item.revision}`}
                    item={activeView.item}
                    historical={isHistorical || Boolean(activeView.historical)}
                    valuation={evidenceValuation}
                    focusWarehouse={warehouseFilter}
                    onBack={closeEvidence}
                  />
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

export function CatalogDetailDialog({
  payload,
  url,
  cacheContext,
}: {
  payload: CatalogListClientPayload | null;
  url: UrlApi;
  cacheContext: CatalogDetailCacheContext;
}) {
  const { detail: detailId, warehouse, closeDetail, revision, revisionInvalid, evidence } = url;
  const open = Boolean(detailId);
  const warehouseFilter = warehouse !== 'all' ? warehouse : undefined;
  const listRow: CatalogListClientRow | undefined = payload?.rows.find((row) => row.itemId === detailId);

  const closeGuardRef = useRef<() => void>(() => closeDetail());
  /* 当前列表 URL（去掉 detail/revision/evidence/from）：作为处理入口与证据视图的列表级返回上下文。 */
  const listHref = useMemo(
    () => buildCatalogListPath({ q: url.q, warehouse: url.warehouse, page: url.page }),
    [url.q, url.warehouse, url.page],
  );

  /* F09：弹窗内切仓只改 warehouse（不关弹窗、不重置 page/detail），由 list-ui 的 URL 状态提供。 */
  const switchWarehouseInDetail = (next: string) => {
    url.setWarehouseInDetail(next);
  };

  /* F01/F09：Tab/Shift+Tab 必须约束在当前弹层内（base-ui 的 focus guard 在宽屏下会漏回背景）。 */
  useDialogFocusTrap(open);

  if (!open || !detailId) return null;

  return (
    <Dialog open onOpenChange={(next) => {
      /* 证据子视图打开时，Esc/遮罩不应直接关掉整个商品弹窗；先退回原分区。 */
      if (!next && evidence) return;
      if (!next) closeGuardRef.current();
    }}>
      <DialogContent
        className={`sm:max-w-5xl ${demoStyles.detailDialog} ${styles.dialogShell}`}
        showCloseButton={false}
        aria-describedby="catalog-detail-desc"
        data-testid="catalog-detail-dialog"
        data-revision={revision > 0 && !revisionInvalid ? String(revision) : revisionInvalid ? 'invalid' : 'current'}
        data-evidence={evidence ? 'on' : 'off'}
      >
        <CatalogDetailLoader
          /* R4/U1：key 只按商品与权限/金额口径上下文重挂载。
             仓库变化、资料版本变化都不重挂载——否则弹窗内切仓会把当前分区复位到「商品资料」、
             保存后刷新会重置编辑草稿（草稿另有 sessionStorage 兜底）。
             数据获取仍由 loader effect 的 revision/warehouseNorm 依赖驱动。 */
          key={`${detailId}-${cacheContext.principalKey}-${cacheContext.amountAllowed ? '1' : '0'}-${cacheContext.displayBasisSha256}`}
          detailId={detailId}
          revision={revision}
          revisionInvalid={revisionInvalid}
          warehouseFilter={warehouseFilter}
          listRow={listRow}
          cacheContext={cacheContext}
          onClose={closeDetail}
          closeGuardRef={closeGuardRef}
          listHref={listHref}
          warehouseOptions={payload?.warehouseOptions ?? []}
          onWarehouseChange={switchWarehouseInDetail}
          onSelectRevision={url.setRevision}
          onBackToCurrent={() => url.setRevision(0)}
          evidenceOpen={evidence}
          fromHref={url.from || undefined}
          onEvidenceOpen={() => url.setEvidence(true)}
          onEvidenceClose={() => url.setEvidence(false)}
          navigateGuard={url as unknown as UrlNavigateGuardApi}
        />
      </DialogContent>
    </Dialog>
  );
}
