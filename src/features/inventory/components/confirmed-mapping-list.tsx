'use client';

import { useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import styles from './inventory.module.css';
import {
  buildConfirmMappingsIntent,
  buildDisableMappingIntent,
  buildRecheckMappingIntent,
  currentMappingStatusLabel,
  timestampOr,
  verificationBadge,
} from '../model';
import type { InventoryItemMappingDto, InventoryTargetItemDto, InventoryWarehouseDto } from '../types';
import {
  confirmInventoryMappingsAction,
  disableInventoryMappingAction,
  recheckInventoryMappingAction,
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
 * 已确认对应维护（商品库「来源 SKU 对应」页）：重核 / 停用 / 换绑都带“页面看到的旧版本 + 理由”。
 * - 换绑 = 对同一仓同一 SKU 用新商品提交 confirm（带 expectedVersion）；新值等下一次完整批次才采用；
 * - 停用/重核立即退出当前聚合，历史批次保留原事实；
 * - 写动作一律“先登记（服务端身份回执）→ 本地 v2 记录 → 原动作 → 成功/确定失败清本地”；
 * - 写锁 = 服务端 pending 或本地保留原请求（R2 v4）：本面板所有输入/按钮（含换绑搜索）一并禁用；
 * - R4：可带 targetSku / targetWarehouseId（来自库存行定位）——匹配行高亮置顶，不新增第二套编辑器。
 */
export function ConfirmedMappingList({
  itemLabel,
  mappings,
  warehouses,
  pendingLocked,
  viewer,
  targetSku = null,
  targetWarehouseId = null,
}: {
  /** 用于换绑说明文案；对应关系本身按 mapping 行处理。 */
  itemId: string;
  itemLabel: string;
  mappings: InventoryItemMappingDto[];
  warehouses: InventoryWarehouseDto[];
  pendingLocked: boolean;
  viewer: LocalViewerIdentity | null;
  /** 目标来源 SKU（来自库存行定位）：匹配行高亮置顶。 */
  targetSku?: string | null;
  /** 目标仓 UUID（来自库存行定位）：与 targetSku 一起限定匹配行。 */
  targetWarehouseId?: string | null;
}) {
  const router = useRouter();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [rebind, setRebind] = useState<{
    mappingId: string;
    q: string;
    results: InventoryTargetItemDto[];
    itemId: string;
    itemLabel: string;
    unit: string;
  } | null>(null);
  const local = useSyncExternalStore(subscribeLocalUnknown, getLocalUnknownSnapshot, getLocalUnknownServerSnapshot);
  const writeLocked = pendingLocked || Boolean(local);
  const localOwner = local ? localUnknownOwnerCheck(local, viewer) : { trusted: true, reason: null };
  const targetSkuKey = (targetSku ?? '').trim().toLowerCase();

  const externalIdByWarehouseId = new Map(warehouses.map((warehouse) => [warehouse.id, warehouse.externalId]));

  function isTargetRow(mapping: InventoryItemMappingDto): boolean {
    if (!targetSkuKey && !targetWarehouseId) return false;
    if (targetWarehouseId && mapping.warehouseId !== targetWarehouseId) return false;
    if (targetSkuKey && mapping.externalSku.trim().toLowerCase() !== targetSkuKey) return false;
    return true;
  }

  // 定位行置顶：目标仓该来源 SKU 的已确认关系排在第一条，便于直接重核/停用。
  const orderedMappings = targetSkuKey || targetWarehouseId
    ? [...mappings].sort((left, right) => Number(isTargetRow(right)) - Number(isTargetRow(left)))
    : mappings;

  /** 登记未成功：不发业务写；未知 → 保留本地记录并整页重载；确定失败 → 只显示原因。 */
  function stopAfterRegistrationFailure(outcome: { unknown: boolean; message: string }): void {
    setMessage({ text: outcome.message, tone: outcome.unknown ? 'warn' : 'error' });
    if (outcome.unknown) {
      window.location.reload();
      return;
    }
    router.refresh();
  }

  async function recheck(mapping: InventoryItemMappingDto) {
    if (!reason.trim()) {
      setMessage({ text: '重核必须填写理由。', tone: 'error' });
      return;
    }
    setBusy(`recheck:${mapping.id}`);
    const requestId = crypto.randomUUID();
    const payload = { mappingId: mapping.id, expectedVersion: mapping.version, reason: reason.trim(), note: reason.trim() };
    const intent = buildRecheckMappingIntent({ mappingId: mapping.id, expectedVersion: mapping.version, reason: reason.trim() });
    try {
      const registration = await registerOriginalRequest({
        requestId,
        action: 'recheck_inventory_mapping',
        intent,
        payload,
        viewer,
      });
      if (!registration.registered) {
        stopAfterRegistrationFailure(registration);
        return;
      }
      const result = await recheckInventoryMappingAction({
        mappingId: mapping.id,
        expectedVersion: mapping.version,
        reason: reason.trim(),
        requestId,
        intent,
      });
      if (result.outcomeUnknown) {
        setMessage({ text: result.message, tone: 'warn' });
        router.refresh();
        return;
      }
      // v4-final R2：确认结案或成功解锁才清本地记录；结案失败/不是原请求保留锁。
      if (settlementReleasesLock(result)) clearLocalUnknownRequest(requestId);
      setMessage({ text: result.message, tone: settlementTone(result) });
      router.refresh();
    } catch {
      setMessage({ text: '重核结果暂未确认（连接中断）。刷新后在商品库「来源 SKU 对应」页顶部「原请求待核对」入口核对。', tone: 'warn' });
      window.location.reload();
    } finally {
      setBusy(null);
    }
  }

  async function disable(mapping: InventoryItemMappingDto) {
    if (!reason.trim()) {
      setMessage({ text: '停用必须填写理由。', tone: 'error' });
      return;
    }
    setBusy(`disable:${mapping.id}`);
    const requestId = crypto.randomUUID();
    const payload = { mappingId: mapping.id, expectedVersion: mapping.version, reason: reason.trim(), note: reason.trim() };
    const intent = buildDisableMappingIntent({ mappingId: mapping.id, expectedVersion: mapping.version, reason: reason.trim() });
    try {
      const registration = await registerOriginalRequest({
        requestId,
        action: 'disable_inventory_mapping',
        intent,
        payload,
        viewer,
      });
      if (!registration.registered) {
        stopAfterRegistrationFailure(registration);
        return;
      }
      const result = await disableInventoryMappingAction({
        mappingId: mapping.id,
        expectedVersion: mapping.version,
        reason: reason.trim(),
        requestId,
        intent,
      });
      if (result.outcomeUnknown) {
        setMessage({ text: result.message, tone: 'warn' });
        router.refresh();
        return;
      }
      // v4-final R2：确认结案或成功解锁才清本地记录；结案失败/不是原请求保留锁。
      if (settlementReleasesLock(result)) clearLocalUnknownRequest(requestId);
      setMessage({ text: result.message, tone: settlementTone(result) });
      router.refresh();
    } catch {
      setMessage({ text: '停用结果暂未确认（连接中断）。刷新后在商品库「来源 SKU 对应」页顶部「原请求待核对」入口核对。', tone: 'warn' });
      window.location.reload();
    } finally {
      setBusy(null);
    }
  }

  async function searchTarget(mapping: InventoryItemMappingDto) {
    const current = rebind?.mappingId === mapping.id ? rebind : { mappingId: mapping.id, q: '', results: [], itemId: '', itemLabel: '', unit: '' };
    const search = current.q.trim() || mapping.externalSku;
    setBusy(`search:${mapping.id}`);
    try {
      const result = await searchMappingTargetItemsAction({ search });
      setRebind({ ...current, q: search, results: result.items });
      setMessage({ text: result.message, tone: result.ok ? 'ok' : 'error' });
    } catch {
      setMessage({ text: '目标商品搜索失败；可重试，不要凭猜测换绑。', tone: 'error' });
    } finally {
      setBusy(null);
    }
  }

  async function submitRebind(mapping: InventoryItemMappingDto) {
    if (!rebind || rebind.mappingId !== mapping.id) return;
    const warehouseExternalId = mapping.warehouseExternalId
      ?? (mapping.warehouseId ? externalIdByWarehouseId.get(mapping.warehouseId) ?? '' : '');
    if (!warehouseExternalId) {
      setMessage({ text: '该对应缺少仓库来源身份（历史账号级默认已停用）：请在商品库「来源 SKU 对应」页上方「待处理来源」队列按出现仓库重新确认。', tone: 'error' });
      return;
    }
    if (!rebind.itemId) {
      setMessage({ text: '换绑必须先在搜索结果里选择目标商品。', tone: 'error' });
      return;
    }
    if (!rebind.unit.trim()) {
      setMessage({ text: '换绑必须填写单位（不自动使用“件”）。', tone: 'error' });
      return;
    }
    if (!reason.trim()) {
      setMessage({ text: '换绑必须填写理由。', tone: 'error' });
      return;
    }
    setBusy(`rebind:${mapping.id}`);
    const mappingInput = {
      externalSku: mapping.externalSku,
      warehouseExternalId,
      itemId: rebind.itemId,
      unit: rebind.unit.trim(),
      reason: reason.trim(),
      note: `换绑：${itemLabel} 原对应第 ${mapping.version} 版`,
      expectedVersion: mapping.version,
      verification: mapping.verification === true || mapping.unitUnconfirmed === true,
    };
    const requestId = crypto.randomUUID();
    const intent = buildConfirmMappingsIntent([mappingInput]);
    const payload = { mappings: [mappingInput] };
    try {
      const registration = await registerOriginalRequest({
        requestId,
        action: 'confirm_inventory_mapping',
        intent,
        payload,
        viewer,
      });
      if (!registration.registered) {
        stopAfterRegistrationFailure(registration);
        return;
      }
      const result = await confirmInventoryMappingsAction({
        mappings: [mappingInput],
        requestId,
        intent,
      });
      if (result.outcomeUnknown) {
        setMessage({ text: result.message, tone: 'warn' });
        router.refresh();
        return;
      }
      // v4-final R2：确认结案或成功解锁才清本地记录；结案失败/不是原请求保留锁。
      const release = settlementReleasesLock(result);
      if (release) clearLocalUnknownRequest(requestId);
      setMessage({ text: result.message, tone: settlementTone(result) });
      if (release) setRebind(null);
      router.refresh();
    } catch {
      setMessage({ text: '换绑结果暂未确认（连接中断）。刷新后在商品库「来源 SKU 对应」页顶部「原请求待核对」入口核对。', tone: 'warn' });
      window.location.reload();
    } finally {
      setBusy(null);
    }
  }

  if (mappings.length === 0) {
    return (
      <p className={styles.inlineNotice} data-testid="sync-confirmed-mappings">
        暂无对应关系：该商品当前没有计入合计的来源数量。确认/换绑请在商品库「来源 SKU 对应」页上方「待处理来源」队列的目标行操作（仓库、单位、理由必填）；本页不提供第二套编辑器。
      </p>
    );
  }

  return (
    <div data-testid="sync-confirmed-mappings">
      <p className={styles.cardLead}>
        对应关系按仓生效：停用/重核立即退出当前汇总（历史批次仍保留），换绑要等下一次完整批次才采用新关系。
        所有操作都必须带“页面看到的版本”和理由；版本不一致会被拒绝，不会覆盖别人先做的修改。
      </p>
      {writeLocked ? (
        <p className={styles.inlineNotice} data-testid="sync-confirmed-locked">
          原请求待核对期间，重核/停用/换绑与相关输入已禁用（服务端同样拒绝新写）。
          {local
            ? localOwner.trusted
              ? ' 本地还保留一条结果未知的原请求：请在本页顶部「原请求待核对」入口核对后恢复维护。'
              : ` 本地保留的原请求${localOwner.reason ? `：${localOwner.reason}` : '归属/身份不可信'}，因此保持锁定。`
            : ''}
        </p>
      ) : null}
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>外部 SKU</th>
              <th>仓库</th>
              <th>单位</th>
              <th>状态</th>
              <th>版本</th>
              <th>确认时间</th>
              <th>理由</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {orderedMappings.map((mapping) => {
              const active = mapping.status === 'confirmed';
              const rebindState = rebind?.mappingId === mapping.id ? rebind : null;
              const targetRow = isTargetRow(mapping);
              return (
                <tr
                  key={mapping.id}
                  data-testid="sync-confirmed-mapping-row"
                  data-target={targetRow ? 'true' : undefined}
                  className={targetRow ? styles.focusRow : undefined}
                >
                  <td>
                    {mapping.externalSku}
                    {targetRow ? <span className={styles.rowSub}>目标行（从库存行定位）</span> : null}
                  </td>
                  <td>{mapping.warehouseName ?? '历史账号级默认（已停用）'}</td>
                  <td>{mapping.unit ?? '未标单位'}</td>
                  <td>
                    {currentMappingStatusLabel(mapping.status)}
                    {verificationBadge(mapping) ? <span className={styles.rowSub}>{verificationBadge(mapping)}</span> : null}
                  </td>
                  <td>第 {mapping.version} 版</td>
                  <td>{timestampOr(mapping.confirmedAt, '时间未标注')}</td>
                  <td style={{ whiteSpace: 'normal', maxWidth: '16rem' }}>{mapping.reason ?? '—'}</td>
                  <td>
                    {active ? (
                      <div className={styles.mappingTableActions}>
                        <button
                          type="button"
                          className={styles.secondaryButton}
                          onClick={() => recheck(mapping)}
                          disabled={busy !== null || writeLocked}
                          title={`重核后立即退出聚合；页面看到的版本：第 ${mapping.version} 版`}
                        >
                          重核
                        </button>
                        <button
                          type="button"
                          className={styles.secondaryButton}
                          onClick={() => disable(mapping)}
                          disabled={busy !== null || writeLocked}
                          title={`停用后立即退出聚合；页面看到的版本：第 ${mapping.version} 版`}
                        >
                          停用
                        </button>
                        <button
                          type="button"
                          className={styles.secondaryButton}
                          onClick={() => setRebind(rebindState ? null : { mappingId: mapping.id, q: '', results: [], itemId: '', itemLabel: '', unit: '' })}
                          disabled={busy !== null || writeLocked}
                        >
                          {rebindState ? '收起换绑' : '换绑'}
                        </button>
                      </div>
                    ) : (
                      <span className={styles.mappingNote}>已退出聚合；需重新确认后由下一批次采用</span>
                    )}
                    {rebindState ? (
                      <div className={styles.mappingEditor} data-testid="sync-rebind-editor">
                        <div className={styles.intervalRow}>
                          <input
                            value={rebindState.q}
                            onChange={(event) => setRebind({ ...rebindState, q: event.target.value })}
                            placeholder="货号 / 名称 / 69 编码"
                            maxLength={120}
                            aria-label={`换绑搜索目标商品 ${mapping.externalSku}`}
                            disabled={busy !== null || writeLocked}
                          />
                          <button type="button" className={styles.secondaryButton} onClick={() => searchTarget(mapping)} disabled={busy !== null || writeLocked}>
                            {busy === `search:${mapping.id}` ? '搜索中…' : '搜索'}
                          </button>
                        </div>
                        {rebindState.results.length > 0 ? (
                          <div className={styles.searchResultList}>
                            {rebindState.results.map((target) => (
                              <button
                                key={target.itemId}
                                type="button"
                                className={styles.searchResultButton}
                                onClick={() => setRebind({ ...rebindState, itemId: target.itemId, itemLabel: `${target.iceCode ?? '未编号'} · ${target.nameCn ?? '未命名商品'}` })}
                                disabled={busy !== null || writeLocked}
                              >
                                {target.iceCode ?? '未编号'} · {target.nameCn ?? '未命名商品'}
                              </button>
                            ))}
                          </div>
                        ) : null}
                        <div className={styles.intervalRow}>
                          <input
                            value={rebindState.unit}
                            onChange={(event) => setRebind({ ...rebindState, unit: event.target.value })}
                            placeholder="单位（必填）"
                            maxLength={40}
                            aria-label={`换绑单位 ${mapping.externalSku}`}
                            disabled={busy !== null || writeLocked}
                          />
                          <button
                            type="button"
                            className={styles.primaryButton}
                            onClick={() => submitRebind(mapping)}
                            disabled={busy !== null || writeLocked || !rebindState.itemId}
                          >
                            {busy === `rebind:${mapping.id}` ? '正在换绑…' : '提交换绑'}
                          </button>
                        </div>
                        <p className={styles.fieldHint}>
                          {rebindState.itemId ? `目标：${rebindState.itemLabel}` : '请先搜索并选择目标商品'} · 旧版本 第 {mapping.version} 版
                        </p>
                      </div>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <label className={styles.field} style={{ marginTop: '10px' }}>
        <span>理由（必填；重核/停用/换绑都用它）</span>
        <input
          value={reason}
          maxLength={500}
          onChange={(event) => setReason(event.target.value)}
          aria-label="对应维护理由"
          disabled={busy !== null || writeLocked}
        />
      </label>
      <p className={styles.statusMessage} data-tone={message?.tone === 'ok' ? undefined : message?.tone} role="status" aria-live="polite">
        {message?.text ?? `共 ${mappings.length} 条对应记录（含历史状态）；停用/重核不会删除历史批次或历史数量。`}
      </p>
    </div>
  );
}
