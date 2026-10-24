'use client';

import { useEffect } from 'react';

/**
 * 详情弹层的显式焦点约束（F01/F09）。
 *
 * 背景：现役 `@base-ui/react` Dialog 的 focus guard 在部分宽度下会把 Tab 交还给页面背景
 * （实测 1440/1100/短屏/200% 缩放下会逃到侧栏与工具栏）。这里补一层与宽度无关的约束：
 * - Tab / Shift+Tab 在弹层内最后一个/第一个可聚焦元素处回绕；
 * - 焦点若因 base-ui guard 或其它原因落到弹层外，立刻拉回弹层内的第一个可聚焦元素。
 *
 * 只处理键盘与焦点，不改点击/关闭/滚动语义；Esc 仍由弹层自身的关闭逻辑处理。
 */

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function visibleFocusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((element) => {
    if (element.hasAttribute('disabled')) return false;
    if (element.getAttribute('aria-hidden') === 'true') return false;
    // offsetParent 为 null 说明元素（或祖先）不可见，例如关闭的 <details> 内容。
    return element.offsetParent !== null;
  });
}

/** @param active 弹层是否打开；打开期间约束释放由本 hook 的清理负责。 */
export function useDialogFocusTrap(active: boolean, containerSelector = '[data-slot="dialog-content"]') {
  useEffect(() => {
    if (!active || typeof document === 'undefined') return;
    const container = () => document.querySelector<HTMLElement>(containerSelector);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const root = container();
      if (!root) return;
      const focusables = visibleFocusables(root);
      if (!focusables.length) return;
      const activeElement = document.activeElement as HTMLElement | null;
      const inside = Boolean(activeElement && root.contains(activeElement));
      if (!inside) {
        // 焦点已经在弹层外（含 base-ui guard span）：直接拉回，不交给后续默认行为。
        event.preventDefault();
        (event.shiftKey ? focusables[focusables.length - 1] : focusables[0]).focus();
        return;
      }
      const index = focusables.indexOf(activeElement as HTMLElement);
      if (event.shiftKey && index <= 0) {
        event.preventDefault();
        focusables[focusables.length - 1].focus();
        return;
      }
      if (!event.shiftKey && index === focusables.length - 1) {
        event.preventDefault();
        focusables[0].focus();
      }
    };

    const onFocusIn = (event: FocusEvent) => {
      const root = container();
      if (!root) return;
      const target = event.target as HTMLElement | null;
      if (!target || root.contains(target)) return;
      // Base UI 自己会在 guard 上重定向；这里只兜底“真的落到页面背景”的情况，
      // 避免和 guard 的默认重定向互相抢焦点。
      if (target.hasAttribute?.('data-base-ui-focus-guard')) return;
      const focusables = visibleFocusables(root);
      if (focusables.length) focusables[0].focus();
    };

    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', onFocusIn, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', onFocusIn, true);
    };
  }, [active, containerSelector]);
}
