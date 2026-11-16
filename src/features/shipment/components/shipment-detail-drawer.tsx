'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { X } from 'lucide-react';
import { Disclosure } from '@/ui/ice-v4/data-surface';
import demoStyles from '@/ui/ice-v4/ice-v4.module.css';
import surface from '@/ui/ice-v4/data-surface.module.css';
import { DetailTabs } from '@/ui/ice-v4/detail-tabs';
import styles from './shipment.module.css';
import {
  associationSavedNotice,
  changedFieldsText,
  formatQuantity,
  formatQuantityOr,
  formatTimestamp,
  identityPending,
  manualRevisionActionLabel,
  manualStatusLabel,
  marketText,
  noteText,
  purchaseOrderText,
  receivedDisplay,
  remainingDisplay,
  shipmentStatusLabel,
  shipmentStatusTone,
  sourceFieldText,
  summaryValueText,
  ticketTitle,
  waybillsText,
} from '../model';
import type { ShipmentDetailDto, ShipmentDetailItemDto } from '../types';
import { ShipmentAssociationEditor } from './association-editor';
import { ShipmentManualCorrectionDialog } from './shipment-manual-correction-dialog';
import { restoreShipmentItemSourceJudgement } from '../server/actions';
import { lockPageScroll } from '@/ui/ice-v4/scroll-lock';

function manualResultErrorText(result: { errorCode: string | null; errorMessage: string | null }): string {
  const code = result.errorCode ?? '';
  const message = result.errorMessage ?? '';
  if (code && message) return `恢复失败（${code}）：${message}`;
  if (code) return `恢复失败（${code}）`;
  if (message) return `恢复失败：${message}`;
  return '恢复失败，请重试';
}

/**
 * 货票详情弹窗（ICE v4 共用详情样式：detailDialog / detailHeader / detailBody / table / detailList）。
 *
 * 口径（详见 docs/tasks/shipment-in-transit-v1.md §16–§20，页面不再常驻解释）：
 * - 标题 = 采购单号 → 第一张运单号 → 「无单号货票」；
 * - 状态 = 含人工修正的有效票级状态；「本票在途货值」与状态摘要同一行，只在正文出现一次；
 * - 当前明细可关联/修正在途；人工修正显示状态/修改人/时间与待复核提示；
 * - 本次来源未见的历史明细只读；人工修正记录与最近变更记录折叠展示；
 * - 从汇总带 ?item=<uuid> 打开时高亮并滚动到该明细（不自动保存/不自动打开弹窗）。
 */
export function ShipmentDetailDrawer({
  detail,
  detailError,
  loading,
  focusItemId = '',
  onClose,
}: {
  detail: ShipmentDetailDto | null;
  detailError: string | null;
  /** 刚点开、服务端详情还没返回时为 true（显示读取中，不显示空态）。 */
  loading: boolean;
  /** 从汇总带过来的明细 id：高亮并滚动到该行。 */
  focusItemId?: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [editingItemId, setEditingItemId] = useState('');
  /** 关联保存后的结果提示（已关联商品 + 该条实际去向）。 */
  const [assocNotice, setAssocNotice] = useState('');
  const [correctingItemId, setCorrectingItemId] = useState('');
  const [restoreItemId, setRestoreItemId] = useState('');
  const [rowError, setRowError] = useState('');
  /** R15：货票详情｜变更记录；换票回到「货票详情」，切页签回到正文顶部。 */
  const [tab, setTab] = useState<'detail' | 'changes'>('detail');
  const shipmentKey = detail?.shipment?.shipmentId ?? '';
  const [tabForShipment, setTabForShipment] = useState(shipmentKey);
  if (tabForShipment !== shipmentKey) {
    /* 换了一张货票：同一次渲染内复位页签，避免 effect 里 setState 造成级联渲染。 */
    setTabForShipment(shipmentKey);
    setTab('detail');
  }

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
  }, [tab]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // 修正在途弹窗打开时，Esc 只关弹窗（弹窗自己监听），不把详情一起关掉。
      if (correctingItemId) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    // 用共享 lockPageScroll：补滚动条宽度（避免整页横向跳动）、支持嵌套、关闭后回到原滚动位置。
    const releaseScrollLock = lockPageScroll();
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      releaseScrollLock();
    };
  }, [onClose, correctingItemId]);

  const shipment = detail?.shipment ?? null;
  const items = detail?.items ?? [];
  const missingItems = detail?.missingItems ?? [];
  const revisions = detail?.revisions ?? [];
  const manualRevisions = detail?.manualRevisions ?? [];
  const editingItem = editingItemId ? items.find((item) => item.itemId === editingItemId) ?? null : null;
  const correctingItem = correctingItemId ? items.find((item) => item.itemId === correctingItemId) ?? null : null;
  const identityWaiting = identityPending(shipment?.identityStatus);
  const absent = shipment ? !shipment.presentInLatestRead : false;
  const manualCount = shipment?.manualCorrectionCount ?? 0;
  // 详情与列表/筛选/计数使用同一个有效状态（manual index 读取失败时回退原表状态）。
  const effectiveClass = shipment ? shipment.effectiveStatusClass : null;
  const statusToShow = effectiveClass ?? shipment?.statusClass ?? null;
  // 本票在途货值（第十三轮）：逐条当前有效剩余 × 商品库采用进货价；一条都算不出写「暂无法计算」。
  const ticketValue = detail?.ticketValue ?? null;
  const ticketValueText = ticketValue === null
    ? ''
    : ticketValue.pricedItemCount === 0
      ? '暂无法计算'
      : summaryValueText(ticketValue.totalValueCny) ?? '暂无法计算';

  // 从汇总定位到某条明细：只高亮 + 滚动，不自动保存、不自动打开弹窗。
  useEffect(() => {
    if (!focusItemId || items.length === 0) return;
    const selector = `[data-testid="shipment-item-row"][data-item-id="${focusItemId}"]`;
    const row = document.querySelector<HTMLElement>(selector);
    row?.scrollIntoView({ block: 'center' });
  }, [focusItemId, items.length]);

  async function restoreItem(item: ShipmentDetailItemDto) {
    if (restoreItemId) return;
    setRestoreItemId(item.itemId);
    setRowError('');
    try {
      const result = await restoreShipmentItemSourceJudgement({
        itemId: item.itemId,
        restore: true,
        status: item.manualStatus ?? 'unknown',
        cumulativeShelved: null,
        expectedManualRevision: item.manualRevision,
      });
      if (!result.ok) {
        setRowError(manualResultErrorText(result));
        return;
      }
      router.refresh();
    } catch {
      setRowError('恢复失败：网络或传输异常，未保存');
    } finally {
      setRestoreItemId('');
    }
  }

  return (
    <div
      className={styles.detailBackdrop}
      data-testid="shipment-detail-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="shipment-detail-title"
        className={`${demoStyles.detailDialog} ${styles.detailDialog}`}
        data-testid="shipment-detail-drawer"
      >
        <header className={demoStyles.detailHeader}>
          <div>
            <h2
              id="shipment-detail-title"
              data-slot="dialog-title"
              data-testid="shipment-detail-title"
              className={styles.detailTitle}
            >
              {shipment ? ticketTitle(shipment.purchaseOrder, shipment.waybillsText) : '货票详情'}
            </h2>
          </div>
          <button
            type="button"
            ref={closeRef}
            className={demoStyles.iconButton}
            aria-label="关闭货票详情"
            data-testid="shipment-detail-close"
            onClick={onClose}
          >
            <X size={18} aria-hidden />
          </button>
        </header>

        <DetailTabs
          tabs={[{ key: 'detail', label: '货票详情' }, { key: 'changes', label: '变更记录' }] as const}
          active={tab}
          onSelect={(key) => setTab(key === 'changes' ? 'changes' : 'detail')}
          ariaLabel="货票详情分区"
          idPrefix="shipment-detail-tab"
          panelIdPrefix="shipment-detail-panel"
          testIdPrefix="shipment-detail-tab"
        />

        <div ref={bodyRef} className={`${demoStyles.detailBody} ${styles.detailBody}`}>
          {tab === 'detail' ? (
            <div role="tabpanel" id="shipment-detail-panel-detail" aria-labelledby="shipment-detail-tab-detail" data-testid="shipment-detail-panel">
          {loading ? (
            <p className={styles.detailEmpty} data-testid="shipment-detail-loading">正在读取货票…</p>
          ) : detailError ? (
            <>
              <p className={styles.inlineError} role="alert" data-testid="shipment-detail-error">{detailError}</p>
              <div className={styles.detailActionsRow}>
                <button
                  type="button"
                  className={`${surface.button} ${surface.buttonSmall}`}
                  onClick={() => router.refresh()}
                  data-testid="shipment-detail-retry"
                >
                  重试
                </button>
              </div>
            </>
          ) : !shipment ? (
            <>
              <p className={styles.detailEmpty} data-testid="shipment-detail-missing">
                没有找到该货票（可能已不在当前来源）
              </p>
              <div className={`${styles.detailActionsRow} ${styles.detailActionsCenter}`}>
                <button
                  type="button"
                  className={`${surface.button} ${surface.buttonSmall}`}
                  onClick={onClose}
                  data-testid="shipment-detail-back"
                >
                  返回列表
                </button>
              </div>
            </>
          ) : (
            <>
              <div className={styles.detailStatusLine} data-testid="shipment-detail-status">
                <span className={styles.statusCellLine}>
                  <span className={styles.statusDot} data-tone={shipmentStatusTone(statusToShow)} aria-hidden />
                  {shipmentStatusLabel(statusToShow)}
                </span>
                {manualCount > 0 ? (
                  <span className={styles.manualChip} data-testid="shipment-detail-manual-status">
                    含人工修正（{manualCount} 条）
                  </span>
                ) : null}
                {shipment.quantityPending ? <span className={styles.pendingChip}>数量待核</span> : null}
                {identityWaiting ? <span className={styles.identityChip}>身份待核</span> : null}
                {absent ? <span className={styles.absentChip}>本次来源未见</span> : null}
                {ticketValue ? (
                  <span className={styles.detailValueInline} data-testid="shipment-detail-ticket-value">
                    本票在途货值 <strong>{ticketValueText}</strong>
                    {ticketValue.excludedItemCount > 0 ? ` · ${ticketValue.excludedItemCount} 条未计入` : ''}
                  </span>
                ) : null}
              </div>

              {identityWaiting ? (
                <p className={styles.identityNotice} role="status" data-testid="shipment-detail-identity">
                  身份待核{shipment.identityNote ? `：${shipment.identityNote}` : ''}
                </p>
              ) : null}

              {absent ? (
                <p className={styles.absentNotice} role="status" data-testid="shipment-detail-absent">
                  本次来源未见 · 最后出现 {formatTimestamp(shipment.lastSeenAt) || '—'}
                </p>
              ) : null}

              <dl className={`${demoStyles.detailList} ${styles.drawerFacts}`} data-testid="shipment-detail-facts">
                <div><dt>目的市场</dt><dd>{marketText(shipment.market)}</dd></div>
                <div><dt>采购单号</dt><dd data-testid="shipment-detail-purchase-order">{purchaseOrderText(shipment.purchaseOrder)}</dd></div>
                <div><dt>运单号</dt><dd data-testid="shipment-detail-waybills">{waybillsText(shipment.waybillsText)}</dd></div>
                <div><dt>报关方式</dt><dd>{shipment.customsMethod || '—'}</dd></div>
                <div><dt>船名</dt><dd>{shipment.vessel || '—'}</dd></div>
                <div><dt>发出时间</dt><dd>{shipment.dispatchedText || '—'}</dd></div>
                <div><dt>物流情况</dt><dd data-testid="shipment-detail-transport">{noteText(shipment.transportText)}</dd></div>
                <div><dt>预计到货时间</dt><dd data-testid="shipment-detail-arrival">{noteText(shipment.arrivalText)}</dd></div>
                <div><dt>首次见到</dt><dd>{formatTimestamp(shipment.firstSeenAt) || '—'}</dd></div>
                <div><dt>最后见到</dt><dd>{formatTimestamp(shipment.lastSeenAt) || '—'}</dd></div>
                <div><dt>明细条数</dt><dd>当前 {items.length} 条{missingItems.length > 0 ? ` · 本次未见 ${missingItems.length} 条` : ''}</dd></div>
              </dl>

              <h3 className={`${demoStyles.smallHeading} ${styles.drawerSectionTitle}`}>当前明细</h3>
              <div className={`${demoStyles.tableScroll} ${styles.itemsTableWrap} ${styles.drawerTableWrap}`}>
                <table className={`${demoStyles.table} ${styles.itemsTable} ${styles.drawerTable}`} data-testid="shipment-items-table">
                  <thead>
                    <tr>
                      <th scope="col">来源商品</th>
                      <th scope="col">来源 SKU</th>
                      <th scope="col">关联 ICE 商品</th>
                      <th scope="col">规格 / 单位</th>
                      <th scope="col">单位成本</th>
                      <th scope="col">发货量</th>
                      <th scope="col">累计到货</th>
                      <th scope="col">剩余在途</th>
                      <th scope="col">来源备注</th>
                      <th scope="col">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.length === 0 ? (
                      <tr>
                        <td colSpan={10} className={styles.itemProductSub}>本次来源没有当前明细</td>
                      </tr>
                    ) : items.map((item) => {
                      const received = receivedDisplay(item);
                      const remaining = remainingDisplay(item);
                      const focused = focusItemId !== '' && item.itemId === focusItemId;
                      return (
                        <tr
                          key={item.itemId}
                          data-testid="shipment-item-row"
                          data-item-key={item.itemKey}
                          data-item-id={item.itemId}
                          data-product-id={item.product?.itemId ?? undefined}
                          data-focused={focused ? 'true' : undefined}
                          className={focused ? styles.focusedItemRow : undefined}
                        >
                          <td><span className={styles.itemName}>{item.productNameRaw}</span></td>
                          <td className={styles.itemProductSub}>{sourceFieldText(item.sourceSku)}</td>
                          <td>
                            {item.product ? (
                              <>
                                <span className={styles.itemProduct}>{item.product.iceCode ?? '待补货号'}</span>
                                <span className={styles.itemProductSub}>
                                  {item.product.nameCn ?? '—'}
                                  {item.associationStatus === 'auto' ? ' · 自动关联' : ''}
                                </span>
                              </>
                            ) : (
                              <span className={styles.itemProductSub}>未关联</span>
                            )}
                          </td>
                          <td data-testid="shipment-item-spec-unit">
                            {item.product ? (
                              <>
                                <span className={styles.itemProductSub} data-testid="shipment-item-specification">
                                  {item.product.specificationText ? `规格 ${item.product.specificationText}` : '规格待补'}
                                </span>
                                <span className={styles.itemProductSub} data-testid="shipment-item-unit">
                                  {item.product.unitText ? `单位 ${item.product.unitText}` : '单位 待确认'}
                                </span>
                              </>
                            ) : (
                              <span className={styles.itemProductSub}>—</span>
                            )}
                          </td>
                          <td data-testid="shipment-item-unit-cost">
                            {item.product ? (
                              <>
                                <span
                                  className={item.product.unitCost.state === 'priced' ? styles.unitCostPriced : styles.unitCostMissing}
                                  data-testid="shipment-item-unit-cost-label"
                                >
                                  {item.product.unitCost.label}
                                </span>
                                {item.product.unitCost.state === 'missing' && item.product.unitCost.reason ? (
                                  <span className={styles.unitCostReason}>{item.product.unitCost.reason}</span>
                                ) : null}
                              </>
                            ) : (
                              <span className={styles.itemProductSub}>—</span>
                            )}
                          </td>
                          <td className={styles.numCell} data-testid="shipment-item-shipped">
                            {formatQuantityOr(item.shippedQuantity)}
                          </td>
                          <td className={styles.numCell} data-testid="shipment-item-received">
                            {received.text}
                            {received.pending ? <span className={styles.pendingChip}>待核</span> : null}
                            {item.manualStatus ? (
                              <span className={styles.manualBadge} data-testid="shipment-item-manual-badge">
                                人工修正 · {manualStatusLabel(item.manualStatus)}
                                {item.manualShelvedQuantity !== null ? `（累计已上架 ${formatQuantity(item.manualShelvedQuantity)}）` : ''}
                                {item.manualActorName ? ` · ${item.manualActorName}` : ''}
                                {item.manualAt ? ` · ${formatTimestamp(item.manualAt)}` : ''}
                              </span>
                            ) : null}
                            {item.manualReviewNeeded && !item.manualConflict ? (
                              <span className={styles.manualReviewChip} data-testid="shipment-item-manual-review">
                                待复核
                              </span>
                            ) : null}
                            {item.manualConflict ? (
                              <span className={styles.manualConflictNotice} data-testid="shipment-item-manual-conflict">
                                待复核 · 原表 {formatQuantityOr(item.manualShippedQuantity)} → {formatQuantityOr(item.shippedQuantity)}
                                {item.previousConfirmedShelvedQuantity === null
                                  ? ''
                                  : ` · 已确认上架 ${formatQuantity(item.previousConfirmedShelvedQuantity)}`}
                              </span>
                            ) : null}
                          </td>
                          <td className={styles.numCell} data-testid="shipment-item-remaining">
                            {remaining.text}
                            {remaining.pending ? <span className={styles.pendingChip}>待核</span> : null}
                          </td>
                          <td className={styles.itemProductSub}>{noteText(item.sourceNote)}</td>
                          <td>
                            <span className={styles.itemActions}>
                              <button
                                type="button"
                                className={`${surface.button} ${surface.buttonSmall}`}
                                onClick={() => setCorrectingItemId(item.itemId)}
                                data-testid="shipment-item-correct"
                              >
                                修正在途
                              </button>
                              {item.manualStatus ? (
                                <button
                                  type="button"
                                  className={`${surface.button} ${surface.buttonSmall}`}
                                  onClick={() => void restoreItem(item)}
                                  disabled={restoreItemId === item.itemId}
                                  data-testid="shipment-item-manual-restore"
                                >
                                  恢复按原表
                                </button>
                              ) : null}
                              {item.product ? (
                                <>
                                  <button
                                    type="button"
                                    className={`${surface.button} ${surface.buttonSmall}`}
                                    onClick={() => setEditingItemId(item.itemId)}
                                    data-testid="shipment-item-change"
                                  >
                                    更换
                                  </button>
                                  <button
                                    type="button"
                                    className={`${surface.button} ${surface.buttonSmall}`}
                                    onClick={() => setEditingItemId(item.itemId)}
                                    data-testid="shipment-item-clear"
                                  >
                                    清除
                                  </button>
                                </>
                              ) : (
                                <button
                                  type="button"
                                  className={`${surface.button} ${surface.buttonSmall}`}
                                  onClick={() => setEditingItemId(item.itemId)}
                                  data-testid="shipment-item-associate"
                                >
                                  关联商品
                                </button>
                              )}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {rowError ? (
                <p className={styles.manualError} role="alert" data-testid="shipment-manual-row-error">{rowError}</p>
              ) : null}

              {assocNotice ? (
                <p className={styles.manualSaved} role="status" data-testid="shipment-assoc-saved-notice">{assocNotice}</p>
              ) : null}

              {editingItem ? (
                <ShipmentAssociationEditor
                  key={editingItem.itemId}
                  item={{
                    itemId: editingItem.itemId,
                    shipmentId: shipment?.shipmentId ?? null,
                    productNameRaw: editingItem.productNameRaw,
                    product: editingItem.product,
                    revision: editingItem.revision,
                  }}
                  onCancel={() => setEditingItemId('')}
                  onSaved={(payload) => {
                    setEditingItemId('');
                    setAssocNotice(associationSavedNotice(payload));
                    router.refresh();
                  }}
                />
              ) : null}

              {missingItems.length > 0 ? (
                <Disclosure
                  summary="本次来源未见的历史明细"
                  count={`${missingItems.length} 条`}
                  defaultOpen={false}
                  testId="shipment-missing-items"
                  tone="warn"
                >
                  <div className={`${demoStyles.tableScroll} ${styles.itemsTableWrap} ${styles.drawerTableWrap}`}>
                    <table className={`${demoStyles.table} ${styles.itemsTable} ${styles.drawerTable} ${styles.historyTable}`} data-testid="shipment-missing-items-table">
                      <thead>
                        <tr>
                          <th scope="col">来源商品</th>
                          <th scope="col">关联 ICE 商品</th>
                          <th scope="col">发货量</th>
                          <th scope="col">最后出现</th>
                          <th scope="col">原备注</th>
                        </tr>
                      </thead>
                      <tbody>
                        {missingItems.map((item) => (
                          <tr key={item.itemId} data-testid="shipment-missing-item-row" data-item-key={item.itemKey}>
                            <td><span className={styles.itemName}>{item.productNameRaw}</span></td>
                            <td>
                              {item.product ? (
                                <>
                                  <span className={styles.itemProduct}>{item.product.iceCode ?? '待补货号'}</span>
                                  <span className={styles.itemProductSub}>{item.product.nameCn ?? '—'}</span>
                                </>
                              ) : (
                                <span className={styles.itemProductSub}>未关联</span>
                              )}
                            </td>
                            <td className={styles.numCell}>{formatQuantityOr(item.shippedQuantity)}</td>
                            <td className={styles.numCell}>{formatTimestamp(item.lastSeenAt) || '—'}</td>
                            <td className={styles.itemProductSub}>{noteText(item.sourceNote)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Disclosure>
              ) : null}
            </>
          )}
            </div>
          ) : (
            <div role="tabpanel" id="shipment-detail-panel-changes" aria-labelledby="shipment-detail-tab-changes" data-testid="shipment-changes-panel">
              {loading ? (
                <p className={styles.detailEmpty} data-testid="shipment-changes-loading">正在读取货票…</p>
              ) : !shipment ? (
                <p className={styles.detailEmpty} data-testid="shipment-changes-empty">暂无变更记录</p>
              ) : (
                <>
                  <h3 className={`${demoStyles.smallHeading} ${styles.drawerSectionTitle}`}>人工修正记录</h3>
                  {manualRevisions.length === 0 ? (
                    <p className={styles.detailNote} data-testid="shipment-manual-history-empty">暂无人工修正记录</p>
                  ) : (
                    <ul className={styles.revisionList} data-testid="shipment-manual-history-list">
                      {manualRevisions.map((revision) => (
                        <li key={`${revision.itemId}-${revision.revision}-${revision.recordedAt}`}>
                          <span className={styles.revisionMeta}>
                            #{revision.revision} · {formatTimestamp(revision.recordedAt) || '—'} · {manualRevisionActionLabel(revision.action)}
                          </span>
                          <span>
                            {revision.productNameRaw}：
                            {revision.manualStatus ? manualStatusLabel(revision.manualStatus) : '恢复原表判断'}
                            {revision.manualShelvedQuantity !== null ? `（累计已上架 ${formatQuantity(revision.manualShelvedQuantity)}）` : ''}
                            {' · '}累计到货 {revision.receivedQuantity === null ? '未提供' : formatQuantity(revision.receivedQuantity)}
                            {' · '}剩余在途 {revision.remainingQuantity === null ? '未提供' : formatQuantity(revision.remainingQuantity)}
                            {revision.actorName ? ` · ${revision.actorName}` : ''}
                            {revision.note ? ` · ${revision.note}` : ''}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}

                  <h3 className={`${demoStyles.smallHeading} ${styles.drawerSectionTitle}`}>最近变更记录</h3>
                  {revisions.length === 0 ? (
                    <p className={styles.detailNote} data-testid="shipment-revision-empty">暂无变更记录</p>
                  ) : (
                    <ul className={styles.revisionList} data-testid="shipment-revision-list">
                      {revisions.map((revision, index) => (
                        <li key={`${revision.revision}-${revision.recordedAt}-${index}`}>
                          <span className={styles.revisionMeta}>#{revision.revision} · {formatTimestamp(revision.recordedAt) || '—'}</span>
                          <span>变更：{changedFieldsText(revision.changedFields)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        {correctingItem ? (
          <ShipmentManualCorrectionDialog
            item={correctingItem}
            onClose={() => setCorrectingItemId('')}
            onSaved={() => {
              setCorrectingItemId('');
              router.refresh();
            }}
          />
        ) : null}
      </div>
    </div>
  );
}
