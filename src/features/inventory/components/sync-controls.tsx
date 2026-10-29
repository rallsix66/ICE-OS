'use client';

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import styles from './sync-view.module.css';
import { StatusPill } from './display';
import {
  buildManualSyncIntent,
  buildSettingsIntent,
  compareStableText,
  errorCodeLabel,
  formatQuantity,
  formatTimestamp,
  intervalDisplay,
  manualSyncBlockedReason,
  normalizeIntervalInput,
  resolveScopeChange,
  runStatusDisplay,
  scopeDisplay,
  timestampOr,
  warehouseStatusLabel,
  type IntervalUnit,
  type Tone,
} from '../model';
import type { InventoryActionOutcome, InventoryOverviewDto } from '../types';
import {
  clearLocalUnknownRequest,
  getLocalUnknownServerSnapshot,
  getLocalUnknownSnapshot,
  localUnknownOwnerCheck,
  subscribeLocalUnknown,
  type LocalViewerIdentity,
} from '../client-pending';
import { requestManualSyncAction, saveSyncSettingsAction } from '../server/actions';
import { registerOriginalRequest } from './pending-recovery';
import { settlementReleasesLock, settlementTone } from '../settlement';

type MessageTone = 'ok' | 'warn' | 'error';
type OpenPanel = 'detail' | 'settings' | null;

const TONE_BY_RESULT = (outcome: InventoryActionOutcome): MessageTone => settlementTone(outcome);
const FAILURE_RUN_STATUSES = ['failed', 'partial', 'outcome_unknown', 'needs_login'];

/**
 * BigSeller 来源行（R6 紧凑来源总览）：
 * - 一行展示真实同步状态、最后成功数据时间、下次计划、待处理对应与关键操作；
 * - 「立即同步」是主操作；「详情」「设置」按需在同页展开面板（不整页跳转，默认折叠）；
 * - 详情内容由服务端页面渲染后传入（逐仓结果、任务历史、失败详情、原请求核对）；
 * - 设置面板含频率/参与仓/保存 + 后台诊断 <details>；
 * - 所有写动作仍走统一 pending 流程：先登记原请求 → 本地记录 → 原动作 → 结果未知核对；
 * - 写锁 = 服务端 pending 或本地保留原请求，覆盖设置/立即同步/仓库勾选等输入。
 */
export function SyncControls({
  overview,
  selectedWarehouseIds,
  activeRun,
  pendingLocked,
  viewer,
  selectedRunId,
  lastDataText,
  lastDataAlert,
  pendingTotal,
  detailContent,
  diagnostics,
}: {
  overview: InventoryOverviewDto;
  selectedWarehouseIds: string[];
  activeRun: { id: string; statusLabel: string } | null;
  pendingLocked: boolean;
  viewer: LocalViewerIdentity | null;
  /** 当前 URL 选中的任务 id（?run=）；有值时外层详情自动展开，选中任务详情随面板可见。 */
  selectedRunId: string;
  /** 最后成功数据时间（服务端按逐仓观测时间计算）；读取失败时给一行短状态。 */
  lastDataText: string;
  lastDataAlert: string | null;
  /** 待处理对应总数（来源 SKU × 仓库；未计入商品合计）。 */
  pendingTotal: number;
  /** 详情面板内容（服务端渲染；原请求核对/逐仓结果/任务历史）。 */
  detailContent: ReactNode;
  /** 设置面板内的后台诊断（服务端渲染的 <details>）。 */
  diagnostics: ReactNode;
}) {
  const router = useRouter();
  const saved = intervalDisplay(overview.settings.intervalMinutes);
  const scope = scopeDisplay(overview.scope);
  const [enabled, setEnabled] = useState(overview.settings.enabled);
  const [intervalValue, setIntervalValue] = useState(saved.inputValue);
  const [intervalUnit, setIntervalUnit] = useState<IntervalUnit>(saved.inputUnit);
  const [intervalError, setIntervalError] = useState('');
  const [selected, setSelected] = useState<string[]>(selectedWarehouseIds);
  const [clearConfirm, setClearConfirm] = useState(false);
  const [busy, setBusy] = useState<null | 'save' | 'manual'>(null);
  const [message, setMessage] = useState<{ text: string; tone: MessageTone } | null>(null);
  /** 详情/设置面板默认折叠：有待核对原请求或 URL 选中任务时展开详情；明确空范围时展开设置方便恢复。 */
  const [openPanel, setOpenPanel] = useState<OpenPanel>(
    overview.pendingAction ? 'detail' : scope.empty ? 'settings' : selectedRunId ? 'detail' : null,
  );
  /** 本地“结果未知”原请求出现时自动展开详情（恢复入口在详情内）；用户可手动收起。 */
  const [dismissedLocalId, setDismissedLocalId] = useState<string | null>(null);
  /** URL 选中任务时自动展开详情；用户手动“收起详情”后不再自动展开，直到选中另一个任务。 */
  const [dismissedSelectedRunId, setDismissedSelectedRunId] = useState<string | null>(null);
  // R2 v4：本地保留的“结果未知”原请求也计入写锁（服务端 pending 之外的浏览器副本）。
  const local = useSyncExternalStore(subscribeLocalUnknown, getLocalUnknownSnapshot, getLocalUnknownServerSnapshot);
  const localRequestId = local?.requestId ?? null;
  const autoDetail = Boolean(localRequestId) && dismissedLocalId !== localRequestId;
  const autoSelectedRun = Boolean(selectedRunId) && dismissedSelectedRunId !== selectedRunId;
  const writeLocked = pendingLocked || Boolean(local);
  const localOwner = local ? localUnknownOwnerCheck(local, viewer) : { trusted: true, reason: null };
  const locatedSelectedRunRef = useRef<string | null>(null);

  const warehouses = overview.warehouses ?? [];
  // 首屏排序必须确定性（不依赖 locale/ICU）：先已确认参与，再按仓库外部编码/名称码点。
  const selectableWarehouses = warehouses
    .filter((warehouse) => warehouse.status !== 'excluded')
    .sort((a, b) => {
      const confirmedDelta = Number(b.status === 'confirmed') - Number(a.status === 'confirmed');
      if (confirmedDelta !== 0) return confirmedDelta;
      const externalDelta = compareStableText(a.externalId, b.externalId);
      return externalDelta !== 0 ? externalDelta : compareStableText(a.name, b.name);
    });
  const scopeChange = resolveScopeChange({ savedWarehouseIds: selectedWarehouseIds, draftWarehouseIds: selected });
  const nextRunText = overview.settings.nextRunAt
    ? formatTimestamp(overview.settings.nextRunAt) || '待后台确认'
    : overview.settings.enabled
      ? '待后台确认'
      : '未安排（自动同步已关闭）';
  const blockedReason = manualSyncBlockedReason({ scopeEmpty: scope.empty, accountStatus: overview.account.status });
  // 草稿是否偏离已保存设置：立即同步始终按已保存范围执行，不能让人误以为草稿已生效。
  const draftInterval = normalizeIntervalInput(intervalValue, intervalUnit);
  const draftDirty = enabled !== overview.settings.enabled
    || !draftInterval.ok
    || draftInterval.minutes !== overview.settings.intervalMinutes
    || scopeChange.kind !== 'unchanged';
  const savedScopeText = scope.empty ? '参与仓库为空（已停止发布）' : `参与仓库 ${scope.count} 个`;
  const savedSummaryText = `${overview.settings.enabled ? '自动同步已开启' : '自动同步已关闭'} · ${saved.display} · ${savedScopeText} · 下次计划 ${nextRunText}`;

  const latestRun = overview.lastRun ?? overview.runs[0] ?? null;
  const latestDisplay = latestRun ? runStatusDisplay(latestRun.status) : null;
  const lastFailedRun = latestRun && latestDisplay && FAILURE_RUN_STATUSES.includes(latestRun.status);

  /* 来源行状态：真实同步状态优先，其次账号/后台这类会阻止同步的当前状态。 */
  let statusLabel = '未运行';
  let statusTone: Tone = 'neutral';
  let statusReason: string | null = null;
  if (overview.pendingAction) {
    statusLabel = '结果待核对';
    statusTone = 'amber';
    statusReason = '先核对原请求，再同步或改设置。';
  } else if (activeRun) {
    statusLabel = activeRun.statusLabel;
    statusTone = 'blue';
  } else if (overview.account.status === 'needs_login') {
    statusLabel = '需要重新登录';
    statusTone = 'amber';
    statusReason = '登录已失效，自动同步暂停。';
  } else if (overview.account.status === 'disabled') {
    statusLabel = '账号已停用';
    statusTone = 'neutral';
    statusReason = '自动同步不会执行。';
  } else if (!overview.worker) {
    statusLabel = '后台未登记';
    statusTone = 'amber';
    statusReason = '后台同步程序未登记，自动同步不会执行。';
  } else if (!overview.worker.online) {
    statusLabel = '后台离线';
    statusTone = 'amber';
    statusReason = `后台离线（最后心跳 ${timestampOr(overview.worker.lastSeenAt, '暂无记录')}），自动同步暂停。`;
  } else if (latestDisplay) {
    statusLabel = latestDisplay.label;
    statusTone = latestDisplay.tone;
    if (latestRun?.status === 'outcome_unknown') {
      statusReason = '保存结果暂未确认，不要重复同步。';
    } else if (lastFailedRun) {
      statusReason = `${errorCodeLabel(latestRun?.errorCode ?? null) ?? '本次同步未成功'}；保留上次成功数据。`;
    }
  }
  if (scope.empty && !activeRun && !overview.pendingAction) {
    statusLabel = '未安排（空范围）';
    statusTone = 'amber';
    statusReason = '参与仓库为空：已停止发布。';
  }

  const detailOpen = openPanel === 'detail'
    || (openPanel !== 'settings' && (autoDetail || autoSelectedRun));
  const settingsOpen = openPanel === 'settings';

  // T3：URL 选中任务（?run=）时，把该任务详情带入当前视口。
  // 只在首次定位该任务时生效（切换任务/刷新会重新定位）；样式或流式内容补齐造成的布局变化会再校正，
  // 位置稳定后停止并断开监听，手动收起或之后再展开都不会持续把用户拉回。
  useEffect(() => {
    if (!selectedRunId || !detailOpen) return;
    if (locatedSelectedRunRef.current === selectedRunId) return;
    locatedSelectedRunRef.current = selectedRunId;
    const target = () => document.getElementById('sync-run-detail');
    target()?.scrollIntoView({ block: 'start' });
    if (typeof ResizeObserver === 'undefined' || !document.body) return;
    // 观察 body：样式/流式内容补全会改变页面高度，此时把目标重新带回视口；稳定后断开。
    const observer = new ResizeObserver(() => target()?.scrollIntoView({ block: 'start' }));
    observer.observe(document.body);
    const stop = window.setTimeout(() => observer.disconnect(), 1500);
    return () => {
      observer.disconnect();
      window.clearTimeout(stop);
    };
  }, [selectedRunId, detailOpen]);

  function togglePanel(panel: Exclude<OpenPanel, null>): void {
    if (panel === 'detail') {
      if (detailOpen) {
        // 用户主动收起：本地恢复入口 / URL 选中任务之后不再自动弹出，直到出现新的对应状态。
        if (autoDetail) setDismissedLocalId(localRequestId);
        if (autoSelectedRun) setDismissedSelectedRunId(selectedRunId);
        setOpenPanel(null);
      } else {
        setOpenPanel('detail');
      }
      return;
    }
    setOpenPanel((current) => (current === 'settings' ? null : 'settings'));
  }

  function toggleWarehouse(warehouseId: string) {
    setClearConfirm(false);
    setSelected((current) => (
      current.includes(warehouseId)
        ? current.filter((entry) => entry !== warehouseId)
        : [...current, warehouseId]
    ));
  }

  /** 登记未成功：不发业务写。未知→保留本地记录并整页重载；确定失败→只显示原因。 */
  function stopAfterRegistrationFailure(outcome: { unknown: boolean; message: string }): void {
    setMessage({ text: outcome.message, tone: outcome.unknown ? 'warn' : 'error' });
    if (outcome.unknown) {
      // 整页重载进入恢复入口；本地记录已保存（registration:'unknown'），绝不自动重发动作。
      window.location.reload();
      return;
    }
    router.refresh();
  }

  async function saveSettings() {
    setIntervalError('');
    const parsed = normalizeIntervalInput(intervalValue, intervalUnit);
    if (!parsed.ok) {
      setIntervalError(parsed.reason);
      setMessage({ text: parsed.reason, tone: 'error' });
      return;
    }
    if (scopeChange.kind === 'cleared' && !clearConfirm) {
      setClearConfirm(true);
      setMessage({
        text: '清空全部参与仓库会“停止发布”（不会回退旧范围、不会自动选全部仓库）。请确认后再点一次“确认清空并保存”。',
        tone: 'warn',
      });
      return;
    }
    setBusy('save');
    setMessage({ text: '正在保存自动同步设置…', tone: 'ok' });
    const intervalMinutes = parsed.minutes;
    const intent = buildSettingsIntent({
      enabled,
      intervalMinutes,
      scopeProvided: scopeChange.scopeProvided,
      warehouseIds: scopeChange.warehouseIds,
    });
    const requestId = crypto.randomUUID();
    const payload = {
      enabled,
      intervalMinutes,
      scopeProvided: scopeChange.scopeProvided,
      warehouseIds: scopeChange.warehouseIds,
    };
    try {
      // 1) 先登记原请求；成功拿到服务端身份才允许执行原动作。
      const registration = await registerOriginalRequest({
        requestId,
        action: 'update_inventory_sync_settings',
        intent,
        payload,
        viewer,
      });
      if (!registration.registered) {
        stopAfterRegistrationFailure(registration);
        return;
      }
      // 2) 原动作；它内部用同一 requestId 幂等 begin（已登记 → 重放）。
      const result = await saveSyncSettingsAction({
        enabled,
        intervalValue,
        intervalUnit,
        scopeProvided: scopeChange.scopeProvided,
        warehouseIds: scopeChange.warehouseIds,
        confirmClearScope: scopeChange.kind === 'cleared' ? clearConfirm : undefined,
        requestId,
        intent,
      });
      if (result.outcomeUnknown) {
        // 业务结果未知：本地记录保留（registration:'registered'），恢复入口优先使用服务端 pending。
        setMessage({ text: result.message, tone: TONE_BY_RESULT(result) });
        router.refresh();
        return;
      }
      // v4-final R2：只有成功且锁已解除、或服务端确认原请求已结案（settled/no_pending）才清本地记录；
      // 结案失败/不是原请求/unlockFailed 一律保留本地记录（新写继续锁定）。
      const release = settlementReleasesLock(result);
      if (release) clearLocalUnknownRequest(requestId);
      setMessage({ text: result.message, tone: TONE_BY_RESULT(result) });
      if (release) {
        setClearConfirm(false);
        router.refresh();
        return;
      }
      if (result.errorCode === 'CONFIRM_CLEAR_SCOPE') {
        setClearConfirm(true);
        return;
      }
      // 原请求未结案：刷新显示服务端“原请求待核对”恢复入口，不能提示已解锁。
      router.refresh();
    } catch {
      // 业务动作网络异常：保留已登记本地记录并整页重载；以服务端 pending 为准，绝不自动重发。
      setMessage({
        text: '保存结果暂未确认（连接中断）。刷新页面后从“原请求待核对”入口核对，不要直接重复保存。',
        tone: 'warn',
      });
      window.location.reload();
    } finally {
      setBusy(null);
    }
  }

  async function requestManualSync() {
    if (blockedReason) {
      setMessage({ text: blockedReason, tone: 'error' });
      return;
    }
    setBusy('manual');
    setMessage({ text: '正在提交“立即同步”…', tone: 'ok' });
    const manualRequestId = crypto.randomUUID();
    const manualIntent = buildManualSyncIntent();
    try {
      const registration = await registerOriginalRequest({
        requestId: manualRequestId,
        action: 'request_inventory_manual_sync',
        intent: manualIntent,
        payload: {},
        viewer,
      });
      if (!registration.registered) {
        stopAfterRegistrationFailure(registration);
        return;
      }
      const result = await requestManualSyncAction({ requestId: manualRequestId, intent: manualIntent });
      if (result.outcomeUnknown) {
        setMessage({ text: result.message, tone: TONE_BY_RESULT(result) });
        router.refresh();
        return;
      }
      // v4-final R2：确认结案（或成功解锁）才清本地记录；其余保留锁。
      if (settlementReleasesLock(result)) clearLocalUnknownRequest(manualRequestId);
      setMessage({ text: result.message, tone: TONE_BY_RESULT(result) });
      router.refresh();
    } catch {
      setMessage({
        text: '立即同步的提交结果暂未确认（连接中断）。刷新后从“原请求待核对”入口核对；后台不会重复排队。',
        tone: 'warn',
      });
      window.location.reload();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div data-testid="sync-controls" id="sync-controls" className={styles.controls}>
      <section className={styles.sourceRow} data-testid="sync-source-row-bigseller" aria-label="BigSeller 海外库存同步">
        <div className={styles.sourceIdentity}>
          <h2>BigSeller · 海外库存</h2>
        </div>

        <div className={styles.sourceCell} data-testid="sync-source-status">
          <span className={styles.sourceLabel}>状态</span>
          <StatusPill tone={statusTone}>{statusLabel}</StatusPill>
        </div>

        <div className={styles.sourceCell} data-testid="sync-source-last-data">
          <span className={styles.sourceLabel}>最后成功数据</span>
          <span className={styles.sourceValue}>{lastDataText}</span>
          {lastDataAlert ? <small>{lastDataAlert}</small> : null}
        </div>

        <div className={styles.sourceCell} data-testid="sync-source-next-plan">
          <span className={styles.sourceLabel}>下次计划</span>
          <span className={styles.sourceValue}>{nextRunText}</span>
        </div>

        <div className={styles.sourceCell} data-testid="sync-source-pending">
          <span className={styles.sourceLabel}>待处理</span>
          <span className={styles.sourceValue} data-testid="sync-mapping">{formatQuantity(pendingTotal) || '0'}</span>
        </div>

        <div className={styles.sourceActions}>
          <button
            type="button"
            className={styles.primaryButton}
            onClick={requestManualSync}
            disabled={busy !== null || writeLocked || blockedReason !== null}
            title={blockedReason ?? '立即同步使用已保存的自动同步范围；已有活动任务时返回同一个任务'}
            data-testid="sync-manual-button"
          >
            {busy === 'manual' ? '正在提交…' : '立即同步'}
          </button>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={() => togglePanel('detail')}
            aria-expanded={detailOpen}
            aria-controls="sync-source-detail-panel"
            data-testid="sync-source-detail-toggle"
          >
            {detailOpen ? '收起详情' : '详情'}
          </button>
          <span className={styles.actionWrap} data-testid="sync-settings-toggle">
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => togglePanel('settings')}
              aria-expanded={settingsOpen}
              aria-controls="sync-settings-panel"
              data-testid="sync-source-settings-toggle"
            >
              {settingsOpen ? '收起设置' : '设置'}
            </button>
          </span>
        </div>

        {statusReason ? <p className={styles.sourceReason} data-testid="sync-source-reason">{statusReason}</p> : null}
      </section>

      {blockedReason ? <p className={styles.blockedNote} data-testid="sync-manual-blocked">{blockedReason}</p> : null}

      {scope.empty ? (
        <div className={styles.inlineNotice} data-testid="sync-scope-empty-notice">
          <strong>{scope.label}</strong>
          <br />
          在「设置」重新勾选参与仓库并保存后恢复。
        </div>
      ) : null}

      {writeLocked ? (
        <p className={styles.writeLocked} data-testid="sync-write-locked">
          原请求待核对：保存设置与立即同步暂不可用。
          {local
            ? localOwner.trusted
              ? ' 本地还保留一条结果未知的原请求，先在「详情」核对。'
              : ` 本地保留的原请求${localOwner.reason ? `：${localOwner.reason}` : '归属/身份不可信'}，保持锁定。`
            : ''}
        </p>
      ) : null}

      {detailOpen ? (
        <section
          className={styles.sourcePanel}
          id="sync-source-detail-panel"
          data-testid="sync-source-detail-panel"
          aria-label="BigSeller 同步详情"
        >
          <div className={styles.panelInner}>{detailContent}</div>
        </section>
      ) : null}

      {settingsOpen ? (
        <section
          className={styles.settingsPanel}
          id="sync-settings-panel"
          data-testid="sync-settings"
          aria-label="自动同步设置"
        >
          <div data-testid="sync-source-settings-panel" className={styles.panelInner}>
            <p className={styles.savedSummary} data-testid="sync-settings-summary">
              <strong>当前已保存：</strong>
              {savedSummaryText}
            </p>
            <div className={styles.formGrid}>
              <div className={styles.field}>
                <span>自动同步</span>
                <label className={styles.checkLine}>
                  <input
                    type="checkbox"
                    checked={enabled}
                    disabled={busy !== null || writeLocked}
                    onChange={(event) => setEnabled(event.target.checked)}
                    aria-label="开启自动同步"
                  />
                  开启自动同步
                </label>
              </div>

              <div className={styles.field}>
                <span>同步频率</span>
                <div className={styles.intervalRow}>
                  <input
                    value={intervalValue}
                    onChange={(event) => setIntervalValue(event.target.value)}
                    inputMode="numeric"
                    aria-label="同步频率数值"
                    disabled={busy !== null || writeLocked}
                  />
                  <select
                    value={intervalUnit}
                    onChange={(event) => setIntervalUnit(event.target.value === 'hours' ? 'hours' : 'minutes')}
                    aria-label="同步频率单位"
                    disabled={busy !== null || writeLocked}
                  >
                    <option value="minutes">分钟</option>
                    <option value="hours">小时</option>
                  </select>
                </div>
                <p className={styles.fieldHint} data-tone={intervalError ? 'error' : undefined}>
                  {intervalError || '范围 5–1440 分钟（1–24 小时）'}
                </p>
              </div>

              <div className={styles.field}>
                <span>参与仓库</span>
                <div className={styles.warehouseGrid} data-testid="sync-warehouse-picker">
                  {selectableWarehouses.length === 0 ? (
                    <p className={styles.fieldHint}>还没有读到该账号可见的仓库清单。</p>
                  ) : (
                    selectableWarehouses.map((warehouse) => (
                      <label key={warehouse.id} className={styles.checkLine} title={warehouse.externalId}>
                        <input
                          type="checkbox"
                          checked={selected.includes(warehouse.id)}
                          disabled={busy !== null || writeLocked}
                          onChange={() => toggleWarehouse(warehouse.id)}
                          aria-label={`参与仓库：${warehouse.name}`}
                        />
                        <span>
                          {warehouse.name}
                          <small className={styles.rowSub}>
                            {warehouseStatusLabel(warehouse.status)}
                            {warehouse.market ? ` · 市场 ${warehouse.market}` : ' · 市场待确认'}
                          </small>
                        </span>
                      </label>
                    ))
                  )}
                </div>
                <p className={styles.fieldHint} data-testid="sync-scope-change-hint">
                  {scopeChange.kind === 'unchanged'
                    ? `参与仓库未修改（当前保存 ${selectedWarehouseIds.length} 个${scope.empty ? '，且为明确空范围' : ''}）。`
                    : scopeChange.kind === 'cleared'
                      ? '将明确清空参与仓库：保存后停止发布；立即同步会被拒绝。'
                      : `将更新为 ${scopeChange.warehouseIds.length} 个参与仓库。`}
                </p>
              </div>
            </div>

            {draftDirty ? (
              <p className={styles.draftNotice} data-testid="sync-draft-notice">
                有未保存的设置草稿：<strong>立即同步仍使用已保存范围</strong>（{savedSummaryText.split(' · ').slice(1, 3).join(' · ')}）。
              </p>
            ) : null}

            <div className={styles.panelActions}>
              <button
                type="button"
                className={styles.primaryButton}
                onClick={saveSettings}
                disabled={busy !== null || writeLocked}
                data-testid="sync-save-settings"
              >
                {busy === 'save'
                  ? '正在保存…'
                  : scopeChange.kind === 'cleared' && clearConfirm
                    ? '确认清空并保存'
                    : '保存设置'}
              </button>
            </div>

            {diagnostics}
          </div>
        </section>
      ) : null}

      {message ? (
        <p
          role="status"
          aria-live="polite"
          className={styles.statusMessage}
          data-tone={message.tone === 'ok' ? undefined : message.tone}
          data-testid="sync-control-message"
        >
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
