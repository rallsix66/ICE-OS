import { safeCatalogReturnHref } from './safe-return';

export type CatalogUrlState = {
  q: string;
  warehouse: string;
  page: number;
  detail: string;
  /** 0 = 当前采用资料；>=1 = 在弹窗内查看的历史版本（只读）。 */
  revision: number;
  /** 版本参数存在但不是合法版本；显示明确错误，不静默当作当前资料。 */
  revisionInvalid: boolean;
  /** 弹窗内“来源与证据”子视图开关（同一弹窗，不新开页面）。 */
  evidence: boolean;
  /** 安全内部返回路径（仅 /dashboard/catalog 前缀，禁止嵌套 from）。 */
  from: string;
};

export const DEFAULT_CATALOG_URL_STATE: CatalogUrlState = {
  q: '',
  warehouse: 'all',
  page: 1,
  detail: '',
  revision: 0,
  revisionInvalid: false,
  evidence: false,
  from: '',
};

const DETAIL_ID = /^[a-f\d-]{36}$/i;
const MAX_REVISION = 1_000_000_000;

/** 页码只接受正整数字面量；NaN/Infinity/小数/负数一律收敛为 1。 */
export function normalizePageNumber(raw: number): number {
  if (!Number.isFinite(raw)) return 1;
  const floored = Math.floor(raw);
  return floored >= 1 ? floored : 1;
}

/** 版本号只接受 >=1 的整数；无效参数收敛为 0（当前资料），不猜版本。 */
export function normalizeRevisionParam(raw: string | number | null | undefined): number {
  if (raw === null || raw === undefined || raw === '') return 0;
  const parsed = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_REVISION) return 0;
  return parsed;
}

export function isCatalogDetailId(value: string): boolean {
  return DETAIL_ID.test(value);
}

/**
 * 从 URLSearchParams 解析商品库 URL 状态（服务端首屏与客户端 popstate 共用）。
 * 非法参数收敛为安全值；`revisionInvalid` 保留“参数存在但无效”的事实，供弹窗显示明确错误。
 */
export function parseCatalogSearchParams(params: URLSearchParams): CatalogUrlState {
  const rawPage = Number(params.get('page') ?? '1');
  const rawDetail = (params.get('detail') ?? '').trim();
  const detail = isCatalogDetailId(rawDetail) ? rawDetail : '';
  const rawRevision = params.get('revision');
  const revision = detail ? normalizeRevisionParam(rawRevision) : 0;
  const revisionInvalid = Boolean(detail) && rawRevision !== null && rawRevision !== '' && revision === 0;
  const evidence = Boolean(detail) && ['1', 'true'].includes((params.get('evidence') ?? '').toLowerCase());
  const from = detail ? safeCatalogReturnHref(params.get('from')) : '';
  return {
    q: params.get('q')?.trim() ?? '',
    warehouse: params.get('warehouse')?.trim() || 'all',
    page: normalizePageNumber(rawPage),
    detail,
    revision,
    revisionInvalid,
    evidence,
    from,
  };
}

/** 列表级路径（不含 detail/revision/evidence），用于关闭弹窗后恢复阅读上下文。 */
export function buildCatalogListPath(state: Pick<CatalogUrlState, 'q' | 'warehouse' | 'page'>): string {
  const params = new URLSearchParams();
  if (state.q) params.set('q', state.q);
  if (state.warehouse && state.warehouse !== 'all') params.set('warehouse', state.warehouse);
  if (state.page > 1) params.set('page', String(state.page));
  const qs = params.toString();
  return qs ? `/dashboard/catalog?${qs}` : '/dashboard/catalog';
}

/** 规范化后的完整 URL；所有会员状态只通过这里序列化，保证地址栏可刷新/可分享。 */
export function buildCatalogUrl(state: CatalogUrlState): string {
  const params = new URLSearchParams();
  if (state.q) params.set('q', state.q);
  if (state.warehouse && state.warehouse !== 'all') params.set('warehouse', state.warehouse);
  if (state.page > 1) params.set('page', String(state.page));
  if (state.detail) {
    params.set('detail', state.detail);
    if (state.revision > 0) params.set('revision', String(state.revision));
    else if (state.revisionInvalid) params.set('revision', 'invalid');
    if (state.evidence) params.set('evidence', '1');
    if (state.from) params.set('from', state.from);
  }
  const qs = params.toString();
  return qs ? `/dashboard/catalog?${qs}` : '/dashboard/catalog';
}

/** 服务端 searchParams（可能为数组）→ URLSearchParams。 */
export function searchParamsToUrlSearchParams(sp: Record<string, string | string[] | undefined>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) {
    if (value === undefined) continue;
    const first = Array.isArray(value) ? value[0] : value;
    if (first !== undefined) params.set(key, first);
  }
  return params;
}
