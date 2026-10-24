/**
 * V4-06：安全内部返回路径。
 *
 * 先把 URL 规范化（解码、折叠 `.`/`..`、去除编码等价写法），再按商品库白名单校验：
 * - 只接受 `/dashboard/catalog` 本身及其 `issues` / `admin` / `intake` / `sources` 子路径；
 * - 拒绝外站、协议相对、反斜杠、路径穿越、编码等价路径、控制字符；
 * - 拒绝旧 `/dashboard/catalog/<商品编号>` 详情 pathname，避免关闭后又被兼容路由打开；
 * - 去掉 detail/revision/evidence 与嵌套 from，避免无限返回链/循环。
 *
 * 该函数同时供服务端页面与客户端 URL 状态使用（纯函数，无副作用）。
 */
export const CATALOG_INTERNAL_PREFIX = '/dashboard/catalog';
export const CATALOG_SAFE_RETURN_MAX_LENGTH = 1024;

const INTERNAL_ORIGIN = 'http://iceos.invalid';
const ALLOWED_CHILDREN = new Set(['issues', 'admin', 'intake', 'sources']);
const UUID_OR_ID = /^[0-9a-f][0-9a-f-]{7,}$/i;

function decodePathOnce(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return '';
  }
}

export function safeCatalogReturnHref(raw?: string | null): string {
  if (!raw) return '';
  const value = raw.trim();
  if (!value || value.length > CATALOG_SAFE_RETURN_MAX_LENGTH) return '';
  if (!value.startsWith(CATALOG_INTERNAL_PREFIX)) return '';
  if (value.includes('\\') || /[\u0000-\u001f]/.test(value)) return '';

  let url: URL;
  try {
    url = new URL(value, INTERNAL_ORIGIN);
  } catch {
    return '';
  }
  if (url.origin !== INTERNAL_ORIGIN) return '';

  const decoded = decodePathOnce(url.pathname);
  if (!decoded) return '';
  if (!decoded.startsWith(CATALOG_INTERNAL_PREFIX)) return '';
  /* 编码的斜杠/反斜杠/空字节不能绕过路径边界。 */
  if (/%2f|%5c|%00/i.test(url.pathname)) return '';

  let normalized: URL;
  try {
    normalized = new URL(decoded, INTERNAL_ORIGIN);
  } catch {
    return '';
  }
  if (normalized.origin !== INTERNAL_ORIGIN) return '';
  const pathname = normalized.pathname;
  if (!pathname.startsWith(CATALOG_INTERNAL_PREFIX)) return '';
  if (pathname.includes('//')) return '';

  const rest = pathname.slice(CATALOG_INTERNAL_PREFIX.length);
  const segments = rest.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..')) return '';
  if (segments.length > 0) {
    if (!ALLOWED_CHILDREN.has(segments[0]!)) return '';
    /* 旧详情 pathname：/dashboard/catalog/<id>；关闭后不能再被兼容路由打开。 */
    if (segments.length === 1 && UUID_OR_ID.test(segments[0]!)) return '';
  }

  const params = new URLSearchParams(url.search);
  if (params.has('from')) return '';
  params.delete('detail');
  params.delete('revision');
  params.delete('evidence');
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

/** 忽略末尾空查询串的比较，用于判断 from 是否就是当前列表 URL。 */
export function sameCatalogHref(a: string, b: string): boolean {
  const norm = (value: string) => value.replace(/\?$/, '');
  return norm(a) === norm(b);
}
