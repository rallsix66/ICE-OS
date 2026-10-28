/**
 * Future Feishu API reader placeholder.
 *
 * Same `ProductSourceReader` interface as the local reader so the pipeline does
 * not change when the API is enabled. v1 never calls the network and never
 * silently falls back to stale data: every read throws
 * `FEISHU_API_NOT_CONFIGURED`.
 */
import 'server-only';
import { SOURCE_PROFILE_KEY } from './contract';
import { ProductSourceReaderError, type ProductSourceReader, type SourceSnapshotSummary } from './reader';

export const FEISHU_API_NOT_CONFIGURED = 'FEISHU_API_NOT_CONFIGURED';

function notConfigured(): never {
  throw new ProductSourceReaderError(
    FEISHU_API_NOT_CONFIGURED,
    '飞书 API 未配置；当前仅支持本地快照模拟读取',
  );
}

export function createFeishuApiReader(): ProductSourceReader {
  return {
    profileKey: SOURCE_PROFILE_KEY,
    describe: () => ({
      mode: 'feishu_api',
      label: '飞书 API（未开通）',
      detail: '未开通飞书 API；配置后只需替换读取层，不改变差异计划与页面。',
    }),
    async listSnapshots(): Promise<SourceSnapshotSummary[]> {
      return notConfigured();
    },
    async readSnapshot(): Promise<never> {
      return notConfigured();
    },
  };
}

/** Back-compat alias for the name used in the implementation specification §3. */
export const createFutureFeishuApiReader = createFeishuApiReader;
