'use client';

import { useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import styles from './inventory.module.css';
import {
  pendingActionLabel,
  pendingRecoveryKey,
  reconcileStateDisplay,
  timestampOr,
} from '../model';
import type { InventoryPendingActionDto, InventoryReconcileState } from '../types';
import {
  clearLocalUnknownRequest,
  getLocalUnknownServerSnapshot,
  getLocalUnknownSnapshot,
  localRecoveryKey,
  localUnknownOwnerCheck,
  saveLocalUnknownRequest,
  subscribeLocalUnknown,
  type LocalUnknownRequest,
  type LocalViewerIdentity,
} from '../client-pending';
import {
  reconcileInventoryRequestAction,
  registerInventoryRequestAction,
  retryInventoryPendingAction,
} from '../server/actions';
import {
  settlementReleasesLock,
  settlementResetsToReconcile,
  settlementTone,
} from '../settlement';

type Message = { text: string; tone: 'ok' | 'warn' | 'error' };

/* ------------------------------------------------------------------ *
 * 先登记后执行：所有写入口共用（不新增文件，客户端组件模块内导出）
 * ------------------------------------------------------------------ */

export interface RegistrationResult {
  /** 服务端已确认登记（拿到身份回执）：调用方才可以继续发原业务写。 */
  registered: boolean;
  /** 用于本地恢复记录的服务端身份；登记未知时回退到服务端渲染的 viewer 身份。 */
  actorId: string;
  accountId: string;
  /** true = 是否到达服务端未确认：调用方必须保留本地记录并整页重载，绝不再发业务写。 */
  unknown: boolean;
  message: string;
}

/**
 * 写动作前的“登记原请求”（R2 v4 契约 §2.3）：
 * - 先 registerInventoryRequestAction（app RPC begin_inventory_pending_action）；成功拿到服务端身份才允许调用原动作；
 * - 登记确定失败（冲突/已有 pending/参数无效）：不写本地记录、不发业务动作，只显示原因；
 * - 登记网络异常/结果未知：保存本地 v2 记录（registration:'unknown'）并返回 unknown，调用方整页重载；
 * - 登记成功后立即保存 v2 记录（registration:'registered'），供业务动作网络异常时恢复。
 * 客户端不生成身份：actorId/accountId 来自服务端登记回执或服务端渲染的 viewer。
 */
export async function registerOriginalRequest(input: {
  requestId: string;
  action: string;
  intent: string;
  payload: Record<string, unknown>;
  viewer: LocalViewerIdentity | null | undefined;
}): Promise<RegistrationResult> {
  const fallbackActorId = input.viewer?.actorId ?? '';
  const fallbackAccountId = input.viewer?.accountId ?? '';
  const keepUnknown = (message: string): RegistrationResult => {
    saveLocalUnknownRequest({
      requestId: input.requestId,
      action: input.action,
      intent: input.intent,
      payload: input.payload,
      actorId: fallbackActorId,
      accountId: fallbackAccountId,
      registration: 'unknown',
    });
    return { registered: false, actorId: fallbackActorId, accountId: fallbackAccountId, unknown: true, message };
  };
  try {
    const result = await registerInventoryRequestAction({
      requestId: input.requestId,
      action: input.action,
      intent: input.intent,
      payload: input.payload,
    });
    if (result.ok) {
      const actorId = typeof result.actorId === 'string' && result.actorId ? result.actorId : fallbackActorId;
      const accountId = typeof result.accountId === 'string' && result.accountId ? result.accountId : fallbackAccountId;
      if (!actorId) {
        return keepUnknown('原请求登记回执缺少可信身份：已停止后续写入并保留本地记录，刷新页面后先核对。');
      }
      saveLocalUnknownRequest({
        requestId: input.requestId,
        action: input.action,
        intent: input.intent,
        payload: input.payload,
        actorId,
        accountId,
        registration: 'registered',
      });
      return { registered: true, actorId, accountId, unknown: false, message: '' };
    }
    if (result.outcomeUnknown) {
      return keepUnknown(result.message
        || '原请求登记结果暂未确认（连接中断）：已停止后续写入并保留本地记录，刷新页面后先核对。');
    }
    return {
      registered: false,
      actorId: fallbackActorId,
      accountId: fallbackAccountId,
      unknown: false,
      message: result.message || '原请求登记被拒绝；未执行任何写操作。请刷新页面核对后重试。',
    };
  } catch {
    return keepUnknown('原请求登记结果暂未确认（连接中断）：已停止后续写入并保留本地记录，刷新页面后先核对。');
  }
}

/* ------------------------------------------------------------------ *
 * 恢复入口
 * ------------------------------------------------------------------ */

function RegistrationHint({ local }: { local: LocalUnknownRequest }) {
  return (
    <p style={{ margin: '6px 0 0' }} data-testid="sync-pending-registration">
      {local.registration === 'registered'
        ? '本地记录状态：原请求已确认登记到服务端；业务动作的网络异常才会走到这里，核对会以服务端记录为准。'
        : '本地记录状态：未确认这次登记是否到达服务端（可能请求未达）；先核对，只有明确“未找到”才允许重试。'}
    </p>
  );
}

/**
 * 内部 keyed 组件：状态必须按 pendingRecoveryKey(server pending) / localRecoveryKey(本地记录) 绑定。
 * requestId/intent/actor/account 任一变化 → 重新挂载，绝不继承上一条请求的 not_found/重试按钮。
 */
function PendingRecoveryInner({
  pending,
  local,
  viewer,
}: {
  pending: InventoryPendingActionDto | null;
  local: LocalUnknownRequest | null;
  viewer: LocalViewerIdentity | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<null | 'reconcile' | 'retry'>(null);
  const [state, setState] = useState<InventoryReconcileState | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const display = state ? reconcileStateDisplay(state) : null;

  const foreign = pending?.foreign === true;
  const localOwner = local ? localUnknownOwnerCheck(local, viewer) : { trusted: true, reason: null };
  const localExecutable = Boolean(local && localOwner.trusted);
  const requestId = pending?.requestId ?? local?.requestId ?? null;
  const canReconcile = pending
    ? !foreign && Boolean(pending.requestId)
    : localExecutable && Boolean(local?.requestId);

  async function reconcile() {
    if (!canReconcile || !requestId) return;
    setBusy('reconcile');
    setMessage({ text: '正在核对原请求（只读，不会重放动作）…', tone: 'ok' });
    try {
      const result = await reconcileInventoryRequestAction({
        requestId,
        // 只有服务端没有持久 pending 时，才把本地副本作为输入（服务端会重算 intent 并核完整参数）。
        action: pending ? undefined : local?.action,
        intent: pending ? undefined : local?.intent,
        payload: pending ? undefined : local?.payload,
        // 本地回退路径必须带原操作者：服务端要求与当前会话一致，B 不能接管 A 的请求。
        originActorId: pending ? undefined : local?.actorId,
      });
      setState(result.state);
      setMessage({
        text: result.message,
        tone: result.state === 'found' ? 'ok' : result.state === 'not_found' || result.state === 'found_unlock_failed' ? 'warn' : 'error',
      });
      if (result.state === 'failed_terminal') {
        // 先把“原操作失败，已处理完”显示给用户；随后只清这一条本地记录并刷新解锁。
        setState(result.state);
        setMessage({ text: result.message, tone: 'warn' });
        window.setTimeout(() => {
          if (requestId) clearLocalUnknownRequest(requestId);
          router.refresh();
        }, 1200);
        return;
      }
      if (result.state === 'found') {
        if (requestId) clearLocalUnknownRequest(requestId);
        router.refresh();
      }
    } catch {
      setState('failed');
      setMessage({
        text: '核对失败（连接或后台异常）：这不代表原请求未生效。请保留原请求稍后继续核对，不要发起新的写操作。',
        tone: 'error',
      });
    } finally {
      setBusy(null);
    }
  }

  async function retryOriginal() {
    // 只有“明确未找到”才出现重试；服务端持久 pending 只走服务端路径（不传本地参数）。
    if (state !== 'not_found' || !canReconcile || !requestId) return;
    setBusy('retry');
    setMessage({ text: '正在重试原操作（同 requestId + 同 intent + 原参数）…', tone: 'ok' });
    try {
      const result = await retryInventoryPendingAction({
        requestId,
        action: pending ? undefined : local?.action,
        intent: pending ? undefined : local?.intent,
        payload: pending ? undefined : local?.payload,
        originActorId: pending ? undefined : local?.actorId,
      });
      if (result.outcomeUnknown) {
        // 重试后又未知：回到“先核对”（服务端 pending 会出现），不保留直接重试入口。
        setState(null);
        setMessage({ text: result.message, tone: 'warn' });
        router.refresh();
        return;
      }
      // v4-final R2：只有业务成功且锁已确认解除，或服务端确认原请求已结案（settled/no_pending），
      // 才清本地记录/重置核对状态/刷新；结案失败、不是原请求、unlockFailed 一律保留记录与锁。
      const release = settlementReleasesLock(result);
      const tone = result.settlement === 'not_original' ? 'warn' : settlementTone(result);
      setMessage({ text: result.message, tone });
      if (release) {
        clearLocalUnknownRequest(requestId);
        setState(null);
        router.refresh();
        return;
      }
      if (settlementResetsToReconcile(result)) {
        // 结案未确认（服务端异常/连接中断）：不能当已解锁，回到“先核对”，本地记录保留。
        setState(null);
        router.refresh();
        return;
      }
      // not_original：本次调用被拒，原请求保持原样；保留“明确未找到”状态，可继续按原请求核对/重试。
    } catch {
      setState(null);
      setMessage({
        text: '重试结果暂未确认（连接中断）：原请求仍保留，请刷新后先核对，不要重复提交。',
        tone: 'warn',
      });
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  /* ---------------- 他人 pending：只显示忙碌，不提供任何执行 ---------------- */
  if (foreign) {
    return (
      <section className={styles.section} data-testid="sync-pending-recovery" data-foreign="true">
        <div className={styles.sectionHeader}>
          <h2>账号有其他未完成请求</h2>
          <p>这不是你的原请求；本页不显示 requestId/参数，也不提供核对/重试。</p>
        </div>
        <div className={styles.sectionBody}>
          <div className={styles.statusMessage} data-tone="warn" data-testid="sync-pending-foreign">
            <p style={{ margin: 0 }}>
              同一账号下另一位管理员有一个未完成请求（{pendingActionLabel(pending.action)}，发起时间 {timestampOr(pending.createdAt, '未记录')}）。
              在对方核对完成前，新的写操作会被服务端拒绝；请等待对方处理或联系管理员，本页面不会接管其意图。
            </p>
            {local ? (
              <p style={{ margin: '6px 0 0' }} data-local-note="foreign">
                本地还保留着一条原请求记录；在服务端请求处理完前一律锁定新写，本页不会执行这条本地记录。
              </p>
            ) : null}
          </div>
        </div>
      </section>
    );
  }

  /* ---------------- 仅本地记录：服务端没有持久 pending ---------------- */
  if (!pending && local) {
    if (!localExecutable) {
      return (
        <section
          className={styles.section}
          data-testid="sync-pending-recovery"
          data-local="true"
          data-untrusted="true"
        >
          <div className={styles.sectionHeader}>
            <h2>结果未知（保留待核实，不提供执行）</h2>
            <p>本地保留原请求记录，但它的归属/身份不可信：只显示现场并锁定新写，不提供核对或重试。</p>
          </div>
          <div className={styles.sectionBody}>
            <div className={styles.statusMessage} data-tone="warn" data-testid="sync-pending-local-untrusted">
              <p style={{ margin: 0 }}>
                {pendingActionLabel(local.action)} · 记录时间 {timestampOr(local.createdAt, '未记录')}
              </p>
              <p style={{ margin: '6px 0 0' }}>{localOwner.reason
                ?? '本地记录缺少可信身份：保留待核实，不自动归给当前管理员。'}</p>
              <p style={{ margin: '6px 0 0' }}>
                这条记录不会被执行、也不会被清除；新的写操作保持锁定。旧格式记录需原管理员登录后人工核实。
              </p>
            </div>
            <p
              role="status"
              aria-live="polite"
              className={styles.statusMessage}
              data-testid="sync-pending-message"
            >
              本页只显示待核实状态；没有核对/重试按钮。原请求的完整内容与身份仍保留在本地。
            </p>
          </div>
        </section>
      );
    }
    return (
      <section className={styles.section} data-testid="sync-pending-recovery" data-local="true">
        <div className={styles.sectionHeader}>
          <h2>结果未知（本地保留原请求）</h2>
          <p>服务端没有登记到这次请求（可能请求未到达服务端）；本地保留同一 requestId + intent + 原参数，核对/重试后仍只会有一份效果。</p>
        </div>
        <div className={styles.sectionBody}>
          <div className={styles.statusMessage} data-tone="warn">
            <p style={{ margin: 0 }}>
              {pendingActionLabel(local.action)} · 结果未知时间 {timestampOr(local.createdAt, '未记录')}
            </p>
            <RegistrationHint local={local} />
          </div>

          {display ? (
            <div
              className={styles.statusMessage}
              data-tone={display.tone === 'green' ? undefined : display.tone}
              data-testid="sync-pending-reconcile-state"
              data-state={state ?? undefined}
            >
              <strong>{display.title}</strong>
              <p style={{ margin: '6px 0 0' }}>{display.nextStep}</p>
            </div>
          ) : null}

          <div className={styles.buttonRow}>
            <button
              type="button"
              className={styles.primaryButton}
              onClick={reconcile}
              disabled={busy !== null}
              data-testid="sync-pending-reconcile"
            >
              {busy === 'reconcile' ? '正在核对…' : '核对原请求（只读）'}
            </button>
            {state === 'not_found' ? (
              <button
                type="button"
                className={styles.primaryButton}
                onClick={retryOriginal}
                disabled={busy !== null}
                data-testid="sync-pending-retry"
              >
                {busy === 'retry' ? '正在重试…' : '重试原操作（同 requestId + intent + 原参数）'}
              </button>
            ) : null}
          </div>

          <p
            role="status"
            aria-live="polite"
            className={styles.statusMessage}
            data-tone={message?.tone === 'ok' ? undefined : message?.tone}
            data-testid="sync-pending-message"
          >
            {message?.text ?? '先核对；只有“明确未找到”才会出现重试按钮。重试后结果又未知会回到“先核对”。'}
          </p>
        </div>
      </section>
    );
  }

  if (!pending) return null;

  /* ---------------- 服务端持久 pending（本人）：服务端记录是唯一依据 ---------------- */
  return (
    <section className={styles.section} data-testid="sync-pending-recovery">
      <div className={styles.sectionHeader}>
        <h2>原请求待核对</h2>
        <p>未完成原请求存在时，新的写操作会被服务端拒绝；这里只做核对/恢复。</p>
      </div>
      <div className={styles.sectionBody}>
        <div className={styles.statusMessage} data-tone="warn">
          <p style={{ margin: 0 }}>
            {pendingActionLabel(pending.action)} · 发起时间 {timestampOr(pending.createdAt, '未记录')}
          </p>
          <p style={{ margin: '6px 0 0' }}>
            原请求号、完整参数与 intent 由服务端持久保存；核对/重试只使用服务端记录，不重放业务写入。核对失败不会变成“未找到”。
          </p>
          {local ? (
            <p style={{ margin: '6px 0 0' }} data-testid="sync-pending-local-copy">
              本地也保留了同一原请求记录；以服务端记录为准，核对成功后会一并清除本地副本。
            </p>
          ) : null}
        </div>

        {display ? (
          <div
            className={styles.statusMessage}
            data-tone={display.tone === 'green' ? undefined : display.tone}
            data-testid="sync-pending-reconcile-state"
            data-state={state ?? undefined}
          >
            <strong>{display.title}</strong>
            <p style={{ margin: '6px 0 0' }}>{display.nextStep}</p>
          </div>
        ) : null}

        <div className={styles.buttonRow}>
          <button
            type="button"
            className={styles.primaryButton}
            onClick={reconcile}
            disabled={busy !== null || !canReconcile}
            data-testid="sync-pending-reconcile"
          >
            {busy === 'reconcile' ? '正在核对…' : '核对原请求（只读）'}
          </button>
          {state === 'not_found' ? (
            <button
              type="button"
              className={styles.primaryButton}
              onClick={retryOriginal}
              disabled={busy !== null}
              data-testid="sync-pending-retry"
            >
              {busy === 'retry' ? '正在重试…' : '重试原操作（服务端持久 requestId+intent）'}
            </button>
          ) : null}
        </div>

        <p
          role="status"
          aria-live="polite"
          className={styles.statusMessage}
          data-tone={message?.tone === 'ok' ? undefined : message?.tone}
          data-testid="sync-pending-message"
        >
          {message?.text ?? '先核对；只有“明确未找到”才会出现重试按钮。查询失败/无权限/解锁失败都会保留原请求，不会变成写动作。'}
        </p>
      </div>
    </section>
  );
}

/**
 * F4 恢复入口（页面级、统一组件）：
 * - 服务端 pending 优先；本地副本只在服务端没有 pending 时作为恢复对象；
 * - 本地记录归属由 viewer（服务端页面传入）判断：只有可信且同一 actor/account 才显示核对/重试；
 * - 状态按 pendingRecoveryKey(server) / localRecoveryKey(local) 绑定并重置（内部 keyed 子组件），
 *   新请求不得继承上一条的 not_found/重试按钮；
 * - 核对失败不会判成未找到；仅显式 found=false 才允许重试，重试后再次未知回到“先核对”。
 */
export function PendingRecoveryPanel({
  pending,
  viewer,
}: {
  pending: InventoryPendingActionDto | null;
  viewer: LocalViewerIdentity | null;
}) {
  // 本地“结果未知”副本用外部存储快照读取：hydration 用服务端快照 null，挂载后再读 sessionStorage，避免 setState-in-effect。
  const local = useSyncExternalStore(subscribeLocalUnknown, getLocalUnknownSnapshot, getLocalUnknownServerSnapshot);

  if (!pending && !local) return null;
  const bindingKey = `${pendingRecoveryKey(pending)}|${localRecoveryKey(local)}`;
  return <PendingRecoveryInner key={bindingKey} pending={pending} local={local} viewer={viewer} />;
}
