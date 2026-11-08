/**
 * 经营总览使用的市场显示名。
 *
 * 库存仓库带的是有证据的市场代码（TH/PH/MY/VN/ID…），飞书在途来源给的是中文国家名；
 * 首页只做显示映射与两套来源的合并键，不据此推断归属。未知代码原样显示，市场空值单列。
 */
export const MARKET_LABELS: Record<string, string> = {
  CN: '中国',
  TH: '泰国',
  PH: '菲律宾',
  MY: '马来西亚',
  VN: '越南',
  ID: '印度尼西亚',
  SG: '新加坡',
  KH: '柬埔寨',
};

export function marketLabel(code: string | null | undefined): string {
  if (!code) return '市场待确认';
  return MARKET_LABELS[code] ?? code;
}

/** 中文市场名 → 代码（用于把飞书在途市场合并到库存市场行）；未收录时返回 null。 */
const LABEL_TO_CODE = new Map(
  Object.entries(MARKET_LABELS).map(([code, label]) => [label, code] as const),
);

export function marketCodeFromLabel(label: string | null | undefined): string | null {
  const value = (label ?? '').trim();
  if (!value) return null;
  return LABEL_TO_CODE.get(value) ?? null;
}
