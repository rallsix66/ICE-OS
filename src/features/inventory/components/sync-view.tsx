import Link from 'next/link';
import styles from './sync-view.module.css';
import { StatusPill } from './display';
import { SyncControls } from './sync-controls';
import { PendingRecoveryPanel } from './pending-recovery';
import {
  accountIdentityLabel,
  buildSyncUrl,
  errorCodeLabel,
  fileValidationStatusLabel,
  formatQuantity,
  formatTimestamp,
  isActiveRunStatus,
  loginStateDisplay,
  parseStatusLabel,
  pendingBlocksWrites,
  pendingRecoveryKey,
  quantityHeaderDisplay,
  runStatusDisplay,
  runWarehouseStatusLabel,
  scopeDisplay,
  selectedScopeWarehouseIds,
  summarizeWarehouseCounts,
  timestampOr,
  triggerLabel,
  warehouseStateLabel,
  warehouseSuccessRows,
  workerStateDisplay,
  type SyncQueryState,
  type Tone,
} from '../model';
import type {
  InventoryDomesticSnapshotDto,
  InventoryOverviewDto,
  InventoryRunDetailDto,
  InventoryRunHeaderColumnDto,
  InventoryWarehouseReadStateV2Dto,
} from '../types';
import type { LocalViewerIdentity } from '../client-pending';

/**
 * /dashboard/sync 页面主体（R6 紧凑来源总览）：
 * 首屏按数据来源一行展示状态、最后成功数据时间、下次计划与关键操作；
 * 逐仓结果、任务历史、失败详情与原请求核对收进同一来源的「详情」面板；
 * 频率、参与仓库、保存与后台诊断收进「设置」面板（诊断再按需展开）。
 * 写动作仍由客户端组件完成，统一走 pending 登记 → 原动作 → 结果未知核对流程。
 */

/** 选中任务详情的锚点：真实点击/刷新后由浏览器直接把该详情带入视口（不靠 DOM 可见性判断）。 */
const RUN_DETAIL_ANCHOR = 'sync-run-detail';

function headerNames(header: Array<InventoryRunHeaderColumnDto | string> | null | undefined): string[] {
  if (!Array.isArray(header)) return [];
  return header
    .map((entry) => (typeof entry === 'string' ? entry : (entry?.name ?? '')))
    .map((name) => String(name).trim())
    .filter(Boolean);
}

function fingerprintPrefix(file: NonNullable<InventoryRunDetailDto['file']> | null | undefined): string {
  const raw = (file?.sha256Prefix ?? file?.sha256 ?? '').trim();
  return raw ? raw.slice(0, 12) : '';
}

function columnIssueText(validation: InventoryRunDetailDto['fileValidation']): string | null {
  if (!validation) return null;
  const parts: string[] = [];
  if ((validation.missingColumns ?? []).length > 0) parts.push(`缺列：${validation.missingColumns?.join('、')}`);
  if ((validation.ambiguousColumns ?? []).length > 0) parts.push(`歧义列：${validation.ambiguousColumns?.join('、')}`);
  if ((validation.duplicateColumns ?? []).length > 0) parts.push(`重复列：${validation.duplicateColumns?.join('、')}`);
  return parts.length > 0 ? parts.join('；') : null;
}

/** 逐仓结果里“文件保存成功”与“SKU 全部已对应”分开表达，不互相冒充。 */
interface WarehouseProgressRow {
  key: string;
  name: string;
  resultLabel: string;
  batchText: string | null;
  dataTime: string | null;
  publishTime: string | null;
  pendingMappingRows: number | null;
  adoptedRows: number | null;
  failed: boolean;
  stale: boolean;
  errorCode: string | null;
  note: { label: string; tone: Tone; note: string | null };
}

function pendingMappingCell(row: WarehouseProgressRow): { text: string; alert: boolean } {
  if (row.pendingMappingRows === null || row.pendingMappingRows === undefined) return { text: '—', alert: false };
  if (row.pendingMappingRows > 0) {
    return {
      text: row.adoptedRows && row.adoptedRows > 0 && !row.failed && !row.stale
        ? `同步成功，另有 ${formatQuantity(row.pendingMappingRows)} 条来源待对应`
        : `另有 ${formatQuantity(row.pendingMappingRows)} 条来源待对应`,
      alert: true,
    };
  }
  return { text: '已全部对应', alert: false };
}

/** 历史任务详情的逐仓小结（不依赖 run.summary 的额外字段形态）。 */
function runWarehouseBreakdown(warehouses: NonNullable<InventoryRunDetailDto['warehouses']>): string {
  if (warehouses.length === 0) return '没有逐仓结果';
  const published = warehouses.filter((warehouse) => warehouse.status === 'success' || warehouse.status === 'published').length;
  const failed = warehouses.filter((warehouse) => warehouse.status === 'failed').length;
  const blocked = warehouses.filter((warehouse) => warehouse.status === 'blocked').length;
  return `发布 ${published} 仓 · 失败 ${failed} 仓 · 阻断 ${blocked} 仓`;
}

function FactList({ rows }: { rows: Array<{ label: string; value: string; hint?: string }> }) {
  return (
    <dl className={styles.factList}>
      {rows.map((row) => (
        <div key={row.label}>
          <dt>{row.label}</dt>
          <dd>
            {row.value}
            {row.hint ? <small>{row.hint}</small> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** 最后成功数据时间：取逐仓最后完整成功批次的来源观测时间；读不到时退回范围内最后全部成功时间。 */
function latestObservationAt(states: InventoryWarehouseReadStateV2Dto[] | null): string | null {
  let latest: string | null = null;
  let latestTime = Number.NEGATIVE_INFINITY;
  for (const state of states ?? []) {
    const raw = state.observationAt ?? state.lastSuccessAt;
    if (!raw) continue;
    const time = Date.parse(raw);
    if (!Number.isFinite(time)) continue;
    if (time > latestTime) {
      latest = raw;
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
  runDetail,
  runError,
  domesticSnapshot,
  viewer,
}: {
  overview: InventoryOverviewDto;
  query: SyncQueryState;
  /** 逐仓读取状态（每仓最后完整成功批次）；null = 未读到，不显示 0。 */
  warehouseStates: InventoryWarehouseReadStateV2Dto[] | null;
  warehouseStatesError: string | null;
  /** ?run= 时才有的历史任务详情；日常首屏不读。 */
  runDetail: InventoryRunDetailDto | null;
  runError: string | null;
  /** 国内聚水潭冻结表格快照（只读；null = 未读到，不显示 0/假成功）。 */
  domesticSnapshot: InventoryDomesticSnapshotDto | null;
  /** 服务端会话身份（页面传入）：本地保留原请求的归属判断与本地记录绑定；客户端不自行生成。 */
  viewer: LocalViewerIdentity | null;
}) {
  const account = overview.account;
  const login = loginStateDisplay(account.status);
  const worker = workerStateDisplay(overview.worker);
  const selectedIds = selectedScopeWarehouseIds(overview);
  const runs = overview.runs;
  const scope = scopeDisplay(overview.scope);
  const pending = overview.pendingAction;
  const pendingLocked = pendingBlocksWrites(pending);
  const activeRuns = runs.filter((run) => isActiveRunStatus(run.status));
  const activeRun = activeRuns.length > 0
    ? { id: activeRuns[0].id, statusLabel: runStatusDisplay(activeRuns[0].status).label }
    : null;
  const latestRun = overview.lastRun ?? runs[0] ?? null;
  const latestDisplay = latestRun ? runStatusDisplay(latestRun.status) : null;
  const detailStatus = runDetail ? runStatusDisplay(runDetail.status) : null;
  const scopeLabels = (overview.scope.labels ?? []).filter(Boolean);
  const scopeVersion = Number(overview.scope.version ?? 0) || 0;
  /** 逐仓表：优先用服务端逐仓读取状态；读不到时退回总览字段并明确标注。 */
  const progressRows: WarehouseProgressRow[] = warehouseStates
    ? warehouseStates.map((state) => ({
      key: state.warehouseId,
      name: state.name,
      resultLabel: state.latestRunStatus ? runWarehouseStatusLabel(state.latestRunStatus) : '尚无记录',
      batchText: state.lastSuccessAt ? `上一成功批次采用 ${formatQuantity(state.adoptedRows)} / 共 ${formatQuantity(state.batchRows)} 行` : null,
      dataTime: state.observationAt ?? state.lastSuccessAt,
      publishTime: state.publishedAt,
      pendingMappingRows: state.pendingMappingRows,
      adoptedRows: state.adoptedRows,
      failed: state.failed,
      stale: state.stale,
      errorCode: state.lastErrorCode,
      note: warehouseStateLabel({
        lastSuccessAt: state.lastSuccessAt,
        lastRunStatus: state.latestRunStatus,
        failed: state.failed,
        stale: state.stale,
      }),
    }))
    : warehouseSuccessRows(overview).map((row) => ({
      key: row.warehouseId,
      name: row.name,
      resultLabel: row.lastRunStatus ? runWarehouseStatusLabel(row.lastRunStatus) : '尚无记录',
      batchText: null,
      dataTime: row.lastSuccessAt,
      publishTime: row.lastPublishAt,
      pendingMappingRows: null,
      adoptedRows: null,
      failed: row.failed,
      stale: row.stale,
      errorCode: row.lastErrorCode,
      note: warehouseStateLabel(row),
    }));

  /* 首屏来源行需要的事实：最后成功数据时间（只在读取失败时给一行短状态）。 */
  const latestObservation = latestObservationAt(warehouseStates);
  const lastDataTime = latestObservation ?? overview.scopeLastAllSuccessAt ?? null;
  const lastDataText = lastDataTime ? (formatTimestamp(lastDataTime) || '时间未记录') : '尚无成功数据';
  const lastDataAlert = latestObservation
    ? null
    : (warehouseStatesError ? '逐仓状态读取失败' : null);

  const pendingTotal = Math.max(0, Number(overview.mappingQueueTotal ?? 0) || 0);

  /* 国内冻结快照：只读展示状态与最新文件日期，不提供立即同步。 */
  const domesticAvailable = domesticSnapshot?.available === true;
  const domesticDates = domesticAvailable
    ? (domesticSnapshot?.fileDates ?? []).map((entry) => entry.fileDate).filter(Boolean).sort()
    : [];
  const domesticDateText = domesticDates.length > 0 ? domesticDates[domesticDates.length - 1] : '—';
  const domesticReason = domesticAvailable ? null : ((domesticSnapshot?.reason ?? '').trim() || null);
  const domesticStatus: { label: string; tone: Tone } = domesticAvailable
    ? { label: '表格快照', tone: 'neutral' }
    : { label: '未读取', tone: 'amber' };

  /* 只有真实异常才需要处理：登录/后台/最近任务失败。 */
  const alerts: Array<{ tone: 'amber' | 'red'; title: string; body: string; href?: string; linkLabel?: string }> = [];
  if (account.status === 'needs_login') {
    alerts.push({
      tone: 'amber',
      title: 'BigSeller 登录已失效，自动同步已暂停',
      body: '需人工重新登录并复位账号状态后才能继续。',
    });
  } else if (account.status === 'disabled') {
    alerts.push({ tone: 'amber', title: 'BigSeller 账号已停用', body: '自动同步不会执行。' });
  }
  if (!overview.worker) {
    alerts.push({ tone: 'amber', title: '后台同步程序未登记', body: '自动同步不会执行，请确认后台程序已启动。' });
  } else if (!overview.worker.online) {
    alerts.push({
      tone: 'amber',
      title: '后台同步程序离线',
      body: `最后心跳：${timestampOr(overview.worker.lastSeenAt, '暂无记录')}。自动同步暂停，已有库存不清空。`,
    });
  }
  if (latestRun && latestDisplay && ['failed', 'partial', 'outcome_unknown', 'needs_login'].includes(latestRun.status)) {
    alerts.push({
      tone: latestRun.status === 'failed' || latestRun.status === 'needs_login' ? 'red' : 'amber',
      title: `最近任务：${latestDisplay.label}`,
      body: `${errorCodeLabel(latestRun.errorCode) ?? latestDisplay.nextStep}（任务时间：${timestampOr(latestRun.startedAt, '未记录')}）`,
      href: '#sync-runs',
      linkLabel: '查看任务详情',
    });
  }

  const runsAttention = Boolean(pending)
    || Boolean(latestRun && latestDisplay && ['failed', 'partial', 'outcome_unknown', 'needs_login'].includes(latestRun.status));

  /* 详情面板（服务端渲染后作为 children 交给客户端外壳，按需显示；内容与旧语义一致）。 */
  const detailContent = (
    <>
      <PendingRecoveryPanel key={pendingRecoveryKey(pending)} pending={pending} viewer={viewer} />

      {alerts.length > 0 ? (
        <ul className={styles.alertList} data-testid="sync-alerts">
          {alerts.map((alert) => (
            <li key={alert.title} className={styles.alertItem} data-tone={alert.tone} data-testid="sync-alert-item">
              <div className={styles.alertText}>
                <strong>{alert.title}</strong>
                <p>{alert.body}</p>
              </div>
              {alert.href ? (
                <a className={styles.alertLink} href={alert.href}>{alert.linkLabel ?? '去处理'}</a>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.statusOkLine} data-testid="sync-no-alerts">
          <StatusPill tone="green">运行正常</StatusPill>
        </p>
      )}

      <section className={styles.detailSection} data-testid="sync-scope-progress" aria-label="逐仓结果">
        <div className={styles.sectionHeader}>
          <h2>逐仓结果</h2>
        </div>
        <div className={styles.sectionBody}>
          <div className={styles.pillRow}>
            <StatusPill tone={scopeVersion > 0 ? 'blue' : 'amber'}>
              {scopeVersion > 0 ? `范围版本 第 ${scopeVersion} 版` : '尚未创建参与范围'}
            </StatusPill>
            <StatusPill tone={scope.empty ? 'amber' : 'neutral'}>{scope.empty ? '参与仓库为空：已停止发布' : `${scope.count} 个参与仓库`}</StatusPill>
            <StatusPill tone={overview.scopeLastAllSuccessAt ? 'green' : 'amber'}>
              最后全部成功：{overview.scopeLastAllSuccessAt ? formatTimestamp(overview.scopeLastAllSuccessAt) : '尚无记录'}
            </StatusPill>
            {activeRun ? <StatusPill tone="blue">有进行中的任务</StatusPill> : null}
          </div>
          {scope.empty ? (
            <p className={styles.inlineNotice} data-testid="sync-scope-empty-summary">
              已停止发布；在「设置」重新勾选并保存后恢复。
            </p>
          ) : null}
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>参与仓库</th>
                  <th>最近一次任务结果</th>
                  <th>当前数据时间</th>
                  <th>待处理（未对应）</th>
                  <th>说明</th>
                </tr>
              </thead>
              <tbody>
                {progressRows.length === 0 ? (
                  <tr>
                    <td colSpan={5} className={styles.wrapCell}>
                      还没有已确认参与的仓库。
                    </td>
                  </tr>
                ) : (
                  progressRows.map((row) => {
                    const pendingCell = pendingMappingCell(row);
                    return (
                      <tr key={row.key} data-testid="sync-warehouse-progress-row">
                        <td>
                          {row.name}
                          {row.batchText ? <span className={styles.rowSub}>{row.batchText}</span> : null}
                        </td>
                        <td>
                          {row.resultLabel}
                          {row.errorCode ? <span className={`${styles.rowSub} ${styles.rowSubAlert}`}>{errorCodeLabel(row.errorCode) ?? '本次未成功'}</span> : null}
                        </td>
                        <td>
                          {timestampOr(row.dataTime, '尚无成功记录')}
                          {row.publishTime ? <span className={styles.rowSub}>发布：{timestampOr(row.publishTime, '未发布')}</span> : null}
                          {row.stale || row.failed ? <span className={`${styles.rowSub} ${styles.rowSubAlert}`}>保留上一成功批次（旧时间）</span> : null}
                        </td>
                        <td>
                          {pendingCell.text}
                          {pendingCell.alert ? (
                            <span className={styles.pendingNote}>未计入商品合计</span>
                          ) : null}
                        </td>
                        <td>
                          <StatusPill tone={row.note.tone as Tone}>{row.note.label}</StatusPill>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
          {warehouseStatesError ? (
            <p className={styles.inlineError}>
              逐仓状态读取失败：{warehouseStatesError}。上表为总览字段，可刷新重试。
            </p>
          ) : null}
        </div>
      </section>

      <details className={styles.collapsible} data-testid="sync-runs" open={query.run !== '' || runsAttention}>
        <summary>
          任务历史与任务详情
          <span className={styles.summaryHint}>共 {runs.length} 条</span>
        </summary>
        <div className={styles.collapsibleBody}>
          {activeRuns.length > 0 ? (
            <p className={styles.inlineNotice}>
              当前有 {activeRuns.length} 个进行中的任务；「立即同步」返回同一任务，不额外排队。
            </p>
          ) : null}
          {runs.length === 0 ? (
            <p className={styles.inlineNotice}>还没有同步任务。</p>
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>状态</th>
                    <th>触发方式</th>
                    <th>计划时间</th>
                    <th>开始 / 完成</th>
                    <th>逐仓结果</th>
                    <th>错误原因</th>
                    <th>任务详情</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => {
                    const display = runStatusDisplay(run.status);
                    const selected = run.id === query.run;
                    return (
                      <tr key={run.id} data-testid="sync-run-row">
                        <td>
                          <StatusPill tone={display.tone as Tone}>{display.label}</StatusPill>
                        </td>
                        <td>{triggerLabel(run.triggerKind)}</td>
                        <td>{timestampOr(run.plannedFor, '未安排')}</td>
                        <td>
                          {timestampOr(run.startedAt, '未开始')}
                          <span className={styles.rowSub}>完成：{timestampOr(run.finishedAt, '未完成')}</span>
                        </td>
                        <td>{summarizeWarehouseCounts(run.warehouseSummary)}</td>
                        <td className={styles.wrapCell}>
                          {errorCodeLabel(run.errorCode) ?? '—'}
                          {run.errorCode ? <span className={styles.rowSub}>错误码：{run.errorCode}</span> : null}
                        </td>
                        <td>
                          {/* 任务详情切换用原生 a：冷加载/hydration 未完成时点击也必定整页导航，不依赖 Next router。 */}
                          {/* 未选中时 href 带详情锚点：整页导航/刷新后浏览器直接把所选任务详情带到视口；收起时不带锚点。 */}
                          <a
                            className={styles.headerLink}
                            href={`${buildSyncUrl({ ...query, run: selected ? '' : run.id })}${selected ? '' : `#${RUN_DETAIL_ANCHOR}`}`}
                            title={selected ? '收起任务详情' : '查看该任务的逐仓结果与文件信息'}
                          >
                            {selected ? '收起详情' : '查看详情'}
                          </a>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {query.run ? (
            <section id={RUN_DETAIL_ANCHOR} data-testid="sync-run-detail" aria-label="同步任务详情">
              <div className={styles.sectionHeader}>
                <h2>任务详情</h2>
              </div>
              <div className={styles.sectionBody}>
                {runError ? (
                  <p className={styles.inlineError}>读取任务详情失败：{runError}。可刷新重试。</p>
                ) : !runDetail || !detailStatus ? (
                  <p className={styles.inlineNotice}>没有找到该任务（可能不在授权范围或已被清理）。</p>
                ) : (
                  <>
                    <div className={styles.pillRow}>
                      <StatusPill tone={detailStatus.tone as Tone}>{detailStatus.label}</StatusPill>
                      <StatusPill tone="neutral">{triggerLabel(runDetail.triggerKind)}</StatusPill>
                      <StatusPill tone={runDetail.accountIdentity?.status === 'verified' ? 'green' : 'amber'}>
                        {accountIdentityLabel(runDetail.accountIdentity?.status)}
                      </StatusPill>
                      {runDetail.fileValidation ? (
                        <StatusPill tone={runDetail.fileValidation.status === 'ok' ? 'green' : 'red'}>
                          {fileValidationStatusLabel(runDetail.fileValidation.status)}
                        </StatusPill>
                      ) : null}
                    </div>

                    <div className={styles.subGrid}>
                      <div className={styles.subPanel}>
                        <h4>任务时间与覆盖</h4>
                        <FactList
                          rows={[
                            { label: '计划时间', value: timestampOr(runDetail.plannedFor, '未安排') },
                            { label: '开始 / 完成', value: `${timestampOr(runDetail.startedAt, '未开始')} / ${timestampOr(runDetail.finishedAt, '未完成')}` },
                            {
                              label: '本次观测时间',
                              value: timestampOr(runDetail.observationAt ?? null, '未记录（缺失时不发布）'),
                            },
                            {
                              label: '覆盖的自动时间点',
                              value: (runDetail.coveredSlots ?? []).length > 0
                                ? (runDetail.coveredSlots ?? []).map((slot) => timestampOr(slot, '时间未标注')).join('、')
                                : '无',
                            },
                            {
                              label: '错误原因',
                              value: errorCodeLabel(runDetail.errorCode) ?? '无',
                              hint: runDetail.errorCode
                                ? `错误码：${runDetail.errorCode}${runDetail.errorDetail ? ` · ${runDetail.errorDetail}` : ''}`
                                : undefined,
                            },
                          ]}
                        />
                      </div>
                      <div className={styles.subPanel}>
                        <h4>逐仓概览</h4>
                        <FactList
                          rows={[
                            { label: '逐仓结果', value: runWarehouseBreakdown(runDetail.warehouses ?? []) },
                            { label: '本任务观测时间', value: timestampOr(runDetail.observationAt ?? null, '未记录') },
                            {
                              label: '问题行',
                              value: (runDetail.issues ?? []).length > 0 ? `${(runDetail.issues ?? []).length} 行` : '没有解析问题行',
                            },
                          ]}
                        />
                      </div>
                    </div>

                    <details className={styles.collapsible} data-testid="sync-run-file-diagnostics">
                      <summary>文件与后台诊断</summary>
                      <div className={styles.collapsibleBody}>
                        {runDetail.file ? (
                          <FactList
                            rows={[
                              { label: '文件指纹', value: fingerprintPrefix(runDetail.file) || '未记录' },
                              {
                                label: '文件行数',
                                value: runDetail.file.rowCount === null || runDetail.file.rowCount === undefined
                                  ? '未记录'
                                  : `${formatQuantity(runDetail.file.rowCount)} 行`,
                                hint: `空白行 ${runDetail.file.blankRowCount ?? 0} 行`,
                              },
                              { label: '工作表', value: runDetail.file.sheetName ?? '未记录' },
                              { label: '下载时间', value: timestampOr(runDetail.file.downloadedAt ?? null, '未记录') },
                              {
                                label: '表头',
                                value: headerNames(runDetail.file.header).length > 0 ? headerNames(runDetail.file.header).join(' / ') : '未记录',
                              },
                            ]}
                          />
                        ) : (
                          <p className={styles.mappingNote}>本次任务还没有导出文件。</p>
                        )}
                        {runDetail.fileValidation ? (
                          <div>
                            <p className={styles.mappingNote}>
                              数量列：{quantityHeaderDisplay(runDetail.fileValidation.quantityHeader)} · 组合行 {runDetail.fileValidation.comboRowCount ?? 0} · 无法归仓 {runDetail.fileValidation.unattributableRowCount ?? 0}
                            </p>
                            {columnIssueText(runDetail.fileValidation) ? <p className={styles.inlineError}>{columnIssueText(runDetail.fileValidation)}</p> : null}
                            {runDetail.fileValidation.reason ? <p className={styles.mappingNote}>阻断原因：{runDetail.fileValidation.reason}</p> : null}
                          </div>
                        ) : null}
                        {(runDetail.warehouseDiscovery ?? []).length > 0 ? (
                          <div>
                            <p className={styles.mappingNote}>本次发现的仓库（待确认）：</p>
                            <ul className={styles.hintList}>
                              {(runDetail.warehouseDiscovery ?? []).map((warehouse) => (
                                <li key={`${warehouse.externalId}-${warehouse.name}`}>
                                  {warehouse.name}{warehouse.status ? ` · ${warehouse.status}` : ''}
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                      </div>
                    </details>

                    <h4 className={styles.subPanelTitle}>逐仓结果（该任务）</h4>
                    <div className={styles.tableWrap}>
                      <table className={styles.table}>
                        <thead>
                          <tr>
                            <th>仓库</th>
                            <th>结果</th>
                            <th>行数</th>
                            <th>采用</th>
                            <th>未对应</th>
                            <th>坏行/重复</th>
                            <th>观测时间</th>
                            <th>发布时间</th>
                            <th>错误原因</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(runDetail.warehouses ?? []).length === 0 ? (
                            <tr>
                              <td colSpan={9} className={styles.wrapCell}>本次任务没有逐仓结果。</td>
                            </tr>
                          ) : (
                            (runDetail.warehouses ?? []).map((warehouse) => (
                              <tr key={`${warehouse.warehouseId}`} data-testid="sync-run-warehouse-row">
                                <td>{warehouse.warehouseName ?? warehouse.name ?? '未命名仓库'}</td>
                                <td>{runWarehouseStatusLabel(warehouse.status)}</td>
                                <td className={styles.numCell}>{warehouse.rows ?? '—'}</td>
                                <td className={styles.numCell}>{warehouse.adopted ?? '—'}</td>
                                <td className={styles.numCell}>{warehouse.unmapped ?? '—'}</td>
                                <td className={styles.numCell}>{warehouse.invalidRows ?? '—'} / {warehouse.duplicateSkuRows ?? '—'}</td>
                                <td>{timestampOr(warehouse.observationAt ?? null, '未记录')}</td>
                                <td>{timestampOr(warehouse.publishedAt ?? null, '未发布')}</td>
                                <td className={styles.wrapCell}>
                                  {errorCodeLabel(warehouse.errorCode) ?? '—'}
                                  {warehouse.reason ? <span className={styles.rowSub}>{warehouse.reason}</span> : null}
                                  {warehouse.errorCode ? <span className={styles.rowSub}>错误码：{warehouse.errorCode}</span> : null}
                                </td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>

                    <h4 className={styles.subPanelTitle}>问题行（前 50 条）</h4>
                    <div className={styles.tableWrap}>
                      <table className={styles.table}>
                        <thead>
                          <tr>
                            <th>文件行号</th>
                            <th>仓库</th>
                            <th>外部 SKU</th>
                            <th>问题</th>
                            <th>说明</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(runDetail.issues ?? []).length === 0 ? (
                            <tr>
                              <td colSpan={5} className={styles.wrapCell}>本次没有解析问题行。</td>
                            </tr>
                          ) : (
                            (runDetail.issues ?? []).map((issue, index) => (
                              <tr key={`${issue.excelRow}-${index}`} data-testid="sync-run-issue-row">
                                <td>第 {issue.excelRow} 行</td>
                                <td>{issue.warehouseName ?? '未标注'}</td>
                                <td>{issue.externalSku ?? '未标注'}</td>
                                <td>{parseStatusLabel(issue.parseStatus)}</td>
                                <td className={styles.wrapCell}>{issue.reason ?? '—'}</td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </div>
            </section>
          ) : null}
        </div>
      </details>
    </>
  );

  /* 设置面板里的按需诊断（不占首屏；只在设置面板内展开）。 */
  const diagnosticsContent = (
    <details className={styles.collapsible} data-testid="sync-diagnostics">
      <summary>后台诊断</summary>
      <div className={styles.collapsibleBody}>
        <div className={styles.subGrid}>
          <div className={styles.subPanel}>
            <h4>后台程序</h4>
            <FactList
              rows={[
                { label: '后台状态', value: worker.label },
                { label: '最后联系', value: timestampOr(overview.worker?.lastSeenAt ?? null, '还没有心跳记录') },
                { label: '运行主机', value: overview.worker?.host ?? '未登记' },
                { label: '最近尝试', value: timestampOr(latestRun?.startedAt ?? null, '还没有同步记录') },
              ]}
            />
          </div>
          <div className={styles.subPanel}>
            <h4>账号与范围</h4>
            <FactList
              rows={[
                { label: '登录状态', value: login.label },
                { label: '最近登录成功', value: timestampOr(account.lastLoginOkAt, '暂无记录') },
                { label: '范围版本', value: scopeVersion > 0 ? `第 ${scopeVersion} 版` : '尚未创建参与范围' },
                { label: '参与仓库', value: scopeLabels.length > 0 ? scopeLabels.join('、') : (scope.empty ? '明确空范围（已停止发布）' : '暂无') },
                { label: '已保存设置', value: `自动同步${overview.settings.enabled ? '已开启' : '已关闭'} · 配置版本 ${overview.settings.configVersion > 0 ? `第 ${overview.settings.configVersion} 版` : '尚未保存'}` },
              ]}
            />
          </div>
        </div>
      </div>
    </details>
  );

  return (
    <div className={styles.page} data-testid="sync-page">
      <header className={styles.pageHeader}>
        <div className={styles.headerText}>
          <h1>数据同步</h1>
        </div>
        <div className={styles.headerLinks}>
          <Link className={styles.headerLink} href="/dashboard/inventory">
            商品库存
          </Link>
          {/* 用原生链接刷新当前状态；不改变任何设置，也不触发同步。 */}
          <a className={styles.headerLink} href={buildSyncUrl(query)} data-testid="sync-refresh-status">
            刷新状态
          </a>
        </div>
      </header>

      <section className={styles.sourceList} data-testid="sync-status-overview" aria-label="数据来源同步状态">
        <div className={styles.sourceListHead}>
          <h2>数据来源</h2>
        </div>

        <SyncControls
          key={`sync-controls-v${overview.scope.version}-c${overview.scope.warehouseCount}-e${overview.scope.empty ? 1 : 0}-r${query.run || 'none'}`}
          overview={overview}
          selectedWarehouseIds={selectedIds}
          activeRun={activeRun}
          pendingLocked={pendingLocked}
          viewer={viewer}
          selectedRunId={query.run}
          lastDataText={lastDataText}
          lastDataAlert={lastDataAlert}
          pendingTotal={pendingTotal}
          detailContent={detailContent}
          diagnostics={diagnosticsContent}
        />

        <section className={styles.sourceRow} data-testid="sync-source-row-domestic" aria-label="聚水潭国内表格快照">
          <div className={styles.sourceIdentity}>
            <h2>聚水潭 · 国内表格快照</h2>
          </div>
          <div className={styles.sourceCell} data-testid="sync-source-domestic-status">
            <span className={styles.sourceLabel}>状态</span>
            <StatusPill tone={domesticStatus.tone}>{domesticStatus.label}</StatusPill>
          </div>
          <div className={styles.sourceCell} data-testid="sync-source-domestic-file-date">
            <span className={styles.sourceLabel}>原文件日期</span>
            <span className={styles.sourceValue}>{domesticDateText}</span>
            {domesticReason ? <small>{domesticReason}</small> : null}
          </div>
          <div className={styles.sourceCell} data-testid="sync-source-domestic-next-plan">
            <span className={styles.sourceLabel}>下次计划</span>
            <span className={styles.sourceValue}>不自动同步</span>
          </div>
          <div className={styles.sourceCell} data-testid="sync-source-domestic-pending">
            <span className={styles.sourceLabel}>待处理</span>
            <span className={styles.sourceValue}>—</span>
          </div>
          <div className={styles.sourceActions}>
            <Link className={styles.sourceLink} href="/dashboard/inventory?source=domestic" data-testid="sync-source-domestic-link">
              查看国内明细
            </Link>
          </div>
        </section>
      </section>
    </div>
  );
}
