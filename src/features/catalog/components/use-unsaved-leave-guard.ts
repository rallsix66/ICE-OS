'use client';

import { useEffect, useRef } from 'react';

/**
 * R4：站内链接离开守卫。
 *
 * 编辑草稿未保存时，拦截同源 `<a href>` 的点击（不拦截 target=_blank / download / 外站 / 组合键 / 中键），
 * 交回调用方弹出提示并提供“继续编辑 / 放弃并前往”。浏览器后退由 `useCatalogUrlState` 的导航守卫处理，
 * 文档卸载由 `beforeunload` 处理；三条路径共用同一份草稿状态，不各自清空。
 */
export function useUnsavedLeaveGuard({
  active,
  onBlocked,
}: {
  active: boolean;
  onBlocked: (href: string) => void;
}) {
  const activeRef = useRef(active);
  const blockedRef = useRef(onBlocked);

  useEffect(() => {
    activeRef.current = active;
    blockedRef.current = onBlocked;
  }, [active, onBlocked]);

  useEffect(() => {
    function onClick(event: MouseEvent) {
      if (!activeRef.current) return;
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target as Element | null;
      const anchor = target?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!anchor) return;
      if (anchor.target && anchor.target !== '_self') return;
      if (anchor.hasAttribute('download')) return;
      let url: URL;
      try {
        url = new URL(anchor.href, window.location.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin) return;
      if (`${url.pathname}${url.search}` === `${window.location.pathname}${window.location.search}`) return;
      event.preventDefault();
      event.stopPropagation();
      blockedRef.current(`${url.pathname}${url.search}${url.hash}`);
    }

    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);
}
