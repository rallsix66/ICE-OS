'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import styles from './inventory.module.css';
import {
  buildConfirmMappingsIntent,
  timestampOr,
  validateMappingDraft,
  type MappingDraft,
} from '../model';
import { marketLabel } from '@/features/overview/markets';
import {
  groupPendingBindingRows,
  pendingBindingCandidateDiffFields,
  type PendingBindingCandidate,
  type PendingBindingGroup,
  type PendingBindingRow,
  type PendingBindingSuggestion,
} from '../pending-bindings';
import type { InventoryTargetItemDto } from '../types';
import {
  confirmInventoryMappingsAction,
  getInventoryPendingBindingsAction,
  getSkuWarehousePriorBindingsAction,
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

type Tone = 'ok' | 'warn' | 'error';
type PanelMessage = { text: string; tone: Tone };

interface GroupMeta {
  loading: boolean;
  /** 同 SKU 其他仓曾选过的商品：每款一个候选项。 */
  skuCandidates: PendingBindingCandidate[];
  /** 搜索到的其他商品（「都不是这两款」时使用）。 */
  searchResults: InventoryTargetItemDto[];
  error: string | null;
}

interface GroupDraft {
  itemId: string;
  itemLabel: string;
  unit: string;
  reason: string;
  note: string;
  verification: boolean;
  selectedRowKeys: string[];
  searchTerm: string;
}

const EMPTY_META: GroupMeta = { loading: false, skuCandidates: [], searchResults: [], error: null };

function defaultDraft(group: PendingBindingGroup): GroupDraft {
  return {
    itemId: '',
    itemLabel: '',
    unit: '',
    reason: '',
    note: '',
    verification: group.rows.some((row) => row.verification),
    // 默认只勾当前这一仓（组内第一条，按队列顺序），其余仓由用户显式勾选。
    selectedRowKeys: group.rows[0] ? [group.rows[0].rowKey] : [],
    searchTerm: '',
  };
}

function candidateLabel(candidate: InventoryTargetItemDto): string {
  const code = (candidate.iceCode ?? '').trim() || '未编号';
  const name = (candidate.nameCn ?? '').trim() || '未命名商品';
  return `${code} · ${name}`;
}

function rowLabel(row: PendingBindingRow): string {
  return `${row.warehouseName} · ${marketLabel(row.market)}`;
}

function groupMessageText(message: PanelMessage | undefined): string {
  return message?.text ?? '';
}

/**
 * 商品库存「待处理」弹窗正文：按来源 SKU 分组、展示同 SKU 其他仓已确认绑定、
 * 候选差异、勾选本次要绑定的仓，并在弹窗内直接保存（复用既有 pending/原请求流程）。
 *
 * 打开弹窗时才挂载并懒加载完整清单；保存成功后本组从清单移除并刷新计数。
 */
export function PendingBindingsPanel({
  viewer,
  pendingLocked,
  onClose,
  onSaved,
}: {
  viewer: LocalViewerIdentity | null;
  pendingLocked: boolean;
  onClose: () => void;
  /** 保存成功：通知入口按成功条数即时下调徽标数量（不整页刷新，避免弹窗被卸载）。 */
  onSaved: (savedRows: number) => void;
}) {
  const router = useRouter();
  const local = useSyncExternalStore(subscribeLocalUnknown, getLocalUnknownSnapshot, getLocalUnknownServerSnapshot);
  const localOwner = local ? localUnknownOwnerCheck(local, viewer) : { trusted: true, reason: null };
  const writeLocked = pendingLocked || Boolean(local);

  const [rows, setRows] = useState<PendingBindingRow[] | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ok' | 'error'>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [expandedSku, setExpandedSku] = useState<string | null>(null);
  const [metas, setMetas] = useState<Record<string, GroupMeta>>({});
  const [drafts, setDrafts] = useState<Record<string, GroupDraft>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, PanelMessage>>({});
  /** 弹窗级结果：保存成功后本组会从清单移除，结果句必须留在弹窗顶部，不能随组一起消失。 */
  const [result, setResult] = useState<PanelMessage | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoadState('loading');
      setLoadError(null);
      const result = await getInventoryPendingBindingsAction();
      if (cancelled) return;
      if (result.ok && result.data && result.data.state === 'ok') {
        setRows(result.data.rows);
        setLoadState('ok');
        return;
      }
      setRows(null);
      setLoadState('error');
      setLoadError(result.message ?? (result.data?.state === 'read_failed' ? result.data.error : '待绑定清单读取失败；请重试。'));
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadNonce]);

  const groups = groupPendingBindingRows(rows ?? []);

  function setMessage(sku: string, message: PanelMessage): void {
    setMessages((current) => ({ ...current, [sku]: message }));
  }

  function draftOf(group: PendingBindingGroup): GroupDraft {
    return drafts[group.externalSku] ?? defaultDraft(group);
  }

  function updateDraft(group: PendingBindingGroup, patch: Partial<GroupDraft>): void {
    setDrafts((current) => ({
      ...current,
      [group.externalSku]: { ...(current[group.externalSku] ?? defaultDraft(group)), ...patch },
    }));
  }

  async function toggleGroup(group: PendingBindingGroup): Promise<void> {
    const sku = group.externalSku;
    if (expandedSku === sku) {
      setExpandedSku(null);
      return;
    }
    setExpandedSku(sku);
    if (!drafts[sku]) setDrafts((current) => ({ ...current, [sku]: defaultDraft(group) }));
    if (metas[sku]) return;
    setMetas((current) => ({ ...current, [sku]: { ...EMPTY_META, loading: true } }));
    try {
      const result = await getSkuWarehousePriorBindingsAction({ externalSku: sku });
      setMetas((current) => ({
        ...current,
        [sku]: {
          ...(current[sku] ?? EMPTY_META),
          loading: false,
          skuCandidates: result.candidates,
          error: result.ok ? null : result.message,
        },
      }));
      if (!result.ok) setMessage(sku, { text: result.message, tone: 'warn' });
    } catch {
      setMetas((current) => ({ ...current, [sku]: { ...(current[sku] ?? EMPTY_META), loading: false, error: '其他仓绑定读取失败（连接异常）；可重试。' } }));
      setMessage(sku, { text: '其他仓绑定读取失败（连接异常）；可重试，不要凭猜测绑定。', tone: 'error' });
    }
  }

  async function searchGroup(group: PendingBindingGroup): Promise<void> {
    const draft = draftOf(group);
    const term = draft.searchTerm.trim();
    if (!term) {
      setMessage(group.externalSku, { text: '请输入货号、名称或 69 编码后再搜索。', tone: 'error' });
      return;
    }
    const sku = group.externalSku;
    setBusy(`search:${sku}`);
    try {
      const result = await searchMappingTargetItemsAction({ search: term });
      setMetas((current) => ({
        ...current,
        [sku]: {
          ...(current[sku] ?? EMPTY_META),
          searchResults: result.items,
          error: result.ok ? null : result.message,
        },
      }));
      setMessage(sku, { text: result.message, tone: result.ok ? 'ok' : 'error' });
    } catch {
      setMessage(sku, { text: '目标商品搜索失败（连接或后台异常）；可重试。', tone: 'error' });
    } finally {
      setBusy(null);
    }
  }

  /** 选用一款候选/搜索结果；候选带已登记库存单位时直接沿用，缺单位才要求填写。 */
  function pickItem(
    group: PendingBindingGroup,
    itemId: string,
    label: string,
    registeredUnit?: string | null,
  ): void {
    const unit = (registeredUnit ?? '').trim();
    updateDraft(group, unit ? { itemId, itemLabel: label, unit } : { itemId, itemLabel: label, unit: '' });
    setMessage(group.externalSku, {
      text: unit
        ? `已选择 ${label}；已登记库存单位为「${unit}」，核对后可直接保存。`
        : `已选择 ${label}；该商品没有登记库存单位，请在下方填写单位后保存。`,
      tone: 'ok',
    });
  }

  function toggleWarehouse(group: PendingBindingGroup, rowKey: string): void {
    const draft = draftOf(group);
    const next = draft.selectedRowKeys.includes(rowKey)
      ? draft.selectedRowKeys.filter((key) => key !== rowKey)
      : [...draft.selectedRowKeys, rowKey];
    updateDraft(group, { selectedRowKeys: next });
  }

  async function saveGroup(group: PendingBindingGroup): Promise<void> {
    if (busy !== null || writeLocked) return;
    const sku = group.externalSku;
    const draft = draftOf(group);
    const selected = group.rows.filter((row) => draft.selectedRowKeys.includes(row.rowKey));
    if (!draft.itemId.trim()) {
      setMessage(sku, { text: '请选择要绑定的商品（候选、其他仓已绑定商品或搜索结果）。', tone: 'error' });
      return;
    }
    if (selected.length === 0) {
      setMessage(sku, { text: '请至少勾选一个本次要绑定的仓库。', tone: 'error' });
      return;
    }
    const entries: ReturnType<typeof validateMappingDraft>['payload'] = [];
    const errors: string[] = [];
    for (const row of selected) {
      const rowDraft: MappingDraft = {
        rowKey: row.rowKey,
        externalSku: group.externalSku,
        itemId: draft.itemId.trim(),
        itemLabel: draft.itemLabel,
        unit: draft.unit,
        reason: draft.reason,
        warehouseExternalIds: row.warehouseExternalId ? [row.warehouseExternalId] : [],
        expectedVersion: row.currentVersion,
        note: draft.note,
        verification: draft.verification,
      };
      const validation = validateMappingDraft(rowDraft, { requireVersion: row.currentVersion !== null });
      if (!validation.ok) {
        errors.push(`${rowLabel(row)}：${validation.errors.join('、')}`);
        continue;
      }
      entries.push(...validation.payload);
    }
    if (errors.length > 0) {
      setMessage(sku, { text: `无法保存：${errors.slice(0, 3).join('；')}`, tone: 'error' });
      return;
    }
    const requestId = crypto.randomUUID();
    const intent = buildConfirmMappingsIntent(entries);
    const payload = { mappings: entries };
    setBusy(`save:${sku}`);
    setMessage(sku, { text: '正在保存绑定…', tone: 'ok' });
    try {
      // 1) 先登记原请求；登记未知/失败不继续业务写。
      const registration = await registerOriginalRequest({
        requestId,
        action: 'confirm_inventory_mapping',
        intent,
        payload,
        viewer,
      });
      if (!registration.registered) {
        setMessage(sku, { text: registration.message, tone: registration.unknown ? 'warn' : 'error' });
        if (registration.unknown) window.location.reload();
        return;
      }
      // 2) 原动作（服务端按同一 requestId 幂等）。
      const result = await confirmInventoryMappingsAction({ mappings: entries, requestId, intent });
      if (result.outcomeUnknown) {
        setMessage(sku, { text: result.message, tone: settlementTone(result) });
        router.refresh();
        return;
      }
      const release = settlementReleasesLock(result);
      if (release) clearLocalUnknownRequest(requestId);
      const applied = result.applied ?? 0;
      // 只有全部条目都实际生效才从清单移除；跳过/部分生效保留行，避免把未知当已绑定。
      const allApplied = result.ok && applied >= entries.length;
      if (allApplied) {
        const savedKeys = new Set(selected.map((row) => row.rowKey));
        const remaining = (rows ?? []).filter((row) => row.externalSku === sku && !savedKeys.has(row.rowKey));
        setRows((current) => (current
          ? current.filter((row) => !(row.externalSku === sku && savedKeys.has(row.rowKey)))
          : current));
        setDrafts((current) => {
          const next = { ...current };
          if (remaining.length > 0) {
            next[sku] = defaultDraft({ externalSku: sku, rows: remaining, warehouses: [] });
          } else {
            delete next[sku];
          }
          return next;
        });
        if (remaining.length === 0) setExpandedSku(null);
        setMessage(sku, { text: result.message, tone: settlementTone(result) });
        // 保存成功后本组可能还有仓未处理：结果句固定留在弹窗顶部，并写清本组/全部还剩多少。
        const remainingTotal = Math.max(0, ((rows ?? []).length) - applied);
        const groupNote = remaining.length > 0
          ? `本组还剩 ${remaining.length} 个仓可继续处理。`
          : '';
        setResult({
          text: `${result.message} 本次保存 ${applied} 个仓；${groupNote}还剩 ${remainingTotal} 条可继续处理。`,
          tone: settlementTone(result),
        });
        onSaved(selected.length);
        return;
      }
      // 失败/部分生效保留选择与弹窗，可修正后重试（不整页刷新，避免丢掉当前选择）。
      setMessage(sku, { text: result.message, tone: settlementTone(result) });
    } catch {
      setMessage(sku, {
        text: '保存绑定结果暂未确认（连接中断）。刷新页面后从“原请求待核对”入口核对，不要重复提交。',
        tone: 'warn',
      });
      window.location.reload();
    } finally {
      setBusy(null);
    }
  }

  if (loadState === 'loading') {
    return (
      <p className={styles.pendingPanelHint} data-testid="inventory-pending-loading">
        正在读取待绑定清单…
      </p>
    );
  }

  if (loadState === 'error') {
    return (
      <div className={styles.pendingPanelError} data-testid="inventory-pending-error">
        <p>{loadError ?? '待绑定清单读取失败；请重试。'}</p>
        <button
          type="button"
          className={styles.secondaryButton}
          onClick={() => setReloadNonce((value) => value + 1)}
          data-testid="inventory-pending-retry"
        >
          重试读取
        </button>
      </div>
    );
  }

  if (groups.length === 0) {
    return (
      <p className={styles.pendingPanelHint} data-testid="inventory-pending-empty">
        当前没有需要绑定商品的海外仓记录。
      </p>
    );
  }

  return (
    <div className={styles.pendingPanel} data-testid="inventory-pending-panel">
      <p className={styles.pendingPanelHint}>
        按来源 SKU 分组：先选商品，再勾选本次要绑定的仓库。商品已登记的库存单位会直接带出供核对，
        没有登记时才需要填写；理由必填。保存后其他仓仍可接着处理，只有下一次完整同步批次才计入合计。
      </p>
      {result ? (
        <p className={styles.pendingMessage} data-tone={result.tone} role="status" data-testid="inventory-pending-result">
          {result.text}
        </p>
      ) : null}
      {writeLocked ? (
        <p className={styles.inlineNotice} data-testid="inventory-pending-locked">
          原请求待核对期间不能保存新的绑定（服务端同样拒绝新写）。
          {local && !localOwner.trusted ? ' 本地保留的原请求归属/身份不可信：保持锁定，等待原管理员处理。' : ''}
        </p>
      ) : null}
      <ul className={styles.pendingGroupList}>
        {groups.map((group) => {
          const draft = draftOf(group);
          const meta = metas[group.externalSku] ?? EMPTY_META;
          const expanded = expandedSku === group.externalSku;
          const message = messages[group.externalSku];
          const diffFields = pendingBindingCandidateDiffFields(meta.searchResults);
          const candidateItemIds = new Set(meta.skuCandidates.map((candidate) => candidate.itemId));
          const suggestionPicks: Array<{ itemId: string; label: string; source: string }> = [];
          const seenPicks = new Set<string>(candidateItemIds);
          for (const row of group.rows) {
            const suggestion: PendingBindingSuggestion | null = row.suggestion;
            if (!suggestion || seenPicks.has(suggestion.itemId)) continue;
            seenPicks.add(suggestion.itemId);
            const label = [suggestion.iceCode, suggestion.nameCn].filter(Boolean).join(' · ') || '未命名商品';
            suggestionPicks.push({ itemId: suggestion.itemId, label, source: '本批建议' });
          }
          return (
            <li key={group.externalSku} className={styles.pendingGroup} data-testid="inventory-pending-group" data-sku={group.externalSku}>
              <div className={styles.pendingGroupHead}>
                <div>
                  <strong className={styles.pendingGroupTitle}>来源 SKU：{group.externalSku}</strong>
                  <p className={styles.pendingGroupMeta}>
                    {group.rows.length} 个仓待绑定：
                    {group.rows.map((row, index) => (
                      <span key={row.rowKey} className={styles.pendingWarehouseFact} data-testid="inventory-pending-warehouse-fact">
                        {index > 0 ? ' · ' : ''}
                        {rowLabel(row)}（最近出现 {timestampOr(row.latestRunAt, '暂无记录')}）
                      </span>
                    ))}
                  </p>
                </div>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={() => void toggleGroup(group)}
                  data-testid="inventory-pending-expand"
                  aria-expanded={expanded}
                >
                  {expanded ? '收起' : '绑定商品'}
                </button>
              </div>

              {expanded ? (
                <div className={styles.pendingGroupBody}>
                  {meta.loading ? <p className={styles.pendingPanelHint}>正在读取同 SKU 其他仓绑定…</p> : null}

                  <div className={styles.pendingSection} data-testid="inventory-pending-prior">
                    <p className={styles.pendingSectionTitle}>
                      同 SKU 其他仓曾选过的商品（每款只列一次，按品名、货号与实际差异选一款）
                    </p>
                    {meta.skuCandidates.length > 0 ? (
                      <ul className={styles.pendingCandidateList}>
                        {meta.skuCandidates.map((candidate) => {
                          const selected = draft.itemId === candidate.itemId;
                          const label = [candidate.iceCode, candidate.nameCn].filter(Boolean).join(' · ') || '未命名商品';
                          return (
                            <li
                              key={candidate.itemId}
                              className={styles.pendingCandidate}
                              data-selected={selected ? 'true' : undefined}
                              data-item-id={candidate.itemId}
                              data-testid="inventory-pending-sku-candidate"
                            >
                              <div className={styles.pendingCandidateHead}>
                                <strong>{label}</strong>
                                <button
                                  type="button"
                                  className={styles.secondaryButton}
                                  onClick={() => pickItem(group, candidate.itemId, label, candidate.unit)}
                                  disabled={busy !== null || writeLocked}
                                  data-testid="inventory-pending-candidate-pick"
                                >
                                  {selected ? '已选' : '选这款'}
                                </button>
                              </div>
                              <p data-testid="inventory-pending-candidate-facts">
                                规格：{candidate.specification ?? '—'}
                                <span className={styles.pendingQuickPickMeta}> · </span>
                                条码：{candidate.gtin ?? '—'}
                              </p>
                              <p
                                data-testid="inventory-pending-candidate-unit"
                                data-unit-known={candidate.unit ? 'true' : 'false'}
                              >
                                已登记库存单位：
                                {candidate.unit
                                  ? `${candidate.unit}（核对后直接沿用，无需再填）`
                                  : candidate.unitValues.length > 0
                                    ? `${candidate.unitValues.join(' / ')}（各仓不一致，请在下方填写）`
                                    : '未登记（保存前需填写）'}
                              </p>
                              <p data-testid="inventory-pending-candidate-warehouses">
                                曾选过它的仓：
                                {candidate.warehouses
                                  .map((warehouse) => `${warehouse.warehouseName}（${marketLabel(warehouse.market)}）`)
                                  .join('、')}
                              </p>
                              {candidate.diffNotes.length > 0 ? (
                                <ul className={styles.pendingDifferences} data-testid="inventory-pending-candidate-diff">
                                  {candidate.diffNotes.map((note) => <li key={note}>{note}</li>)}
                                </ul>
                              ) : (
                                <p className={styles.pendingQuickPickMeta}>同 SKU 只有这一款已确认绑定的商品。</p>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    ) : meta.loading ? null : (
                      <p className={styles.pendingPanelHint}>
                        同 SKU 在其他仓没有已确认绑定；请按货号/名称搜索商品。
                      </p>
                    )}
                  </div>

                  {suggestionPicks.length > 0 ? (
                    <div className={styles.pendingSection} data-testid="inventory-pending-quick-picks">
                      <p className={styles.pendingSectionTitle}>本批来源样表里出现过的商品（仍需人工确认）</p>
                      <div className={styles.pendingQuickPicks}>
                        {suggestionPicks.map((pick) => (
                          <button
                            key={pick.itemId}
                            type="button"
                            className={styles.pendingQuickPick}
                            onClick={() => pickItem(group, pick.itemId, pick.label)}
                            data-testid="inventory-pending-quick-pick"
                          >
                            {pick.label}
                            <span className={styles.pendingQuickPickMeta}> · {pick.source}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  <details className={styles.pendingDetails} data-testid="inventory-pending-search-details">
                    <summary>都不是这两款？搜索其他商品</summary>
                    <div className={styles.intervalRow} style={{ marginTop: 8 }}>
                      <input
                        type="search"
                        value={draft.searchTerm}
                        onChange={(event) => updateDraft(group, { searchTerm: event.target.value })}
                        placeholder="货号 / 名称 / 69 编码"
                        maxLength={120}
                        aria-label={`搜索目标商品 ${group.externalSku}`}
                        disabled={busy !== null || writeLocked}
                        data-testid="inventory-pending-search"
                      />
                      <button
                        type="button"
                        className={styles.secondaryButton}
                        onClick={() => void searchGroup(group)}
                        disabled={busy !== null || writeLocked}
                        data-testid="inventory-pending-search-button"
                      >
                        {busy === `search:${group.externalSku}` ? '搜索中…' : '搜索商品'}
                      </button>
                    </div>
                    {meta.searchResults.length > 0 ? (
                      <ul className={styles.pendingCandidateList}>
                        {meta.searchResults.map((candidate) => {
                          const selected = draft.itemId === candidate.itemId;
                          return (
                            <li
                              key={candidate.itemId}
                              className={styles.pendingCandidate}
                              data-selected={selected ? 'true' : undefined}
                              data-testid="inventory-pending-candidate"
                            >
                              <div className={styles.pendingCandidateHead}>
                                <strong>{candidateLabel(candidate)}</strong>
                                <button
                                  type="button"
                                  className={styles.secondaryButton}
                                  onClick={() => pickItem(group, candidate.itemId, candidateLabel(candidate), candidate.unit)}
                                  disabled={busy !== null || writeLocked}
                                  data-testid="inventory-pending-candidate-pick"
                                >
                                  {selected ? '已选' : '选用'}
                                </button>
                              </div>
                              <p className={diffFields.includes('gtin') ? styles.pendingDiff : undefined}>
                                条码：{candidate.gtin ?? '—'}
                                {diffFields.includes('gtin') ? <span className={styles.pendingDiffTag}>与其他候选不同</span> : null}
                              </p>
                              <p className={diffFields.includes('specification') ? styles.pendingDiff : undefined}>
                                规格：{candidate.specification ?? '—'}
                                {diffFields.includes('specification') ? <span className={styles.pendingDiffTag}>与其他候选不同</span> : null}
                              </p>
                              <p className={diffFields.includes('unit') ? styles.pendingDiff : undefined}>
                                单位：{candidate.unit ?? '—'}
                                {diffFields.includes('unit') ? <span className={styles.pendingDiffTag}>与其他候选不同</span> : null}
                              </p>
                            </li>
                          );
                        })}
                      </ul>
                    ) : null}
                  </details>

                  <p className={styles.pendingSelected} data-testid="inventory-pending-selected">
                    已选商品：{draft.itemId ? draft.itemLabel || draft.itemId : '尚未选择商品'}
                  </p>
                  <p className={styles.pendingSelected} data-testid="inventory-pending-unit-fact">
                    本次绑定单位：{draft.unit
                      ? `${draft.unit}（沿用该商品已登记库存单位，核对后可直接保存）`
                      : '未登记，请在下方填写'}
                  </p>

                  <div className={styles.pendingSection}>
                    <p className={styles.pendingSectionTitle}>本次要绑定的仓库（默认只勾当前仓，可多选同 SKU 的仓）</p>
                    <ul className={styles.pendingWarehouseList}>
                      {group.rows.map((row) => (
                        <li key={row.rowKey}>
                          <label className={styles.pendingWarehouseChoice}>
                            <input
                              type="checkbox"
                              checked={draft.selectedRowKeys.includes(row.rowKey)}
                              onChange={() => toggleWarehouse(group, row.rowKey)}
                              disabled={busy !== null || writeLocked}
                              data-testid="inventory-pending-warehouse-checkbox"
                            />
                            <span>
                              {rowLabel(row)}
                              <span className={styles.pendingQuickPickMeta}> · 本次出现 {row.rowCount} 行 · 最近出现 {timestampOr(row.latestRunAt, '暂无记录')}</span>
                            </span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  </div>

                  <details className={styles.pendingDetails} data-testid="inventory-pending-details">
                    <summary>补充信息（单位已带出可核对修改；理由必填）</summary>
                    <div className={styles.intervalRow} style={{ marginTop: 8 }}>
                      <label className={styles.field}>
                        <span>{draft.unit ? '单位（已按登记单位填入）' : '单位（该商品未登记，必填）'}</span>
                        <input
                          value={draft.unit}
                          onChange={(event) => updateDraft(group, { unit: event.target.value })}
                          placeholder="如 个 / 件 / 箱"
                          maxLength={20}
                          aria-label={`单位 ${group.externalSku}`}
                          disabled={busy !== null || writeLocked}
                          data-testid="inventory-pending-unit"
                        />
                      </label>
                      <label className={styles.field} style={{ flex: 1 }}>
                        <span>理由（必填）</span>
                        <input
                          value={draft.reason}
                          onChange={(event) => updateDraft(group, { reason: event.target.value })}
                          placeholder="例如 已核对包装；验证数据请写明业务包装单位待确认"
                          maxLength={500}
                          aria-label={`理由 ${group.externalSku}`}
                          disabled={busy !== null || writeLocked}
                          data-testid="inventory-pending-reason"
                        />
                      </label>
                    </div>
                    <div className={styles.intervalRow} style={{ marginTop: 8 }}>
                      <label className={styles.field} style={{ flex: 1 }}>
                        <span>备注（可选）</span>
                        <input
                          value={draft.note}
                          onChange={(event) => updateDraft(group, { note: event.target.value })}
                          maxLength={500}
                          aria-label={`备注 ${group.externalSku}`}
                          disabled={busy !== null || writeLocked}
                          data-testid="inventory-pending-note"
                        />
                      </label>
                    </div>
                    <label className={styles.checkLine} style={{ marginTop: 8, fontSize: '12px' }}>
                      <input
                        type="checkbox"
                        checked={draft.verification}
                        onChange={(event) => updateDraft(group, { verification: event.target.checked })}
                        disabled={busy !== null || writeLocked}
                        data-testid="inventory-pending-verification"
                      />
                      本次为验证数据（业务包装单位待确认；不作为正式业务合计）
                    </label>
                  </details>

                  <div className={styles.pendingActions}>
                    <button
                      type="button"
                      className={styles.primaryButton}
                      onClick={() => void saveGroup(group)}
                      disabled={busy !== null || writeLocked || group.rows.length === 0}
                      data-testid="inventory-pending-save"
                    >
                      {busy === `save:${group.externalSku}` ? '正在保存…' : '保存绑定'}
                    </button>
                    <button
                      type="button"
                      className={styles.secondaryButton}
                      onClick={onClose}
                      disabled={busy !== null}
                      data-testid="inventory-pending-close"
                    >
                      稍后处理
                    </button>
                  </div>

                  {message ? (
                    <p className={styles.pendingMessage} data-tone={message.tone} role="status" data-testid="inventory-pending-message">
                      {groupMessageText(message)}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
