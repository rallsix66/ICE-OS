'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { AlertTriangle, CheckCircle2, X } from 'lucide-react';
import surface from '@/ui/ice-v4/data-surface.module.css';
import syncStyles from '@/features/inventory/components/sync-view.module.css';
import { useDialogFocusTrap } from '@/features/catalog/components/use-dialog-focus-trap';
import { lockPageScroll } from '@/ui/ice-v4/scroll-lock';
import styles from './shipment.module.css';
import {
  resolveShipmentGroupingReview,
  restoreShipmentGroupingJudgement,
} from '../server/actions';
import {
  GROUPING_DECISION_LABELS,
  buildLocalOverride,
  decisionSavedText,
  groupingOverrideTitle,
  groupingReviewSummary,
  mergeActiveOverrides,
} from '../grouping-review-summary';
import type {
  ShipmentGroupingActiveOverrideDto,
  ShipmentGroupingDecision,
  ShipmentGroupingReviewDto,
  ShipmentGroupingReviewTicketSide,
  ShipmentGroupingReviewsDto,
} from '../types';

function kindText(kind: 'split' | 'merge'): string {
  return kind === 'split' ? '疑似拆票' : '疑似合票';
}

/**
 * 生效中人工决定的来源识别（第十四轮）：市场 + 票号（采购单号→首张运单号→票键）+ 运单号原文。
 * 没有任何单号时写「无单号·市场」（未提供市场写「无单号」），不显示空或 UUID。
 */
function overrideTicketText(override: ShipmentGroupingActiveOverrideDto): string {
  const market = (override.market ?? '').trim();
  const ticketNo = (override.ticketNo ?? '').trim();
  const waybills = (override.waybillsText ?? '').trim();
  const marketText = market || '未提供市场';
  const ticketText = ticketNo || (market ? `无单号·${market}` : '无单号');
  const waybillPart = waybills ? ` · 运单 ${waybills}` : '';
  return `${marketText} · ${ticketText}${waybillPart}`;
}

function TicketCard({ side }: { side: ShipmentGroupingReviewTicketSide }) {
  return (
    <div className={styles.reviewTicket} data-testid="shipment-review-ticket" data-ticket-key={side.ticketKey}>
      <div className={styles.reviewTicketHead}>
        <strong>{side.ticketNo || '无单号'}</strong>
        <span>{side.market ?? '未提供'}</span>
      </div>
      {side.waybillsText || side.purchaseOrder ? (
        <p className={styles.reviewTicketMeta}>
          {[side.purchaseOrder ? `采购单 ${side.purchaseOrder}` : null,
            side.waybillsText ? `运单 ${side.waybillsText}` : null].filter(Boolean).join(' · ')}
        </p>
      ) : null}
      <ul className={styles.reviewItems}>
        {side.items.map((item) => (
          <li key={`${side.ticketKey}-${item.productNameNorm}-${item.shippedQuantity}`}>
            <span>{item.productNameRaw}</span>
            <span>{item.shippedQuantity.toLocaleString('zh-CN')}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * 「待复核」入口 + 复核弹窗（同步卡 / 物流在途页共用同一组件）。
 *
 * - count = 同步卡信息栏里的「N 项」；toolbar = 物流在途页工具栏按钮（兼容保留）；
 *   custom = 由调用方用 render prop 提供入口（例如统一「待处理」按钮），
 *   组件仍负责弹窗与数据，trigger 收到的 openModal 就是打开同一个整页居中弹窗。
 * - 弹窗相对整个浏览器视口居中，遮罩覆盖整页，标题与关闭按钮固定，正文独立滚动；
 * - 每条先用一句话说明市场、采购单/运单、上次/本次票数，下面并排显示两侧单号、商品、数量；
 * - 保存「仍然分开 / 仍是一票」（会写人工覆盖）后，立即在同一弹窗的「已有人工决定」区
 *   加入该行，可直接点「恢复按飞书判断」；保存/恢复后都刷新待复核数量与已有人工决定；
 * - 保存后说明实际采用的结论（不写死票数）；若决定已保存但货票分组更新失败，两个结果都写清楚；
 * - 关闭不写 URL，恢复打开前的滚动位置并把焦点还给入口。
 */
export function ShipmentGroupingReviewEntry({
  reviews,
  error,
  variant = 'toolbar',
  trigger,
}: {
  reviews: ShipmentGroupingReviewsDto | null;
  error: string | null;
  variant?: 'count' | 'toolbar' | 'custom';
  /** variant='custom' 时的入口渲染器：openModal 打开同一个复核弹窗，pendingCount 为待复核数。 */
  trigger?: (openModal: () => void, pendingCount: number) => ReactNode;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState<{ text: string; tone: 'ok' | 'warn' } | null>(null);
  const [savedIds, setSavedIds] = useState<string[]>([]);
  /** 本次会话刚保存、尚未随服务端 props 刷新回来的「已有人工决定」行。 */
  const [localOverrides, setLocalOverrides] = useState<ShipmentGroupingActiveOverrideDto[]>([]);
  /** 已「恢复按飞书判断」的 reviewId：立即隐藏对应行，不用等刷新。 */
  const [restoredIds, setRestoredIds] = useState<string[]>([]);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const scrollRef = useRef(0);
  const pending = (reviews?.pending ?? []).filter((review) => !savedIds.includes(review.id));
  // 服务端 props 的 activeOverrides 与本地新增行按 reviewId 去重；已恢复的立即隐藏。
  const overrides = mergeActiveOverrides(reviews?.activeOverrides ?? [], localOverrides, restoredIds);
  const localReviewIds = new Set(localOverrides.map((override) => override.reviewId));

  useDialogFocusTrap(open, '#shipment-review-dialog');

  const close = useCallback(() => {
    setOpen(false);
    setActionError('');
  }, []);

  useEffect(() => {
    if (!open) return;
    // 打开瞬间记录滚动位置与真正聚焦的入口（custom 入口拿不到 ref，用 activeElement 兜底）。
    scrollRef.current = window.scrollY;
    const triggerElement = triggerRef.current
      ?? (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null);
    closeRef.current?.focus();
    // 共享滚动锁：补滚动条宽度、支持与详情抽屉嵌套；释放时回到打开前位置。
    const releaseScrollLock = lockPageScroll();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      releaseScrollLock();
      const top = scrollRef.current;
      requestAnimationFrame(() => {
        window.scrollTo({ top, left: window.scrollX, behavior: 'auto' });
        triggerElement?.focus({ preventScroll: true });
      });
    };
  }, [open, close]);

  function openModal() {
    setActionError('');
    setNotice(null);
    setOpen(true);
  }

  /** 保存「仍然分开 / 仍是一票」后立即生成人工决定行；接受飞书原分组返回 null。 */
  function rememberOverride(review: ShipmentGroupingReviewDto, decision: ShipmentGroupingDecision) {
    const row = buildLocalOverride(review, decision, new Date());
    if (!row) return;
    setLocalOverrides((current) => [row, ...current.filter((override) => override.reviewId !== row.reviewId)]);
  }

  /** 恢复成功后：本地行立即移除，服务端行按 reviewId 立即隐藏。 */
  function forgetOverride(reviewId: string) {
    setLocalOverrides((current) => current.filter((override) => override.reviewId !== reviewId));
    setRestoredIds((current) => (current.includes(reviewId) ? current : [...current, reviewId]));
  }

  async function decide(review: ShipmentGroupingReviewDto, decision: ShipmentGroupingDecision) {
    if (busyId || savedIds.includes(review.id)) return;
    setBusyId(review.id);
    setActionError('');
    setNotice(null);
    try {
      const result = await resolveShipmentGroupingReview({ reviewId: review.id, decision });
      const actual = result.decision ?? decision;
      if (!result.ok) {
        if (result.errorCode === 'SHIPMENT_GROUPING_REINGEST_FAILED') {
          // 决定已写入，只是货票分组重新入库失败：两个结果都说明，避免用户重复确认。
          setSavedIds((current) => [...current, review.id]);
          rememberOverride(review, actual);
          setNotice({
            tone: 'warn',
            text: `${decisionSavedText(actual)}；但货票分组更新失败：${result.errorMessage ?? '原因未返回'}。待复核数量已刷新；请不要重复确认，可稍后刷新来源或重试。`,
          });
          router.refresh();
          return;
        }
        setActionError(result.errorMessage ?? '保存失败，请刷新后重试');
        return;
      }
      setSavedIds((current) => [...current, review.id]);
      rememberOverride(review, actual);
      setNotice({
        tone: 'ok',
        text: `${decisionSavedText(actual)}；待复核数量已刷新。`,
      });
      router.refresh();
    } catch {
      setActionError('保存失败：网络或传输异常');
    } finally {
      setBusyId('');
    }
  }

  async function restore(reviewId: string) {
    // 恢复不能被 savedIds 阻挡：刚保存的决定行要能当场撤销。
    if (busyId) return;
    setBusyId(reviewId);
    setActionError('');
    setNotice(null);
    try {
      const result = await restoreShipmentGroupingJudgement(reviewId, null);
      if (!result.ok) {
        if (result.errorCode === 'SHIPMENT_GROUPING_REINGEST_FAILED') {
          // 覆盖已停用，只是分组重新入库失败：行照常移除，两个结果都说明。
          forgetOverride(reviewId);
          setNotice({
            tone: 'warn',
            text: `已恢复按飞书判断；但货票分组更新失败：${result.errorMessage ?? '原因未返回'}。待复核数量已刷新；请不要重复确认，可稍后刷新来源或重试。`,
          });
          router.refresh();
          return;
        }
        setActionError(result.errorMessage ?? '恢复失败');
        return;
      }
      forgetOverride(reviewId);
      setNotice({ tone: 'ok', text: '已恢复按飞书判断；待复核数量已刷新。' });
      router.refresh();
    } catch {
      setActionError('恢复失败：网络或传输异常');
    } finally {
      setBusyId('');
    }
  }

  const entry = variant === 'custom' && trigger ? trigger(openModal, pending.length) : variant === 'count' ? (
    <button
      type="button"
      ref={triggerRef}
      className={syncStyles.factButton}
      onClick={openModal}
      data-testid="shipment-review-open"
      aria-haspopup="dialog"
      title="打开物流在途待复核"
    >
      {reviews ? `${pending.length} 项` : '—'}
    </button>
  ) : (
    <button
      type="button"
      ref={triggerRef}
      className={surface.button}
      onClick={openModal}
      data-testid="shipment-review-open"
      aria-haspopup="dialog"
    >
      待复核
      <span className={styles.reviewCountText} data-testid="shipment-review-count">{pending.length} 项</span>
    </button>
  );

  return (
    <>
      {entry}

      {open && typeof document !== 'undefined' ? createPortal((
        <div
          className={styles.reviewModalBackdrop}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) close();
          }}
          data-testid="shipment-review-backdrop"
        >
          <section
            id="shipment-review-dialog"
            className={styles.reviewModal}
            role="dialog"
            aria-modal="true"
            aria-labelledby="shipment-review-modal-title"
            data-testid="shipment-review-modal"
          >
            <header className={styles.reviewModalHead}>
              <div>
                <h2 id="shipment-review-modal-title">物流在途待复核</h2>
                <p data-testid="shipment-review-subtitle">
                  {pending.length > 0 ? `待复核 ${pending.length} 项 · 上次与本次对照` : '没有待复核'}
                </p>
              </div>
              <button
                type="button"
                ref={closeRef}
                className={styles.detailClose}
                onClick={close}
                aria-label="关闭复核"
                data-testid="shipment-review-close"
              >
                <X size={18} aria-hidden />
              </button>
            </header>

            <div className={styles.reviewModalBody}>
              {notice ? (
                <p
                  className={styles.reviewNotice}
                  data-tone={notice.tone}
                  role="status"
                  data-testid="shipment-review-notice"
                >
                  {notice.tone === 'ok' ? <CheckCircle2 size={15} aria-hidden /> : <AlertTriangle size={15} aria-hidden />}
                  <span>{notice.text}</span>
                </p>
              ) : null}

              {actionError ? (
                <p className={styles.inlineError} role="alert" data-testid="shipment-review-action-error">
                  {actionError}
                </p>
              ) : null}

              {error ? (
                <p className={styles.inlineError} role="alert" data-testid="shipment-review-error">
                  待复核读取失败：{error}
                </p>
              ) : !reviews ? (
                <p className={styles.detailEmpty}>读取中</p>
              ) : (
                <>
                  {pending.length === 0 ? (
                    <p className={styles.detailEmpty} data-testid="shipment-review-empty">没有待复核</p>
                  ) : pending.map((review) => {
                    const summary = groupingReviewSummary(review);
                    const decisions: Array<{ key: ShipmentGroupingDecision; label: string }> = review.kind === 'split'
                      ? [{ key: 'keep_one', label: GROUPING_DECISION_LABELS.keep_one }, { key: 'split_confirmed', label: GROUPING_DECISION_LABELS.split_confirmed }]
                      : [{ key: 'merge_confirmed', label: GROUPING_DECISION_LABELS.merge_confirmed }, { key: 'keep_separate', label: GROUPING_DECISION_LABELS.keep_separate }];
                    return (
                      <article
                        key={review.id}
                        className={styles.reviewCard}
                        data-testid="shipment-review-card"
                        data-review-id={review.id}
                        data-kind={review.kind}
                      >
                        <div className={styles.reviewCardHead}>
                          <strong>{kindText(review.kind)}</strong>
                          {review.createdAt ? (
                            <span className={styles.reviewCardTime}>
                              {review.createdAt.slice(0, 16).replace('T', ' ')}
                            </span>
                          ) : null}
                        </div>
                        <p className={styles.reviewSummary} data-testid="shipment-review-summary">
                          {summary.text}
                        </p>
                        <div className={styles.reviewGrid}>
                          <div className={styles.reviewSide} data-testid="shipment-review-previous">
                            <h3>上次（{summary.previousCount} 票）</h3>
                            {review.evidence.previous.tickets.map((ticket) => (
                              <TicketCard key={ticket.ticketKey} side={ticket} />
                            ))}
                          </div>
                          <div className={styles.reviewSide} data-testid="shipment-review-current">
                            <h3>本次（{summary.currentCount} 票）</h3>
                            {review.evidence.current.tickets.map((ticket) => (
                              <TicketCard key={ticket.ticketKey} side={ticket} />
                            ))}
                          </div>
                        </div>
                        <div className={styles.reviewActions}>
                          {decisions.map((entry, index) => (
                            <button
                              key={entry.key}
                              type="button"
                              className={index === 0
                                ? `${surface.button} ${surface.buttonSmall}`
                                : `${surface.buttonGhost} ${surface.buttonSmall}`}
                              onClick={() => void decide(review, entry.key)}
                              disabled={busyId === review.id || savedIds.includes(review.id)}
                              data-testid={`shipment-review-decide-${entry.key}`}
                            >
                              {entry.label}
                            </button>
                          ))}
                        </div>
                      </article>
                    );
                  })}

                  {overrides.length > 0 ? (
                    <section className={styles.reviewOverrides} data-testid="shipment-review-overrides">
                      <h3>已有人工决定</h3>
                      {overrides.map((override) => {
                        const isLocal = localReviewIds.has(override.reviewId) && !(reviews?.activeOverrides ?? [])
                          .some((server) => server.reviewId === override.reviewId);
                        return (
                          <div
                            key={override.id}
                            className={styles.reviewOverrideRow}
                            data-testid="shipment-review-override"
                            data-review-id={override.reviewId}
                            data-decision={override.decision ?? ''}
                            data-source={isLocal ? 'local' : 'server'}
                            data-market={override.market ?? ''}
                            data-ticket-no={override.ticketNo ?? ''}
                            data-waybills={override.waybillsText ?? ''}
                          >
                            <div className={styles.reviewOverrideInfo}>
                              <strong>{groupingOverrideTitle(override)}</strong>
                              <span className={styles.reviewOverrideMeta} data-testid="shipment-review-override-ticket">
                                {overrideTicketText(override)}
                              </span>
                              {override.createdAt ? (
                                <span className={styles.reviewOverrideTime}>
                                  {override.createdAt.slice(0, 16).replace('T', ' ')}
                                </span>
                              ) : null}
                            </div>
                            <button
                              type="button"
                              className={`${surface.buttonGhost} ${surface.buttonSmall}`}
                              onClick={() => void restore(override.reviewId)}
                              disabled={busyId === override.reviewId}
                              data-testid="shipment-review-restore"
                            >
                              {busyId === override.reviewId ? '恢复中' : '恢复按飞书判断'}
                            </button>
                          </div>
                        );
                      })}
                    </section>
                  ) : null}
                </>
              )}
            </div>
          </section>
        </div>
      ), document.body) : null}
    </>
  );
}
