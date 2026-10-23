'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export type CatalogUrlState = {
  q: string;
  warehouse: string;
  page: number;
  detail: string;
};

function readFromLocation(): CatalogUrlState {
  if (typeof window === 'undefined') {
    return { q: '', warehouse: 'all', page: 1, detail: '' };
  }
  const params = new URLSearchParams(window.location.search);
  const rawPage = Number(params.get('page') ?? '1');
  const detail = params.get('detail')?.trim() ?? '';
  return {
    q: params.get('q')?.trim() ?? '',
    warehouse: params.get('warehouse')?.trim() || 'all',
    page: Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1,
    detail: /^[a-f\d-]{36}$/i.test(detail) ? detail : '',
  };
}

function buildPath(state: CatalogUrlState): string {
  const params = new URLSearchParams();
  if (state.q) params.set('q', state.q);
  if (state.warehouse && state.warehouse !== 'all') params.set('warehouse', state.warehouse);
  if (state.page > 1) params.set('page', String(state.page));
  if (state.detail) params.set('detail', state.detail);
  const qs = params.toString();
  return qs ? `/dashboard/catalog?${qs}` : '/dashboard/catalog';
}

/** Client-side URL sync without Next.js navigation (avoids force-dynamic list refetch). */
export function useCatalogUrlState(initial: CatalogUrlState) {
  const [state, setState] = useState<CatalogUrlState>(initial);
  const detailPushed = useRef(false);
  const scrollY = useRef<number | null>(null);

  useEffect(() => {
    const onPop = () => {
      const next = readFromLocation();
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
  }, []);

  const apply = useCallback((patch: Partial<CatalogUrlState>, mode: 'push' | 'replace') => {
    setState((prev) => {
      const next = { ...prev, ...patch };
      const url = buildPath(next);
      if (mode === 'push') window.history.pushState(null, '', url);
      else window.history.replaceState(null, '', url);
      return next;
    });
  }, []);

  const setQuery = useCallback((q: string) => apply({ q, page: 1 }, 'replace'), [apply]);
  const setWarehouse = useCallback((warehouse: string) => apply({ warehouse, page: 1 }, 'replace'), [apply]);
  const setPage = useCallback((page: number) => apply({ page }, 'replace'), [apply]);
  const resetFilters = useCallback(() => apply({ q: '', warehouse: 'all', page: 1, detail: '' }, 'replace'), [apply]);

  const openDetail = useCallback((detail: string) => {
    if (scrollY.current === null) scrollY.current = window.scrollY;
    detailPushed.current = true;
    apply({ detail }, 'push');
  }, [apply]);

  const closeDetail = useCallback(() => {
    if (detailPushed.current) {
      window.history.back();
      return;
    }
    apply({ detail: '' }, 'replace');
  }, [apply]);

  return {
    ...state,
    setQuery,
    setWarehouse,
    setPage,
    resetFilters,
    openDetail,
    closeDetail,
    clearDetailParam: () => apply({ detail: '' }, 'replace'),
  };
}
