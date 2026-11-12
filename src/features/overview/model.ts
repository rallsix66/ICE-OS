/**
 * 经营总览首页的页面级工具：查询参数、金额/数量显示、待处理事项模型。
 *
 * 口径与读取都在 `server/reads.ts` 与 `aggregate.ts`；这里只做 URL 与纯显示转换，
 * 不另算业务数量，不把未知写成 0。
 */

export interface HomeQueryState {
  /** 商品概览搜索（货号/名称/条码），最多 120 字符。 */
  q: string;
  /** 商品概览页码（从 1 开始）。 */
  page: number;
}

export const HOME_PAGE_SIZE = 10;

export const DEFAULT_HOME_QUERY: HomeQueryState = { q: '', page: 1 };

export function parseHomeSearchParams(
  params: URLSearchParams | Record<string, string | string[] | undefined>,
): HomeQueryState {
  const get = (key: string): string => {
    if (params instanceof URLSearchParams) return params.get(key) ?? '';
    const value = params[key];
    return (Array.isArray(value) ? value[0] : value) ?? '';
  };
  const pageNumber = Number.parseInt(get('page'), 10);
  return {
    q: get('q').trim().slice(0, 120),
    page: Number.isFinite(pageNumber) && pageNumber > 0 ? pageNumber : 1,
  };
}

export function buildHomeHref(state: Partial<HomeQueryState>): string {
  const params = new URLSearchParams();
  const q = (state.q ?? '').trim();
  if (q) params.set('q', q);
  if (state.page && state.page > 1) params.set('page', String(state.page));
  const qs = params.toString();
  return qs ? `/dashboard?${qs}` : '/dashboard';
}

/** 需要处理事项的动作：跳转 / 当场打开复核弹窗 / 就地展开缺价清单。 */
export type HomePendingAction = 'link' | 'review' | 'missing-cost';

export interface HomePendingItem {
  key: string;
  /** 业务分类：库存待对应 / 物流待复核 / 在途未计入 / 商品资料 / 同步状态。 */
  category: string;
  title: string;
  detail: string;
  /** 该事项自己的数量文本（如「141 条」「7 项」「2 款」）；null = 状态类事项，没有可计数量（不写 0）。 */
  countLabel: string | null;
  href: string;
  /** 明确动作：跳转目标页 / 当场复核 / 就地展开清单。 */
  action: HomePendingAction;
  /** 动作按钮文字（按业务写明，不用「处理 →」）。 */
  actionLabel: string;
}

/** 金额展示：保留原始小数位，仅给整数部分加千分位；null 不显示 0。 */
export function formatCnyAmount(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return '—';
  const text = String(raw).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return '—';
  const [whole, frac] = text.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `¥${grouped}${frac ? `.${frac}` : ''}`;
}

/** 数量展示：整数千分位；null 保持「—」（未知/未计入，不是 0）。 */
export function formatHomeQuantity(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return Math.trunc(value).toLocaleString('zh-CN');
}
