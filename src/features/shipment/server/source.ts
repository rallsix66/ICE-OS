import 'server-only';

/**
 * 页面/服务端动作的来源读取入口。
 *
 * 真实读取逻辑在 `source-core.ts`（不引 server-only），由这里和本机后台定时任务
 * （scripts/shipment/worker.mjs）共用，保证手动刷新和定时读取走同一套读取/校验代码。
 */
export * from './source-core';
