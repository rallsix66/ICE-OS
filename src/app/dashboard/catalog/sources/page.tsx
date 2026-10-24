import Link from 'next/link';
import { getSourceIdentityWorkspace } from '@/features/catalog/source-identity/service';
import { SourceIdentityWorkspace } from '@/features/catalog/components/source-identity-panel';
import { LegacyEntryGuidance, type LegacyEntryState } from '@/features/catalog/issues/legacy-entry-guidance';
import { getCatalogItemLabel, getLegacyEntryItemContext } from '@/features/catalog/issues/service';
import { classifyCatalogReadFailure } from '@/features/catalog/issues/entry-state';
import { isIssuesReturnHref, safeInternalReturnHref } from '@/features/catalog/issues/context';

// 旧入口保留：来源核实模块启用且已授权时仍是原处理页（消费 scope/item/record/from），
// 未启用 / 无权限 / 读取失败时给中文安全引导，不 404、不删能力、不把未启用写成“0 项”。
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const UUID = /^[a-f\d-]{36}$/i;

/** 业务状态用语（不把内部状态码展示给用户）。 */
const RECORD_STATE_LABELS: Record<string, string> = {
  active: '有效',
  review_required: '待复核',
  suspended: '已暂停',
  revoked: '已撤销',
};

const LINK_STATUS_LABELS: Record<string, string> = {
  linked: '已关联',
  revoked: '已撤销',
};

function uuidOf(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' && UUID.test(raw) ? raw : undefined;
}

export default async function SourceIdentityPage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string; item?: string; from?: string; record?: string }>;
}) {
  const { scope, item, from, record } = await searchParams;
  const rawScope = typeof scope === 'string' ? scope : undefined;
  const scopeId = uuidOf(scope);
  const itemId = uuidOf(item);
  const recordId = uuidOf(record);
  // 安全返回点：只接受站内 /dashboard/ 相对路径，拒绝协议相对地址、反斜杠与外部 URL。
  const returnHref = safeInternalReturnHref(from);
  const backHref = returnHref ?? '/dashboard/catalog';
  const backLabel = isIssuesReturnHref(returnHref) ? '返回待处理' : returnHref ? '返回原处' : '返回商品库';

  let view: Awaited<ReturnType<typeof getSourceIdentityWorkspace>> | null = null;
  let state: LegacyEntryState = 'disabled';
  if (rawScope && !scopeId) {
    // 请求的范围标识不是有效身份：按“无权或不存在”安全表达，不落到默认范围。
    state = 'forbidden';
  } else {
    try {
      view = await getSourceIdentityWorkspace(scopeId);
    } catch (error) {
      state = classifyCatalogReadFailure(error) === 'forbidden' ? 'forbidden' : 'read_failed';
    }
  }
  if (view && view.enabled) {
    const itemLabel = itemId ? await getCatalogItemLabel(itemId) : null;
    const locatedRecord = recordId ? view.workspace?.records.find((entry) => entry.recordId === recordId) : undefined;
    const locatedLink = recordId ? view.workspace?.links.find((entry) => entry.recordId === recordId) : undefined;
    const scopeName = view.workspace?.scope.displayName ?? '未选择来源范围';
    return (
      <main className="p-6 space-y-5" data-testid="source-identity-page">
        <Link className="underline text-sm" href={backHref}>{backLabel}</Link>
        <h1 className="text-2xl font-semibold">来源身份与观测</h1>
        <p className="text-sm" data-testid="identity-context">
          当前范围：{scopeName}
          {itemId ? ` · 关联商品：${itemLabel ?? '未读取到摘要'}` : ''}
        </p>
        {recordId && (
          <p className="text-sm" data-testid="identity-record-locate">
            {!view.workspace
              ? '当前没有可查看的授权来源范围，因此未定位原记录。'
              : locatedRecord
                ? `已定位原记录：${RECORD_STATE_LABELS[locatedRecord.state] ?? '状态未标注'} · 第 ${locatedRecord.revision} 版`
                : locatedLink
                  ? `原记录已建立关联（${LINK_STATUS_LABELS[locatedLink.status] ?? '状态未标注'}，第 ${locatedLink.linkRevision} 版）`
                  : '原记录不在当前授权范围内：请切换来源范围后重试，未替你切换到别的范围。'}
          </p>
        )}
        <SourceIdentityWorkspace
          key={view.scopeId ?? 'disabled'}
          view={view}
          fromHref={returnHref}
          itemId={itemId}
          focusRecordId={recordId && (locatedRecord || locatedLink) ? recordId : undefined}
        />
      </main>
    );
  }
  const itemContext = state === 'disabled' && itemId ? await getLegacyEntryItemContext(itemId) : null;
  return (
    <LegacyEntryGuidance
      moduleKey="source_identity"
      title="来源核实"
      lede="来源身份与观测核实的旧链接仍然可用：模块启用且已授权时这里是原处理页，否则本页给出安全引导并保留原有处理能力；相关事项集中到商品库「待处理」索引。"
      state={state}
      itemId={itemId}
      itemContext={itemContext}
      returnHref={returnHref}
    />
  );
}
