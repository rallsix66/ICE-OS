import 'server-only';

import { requireActiveAdmin } from '@/lib/auth';
import { withReadOnlyAppDb, type DbIdentity } from '@/lib/database/app-db';
import type { InventoryDomesticSnapshotDto } from '../types';
import {
  buildDomesticSnapshot,
  isDomesticSourceCached,
  loadDomesticSource,
  normalizeDomesticLinks,
  unavailableDomesticSnapshot,
} from '../domestic/snapshot';

/**
 * 国内聚水潭冻结表格快照的服务端只读读取入口（任务包 UI-04）。
 *
 * 调用链（与 `server/reads.ts` 一致）：
 * 1. 入口先做服务端鉴权：页面调用 `requireInventoryAdmin()` 取得 `DbIdentity`；本函数另外再校验一次
 *    当前会话仍是启用管理员且与传入 identity 一致（React `cache` 去重，不重复查库），不能只靠浏览器藏列。
 * 2. 数据库关联走普通 app 角色的只读事务（`withReadOnlyAppDb`）+ 023 只读函数
 *    `catalog.read_inventory_domestic_links()`；该函数内部还有 `catalog.require_admin()` 兜底。
 * 3. 数量与文件日期来自冻结文件（SHA 校验），文件失败/DB 失败都返回 `available=false` + 中文原因，
 *    不转 0、不伪造空成功。
 */

async function callReadRpc<T>(identity: DbIdentity, functionSpec: string, params: unknown[]): Promise<T> {
  const placeholders = params.map((_, index) => `$${index + 1}`).join(', ');
  const sql = params.length > 0
    ? `SELECT ${functionSpec}(${placeholders}) AS result`
    : `SELECT ${functionSpec}() AS result`;
  return withReadOnlyAppDb(identity, async (client) => {
    const result = await client.query<{ result: T }>(sql, params);
    const rows = result.rows as Array<{ result: T }>;
    return rows[0]?.result as T;
  });
}

/** 把已知失败类别转成可直接显示的中文原因；不把 SQL/路径带回页面。 */
function domesticFailureReason(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return '国内冻结快照文件缺失，未读取数量';
    if (error.message.startsWith('DOMESTIC_SOURCE_SHA256_MISMATCH')) return '国内冻结快照文件哈希校验失败，未读取数量';
    if (error.message.startsWith('DOMESTIC_SOURCE_PATH_DENIED')) return '国内冻结快照路径不可用，未读取数量';
    if (error.message.startsWith('DOMESTIC_')) {
      return '国内冻结快照文件或关联记录格式与预期不符，未读取数量';
    }
    if (error.message === '未登录或账户已停用') return '未登录或账户已停用，未读取国内表格快照';
    if (error.message.startsWith('无权限')) return '当前账号无权限读取国内表格快照';
  }
  const pgCode = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : null;
  if (pgCode === '42501') return '当前账号无权限读取国内表格快照';
  return '国内表格快照读取失败（文件或数据库关联读取异常）';
}

export async function getInventoryDomesticSnapshot(identity: DbIdentity): Promise<InventoryDomesticSnapshotDto> {
  try {
    const actor = await requireActiveAdmin();
    if (actor.id !== identity.profileUserId) return unavailableDomesticSnapshot('当前登录身份与读取身份不一致，未读取国内表格快照');
    const cached = isDomesticSourceCached();
    const source = await loadDomesticSource();
    const rawLinks = await callReadRpc<unknown>(identity, 'catalog.read_inventory_domestic_links', []);
    return buildDomesticSnapshot({
      records: source.records,
      links: normalizeDomesticLinks(rawLinks),
      sourceRecordsSha256: source.sourceRecordsSha256,
      cached,
    });
  } catch (error) {
    return unavailableDomesticSnapshot(domesticFailureReason(error));
  }
}
