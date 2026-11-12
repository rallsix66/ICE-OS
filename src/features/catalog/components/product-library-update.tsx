'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertTriangle, ArrowRight, CheckCircle2, Loader2, NotebookTabs, RefreshCw, X } from 'lucide-react';
import { DetailTabs } from '@/ui/ice-v4/detail-tabs';
import demoStyles from '@/ui/ice-v4/ice-v4.module.css';
import syncStyles from '@/features/inventory/components/sync-view.module.css';
import { StatusPill } from '@/features/inventory/components/display';
import type { Tone } from '@/features/inventory/model';
import { useDialogFocusTrap } from './use-dialog-focus-trap';
import {
  applyProductSourceAction,
  assignProductSourceCodeAction,
  decideDuplicateSourceRowAction,
  readProductSourceNowAction,
} from '../product-source/actions';
import type { ProductSourcePanelDto } from '../product-source/panel-types';
import { PARTIAL_WRITTEN_NOTICE, receiptSentence } from '../product-source/receipt-copy';
import styles from './product-library-update.module.css';

type ProductSourceIssue = ProductSourcePanelDto['issues'][number];
type TabKey = 'changes' | 'issues' | 'history';

const TABS = [
  { key: 'changes', label: '本次更新' },
  { key: 'issues', label: '待人工确认' },
  { key: 'history', label: '采用记录' },
] as const;

type AppliedReceipt = {
  message: string;
  status?: string;
  receiptStatus?: string;
  counts?: {
    created: number;
    updated: number;
    unchanged: number;
    needsReview: number;
    failed: number;
    missing: number;
  } | null;
  writtenItems?: number | null;
  writtenNeedsReview?: number | null;
};

/** 回执标题：按数据库实际状态区分完成/部分完成/失败/重复采用/旧快照/原请求核对。 */
function receiptTitle(status: string | undefined): string {
  if (status === 'partial') return '本批部分完成';
  if (status === 'failed') return '本批未改商品资料';
  if (status === 'duplicate') return '重复采用';
  if (status === 'rejected_stale') return '旧快照已拒绝';
  if (status === 'reconciled') return '已核对原请求';
  return '本次更新完成';
}

function receiptTone(status: string | undefined): 'ok' | 'warn' | 'error' {
  if (status === 'failed') return 'error';
  if (status === 'partial' || status === 'rejected_stale') return 'warn';
  return 'ok';
}

/**
 * 实际回执结果：只显示一套数字。
 * counts 存在时用 receiptSentence 渲染（数字全部来自数据库回执，writtenItems 缺失显示「—」）；
 * counts 缺失时只显示结果说明，不补 0。服务端 message 在带 counts 时已不再内嵌数字。
 */
function AppliedReceiptBox({ entry }: { entry: AppliedReceipt }) {
  const tone = receiptTone(entry.status);
  const counts = entry.counts ?? null;
  const sentence = receiptSentence({
    counts,
    writtenItems: entry.writtenItems ?? null,
    writtenNeedsReview: entry.writtenNeedsReview ?? null,
    status: entry.receiptStatus ?? entry.status ?? null,
  });
  const title = entry.status ? receiptTitle(entry.status) : '更新结果';
  // 数据库回执为 partial（含核对到原请求时）：先说明已确认字段已写入、待核对字段保留原值。
  const partial = (entry.receiptStatus ?? entry.status) === 'partial';
  // 服务端 message 开头可能重复状态前缀；标题已说明状态时不再重复一次。
  const message = entry.message.replace(
    /^(本次更新完成|本批处理完成|本批部分完成|本批未改商品资料|重复采用|该快照早于最近成功批次，已拒绝，未覆盖新结果)[：:；;]\s*/,
    '',
  ) || entry.message;
  const reviewRegistered = counts !== null
    && counts.needsReview > 0
    && entry.status !== 'duplicate'
    && entry.status !== 'reconciled';
  return (
    <div className={styles.receiptBox} data-tone={tone} role="status" data-testid="product-library-applied-result" data-status={entry.status ?? ''}>
      {tone === 'ok' ? <CheckCircle2 size={17} aria-hidden /> : <AlertTriangle size={17} aria-hidden />}
      <div className={styles.receiptBody}>
        <strong data-testid="product-library-receipt-title">{title}</strong>
        {partial ? (
          <p className={styles.receiptHint} data-testid="product-library-receipt-partial">
            {PARTIAL_WRITTEN_NOTICE}
          </p>
        ) : null}
        <p>{message}</p>
        {sentence ? (
          <p className={styles.receiptCounts} data-testid="product-library-receipt-counts">
            {sentence}
          </p>
        ) : null}
        {reviewRegistered ? (
          <p className={styles.receiptHint} data-testid="product-library-receipt-registered">
            需核对事项已登记到商品库「待处理」，数量和结果以实际回执为准。
          </p>
        ) : null}
      </div>
    </div>
  );
}

function statusOf(dto: ProductSourcePanelDto | null): { label: string; tone: Tone } {
  if (!dto) return { label: '读取失败', tone: 'red' };
  if (dto.read.lastResultLabel === '读取失败' || dto.schedule?.errorLabel) return { label: '读取失败', tone: 'red' };
  if (dto.preview?.canApply) return { label: '有更新待确认', tone: 'amber' };
  if (dto.applied) return { label: '已是最新', tone: 'green' };
  if (dto.read.lastReadAtDisplay) return { label: '已读取', tone: 'blue' };
  return { label: '未读取', tone: 'neutral' };
}

function displayValue(value: string): string {
  return value.trim() ? value : '（空）';
}

function itemTitle(entry: { iceCode: string | null; nameCn: string | null }): string {
  if (entry.iceCode) return entry.nameCn ? `${entry.iceCode} · ${entry.nameCn}` : entry.iceCode;
  return entry.nameCn ?? '未编号来源行';
}

/** 同号多行差异：只投影已有字段值，不猜不合并。 */
function duplicateDiffLines(issue: ProductSourceIssue): string[] {
  const fields = issue.duplicate?.fields ?? [];
  return fields.map((field) => {
    const parts = field.values
      .map((value) => `第${value.rowNumber}行：${value.empty || !value.value.trim() ? '未填写' : value.value}`)
      .join('；');
    return `${field.fieldLabel}：${parts}`;
  });
}

function duplicateReason(issue: ProductSourceIssue): string {
  const labels = [...new Set([
    ...(issue.duplicate?.fields ?? []).map((field) => field.fieldLabel),
    ...(issue.fieldLabel ? [issue.fieldLabel] : []),
  ])].filter(Boolean);
  return `同一货号有两行，${labels.length > 0 ? labels.join('、') : '商品资料'}不一致，请选择以后采用哪行资料。`;
}

function pendingCodeReason(issue: ProductSourceIssue): string {
  return issue.pendingCodeCandidate
    ? `飞书已补充货号 ${issue.pendingCodeCandidate.sourceCode}，请确认用于这款商品。`
    : '该商品尚无正式货号，需要人工确认后补录。';
}

function IssueAction({
  issue,
  busy,
  onCode,
  onDuplicate,
  message,
}: {
  issue: ProductSourceIssue;
  busy: boolean;
  onCode: (code: string) => void;
  onDuplicate: (rowNumber: number) => void;
  message: string;
}) {
  const [openChoice, setOpenChoice] = useState(false);
  const [chosenRow, setChosenRow] = useState<number | null>(null);
  const candidate = issue.pendingCodeCandidate;
  const duplicate = issue.kind === 'duplicate_code_inconsistent' ? issue.duplicate : null;
  const rowNumbers = [...new Set([
    ...issue.rows,
    ...(duplicate?.fields ?? []).flatMap((field) => field.values.map((value) => value.rowNumber)),
  ])].sort((a, b) => a - b);

  if (candidate) {
    return (
      <div className={styles.issueAction}>
        <p className={styles.codeDiff} data-testid="product-library-code-diff">
          <span>正式货号</span>
          <span className={styles.oldValue}>未填写</span>
          <ArrowRight size={14} aria-hidden />
          <span className={styles.newValue}>{candidate.sourceCode}</span>
        </p>
        <div className={styles.issueButtons}>
          <button type="button" className={styles.primaryButton} disabled={busy}
            onClick={() => onCode(candidate.sourceCode)} data-testid="product-library-code-confirm">
            {busy ? '正在补号…' : '确认采用此货号'}
          </button>
        </div>
        {message ? <p role="status" className={styles.issueMessage}>{message}</p> : null}
      </div>
    );
  }

  if (duplicate) {
    return (
      <div className={styles.issueAction}>
        <div className={styles.issueButtons}>
          <button type="button" className={styles.secondaryButton} onClick={() => setOpenChoice((value) => !value)}
            data-testid="product-library-duplicate-toggle">
            {openChoice ? '收起' : '选择采用行'}
          </button>
        </div>
        {openChoice ? (
          <div className={styles.choiceBox}>
            {rowNumbers.map((rowNumber) => (
              <label key={rowNumber} className={styles.choiceRow}>
                <input type="radio" name={`library-row-${issue.issueKey}`} value={rowNumber}
                  checked={chosenRow === rowNumber} onChange={() => setChosenRow(rowNumber)} />
                第 {rowNumber} 行
              </label>
            ))}
            <button type="button" className={styles.primaryButton}
              disabled={busy || chosenRow === null}
              onClick={() => chosenRow !== null && onDuplicate(chosenRow)}
              data-testid="product-library-duplicate-save">
              {busy ? '正在保存…' : '保存采用行'}
            </button>
          </div>
        ) : null}
        {message ? <p role="status" className={styles.issueMessage}>{message}</p> : null}
      </div>
    );
  }

  return (
    <div className={styles.issueAction}>
      <Link className={styles.secondaryLink} href={`/dashboard/catalog/sources?issue=${encodeURIComponent(issue.issueKey)}`}>
        打开来源资料
      </Link>
      {message ? <p role="status" className={styles.issueMessage}>{message}</p> : null}
    </div>
  );
}

export function ProductLibraryUpdate({
  dto,
  fallbackReason,
  initialPanel = false,
}: {
  dto: ProductSourcePanelDto | null;
  fallbackReason: 'forbidden' | 'read_failed';
  /** 仅首次挂载为 true 时自动打开更新弹窗（数据同步页「查看预览」直达 /dashboard/sync?panel=product-update）。 */
  initialPanel?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<TabKey>('changes');
  const [busy, startTransition] = useTransition();
  const [checking, setChecking] = useState(false);
  const [cardMessage, setCardMessage] = useState('');
  const [modalMessage, setModalMessage] = useState('');
  const [appliedResult, setAppliedResult] = useState<AppliedReceipt | null>(null);
  const [issueBusyKey, setIssueBusyKey] = useState<string | null>(null);
  const [issueMessages, setIssueMessages] = useState<Record<string, string>>({});
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const autoOpenedRef = useRef(false);

  const status = statusOf(dto);
  const preview = dto?.preview ?? null;
  const changedCount = preview?.changed.length ?? 0;
  /** 已读到的候选货号优先，避免被同号事项挤到列表末尾。 */
  const displayedIssues = dto
    ? [...dto.issues].sort((left, right) => (
      Number(Boolean(right.pendingCodeCandidate)) - Number(Boolean(left.pendingCodeCandidate))
      || (left.iceCode ?? left.nameCn ?? '').localeCompare(right.iceCode ?? right.nameCn ?? '', 'zh-Hans-CN')
    ))
    : [];

  useDialogFocusTrap(open, '#product-library-dialog');

  // 数据同步页「查看预览」直达：只认首次挂载时的 true，挂载后自动打开一次。
  // 关闭后不因属性不变而重开；首屏（SSR）保持关闭，避免水合不一致。
  useEffect(() => {
    if (!initialPanel || autoOpenedRef.current) return;
    autoOpenedRef.current = true;
    setTab('changes');
    setModalMessage('');
    setOpen(true);
  }, [initialPanel]);

  useEffect(() => {
    if (!open) return;
    previousFocus.current = document.activeElement as HTMLElement | null;
    const frame = requestAnimationFrame(() => closeRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('keydown', onKeyDown);
      document.documentElement.style.overflow = previousOverflow;
      previousFocus.current?.focus();
    };
  }, [open]);

  function openModal(nextTab: TabKey) {
    setTab(nextTab);
    setModalMessage('');
    setOpen(true);
  }

  function checkNow() {
    if (checking) return;
    setChecking(true);
    setCardMessage('正在通过飞书读取最新资料…');
    startTransition(async () => {
      try {
        const result = await readProductSourceNowAction();
        if (!result.success) {
          setCardMessage(result.error ?? '检查未完成；没有改动商品资料。');
          return;
        }
        const statusValue = (result.data as { status?: string } | undefined)?.status;
        setCardMessage(statusValue === 'unchanged'
          ? '已检查，来源内容没有新变化。'
          : statusValue === 'failed'
            ? '检查失败；没有改动商品资料。'
            : '已读取到最新来源资料。');
        router.refresh();
      } catch {
        setCardMessage('检查结果未确认；没有改动商品资料，请刷新后核对。');
      } finally {
        setChecking(false);
      }
    });
  }

  function applyUpdate() {
    if (!preview?.canApply || busy) return;
    setModalMessage('正在按这份来源计划更新商品资料…');
    startTransition(async () => {
      try {
        const result = await applyProductSourceAction({
          requestId: crypto.randomUUID(),
          snapshotKey: preview.snapshotToken,
        });
        if (!result.success) {
          setModalMessage(result.error ?? '本次更新未完成；未写入商品资料。');
          return;
        }
        setAppliedResult({
          message: result.data?.message ?? '本次更新未返回结果说明。',
          status: result.data?.status,
          receiptStatus: result.data?.receiptStatus,
          counts: result.data?.counts ?? null,
          writtenItems: result.data?.writtenItems ?? null,
          writtenNeedsReview: result.data?.writtenNeedsReview ?? null,
        });
        setModalMessage('');
        router.refresh();
      } catch {
        setModalMessage('更新结果未确认；请刷新后核对，不要重复提交。');
      }
    });
  }

  function confirmCode(issue: ProductSourceIssue, code: string) {
    if (!issue.itemId || issue.itemRevision === null || issueBusyKey) return;
    setIssueBusyKey(issue.issueKey);
    setIssueMessages((current) => ({ ...current, [issue.issueKey]: '' }));
    startTransition(async () => {
      try {
        const result = await assignProductSourceCodeAction({
          requestId: crypto.randomUUID(),
          itemId: issue.itemId as string,
          expectedRevision: issue.itemRevision as number,
          code,
          reason: '飞书已补充货号，确认为同一商品',
        });
        setIssueMessages((current) => ({
          ...current,
          [issue.issueKey]: result.success
            ? `已采用正式货号 ${code}；原商品身份、历史与在途关联保留。`
            : result.error ?? '补号未完成。',
        }));
        if (result.success) router.refresh();
      } catch {
        setIssueMessages((current) => ({ ...current, [issue.issueKey]: '提交结果未确认；请刷新后核对。' }));
      } finally {
        setIssueBusyKey(null);
      }
    });
  }

  function saveDuplicate(issue: ProductSourceIssue, rowNumber: number) {
    if (issueBusyKey) return;
    setIssueBusyKey(issue.issueKey);
    setIssueMessages((current) => ({ ...current, [issue.issueKey]: '' }));
    startTransition(async () => {
      try {
        const result = await decideDuplicateSourceRowAction({
          requestId: crypto.randomUUID(),
          issueId: issue.issueKey,
          chosenRowNumber: rowNumber,
          note: '已核对两份资料',
        });
        setIssueMessages((current) => ({
          ...current,
          [issue.issueKey]: result.success
            ? `已保存采用行：以来源第 ${rowNumber} 行为准。`
            : result.error ?? '保存未完成。',
        }));
        if (result.success) router.refresh();
      } catch {
        setIssueMessages((current) => ({ ...current, [issue.issueKey]: '提交结果未确认；请刷新后核对。' }));
      } finally {
        setIssueBusyKey(null);
      }
    });
  }

  const cardFacts = (
    <dl className={syncStyles.cardFacts}>
      <div data-testid="sync-product-library-last-read">
        <dt>最近检查</dt>
        <dd>{dto?.read.lastReadAtDisplay ?? '暂无记录'}</dd>
      </div>
      <div data-testid="sync-product-library-applied">
        <dt>已采用来源</dt>
        <dd>{dto?.applied?.capturedAtDisplay ?? '还没有采用'}</dd>
      </div>
    </dl>
  );

  return (
    <>
      <section className={`${syncStyles.sourceCard} ${syncStyles.cardProduct}`} data-testid="sync-product-library-card" aria-label="商品库更新">
        <header className={syncStyles.cardHead}>
          <span className={syncStyles.cardIcon} aria-hidden>
            <NotebookTabs size={18} strokeWidth={1.8} />
          </span>
          <div className={syncStyles.cardIdentity}>
            <h2>商品库更新</h2>
            <span className={syncStyles.cardPurpose}>飞书商品资料</span>
          </div>
          <div className={syncStyles.cardStatus} data-testid="sync-product-library-status">
            <StatusPill tone={status.tone}>{status.label}</StatusPill>
          </div>
        </header>

        {cardFacts}

        {cardMessage ? (
          <p className={styles.cardMessage} role="status" aria-live="polite">{cardMessage}</p>
        ) : null}

        <div className={syncStyles.cardActions}>
          <button type="button" className={syncStyles.primaryButton} onClick={checkNow}
            disabled={!dto || checking} data-testid="sync-product-library-check">
            {checking ? <Loader2 size={14} aria-hidden /> : <RefreshCw size={14} aria-hidden />}
            {checking ? '检查中…' : '检查更新'}
          </button>
          <button type="button" className={syncStyles.secondaryButton} onClick={() => openModal('changes')}
            disabled={!dto} data-testid="sync-product-library-view">
            <ArrowRight size={14} aria-hidden />
            查看更新
          </button>
        </div>
      </section>

      {open ? (
        <div className={styles.backdrop} role="presentation" onClick={() => setOpen(false)}
          data-testid="product-library-backdrop">
          <section id="product-library-dialog" className={demoStyles.detailDialog} role="dialog"
            aria-modal="true" aria-labelledby="product-library-title"
            onClick={(event) => event.stopPropagation()} data-testid="product-library-dialog">
            <header className={demoStyles.detailHeader}>
              <div>
                <h2 id="product-library-title" data-slot="dialog-title">商品库更新</h2>
                <p data-slot="dialog-description">
                  飞书商品资料 · {preview?.capturedAtDisplay ?? dto?.applied?.capturedAtDisplay ?? '最新来源'}
                </p>
              </div>
              <button ref={closeRef} type="button" className={demoStyles.iconButton}
                onClick={() => setOpen(false)} aria-label="关闭商品库更新" data-testid="product-library-close">
                <X size={18} strokeWidth={1.8} aria-hidden />
              </button>
            </header>

            <DetailTabs
              tabs={TABS}
              active={tab}
              onSelect={(key) => setTab(key as TabKey)}
              ariaLabel="商品库更新详情"
              idPrefix="product-library-tab"
              panelIdPrefix="product-library-panel"
              testIdPrefix="product-library"
            />

            <div className={`${demoStyles.detailBody} ${demoStyles.detailContent}`}>
              {tab === 'changes' ? (
                <section id="product-library-panel-changes" role="tabpanel"
                  aria-labelledby="product-library-tab-changes" data-testid="product-library-panel-changes">
                  {appliedResult ? <AppliedReceiptBox entry={appliedResult} /> : null}

                  {preview ? (
                    <>
                      <div className={styles.batchLine}>
                        <strong>{preview.capturedAtDisplay} 的来源资料</strong>
                        <span>{preview.canApply ? '待确认，尚未更新商品库' : '当前不能应用'}</span>
                      </div>

                      <div className={styles.summaryRow} data-testid="product-library-update-summary">
                        <div><b>{changedCount}</b><span>款有变化</span></div>
                        <div><b>{preview.unchangedCount}</b><span>款无变化</span></div>
                        <div><b>{preview.reviewCount}</b><span>项本批需核对</span></div>
                      </div>

                      {preview.reviewNotes.length > 0 ? (
                        <div className={styles.sourceAlert} data-testid="product-library-review-notes">
                          <p>本批来源需核对（尚未登记为待处理事项，确认更新后才登记）：</p>
                          <ul>
                            {preview.reviewNotes.map((note) => (
                              <li key={`${note.fieldLabel}-${note.reasonLabel}`}>
                                <span>{note.fieldLabel}</span>：{note.reasonLabel} · {note.count} 处
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}

                      {preview.changed.length > 0 ? (
                        <div className={styles.changeList}>
                          {preview.changed.map((entry) => (
                            <article key={entry.itemKey} className={styles.changeItem}
                              data-testid="product-library-change">
                              <header className={styles.changeHead}>
                                {entry.iceCode ? <span className={styles.changeCode}>{entry.iceCode}</span> : null}
                                <strong>{entry.nameCn ?? entry.iceCode ?? '未编号商品'}</strong>
                              </header>
                              {entry.changes.map((change) => (
                                <div key={`${entry.itemKey}-${change.fieldLabel}`} className={styles.diffRow}>
                                  <span className={styles.diffLabel}>{change.fieldLabel}</span>
                                  <span className={styles.oldValue}>{displayValue(change.before)}</span>
                                  <ArrowRight size={14} aria-hidden />
                                  <span className={styles.newValue}>{displayValue(change.after)}</span>
                                  {change.unitLabel ? <span className={styles.unit}>{change.unitLabel}</span> : null}
                                </div>
                              ))}
                            </article>
                          ))}
                        </div>
                      ) : (
                        <p className={styles.emptyText} data-testid="product-library-no-changes">
                          本次没有需要更新的字段；{preview.unchangedCount} 款无变化。
                        </p>
                      )}

                      {modalMessage ? (
                        <p className={styles.modalMessage} role="status" data-testid="product-library-apply-message">
                          {modalMessage}
                        </p>
                      ) : null}
                    </>
                  ) : (
                    <div className={styles.emptyBox} data-testid="product-library-no-pending">
                      <p className={styles.emptyText}>
                        {dto ? '当前没有待应用的更新。' : (fallbackReason === 'forbidden' ? '当前账号无权读取商品库更新。' : '商品库更新读取失败。')}
                      </p>
                      {dto?.applied ? (
                        <p className={styles.emptyMeta}>
                          最近采用：{dto.applied.capturedAtDisplay} · {dto.applied.statusLabel} · {dto.applied.countsSummary}
                        </p>
                      ) : null}
                    </div>
                  )}
                </section>
              ) : null}

              {tab === 'issues' ? (
                <section id="product-library-panel-issues" role="tabpanel"
                  aria-labelledby="product-library-tab-issues" data-testid="product-library-panel-issues">
                  {!dto ? (
                    <p className={styles.emptyText}>当前没有可读取的待人工确认事项。</p>
                  ) : dto.issues.length === 0 ? (
                    <p className={styles.emptyText} data-testid="product-library-issues-empty">当前没有待人工确认事项。</p>
                  ) : (
                    <div className={styles.issueList}>
                      {displayedIssues.map((issue) => {
                        const candidate = issue.pendingCodeCandidate;
                        const isDuplicate = issue.kind === 'duplicate_code_inconsistent' && issue.duplicate;
                        const reason = candidate
                          ? pendingCodeReason(issue)
                          : isDuplicate
                            ? duplicateReason(issue)
                            : issue.detailLabel;
                        const differences = isDuplicate ? duplicateDiffLines(issue) : [];
                        return (
                          <article key={issue.issueKey} className={styles.issue}
                            data-testid="product-library-issue" data-kind={issue.kind}>
                            <header className={styles.issueHead}>
                              <strong>{itemTitle(issue)}</strong>
                            </header>
                            <p className={styles.issueReason}>{reason}</p>
                            {differences.length > 0 ? (
                              <ul className={styles.issueDiff}>
                                {differences.map((line) => <li key={line}>{line}</li>)}
                              </ul>
                            ) : null}
                            <IssueAction
                              issue={issue}
                              busy={issueBusyKey === issue.issueKey}
                              message={issueMessages[issue.issueKey] ?? ''}
                              onCode={(code) => confirmCode(issue, code)}
                              onDuplicate={(rowNumber) => saveDuplicate(issue, rowNumber)}
                            />
                          </article>
                        );
                      })}
                    </div>
                  )}
                </section>
              ) : null}

              {tab === 'history' ? (
                <section id="product-library-panel-history" role="tabpanel"
                  aria-labelledby="product-library-tab-history" data-testid="product-library-panel-history">
                  {dto && dto.batchHistory.length > 0 ? (
                    <div className={styles.historyList}>
                      {dto.batchHistory.map((batch, index) => (
                        <article key={`${batch.capturedAtDisplay}-${index}`} className={styles.historyItem}
                          data-testid="product-library-history-item">
                          <header>
                            <strong>{batch.capturedAtDisplay}</strong>
                            <span>{batch.originLabel} · {batch.statusLabel}</span>
                          </header>
                          <p>{batch.countsSummary}</p>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p className={styles.emptyText} data-testid="product-library-history-empty">还没有采用记录。</p>
                  )}
                </section>
              ) : null}
            </div>

            <footer className={styles.footer}>
              <p className={styles.footerNote}>
                {tab === 'changes'
                  ? preview?.canApply
                    ? `确认后，将更新这 ${changedCount} 款商品的对应字段；无变化 ${preview.unchangedCount} 款。`
                    : '这里只展示是否已更新；没有待应用计划时不能重复确认。'
                  : tab === 'issues'
                    ? '人工确认在对应事项内完成。'
                    : '采用记录按批次时间从新到旧排列。'}
              </p>
              <div className={styles.footerActions}>
                <button type="button" className={styles.secondaryButton} onClick={() => setOpen(false)}>
                  {tab === 'changes' && preview?.canApply ? '稍后处理' : '完成'}
                </button>
                {tab === 'changes' && preview?.canApply ? (
                  <button type="button" className={styles.primaryButton} disabled={busy}
                    onClick={applyUpdate} data-testid="product-library-apply">
                    {busy ? '更新中…' : `确认更新 ${changedCount} 款`}
                  </button>
                ) : null}
              </div>
            </footer>
          </section>
        </div>
      ) : null}
    </>
  );
}
