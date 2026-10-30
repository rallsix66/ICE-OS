'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Globe2, X } from 'lucide-react';
import { Checkbox, SelectMenu } from '@/ui/ice-v4/data-surface';
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
import { useDialogFocusTrap } from '@/features/catalog/components/use-dialog-focus-trap';
import { registerOriginalRequest } from './pending-recovery';
import { settlementReleasesLock, settlementTone } from '../settlement';

type MessageTone = 'ok' | 'warn' | 'error';
type OpenPanel = 'detail' | 'settings' | null;

const TONE_BY_RESULT = (outcome: InventoryActionOutcome): MessageTone => settlementTone(outcome);
const FAILURE_RUN_STATUSES = ['failed', 'partial', 'outcome_unknown', 'needs_login'];

/**
 * BigSeller 来源卡片（客户端）：卡片网格的容器。
 * - 首屏两张卡：BigSeller（左）与聚水潭（右，服务端渲染后传入），窄屏一列；
 * - 卡片右上角只给一句“是否正常”状态；异常收进卡片内一行短状态；
 * - 「立即同步」是主操作；「详情」「设置」打开同一右侧抽屉，用顶部页签切换；
 * - 抽屉内容由服务端页面渲染后传入（逐仓结果、任务历史、失败详情、原请求核对、设置）；
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
  domesticCard,
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
  /** 聚水潭来源卡片（服务端渲染；只读快照，不提供立即同步）。 */
  domesticCard: ReactNode;
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
  /** 抽屉页签与卡片触发按钮：打开后焦点进抽屉，关闭后回到触发按钮。 */
  const detailTabRef = useRef<HTMLButtonElement | null>(null);
  const settingsTabRef = useRef<HTMLButtonElement | null>(null);
  const detailToggleRef = useRef<HTMLButtonElement | null>(null);
  const settingsToggleRef = useRef<HTMLButtonElement | null>(null);
  const lastOpenRef = useRef<OpenPanel>(null);
  /** 首屏自动打开（待核对/空范围/?run=）不抢焦点；用户主动打开才把焦点放进抽屉。 */
  const skipAutoFocusRef = useRef(openPanel !== null);

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
  const savedScopeText = scope.empty ? '空范围' : `${scope.count} 个仓库`;
  const savedMinutes = Number(saved.inputValue) || 0;
  const savedIntervalText = savedMinutes > 0 && savedMinutes % 60 === 0
    ? `每 ${savedMinutes / 60} 小时`
    : `每 ${savedMinutes} 分钟`;
  const savedSummaryText = `${savedIntervalText} · ${savedScopeText}`;

  const latestRun = overview.lastRun ?? overview.runs[0] ?? null;
  const latestDisplay = latestRun ? runStatusDisplay(latestRun.status) : null;
  const lastFailedRun = latestRun && latestDisplay && FAILURE_RUN_STATUSES.includes(latestRun.status);

  /* 卡片右上角“是否正常”：异常优先；只给状态词，长解释不进卡片。 */
  const healthNotes: string[] = [];
  let statusLabel = '未运行';
  let statusTone: Tone = 'neutral';
  if (overview.pendingAction) {
    statusLabel = '结果待核对';
    statusTone = 'amber';
    healthNotes.push('原请求待核对，先核对再同步或改设置');
  } else if (activeRun) {
    statusLabel = '同步中';
    statusTone = 'blue';
  } else if (overview.account.status === 'needs_login') {
    statusLabel = '需要重新登录';
    statusTone = 'amber';
    healthNotes.push('登录已失效，自动同步暂停');
  } else if (overview.account.status === 'disabled') {
    statusLabel = '账号已停用';
    statusTone = 'neutral';
    healthNotes.push('账号已停用，自动同步不执行');
  } else if (!overview.worker) {
    statusLabel = '后台未登记';
    statusTone = 'amber';
    healthNotes.push('后台同步程序未登记');
  } else if (!overview.worker.online) {
    statusLabel = '后台离线';
    statusTone = 'amber';
    healthNotes.push(`后台离线 · 最后心跳 ${timestampOr(overview.worker.lastSeenAt, '暂无记录')}`);
  } else if (scope.empty) {
    statusLabel = '空范围';
    statusTone = 'amber';
  } else if (lastFailedRun) {
    const unknown = latestRun?.status === 'outcome_unknown';
    statusLabel = unknown ? '结果待核对' : '最近同步失败';
    statusTone = latestRun?.status === 'failed' || latestRun?.status === 'needs_login' ? 'red' : 'amber';
    healthNotes.push(unknown ? '保存结果待确认，先核对原请求' : `失败原因：${errorCodeLabel(latestRun?.errorCode ?? null) ?? '未记录'}`);
  } else if (latestRun?.status === 'success') {
    statusLabel = '正常';
    statusTone = 'green';
  } else if (latestDisplay) {
    statusLabel = latestDisplay.label;
    statusTone = latestDisplay.tone;
  }

  /* 立即同步被阻止时的短原因（模型里是长句，卡片只留状态词）。 */
  const blockedShort = blockedReason
    ? scope.empty
      ? '参与仓库为空，无法立即同步'
      : overview.account.status === 'needs_login'
        ? '需要重新登录，无法立即同步'
        : overview.account.status === 'disabled'
          ? '账号已停用，无法同步'
          : blockedReason
    : null;

  /* 抽屉当前页签：本地“结果未知”原请求 / URL 选中任务出现时自动落到详情页签，用户关闭后不再自动弹出。 */
  const panel: OpenPanel = openPanel ?? (autoDetail || autoSelectedRun ? 'detail' : null);
  const detailOpen = panel === 'detail';
  const settingsOpen = panel === 'settings';

  /** 关闭抽屉：同时收起自动弹出（本地恢复入口 / URL 选中任务），后续不自动重开。 */
  const dismissAutoDetail = useCallback(() => {
    if (autoDetail) setDismissedLocalId(localRequestId);
    if (autoSelectedRun) setDismissedSelectedRunId(selectedRunId);
  }, [autoDetail, autoSelectedRun, localRequestId, selectedRunId]);

  const closeDrawer = useCallback(() => {
    dismissAutoDetail();
    setOpenPanel(null);
  }, [dismissAutoDetail]);

  /* 抽屉是 modal：Tab / Shift+Tab 限制在抽屉内，焦点跑出立刻拉回（与商品详情弹层同一 hook）。 */
  useDialogFocusTrap(panel !== null, '#sync-source-drawer');

  /* Esc 关闭 + 打开时锁背景滚动（与库存详情抽屉一致）。 */
  useEffect(() => {
    if (!panel) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeDrawer();
    };
    window.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.documentElement.style.overflow = previousOverflow;
    };
  }, [panel, closeDrawer]);

  /* 焦点：打开/切页签进入对应页签按钮；关闭回到触发按钮；首屏自动打开不抢焦点。 */
  useEffect(() => {
    const previous = lastOpenRef.current;
    lastOpenRef.current = panel;
    if (!panel) {
      if (previous === 'detail') detailToggleRef.current?.focus();
      else if (previous === 'settings') settingsToggleRef.current?.focus();
      return;
    }
    if (previous === null && skipAutoFocusRef.current) {
      skipAutoFocusRef.current = false;
      return;
    }
    (panel === 'detail' ? detailTabRef : settingsTabRef).current?.focus();
  }, [panel]);

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

  /** 卡片上的「详情」「设置」：打开抽屉对应页签；当前页签再点一次即关闭。 */
  function togglePanel(nextPanel: Exclude<OpenPanel, null>): void {
    if (panel === nextPanel) {
      closeDrawer();
      return;
    }
    setOpenPanel(nextPanel);
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
        text: '清空参与仓库会停止发布，请再次确认。',
        tone: 'warn',
      });
      return;
    }
    setBusy('save');
    setMessage({ text: '正在保存…', tone: 'ok' });
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
        text: '保存结果未确认（连接中断）。刷新后核对原请求，不要重复保存。',
        tone: 'warn',
      });
      window.location.reload();
    } finally {
      setBusy(null);
    }
  }

  async function requestManualSync() {
    if (blockedReason) {
      setMessage({ text: blockedShort ?? blockedReason, tone: 'error' });
      return;
    }
    setBusy('manual');
    setMessage({ text: '正在提交…', tone: 'ok' });
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
        text: '同步提交结果未确认（连接中断）。刷新后核对原请求。',
        tone: 'warn',
      });
      window.location.reload();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div data-testid="sync-controls" id="sync-controls" className={styles.sourceGrid}>
      <section
        className={`${styles.sourceCard} ${styles.cardBigseller}`}
        data-testid="sync-source-row-bigseller"
        data-stagger="0"
        aria-label="BigSeller 海外库存同步"
      >
        <header className={styles.cardHead}>
          <span className={styles.cardIcon} aria-hidden>
            <Globe2 size={18} strokeWidth={1.8} />
          </span>
          <div className={styles.cardIdentity}>
            <h2>BigSeller</h2>
            <span className={styles.cardPurpose}>海外库存</span>
          </div>
          <div className={styles.cardStatus} data-testid="sync-source-status">
            <StatusPill tone={statusTone}>{statusLabel}</StatusPill>
          </div>
        </header>

        <dl className={styles.cardFacts}>
          <div data-testid="sync-source-last-data">
            <dt>最后成功数据</dt>
            <dd>
              {lastDataText}
              {lastDataAlert ? <small>{lastDataAlert}</small> : null}
            </dd>
          </div>
          <div data-testid="sync-source-next-plan">
            <dt>下次计划</dt>
            <dd>{nextRunText}</dd>
          </div>
          <div data-testid="sync-source-pending">
            <dt>待处理未对应</dt>
            <dd data-testid="sync-mapping">{formatQuantity(pendingTotal) || '0'}</dd>
          </div>
        </dl>

        <div className={styles.cardActions}>
          <button
            type="button"
            className={styles.primaryButton}
            onClick={requestManualSync}
            disabled={busy !== null || writeLocked || blockedReason !== null}
            title={blockedShort ?? '按已保存范围立即同步'}
            data-testid="sync-manual-button"
          >
            {busy === 'manual' ? '正在提交…' : '立即同步'}
          </button>
          <button
            ref={detailToggleRef}
            type="button"
            className={styles.secondaryButton}
            onClick={() => togglePanel('detail')}
            aria-expanded={detailOpen}
            aria-controls="sync-source-drawer"
            data-testid="sync-source-detail-toggle"
          >
            详情
          </button>
          <span className={styles.actionWrap} data-testid="sync-settings-toggle">
            <button
              ref={settingsToggleRef}
              type="button"
              className={styles.secondaryButton}
              onClick={() => togglePanel('settings')}
              aria-expanded={settingsOpen}
              aria-controls="sync-source-drawer"
              data-testid="sync-source-settings-toggle"
            >
              设置
            </button>
          </span>
        </div>

        {healthNotes.length > 0 ? (
          <div data-testid="sync-source-reason">
            <ul className={styles.cardAlerts} data-testid="sync-alerts">
              {healthNotes.map((note) => (
                <li key={note} data-testid="sync-alert-item">{note}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {blockedShort ? <p className={styles.blockedNote} data-testid="sync-manual-blocked">{blockedShort}</p> : null}

        {scope.empty ? (
          <p className={styles.cardNotice} data-testid="sync-scope-empty-notice">参与仓库为空：已停止发布</p>
        ) : null}

        {writeLocked ? (
          <p className={styles.writeLocked} data-testid="sync-write-locked">
            原请求待核对：保存设置与立即同步暂不可用。
            {local
              ? localOwner.trusted
                ? ' 本地还保留一条结果未知的原请求。'
                : ` 本地原请求${localOwner.reason ? `：${localOwner.reason}` : '身份不可信'}。`
              : ''}
          </p>
        ) : null}
      </section>

      {domesticCard}

      {panel ? (
        <div
          className={styles.drawerBackdrop}
          role="presentation"
          onClick={closeDrawer}
          data-testid="sync-drawer-backdrop"
        >
          <aside
            id="sync-source-drawer"
            className={styles.drawer}
            role="dialog"
            aria-modal="true"
            aria-label={`BigSeller ${detailOpen ? '同步详情' : '自动同步设置'}`}
            onClick={(event) => event.stopPropagation()}
            data-testid="sync-drawer"
          >
            <header className={styles.drawerHead}>
              <div>
                <h2>BigSeller</h2>
                <p>{detailOpen ? '同步详情' : '自动同步设置'}</p>
              </div>
              <button
                type="button"
                className={styles.drawerClose}
                onClick={closeDrawer}
                aria-label="关闭"
                title="关闭"
                data-testid="sync-drawer-close"
              >
                <X size={18} strokeWidth={1.8} aria-hidden />
              </button>
            </header>

            <div className={styles.drawerTabs} role="tablist" aria-label="来源面板">
              <button
                ref={detailTabRef}
                type="button"
                role="tab"
                id="sync-drawer-tab-detail"
                className={styles.drawerTab}
                data-active={detailOpen || undefined}
                aria-selected={detailOpen}
                aria-controls="sync-source-detail-panel"
                tabIndex={detailOpen ? 0 : -1}
                onClick={() => setOpenPanel('detail')}
                data-testid="sync-drawer-tab-detail"
              >
                详情
              </button>
              <button
                ref={settingsTabRef}
                type="button"
                role="tab"
                id="sync-drawer-tab-settings"
                className={styles.drawerTab}
                data-active={settingsOpen || undefined}
                aria-selected={settingsOpen}
                aria-controls="sync-settings-panel"
                tabIndex={settingsOpen ? 0 : -1}
                onClick={() => setOpenPanel('settings')}
                data-testid="sync-drawer-tab-settings"
              >
                设置
              </button>
            </div>

            <div className={styles.drawerBody}>
              {detailOpen ? (
                <div
                  id="sync-source-detail-panel"
                  className={styles.drawerPanel}
                  role="tabpanel"
                  aria-labelledby="sync-drawer-tab-detail"
                  data-testid="sync-source-detail-panel"
                >
                  <div className={styles.panelInner}>{detailContent}</div>
                </div>
              ) : null}

              {settingsOpen ? (
                <div
                  id="sync-settings-panel"
                  className={styles.drawerPanel}
                  role="tabpanel"
                  aria-labelledby="sync-drawer-tab-settings"
                  data-testid="sync-settings"
                >
                  <div data-testid="sync-source-settings-panel" className={styles.panelInner}>
                    <p className={styles.savedSummary} data-testid="sync-settings-summary">
                      <strong>已保存</strong>
                      {' · '}
                      {savedSummaryText}
                    </p>
                    <div className={styles.formGrid}>
                      <div className={styles.field}>
                        <span>自动同步</span>
                        <Checkbox
                          checked={enabled}
                          onChange={setEnabled}
                          label="开启自动同步"
                          disabled={busy !== null || writeLocked}
                        />
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
                          <SelectMenu
                            value={intervalUnit}
                            onChange={(value) => setIntervalUnit(value === 'hours' ? 'hours' : 'minutes')}
                            options={[
                              { value: 'minutes', label: '分钟' },
                              { value: 'hours', label: '小时' },
                            ]}
                            ariaLabel="同步频率单位"
                            testId="sync-interval-unit"
                            disabled={busy !== null || writeLocked}
                          />
                        </div>
                        {intervalError ? (
                          <p className={styles.fieldHint} data-tone="error">{intervalError}</p>
                        ) : null}
                      </div>

                      <div className={`${styles.field} ${styles.fieldWide}`}>
                        <span>参与仓库</span>
                        <div className={styles.warehouseGrid} data-testid="sync-warehouse-picker">
                          {selectableWarehouses.length === 0 ? (
                            <p className={styles.fieldHint}>未读到仓库清单</p>
                          ) : (
                            selectableWarehouses.map((warehouse) => (
                              <div key={warehouse.id} className={styles.warehouseOption} title={warehouse.externalId}>
                                <Checkbox
                                  checked={selected.includes(warehouse.id)}
                                  onChange={() => toggleWarehouse(warehouse.id)}
                                  disabled={busy !== null || writeLocked}
                                  ariaLabel={`参与仓库：${warehouse.name}`}
                                  label={(
                                    <span className={styles.warehouseLabel}>
                                      {warehouse.name}
                                      <small className={styles.rowSub}>{warehouseStatusLabel(warehouse.status)}</small>
                                    </span>
                                  )}
                                />
                              </div>
                            ))
                          )}
                        </div>
                        <p className={styles.fieldHint} data-testid="sync-scope-change-hint">
                          {scopeChange.kind === 'unchanged'
                            ? `未修改（当前 ${selectedWarehouseIds.length} 个）`
                            : scopeChange.kind === 'cleared'
                              ? '将清空参与仓库：保存后停止发布'
                              : `将更新为 ${scopeChange.warehouseIds.length} 个参与仓库`}
                        </p>
                      </div>
                    </div>

                    {draftDirty ? (
                      <p className={styles.draftNotice} data-testid="sync-draft-notice">
                        有未保存设置：<strong>立即同步仍按已保存范围执行</strong>
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
                </div>
              ) : null}
            </div>
          </aside>
        </div>
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
