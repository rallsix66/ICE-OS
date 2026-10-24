/**
 * 旧入口 / 待处理索引的失败分类（纯函数，无数据库、无环境变量）。
 *
 * 三态必须分开表达，不能把“未启用”写成 0 项，也不能把网络失败并入“无权或不存在”：
 * - `forbidden`   → 账号没有访问权限或所请求对象不存在（防枚举，可共用安全文案）
 * - `unavailable` → 模块/运行环境当前未启用（隔离 fixture 未就绪等），不代表 0 项
 * - `read_failed` → 网络/传输/SQL 故障，可重试
 */
export type CatalogReadFailureKind = 'forbidden' | 'unavailable' | 'read_failed';

const UNAVAILABLE_PATTERN = /CATALOG_UNAVAILABLE|MODULE_DISABLED|FIXTURE_RUNTIME_DENIED/;
// N1A/N1C 在范围级拒绝时抛 IDENTITY_DENIED / NEW_ITEM_DENIED（同为 42501），必须与网络失败分开。
const FORBIDDEN_PATTERN = /CATALOG_FORBIDDEN|IDENTITY_FORBIDDEN|IDENTITY_DENIED|NEW_ITEM_FORBIDDEN|NEW_ITEM_DENIED|无权限|未登录或账户已停用/;

export function catalogErrorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : '';
}

export function catalogErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '';
}

export function classifyCatalogReadFailure(error: unknown): CatalogReadFailureKind {
  const message = catalogErrorMessage(error);
  if (UNAVAILABLE_PATTERN.test(message)) return 'unavailable';
  if (catalogErrorCode(error) === '42501' || FORBIDDEN_PATTERN.test(message)) return 'forbidden';
  return 'read_failed';
}
