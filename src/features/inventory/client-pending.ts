/**
 * 浏览器本地保留的“结果未知”原请求（仅用于“请求未达/未确认到达服务端”分支）：
 * 服务端已有持久 pending 时永远以服务端为准；本文件只在没有 pending 时保留同一
 * requestId + intent + payload，供核对/重试使用（服务器会重算 intent 并核完整参数）。
 *
 * v2 起记录原身份：actorId/accountId 来自服务端渲染或服务端登记回执，客户端不自行生成；
 * 同一浏览器换管理员后，B 不能把 A 的原请求当成自己的恢复任务执行。
 * 旧 v1 记录（无身份）保留并标记为“待核实”，不自动归给当前管理员。
 * 不保存任何凭据、金额或数据库连接信息。
 */
export interface LocalUnknownRequest {
  schemaVersion: 2;
  requestId: string;
  action: string;
  intent: string;
  intentVersion: 'v4' | 'v3';
  payload: Record<string, unknown>;
  createdAt: string;
  /** 服务端会话身份（接收入口由服务端页面/登记回执提供）。 */
  actorId: string;
  /** 服务端绑定的来源账号 id；未知时为空字符串。 */
  accountId: string;
  /** registered = 服务端登记回执已确认；unknown = 仅本地保留，未确认是否到达服务端。 */
  registration: 'registered' | 'unknown';
  trusted: boolean;
}

export interface LocalUnknownDraft {
  requestId: string;
  action: string;
  intent: string;
  payload: Record<string, unknown>;
  createdAt?: string;
  actorId: string;
  accountId: string;
  registration: 'registered' | 'unknown';
}

export interface LocalViewerIdentity {
  actorId: string;
  accountId: string;
}

const STORAGE_KEY = 'inventory.localUnknownRequest.v1';
const listeners = new Set<() => void>();
/**
 * useSyncExternalStore 要求 getSnapshot 返回稳定引用（不能每次 parse 新对象），
 * 否则会出现 “getSnapshot should be cached” 无限渲染并落到 Next 错误页。
 */
let cachedSnapshot: LocalUnknownRequest | null | undefined;

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeLocalUnknown(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function storage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function saveLocalUnknownRequest(draft: LocalUnknownDraft): void {
  const request: LocalUnknownRequest = {
    schemaVersion: 2,
    requestId: draft.requestId,
    action: draft.action,
    intent: draft.intent,
    intentVersion: 'v4',
    payload: draft.payload,
    createdAt: typeof draft.createdAt === 'string' ? draft.createdAt : new Date().toISOString(),
    actorId: draft.actorId,
    accountId: draft.accountId,
    registration: draft.registration,
    trusted: true,
  };
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(request));
    cachedSnapshot = request;
    emit();
  } catch {
    /* 隐私模式/禁用存储：页面仍显示结果未知，但刷新后只能依赖服务端 pending。 */
  }
}

export function getLocalUnknownSnapshot(): LocalUnknownRequest | null {
  if (cachedSnapshot === undefined) cachedSnapshot = readLocalUnknownRequest();
  return cachedSnapshot;
}

export function getLocalUnknownServerSnapshot(): LocalUnknownRequest | null {
  return null;
}

/** 读取本地记录；兼容旧 v1 格式（保留、trusted=false，不自动执行）。 */
export function readLocalUnknownRequest(): LocalUnknownRequest | null {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LocalUnknownRequest> & Record<string, unknown>;
    if (!parsed || typeof parsed.requestId !== 'string' || typeof parsed.action !== 'string'
      || typeof parsed.intent !== 'string' || typeof parsed.payload !== 'object' || parsed.payload === null) {
      return null;
    }
    const createdAt = typeof parsed.createdAt === 'string' ? parsed.createdAt : new Date().toISOString();
    const isV2 = parsed.schemaVersion === 2;
    return {
      schemaVersion: 2,
      requestId: parsed.requestId,
      action: parsed.action,
      intent: parsed.intent,
      // v1 记录不可能是新编码；标记为 v3，恢复时按“不可信旧记录”保留待核实。
      intentVersion: isV2 && parsed.intentVersion === 'v4' ? 'v4' : 'v3',
      payload: parsed.payload as Record<string, unknown>,
      createdAt,
      actorId: typeof parsed.actorId === 'string' ? parsed.actorId : '',
      accountId: typeof parsed.accountId === 'string' ? parsed.accountId : '',
      registration: parsed.registration === 'registered' ? 'registered' : 'unknown',
      // 只有 v2 且带服务端身份、且为新编码才算可信；旧 v1 记录留待人工核实。
      trusted: isV2 === true && typeof parsed.actorId === 'string' && parsed.actorId.length > 0
        && parsed.intentVersion === 'v4',
    };
  } catch {
    return null;
  }
}

/** 本地记录是否可由当前会话恢复；返回明确原因，供页面展示“保留待核实”。 */
export function localUnknownOwnerCheck(
  local: LocalUnknownRequest | null,
  viewer: LocalViewerIdentity | null | undefined,
): { trusted: boolean; reason: string | null } {
  if (!local) return { trusted: true, reason: null };
  if (!viewer || !viewer.actorId) {
    return { trusted: false, reason: '当前会话身份未确认：不能执行或核对本地保留的原请求。' };
  }
  if (!local.trusted || !local.actorId) {
    return {
      trusted: false,
      reason: '这是旧格式本地记录，缺少可信的原操作者：保留现场、锁定新写，等待原管理员登录后人工核实，不会自动归给当前管理员。',
    };
  }
  if (local.actorId !== viewer.actorId) {
    return {
      trusted: false,
      reason: '本地保留的原请求属于另一位管理员：本页只显示待核实，不提供核对/重试；请原管理员登录处理，不能由当前管理员接手执行。',
    };
  }
  if (local.accountId && viewer.accountId && local.accountId !== viewer.accountId) {
    return {
      trusted: false,
      reason: '本地保留的原请求属于另一个来源账号：本页只显示待核实，不提供执行。',
    };
  }
  return { trusted: true, reason: null };
}

export function localRecoveryKey(local: LocalUnknownRequest | null): string {
  if (!local) return 'none';
  return `local:${local.requestId}:${local.intent}:${local.actorId}:${local.accountId}`;
}

export function clearLocalUnknownRequest(requestId?: string): void {
  try {
    if (!requestId) {
      storage()?.removeItem(STORAGE_KEY);
      cachedSnapshot = null;
      emit();
      return;
    }
    const current = readLocalUnknownRequest();
    if (current?.requestId === requestId) {
      storage()?.removeItem(STORAGE_KEY);
      cachedSnapshot = null;
      emit();
    }
  } catch {
    /* 忽略存储异常。 */
  }
}
