// 喜运达(golucky)物流轨迹 API Client（Provider 私有模块）
//
// 本模块禁止向业务模块暴露喜运达专有字段。
// 业务模块通过 Record<string, unknown> 接收原始响应。
//
// API 事实经正式环境实测确认。

export { GoluckyClient, createGoluckyClient, InMemoryTokenCache } from './client';
export type { TokenCache, TokenLease, GoluckyClientConfig, FetchFn } from './client';
export { SupabaseTokenCache } from './token-cache';
export { PostgresTokenCache } from './postgres-token-cache';
export { dryRunWaybill, createDryRunClient } from './dry-run';
export { parseTrackingResponse } from './parse-response';
export {
  GoluckyApiError,
  GoluckyNetworkError,
  GoluckyValidationError,
  type NetworkDiagnostics,
  type GoluckyTokenResponse,
  type GoluckyTrackingResponse,
  type GoluckyTrackingNode,
  type ParsedGoluckyEvent,
  type GoluckyDryRunResult,
  type GoluckySyncResult,
  type GoluckyBatchSyncResult,
} from './types';
export {
  goluckyTrackingResponseSchema,
  goluckyTokenResponseSchema,
  goluckyTrackingNodeSchema,
} from './schema';
