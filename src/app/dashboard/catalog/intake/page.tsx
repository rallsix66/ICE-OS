import Link from 'next/link';
import { getNewItemWorkspace } from '@/features/catalog/new-item/service';
import { NewItemIntake } from '@/features/catalog/components/new-item-intake';
import { LegacyEntryGuidance, type LegacyEntryState } from '@/features/catalog/issues/legacy-entry-guidance';
import { getCatalogItemLabel, getLegacyEntryItemContext } from '@/features/catalog/issues/service';
import { classifyCatalogReadFailure } from '@/features/catalog/issues/entry-state';
import { isIssuesReturnHref, safeInternalReturnHref } from '@/features/catalog/issues/context';

// 旧入口保留：持续新品模块启用且已授权时仍是原处理页（消费 scope/observation/item/from），
// 未启用 / 无权限 / 读取失败时给中文安全引导，不 404、不删能力、不把未启用写成“0 项”。
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const UUID = /^[a-f\d-]{36}$/i;

/** 业务用语映射：内部枚举不直接展示给用户。 */
const CLASSIFICATION_LABELS: Record<string, string> = {
  new_item: '新商品',
  item_update: '资料更新',
  external_sku: '外部 SKU',
  suspected_version: '疑似版本',
};

const REVIEW_STATE_LABELS: Record<string, string> = {
  proposed: '待确认',
  needs_review: '待复核',
};

function uuidOf(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' && UUID.test(raw) ? raw : undefined;
}

function classificationSummary(
  observation: { classification: { classification: string; reviewState: string } | null; origin: { itemId: string } | null },
): string {
  const classification = observation.classification
    ? `分类${CLASSIFICATION_LABELS[observation.classification.classification] ?? '已提出'}（${REVIEW_STATE_LABELS[observation.classification.reviewState] ?? '状态未标注'}）`
    : '尚未分类';
  const origin = observation.origin ? '已关联商品' : '未关联商品';
  return `${classification} · ${origin}`;
}

export default async function NewItemIntakePage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string; item?: string; from?: string; observation?: string }>;
}) {
  const { scope, item, from, observation } = await searchParams;
  const rawScope = typeof scope === 'string' ? scope : undefined;
  const scopeId = uuidOf(scope);
  const itemId = uuidOf(item);
  const observationId = uuidOf(observation);
  // 安全返回点：只接受站内 /dashboard/ 相对路径，拒绝协议相对地址、反斜杠与外部 URL。
  const returnHref = safeInternalReturnHref(from);
  const backHref = returnHref ?? '/dashboard/catalog';
  const backLabel = isIssuesReturnHref(returnHref) ? '返回待处理' : returnHref ? '返回原处' : '返回商品库';

  let data: Awaited<ReturnType<typeof getNewItemWorkspace>> | null = null;
  let state: LegacyEntryState = 'disabled';
  let observationMissing = false;
  if (rawScope && !scopeId) {
    state = 'forbidden';
  } else {
    try {
      // 观测定位由既有工作区读取支持：只读取该范围下这一条来源观测及其分类/关联状态。
      data = await getNewItemWorkspace(scopeId, observationId);
    } catch (error) {
      if (observationId) {
        // 原观测不在该范围时退回整个范围工作区，并明确提示未定位到原观测。
        try {
          data = await getNewItemWorkspace(scopeId);
          observationMissing = true;
        } catch (retryError) {
          state = classifyCatalogReadFailure(retryError) === 'forbidden' ? 'forbidden' : 'read_failed';
        }
      } else {
        state = classifyCatalogReadFailure(error) === 'forbidden' ? 'forbidden' : 'read_failed';
      }
    }
  }
  if (data && data.enabled) {
    const itemLabel = itemId ? await getCatalogItemLabel(itemId) : null;
    const located = observationId
      ? data.workspace?.observations.find((entry) => entry.observationId === observationId)
      : undefined;
    return (
      <main className="p-6 space-y-3" data-testid="new-item-page">
        <Link className="underline text-sm" href={backHref}>{backLabel}</Link>
        <h1 className="text-2xl font-semibold">持续新品</h1>
        <p className="text-sm" data-testid="intake-context">
          当前范围：{data.workspace?.scope.displayName ?? '未选择来源范围'}
          {itemId ? ` · 关联商品：${itemLabel ?? '未读取到摘要'}` : ''}
        </p>
        {observationId && (
          <p className="text-sm" data-testid="intake-observation-locate">
            {!data.workspace
              ? '当前没有可查看的授权来源范围，因此未定位原观测。'
              : located
                ? `已定位原观测：${classificationSummary(located)}`
                : observationMissing
                  ? '原观测不在该来源范围：已显示该范围工作区，未替你切换到别的范围。'
                  : '原观测不在当前授权范围内：请核对来源范围后重试。'}
          </p>
        )}
        <NewItemIntake
          key={data.scopeId ?? 'disabled'}
          data={data}
          itemId={itemId}
          returnHref={returnHref ?? undefined}
          focusObservationId={located?.observationId}
        />
      </main>
    );
  }
  const itemContext = state === 'disabled' && itemId ? await getLegacyEntryItemContext(itemId) : null;
  return (
    <LegacyEntryGuidance
      moduleKey="new_item"
      title="持续新品"
      lede="持续新品资料的旧链接仍然可用：模块启用且已授权时这里是原处理页，否则本页给出安全引导并保留原有处理能力；待处理事项集中到商品库「待处理」索引。"
      state={state}
      itemId={itemId}
      itemContext={itemContext}
      returnHref={returnHref}
    />
  );
}
