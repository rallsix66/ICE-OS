// 喜运达(golucky)物流轨迹 API Client（只读）
//
// 仅查询运单物流轨迹（GET /tmsapi/tracking/list）。
// Token 管理采用租约模型：抢租约短事务 → 事务外调外部 API → 写回校验所有权。
//
// 并发安全：TokenLease 为操作级句柄，每个 acquireLease 返回独立的 lease 对象，
// storeToken / releaseLease 必须使用同一次 acquireLease 返回的 lease。
// 不存在共享可变 _leaseId，多线程/并发安全。
//
// 安全约束：本模块不记录 token / appSecret 到日志或错误。

import {
  GoluckyApiError,
  GoluckyNetworkError,
  type NetworkDiagnostics,
  type ParsedGoluckyEvent,
} from './types';
import {
  goluckyTrackingResponseSchema,
  goluckyTokenResponseSchema,
} from './schema';
import { parseTrackingResponse } from './parse-response';

export type FetchFn = typeof fetch;

// ─── Token 租约句柄（操作级，非实例级） ──────────────────

/** 每次 acquireLease 返回的独立租约句柄。storeToken / releaseLease 必须使用同一次 acquire 返回的 lease。 */
export interface TokenLease {
  action: 'reuse' | 'refresh' | 'first_time' | 'lease_held_by_other';
  accessToken: string | null;
  expiresAt: string | null;
  /** 不透明租约 ID — storeToken / releaseLease 需要此值校验所有权 */
  readonly leaseId: string;
}

// ─── Token 缓存接口（由调用方注入，隔离数据库访问） ──────

export interface TokenCache {
  /** 阶段一：抢租约（短事务无网络）→ 返回 TokenLease 句柄 */
  acquireLease(provider: string): Promise<TokenLease>;
  /** 阶段二：写回 token（校验 lease_owner 所有权）。lease 必须是同一次 acquireLease 的返回值 */
  storeToken(provider: string, accessToken: string, expiresAt: string, lease: TokenLease): Promise<void>;
  /** 释放租约（刷新失败时调用）。lease 必须是同一次 acquireLease 的返回值 */
  releaseLease(provider: string, lease: TokenLease): Promise<void>;
}

/** 默认 TokenCache（供测试/无 DB 场景使用）。并发安全：无共享可变状态 */
export class InMemoryTokenCache implements TokenCache {
  private cache = new Map<string, { token: string; expiresAt: string }>();

  async acquireLease(_provider: string): Promise<TokenLease> {
    const entry = this.cache.get(_provider);
    const leaseId = globalThis.crypto.randomUUID();
    if (entry && new Date(entry.expiresAt).getTime() - 5 * 60 * 1000 > Date.now()) {
      return { action: 'reuse' as const, accessToken: entry.token, expiresAt: entry.expiresAt, leaseId };
    }
    if (entry) {
      return { action: 'refresh' as const, accessToken: entry.token, expiresAt: entry.expiresAt, leaseId };
    }
    return { action: 'first_time' as const, accessToken: null, expiresAt: null, leaseId };
  }

  async storeToken(provider: string, accessToken: string, expiresAt: string, _lease: TokenLease) {
    void _lease;
    this.cache.set(provider, { token: accessToken, expiresAt });
  }

  async releaseLease(_provider: string, _lease: TokenLease) {
    void _provider;
    void _lease;
    // no-op — in-memory 无并发锁需求
  }
}

// ─── Client Config ──────────────────────────────────────

export interface GoluckyClientConfig {
  baseUrl: string;
  appKey: string;
  appSecret: string;
  timeoutMs?: number;
  /** Token 缓存实现。既有实现为 PostgresTokenCache；喜运达业务尚未启用，现役无实例化消费者 */
  tokenCache: TokenCache;
}

// ─── Client ─────────────────────────────────────────────

export class GoluckyClient {
  private readonly config: Required<Omit<GoluckyClientConfig, 'tokenCache'>>;
  private readonly fetchFn: FetchFn;
  private readonly tokenCache: TokenCache;
  private static readonly PROVIDER = 'golucky';

  constructor(config: GoluckyClientConfig, fetchImpl?: FetchFn) {
    this.config = {
      baseUrl: config.baseUrl,
      appKey: config.appKey,
      appSecret: config.appSecret,
      timeoutMs: config.timeoutMs ?? 30_000,
    };
    this.fetchFn = fetchImpl ?? globalThis.fetch;
    this.tokenCache = config.tokenCache;
  }

  get baseUrl(): string {
    return this.config.baseUrl;
  }

  // ─── 公共接口：查询单运单轨迹 ───────────────────────────

  /**
   * 查询单运单全量物流轨迹（只读）。
   *
   * 并发安全：每次调用 obtainToken 获取独立的 TokenLease 句柄，
   * 不存在跨并发请求的共享可变状态。
   *
   * @param transportNumber — 运单号
   * @returns 解析后的轨迹事件列表
   */
  async getTracking(transportNumber: string): Promise<{
    events: ParsedGoluckyEvent[];
    rawResponse: unknown;
  }> {
    const accessToken = await this.obtainToken();

    const url = `${this.config.baseUrl}/tmsapi/tracking/list?transportNumber=${encodeURIComponent(transportNumber)}`;

    const raw = await this.get(url, accessToken);

    const parsed = goluckyTrackingResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new GoluckyApiError('轨迹响应结构校验失败', 'INVALID_RESPONSE');
    }

    const events = parseTrackingResponse(parsed.data.data ?? [], transportNumber);

    return { events, rawResponse: raw };
  }

  // ─── Token 管理（租约模型，并发安全） ─────────────────────

  /**
   * 获取有效 access token。
   *
   * 每个并发调用独立获取 TokenLease，lease 句柄随调用链路传递，
   * 不存储在任何共享可变字段中。
   */
  private async obtainToken(): Promise<string> {
    const lease = await this.tokenCache.acquireLease(GoluckyClient.PROVIDER);

    if (lease.action === 'reuse' && lease.accessToken) {
      return lease.accessToken;
    }

    // 租约被他人持有 → 使用旧 token 降级，或抛出可重试错误
    if (lease.action === 'lease_held_by_other') {
      if (lease.accessToken && lease.expiresAt && new Date(lease.expiresAt).getTime() > Date.now()) {
        return lease.accessToken;
      }
      throw new GoluckyApiError(
        'Token 租约被其他进程持有且旧 token 已过期，请稍后重试',
        'LEASE_HELD_BY_OTHER',
      );
    }

    // 需要刷新或首次获取
    let newToken: string | null = null;
    let newExpiresAt: string | null = null;

    try {
      const result = await this.fetchToken();
      newToken = result.token;
      newExpiresAt = result.expiresAt;
    } catch (err) {
      // 刷新失败但旧 token 仍有效 → 继续用旧 token，释放租约
      if (lease.accessToken && lease.expiresAt && new Date(lease.expiresAt).getTime() > Date.now()) {
        await this.tokenCache.releaseLease(GoluckyClient.PROVIDER, lease);
        return lease.accessToken;
      }
      // 旧 token 也已过期 → 释放租约并抛出（保留原始诊断信息）
      await this.tokenCache.releaseLease(GoluckyClient.PROVIDER, lease);

      if (err instanceof GoluckyNetworkError) {
        // 重抛并标注 token 上下文（保留底层诊断）
        throw new GoluckyNetworkError(
          `Token 获取失败 (${err.diagnostics.phase}): ${err.message}`,
          err.diagnostics,
        );
      }
      if (err instanceof GoluckyApiError) {
        throw err; // API 错误直接透传（含 code）
      }
      throw new GoluckyApiError(
        `Token 获取失败且旧 Token 已过期: ${(err as Error)?.message ?? '未知错误'}`,
        'TOKEN_FAILED',
      );
    }

    // 写回 token（使用本次 acquireLease 返回的 lease，校验所有权）
    await this.tokenCache.storeToken(GoluckyClient.PROVIDER, newToken, newExpiresAt, lease);
    return newToken;
  }

  private async fetchToken(): Promise<{ token: string; expiresAt: string }> {
    const url = `${this.config.baseUrl}/api/account/gettoken?appKey=${encodeURIComponent(this.config.appKey)}&appSecret=${encodeURIComponent(this.config.appSecret)}`;

    const raw = await this.get(url);

    const parsed = goluckyTokenResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new GoluckyApiError('Token 响应结构校验失败', 'INVALID_TOKEN_RESPONSE');
    }

    const tokenData = parsed.data;
    if (!tokenData.data?.accessToken) {
      throw new GoluckyApiError(
        `Token 获取失败: ${tokenData.message ?? tokenData.code ?? 'accessToken 为空'}`,
        tokenData.code ?? 'TOKEN_EMPTY',
      );
    }

    const expiresIn = tokenData.data.expiresIn ?? 7200;
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

    return { token: tokenData.data.accessToken, expiresAt };
  }

  // ─── 内部 HTTP 方法 ────────────────────────────────────

  private async get(url: string, accessToken?: string): Promise<unknown> {
    const safeUrl = sanitizeUrl(url);
    const headers: Record<string, string> = {
      'Accept': 'application/json',
    };

    if (accessToken) {
      headers['Access-Token'] = accessToken;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);

      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new GoluckyNetworkError(
          `请求超时 (${this.config.timeoutMs}ms) → ${safeUrl}`,
          {
            phase: 'timeout',
            safeUrl,
            timeoutMs: this.config.timeoutMs,
          },
        );
      }

      const phase = classifyNetworkError(err);
      const underlyingError = (err as Error)?.message ?? String(err);
      throw new GoluckyNetworkError(
        `网络请求失败 (${phase}) → ${safeUrl}: ${underlyingError}`,
        {
          phase,
          safeUrl,
          underlyingError,
        },
      );
    }

    clearTimeout(timer);

    if (!response.ok) {
      throw new GoluckyNetworkError(
        `HTTP ${response.status}: ${response.statusText || '无状态描述'} → ${safeUrl}`,
        {
          phase: 'http',
          safeUrl,
          httpStatus: response.status,
          httpStatusText: response.statusText || undefined,
        },
      );
    }

    try {
      return await response.json();
    } catch {
      throw new GoluckyNetworkError(
        `响应不是合法 JSON → ${safeUrl}`,
        {
          phase: 'parse',
          safeUrl,
        },
      );
    }
  }
}

// ─── 工具函数（模块级私有） ──────────────────────────────

/** 脱敏 URL：将 appKey、appSecret、accessToken 等凭证参数替换为 *** */
function sanitizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const redacted = new URL(u.origin + u.pathname);
    // 保留非敏感参数
    for (const [key, value] of u.searchParams) {
      const lower = key.toLowerCase();
      if (lower === 'appkey' || lower === 'appsecret' || lower === 'accesstoken' || lower === 'access_token' || lower === 'transportnumber') {
        redacted.searchParams.set(key, '***');
      } else {
        redacted.searchParams.set(key, value);
      }
    }
    return redacted.toString();
  } catch {
    // URL 解析失败 → 移除整个 query string
    return raw.split('?')[0] ?? raw;
  }
}

/** 根据 fetch 抛出的错误推断故障阶段 */
function classifyNetworkError(err: unknown): NetworkDiagnostics['phase'] {
  const msg = (err as Error)?.message ?? String(err);
  const lower = msg.toLowerCase();

  // AbortError（非 DOMException 或非标准实现）
  if (lower.includes('abort') || lower.includes('timeout') || lower.includes('cancel')) {
    return 'timeout';
  }

  // Node.js fetch 错误分类
  if (lower.includes('enotfound') || lower.includes('eai_again') || lower.includes('dns') || lower.includes('getaddrinfo')) {
    return 'dns';
  }
  if (lower.includes('cert') || lower.includes('ssl') || lower.includes('tls') || lower.includes('unable to verify') || lower.includes('self signed') || lower.includes('eproto')) {
    return 'tls';
  }
  if (lower.includes('econnrefused') || lower.includes('econnreset') || lower.includes('enetunreach') || lower.includes('ehostunreach') || lower.includes('etimedout') || lower.includes('socket')) {
    return 'connect';
  }

  return 'unknown';
}

/** 从环境变量创建 GoluckyClient */
export function createGoluckyClient(
  env: typeof process.env,
  tokenCache: TokenCache,
  fetchImpl?: FetchFn,
): GoluckyClient {
  const baseUrl = env.GOLUCKY_BASE_URL;
  const appKey = env.GOLUCKY_APP_KEY;
  const appSecret = env.GOLUCKY_APP_SECRET;

  const missing: string[] = [];
  if (!baseUrl) missing.push('GOLUCKY_BASE_URL');
  if (!appKey) missing.push('GOLUCKY_APP_KEY');
  if (!appSecret) missing.push('GOLUCKY_APP_SECRET');

  if (missing.length > 0) {
    throw new Error(`喜运达 API 凭证缺失: ${missing.join(', ')}`);
  }

  return new GoluckyClient(
    {
      baseUrl: baseUrl!,
      appKey: appKey!,
      appSecret: appSecret!,
      tokenCache,
    },
    fetchImpl,
  );
}
