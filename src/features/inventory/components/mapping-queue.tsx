'use client';

import { useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import styles from './inventory.module.css';
import {
  buildConfirmBatch,
  buildConfirmMappingsIntent,
  buildSyncQueueHref,
  currentMappingStatusLabel,
  mappingDraftForQueueItem,
  mappingRowKey,
  mappingQueuePageRange,
  mappingSuggestionDisplay,
  timestampOr,
  validateMappingDraft,
  verificationBadge,
  type MappingDraft,
} from '../model';
import type {
  InventoryMappingQueueDto,
  InventoryMappingQueueItemDto,
  InventoryTargetItemDto,
} from '../types';
import {
  confirmInventoryMappingsAction,
  searchMappingTargetItemsAction,
} from '../server/actions';
import {
  clearLocalUnknownRequest,
  getLocalUnknownServerSnapshot,
  getLocalUnknownSnapshot,
  localUnknownOwnerCheck,
  subscribeLocalUnknown,
  type LocalViewerIdentity,
} from '../client-pending';
import { registerOriginalRequest } from './pending-recovery';
import { settlementReleasesLock, settlementTone } from '../settlement';
type Message = { text: string; tone: 'ok' | 'warn' | 'error' };

/**
 * F1 商品对应维护：
 * - 行身份 = account + warehouseExternalId + externalSku；选择/草稿/批量都用同一复合 key（不退回纯 SKU，避免同 SKU 跨仓误合并）；
 * - 草稿 expectedVersion 来自队列 currentMapping.version；首次确认 null，重新确认/换绑带页面所见版本；
 * - R3 v4：版本要求**按行**判断（reconfirmRowKeys），同一批可同时提交“首次行 + 已有对应的重确认行”；
 *   服务端旧版本拒绝不变；
 * - 每行 = 一个明确的 (来源 SKU × 仓库) 对；单位/理由必填且无默认值；批量只作用勾选行；
 * - 写动作一律“先登记原请求 → 服务端身份回执 → 原动作 → 清本地”，登记未知不执行并保留本地记录；
 * - 写锁 = 服务端 pending 或 本地保留原请求（R2 v4），覆盖勾选/编辑/搜索/提交等控件。
 */
export function MappingQueue({
  queue,
  mapQ,
  mapPage,
  runId,
  pendingLocked,
  viewer,
  searchAction = '/dashboard/sync',
  searchParamName = 'mapQ',
  pageParamName = 'mapPage',
  searchPlaceholder = '例如 6973517482611 或货号',
  hiddenFields,
  queueFields,
  clearHref,
  locate = null,
  hrefFor,
}: {
  queue: InventoryMappingQueueDto;
  mapQ: string;
  mapPage: number;
  runId: string;
  pendingLocked: boolean;
  viewer: LocalViewerIdentity | null;
  /** 搜索表单提交目标（默认数据同步页；商品库来源 SKU 对应页传入自己的路径）。 */
  searchAction?: string;
  /** 搜索参数名（默认 mapQ，与 /dashboard/sync 兼容）。 */
  searchParamName?: string;
  /** 分页参数名（默认 mapPage；商品库来源 SKU 对应页用 page）。 */
  pageParamName?: string;
  searchPlaceholder?: string;
  /** 搜索表单随附的隐式上下文（如来源页 from/back/item），只透传不参与查询。 */
  hiddenFields?: Record<string, string>;
  /** 仅分页链接随附的定位上下文（如来源页 warehouse/sku）：搜索表单不带，避免新搜索被定位条件挡住。 */
  queueFields?: Record<string, string>;
  /** 清空搜索链接（定位页用它同时清掉目标 SKU/仓库）；缺省按 pageHref 组合。 */
  clearHref?: string;
  /** 目标定位（来自库存行）：本页仅渲染匹配行并高亮置顶；本页没有匹配时明确说明，不虚构。 */
  locate?: { sku: string; warehouseId: string; warehouseName: string } | null;
  /** 分页/清空链接构造（可选；服务端页面不能传函数，默认按 searchAction/参数名/hiddenFields 组合）。 */
  hrefFor?: (state: { run: string; mapQ: string; mapPage: number }, page: number) => string;
}) {
  const router = useRouter();
  const pageHref = hrefFor ?? ((state: { run: string; mapQ: string; mapPage: number }, page: number) => {
    if (searchAction === '/dashboard/sync') return buildSyncQueueHref(state, page);
    const params = new URLSearchParams();
    if (state.run) params.set('run', state.run);
    if (state.mapQ) params.set(searchParamName, state.mapQ);
    if (page > 1) params.set(pageParamName, String(page));
    for (const [key, value] of Object.entries(hiddenFields ?? {})) {
      if (value) params.set(key, value);
    }
    for (const [key, value] of Object.entries(queueFields ?? {})) {
      if (value) params.set(key, value);
    }
    const qs = params.toString();
    return qs ? `${searchAction}?${qs}` : searchAction;
  });
  const [selected, setSelected] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<Record<string, MappingDraft>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [targetSearch, setTargetSearch] = useState<{ key: string; q: string; results: InventoryTargetItemDto[] } | null>(null);
  const local = useSyncExternalStore(subscribeLocalUnknown, getLocalUnknownSnapshot, getLocalUnknownServerSnapshot);
  const writeLocked = pendingLocked || Boolean(local);
  const localOwner = local ? localUnknownOwnerCheck(local, viewer) : { trusted: true, reason: null };

  const range = mappingQueuePageRange(queue.total, mapPage);
  const pageState = { run: runId, mapQ, mapPage };
  const locateSkuKey = locate?.sku.trim().toLowerCase() ?? '';
  /** 定位范围的人话标签：仓名 / 来源 SKU / 两者；都为空时退回“目标仓”。 */
  const locateScopeLabel = locate
    ? ([
      locate.warehouseName ? `「${locate.warehouseName}」` : '',
      locate.sku ? `来源 SKU「${locate.sku}」` : '',
    ].filter(Boolean).join(' · ') || '目标仓')
    : '';

  /** 定位行 = 目标仓 + 目标来源 SKU（大小写不敏感）；页面已按服务端检索结果过滤，这里再兜底置顶。 */
  function isLocated(item: InventoryMappingQueueItemDto): boolean {
    if (!locate) return false;
    if (locate.warehouseId && item.warehouseId !== locate.warehouseId) return false;
    if (locateSkuKey && item.externalSku.trim().toLowerCase() !== locateSkuKey) return false;
    return Boolean(locate.warehouseId || locateSkuKey);
  }

  // 目标行置顶：定位模式下本页应只有目标行；其余行（若有）排在后面，不删除、不伪造。
  const displayItems = locate
    ? [...queue.items].sort((left, right) => Number(isLocated(right)) - Number(isLocated(left)))
    : queue.items;

  function rowKey(item: InventoryMappingQueueItemDto): string {
    return mappingRowKey(item.warehouseExternalId, item.externalSku);
  }

  function draftFor(item: InventoryMappingQueueItemDto): MappingDraft {
    return drafts[rowKey(item)] ?? mappingDraftForQueueItem(item);
  }

  function updateDraft(item: InventoryMappingQueueItemDto, patch: Partial<MappingDraft>) {
    const base = draftFor(item);
    setDrafts((current) => ({ ...current, [rowKey(item)]: { ...base, ...patch } }));
  }

  function toggleSelected(item: InventoryMappingQueueItemDto) {
    const key = rowKey(item);
    setSelected((current) => (current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key]));
  }

  function adoptSuggestion(item: InventoryMappingQueueItemDto) {
    const suggestion = item.suggestion;
    if (!suggestion) return;
    updateDraft(item, {
      itemId: suggestion.itemId,
      itemLabel: mappingSuggestionDisplay(item).title,
    });
    setMessage({ text: '已填入建议商品；仍需填写单位与理由后提交。', tone: 'ok' });
  }

  async function searchTarget(item: InventoryMappingQueueItemDto) {
    const key = rowKey(item);
    const typed = targetSearch?.key === key ? targetSearch.q : '';
    const search = typed.trim() || item.externalSku;
    setBusy(`search:${key}`);
    try {
      const result = await searchMappingTargetItemsAction({ search });
      setTargetSearch({ key, q: search, results: result.items });
      setMessage({ text: result.message, tone: result.ok ? 'ok' : 'error' });
    } catch {
      setMessage({ text: '目标商品搜索失败（连接或后台异常）；可重试，不要凭猜测提交。', tone: 'error' });
    } finally {
      setBusy(null);
    }
  }

  function pickTarget(item: InventoryMappingQueueItemDto, target: InventoryTargetItemDto) {
    updateDraft(item, {
      itemId: target.itemId,
      itemLabel: `${target.iceCode ?? '未编号'} · ${target.nameCn ?? '未命名商品'}`,
    });
    setMessage({ text: `已选择目标商品：${target.iceCode ?? target.itemId}`, tone: 'ok' });
  }

  function resultTone(result: Awaited<ReturnType<typeof confirmInventoryMappingsAction>>): Message['tone'] {
    return settlementTone(result);
  }

  async function submitRows(items: InventoryMappingQueueItemDto[], label: string) {
    const keys = items.map((item) => rowKey(item));
    if (keys.length === 0) {
      setMessage({ text: '请先勾选要确认的对应行（不会默认全选）。', tone: 'error' });
      return;
    }
    // R3：版本要求按行（已有当前对应/需重核的行才要求页面所见版本）；首次行 expectedVersion=null 合法。
    const plan = buildConfirmBatch({
      selectedRowKeys: keys,
      drafts: items.map((item) => draftFor(item)),
      reconfirmRowKeys: items
        .filter((item) => item.currentMapping !== null)
        .map((item) => rowKey(item)),
    });
    if (!plan.ok) {
      setMessage({ text: `无法提交：${plan.errors.slice(0, 3).join('；')}`, tone: 'error' });
      return;
    }
    const requestId = crypto.randomUUID();
    const intent = buildConfirmMappingsIntent(plan.entries);
    const payload = { mappings: plan.entries };
    setBusy('confirm');
    setMessage({ text: `正在提交${label}…`, tone: 'ok' });
    try {
      // 1) 先登记；登记未知/失败不继续业务写（登记未知由 helper 保存本地记录）。
      const registration = await registerOriginalRequest({
        requestId,
        action: 'confirm_inventory_mapping',
        intent,
        payload,
        viewer,
      });
      if (!registration.registered) {
        setMessage({ text: registration.message, tone: registration.unknown ? 'warn' : 'error' });
        if (registration.unknown) {
          window.location.reload();
        } else {
          router.refresh();
        }
        return;
      }
      // 2) 原动作（内部 begin 幂等重放同一 requestId）。
      const result = await confirmInventoryMappingsAction({
        mappings: plan.entries,
        requestId,
        intent,
      });
      if (result.outcomeUnknown) {
        // 业务结果未知：保留本地记录（registration:'registered'），服务端 pending 优先用于恢复。
        setMessage({ text: result.message, tone: resultTone(result) });
        router.refresh();
        return;
      }
      // v4-final R2：只有成功解锁、或服务端确认原请求已结案（settled/no_pending）才清本地记录；
      // 版本冲突等确定失败也走结案，结案成功后允许修正后重做。
      const release = settlementReleasesLock(result);
      if (release) {
        clearLocalUnknownRequest(requestId);
        setSelected([]);
      }
      setMessage({ text: result.message, tone: resultTone(result) });
      // 结案失败/不是原请求：保持勾选与锁，刷新显示服务端恢复入口。
      router.refresh();
    } catch {
      // 业务动作网络异常：本地记录（registration:'registered'）保留；整页重载进入恢复入口，不自动重发。
      setMessage({
        text: `${label}的提交结果暂未确认（连接中断）。刷新页面后从“原请求待核对”入口核对，不要重复提交。`,
        tone: 'warn',
      });
      window.location.reload();
    } finally {
      setBusy(null);
    }
  }

  const selectedItems = queue.items.filter((item) => selected.includes(rowKey(item)));

  return (
    <div data-testid="sync-mapping-queue">
      <p className={styles.cardLead}>
        {locate ? (
          <>
            已按库存行定位到{locateScopeLabel}
            ：本页只显示匹配的待处理行（服务端检索共 <strong>{queue.total}</strong> 个待处理对，翻页沿用同一检索）。
            未对应数量保留但<strong>不计入商品合计</strong>；确认后下一次完整批次才采用。
          </>
        ) : (
          <>
            当前有 <strong>{queue.total}</strong> 个待处理的 (来源 SKU × 仓库) 对（第 {range.from}–{range.to} 条）。未对应数量保留但<strong>不计入商品合计</strong>；
            旧样表只作为“有出处的建议”，必须由管理员明确选择商品、填写单位（无默认值）和理由后才生效，且下一次完整批次才采用。
            验证数据（业务包装单位待确认）请勾选“验证数据”标记，不作为正式业务合计。
          </>
        )}
      </p>

      <form className={styles.filterForm} method="get" action={searchAction} data-testid="sync-mapping-search">
        {runId ? <input type="hidden" name="run" value={runId} /> : null}
        {Object.entries(hiddenFields ?? {}).map(([name, value]) => (
          value ? <input key={name} type="hidden" name={name} value={value} /> : null
        ))}
        <label className={styles.filterSearch}>
          <span>搜索待处理 SKU / 仓库 / 建议商品</span>
          <input type="search" name={searchParamName} defaultValue={mapQ} maxLength={120} placeholder={searchPlaceholder} />
        </label>
        <div className={styles.filterActions}>
          <button type="submit" className={styles.primaryButton}>搜索</button>
          <Link className={styles.secondaryButton} href={clearHref ?? pageHref({ run: runId, mapQ: '', mapPage: 1 }, 1)} style={{ textDecoration: 'none' }}>
            清空搜索
          </Link>
        </div>
      </form>

      {writeLocked ? (
        <p className={styles.inlineNotice} data-testid="sync-mapping-locked">
          原请求待核对期间，确认/换绑与相关编辑已禁用（服务端同样拒绝新写）。
          {local
            ? localOwner.trusted
              ? ' 本地还保留一条结果未知的原请求：先在页面顶部核对。'
              : ' 本地保留的原请求归属/身份不可信：保持锁定，等待原管理员处理。'
            : ''}
        </p>
      ) : null}

      {queue.items.length === 0 ? (
        <p className={styles.inlineNotice} data-testid="sync-mapping-empty">
          {locate
            ? (
              <>
                本页未找到{locateScopeLabel}的待处理行。
                {queue.total > 0
                  ? ` 服务端按${locate.sku ? `来源 SKU「${locate.sku}」` : '当前条件'}检索共有 ${queue.total} 个待处理对，本页不含目标行；可翻页继续查找。`
                  : ' 服务端检索也没有匹配的待处理对：若该来源 SKU 已确认对应，它不会出现在待处理队列（请看下方「已确认对应」）；本页不会虚构成待处理行。'}
              </>
            )
            : queue.total > 0 ? '当前页没有待处理行；请返回第一页或清空搜索。' : '当前没有待处理的未对应/候选 SKU。'}
        </p>
      ) : (
        <>
          <div className={styles.buttonRow} style={{ marginBottom: '10px' }}>
            <button
              type="button"
              className={styles.primaryButton}
              onClick={() => submitRows(selectedItems, '所选对应')}
              disabled={busy !== null || writeLocked || selected.length === 0}
              data-testid="sync-mapping-confirm-selected"
            >
              {busy === 'confirm' ? '正在处理…' : `确认所选行（${selected.length}）`}
            </button>
            <span className={styles.fieldHint}>批量只作用于勾选行；每行仍需商品、单位、理由齐全。</span>
          </div>

          <ul className={styles.queueList}>
            {displayItems.map((item) => {
              const suggestion = mappingSuggestionDisplay(item);
              const draft = draftFor(item);
              const checks = validateMappingDraft(draft, { requireVersion: item.currentMapping !== null });
              const key = rowKey(item);
              const checked = selected.includes(key);
              const searchState = targetSearch?.key === key ? targetSearch : null;
              const rowBusy = busy === 'confirm' || busy === `search:${key}`;
              const verification = verificationBadge(item) ?? verificationBadge(draft);
              const mappingStatus = item.mappingStatus ?? item.currentMapping?.status ?? null;
              const located = isLocated(item);
              return (
                <li
                  key={key}
                  className={styles.queueItem}
                  data-confirmable="true"
                  data-testid="sync-mapping-row"
                  data-sku={item.externalSku}
                  data-row-key={key}
                  data-warehouse-external-id={item.warehouseExternalId}
                  data-located={located ? 'true' : undefined}
                  style={located ? { borderColor: '#e6c576', background: '#fffaf0', boxShadow: 'inset 0 0 0 1px #f0d99b' } : undefined}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={busy !== null || writeLocked}
                    onChange={() => toggleSelected(item)}
                    aria-label={`选择待处理 SKU ${item.externalSku}（${item.warehouseName}）`}
                  />
                  <div className={styles.queueMain}>
                    <strong>
                      外部 SKU：{item.externalSku}
                      {located ? <span className={styles.fieldHint} style={{ marginLeft: 8 }}>目标行（从库存行定位）</span> : null}
                    </strong>
                    <div className={styles.queueMeta}>
                      <span data-testid="sync-mapping-warehouse">
                        来源仓库：{item.warehouseName}
                        {item.market ? `（市场 ${item.market}）` : '（市场待确认）'}
                      </span>
                      <span>本次出现 {item.rowCount} 行{item.rowCount === 0 ? '（候选记录，尚未在导出中见到）' : ''}</span>
                      <span>最近出现：{timestampOr(item.latestRunAt, '暂无记录')}</span>
                      {item.currentMapping ? (
                        <span data-testid="sync-mapping-current">
                          当前对应：{currentMappingStatusLabel(item.currentMapping.status)} · 第 {item.currentMapping.version} 版
                          · {item.currentMapping.unit ?? '未标单位'}
                          {item.currentMapping.status !== 'confirmed' ? `（需按第 ${item.currentMapping.version} 版重新确认）` : ''}
                        </span>
                      ) : mappingStatus ? (
                        <span data-testid="sync-mapping-current">当前对应状态：{currentMappingStatusLabel(mappingStatus)}（需按最新版本重新确认）</span>
                      ) : (
                        <span>当前没有生效的仓级对应（首次确认 expectedVersion=null）</span>
                      )}
                      {verification ? <span data-testid="sync-mapping-verification">验证数据：业务包装单位待确认</span> : null}
                    </div>

                    <div className={styles.mappingEditor}>
                      <div className={styles.field}>
                        <span>确认目标（仓库由来源行确定；每行只确认这一个仓，不再创建账号默认）</span>
                        {item.warehouseExternalId ? (
                          <p className={styles.fieldHint}>
                            {item.warehouseName} · 仓编码 {item.warehouseExternalId}
                            {item.currentMapping ? ` · 将带旧版本 第 ${item.currentMapping.version} 版` : ' · 首次确认（expectedVersion 为空）'}
                          </p>
                        ) : (
                          <p className={styles.inlineError} data-testid="sync-mapping-no-warehouse">
                            该行没有仓库身份（历史账号级候选已停用）：不能在这里确认；需来源文件中按仓出现后，按仓重新确认。
                          </p>
                        )}
                      </div>

                      <div className={styles.field}>
                        <span>目标商品（服务端按货号/名称搜索，不要求有库存）</span>
                        <div className={styles.intervalRow}>
                          <input
                            value={searchState?.q ?? ''}
                            onChange={(event) => setTargetSearch({ key, q: event.target.value, results: searchState?.results ?? [] })}
                            placeholder="货号 / 名称 / 69 编码"
                            maxLength={120}
                            aria-label={`搜索目标商品 ${item.externalSku}`}
                            disabled={busy !== null || writeLocked}
                          />
                          <button
                            type="button"
                            className={styles.secondaryButton}
                            onClick={() => searchTarget(item)}
                            disabled={busy !== null || writeLocked}
                          >
                            {busy === `search:${key}` ? '搜索中…' : '搜索'}
                          </button>
                          {suggestion.hasSuggestion ? (
                            <button type="button" className={styles.secondaryButton} onClick={() => adoptSuggestion(item)} disabled={busy !== null || writeLocked}>
                              采用建议
                            </button>
                          ) : null}
                        </div>
                        <p className={styles.fieldHint} data-testid="sync-mapping-target">
                          {draft.itemId ? `已选目标：${draft.itemLabel || draft.itemId}` : '尚未选择目标商品；不能只凭建议自动提交。'}
                        </p>
                        {searchState && searchState.results.length > 0 ? (
                          <div className={styles.searchResultList}>
                            {searchState.results.map((target) => (
                              <button
                                key={target.itemId}
                                type="button"
                                className={styles.searchResultButton}
                                onClick={() => pickTarget(item, target)}
                                disabled={busy !== null || writeLocked}
                                data-testid="sync-mapping-target-result"
                              >
                                {target.iceCode ?? '未编号'} · {target.nameCn ?? '未命名商品'}
                                {target.gtin ? ` · ${target.gtin}` : ''}
                              </button>
                            ))}
                          </div>
                        ) : null}
                      </div>

                      <div className={styles.intervalRow}>
                        <div className={styles.field}>
                          <span>单位（必填，无默认值；不代用户确认业务单位）</span>
                          <input
                            value={draft.unit}
                            onChange={(event) => updateDraft(item, { unit: event.target.value })}
                            placeholder="必须填写（如 件 / 箱）"
                            maxLength={20}
                            aria-label={`单位 ${item.externalSku}`}
                            disabled={busy !== null || writeLocked}
                          />
                        </div>
                        <div className={styles.field} style={{ flex: 1 }}>
                          <span>理由（必填）</span>
                          <input
                            value={draft.reason}
                            onChange={(event) => updateDraft(item, { reason: event.target.value })}
                            placeholder="例如 已核对包装；验证数据请写“验证数据，业务包装单位待确认”"
                            maxLength={500}
                            aria-label={`理由 ${item.externalSku}`}
                            disabled={busy !== null || writeLocked}
                          />
                        </div>
                      </div>

                      <label className={styles.checkLine} style={{ fontSize: '12px' }}>
                        <input
                          type="checkbox"
                          checked={draft.verification}
                          disabled={busy !== null || writeLocked}
                          onChange={(event) => updateDraft(item, { verification: event.target.checked })}
                          aria-label={`验证数据标记 ${item.externalSku}（${item.warehouseName}）`}
                          data-testid="sync-mapping-verification-toggle"
                        />
                        本次为验证数据（业务包装单位待确认；不作为正式业务合计）
                      </label>

                      {suggestion.hasSuggestion ? (
                        <p className={styles.mappingNote}>
                          建议：{suggestion.title}
                          {suggestion.sourceText ? ` · ${suggestion.sourceText}` : ''} · {suggestion.evidenceText}
                          {item.candidateStatus === 'dismissed' ? ' · 候选已被忽略（仍可人工重新确认）' : ''}
                        </p>
                      ) : (
                        <p className={styles.mappingNote}>
                          {suggestion.evidenceText}
                          {item.candidateId ? ' · 该行有候选记录但没有可靠建议，请人工核对。' : ''}
                        </p>
                      )}
                      {item.reason ? <p className={styles.mappingNote}>对应说明：{item.reason}</p> : null}

                      <div className={styles.buttonRow}>
                        <button
                          type="button"
                          className={styles.primaryButton}
                          onClick={() => submitRows([item], item.currentMapping ? '重新确认/换绑' : '确认对应')}
                          disabled={busy !== null || writeLocked || !checks.ok || !checked}
                          title={!checked ? '请先勾选这一行（明确选择该仓该 SKU）' : checks.ok ? '提交本行' : checks.errors.join('；')}
                          data-testid="sync-mapping-submit-row"
                        >
                          {rowBusy ? '处理中…' : item.currentMapping ? `重新确认（第 ${item.currentMapping.version} 版）` : '提交确认'}
                        </button>
                        {!checks.ok ? <span className={styles.fieldHint}>{checks.errors.join('；')}</span> : null}
                        {!checked && checks.ok ? <span className={styles.fieldHint}>先勾选本行再提交（不默认选中）。</span> : null}
                      </div>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}

      <div className={styles.pagination} data-testid="sync-mapping-pagination">
        <span>
          第 {range.from}–{range.to} 条，共 {queue.total} 个 · 第 {range.page}/{range.pageCount} 页
        </span>
        <div className={styles.paginationLinks}>
          {range.hasPrev ? <Link href={pageHref(pageState, range.page - 1)}>上一页</Link> : <span aria-disabled="true">上一页</span>}
          {range.hasNext ? <Link href={pageHref(pageState, range.page + 1)}>下一页</Link> : <span aria-disabled="true">下一页</span>}
        </div>
      </div>

      <p className={styles.statusMessage} data-tone={message?.tone === 'ok' ? undefined : message?.tone} role="status" aria-live="polite">
        {message?.text ?? '确认/换绑只写生效关系；当前库存要等下一次完整批次才采用。重核/停用/换绑在下方「已确认对应」区维护（同样带旧版本 + 理由）。'}
      </p>
    </div>
  );
}
