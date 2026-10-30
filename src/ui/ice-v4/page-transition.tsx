'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import styles from './page-transition.module.css';

/**
 * 路由切换的轻量过渡：只在 pathname 变化时给内容加一次淡入。
 * 不 remount 子树——商品库存详情用 router.push 改的是同一路由的 search 参数，
 * 这里只监听 pathname，不会把已打开的详情重置。
 */
export function PageTransition({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [entering, setEntering] = useState(false);
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setEntering(true);
    const timer = window.setTimeout(() => setEntering(false), 220);
    return () => window.clearTimeout(timer);
  }, [pathname]);

  return <div className={entering ? styles.enter : undefined}>{children}</div>;
}
