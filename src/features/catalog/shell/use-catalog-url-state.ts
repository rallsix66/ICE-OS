'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  buildCatalogListPath,
  buildCatalogUrl,
  DEFAULT_CATALOG_URL_STATE,
  normalizePageNumber,
  normalizeRevisionParam,
  parseCatalogSearchParams,
  type CatalogUrlState,
} from './catalog-url-params';
import { safeCatalogReturnHref, sameCatalogHref } from './safe-return';

export type { CatalogUrlState } from './catalog-url-params';
export { normalizePageNumber, normalizeRevisionParam } from './catalog-url-params';

function clampPage(raw: number, pageCount: number): number {
  const safeCount = Number.isFinite(pageCount) && pageCount >= 1 ? Math.floor(pageCount) : 1;
  return Math.min(normalizePageNumber(raw), safeCount);
}

function readFromLocation(): CatalogUrlState {
  if (typeof window === 'undefined') return DEFAULT_CATALOG_URL_STATE;
  return parseCatalogSearchParams(new URLSearchParams(window.location.search));
}

/** Client-side URL sync without Next.js navigation (avoids force-dynamic list refetch). */
export function useCatalogUrlState(initial: CatalogUrlState) {
  const [state, setState] = useState<CatalogUrlState>(() => ({
    ...initial,
    page: normalizePageNumber(initial.page),
    revision: initial.detail ? normalizeRevisionParam(initial.revision) : 0,
    revisionInvalid: Boolean(initial.detail) && Boolean(initial.revisionInvalid),
  }));
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);

  const detailPushed = useRef(false);
  const scrollY = useRef<number | null>(null);
  /** 最近一次已知的完整 URL（pathname + search）；守卫取消历史变化时用它 pushState 回原位。 */
  const currentUrlRef = useRef<string>(typeof window === 'undefined' ? '' : `${window.location.pathname}${window.location.search}`);
  /**
   * R4：外部（如编辑弹窗）注册的离开守卫。返回 false = 取消这次历史变化。
   *
   * “放行一次后自动复位”由调用方实现：调用方在批准一次离开（例如 approveNavigation）时置位内部标志，
   * 守卫返回 true 后立刻自行清除该标志；hook 每次 popstate 都调用同一个守卫函数，不缓存结果，
   * 因此一次放行不会让后续返回也被默默放行。
   */
  const guardRef = useRef<(() => boolean) | null>(null);

  const syncUrlRef = useCallback(() => {
    currentUrlRef.current = `${window.location.pathname}${window.location.search}`;
  }, []);

  const registerNavigationGuard = useCallback((guard: (() => boolean) | null) => {
    guardRef.current = guard;
  }, []);

  const commit = useCallback((next: CatalogUrlState, mode: 'push' | 'replace') => {
    const url = buildCatalogUrl(next);
    if (mode === 'push') window.history.pushState(null, '', url);
    else window.history.replaceState(null, '', url);
    stateRef.current = next;
    currentUrlRef.current = `${window.location.pathname}${window.location.search}`;
  }, []);

  useEffect(() => {
    const onPop = () => {
      // 守卫必须在改变 React state 之前判断：返回 false 时整体取消（不关闭详情、不换页、不恢复滚动）。
      if (guardRef.current && !guardRef.current()) {
        window.history.pushState(null, '', currentUrlRef.current);
        return;
      }
      const next = readFromLocation();
      syncUrlRef();
      setState(next);
      if (!next.detail && scrollY.current !== null) {
        const y = scrollY.current;
        scrollY.current = null;
        detailPushed.current = false;
        window.requestAnimationFrame(() => window.scrollTo({ top: y }));
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [syncUrlRef]);

  // Canonicalize the address bar for out-of-range/invalid parameters (e.g. page=abc, page=-2,
  // warehouse=all) as soon as the client has a state to build the canonical URL from.
  useEffect(() => {
    const canonical = buildCatalogUrl(state);
    const current = `${window.location.pathname}${window.location.search}`;
    if (current !== canonical) {
      window.history.replaceState(null, '', canonical);
      syncUrlRef();
    }
  }, [state, syncUrlRef]);

  const apply = useCallback((patch: Partial<CatalogUrlState>, mode: 'push' | 'replace') => {
    setState((prev) => {
      const next = { ...prev, ...patch };
      next.page = normalizePageNumber(next.page);
      if (!next.detail) {
        next.revision = 0;
        next.revisionInvalid = false;
        next.evidence = false;
        next.from = '';
      } else {
        next.revision = normalizeRevisionParam(next.revision);
        next.revisionInvalid = next.revision > 0 ? false : Boolean(next.revisionInvalid);
        /* V4-06：任何写回 URL 的 from 都先规范化；非法/旧详情/嵌套来源直接丢弃，不产生循环。 */
        next.from = safeCatalogReturnHref(next.from);
      }
      commit(next, mode);
      return next;
    });
  }, [commit]);

  const setQuery = useCallback((q: string) => apply({ q, page: 1 }, 'replace'), [apply]);
  const setWarehouse = useCallback((warehouse: string) => apply({ warehouse, page: 1 }, 'replace'), [apply]);
  const setPage = useCallback((page: number) => apply({ page }, 'replace'), [apply]);

  /**
   * 收敛页码到当前结果集的有效页（筛选/切仓/数据变少后调用）。
   * 只在越界时改写 URL（replaceState），不新增历史记录。
   */
  const normalizePage = useCallback((pageCount: number) => {
    setState((prev) => {
      const nextPage = clampPage(prev.page, pageCount);
      if (nextPage === prev.page) return prev;
      const next = { ...prev, page: nextPage };
      commit(next, 'replace');
      return next;
    });
  }, [commit]);

  const resetFilters = useCallback(() => apply({
    q: '', warehouse: 'all', page: 1, detail: '', revision: 0, revisionInvalid: false, evidence: false, from: '',
  }, 'replace'), [apply]);

  /**
   * 详情弹窗内切仓：只替换 warehouse，不重置 page/detail/revision/evidence/from，
   * 不新增历史记录。列表上下文（搜索/页码/编辑中的详情）保持不变。
   */
  const setWarehouseInDetail = useCallback((warehouse: string) => {
    apply({ warehouse: warehouse.trim() || 'all' }, 'replace');
  }, [apply]);

  const openDetail = useCallback((detail: string, options: { from?: string } = {}) => {
    if (scrollY.current === null) scrollY.current = window.scrollY;
    detailPushed.current = true;
    apply({ detail, revision: 0, revisionInvalid: false, evidence: false, from: options.from ?? '' }, 'push');
  }, [apply]);

  /**
   * 关闭弹窗：优先回到明确的安全来源（例如 `/dashboard/catalog/issues`），
   * 否则回到原列表并恢复阅读位置。绝不退到不相关外站。
   */
  const closeDetail = useCallback(() => {
    const current = stateRef.current;
    const listPath = buildCatalogListPath(current);
    const hasExternalFrom = Boolean(current.from) && !sameCatalogHref(current.from, listPath);    if (hasExternalFrom) {
      detailPushed.current = false;
      scrollY.current = null;
      /* 来源页属于另一条服务端路由：用一次真实导航确保列表筛选/滚动重新建立，不留在旧 state 上。 */
      window.location.assign(current.from);
      return;
    }
    if (detailPushed.current) {
      window.history.back();
      return;
    }
    apply({ detail: '', revision: 0, revisionInvalid: false, evidence: false, from: '' }, 'replace');
  }, [apply]);

  /** 弹窗内切换历史版本（只读）；不新开页面、不叠加第二个弹窗。 */
  const setRevision = useCallback((revision: number) => {
    apply({ revision: normalizeRevisionParam(revision), revisionInvalid: false, evidence: false }, 'replace');
  }, [apply]);

  /** 弹窗内打开/关闭“来源与证据”子视图；分区与滚动位置由组件恢复。 */
  const setEvidence = useCallback((evidence: boolean) => {
    apply({ evidence }, 'replace');
  }, [apply]);

  return {
    ...state,
    setQuery,
    setWarehouse,
    setPage,
    normalizePage,
    setWarehouseInDetail,
    registerNavigationGuard,
    resetFilters,
    openDetail,
    closeDetail,
    setRevision,
    setEvidence,
    clearDetailParam: () => apply({ detail: '', revision: 0, revisionInvalid: false, evidence: false, from: '' }, 'replace'),
  };
}
