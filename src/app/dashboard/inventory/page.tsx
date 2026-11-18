import type { Metadata } from 'next';
import { ReadFailurePanel } from '@/features/inventory/components/display';
import { InventoryView } from '@/features/inventory/components/inventory-view';
import { InventoryPendingEntry } from '@/features/inventory/components/inventory-pending-entry';
import { domesticIncludedInScope, mergeProductSummary, mergeWarehouseRowsPage } from '@/features/inventory/dual-view';
import {
  classifyReadFailure,
  errorMessageOf,
  INVENTORY_SNAPSHOT_BATCH_PAGE_SIZE,
  INVENTORY_SNAPSHOT_PAGE_SIZE,
  parseInventorySearchParams,
  pendingBlocksWrites,
  type InventoryQueryState,
} from '@/features/inventory/model';
import {
  getInventoryItem,
  getInventoryProductSummary,
  getInventorySnapshotBatches,
  getInventorySnapshotRows,
  getInventorySyncOverview,
  getInventoryWarehouseRows,
  getMemberItemAmounts,
  getSourceBinding,
  requireInventoryReader,
} from '@/features/inventory/server/reads';
import { getInventoryDomesticSnapshot } from '@/features/inventory/server/domestic-reads';
import { requireCatalogAdmin } from '@/features/catalog/authorization';
import { catalogRepository } from '@/features/catalog/repository';
import { adoptedUnitCostFromFinancial } from '@/features/catalog/local-display/adopted-price';
import type {
  InventoryDomesticSnapshotDto,
  InventoryItemDetailDto,
  InventoryOverviewDto,
  InventoryProductSummaryDto,
  InventorySnapshotBatchesDto,
  InventorySnapshotRowsDto,
  InventoryWarehouseDto,
  InventoryWarehouseRowDto,
  InventoryWarehouseRowsDto,
  SourceBindingDto,
} from '@/features/inventory/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const metadata: Metadata = { title: '商品库存 · 双视图' };

function toUrlSearchParams(sp: Record<string, string | string[] | undefined>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) {
    if (value === undefined) continue;
    const first = Array.isArray(value) ? value[0] : value;
    if (first !== undefined) params.set(key, first);
  }
  return params;
}

/** 详情读取失败的短原因：不把 SQL/路径带到页面；“没找到该商品”不是网络失败。 */
function shortFailure(error: unknown): string | null {
  const message = errorMessageOf(error);
  if (/INVENTORY_ITEM_NOT_FOUND|INVENTORY_INVALID_INPUT/.test(message)) return null;
  const kind = classifyReadFailure(error);
  if (kind === 'forbidden') return '当前账号无权查看该商品';
  if (kind === 'unavailable') return '后台库存功能尚未就绪';
  return '网络或传输异常';
}

/**
 * 商品库存页：默认「仓库明细」，同一入口切「商品汇总」。
 *
 * - 视图/来源范围/搜索/仓库/市场下钻/分页/详情全部由 URL 还原（刷新、前进后退不丢上下文）；
 * - 来源范围同时约束查询、行集合、列与计数：仅国内时只有国内有效商品（118），不混入海外-only 商品；
 * - 海外数量来自每仓最后完整成功批次（服务端读模型）；国内数量来自冻结聚水潭表格快照（只读适配）；
 * - 两个来源分开计时、分开计数，不跨来源相加；失败/缺失/未对应都不写 0；
 * - 详情只有一个入口：URL 带 item/row 时首屏即渲染可见详情弹层，点击行时先在客户端立即打开再由 URL 还原数据。
 */
export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;

  let reader;
  try {
    reader = await requireInventoryReader();
  } catch (error) {
    return <ReadFailurePanel kind={classifyReadFailure(error)} backHref="/dashboard/catalog" backLabel="返回 ICE 商品库" />;
  }
  const identity = reader.identity;
  const isAdmin = reader.isAdmin;
  const parsed = parseInventorySearchParams(toUrlSearchParams(sp));
  // 国内冻结快照本包仍只给管理员看：成员的来源范围固定为「仅海外」（不显示国内，也不请求国内数据）。
  const query: InventoryQueryState = isAdmin
    ? parsed
    : { ...parsed, source: parsed.source === 'overseas' ? parsed.source : 'overseas' };

  // 估算货值：管理员沿用 catalog 的 amount:read；成员只用角色里的「库存金额查看」，
  // 由数据库按授权仓商品返回采用成本（不再借用管理员专用的全商品成本查询）。
  // 成本只在服务端参与排序与当前页行货值计算；页面不接收单位成本表。
  // 无金额权限时不读成本、不传该列（merge 不收到 costMap，行上也不出现货值字段）。
  let amountAllowed = false;
  if (isAdmin) {
    try {
      await requireCatalogAdmin('amount:read');
      amountAllowed = true;
    } catch {
      amountAllowed = false;
    }
  } else {
    amountAllowed = reader.canViewAmount;
  }
  const inventoryCostMap: Record<string, string> = {};
  if (amountAllowed && !query.snapshot) {
    try {
      const batch = isAdmin
        ? await catalogRepository.baselineAmountsMap(identity)
        : await getMemberItemAmounts(identity);
      for (const [itemId, financial] of batch) {
        const cost = adoptedUnitCostFromFinancial(financial);
        if (cost.state === 'priced') inventoryCostMap[itemId] = cost.amountCny;
      }
    } catch {
      /* 成本读取失败：列保留，金额按缺成本显示“—”。 */
    }
  }

  // 国内表格快照没有仓库/市场维度：选择「仅国内」时不再把海外仓/市场条件带进国内查询。
  const domesticScope = query.source === 'domestic';
  const warehouseFilter = domesticScope ? 'all' : query.warehouse;
  const marketFilter = domesticScope ? 'all' : query.market;

  const [warehouseSettled, summarySettled, domesticSettled, overviewSettled] = await Promise.allSettled([
    query.view === 'warehouse' && !query.snapshot
      ? getInventoryWarehouseRows(identity, { q: query.q, warehouse: warehouseFilter, market: marketFilter })
      : Promise.resolve(null),
    query.view === 'product' && !query.snapshot
      // 商品汇总在服务端按完整筛选范围计算；这里取全量后与国内快照合并，再统一切页。
      ? getInventoryProductSummary(identity, {
        q: query.q,
        warehouse: warehouseFilter,
        market: marketFilter,
        limit: 200,
        offset: 0,
      })
      : Promise.resolve(null),
    // 历史快照只读已发布批次，不合并国内冻结快照，也不影响当前库存视图。
    // 国内快照只对管理员读取；成员页面不请求、不显示国内数据。
    query.snapshot || !isAdmin ? Promise.resolve(null) : getInventoryDomesticSnapshot(identity),
    isAdmin ? getInventorySyncOverview(identity) : Promise.resolve(null),
  ]);

  const viewFailure = query.view === 'warehouse' ? warehouseSettled : summarySettled;
  if (viewFailure.status === 'rejected') {
    const message = errorMessageOf(viewFailure.reason);
    const invalidFilter = /INVENTORY_WAREHOUSE_UNKNOWN/.test(message);
    return (
      <ReadFailurePanel
        kind={classifyReadFailure(viewFailure.reason)}
        backHref="/dashboard/catalog"
        backLabel="返回 ICE 商品库"
        extra={(
          <p style={{ margin: '10px 0 0', color: '#8d98a8', fontSize: '12px' }}>
            {invalidFilter
              ? '所选仓库不在当前账号的仓库清单里；请清空筛选后重试。'
              : '库存读模型没有读到，因此不显示商品数量或“没有库存”的结论。'}
          </p>
        )}
      />
    );
  }

  const overview: InventoryOverviewDto | null = overviewSettled.status === 'fulfilled' ? overviewSettled.value : null;

  // 可见仓库：管理员取同步范围里的参与仓；成员取账号被授予的仓（服务端已按授权范围返回）。
  const warehouses: InventoryWarehouseDto[] = isAdmin
    ? (overview?.warehouses ?? [])
    : reader.access.warehouses.map((warehouse) => ({
      id: warehouse.id,
      externalId: warehouse.externalId,
      name: warehouse.name,
      status: 'confirmed',
      market: warehouse.market,
    }));
  const scopeEmpty = isAdmin ? overview?.scope.empty === true : reader.access.scopeEmpty;

  // 历史快照：只读选定海外仓的已发布批次；默认该仓最新批次。
  // 明确 snapBatch 时独立读取这一批并核对所属仓，不依赖它是否落在当前批次列表页；
  // 不存在/仓库不一致时不返回其他批次的数量，由页面给出明确提示。
  // 该视图不读当前库存列表/国内冻结快照，也不会改写它们的筛选。
  const snapshotWarehouses = warehouses.filter((warehouse) => warehouse.status === 'confirmed');
  // 书签里的仓已被收回授权：不要静默改选第一个授权仓，明确提示重新选仓。
  // 只有首次打开（URL 未指定仓库）才默认选中一个授权仓。
  const explicitSnapshotWarehouse = Boolean(query.snapWarehouse);
  const requestedSnapshotWarehouse = snapshotWarehouses.find((warehouse) => warehouse.id === query.snapWarehouse) ?? null;
  let snapshotWarehouseId = requestedSnapshotWarehouse?.id ?? '';
  let snapshotWarehouseSelectionLost = false;
  let snapshotBatches: InventorySnapshotBatchesDto | null = null;
  let snapshotDetailResult: InventorySnapshotRowsDto | null = null;
  let snapshotBatchPage = query.snapBPage > 0 ? query.snapBPage : 1;
  let snapshotBatchesError: string | null = null;
  let snapshotDetailError: string | null = null;
  let snapshotBatchNotice: {
    kind: 'not_found' | 'warehouse_mismatch' | 'no_account';
    batchWarehouseId: string;
    batchWarehouseName: string;
    observationAt: string;
  } | null = null;
  if (query.snapshot) {
    const overviewFailed = isAdmin && overviewSettled.status === 'rejected';
    if (overviewFailed) {
      snapshotBatchesError = '仓库清单读取失败';
    } else if (warehouses.length === 0) {
      // 成员没有授权仓时不是“读取失败”，明确说明没有可用仓库。
      snapshotBatchesError = isAdmin ? '参与仓库为空' : '暂无授权的仓库';
    } else {
      if (query.snapBatch) {
        try {
          const detail = await getInventorySnapshotRows(identity, {
            // 直链只有批次编号时 warehouseId=null：只校验账号归属，再由批次自身确定仓库。
            warehouseId: requestedSnapshotWarehouse?.id ?? null,
            batchId: query.snapBatch,
            search: query.snapQ,
            page: query.snapPage,
            limit: INVENTORY_SNAPSHOT_PAGE_SIZE,
          });
          snapshotDetailResult = detail.ok ? detail : null;
          if (!detail.ok) {
            snapshotBatchNotice = {
              kind: detail.status === 'warehouse_mismatch' || detail.status === 'no_account'
                ? detail.status
                : 'not_found',
              batchWarehouseId: detail.batchWarehouseId ?? '',
              batchWarehouseName: detail.batchWarehouseName ?? '',
              observationAt: detail.batchObservationAt ?? '',
            };
          }
          if (detail.ok && detail.batch) snapshotWarehouseId = detail.batch.warehouseId;
        } catch (error) {
          snapshotDetailError = shortFailure(error) ?? '明细读取失败';
        }
      }
      if (!snapshotWarehouseId) {
        if (explicitSnapshotWarehouse) {
          snapshotWarehouseSelectionLost = true;
        } else {
          snapshotWarehouseId = snapshotWarehouses[0]?.id ?? '';
        }
      }
      if (snapshotWarehouseId) {
        // 直链批次不在第一批次页时，列表翻到它所在页：页面选择与直链看到的是同一批。
        const rankPage = snapshotDetailResult?.batchRank
          ? Math.ceil(snapshotDetailResult.batchRank / INVENTORY_SNAPSHOT_BATCH_PAGE_SIZE)
          : 1;
        // 未指定列表页（snapBPage=0）才按所选批次所在页自动定位；
        // 显式第 1 页（用户点“更新批次”）必须回到第 1 页，不能再次被批次位置拉回。
        const requestedBatchPage = query.snapBPage > 0 ? query.snapBPage : rankPage;
        try {
          snapshotBatches = await getInventorySnapshotBatches(identity, {
            warehouseId: snapshotWarehouseId,
            page: requestedBatchPage,
            limit: INVENTORY_SNAPSHOT_BATCH_PAGE_SIZE,
          });
          // 服务端会把超出末页的偏移回退到最后一页，页码以返回的 offset 为准。
          snapshotBatchPage = Math.floor(snapshotBatches.offset / Math.max(1, snapshotBatches.limit)) + 1;
        } catch (error) {
          snapshotBatchesError = shortFailure(error) ?? '批次读取失败';
        }
        if (!query.snapBatch) {
          // 未指定批次 = 默认最新批次；列表翻到更早页只影响左栏，不换右侧详情。
          let latestBatchId = snapshotBatches?.batches[0]?.batchId ?? '';
          let newestResolved = true;
          if (snapshotBatchPage > 1) {
            try {
              const newest = await getInventorySnapshotBatches(identity, {
                warehouseId: snapshotWarehouseId,
                page: 1,
                limit: 1,
              });
              latestBatchId = newest.batches[0]?.batchId ?? '';
            } catch (error) {
              newestResolved = false;
              snapshotDetailError = shortFailure(error) ?? '明细读取失败';
            }
          }
          if (newestResolved && latestBatchId) {
            try {
              const detail = await getInventorySnapshotRows(identity, {
                warehouseId: snapshotWarehouseId,
                batchId: latestBatchId,
                search: query.snapQ,
                page: query.snapPage,
                limit: INVENTORY_SNAPSHOT_PAGE_SIZE,
              });
              snapshotDetailResult = detail.ok ? detail : null;
            } catch (error) {
              snapshotDetailError = shortFailure(error) ?? '明细读取失败';
            }
          }
        }
      }
    }
  }

  // 「待处理」入口不再在此同步读清单或计数：徽标数量由客户端挂载后异步读取，
  // 完整清单由弹窗打开时懒加载。这样切换「仓库明细 / 商品汇总」时先看到视图和数据，
  // 不会为 5 页队列读取（约 1s）等待。绑定/待处理都是管理员维护动作，成员不渲染入口。
  const viewer = isAdmin ? { actorId: identity.profileUserId, accountId: overview?.account.accountId ?? '' } : null;
  const pendingEntry = isAdmin ? (
    <InventoryPendingEntry
      viewer={{ actorId: identity.profileUserId, accountId: overview?.account.accountId ?? '' }}
      pendingLocked={pendingBlocksWrites(overview?.pendingAction ?? null)}
      autoOpen={query.pending === 'open'}
    />
  ) : null;

  const domestic: InventoryDomesticSnapshotDto | null = domesticSettled.status === 'fulfilled' ? domesticSettled.value : null;
  const overseasRows: InventoryWarehouseRowsDto | null = warehouseSettled.status === 'fulfilled' ? warehouseSettled.value : null;
  const productSummary: InventoryProductSummaryDto | null = summarySettled.status === 'fulfilled' ? summarySettled.value : null;

  const warehouseRows = query.view === 'warehouse'
    ? mergeWarehouseRowsPage({
      query: { ...query, warehouse: warehouseFilter, market: marketFilter },
      overseas: overseasRows,
      domestic,
      costMap: amountAllowed ? inventoryCostMap : undefined,
    })
    : null;
  const mergedSummary = query.view === 'product' && productSummary
    ? mergeProductSummary({
      query: { ...query, warehouse: warehouseFilter, market: marketFilter },
      summary: productSummary,
      domestic,
      costMap: amountAllowed ? inventoryCostMap : undefined,
    })
    : null;

  // 详情目标行：优先 URL 的 row（来源+仓+SKU），其次 item（商品汇总/商品详情）。
  let detailRow: InventoryWarehouseRowDto | null = null;
  if (warehouseRows) {
    if (query.row) detailRow = warehouseRows.rows.find((row) => row.rowKey === query.row) ?? null;
    if (!detailRow && query.item) detailRow = warehouseRows.rows.find((row) => row.itemId === query.item) ?? null;
  }

  // 国内详情只用国内冻结记录（原数量/编码/文件日期），不混入海外各仓，也不提供 BS 对应动作。
  // 取数与显示复用列表的有效范围：仅国内可以；全部来源只在未限定海外仓/市场时分区展示；
  // 仅海外、或任意明确的海外仓/市场（含未知市场）筛选时不带国内，与列表/列/计数同一判断。
  const domesticDetailRows = query.item
    && domestic
    && domesticIncludedInScope({ source: query.source, warehouse: warehouseFilter, market: marketFilter })
    ? (domestic.rows ?? []).filter((row) => row.itemId === query.item)
    : [];

  // 仓库行详情直接用行内事实（数量/占用/来源时间/状态），不再多读一次；
  // 商品汇总行详情才需要按标准商品读取当前范围的各仓库存。旧式 ?item= 直链（不在当前页）也走这条。
  const needsItemDetail = Boolean(query.item) && !detailRow && !domesticScope;
  let itemDetail: InventoryItemDetailDto | null = null;
  let itemError: string | null = null;
  if (needsItemDetail) {
    try {
      itemDetail = await getInventoryItem(identity, query.item, {
        warehouse: warehouseFilter,
        market: marketFilter,
        allWarehouses: false,
      });
    } catch (error) {
      itemError = shortFailure(error);
    }
  }

  const warehouseStates = overseasRows?.warehouses ?? productSummary?.warehouses ?? [];

  // 仓库行详情：读取固定来源（仓 + 原 SKU）的当前绑定，供详情内直接绑定/更换商品。
  // 国内行只读冻结快照，不提供 BigSeller 绑定；读取失败显示“可重试”，不当作“未绑定”。
  const bindingTarget = isAdmin && detailRow && detailRow.source === 'bigseller' && detailRow.warehouseId
    ? detailRow : null;
  let sourceBinding: SourceBindingDto | null = null;
  let sourceBindingError: string | null = null;
  if (bindingTarget?.warehouseId) {
    try {
      const binding = await getSourceBinding(identity, bindingTarget.warehouseId, bindingTarget.externalSku);
      if (binding) {
        sourceBinding = binding;
      } else {
        // 读不到不等于“未绑定”：显示可重试，避免把未知写成未绑定。
        sourceBindingError = '没有读取到该来源的绑定信息';
      }
    } catch (error) {
      sourceBindingError = shortFailure(error) ?? '绑定信息读取失败';
    }
  }

  // 恢复入口只在有未完成原请求/本地未知记录时出现；身份用于判断本地记录是否属于当前管理员。
  // 成员不渲染恢复/绑定/待处理入口（这些是管理员维护动作），viewer 因此为 null。
  return (
    <InventoryView
      query={query}
      effectiveFilters={{ warehouse: warehouseFilter, market: marketFilter }}
      warehouses={warehouses}
      scopeEmpty={scopeEmpty}
      allowDomestic={isAdmin}
      warehouseRows={warehouseRows}
      productSummary={mergedSummary}
      warehouseStates={warehouseStates}
      domestic={domestic}
      domesticDetailRows={domesticDetailRows}
      detailRow={detailRow}
      itemDetail={itemDetail}
      itemError={itemError}
      pending={overview?.pendingAction ?? null}
      pendingEntry={pendingEntry}
      viewer={viewer}
      sourceBinding={sourceBinding}
      sourceBindingError={sourceBindingError}
      bindingReady={Boolean(bindingTarget)}
      showValue={amountAllowed}
      snapshot={{
        warehouseId: snapshotWarehouseId,
        warehouseSelectionLost: snapshotWarehouseSelectionLost,
        batches: snapshotBatches?.batches ?? [],
        batchTotal: snapshotBatches?.batchTotal ?? 0,
        batchPage: snapshotBatchPage,
        batchLimit: snapshotBatches?.limit || INVENTORY_SNAPSHOT_BATCH_PAGE_SIZE,
        detail: snapshotDetailResult,
        batchNotice: snapshotBatchNotice,
        batchesError: snapshotBatchesError,
        detailError: snapshotDetailError,
      }}
    />
  );
}
