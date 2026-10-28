'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { callAppRpc } from '@/lib/database/app-db';
import type { DbIdentity } from '@/lib/database/app-db';
import {
  buildConfirmMappingsIntent,
  buildDisableMappingIntent,
  buildManualSyncIntent,
  buildRecheckMappingIntent,
  buildSettingsIntent,
  classifyActionError,
  confirmOutcomeMessage,
  disableMappingOutcomeMessage,
  isUuid,
  intentForActionPayload,
  manualSyncOutcomeMessage,
  normalizeIntervalInput,
  recheckOutcomeMessage,
  settingsOutcomeMessage,
  unlockFailedMessage,
  type ConfirmMappingInput,
  type IntervalUnit,
} from '../model';
import type {
  InventoryActionOutcome,
  InventoryReconcileOutcome,
  InventorySettlement,
  InventoryTargetItemDto,
} from '../types';
import {
  mapSettleRpcResponse,
  settlementMessageSuffix,
} from '../settlement';
import {
  getInventoryPendingActions,
  requireInventoryAdmin,
  searchInventoryTargetItems,
} from './reads';

/**
 * /dashboard/sync 与 /dashboard/inventory 的服务端动作（修复包 v2）。
 *
 * 统一流程（R5）：
 *   begin_inventory_pending_action → 原动作 RPC → complete(completed|failed)
 * - 网络/超时/未知结果 → 保持 pending，返回 outcomeUnknown，页面只能用“核对原请求（只读）”；
 * - 确定失败（版本/单位/参数/范围/登录等）→ complete(failed) 后返回可读原因；
 * - pending 期间 DB 用 INVENTORY_PENDING_RECOVERY_REQUIRED 拒绝新写；页面同时禁用按钮；
 * - “重试原操作”复用同一 requestId + 同一 intent，最终只有一份效果。
 */

const ACTION = {
  settings: 'update_inventory_sync_settings',
  manual: 'request_inventory_manual_sync',
  confirm: 'confirm_inventory_mapping',
  disable: 'disable_inventory_mapping',
  recheck: 'recheck_inventory_mapping',
} as const;

function resolveRequestId(value: unknown): string {
  return readRequestId(value) ?? randomUUID();
}

function readRequestId(value: unknown): string | null {
  return typeof value === 'string' && isUuid(value.trim()) ? value.trim() : null;
}

function readString(value: unknown, maxLength = 500): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function actionSuccess(overrides: Partial<InventoryActionOutcome> & { message: string }): InventoryActionOutcome {
  return { ok: true, deduped: false, runId: null, errorCode: null, ...overrides };
}

function actionFailure(error: unknown, requestId?: string): InventoryActionOutcome {
  const info = classifyActionError(error);
  return {
    ok: false,
    deduped: false,
    runId: null,
    errorCode: info.code,
    message: info.message,
    outcomeUnknown: info.outcomeUnknown,
    requestId,
    scopeEmpty: info.code === 'INVENTORY_SCOPE_EMPTY',
  };
}

function failureOutcome(input: {
  code: string;
  message: string;
  requestId: string;
  outcomeUnknown?: boolean;
  scopeEmpty?: boolean;
}): InventoryActionOutcome {
  return {
    ok: false,
    deduped: false,
    runId: null,
    errorCode: input.code,
    message: input.message,
    requestId: input.requestId,
    outcomeUnknown: input.outcomeUnknown ?? false,
    scopeEmpty: input.scopeEmpty,
  };
}

function invalidInput(message: string): InventoryActionOutcome {
  return { ok: false, deduped: false, runId: null, errorCode: 'INVALID_INPUT', message };
}

function revalidateInventoryPaths(): void {
  for (const path of ['/dashboard/sync', '/dashboard/inventory']) {
    try {
      revalidatePath(path);
    } catch {
      /* 已提交的结果仍然有效；刷新失败不影响回执。 */
    }
  }
}

/* ------------------------------------------------------------------ *
 * pending 编排
 * ------------------------------------------------------------------ */

interface BeginResponse {
  ok?: boolean;
  code?: string | null;
  requestId?: string | null;
  action?: string | null;
  status?: string | null;
  errorCode?: string | null;
  replayed?: boolean;
  actorId?: string | null;
  accountId?: string | null;
}

async function beginPending(
  identity: DbIdentity,
  params: { requestId: string; action: string; intent: string; payload: unknown },
): Promise<{ ok: true } | { ok: false; outcome: InventoryActionOutcome }> {
  try {
    const response = await callAppRpc<BeginResponse | null>(identity, 'catalog.begin_inventory_pending_action', [
      params.requestId,
      params.intent,
      params.action,
      JSON.stringify(params.payload ?? {}),
    ]);
    if (response && response.ok === false) {
      return {
        ok: false,
        outcome: failureOutcome({
          code: response.code ?? 'INVENTORY_PENDING_RECOVERY_REQUIRED',
          message: '存在未完成原请求：请先核对原请求，不能发起新的写操作。',
          requestId: params.requestId,
        }),
      };
    }
    // 同一 requestId 已失败结案：不得再执行原业务；交给页面按终态清锁。
    if (response && response.replayed === true && response.status === 'failed') {
      return { ok: false, outcome: failedTerminalOutcome(params.requestId, response.errorCode ?? null) };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, outcome: actionFailure(error, params.requestId) };
  }
}

/** 解除 pending：返回是否确认成功；失败时调用方不得提示“已解锁”。 */
async function completePending(
  identity: DbIdentity,
  requestId: string,
  status: 'completed' | 'failed',
  response: unknown,
  errorCode: string | null,
): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  try {
    await callAppRpc<unknown>(identity, 'catalog.complete_inventory_pending_action', [
      requestId,
      status,
      response === undefined ? null : JSON.stringify(response),
      errorCode,
    ]);
    return { ok: true };
  } catch (error) {
    const info = classifyActionError(error);
    return { ok: false, code: info.code, message: info.message };
  }
}

/**
 * 服务端业务动作在进入 executeWithPending 之前就确定失败（参数/前置校验/指纹不一致）时：
 * 客户端可能已经按流程登记了原请求；这里把**能证明是原请求本身**的已登记 pending 收口为 failed，
 * 避免留下“永远等不到业务写入”的假锁。
 *
 * v4-final R2：不再“仅凭 requestId”调用 complete(failed)（那会让另一份错 intent/参数的调用解除本人原锁）。
 * 统一改走 `catalog.settle_inventory_pending_action`：服务端单事务核 actor/action/intent/完整 payload_key，
 * 只有 SETTLED/NO_PENDING 才算结案；NOT_ORIGINAL/HAS_RECEIPT/FORBIDDEN/NOT_PENDING 一律保持原请求；
 * 连接/服务端异常 → settle_failed（保留锁）。参数不足以重建原请求身份时**不结案**。
 */
async function settleOriginalPending(
  identity: DbIdentity,
  params: {
    requestId: string;
    action: string;
    intent: string;
    payload: unknown;
    errorCode: string | null;
  },
): Promise<{ settlement: InventorySettlement; reason: string | null }> {
  try {
    const response = await callAppRpc<unknown>(identity, 'catalog.settle_inventory_pending_action', [
      params.requestId,
      params.action,
      params.intent,
      JSON.stringify(payloadRecord(params.payload)),
      params.errorCode,
    ]);
    const decision = mapSettleRpcResponse(response);
    return { settlement: decision.settlement, reason: decision.reason };
  } catch (error) {
    const info = classifyActionError(error);
    // 不抛：调用方按“结案未确认”保留原请求与锁。
    return { settlement: 'settle_failed', reason: info.code };
  }
}

function payloadRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** 把结案结果回填到动作结果：页码只按 settlement 决定是否解除本地记录与锁。 */
function withSettlement(
  outcome: InventoryActionOutcome,
  settlement: InventorySettlement,
): InventoryActionOutcome {
  const suffix = settlementMessageSuffix(settlement);
  return {
    ...outcome,
    settlement,
    message: suffix ? `${outcome.message} ${suffix}` : outcome.message,
  };
}

interface InvalidInputSettleContext {
  requestId: unknown;
  /**
   * 本次调用声明/提交的 action 与 intent（不是服务端重算值）。settle RPC 会用它们与持久原请求比对：
   * 错 intent/参数 ⇒ NOT_ORIGINAL，原请求保持原样；只有与原请求完全一致才可能结案。
   */
  action?: unknown;
  intent?: unknown;
  /** 能按规范形状重建的完整 payload；无法重建时传 null（不结案）。 */
  payload?: Record<string, unknown> | null;
}

async function invalidInputSettled(
  identity: DbIdentity,
  context: InvalidInputSettleContext,
  message: string,
  errorCode = 'INVALID_INPUT',
): Promise<InventoryActionOutcome> {
  const requestId = readRequestId(context.requestId);
  const outcome: InventoryActionOutcome = {
    ok: false,
    deduped: false,
    runId: null,
    errorCode,
    message,
    requestId: requestId ?? undefined,
  };
  if (!requestId) return outcome;
  const action = readString(context.action, 80);
  const intent = readString(context.intent, 128);
  const payload = context.payload;
  if (!action || !INTENT_HASH_PATTERN.test(intent) || !payload
    || typeof payload !== 'object' || Array.isArray(payload)) {
    // 无法重建/证明完整原请求身份：不结案，原锁保持。
    return outcome;
  }
  const settled = await settleOriginalPending(identity, {
    requestId,
    action,
    intent,
    payload,
    errorCode,
  });
  return withSettlement(outcome, settled.settlement);
}

/** 客户端 intent 必须与按同一参数重算值一致（防同 requestId 改变意图）。 */
function validateClientIntent(provided: unknown, expected: string): string | null {
  const value = readString(provided, 128);
  if (!value) return '缺少请求指纹（intent）；请刷新页面后重试。';
  if (value !== expected) return '请求指纹与原操作不一致，已拒绝（不能复用同一 requestId 改变意图）；请刷新后重试。';
  return null;
}

interface ExecuteWithPendingOptions<T> {
  identity: DbIdentity;
  requestId: string;
  action: string;
  intent: string;
  payload: unknown;
  execute: () => Promise<T>;
  onSuccess: (result: T) => InventoryActionOutcome;
  /** 业务 RPC 返回 ok:false 时（可读 code/message）→ 视为确定失败并结束 pending。 */
  onBusinessFailure?: (result: T) => InventoryActionOutcome | null;
}

async function executeWithPending<T>(options: ExecuteWithPendingOptions<T>): Promise<InventoryActionOutcome> {
  const begun = await beginPending(options.identity, {
    requestId: options.requestId,
    action: options.action,
    intent: options.intent,
    payload: options.payload,
  });
  if (!begun.ok) return begun.outcome;

  let result: T;
  try {
    result = await options.execute();
  } catch (error) {
    const info = classifyActionError(error);
    const outcome = actionFailure(error, options.requestId);
    // 未知异常（连接中断/超时）：保持 pending，不结案，页面只能先核对。
    if (info.outcomeUnknown) return outcome;
    const settled = await settleOriginalPending(options.identity, {
      requestId: options.requestId,
      action: options.action,
      intent: options.intent,
      payload: options.payload,
      errorCode: info.code,
    });
    return withSettlement(outcome, settled.settlement);
  }

  const businessFailure = options.onBusinessFailure?.(result) ?? null;
  if (businessFailure) {
    const settled = await settleOriginalPending(options.identity, {
      requestId: options.requestId,
      action: options.action,
      intent: options.intent,
      payload: options.payload,
      errorCode: businessFailure.errorCode,
    });
    const failure = withSettlement(
      { ...businessFailure, requestId: options.requestId },
      settled.settlement,
    );
    // 结案未确认：业务确定没生效但锁还在，不能提示“已解锁”。
    return settled.settlement === 'settle_failed' ? { ...failure, unlockFailed: true } : failure;
  }
  const completed = await completePending(options.identity, options.requestId, 'completed', result, null);
  revalidateInventoryPaths();
  const outcome = { ...options.onSuccess(result), requestId: options.requestId };
  if (!completed.ok) {
    // 业务已生效但解锁失败：settle_failed + unlockFailed，原请求保留。
    return withSettlement(
      { ...outcome, unlockFailed: true, message: unlockFailedMessage(outcome.message) },
      'settle_failed',
    );
  }
  return outcome;
}

/** 重试原操作：不 begin（pending 已存在），复用同一 requestId + intent 后 complete/settle。 */
async function executeRetry<T>(options: {
  identity: DbIdentity;
  requestId: string;
  action: string;
  intent: string;
  payload: Record<string, unknown>;
  execute: () => Promise<T>;
  onSuccess: (result: T) => InventoryActionOutcome;
  onBusinessFailure?: (result: T) => InventoryActionOutcome | null;
}): Promise<InventoryActionOutcome> {
  let result: T;
  try {
    result = await options.execute();
  } catch (error) {
    const info = classifyActionError(error);
    const outcome = actionFailure(error, options.requestId);
    // 未知异常：保持 pending，不结案（否则会把“可能已生效”的原请求误判为 failed）。
    if (info.outcomeUnknown) return outcome;
    const settled = await settleOriginalPending(options.identity, {
      requestId: options.requestId,
      action: options.action,
      intent: options.intent,
      payload: options.payload,
      errorCode: info.code,
    });
    return withSettlement(outcome, settled.settlement);
  }
  const businessFailure = options.onBusinessFailure?.(result) ?? null;
  if (businessFailure) {
    const settled = await settleOriginalPending(options.identity, {
      requestId: options.requestId,
      action: options.action,
      intent: options.intent,
      payload: options.payload,
      errorCode: businessFailure.errorCode,
    });
    const failure = withSettlement(
      { ...businessFailure, requestId: options.requestId },
      settled.settlement,
    );
    return settled.settlement === 'settle_failed' ? { ...failure, unlockFailed: true } : failure;
  }
  const completed = await completePending(options.identity, options.requestId, 'completed', result, null);
  revalidateInventoryPaths();
  const outcome = { ...options.onSuccess(result), requestId: options.requestId };
  if (!completed.ok) {
    return withSettlement(
      { ...outcome, unlockFailed: true, message: unlockFailedMessage(outcome.message) },
      'settle_failed',
    );
  }
  return outcome;
}

/* ------------------------------------------------------------------ *
 * 设置（R7：未修改范围 / 明确清空）
 * ------------------------------------------------------------------ */

interface SettingsResponse {
  ok?: boolean;
  code?: string | null;
  message?: string | null;
  changed?: unknown;
  settings?: {
    enabled?: boolean;
    intervalMinutes?: number;
    nextRunAt?: string | null;
    scopeWarehouseCount?: number;
    warehouseCount?: number;
    scopeEmpty?: boolean;
    scopeId?: string | null;
  } | null;
}

const CHANGED_LABELS: Record<string, string> = {
  created: '首次保存参与范围',
  enabled: '自动启停',
  interval: '同步频率',
  intervalMinutes: '同步频率',
  interval_minutes: '同步频率',
  scope: '参与仓库',
  warehouses: '参与仓库',
  warehouse_ids: '参与仓库',
};

function changedText(changed: unknown): string {
  if (!Array.isArray(changed) || changed.length === 0) return '设置已保存';
  const labels: string[] = [];
  for (const entry of changed) {
    const label = CHANGED_LABELS[readString(entry, 40)];
    if (label && !labels.includes(label)) labels.push(label);
  }
  return labels.length > 0 ? `已更新：${labels.join('、')}` : '设置已保存';
}

interface SaveSettingsInput {
  enabled?: unknown;
  intervalValue?: unknown;
  intervalUnit?: unknown;
  intervalMinutes?: unknown;
  scopeProvided?: unknown;
  warehouseIds?: unknown;
  requestId?: unknown;
  /** 客户端生成的请求指纹（sha256 hex）；服务端按同一参数重算核对。 */
  intent?: unknown;
  /** 空范围二次确认：页面第二次点击时带 true。 */
  confirmClearScope?: unknown;
}

export async function saveSyncSettingsAction(input: SaveSettingsInput): Promise<InventoryActionOutcome> {
  try {
    const identity = await requireInventoryAdmin();
    if (typeof input.enabled !== 'boolean') {
      return invalidInputSettled(identity, { requestId: input.requestId }, '请先勾选或取消“自动同步”，再保存设置。');
    }
    const enabledInput: boolean = input.enabled;
    let minutes: number;
    if (input.intervalMinutes !== undefined && input.intervalMinutes !== null) {
      const raw = Number(input.intervalMinutes);
      const parsed = normalizeIntervalInput(String(Number.isSafeInteger(raw) ? raw : ''), 'minutes');
      if (!parsed.ok) return invalidInputSettled(identity, { requestId: input.requestId }, parsed.reason);
      minutes = parsed.minutes;
    } else {
      const unit: IntervalUnit = input.intervalUnit === 'hours' ? 'hours' : 'minutes';
      const parsed = normalizeIntervalInput(readString(input.intervalValue, 12), unit);
      if (!parsed.ok) return invalidInputSettled(identity, { requestId: input.requestId }, parsed.reason);
      minutes = parsed.minutes;
    }

    const scopeProvided = input.scopeProvided === true;
    let warehouseIds: string[] = [];
    if (scopeProvided) {
      if (!Array.isArray(input.warehouseIds)) {
        return invalidInputSettled(identity, { requestId: input.requestId }, '参与仓库格式不正确，请刷新页面后重新选择。');
      }
      warehouseIds = [...new Set(input.warehouseIds.map((entry) => readString(entry, 80)).filter(Boolean))];
      if (warehouseIds.some((entry) => !isUuid(entry))) {
        return invalidInputSettled(identity, { requestId: input.requestId }, '参与仓库标识无效，请刷新页面后重新选择。');
      }
      if (warehouseIds.length === 0 && input.confirmClearScope !== true) {
        return {
          ok: false,
          deduped: false,
          runId: null,
          errorCode: 'CONFIRM_CLEAR_SCOPE',
          message: '清空全部参与仓库会停止发布（不会回退旧范围）。请再次确认后保存。',
          requestId: resolveRequestId(input.requestId),
          scopeEmpty: true,
        };
      }
    }
    // 规范顺序：payload 与 intent 使用同一份排序去重后的仓库集合（完整内容绑定需要稳定形状）。
    warehouseIds = [...warehouseIds].sort();

    const requestId = resolveRequestId(input.requestId);
    const payload = { enabled: enabledInput, intervalMinutes: minutes, scopeProvided, warehouseIds };
    const intent = buildSettingsIntent({ enabled: enabledInput, intervalMinutes: minutes, scopeProvided, warehouseIds });
    const intentError = validateClientIntent(input.intent, intent);
    if (intentError) {
      // 用本次调用提交的 intent + 规范 payload 调 settle：只有与原请求完全一致才可能结案；
      // 错 intent/参数由服务端返回 NOT_ORIGINAL，原请求保持原样。
      return invalidInputSettled(identity, {
        requestId,
        action: ACTION.settings,
        intent: input.intent,
        payload,
      }, intentError, 'INVENTORY_REQUEST_CONFLICT');
    }
    return executeWithPending<SettingsResponse>({
      identity,
      requestId,
      action: ACTION.settings,
      intent,
      payload,
      execute: () => callAppRpc<SettingsResponse>(identity, 'catalog.update_inventory_sync_settings', [
        requestId,
        intent,
        enabledInput,
        minutes,
        scopeProvided,
        warehouseIds,
      ]),
      onBusinessFailure: (response) => {
        if (!response || response.ok !== false) return null;
        return failureOutcome({
          code: response.code ?? 'SETTINGS_REJECTED',
          message: response.message ?? '服务端拒绝了本次设置，原有设置保持不变；请刷新核对后重试。',
          requestId,
        });
      },
      onSuccess: (response) => {
        const savedInterval = typeof response?.settings?.intervalMinutes === 'number' ? response.settings.intervalMinutes : minutes;
        const enabled = typeof response?.settings?.enabled === 'boolean' ? response.settings.enabled : enabledInput;
        const scopeEmpty = response?.settings?.scopeEmpty === true || (scopeProvided && warehouseIds.length === 0);
        const scopeWarehouseCount = typeof response?.settings?.warehouseCount === 'number'
          ? response.settings.warehouseCount
          : (scopeProvided ? warehouseIds.length : undefined);
        const message = settingsOutcomeMessage({
          enabled,
          intervalMinutes: savedInterval,
          warehouseCount: scopeWarehouseCount ?? 0,
          scopeProvided,
          scopeEmpty,
          nextRunAt: response?.settings?.nextRunAt ?? null,
        });
        return actionSuccess({
          message: `${changedText(response?.changed)}；${message}`,
          scopeEmpty,
        });
      },
    });
  } catch (error) {
    return actionFailure(error);
  }
}

/* ------------------------------------------------------------------ *
 * 立即同步（空范围/登录失效给明确原因）
 * ------------------------------------------------------------------ */

interface ManualResponse {
  ok?: boolean;
  code?: string | null;
  message?: string | null;
  deduped?: boolean;
  runId?: string | null;
  status?: string | null;
}

export async function requestManualSyncAction(input: { requestId?: unknown; intent?: unknown }): Promise<InventoryActionOutcome> {
  try {
    const identity = await requireInventoryAdmin();
    const requestId = resolveRequestId(input?.requestId);
    const intent = buildManualSyncIntent();
    const intentError = validateClientIntent(input?.intent, intent);
    if (intentError) {
      // 提交的 intent 与持久原请求不符 ⇒ 服务端返回 NOT_ORIGINAL，原请求保持原样。
      return invalidInputSettled(identity, {
        requestId,
        action: ACTION.manual,
        intent: input?.intent,
        payload: {},
      }, intentError, 'INVENTORY_REQUEST_CONFLICT');
    }
    return executeWithPending<ManualResponse>({
      identity,
      requestId,
      action: ACTION.manual,
      intent,
      payload: {},
      execute: () => callAppRpc<ManualResponse>(identity, 'catalog.request_inventory_manual_sync', [requestId, intent]),
      onBusinessFailure: (response) => {
        if (!response || response.ok !== false) return null;
        const code = response.code ?? 'MANUAL_SYNC_REJECTED';
        return failureOutcome({
          code,
          message: response.message ?? (code === 'INVENTORY_SCOPE_EMPTY'
            ? '参与仓库为空：已停止发布，无法同步；请先在数据同步页重新选择参与仓库。'
            : '服务端拒绝了本次立即同步；请刷新核对当前任务状态后重试。'),
          requestId,
          scopeEmpty: code === 'INVENTORY_SCOPE_EMPTY',
        });
      },
      onSuccess: (response) => {
        const deduped = response?.deduped === true;
        const runId = typeof response?.runId === 'string' ? response.runId : null;
        return actionSuccess({ deduped, runId, message: manualSyncOutcomeMessage({ deduped, runId }) });
      },
    });
  } catch (error) {
    return actionFailure(error);
  }
}

/* ------------------------------------------------------------------ *
 * 对应确认/换绑（R2：仓库/单位/理由必填；旧版本防覆盖）
 * ------------------------------------------------------------------ */

interface ConfirmResponse {
  ok?: boolean;
  code?: string | null;
  message?: string | null;
  applied?: number;
  skipped?: unknown;
}

function parseConfirmMappings(raw: unknown): { ok: true; mappings: ConfirmMappingInput[] } | { ok: false; message: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, message: '请先勾选并填写要确认的对应行（不会默认全选）。' };
  if (raw.length > 100) return { ok: false, message: '一次最多确认 100 条对应，请分批处理。' };
  const mappings: ConfirmMappingInput[] = [];
  for (const entry of raw) {
    const record = (entry ?? {}) as Record<string, unknown>;
    const externalSku = readString(record.externalSku, 200);
    const warehouseExternalId = readString(record.warehouseExternalId, 120);
    const itemId = readString(record.itemId, 64);
    const unit = readString(record.unit, 40);
    const reason = readString(record.reason, 500);
    const note = readString(record.note, 500);
    const expectedVersionRaw = record.expectedVersion;
    const expectedVersion = expectedVersionRaw === null || expectedVersionRaw === undefined
      ? null
      : Number(expectedVersionRaw);
    const verification = record.verification === true;
    if (!externalSku) return { ok: false, message: '有对应行缺少外部 SKU，本次未处理。' };
    if (!warehouseExternalId) return { ok: false, message: `${externalSku}：必须选择该 SKU 出现的仓库（不再创建账号级默认）。` };
    if (!isUuid(itemId)) return { ok: false, message: `${externalSku}：请手动选择有效目标商品。` };
    if (!unit) return { ok: false, message: `${externalSku} / ${warehouseExternalId}：必须填写单位（不自动使用“件”）。` };
    if (!reason) return { ok: false, message: `${externalSku} / ${warehouseExternalId}：必须填写确认理由。` };
    if (expectedVersion !== null && !Number.isSafeInteger(expectedVersion)) {
      return { ok: false, message: `${externalSku}：旧版本号无效，请刷新后重试。` };
    }
    mappings.push({ externalSku, warehouseExternalId, itemId, unit, reason, note: note || null, expectedVersion, verification });
  }
  return { ok: true, mappings };
}

export async function confirmInventoryMappingsAction(input: {
  mappings?: unknown;
  requestId?: unknown;
  intent?: unknown;
}): Promise<InventoryActionOutcome> {
  try {
    const identity = await requireInventoryAdmin();
    const parsed = parseConfirmMappings(input.mappings);
    // 解析失败时无法重建完整 mappings payload：不结案，原请求与锁保持。
    if (!parsed.ok) return invalidInputSettled(identity, { requestId: input.requestId }, parsed.message);
    const requestId = resolveRequestId(input.requestId);
    const intent = buildConfirmMappingsIntent(parsed.mappings);
    const intentError = validateClientIntent(input.intent, intent);
    const payload = { mappings: parsed.mappings };
    if (intentError) {
      // 用提交的 intent + 本次 mappings 重建 payload：错 intent/参数 ⇒ NOT_ORIGINAL，原请求不动。
      return invalidInputSettled(identity, {
        requestId,
        action: ACTION.confirm,
        intent: input.intent,
        payload,
      }, intentError, 'INVENTORY_REQUEST_CONFLICT');
    }
    return executeWithPending<ConfirmResponse>({
      identity,
      requestId,
      action: ACTION.confirm,
      intent,
      payload,
      execute: () => callAppRpc<ConfirmResponse>(identity, 'catalog.confirm_inventory_mapping', [
        requestId,
        intent,
        JSON.stringify(parsed.mappings),
      ]),
      onBusinessFailure: (response) => {
        if (!response || response.ok !== false) return null;
        return failureOutcome({
          code: response.code ?? 'MAPPING_REJECTED',
          message: response.message ?? '服务端拒绝了本次对应确认；请核对仓库、商品、单位与旧版本后重试。',
          requestId,
        });
      },
      onSuccess: (response) => {
        const applied = Number(response?.applied ?? 0) || 0;
        const skipped = Array.isArray(response?.skipped) ? response.skipped : [];
        return actionSuccess({ message: confirmOutcomeMessage(applied, skipped) });
      },
    });
  } catch (error) {
    return actionFailure(error);
  }
}

interface MappingMutationResponse {
  ok?: boolean;
  code?: string | null;
  message?: string | null;
  status?: string | null;
  version?: number | null;
}

function mappingActionResult(response: MappingMutationResponse | null, kind: 'recheck' | 'disable'): InventoryActionOutcome {
  if (response && response.ok === false) {
    return {
      ok: false,
      deduped: false,
      runId: null,
      errorCode: response.code ?? 'MAPPING_REJECTED',
      message: response.message ?? (kind === 'recheck'
        ? '服务端拒绝了本次重核；对应关系保持原样，请刷新后重新核对。'
        : '服务端拒绝了本次停用；对应关系保持原样，请刷新后重新核对。'),
    };
  }
  return actionSuccess({ message: kind === 'recheck' ? recheckOutcomeMessage() : disableMappingOutcomeMessage() });
}

export async function recheckInventoryMappingAction(input: {
  mappingId?: unknown;
  expectedVersion?: unknown;
  reason?: unknown;
  requestId?: unknown;
  intent?: unknown;
}): Promise<InventoryActionOutcome> {
  try {
    const identity = await requireInventoryAdmin();
    const mappingId = readString(input.mappingId, 64);
    const expectedVersion = Number(input.expectedVersion);
    const reason = readString(input.reason, 500);
    // 标识/版本/理由缺失时无法重建完整 payload：不结案，原请求与锁保持。
    if (!isUuid(mappingId)) return invalidInputSettled(identity, { requestId: input.requestId }, '对应关系标识无效；请刷新后重试。');
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) return invalidInputSettled(identity, { requestId: input.requestId }, '缺少对应关系的旧版本号；请刷新后重试。');
    if (!reason) return invalidInputSettled(identity, { requestId: input.requestId }, '必须填写重核理由。');
    const requestId = resolveRequestId(input.requestId);
    const intent = buildRecheckMappingIntent({ mappingId, expectedVersion, reason });
    const intentError = validateClientIntent(input.intent, intent);
    const payload = { mappingId, expectedVersion, reason, note: reason };
    if (intentError) {
      return invalidInputSettled(identity, {
        requestId,
        action: ACTION.recheck,
        intent: input.intent,
        payload,
      }, intentError, 'INVENTORY_REQUEST_CONFLICT');
    }
    return executeWithPending<MappingMutationResponse>({
      identity,
      requestId,
      action: ACTION.recheck,
      intent,
      payload,
      execute: () => callAppRpc<MappingMutationResponse>(identity, 'catalog.recheck_inventory_mapping', [
        requestId,
        intent,
        mappingId,
        reason,
        expectedVersion,
      ]),
      onSuccess: (response) => mappingActionResult(response, 'recheck'),
    });
  } catch (error) {
    return actionFailure(error);
  }
}

export async function disableInventoryMappingAction(input: {
  mappingId?: unknown;
  expectedVersion?: unknown;
  reason?: unknown;
  note?: unknown;
  requestId?: unknown;
  intent?: unknown;
}): Promise<InventoryActionOutcome> {
  try {
    const identity = await requireInventoryAdmin();
    const mappingId = readString(input.mappingId, 64);
    const expectedVersion = Number(input.expectedVersion);
    const reason = readString(input.reason, 500) || readString(input.note, 500);
    if (!isUuid(mappingId)) return invalidInputSettled(identity, { requestId: input.requestId }, '对应关系标识无效；请刷新后重试。');
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) return invalidInputSettled(identity, { requestId: input.requestId }, '缺少对应关系的旧版本号；请刷新后重试。');
    if (!reason) return invalidInputSettled(identity, { requestId: input.requestId }, '必须填写停用理由。');
    const requestId = resolveRequestId(input.requestId);
    const intent = buildDisableMappingIntent({ mappingId, expectedVersion, reason });
    const intentError = validateClientIntent(input.intent, intent);
    const payload = { mappingId, expectedVersion, reason, note: reason };
    if (intentError) {
      return invalidInputSettled(identity, {
        requestId,
        action: ACTION.disable,
        intent: input.intent,
        payload,
      }, intentError, 'INVENTORY_REQUEST_CONFLICT');
    }
    return executeWithPending<MappingMutationResponse>({
      identity,
      requestId,
      action: ACTION.disable,
      intent,
      payload,
      execute: () => callAppRpc<MappingMutationResponse>(identity, 'catalog.disable_inventory_mapping', [
        requestId,
        intent,
        mappingId,
        reason,
        expectedVersion,
      ]),
      onSuccess: (response) => mappingActionResult(response, 'disable'),
    });
  } catch (error) {
    return actionFailure(error);
  }
}

/* ------------------------------------------------------------------ *
 * 核对（只读，不 replay）与“重试原操作”（同 requestId+intent）
 * ------------------------------------------------------------------ */

function receiptSummary(action: string, response: unknown): string {
  const record = (response ?? {}) as Record<string, unknown>;
  if (action === ACTION.manual) {
    const deduped = record.deduped === true;
    return deduped ? '原请求已生效：命中已有任务，没有重复排队。' : '原请求已生效：已创建同步任务。';
  }
  if (action === ACTION.settings) {
    return '原请求已生效：设置已保存。';
  }
  if (action === ACTION.confirm) {
    const applied = Number(record.applied ?? 0) || 0;
    return `原请求已生效：已提交 ${applied} 条对应。`;
  }
  if (action === ACTION.recheck) return '原请求已生效：对应已进入待重核。';
  if (action === ACTION.disable) return '原请求已生效：对应已停用。';
  return '原请求已生效。';
}

const INTENT_HASH_PATTERN = /^[a-f0-9]{64}$/;

const REGISTERABLE_ACTIONS = new Set<string>(Object.values(ACTION));

export interface RegisterRequestOutcome {
  ok: boolean;
  requestId: string | null;
  action: string | null;
  actorId: string | null;
  accountId: string | null;
  intent: string | null;
  replayed?: boolean;
  errorCode: string | null;
  outcomeUnknown?: boolean;
  message: string;
}

/**
 * 写操作前先登记“原请求”（服务端持久 pending）：身份由服务端会话决定，客户端不能自报操作者。
 * - intent 必须能由完整 payload 按 v4 结构化编码重算得到（拒绝同 requestId 改内容）；
 * - 登记成功返回服务端身份（actorId/accountId），本地副本据此绑定归属；
 * - 登记失败/未知：调用方不得继续发业务写；本地只保留记录并锁新写。
 */
export async function registerInventoryRequestAction(input: {
  requestId?: unknown;
  action?: unknown;
  intent?: unknown;
  payload?: unknown;
}): Promise<RegisterRequestOutcome> {
  const fail = (message: string, errorCode: string, requestId: string | null = null,
    outcomeUnknown = false): RegisterRequestOutcome => ({
    ok: false,
    requestId,
    action: null,
    actorId: null,
    accountId: null,
    intent: null,
    errorCode,
    outcomeUnknown,
    message,
  });
  try {
    const identity = await requireInventoryAdmin();
    const requestId = resolveRequestId(input?.requestId);
    const action = readString(input?.action, 80);
    const intent = readString(input?.intent, 128);
    if (!REGISTERABLE_ACTIONS.has(action)) {
      return fail('原请求类型无效，未执行任何写操作；请刷新页面后重试。', 'INVALID_INPUT', requestId);
    }
    const payload = (input?.payload && typeof input.payload === 'object' && !Array.isArray(input.payload))
      ? input.payload as Record<string, unknown>
      : null;
    if (!payload) {
      return fail('原请求内容不完整，未执行任何写操作；请刷新页面后重试。', 'INVALID_INPUT', requestId);
    }
    if (!INTENT_HASH_PATTERN.test(intent)) {
      return fail('缺少有效的请求指纹，未执行任何写操作；请刷新页面后重试。', 'INVALID_INPUT', requestId);
    }
    const expected = intentForActionPayload(action, payload);
    if (!expected || expected !== intent) {
      return fail('请求指纹与原内容不一致（不能复用同一 requestId 改变操作内容）；未执行任何写操作。',
        'INVENTORY_REQUEST_CONFLICT', requestId);
    }
    const response = await callAppRpc<BeginResponse | null>(identity, 'catalog.begin_inventory_pending_action', [
      requestId,
      intent,
      action,
      JSON.stringify(payload),
    ]);
    if (response && response.ok === false) {
      return fail(response.code === 'INVENTORY_PENDING_RECOVERY_REQUIRED'
        ? '存在未完成原请求：请先核对原请求，不能发起新的写操作。'
        : '原请求登记被拒绝；未执行任何写操作。请刷新页面核对。',
      response.code ?? 'INVENTORY_PENDING_RECOVERY_REQUIRED', requestId);
    }
    if (!response || response.ok !== true) {
      return fail('原请求登记未返回明确结果：这不代表已执行；请刷新页面，先核对再决定是否重试。',
        'INVENTORY_REGISTER_OUTCOME_UNKNOWN', requestId, true);
    }
    return {
      ok: true,
      requestId,
      action,
      actorId: identity.profileUserId,
      accountId: typeof response.accountId === 'string' ? response.accountId : null,
      intent,
      replayed: response.replayed === true,
      errorCode: null,
      message: '原请求已登记：现在执行原操作；若结果未知，用同一请求核对。',
    };
  } catch (error) {
    const info = classifyActionError(error);
    return fail(
      info.outcomeUnknown
        ? '原请求登记结果未知（连接中断）：不能继续执行新写；刷新页面后先核对，不要直接重试。'
        : `原请求登记失败（${info.code}）：未执行任何写操作。`,
      info.code,
      null,
      info.outcomeUnknown,
    );
  }
}

async function loadOwnPendingAction(
  identity: DbIdentity,
  requestId: string,
): Promise<{ ok: true; action: string; intent: string; payload: Record<string, unknown>; status: string } | { ok: false; message: string; errorCode: string }> {
  let rows;
  try {
    rows = await getInventoryPendingActions(identity);
  } catch (error) {
    const info = classifyActionError(error);
    return { ok: false, errorCode: info.code, message: '读取原请求失败（异常/无权限）：这不代表请求未生效，原请求仍保留；请稍后继续核对。' };
  }
  // pending 行用于核对/重试；failed 终态用于核对并阻止再次执行原业务（不能当“从未登记”）。
  const own = rows.find((row) => !row.foreign
    && row.requestId === requestId
    && (row.status === null || row.status === undefined
      || row.status === 'pending' || row.status === 'failed'));
  if (!own) {
    return { ok: false, errorCode: 'INVENTORY_PENDING_NOT_FOUND', message: '没有找到本人在待核对的原请求（可能已处理或不属于当前账号）；请刷新页面确认，不要用客户端参数重试。' };
  }
  const action = own.action;
  const intent = (own.intent ?? '').trim();
  if (!action || !INTENT_HASH_PATTERN.test(intent)) {
    return { ok: false, errorCode: 'INVENTORY_PENDING_INVALID', message: '服务端保存的原请求缺少完整 action/intent，不能核对或重试；请保留现场并联系管理员。' };
  }
  return { ok: true, action, intent, payload: own.payload ?? {}, status: own.status ?? 'pending' };
}

/** 已失败结案的原请求：只发核对确认，不执行任何业务；返回明确的终态结果供页面清锁。 */
function failedTerminalOutcome(requestId: string, detail?: string | null): InventoryActionOutcome {
  return {
    ok: false,
    deduped: false,
    runId: null,
    errorCode: detail ?? null,
    message: '原操作失败，已处理完，可以修正后重新操作。旧请求不会再次执行；新操作会使用新的请求编号。',
    requestId,
    settlement: 'settled',
  };
}

/**
 * 本地副本回退路径的身份门槛：原操作者必须与当前服务端会话一致。
 * 客户端自报操作者不算证明，但服务端至少拒绝“换管理员后把 A 的请求当自己的执行”的常见分支；
 * 新格式本地记录还必须带服务端登记的 actorId（旧记录没有，只能保留待核实）。
 */
function validateLocalOrigin(identity: DbIdentity, originActorId: unknown): string | null {
  const origin = readString(originActorId, 64);
  if (!origin) return 'INVENTORY_PENDING_ORIGIN_MISSING';
  if (origin !== identity.profileUserId) return 'INVENTORY_PENDING_OWNER_MISMATCH';
  return null;
}

function localOriginMessage(code: string): string {
  if (code === 'INVENTORY_PENDING_OWNER_MISMATCH') {
    return '本地保留的原请求属于另一位管理员：当前会话不能核对或重试；记录已保留待核实，请原管理员登录处理。';
  }
  return '本地保留的原请求缺少可信的原操作者：保留现场待核实，不会自动归给当前管理员；请刷新页面或联系管理员。';
}

/**
 * 核对原请求：只读 RPC，绝不 replay；只信任持久 pending（本人）的 action/intent。
 * - 仅显式 found===true 才算找到；找到后单独 complete，complete 失败 → found_unlock_failed；
 * - 仅显式 found===false 才算“明确未找到”；
 * - RPC 返回 null/畸形、读取失败、无权限、异常 → failed，原请求保持。
 */
export async function reconcileInventoryRequestAction(input: {
  requestId?: unknown;
  /** 仅当服务端没有持久 pending 行（请求未达服务端）时，页面本地保留的原请求；服务端按完整 intent 校验。 */
  action?: unknown;
  intent?: unknown;
  payload?: unknown;
  /** 本地记录的服务端会话身份；必须与当前会话一致，否则拒绝（B 不能接管 A 的原请求）。 */
  originActorId?: unknown;
}): Promise<InventoryReconcileOutcome> {
  const requestId = readString(input.requestId, 64);
  if (!isUuid(requestId)) {
    return { ok: false, state: 'failed', errorCode: 'INVALID_INPUT', message: '缺少有效的原请求编号，无法核对；请刷新页面后重试。' };
  }
  try {
    const identity = await requireInventoryAdmin();
    const loaded = await loadOwnPendingAction(identity, requestId);
    const loadError = loaded.ok ? null : loaded;
    let source: { action: string; intent: string; payload: Record<string, unknown> } | null = loaded.ok
      ? { action: loaded.action, intent: loaded.intent, payload: loaded.payload }
      : null;
    let localFallback = false;
    if (!source) {
      localFallback = loadError?.errorCode === 'INVENTORY_PENDING_NOT_FOUND';
      const originError = localFallback
        ? validateLocalOrigin(identity, input.originActorId)
        : null;
      if (originError) {
        return { ok: false, state: 'failed', errorCode: originError, message: localOriginMessage(originError) };
      }
      const action = readString(input.action, 80);
      const intent = readString(input.intent, 128);
      const payload = (input.payload ?? {}) as Record<string, unknown>;
      const expected = localFallback ? intentForActionPayload(action, payload) : null;
      if (!expected || expected !== intent || !INTENT_HASH_PATTERN.test(intent)) {
        return {
          ok: false,
          state: 'failed',
          errorCode: loadError?.errorCode ?? 'INVENTORY_PENDING_NOT_FOUND',
          message: '没有找到本人持久原请求，且本地保留的 action/intent/payload 不完整或不一致：不能判定未找到。请保留现场并刷新页面。',
        };
      }
      source = { action, intent, payload };
    }
    const response = await callAppRpc<unknown>(identity, 'catalog.reconcile_inventory_request', [requestId, source.intent]);
    if (!response || typeof response !== 'object' || Array.isArray(response)) {
      return {
        ok: false,
        state: 'failed',
        errorCode: 'INVENTORY_RECONCILE_INVALID',
        message: '核对响应为空或格式异常：这不代表原请求未生效。原请求仍保留，请稍后继续核对，不要重试或发起新写操作。',
      };
    }
    const record = response as Record<string, unknown>;
    if (typeof record.found !== 'boolean') {
      return {
        ok: false,
        state: 'failed',
        errorCode: 'INVENTORY_RECONCILE_INVALID',
        message: '核对响应缺少明确 found 结果：不能判定未找到。原请求仍保留，请稍后继续核对。',
      };
    }
    if (record.terminal === 'failed') {
      return {
        ok: true,
        state: 'failed_terminal',
        errorCode: typeof record.terminalErrorCode === 'string' ? record.terminalErrorCode : null,
        message: '原操作失败，已处理完，可以修正后重新操作。旧请求不会再次执行；新操作会使用新的请求编号。',
      };
    }
    if (record.found === false) {
      return {
        ok: true,
        state: 'not_found',
        errorCode: null,
        message: '服务端明确返回未找到回执：原请求没有落库/未生效。可以重试原操作（同 requestId + 同 intent），只会产生一份结果。',
      };
    }
    const receipt = record.response;
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
      return {
        ok: false,
        state: 'failed',
        errorCode: 'INVENTORY_RECEIPT_MISSING',
        message: '服务端称已找到但未返回真实业务回执：不能解锁，也不能当未找到。原请求仍保留，请继续核对。',
      };
    }
    if (localFallback) {
      // 服务端没有持久 pending 行（已完成/从未登记）：没有锁可解，不再调用 completePending；
      // 只读回执已确认原请求生效，直接报“已找到、未重复写入”。（不能再对 completed 行 complete，否则会抛 ALREADY_RESOLVED）
      return {
        ok: true,
        state: 'found',
        errorCode: null,
        message: '已核对到原请求回执：原请求已生效，没有重复写入；服务端无待解除的恢复锁。',
        receiptSummary: receiptSummary(source.action, receipt),
      };
    }
    const unlocked = await completePending(identity, requestId, 'completed', receipt, null);
    revalidateInventoryPaths();
    if (!unlocked.ok) {
      return {
        ok: false,
        state: 'found_unlock_failed',
        errorCode: unlocked.code,
        message: `已找到业务回执（原请求已生效，不会重放），但解除恢复锁失败：${unlocked.message}。原请求仍保留，请继续核对，不要发起新的写操作。`,
        receiptSummary: receiptSummary(source.action, receipt),
      };
    }
    return {
      ok: true,
      state: 'found',
      errorCode: null,
      message: '已核对到原请求回执：原请求已生效，没有重复写入；锁已确认解除。',
      receiptSummary: receiptSummary(source.action, receipt),
    };
  } catch (error) {
    const info = classifyActionError(error);
    return {
      ok: false,
      state: 'failed',
      errorCode: info.code,
      message: `核对失败（${info.code}）：这不代表原请求未生效。请保留原请求稍后继续核对；不要发起新的写操作、也不要用客户端参数判成未找到。`,
    };
  }
}

/**
 * 重试原操作（仅从 pending 恢复入口调用）：不 begin，直接复用同一 requestId + intent 执行原动作，
 * 成功后 complete(completed)，确定失败 complete(failed)，未知则保持 pending。
 */
export async function retryInventoryPendingAction(input: {
  requestId?: unknown;
  /** 仅当服务端没有持久 pending 行（请求未达服务端）时使用；服务端按完整 intent 校验后重新 begin。 */
  action?: unknown;
  intent?: unknown;
  payload?: unknown;
  /** 本地记录的服务端会话身份；必须与当前会话一致。 */
  originActorId?: unknown;
}): Promise<InventoryActionOutcome> {
  try {
    const identity = await requireInventoryAdmin();
    const requestId = readString(input.requestId, 64);
    if (!isUuid(requestId)) return invalidInput('缺少有效的原请求编号，无法重试；请刷新页面后重试。');
    const loaded = await loadOwnPendingAction(identity, requestId);
    let action: string;
    let intent: string;
    let payload: Record<string, unknown>;
    let localFallback = false;
    if (loaded.ok) {
      // 已失败结案：核对入口负责确认终态；重试入口绝不能再次执行原业务。
      if (loaded.status === 'failed') return failedTerminalOutcome(requestId, null);
      action = loaded.action;
      intent = loaded.intent;
      payload = loaded.payload;
    } else {
      localFallback = loaded.errorCode === 'INVENTORY_PENDING_NOT_FOUND';
      if (localFallback) {
        const originError = validateLocalOrigin(identity, input.originActorId);
        if (originError) {
          return failureOutcome({ code: originError, message: localOriginMessage(originError), requestId });
        }
      }
      action = readString(input.action, 80);
      intent = readString(input.intent, 128);
      payload = (input.payload ?? {}) as Record<string, unknown>;
      const expected = localFallback ? intentForActionPayload(action, payload) : null;
      if (!expected || expected !== intent || !INTENT_HASH_PATTERN.test(intent)) {
        return failureOutcome({ code: loaded.errorCode, message: loaded.message, requestId });
      }
      // 请求未达服务端：用同一 requestId + 同 intent + 原 payload 重新 begin；业务 RPC 的 request_prior 保证一次效果。
      const begun = await beginPending(identity, { requestId, action, intent, payload });
      if (!begun.ok) return begun.outcome;
    }
    void localFallback;

    if (action === ACTION.settings) {
      const enabled = payload.enabled === true;
      const intervalMinutes = Number(payload.intervalMinutes);
      const scopeProvided = payload.scopeProvided === true;
      const warehouseIds = Array.isArray(payload.warehouseIds)
        ? payload.warehouseIds.map((entry) => (typeof entry === 'string' ? entry : '')).filter(Boolean)
        : [];
      return executeRetry<SettingsResponse>({
        identity,
        requestId,
        action,
        intent,
        payload,
        execute: () => callAppRpc<SettingsResponse>(identity, 'catalog.update_inventory_sync_settings', [
          requestId,
          intent,
          enabled,
          intervalMinutes,
          scopeProvided,
          warehouseIds,
        ]),
        onBusinessFailure: (response) => (response && response.ok === false
          ? failureOutcome({
            code: response.code ?? 'SETTINGS_REJECTED',
            message: response.message ?? '服务端拒绝了本次设置；请刷新核对后重试。',
            requestId,
          })
          : null),
        onSuccess: (response) => {
          const savedInterval = typeof response?.settings?.intervalMinutes === 'number' ? response.settings.intervalMinutes : intervalMinutes;
          const scopeEmpty = response?.settings?.scopeEmpty === true || (scopeProvided && warehouseIds.length === 0);
          return actionSuccess({
            message: settingsOutcomeMessage({
              enabled,
              intervalMinutes: savedInterval,
              warehouseCount: typeof response?.settings?.warehouseCount === 'number' ? response.settings.warehouseCount : warehouseIds.length,
              scopeProvided,
              scopeEmpty,
              nextRunAt: response?.settings?.nextRunAt ?? null,
            }),
            scopeEmpty,
          });
        },
      });
    }

    if (action === ACTION.manual) {
      return executeRetry<ManualResponse>({
        identity,
        requestId,
        action,
        intent,
        payload,
        execute: () => callAppRpc<ManualResponse>(identity, 'catalog.request_inventory_manual_sync', [requestId, intent]),
        onBusinessFailure: (response) => (response && response.ok === false
          ? failureOutcome({
            code: response.code ?? 'MANUAL_SYNC_REJECTED',
            message: response.message ?? '服务端拒绝了本次立即同步；请刷新核对当前任务状态后重试。',
            requestId,
            scopeEmpty: response.code === 'INVENTORY_SCOPE_EMPTY',
          })
          : null),
        onSuccess: (response) => {
          const deduped = response?.deduped === true;
          const runId = typeof response?.runId === 'string' ? response.runId : null;
          return actionSuccess({ deduped, runId, message: manualSyncOutcomeMessage({ deduped, runId }) });
        },
      });
    }

    if (action === ACTION.confirm) {
      const mappings = Array.isArray(payload.mappings) ? payload.mappings as ConfirmMappingInput[] : [];
      return executeRetry<ConfirmResponse>({
        identity,
        requestId,
        action,
        intent,
        payload,
        execute: () => callAppRpc<ConfirmResponse>(identity, 'catalog.confirm_inventory_mapping', [
          requestId,
          intent,
          JSON.stringify(mappings),
        ]),
        onBusinessFailure: (response) => (response && response.ok === false
          ? failureOutcome({
            code: response.code ?? 'MAPPING_REJECTED',
            message: response.message ?? '服务端拒绝了本次对应确认；请核对后重试。',
            requestId,
          })
          : null),
        onSuccess: (response) => actionSuccess({
          message: confirmOutcomeMessage(Number(response?.applied ?? 0) || 0, Array.isArray(response?.skipped) ? response.skipped : []),
        }),
      });
    }

    if (action === ACTION.recheck) {
      const mappingId = readString(payload.mappingId, 64);
      const expectedVersion = Number(payload.expectedVersion);
      const reason = readString(payload.reason, 500) || readString(payload.note, 500);
      return executeRetry<MappingMutationResponse>({
        identity,
        requestId,
        action,
        intent,
        payload,
        execute: () => callAppRpc<MappingMutationResponse>(identity, 'catalog.recheck_inventory_mapping', [
          requestId,
          intent,
          mappingId,
          reason,
          expectedVersion,
        ]),
        onSuccess: (response) => mappingActionResult(response, 'recheck'),
      });
    }

    if (action === ACTION.disable) {
      const mappingId = readString(payload.mappingId, 64);
      const expectedVersion = Number(payload.expectedVersion);
      const reason = readString(payload.reason, 500) || readString(payload.note, 500);
      return executeRetry<MappingMutationResponse>({
        identity,
        requestId,
        action,
        intent,
        payload,
        execute: () => callAppRpc<MappingMutationResponse>(identity, 'catalog.disable_inventory_mapping', [
          requestId,
          intent,
          mappingId,
          reason,
          expectedVersion,
        ]),
        onSuccess: (response) => mappingActionResult(response, 'disable'),
      });
    }

    return invalidInput('不支持的待恢复操作类型；请刷新页面后重试。');
  } catch (error) {
    return actionFailure(error);
  }
}

/* ------------------------------------------------------------------ *
 * R2 目标商品搜索（管理员按货号/名称；不要求有当前库存）
 * ------------------------------------------------------------------ */

export async function searchMappingTargetItemsAction(input: { search?: unknown }): Promise<{
  ok: boolean;
  items: InventoryTargetItemDto[];
  message: string;
}> {
  try {
    const identity = await requireInventoryAdmin();
    const search = readString(input?.search, MAX_SEARCH_INPUT);
    if (!search) return { ok: false, items: [], message: '请输入货号、名称或 69 编码后再搜索。' };
    const items = await searchInventoryTargetItems(identity, search, 10);
    return {
      ok: true,
      items,
      message: items.length > 0 ? `找到 ${items.length} 个商品，请选择目标商品。` : '没有找到匹配的商品；可换货号/名称再试，不要凭猜测提交。',
    };
  } catch (error) {
    const info = classifyActionError(error);
    return { ok: false, items: [], message: info.message };
  }
}

const MAX_SEARCH_INPUT = 120;

/* ------------------------------------------------------------------ *
 * 读取辅助：概览（供页面在动作后刷新；也导出给服务端页面复用）
 * ------------------------------------------------------------------ */

