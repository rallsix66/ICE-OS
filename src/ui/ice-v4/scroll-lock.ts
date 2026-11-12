/**
 * 弹窗/抽屉打开时锁住页面滚动，并保证背景不横移、关闭后回到原滚动位置。
 *
 * 为什么不能只写 `document.documentElement.style.overflow='hidden'`：
 * Windows 桌面浏览器（Chrome/Edge）的纵向滚动条占约 15px 布局宽度，直接隐藏滚动条会让
 * 内容区变宽，整页标题、表格和按钮向右跳一下；关闭时再跳回来。这里在锁定期间用
 * `padding-right` 补上滚动条宽度，使内容区宽度与解锁时完全一致，关闭后恢复原样。
 *
 * 支持嵌套（详情抽屉里再开弹窗）：只有最外层真正锁定，最内层释放后才恢复。
 * 关闭后恢复到打开前的 `scrollX/scrollY`，避免焦点回焦把页面滚走。
 */

let lockCount = 0;
let saved: {
  overflow: string;
  paddingRight: string;
  scrollX: number;
  scrollY: number;
} | null = null;

export function lockPageScroll(): () => void {
  if (typeof document === 'undefined') return () => {};
  const doc = document.documentElement;
  if (lockCount === 0) {
    const viewportWidth = doc.clientWidth;
    const scrollbarWidth = Math.max(0, window.innerWidth - viewportWidth);
    saved = {
      overflow: doc.style.overflow,
      paddingRight: doc.style.paddingRight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    };
    if (scrollbarWidth > 0) {
      const computed = Number.parseFloat(window.getComputedStyle(doc).paddingRight) || 0;
      doc.style.paddingRight = `${computed + scrollbarWidth}px`;
    }
    doc.style.overflow = 'hidden';
  }
  lockCount += 1;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    lockCount = Math.max(0, lockCount - 1);
    if (lockCount > 0 || !saved) return;
    const state = saved;
    saved = null;
    doc.style.overflow = state.overflow;
    doc.style.paddingRight = state.paddingRight;
    window.scrollTo({ top: state.scrollY, left: state.scrollX, behavior: 'auto' });
  };
}
