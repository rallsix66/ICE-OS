import Link from 'next/link';
import type { ReactNode } from 'react';
import { ArrowRight, RefreshCw, Table2 } from 'lucide-react';
import { PageHeading } from '@/ui/ice-v4/data-surface';
import shared from '@/ui/ice-v4/data-surface.module.css';
import styles from './sync-view.module.css';
import { StatusPill } from './display';
import { SyncControls } from './sync-controls';
import {
  buildSyncUrl,
  formatQuantity,
  formatTimestamp,
  isActiveRunStatus,
  pendingBlocksWrites,
  runStatusDisplay,
  selectedScopeWarehouseIds,
  type SyncQueryState,
  type Tone,
} from '../model';
import type {
  InventoryDomesticSnapshotDto,
  InventoryOverviewDto,
  InventoryWarehouseReadStateV2Dto,
} from '../types';
import type { LocalViewerIdentity } from '../client-pending';

/**
 * /dashboard/sync 页面主体（四张来源卡）：
 * 海外库存 / 国内库存 / 物流在途 / 商品库更新，桌面 2×2、窄屏一列。
 * 首页只保留来源状态与既有业务操作；商品库更新的差异、待人工确认与采用记录收进同一弹窗。
 * 写动作仍由客户端组件完成，统一走 pending 登记 → 原动作 → 结果未知核对流程。
 */

/** 最近成功批次时间：取逐仓最后完整成功批次时间（lastSuccessAt）的最新一条；没有成功批次返回 null。 */
function latestBatchSuccessAt(states: InventoryWarehouseReadStateV2Dto[] | null): string | null {
  let latest: string | null = null;
  let latestTime = Number.NEGATIVE_INFINITY;
  for (const state of states ?? []) {
    if (!state.lastSuccessAt) continue;
    const time = Date.parse(state.lastSuccessAt);
    if (!Number.isFinite(time)) continue;
    if (time > latestTime) {
      latest = state.lastSuccessAt;
      latestTime = time;
    }
  }
  return latest;
}

export function SyncView({
  overview,
  query,
  warehouseStates,
  warehouseStatesError,
  domesticSnapshot,
  viewer,
  shipmentCard,
  productLibraryCard,
}: {
  overview: InventoryOverviewDto;
  query: SyncQueryState;
  /** 逐仓读取状态（每仓最后完整成功批次）；null = 未读到，不显示 0。 */
  warehouseStates: InventoryWarehouseReadStateV2Dto[] | null;
  warehouseStatesError: string | null;
  /** 国内聚水潭冻结表格快照（只读；null = 未读到，不显示 0/假成功）。 */
  domesticSnapshot: InventoryDomesticSnapshotDto | null;
  /** 服务端会话身份（页面传入）：本地保留原请求的归属判断与本地记录绑定；客户端不自行生成。 */
  viewer: LocalViewerIdentity | null;
  /** 物流在途来源卡（读取状态统一在本页，与其它来源同网格）。 */
  shipmentCard?: ReactNode;
  /** 商品库更新卡（真实差异 + 待人工确认 + 采用记录收进弹窗）。 */
  productLibraryCard?: ReactNode;
}) {
  const selectedIds = selectedScopeWarehouseIds(overview);
  const runs = overview.runs;
  const pending = overview.pendingAction;
  const pendingLocked = pendingBlocksWrites(pending);
  const activeRuns = runs.filter((run) => isActiveRunStatus(run.status));
  const activeRun = activeRuns.length > 0
    ? { id: activeRuns[0].id, statusLabel: runStatusDisplay(activeRuns[0].status).label }
    : null;

  /* 卡片「最近成功」= 最近一次成功批次时间；逐仓读不到时退回「最后全部成功」时间。 */
  const latestBatchSuccess = latestBatchSuccessAt(warehouseStates) ?? overview.scopeLastAllSuccessAt ?? null;
  const lastSuccessText = latestBatchSuccess
    ? (formatTimestamp(latestBatchSuccess) || '时间未记录')
    : '尚无成功记录';
  const lastSuccessAlert = !latestBatchSuccess && warehouseStatesError ? '逐仓状态读取失败' : null;

  /* 国内冻结快照：只读卡片；成功导入记录时间当前没有可读记录 → 「暂无记录」，不写 0。 */
  const domesticAvailable = domesticSnapshot?.available === true;
  const domesticDates = domesticAvailable
    ? (domesticSnapshot?.fileDates ?? []).map((entry) => entry.fileDate).filter(Boolean).sort()
    : [];
  const domesticLatestFile = domesticDates.length > 0
    ? (domesticSnapshot?.fileDates ?? []).find((entry) => entry.fileDate === domesticDates[domesticDates.length - 1]) ?? null
    : null;
  const domesticStatus: { label: string; tone: Tone } = domesticAvailable
    ? { label: '快照可用', tone: 'green' }
    : { label: '未读取', tone: 'amber' };

  const domesticCard = (
    <section
      className={`${styles.sourceCard} ${styles.cardDomestic}`}
      data-testid="sync-source-row-domestic"
      data-stagger="1"
      aria-label="国内库存"
    >
      <header className={styles.cardHead}>
        <span className={styles.cardIcon} aria-hidden>
          <Table2 size={18} strokeWidth={1.8} />
        </span>
        <div className={styles.cardIdentity}>
          <h2>国内库存</h2>
          <span className={styles.cardPurpose}>聚水潭 · 表格导入</span>
        </div>
        <div className={styles.cardStatus} data-testid="sync-source-domestic-status">
          <StatusPill tone={domesticStatus.tone}>{domesticStatus.label}</StatusPill>
        </div>
      </header>
      <dl className={styles.cardFacts}>
        <div data-testid="sync-source-domestic-last-success">
          <dt>最近成功</dt>
          <dd>
            暂无记录
            {domesticAvailable && domesticLatestFile ? (
              <small className={styles.factSub}>
                原文件 {domesticLatestFile.fileDate} · {formatQuantity(domesticSnapshot?.recordCount ?? 0)} 条
              </small>
            ) : null}
          </dd>
        </div>
        <div data-testid="sync-source-domestic-next-plan">
          <dt>下次同步</dt>
          <dd>手动导入</dd>
        </div>
      </dl>
      <div className={styles.cardActions}>
        <Link className={styles.secondaryButton} href="/dashboard/inventory?source=domestic" data-testid="sync-source-domestic-link">
          <ArrowRight size={14} aria-hidden />
          查看库存明细
        </Link>
      </div>
    </section>
  );

  return (
    <div className={styles.page} data-testid="sync-page">
      <PageHeading
        title="数据同步"
        actions={
          // 用原生链接刷新当前状态；不改变设置，也不触发同步。
          <a
            className={`${shared.button} ${shared.buttonIcon}`}
            href={buildSyncUrl(query)}
            aria-label="刷新状态"
            title="刷新状态"
            data-testid="sync-refresh-status"
          >
            <RefreshCw size={16} strokeWidth={1.8} aria-hidden />
          </a>
        }
      />

      <section data-testid="sync-status-overview" aria-label="数据来源同步状态">
        <SyncControls
          key={`sync-controls-v${overview.scope.version}-c${overview.scope.warehouseCount}-e${overview.scope.empty ? 1 : 0}`}
          overview={overview}
          selectedWarehouseIds={selectedIds}
          activeRun={activeRun}
          pendingLocked={pendingLocked}
          viewer={viewer}
          lastSuccessText={lastSuccessText}
          lastSuccessAlert={lastSuccessAlert}
          domesticCard={domesticCard}
          shipmentCard={shipmentCard ?? null}
          productLibraryCard={productLibraryCard ?? null}
        />
      </section>
    </div>
  );
}
