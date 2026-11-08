'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { X } from 'lucide-react';
import surface from '@/ui/ice-v4/data-surface.module.css';
import styles from './shipment.module.css';
import {
  resolveShipmentGroupingReview,
  restoreShipmentGroupingJudgement,
} from '../server/actions';
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

function kindHint(kind: 'split' | 'merge'): string {
  return kind === 'split' ? '上次一票，本次分成两票' : '上次两票，本次合成一票';
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
 * 工具栏「待复核」入口 + 本页弹窗（第十三轮）。
 *
 * - 待确认数量只算 pending 拆合票事项；没有待办时按钮仍可打开，查看/恢复已有人工决定；
 * - 弹窗并排显示上次与本次的单号、商品、数量，四个结论与「恢复按飞书判断」都在弹窗内；
 * - 弹窗只是本页浮层，不写 URL：关闭后市场、筛选、页码和列表位置保持原样。
 */
export function ShipmentGroupingReviewEntry({
  reviews,
  error,
}: {
  reviews: ShipmentGroupingReviewsDto | null;
  error: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState('');
  const [actionError, setActionError] = useState('');
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const pending = reviews?.pending ?? [];
  const overrides = reviews?.activeOverrides ?? [];

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const previousOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.documentElement.style.overflow = previousOverflow;
    };
  }, [open]);

  async function decide(review: ShipmentGroupingReviewDto, decision: ShipmentGroupingDecision) {
    if (busyId) return;
    setBusyId(review.id);
    setActionError('');
    try {
      const result = await resolveShipmentGroupingReview({ reviewId: review.id, decision });
      if (!result.ok) {
        setActionError(result.errorMessage ?? '保存失败，请刷新后重试');
        return;
      }
      router.refresh();
    } catch {
      setActionError('保存失败：网络或传输异常');
    } finally {
      setBusyId('');
    }
  }

  async function restore(reviewId: string) {
    if (busyId) return;
    setBusyId(reviewId);
    setActionError('');
    try {
      const result = await restoreShipmentGroupingJudgement(reviewId, null);
      if (!result.ok) {
        setActionError(result.errorMessage ?? '恢复失败');
        return;
      }
      router.refresh();
    } catch {
      setActionError('恢复失败：网络或传输异常');
    } finally {
      setBusyId('');
    }
  }

  return (
    <>
      <button
        type="button"
        className={surface.button}
        onClick={() => setOpen(true)}
        data-testid="shipment-review-open"
        aria-haspopup="dialog"
      >
        待复核
        {pending.length > 0 ? (
          <span className={styles.reviewCountBadge} data-testid="shipment-review-count">{pending.length}</span>
        ) : null}
      </button>

      {open ? (
        <div
          className={styles.reviewModalBackdrop}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <section
            className={styles.reviewModal}
            role="dialog"
            aria-modal="true"
            aria-labelledby="shipment-review-modal-title"
            data-testid="shipment-review-modal"
          >
            <header className={styles.reviewModalHead}>
              <div>
                <h2 id="shipment-review-modal-title">拆票 / 合票复核</h2>
                <p>{pending.length > 0 ? `待确认 ${pending.length} 项` : '没有待复核'}</p>
              </div>
              <button
                type="button"
                ref={closeRef}
                className={styles.detailClose}
                onClick={() => setOpen(false)}
                aria-label="关闭复核"
                data-testid="shipment-review-close"
              >
                <X size={18} aria-hidden />
              </button>
            </header>

            {error ? (
              <p className={styles.inlineError} role="alert" data-testid="shipment-review-error">
                待复核读取失败：{error}
              </p>
            ) : !reviews ? (
              <p className={styles.detailEmpty}>读取中</p>
            ) : (
              <div className={styles.reviewModalBody}>
                {actionError ? <p className={styles.inlineError} role="alert">{actionError}</p> : null}
                {pending.length === 0 ? (
                  <p className={styles.detailEmpty} data-testid="shipment-review-empty">没有待复核</p>
                ) : pending.map((review) => {
                  const decisions: Array<{ key: ShipmentGroupingDecision; label: string }> = review.kind === 'split'
                    ? [{ key: 'keep_one', label: '仍是一票' }, { key: 'split_confirmed', label: '确实拆开' }]
                    : [{ key: 'merge_confirmed', label: '确实合成一票' }, { key: 'keep_separate', label: '仍然分开' }];
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
                        <span>{kindHint(review.kind)}</span>
                        {review.createdAt ? (
                          <span className={styles.reviewCardTime}>
                            {review.createdAt.slice(0, 16).replace('T', ' ')}
                          </span>
                        ) : null}
                      </div>
                      <div className={styles.reviewGrid}>
                        <div className={styles.reviewSide} data-testid="shipment-review-previous">
                          <h3>上次怎么分</h3>
                          {review.evidence.previous.tickets.map((ticket) => (
                            <TicketCard key={ticket.ticketKey} side={ticket} />
                          ))}
                        </div>
                        <div className={styles.reviewSide} data-testid="shipment-review-current">
                          <h3>本次怎么分</h3>
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
                            disabled={busyId === review.id}
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
                      const decidedText = override.reviewKind === 'split' ? '按一票处理' : '按分开处理';
                      return (
                        <div
                          key={override.id}
                          className={styles.reviewOverrideRow}
                          data-testid="shipment-review-override"
                          data-market={override.market ?? ''}
                          data-ticket-no={override.ticketNo ?? ''}
                          data-waybills={override.waybillsText ?? ''}
                        >
                          <div className={styles.reviewOverrideInfo}>
                            <strong>{decidedText}</strong>
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
              </div>
            )}
          </section>
        </div>
      ) : null}
    </>
  );
}
