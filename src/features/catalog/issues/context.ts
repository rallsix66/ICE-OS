/**
 * 站内上下文工具（R8/V3-05）：构造与校验返回点、把 `from` 带到处理页。
 *
 * 安全边界：
 * - 只接受站内 `/dashboard/` 开头的相对路径；拒绝 `//host`、`\\`、外部 URL、控制字符与 `..` 段；
 * - 不嵌套 `from`（已有 `from` 的返回点不再被包一层），避免 URL 无限增长；
 * - 不产生自引用返回环（目标与返回点完全相同则不加 `from`）。
 * 纯函数，可在单测中直接覆盖。
 */

import { safeCatalogReturnHref } from '../shell/safe-return';

/** 待处理问题索引自身的路径（事项处理页的安全返回点）。 */
export const ISSUES_RETURN_HREF = '/dashboard/catalog/issues';

const MAX_LENGTH = 512;
const NESTED_RETURN_PATTERN = /[?&]from=/i;

function pathOf(href: string): string {
  return href.split('?')[0]?.split('#')[0] ?? '';
}

/**
 * V5-05：intake / sources / 旧 evidence / 商品弹窗统一使用商品库返回路径白名单。
 * 这样编码穿越、旧详情 pathname、嵌套 from 和循环不会再因入口不同而漏过。
 */
export function safeInternalReturnHref(raw?: string | string[] | null): string | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return undefined;
  if (value.length === 0 || value.length > MAX_LENGTH) return undefined;
  const safe = safeCatalogReturnHref(value);
  return safe || undefined;
}

/**
 * 给处理页链接追加 `from`（完整站内返回路径，已编码）。
 * 嵌套 from 与自己指自己都不追加，避免返回循环。
 */
export function appendReturnContext(href: string, from: string | undefined): string {
  if (!from) return href;
  const safe = safeInternalReturnHref(from);
  if (!safe) return href;
  if (NESTED_RETURN_PATTERN.test(safe)) return href;
  if (safe === href) return href;
  const separator = href.includes('?') ? '&' : '?';
  return `${href}${separator}from=${encodeURIComponent(safe)}`;
}

/** 构造「返回待处理索引」的返回点。 */
export function issuesReturnHref(): string {
  return ISSUES_RETURN_HREF;
}

/** 判断返回点是否来自待处理索引（用于文案「返回待处理」与安全回退）。 */
export function isIssuesReturnHref(href: string | undefined): boolean {
  const safe = safeInternalReturnHref(href);
  return safe !== undefined && pathOf(safe) === ISSUES_RETURN_HREF;
}
