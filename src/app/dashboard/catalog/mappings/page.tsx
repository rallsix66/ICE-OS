import type { Metadata } from 'next';
import Link from 'next/link';
import { ReadFailurePanel } from '@/features/inventory/components/display';
import { MappingQueue } from '@/features/inventory/components/mapping-queue';
import { ConfirmedMappingList } from '@/features/inventory/components/confirmed-mapping-list';
import { PendingRecoveryPanel } from '@/features/inventory/components/pending-recovery';
import {
  DEFAULT_INVENTORY_QUERY,
  classifyReadFailure,
  currentMappingStatusLabel,
  isUuid,
  mappingQueueOffset,
  normalizePageNumber,
  pendingBlocksWrites,
  pendingRecoveryKey,
  MAX_SEARCH_LENGTH,
} from '@/features/inventory/model';
import {
  getInventoryItem,
  getInventoryList,
  getInventoryMappingQueue,
  getInventorySyncOverview,
  requireInventoryAdmin,
} from '@/features/inventory/server/reads';
import type {
  InventoryItemDetailDto,
  InventoryListItemDto,
  InventoryMappingQueueDto,
  InventoryOverviewDto,
} from '@/features/inventory/types';
import styles from './mappings.module.css';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const metadata: Metadata = { title: '来源 SKU 对应 · ICE 商品库' };

/**
 * R4：商品库「来源 SKU 对应」是正式来源 SKU 对应的唯一维护入口。
 * - 定位参数 item / warehouse / sku 入口严格校验，只作只读定位/筛选（q 仅兼容旧搜索），不扩大权限；
 * - 待处理队列先按 `q=来源 SKU` 服务端检索，再限定到目标仓，目标行高亮置顶；定位不到就明说“本页未找到”，不虚构；
 * - back 只接受库存页/商品库页的站内相对地址，并原样保留 query string（恢复 view/source/q/warehouse/market/page/row）；
 * - 确认/换绑/重核/停用仍复用 MappingQueue 与 ConfirmedMappingList 的既有动作、版本、理由、结果未知核对与写锁语义，不复制第二套编辑器；
 * - 本页只维护海外 BigSeller 来源对应；国内表格快照只读，不提供 BigSeller 绑定。
 */

/** 返回白名单：只有库存页与商品库页可以作为回跳目标；其它来源丢弃回默认（库存页）。 */
const ALLOWED_BACK_PREFIXES = ['/dashboard/inventory', '/dashboard/catalog'];
const BACK_ORIGIN = 'http://iceos.invalid';
const MAX_BACK_LENGTH = 2000;

/** 旧 from token 仅用于没有 back 的旧链接；正式入口一律带 back。 */
const FROM_LINKS: Record<string, { href: string; label: string }> = {
  catalog: { href: '/dashboard/catalog', label: '返回商品库' },
  inventory: { href: '/dashboard/inventory', label: '返回商品库存' },
  sync: { href: '/dashboard/sync', label: '返回数据同步' },
};
const DEFAULT_BACK = { href: '/dashboard/inventory', label: '返回商品库存' };

/**
 * 站内返回地址：只接受 `/dashboard/inventory` 或 `/dashboard/catalog` 开头的相对路径；
 * 校验通过后**原样返回**，不解析重拼，避免返回时丢掉 view/source/q/warehouse/market/page/row。
 */
function safeBackHref(raw: string): string {
  if (!raw || raw.length > MAX_BACK_LENGTH) return '';
  if (!raw.startsWith('/dashboard/')) return '';
  if (raw.includes('\\') || /[\u0000-\u001f\u007f]/.test(raw)) return '';
  let url: URL;
  try {
    url = new URL(raw, BACK_ORIGIN);
  } catch {
    return '';
  }
  if (url.origin !== BACK_ORIGIN) return '';
  if (url.username || url.password) return '';
  // 不接受指回本页的 back（避免自己套自己）；其余 catalog/inventory 子路径按白名单放行。
  if (url.pathname === '/dashboard/catalog/mappings' || url.pathname.startsWith('/dashboard/catalog/mappings/')) return '';
  if (!ALLOWED_BACK_PREFIXES.some((prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))) return '';
  return raw;
}

type PageQuery = {
  q: string;
  page: number;
  from: string;
  back: string;
  item: string;
  itemQ: string;
  warehouse: string;
  sku: string;
};

function cleanText(raw: string, maxLength: number): string {
  return raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLength);
}

function parseMappingsQuery(sp: Record<string, string | string[] | undefined>): PageQuery {
  const first = (value: string | string[] | undefined): string => {
    const raw = Array.isArray(value) ? value[0] : value;
    return typeof raw === 'string' ? raw : '';
  };
  const from = cleanText(first(sp.from), 24);
  const item = cleanText(first(sp.item), 64);
  const warehouse = cleanText(first(sp.warehouse), 64);
  return {
    q: cleanText(first(sp.q), MAX_SEARCH_LENGTH),
    page: normalizePageNumber(Number(first(sp.page) || '1')),
    from: from in FROM_LINKS ? from : '',
    back: safeBackHref(first(sp.back)),
    item: isUuid(item) ? item : '',
    itemQ: cleanText(first(sp.itemQ), MAX_SEARCH_LENGTH),
    warehouse: isUuid(warehouse) ? warehouse : '',
    sku: cleanText(first(sp.sku), 120),
  };
}

/** 页面自身 URL（保留 from/back/item/warehouse/sku 等定位上下文，供分页、清空搜索与商品定位使用）。 */
function mappingsHref(state: PageQuery, patch: Partial<PageQuery>): string {
  const next = { ...state, ...patch };
  const params = new URLSearchParams();
  if (next.q) params.set('q', next.q);
  if (next.page > 1) params.set('page', String(next.page));
  if (next.from) params.set('from', next.from);
  if (next.back) params.set('back', next.back);
  if (next.item) params.set('item', next.item);
  if (next.itemQ) params.set('itemQ', next.itemQ);
  if (next.warehouse) params.set('warehouse', next.warehouse);
  if (next.sku) params.set('sku', next.sku);
  const qs = params.toString();
  return qs ? `/dashboard/catalog/mappings?${qs}` : '/dashboard/catalog/mappings';
}

function backLinkOf(query: PageQuery): { href: string; label: string; testId: string } {
  if (query.back) {
    const label = query.back.startsWith('/dashboard/inventory') ? '返回商品库存（原筛选）' : '返回商品库（原筛选）';
    return { href: query.back, label, testId: 'catalog-mappings-back' };
  }
  const fixed = FROM_LINKS[query.from] ?? DEFAULT_BACK;
  return { href: fixed.href, label: fixed.label, testId: 'catalog-mappings-back' };
}

function itemLabelOf(item: { iceCode: string | null; nameCn: string | null } | null | undefined): string {
  if (!item) return '未命名商品';
  return `${item.iceCode ?? '未编号'} · ${item.nameCn ?? '未命名商品'}`;
}

export default async function CatalogMappingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const query = parseMappingsQuery(raw);
  // 定位模式：来源 SKU / 仓库只用于筛选待处理队列；item 用于商品名称与已确认对应。
  const targeted = Boolean(query.sku || query.warehouse);
  // 服务端检索：目标来源 SKU 优先；`q` 只作旧搜索兼容（两者都给时以目标 SKU 为准）。
  const queueSearch = query.sku || query.q;
  const skuKey = query.sku.toLowerCase();
  const back = backLinkOf(query);

  let identity;
  try {
    identity = await requireInventoryAdmin();
  } catch (error) {
    return <ReadFailurePanel kind={classifyReadFailure(error)} backHref={back.href} backLabel={back.label} />;
  }

  const [overviewSettled, queueSettled, itemSettled, locatorSettled] = await Promise.allSettled([
    getInventorySyncOverview(identity),
    getInventoryMappingQueue(identity, {
      search: queueSearch,
      offset: mappingQueueOffset(query.page),
      limit: 20,
    }),
    query.item ? getInventoryItem(identity, query.item, { warehouse: 'all', market: 'all', allWarehouses: true }) : Promise.resolve(null),
    // 只在显式“按商品定位已确认对应”时读取，不额外增加日常首屏读取。
    query.itemQ && !query.item
      ? getInventoryList(identity, { ...DEFAULT_INVENTORY_QUERY, q: query.itemQ, limit: 8 })
      : Promise.resolve(null),
  ]);

  if (overviewSettled.status === 'rejected') {
    return (
      <ReadFailurePanel
        kind={classifyReadFailure(overviewSettled.reason)}
        backHref={back.href}
        backLabel={back.label}
        extra={<p className={styles.readNote}>没有读到同步总览，因此本页不显示待核对/写锁状态，也不提供确认入口。</p>}
      />
    );
  }

  const overview: InventoryOverviewDto = overviewSettled.value;
  const pending = overview.pendingAction;
  const pendingLocked = pendingBlocksWrites(pending);
  const mappingQueue: InventoryMappingQueueDto | null = queueSettled.status === 'fulfilled' ? queueSettled.value : null;
  const queueErrorKind = queueSettled.status === 'rejected' ? classifyReadFailure(queueSettled.reason) : null;
  const mappingQueueError: string | null = queueErrorKind === null
    ? null
    : queueErrorKind === 'forbidden'
      ? '当前账号无权读取待处理对应清单'
      : queueErrorKind === 'unavailable'
        ? '后台库存功能尚未就绪'
        : '网络或后台异常';
  const itemDetail: InventoryItemDetailDto | null = itemSettled.status === 'fulfilled' ? itemSettled.value : null;
  const itemError: string | null = itemSettled.status === 'rejected' ? '该商品的资料读取失败（网络或后台异常）' : null;
  const locatorItems: InventoryListItemDto[] = locatorSettled.status === 'fulfilled' && locatorSettled.value ? locatorSettled.value.items : [];
  const locatorError: string | null = locatorSettled.status === 'rejected' ? '商品定位读取失败（网络或后台异常）' : null;
  const viewer = { actorId: identity.profileUserId, accountId: overview.account.accountId ?? '' };

  // 队列：先用 q=来源 SKU 走服务端检索，再在**本页结果**内限定到目标仓/目标 SKU；不擅自改服务端分页语义。
  const queueItems = mappingQueue?.items ?? [];
  const targetPendingItems = targeted
    ? queueItems.filter((item) => (
      (!query.warehouse || item.warehouseId === query.warehouse)
      && (!query.sku || item.externalSku.trim().toLowerCase() === skuKey)
    ))
    : queueItems;
  const visibleQueue: InventoryMappingQueueDto | null = mappingQueue
    ? { ...mappingQueue, items: targetPendingItems }
    : null;

  // 目标上下文：全部取现有只读数据（总览仓名、商品详情、队列行），取不到就明确说没读到，不自造。
  const targetWarehouse = query.warehouse
    ? overview.warehouses.find((warehouse) => warehouse.id === query.warehouse) ?? null
    : null;
  const targetItemWarehouseRow = query.warehouse
    ? itemDetail?.warehouses.find((row) => row.warehouseId === query.warehouse) ?? null
    : null;
  const targetQueueRow = targeted
    ? queueItems.find((item) => (
      (!query.warehouse || item.warehouseId === query.warehouse)
      && (!query.sku || item.externalSku.trim().toLowerCase() === skuKey)
    )) ?? null
    : null;
  const warehouseName = targetWarehouse?.name ?? targetItemWarehouseRow?.warehouseName ?? targetQueueRow?.warehouseName ?? null;
  const warehouseMarket = targetWarehouse?.market ?? targetItemWarehouseRow?.market ?? targetQueueRow?.market ?? null;
  const targetItemLabel = itemDetail ? itemLabelOf(itemDetail.item) : null;
  const suggestionLabel = targetQueueRow?.suggestion
    ? `${targetQueueRow.suggestion.iceCode ?? '未编号'} · ${targetQueueRow.suggestion.nameCn ?? '未命名商品'}`
    : null;
  const targetMappings = (itemDetail?.mapping ?? []).filter((mapping) => (
    (!query.warehouse || mapping.warehouseId === query.warehouse)
    && (!query.sku || mapping.externalSku.trim().toLowerCase() === skuKey)
  ));
  const latestTargetMapping = targetMappings.length > 0
    ? targetMappings.reduce((latest, mapping) => (mapping.version > latest.version ? mapping : latest), targetMappings[0])
    : null;

  /** 已确认对应区的一句话定位说明：有匹配记录就报版本/状态，没有就明说没有匹配项。 */
  const targetMappingSummary = latestTargetMapping
    ? `${query.sku || query.warehouse ? '目标对应' : '最新对应记录'}：第 ${latestTargetMapping.version} 版 · ${currentMappingStatusLabel(latestTargetMapping.status)}${latestTargetMapping.status === 'confirmed' ? '，可直接重核/停用' : '（非生效状态，历史记录保留）'}。`
    : query.sku
      ? '目标来源 SKU 在该商品的对应记录里没有匹配项；如仍需维护，请看下方全部记录或回到待处理队列。'
      : '';

  const locateStatusText = (() => {
    if (mappingQueueError) return '待处理：清单读取失败，无法判断（不等于没有待处理行）';
    if (!mappingQueue) return '待处理：未读到待处理清单（不显示为 0）';
    if (targetPendingItems.length > 0) return `待处理：本页已定位到 ${targetPendingItems.length} 条目标行`;
    return query.sku ? '待处理：本页未找到该仓该 SKU 的待处理行' : '待处理：本页未找到该仓的待处理行';
  })();

  const confirmedStatusText = (() => {
    if (!query.item) {
      return suggestionLabel
        ? `已确认对应：当前没有标准商品可查；队列建议商品 ${suggestionLabel}（未确认，不作为正式对应）`
        : '已确认对应：未指定标准商品（该来源 SKU 尚未确认对应）';
    }
    if (itemError) return '已确认对应：商品资料读取失败，无法判断（不等于没有对应）';
    if (!itemDetail) return '已确认对应：没有找到该商品（可能不在授权范围）';
    if (latestTargetMapping) {
      return `已确认对应：${targetMappings.length} 条匹配记录（最新第 ${latestTargetMapping.version} 版 · ${currentMappingStatusLabel(latestTargetMapping.status)}）`;
    }
    return query.sku || query.warehouse
      ? `已确认对应：没有该商品在${query.sku ? '该仓该 SKU' : '该仓'}的对应记录（下方列出该商品全部对应记录）`
      : '已确认对应：该商品的对应记录见下方';
  })();

  return (
    <main className={styles.page} data-testid="catalog-mappings-page">
      <header className={styles.pageHeader}>
        <Link className={styles.backLink} href={back.href} data-testid={back.testId}>
          ← {back.label}
        </Link>
        <h1 className={styles.pageTitle}>来源 SKU 对应</h1>
        <p className={styles.pageLead}>
          正式来源 SKU 对应的唯一维护入口：确认、换绑、重核、停用都在这里完成。确认后要等下一次完整同步批次才采用；
          停用/重核会立即退出当前库存汇总，但历史批次保留原事实。本页只维护海外 BigSeller 来源对应；
          国内表格快照是只读快照，不在这里建立 BigSeller 绑定，也不改国内数量。
        </p>
        {query.item || query.warehouse || query.sku ? (
          <section className={styles.itemContext} data-testid="catalog-mappings-target" aria-label="目标定位上下文">
            <div className={styles.itemContextHead}>
              <p className={styles.itemContextTitle}>
                正在定位：
                <strong>
                  {targetItemLabel
                    ?? (itemError
                      ? '商品资料读取失败（不等于没有对应）'
                      : query.item
                        ? '没有找到该商品（可能不在授权范围）'
                        : suggestionLabel
                          ? `队列建议商品 ${suggestionLabel}（尚未确认）`
                          : '未指定标准商品（该来源 SKU 可能尚未确认对应）')}
                </strong>
                {targetItemLabel && suggestionLabel ? (
                  <span className={styles.itemContextMeta}> · 队列建议：{suggestionLabel}（未确认，不作为正式对应）</span>
                ) : null}
              </p>
              <p className={styles.itemContextMeta}>
                仓库：
                <strong>
                  {warehouseName
                    ?? (query.warehouse ? '仓库名称未在本页数据中读到（可能不是参与仓）' : '未指定仓库')}
                </strong>
                {query.warehouse ? ` · 市场 ${warehouseMarket ?? '待确认'}` : ''}
                {' · '}来源 SKU：
                <strong data-testid="catalog-mappings-target-sku">{query.sku || '未指定'}</strong>
              </p>
              <p className={styles.itemContextMeta} data-testid="catalog-mappings-locate-context">
                {locateStatusText}。{confirmedStatusText}。
                定位参数只做只读筛选与定位，不改变权限，也不会自动建立对应；确认仍需在上方「待处理来源」目标行提交商品、单位与理由。
              </p>
            </div>
          </section>
        ) : null}
      </header>

      <PendingRecoveryPanel key={pendingRecoveryKey(pending)} pending={pending} viewer={viewer} />

      <section className={styles.legend} data-testid="catalog-mappings-legend" aria-label="来源对应说明">
        <h2 className={styles.legendTitle}>本页维护哪一种对应</h2>
        <dl className={styles.legendGrid}>
          <div className={styles.legendItem}>
            <dt>BigSeller 正式库存对应（本页唯一维护入口）</dt>
            <dd>按来源账号 × 仓库 × SKU 绑定一个标准商品与单位；需要管理员明确提交理由，确认后下一次完整批次才计入库存。</dd>
          </div>
          <div className={styles.legendItem}>
            <dt>旧 BS / JST 样表「本批采用」</dt>
            <dd>历史批次里已经采用或未采用的记录只在商品详情和批次历史中查看，作为出处与证据；本页不新建、不改写这些历史事实。</dd>
          </div>
          <div className={styles.legendItem}>
            <dt>飞书商品资料来源 / 国内表格快照</dt>
            <dd>
              商品资料（编号、名称、规格等）的更新在
              {' '}
              <Link className={styles.inlineLink} href="/dashboard/catalog/sources">来源核实</Link>
              {' '}
              页处理。国内（聚水潭）表格快照是只读快照：本页不提供 BigSeller 绑定、不改国内数量，也不把国内与海外相加。
            </dd>
          </div>
        </dl>
      </section>

      <section className={styles.section} data-testid="catalog-mappings-queue" aria-label="待处理来源">
        <div className={styles.sectionHeader}>
          <h2>{targeted && warehouseName ? `待处理来源 · ${warehouseName}` : '待处理来源'}</h2>
          <p>
            {targeted
              ? `按${query.sku ? `来源 SKU「${query.sku}」` : '当前检索'}服务端检索${mappingQueue ? `（服务端共 ${mappingQueue.total} 个待处理对）` : ''}${
                query.warehouse ? `，并限定到${warehouseName ? `目标仓「${warehouseName}」` : '目标仓'}` : ''
              }：本页匹配 ${targetPendingItems.length} 条。未对应数量保留但不会计入商品合计；确认后下一次完整批次才采用。`
              : '未对应数量保留但不会计入商品合计；处理完成后仍回到当前搜索与页码。'}
          </p>
        </div>
        <div className={styles.sectionBody}>
          {mappingQueueError ? (
            <p className={styles.inlineError}>待处理清单读取失败：{mappingQueueError}。这不等于没有待处理 SKU；可刷新重试。</p>
          ) : visibleQueue ? (
            <MappingQueue
              queue={visibleQueue}
              mapQ={queueSearch}
              mapPage={query.page}
              runId=""
              pendingLocked={pendingLocked}
              viewer={viewer}
              searchAction="/dashboard/catalog/mappings"
              searchParamName="q"
              pageParamName="page"
              searchPlaceholder="来源 SKU / 仓库 / 建议商品货号或名称"
              hiddenFields={{
                ...(query.from ? { from: query.from } : {}),
                ...(query.back ? { back: query.back } : {}),
                ...(query.item ? { item: query.item } : {}),
              }}
              queueFields={{
                ...(query.from ? { from: query.from } : {}),
                ...(query.back ? { back: query.back } : {}),
                ...(query.item ? { item: query.item } : {}),
                ...(query.warehouse ? { warehouse: query.warehouse } : {}),
                ...(query.sku ? { sku: query.sku } : {}),
              }}
              clearHref={mappingsHref(query, { q: '', page: 1, sku: '', warehouse: '' })}
              locate={targeted ? { sku: query.sku, warehouseId: query.warehouse, warehouseName: warehouseName ?? '' } : null}
            />
          ) : (
            <p className={styles.inlineNotice}>本次没有读到待处理清单；不显示为 0。</p>
          )}
        </div>
      </section>

      <section className={styles.section} data-testid="catalog-mappings-confirmed" aria-label="已确认对应">
        <div className={styles.sectionHeader}>
          <h2>已确认对应</h2>
          <p>按商品查看已生效的对应关系；重核 / 停用 / 换绑需要页面所见版本和理由，与待处理确认是同一套服务端动作。</p>
        </div>
        <div className={styles.sectionBody}>
          <form className={styles.locateForm} method="get" action="/dashboard/catalog/mappings" data-testid="catalog-mappings-locator">
            {query.from ? <input type="hidden" name="from" value={query.from} /> : null}
            {query.back ? <input type="hidden" name="back" value={query.back} /> : null}
            {query.q ? <input type="hidden" name="q" value={query.q} /> : null}
            {query.sku ? <input type="hidden" name="sku" value={query.sku} /> : null}
            {query.warehouse ? <input type="hidden" name="warehouse" value={query.warehouse} /> : null}
            <label className={styles.locateField}>
              <span>按商品定位（货号 / 名称 / 69 编码）</span>
              <input
                type="search"
                name="itemQ"
                defaultValue={query.itemQ}
                maxLength={MAX_SEARCH_LENGTH}
                placeholder="例如 WM0043 或唇泥"
              />
            </label>
            <button type="submit" className={styles.locateButton}>查找商品</button>
          </form>

          {query.itemQ && !query.item ? (
            locatorError ? (
              <p className={styles.inlineError}>{locatorError}；这不等于没有该商品。</p>
            ) : locatorItems.length === 0 ? (
              <p className={styles.inlineNotice}>没有找到匹配“{query.itemQ}”的商品；不会替你猜选，也不会自动新建商品。</p>
            ) : (
              <ul className={styles.locateResults} data-testid="catalog-mappings-locator-results">
                {locatorItems.map((item) => (
                  <li key={item.itemId}>
                    <Link
                      className={styles.locateResult}
                      href={mappingsHref(query, { item: item.itemId, itemQ: '', page: 1 })}
                      data-testid="catalog-mappings-locator-result"
                    >
                      {itemLabelOf(item)}
                      <span className={styles.locateResultMeta}>
                        {(item.markets ?? []).length > 0 ? `市场 ${(item.markets ?? []).join(' / ')}` : '市场待确认'}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )
          ) : null}

          {query.item ? (
            itemError ? (
              <p className={styles.inlineError}>{itemError}；可重试或重新定位商品，不以空列表冒充“没有对应”。</p>
            ) : itemDetail ? (
              <div className={styles.itemContext} data-testid="catalog-mappings-item-context">
                <div className={styles.itemContextHead}>
                  <p className={styles.itemContextTitle}>
                    当前商品：<strong>{itemLabelOf(itemDetail.item)}</strong>
                  </p>
                  <p className={styles.itemContextMeta}>
                    该商品当前有 {itemDetail.mapping.length} 条对应记录（含历史状态）；确认/换绑后由下一次完整批次采用。
                    {targetMappingSummary ? ` ${targetMappingSummary}` : ''}
                  </p>
                </div>
                <ConfirmedMappingList
                  itemId={itemDetail.item.id}
                  itemLabel={itemLabelOf(itemDetail.item)}
                  mappings={itemDetail.mapping}
                  warehouses={overview.warehouses}
                  pendingLocked={pendingLocked}
                  viewer={viewer}
                  targetSku={query.sku || null}
                  targetWarehouseId={query.warehouse || null}
                />
              </div>
            ) : (
              <p className={styles.inlineNotice}>没有找到该商品（可能已变化或不在授权范围）；不显示为“0 条对应”。</p>
            )
          ) : (
            <p className={styles.inlineNotice}>
              {query.sku
                ? `按来源 SKU「${query.sku}」定位：${suggestionLabel ? `队列建议商品 ${suggestionLabel}（未确认）。` : '该来源 SKU 尚未确认标准商品。'}要建立对应，请在上方「待处理来源」队列的目标行选择商品、填写单位与理由后提交；本页不提供第二套编辑器。`
                : '先搜索并选择一个商品，即可查看它的已确认对应并进行重核 / 停用 / 换绑。未指定商品时不列出全部对应关系，避免误操作。'}
            </p>
          )}
        </div>
      </section>

      <footer className={styles.footerNote}>
        <p>
          对应关系版本、操作理由、服务端权限和“确认后等下一次完整批次采用”的规则保持不变；
          结果未知的原请求仍在页面顶部核对，不会自动重发。
        </p>
      </footer>
    </main>
  );
}
