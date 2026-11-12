'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import {
  isPanelLocked,
  resolveSubmitOutcome,
  type PendingRequest,
  type ProductSourceActionOutcome,
} from '../product-source/panel-recovery';
import {
  applyProductSourceAction,
  assignProductSourceCodeAction,
  decideDuplicateSourceRowAction,
  deferProductSourceFieldAction,
  overrideProductSourceFieldAction,
  readProductSourceNowAction,
  refreshProductSourceAction,
  resolveProductSourceIssueAction,
  restoreDuplicateSourceDecisionAction,
  restoreProductSourceFieldAction,
  retryProductSourceAction,
} from '../product-source/actions';
import type {
  ProductSourceBatchStatus,
  ProductSourceClassification,
  ProductSourcePanelDto,
} from '../product-source/panel-types';
import pageStyles from './catalog-content.module.css';
import styles from './product-source-panel.module.css';

// 页面 DTO 由服务端 service 生成（panel-types.ts 是唯一类型来源）；
// 页面只展示中文业务摘要，不显示 UUID / JSON / 哈希 / 原始快照列；
// snapshotToken 与 issueKey 只用于提交动作，不上屏。
export type {
  ProductSourceBatchStatus,
  ProductSourceClassification,
  ProductSourceCountsDto,
  ProductSourcePanelDto,
} from '../product-source/panel-types';

type ProductSourceIssueDto = ProductSourcePanelDto['issues'][number];

/* ------------------------------------------------------------------ *
 * 中文业务摘要
 * ------------------------------------------------------------------ */

const PENDING_LABELS: Record<PendingRequest['kind'], string> = {
  refresh: '读取最新快照预览',
  apply: '应用本批来源批次',
  retry: '核对/重试原请求',
  resolve: '处理待核对事项',
};

const COUNT_ITEMS = [
  { key: 'created', label: '新品', tone: 'positive' },
  { key: 'updated', label: '已更新', tone: 'positive' },
  { key: 'unchanged', label: '无变化', tone: 'plain' },
  { key: 'needsReview', label: '待核对', tone: 'warn' },
  { key: 'failed', label: '失败', tone: 'danger' },
  { key: 'missing', label: '本次未见', tone: 'plain' },
] as const;

function classificationBadgeClass(classification: ProductSourceClassification): string {
  switch (classification) {
    case 'created':
    case 'updated':
      return styles.badgePositive;
    case 'needs_review':
      return pageStyles.badgeWarn;
    case 'failed':
      return styles.badgeDanger;
    default:
      return '';
  }
}

/** 未应用/部分应用/旧快照时，明确说明商品资料是否被改动，避免把失败当成功。 */
function batchStatusCaution(status: ProductSourceBatchStatus): string | null {
  switch (status) {
    case 'collected':
    case 'validated':
      return '本批只是读取/预览，尚未写入商品资料。';
    case 'partial':
      return '本批部分应用：失败与待核对项见下方清单，未成功的字段保留原值。';
    case 'failed':
      return '本批未应用：失败原因见下方清单；已保留上次成功数据，未覆盖现有商品资料。';
    case 'rejected_stale':
      return '本批为旧快照：已被拒绝，未写入商品资料，也保留上次成功批次。';
    default:
      return null;
  }
}

function displayValue(value: string): string {
  return value.trim() ? value : '（空）';
}

function itemTitle(entry: { iceCode: string | null; nameCn: string | null }): string {
  if (entry.iceCode) return entry.nameCn ? `${entry.iceCode} · ${entry.nameCn}` : entry.iceCode;
  return entry.nameCn ?? '未编号来源行';
}

function rowNumbersText(rows: number[]): string | null {
  return rows.length ? `来源行 ${rows.join('、')}` : null;
}

/* ------------------------------------------------------------------ *
 * 人工核对：字段级暂不处理 / 人工口径 / 同号多行选择 / 人工补号
 * ------------------------------------------------------------------ */

/** 字段级人工决定适用的待核对类型（只对“该商品 + 该字段”生效）。 */
const FIELD_DECISION_KINDS = new Set([
  'invalid_value',
  'formula_error',
  'invalid_carton_quantity',
  'unit_unconfirmed',
]);

/** 人工补正式货号适用的待核对类型。 */
const PENDING_CODE_KINDS = new Set(['missing_code', 'missing_code_candidate']);

interface ManualActionOutcome {
  success: boolean;
  error?: string;
}

/**
 * 新的人工核对动作独立于 refresh/apply/retry/resolve 的 outcomeUnknown 机制：
 * 每次都用新的 requestId，成功后刷新页面；失败只显示服务端返回的中文原因。
 */
function useManualAction() {
  const router = useRouter();
  const [busy, startTransition] = useTransition();
  const [message, setMessage] = useState('');

  function run(invoke: () => Promise<ManualActionOutcome>, successMessage: string) {
    startTransition(async () => {
      setMessage('正在提交人工核对结果，请稍候…');
      try {
        const result = await invoke();
        if (result.success) {
          setMessage(successMessage);
          router.refresh();
        } else {
          setMessage(result.error ?? '本次操作未完成；未改写任何商品资料。');
        }
      } catch {
        setMessage('提交结果暂未确认；请刷新页面核对当前状态，不要重复提交同一操作。');
      }
    });
  }

  return { busy, message, run };
}

/** issue.rows 与差异值行号的并集（升序），作为对照表列头。 */
function duplicateRowNumbers(issue: ProductSourceIssueDto): number[] {
  const numbers = new Set<number>(issue.rows ?? []);
  for (const field of issue.duplicate?.fields ?? []) {
    for (const value of field.values) numbers.add(value.rowNumber);
  }
  return [...numbers].sort((a, b) => a - b);
}

/* ------------------------------------------------------------------ *
 * 缺货号候选关系确认
 * ------------------------------------------------------------------ */

/** 缺货号时系统找到的“疑似同一商品”候选关系（详情不展示 UUID）。 */
type CandidateRelation = NonNullable<ProductSourceIssueDto['candidate']>;

const MATCHED_BY_LABELS: Record<string, string> = {
  barcode: '69 码与现有商品一致',
  nameCn: '中文名称与现有商品一致',
  normalizedName: '中文名称忽略空格后与现有商品一致',
};

function matchedByText(matchedBy: string | null): string | null {
  return matchedBy ? MATCHED_BY_LABELS[matchedBy] ?? null : null;
}

/* ------------------------------------------------------------------ *
 * 操作请求（结果未知时原请求由服务端保存；核对沿用原 requestId，不新建请求）
 * ------------------------------------------------------------------ */

type ActionOutcome = ProductSourceActionOutcome;

export function ProductSourcePanel({
  dto,
  focusIssueId = null,
}: {
  dto: ProductSourcePanelDto;
  /** 从「待处理」定位过来时，滚动并高亮对应待核对事项（只影响展示，不触发处理）。 */
  focusIssueId?: string | null;
}) {
  const router = useRouter();
  const [busy, startTransition] = useTransition();
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState<PendingRequest | null>(null);
  const latest = dto.latest;
  const pendingSnapshot = dto.pending;
  const locked = isPanelLocked(busy, pending);
  const disabledReason = dto.actions.disabledReason;
  const counts = latest?.counts ?? null;
  const caution = latest ? batchStatusCaution(latest.status) : null;
  const showSimulationNotice = dto.source.simulation && (latest !== null || pendingSnapshot !== null);
  /** 首次应用只认“尚未应用的快照”；latest.snapshotToken 只用于重试最近批次。 */
  const applyToken = pendingSnapshot?.snapshotToken ?? null;
  const applyDisabledReason = applyToken && dto.actions.canApply
    ? null
    : disabledReason ?? '当前没有待应用的新来源快照。';

  useEffect(() => {
    if (!focusIssueId) return;
    const frame = requestAnimationFrame(() => {
      const target = document.getElementById(`product-source-issue-${focusIssueId}`);
      if (!target) return;
      target.scrollIntoView({ block: 'center' });
      target.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusIssueId]);

  async function submit(request: PendingRequest, invoke: () => Promise<ActionOutcome>) {
    setPending(request);
    setMessage('正在提交固定原意图，请勿发起另一操作。');
    try {
      const result = await invoke();
      const next = resolveSubmitOutcome(request, result);
      setPending(next.pending);
      setMessage(next.message);
      if (next.refresh) router.refresh();
    } catch {
      // 传输异常也属于“结果未知”：保留原请求并锁住新操作，等待同一 requestId 核对。
      setMessage('提交结果暂未确认。已保留原请求，请使用“核对/重试原请求”，不要发起新操作。');
    }
  }

  function refreshPreview() {
    const requestId = crypto.randomUUID();
    startTransition(async () => {
      await submit({ kind: 'refresh', requestId }, () => refreshProductSourceAction({ requestId }));
    });
  }

  /** 真实读取飞书来源：只生成待应用快照并返回预览，不写商品资料；失败也不回退旧数据。 */
  function readNow() {
    startTransition(async () => {
      setMessage('正在通过飞书接口读取来源，请稍候…');
      try {
        const result = await readProductSourceNowAction();
        if (result.success && result.data) {
          setMessage(result.data.message);
          router.refresh();
        } else {
          setMessage(result.error ?? '飞书读取未完成；本次没有改动商品资料。');
        }
      } catch {
        setMessage('飞书读取请求未完成（网络或会话异常）；本次没有改动商品资料。');
      }
    });
  }

  function applyBatch() {
    if (!pendingSnapshot) return;
    const requestId = crypto.randomUUID();
    const snapshotKey = pendingSnapshot.snapshotToken;
    startTransition(async () => {
      await submit({ kind: 'apply', requestId, snapshotKey }, () =>
        applyProductSourceAction({ requestId, snapshotKey }),
      );
    });
  }

  function retryOriginal() {
    const request = pending;
    if (!request) {
      // 非 pending：最近批次已知部分失败/失败，服务端只补做失败商品，已成功的商品不重复修订。
      if (!latest || !dto.actions.canRetry) return;
      const requestId = crypto.randomUUID();
      const snapshotKey = latest.snapshotToken;
      startTransition(async () => {
        await submit({ kind: 'retry', requestId, snapshotKey }, () =>
          retryProductSourceAction({ requestId, snapshotKey }),
        );
      });
      return;
    }
    startTransition(async () => {
      switch (request.kind) {
        case 'refresh':
          await submit(request, () => refreshProductSourceAction({ requestId: request.requestId }));
          break;
        case 'apply':
        case 'retry':
          await submit(request, () =>
            retryProductSourceAction({ requestId: request.requestId, snapshotKey: request.snapshotKey }),
          );
          break;
        case 'resolve':
          await submit(request, () =>
            resolveProductSourceIssueAction({
              requestId: request.requestId,
              issueId: request.issueId,
              resolution: request.resolution,
              note: request.note,
            }),
          );
          break;
      }
    });
  }

  function resolveIssue(issue: ProductSourceIssueDto, resolution: 'resolved' | 'ignored', note: string) {
    const trimmed = note.trim() || '已在页面核对';
    const requestId = crypto.randomUUID();
    startTransition(async () => {
      await submit(
        { kind: 'resolve', requestId, issueId: issue.issueKey, resolution, note: trimmed },
        () =>
          resolveProductSourceIssueAction({
            requestId,
            issueId: issue.issueKey,
            resolution,
            note: trimmed,
          }),
      );
    });
  }

  const applyDisabled = locked || !dto.actions.canApply || applyToken === null;
  const refreshDisabled = locked;
  const retryVisible = pending !== null || dto.actions.canRetry;
  const retryLabel = pending ? '核对/重试原请求' : '补做失败商品';

  return (
    <section className={pageStyles.panel} aria-label="飞书商品来源" data-testid="product-source-panel">
      <header className={pageStyles.panelHeader}>
        <div className={pageStyles.panelHeading}>
          <h2 className={pageStyles.panelTitle}>飞书商品来源</h2>
          <p className={pageStyles.panelNote}>
            来源：{dto.source.displayName} · 文档：{dto.source.documentLabel} · 工作表：{dto.source.sheetName}
          </p>
          <p className={pageStyles.panelNote}>
            读取方式：{dto.source.modeLabel}。通过本机 lark-cli 读取飞书电子表格，不会写回飞书原表。
          </p>
        </div>
        <div className={styles.badgeCluster}>
          <span className={`${pageStyles.badge} ${pageStyles.badgeIndigo}`}>{dto.source.modeLabel}</span>
          {dto.source.simulation && <span className={`${pageStyles.badge} ${pageStyles.badgeWarn}`}>本地模拟快照</span>}
        </div>
      </header>

      <div className={pageStyles.panelBody}>
        <div className={pageStyles.actionRow} data-testid="product-source-actions">
          <Button type="button" onClick={readNow} disabled={locked || busy}
            title="通过飞书接口读取当前表格并生成待应用快照；只读飞书，不写商品资料">
            立即读取飞书来源
          </Button>
          <Button type="button" variant="outline" onClick={refreshPreview} disabled={refreshDisabled}
            title={pending ? '请先核对/重试原请求，再读取新快照' : '读取已保存的最新快照并校验，只做预览，不写入商品资料'}>
            预览已保存快照
          </Button>
          <Button type="button" onClick={applyBatch} disabled={applyDisabled}
            title={applyDisabled ? (pending ? '请先核对/重试原请求，再决定是否应用' : applyDisabledReason ?? undefined) : undefined}>
            应用本批
          </Button>
          {retryVisible && (
            <Button type="button" variant="outline" onClick={retryOriginal} disabled={busy}
              title={pending
                ? '沿用服务端保存的原请求核对结果，不新建请求'
                : '只补做本批失败的商品；已成功的商品不会重复修订'}>
              {retryLabel}
            </Button>
          )}
        </div>

        <div className={pageStyles.emptyBox} data-testid="product-source-progress">
          <p className={pageStyles.emptyText}>
            已读取：{dto.read.lastReadAtDisplay ?? '还没有读取记录'}
            {dto.read.lastResultLabel ? ` · ${dto.read.lastResultLabel}` : ''}
            {dto.read.pendingAtDisplay ? ` · 待应用 1 批（${dto.read.pendingAtDisplay}）` : ' · 没有待应用的新快照'}
          </p>
          <p className={pageStyles.emptyText} data-testid="product-source-applied">
            已采用：
            {dto.applied
              ? `${dto.applied.capturedAtDisplay} · ${dto.applied.statusLabel} · ${dto.applied.countsSummary}`
              : '还没有采用任何来源批次'}
          </p>
          <p className={pageStyles.muted}>
            已读取只生成待应用快照，不改商品资料；已采用是按来源计划写入商品资料的批次，待核对项不会自动改写商品。
          </p>
        </div>

        {dto.schedule && (
          <div className={pageStyles.emptyBox} data-testid="product-source-schedule">
            <p className={pageStyles.emptyText}>
              定时读取：{dto.schedule.runningLabel}
              {dto.schedule.intervalMinutes ? ` · 每 ${dto.schedule.intervalMinutes} 分钟` : ''}
              {dto.schedule.lastResultLabel ? ` · 最近结果：${dto.schedule.lastResultLabel}` : ''}
            </p>
            <p className={pageStyles.muted}>
              {dto.schedule.lastRunAtDisplay ? `最近读取：${dto.schedule.lastRunAtDisplay}` : '最近还没有读取记录'}
              {dto.schedule.nextRunAtDisplay ? ` · 下次计划：${dto.schedule.nextRunAtDisplay}` : ''}
            </p>
            {dto.schedule.errorLabel && (
              <p className={pageStyles.muted} data-testid="product-source-schedule-error">
                最近失败原因：{dto.schedule.errorLabel}；旧快照与商品资料保留，不当作没有变化。
              </p>
            )}
            <p className={pageStyles.muted}>
              定时读取只生成待应用快照，不会自动改写商品；需人工核对后点“应用本批”。
            </p>
          </div>
        )}
        {!dto.schedule && (
          <p className={pageStyles.muted} data-testid="product-source-schedule">
            定时读取未运行：没有定时读取状态（不影响手动“立即读取飞书来源”）。
          </p>
        )}
        {applyDisabledReason ? (
          <p className={pageStyles.muted} data-testid="product-source-apply-hint">
            暂不可应用：{applyDisabledReason}读取预览不会写入任何商品资料。
          </p>
        ) : (
          <p className={pageStyles.muted}>
            “应用本批”会按服务端计划写入本批可采纳字段；待核对项不会自动改写商品。
          </p>
        )}
        {!pending && dto.actions.canRetry && (
          <p className={pageStyles.muted}>
            “补做失败商品”只重做本批失败的商品；已成功的商品不会重复修订。
          </p>
        )}

        <p role="status" aria-live="polite" className={pageStyles.summaryLine} data-testid="product-source-status">
          {message || '尚未执行操作；读取预览只核对来源快照，不写入商品资料。'}
        </p>

        {pending && (
          <div className={pageStyles.emptyBox} data-testid="product-source-pending-request">
            <p className={pageStyles.emptyText}>
              结果未知：{PENDING_LABELS[pending.kind]} · 服务端已保存原请求
            </p>
            <p className={pageStyles.muted}>
              原请求及完整意图已由服务端保留；核对沿用原请求，不会新建另一请求。核对期间新操作暂停，避免重复提交。
            </p>
          </div>
        )}

        {pendingSnapshot && (
          <div className={pageStyles.emptyBox} data-testid="product-source-pending-snapshot">
            <p className={pageStyles.emptyText}>
              待应用快照：{pendingSnapshot.capturedAtDisplay} · {pendingSnapshot.originLabel}
            </p>
            <p className={pageStyles.muted}>{pendingSnapshot.captureSummary}</p>
            <p className={pageStyles.muted}>
              “应用本批”使用这一条快照；“立即读取飞书来源”会重新读取飞书并生成更新快照，待核对项不会自动改写商品。
            </p>
          </div>
        )}

        {showSimulationNotice && (
          <p className={styles.simulationNote} data-testid="product-source-simulation-notice">
            本地模拟快照，非飞书真实修改：本面板中的该批次与变化来自本地副本，用于验证来源更新链路。
          </p>
        )}

        {latest === null ? (
          <div className={pageStyles.emptyBox} data-testid="product-source-empty">
            <p className={pageStyles.emptyText}>尚未读取到飞书商品来源批次（不是读取失败，也不当作没有变化）。</p>
            <p className={pageStyles.muted}>点“立即读取飞书来源”生成只读预览；预览不写入商品资料。</p>
          </div>
        ) : (
          <section aria-label="最近一批来源结果" className={pageStyles.subsection} data-testid="product-source-latest">
            <h3 className={pageStyles.subsectionTitle}>最近一批结果</h3>
            <dl className={pageStyles.summaryGrid}>
              <div><dt>最近采集或更新</dt><dd>{latest.capturedAtDisplay}</dd></div>
              <div><dt>批次状态</dt><dd>{latest.statusLabel}</dd></div>
              <div><dt>批次来源</dt><dd>{latest.originLabel}</dd></div>
              <div><dt>批次记录</dt><dd>{latest.batchIdLabel}</dd></div>
            </dl>
            {latest.captureSummary && (
              <p className={pageStyles.summaryLine} data-testid="product-source-capture-summary">
                {latest.captureSummary}
              </p>
            )}
            {latest.message && <p className={pageStyles.recordMeta}>{latest.message}</p>}
            {caution && <p className={pageStyles.summaryLine}>{caution}</p>}
            {counts && (
              <ul className={styles.countsGrid} aria-label="本批处理结果计数" data-testid="product-source-counts">
                {COUNT_ITEMS.map((item) => (
                  <li key={item.key} className={styles.countCard} data-testid={`product-source-count-${item.key}`}>
                    <span
                      className={`${styles.countValue} ${
                        item.tone === 'positive'
                          ? styles.countValuePositive
                          : item.tone === 'warn'
                            ? styles.countValueWarn
                            : item.tone === 'danger'
                              ? styles.countValueDanger
                              : ''
                      }`}
                    >
                      {counts[item.key]}
                    </span>
                    <span className={styles.countLabel}>{item.label}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        <section aria-label="逐项变化" className={pageStyles.subsection} data-testid="product-source-results">
          <h3 className={pageStyles.subsectionTitle}>逐项变化</h3>
          <p className={pageStyles.muted}>
            逐条列出本批每个货号的处理原因与字段差异；“本次未见”只标记，不删除商品、不清零库存。
          </p>
          {dto.results.length === 0 ? (
            <p className={pageStyles.muted} data-testid="product-source-results-empty">
              {latest === null ? '尚未读取批次，因此没有逐项变化。' : '本批没有可展示的逐项变化。'}
            </p>
          ) : (
            <ul className={styles.resultList}>
              {dto.results.map((result, index) => {
                const rowsText = rowNumbersText(result.rowNumbers);
                return (
                  <li key={`${result.sourceKeyLabel}-${index}`} className={styles.resultItem}
                    data-testid="product-source-result">
                    <div className={styles.resultHead}>
                      <p className={styles.resultTitle}>
                        <span className={styles.resultCode}>{itemTitle(result)}</span>
                      </p>
                      <span className={`${pageStyles.badge} ${classificationBadgeClass(result.classification)}`}>
                        {result.classificationLabel}
                      </span>
                    </div>
                    <p className={pageStyles.recordMeta}>处理原因：{result.reasonLabel}</p>
                    {rowsText && <p className={styles.rowsLine}>{rowsText}</p>}
                    {result.changes.length > 0 && (
                      <ul className={styles.changeList} aria-label="字段差异">
                        {result.changes.map((change, changeIndex) => (
                          <li key={`${change.fieldLabel}-${changeIndex}`} className={styles.changeItem}>
                            <span className={styles.changeField}>{change.fieldLabel}</span>
                            <span className={styles.changeValue}>
                              <span className={styles.changeBefore}>{displayValue(change.before)}</span>
                              <span aria-hidden="true" className={styles.changeArrow}> → </span>
                              <span className={styles.srOnly}>改为</span>
                              <span className={styles.changeAfter}>{displayValue(change.after)}</span>
                            </span>
                            {change.unitLabel && <span className={styles.changeUnit}>（{change.unitLabel}）</span>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section aria-label="待核对清单" className={pageStyles.subsection} data-testid="product-source-issues">
          <h3 className={pageStyles.subsectionTitle}>待核对清单</h3>
          <p className={pageStyles.muted}>
            同号冲突、缺码、疑似改码、字段冲突、公式错误、截断或读取失败都会列在这里；处理只关闭事项，不自动改写商品。
          </p>
          {focusIssueId && !dto.issues.some((issue) => issue.issueKey === focusIssueId) ? (
            <p className={pageStyles.muted} role="status" data-testid="product-source-focus-missing">
              没有找到要定位的待核对事项，可能已经被处理；请查看下方当前清单。
            </p>
          ) : null}
          {dto.issues.length === 0 ? (
            <p className={pageStyles.muted} data-testid="product-source-issues-empty">
              当前显示范围内没有待核对事项。
            </p>
          ) : (
            <ul className={styles.issueList}>
              {dto.issues.map((issue, index) => (
                <IssueCard key={`${issue.issueKey}-${index}`} issue={issue}
                  focused={issue.issueKey === focusIssueId}
                  canResolve={pending === null} busy={busy} onResolve={resolveIssue} />
              ))}
            </ul>
          )}
        </section>

        <ManualDecisions dto={dto} />

        <details className={styles.history} data-testid="product-source-history">
          <summary className={styles.historySummary}>查看批次历史（共 {dto.batchHistory.length} 批）</summary>
          {dto.batchHistory.length === 0 ? (
            <p className={styles.subtleNote}>暂无批次历史。</p>
          ) : (
            <ul className={styles.historyList}>
              {dto.batchHistory.map((batch, index) => (
                <li key={`${batch.batchIdLabel}-${index}`} className={styles.historyItem}>
                  <span>{batch.capturedAtDisplay} · {batch.originLabel} · {batch.statusLabel}</span>
                  <span className={styles.historyMeta}>{batch.countsSummary}</span>
                </li>
              ))}
            </ul>
          )}
        </details>
      </div>
    </section>
  );
}

function IssueCard({
  issue,
  focused,
  canResolve,
  busy,
  onResolve,
}: {
  issue: ProductSourceIssueDto;
  focused: boolean;
  canResolve: boolean;
  busy: boolean;
  onResolve: (issue: ProductSourceIssueDto, resolution: 'resolved' | 'ignored', note: string) => void;
}) {
  const [note, setNote] = useState('已在页面核对');
  const title = itemTitle(issue);
  const rowsText = rowNumbersText(issue.rows);
  const open = issue.reviewState === 'open';
  const candidate = issue.candidate;
  const showDuplicate = issue.duplicate !== null && issue.kind === 'duplicate_code_inconsistent';
  const showFieldDecision = issue.fieldKey !== null && FIELD_DECISION_KINDS.has(issue.kind);
  /** 候选关系确认优先于通用补号表单；无候选（含 item 级缺码）继续用 PendingCodeBlock。 */
  const showRelation = issue.kind === 'missing_code_candidate' && candidate !== null && open;
  const showPendingCode = PENDING_CODE_KINDS.has(issue.kind) && candidate === null;
  const detailText = issue.pendingCodeCandidate
    ? '飞书已补充货号，等待确认用于这款商品。'
    : issue.detailLabel;
  return (
    <li
      id={`product-source-issue-${issue.issueKey}`}
      className={focused ? `${styles.issueItem} ${styles.issueItemFocused}` : styles.issueItem}
      data-testid="product-source-issue"
      data-focused={focused ? 'true' : null}
      tabIndex={-1}
    >
      <div className={styles.issueHead}>
        <p className={styles.issueTitle}>{title}</p>
        <span className={`${pageStyles.badge} ${pageStyles.badgeWarn}`}>{issue.kindLabel}</span>
      </div>
      <p className={styles.issueDetail}>{detailText}</p>
      {rowsText && <p className={styles.rowsLine}>{rowsText}</p>}
      <p className={styles.issueState}>核对状态：{issue.reviewStateLabel}</p>
      {showDuplicate && issue.duplicate !== null && <DuplicateCompare issue={issue} duplicate={issue.duplicate} />}
      {showFieldDecision && <FieldDecisionBlock issue={issue} />}
      {showRelation && candidate !== null && <RelationConfirmBlock issue={issue} candidate={candidate} />}
      {showPendingCode && <PendingCodeBlock issue={issue} />}
      {open && canResolve ? (
        <div className={styles.resolveRow}>
          <label className={styles.resolveField}>
            处理说明
            <input value={note} maxLength={500}
              onChange={(event) => setNote(event.target.value)}
              aria-label={`处理说明（${title}）`} />
          </label>
          <Button type="button" variant="outline" disabled={busy}
            aria-label={`标记已处理：${title}`}
            onClick={() => onResolve(issue, 'resolved', note)}>
            标记已处理
          </Button>
          <Button type="button" variant="outline" disabled={busy}
            aria-label={`忽略此项：${title}`}
            onClick={() => onResolve(issue, 'ignored', note)}>
            忽略此项
          </Button>
        </div>
      ) : null}
    </li>
  );
}

/** 同号多行：两份资料的实际差异对照 + 人工选择以哪一来源行为准。 */
function DuplicateCompare({
  issue,
  duplicate,
}: {
  issue: ProductSourceIssueDto;
  duplicate: NonNullable<ProductSourceIssueDto['duplicate']>;
}) {
  const manual = useManualAction();
  const [chosenRowNumber, setChosenRowNumber] = useState<number | null>(null);
  const [note, setNote] = useState('已核对两份资料');
  const rowNumbers = duplicateRowNumbers(issue);
  const open = issue.reviewState === 'open';
  const groupName = `duplicate-choice-${issue.issueKey}`;
  const saved = duplicate.savedChoice;

  function save() {
    if (chosenRowNumber === null) return;
    const trimmedNote = note.trim() || '已核对两份资料';
    manual.run(
      () =>
        decideDuplicateSourceRowAction({
          requestId: crypto.randomUUID(),
          issueId: issue.issueKey,
          chosenRowNumber,
          note: trimmedNote,
        }),
      `已保存采用行：以来源第 ${chosenRowNumber} 行为准。`,
    );
  }

  return (
    <div className={styles.compareWrap} data-testid="product-source-duplicate-compare">
      <p className={styles.compareTitle}>两份资料的实际差异</p>
      {duplicate.decisionStale && (
        <p className={styles.staleNotice} role="alert" data-testid="duplicate-stale">
          已有选择，但来源出现新的差异，请重新确认
        </p>
      )}
      {saved && (
        <p className={styles.savedChoice} data-testid="duplicate-saved-choice">
          当前选择：{saved.chosenRowNumber === null ? '未记录来源行号' : `来源第 ${saved.chosenRowNumber} 行`}（{saved.decidedAtDisplay}）
          {saved.note ? ` · 备注：${saved.note}` : ''}
        </p>
      )}
      <div className={styles.compareScroll}>
        <table className={styles.compareTable}>
          <thead>
            <tr>
              <th scope="col">字段</th>
              {rowNumbers.map((rowNumber) => (
                <th key={rowNumber} scope="col">来源第 {rowNumber} 行</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {duplicate.fields.map((field) => {
              const distinct = new Set(
                field.values.map((value) => (value.empty ? '' : value.value.trim())),
              );
              const differing = distinct.size > 1;
              return (
                <tr key={field.fieldKey}>
                  <th scope="row">{field.fieldLabel}</th>
                  {rowNumbers.map((rowNumber) => {
                    const entry = field.values.find((value) => value.rowNumber === rowNumber);
                    const empty = !entry || entry.empty || !entry.value.trim();
                    const cellClass = empty
                      ? styles.compareValueEmpty
                      : differing
                        ? `${styles.compareValue} ${styles.compareValueDiff}`
                        : styles.compareValue;
                    return (
                      <td key={rowNumber} className={cellClass}>
                        {empty ? '（空）' : entry.value}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {open && (
        <>
          <fieldset className={styles.compareChoices}>
            <legend>以来源第几行为准</legend>
            {rowNumbers.map((rowNumber) => (
              <label key={rowNumber} className={styles.compareChoice}>
                <input
                  type="radio"
                  name={groupName}
                  value={rowNumber}
                  checked={chosenRowNumber === rowNumber}
                  onChange={() => setChosenRowNumber(rowNumber)}
                  data-testid={`duplicate-choice-${rowNumber}`}
                />
                来源第 {rowNumber} 行
              </label>
            ))}
          </fieldset>
          <div className={styles.resolveRow}>
            <label className={styles.resolveField}>
              备注
              <input
                value={note}
                maxLength={500}
                onChange={(event) => setNote(event.target.value)}
                aria-label={`同号选择备注（${itemTitle(issue)}）`}
                data-testid="duplicate-note"
              />
            </label>
            <Button
              type="button"
              variant="outline"
              disabled={manual.busy || chosenRowNumber === null}
              title={chosenRowNumber === null ? '请先选择以来源第几行为准' : undefined}
              onClick={save}
              data-testid="duplicate-save"
            >
              保存采用行
            </Button>
          </div>
          <p role="status" aria-live="polite" className={styles.manualStatus} data-testid="duplicate-status">
            {manual.message || '未选择来源行前不会保存任何选择。'}
          </p>
        </>
      )}
    </div>
  );
}

/** 字段级：暂不处理该字段 / 按人工口径采用（只对当前商品的这个字段生效）。 */
function FieldDecisionBlock({ issue }: { issue: ProductSourceIssueDto }) {
  const manual = useManualAction();
  const [deferNote, setDeferNote] = useState('已核对：暂不处理该字段');
  const [overrideValue, setOverrideValue] = useState('');
  const [overrideNote, setOverrideNote] = useState('已核对：按人工口径采用该值');
  const open = issue.reviewState === 'open';
  const fieldLabel = issue.fieldLabel ?? '该字段';
  const rawValue = displayValue(issue.rawValue ?? '');

  function defer() {
    const reason = deferNote.trim() || '已核对：暂不处理该字段';
    manual.run(
      () =>
        deferProductSourceFieldAction({
          requestId: crypto.randomUUID(),
          issueId: issue.issueKey,
          reason,
          note: reason,
        }),
      '已登记暂不处理该字段；后续批次不再催办。',
    );
  }

  function override() {
    const value = overrideValue.trim();
    if (!value) return;
    const reason = overrideNote.trim() || '已核对：按人工口径采用该值';
    manual.run(
      () =>
        overrideProductSourceFieldAction({
          requestId: crypto.randomUUID(),
          issueId: issue.issueKey,
          value,
          reason,
          note: reason,
        }),
      `已按人工口径采用该字段：${value}。`,
    );
  }

  return (
    <div className={styles.fieldBlock} data-testid="product-source-field-decision">
      <p className={styles.fieldSummary}>
        问题字段：{fieldLabel} · 来源原值：{rawValue}
      </p>
      <p className={styles.hintNote}>只对当前商品的这个字段生效，不会扩大到整商品或同类字段。</p>
      {open && (
        <>
          <div className={styles.resolveRow}>
            <label className={styles.resolveField}>
              暂不处理说明
              <input
                value={deferNote}
                maxLength={500}
                onChange={(event) => setDeferNote(event.target.value)}
                aria-label={`暂不处理说明（${fieldLabel}）`}
              />
            </label>
            <Button type="button" variant="outline" disabled={manual.busy}
              onClick={defer} data-testid="field-defer">
              暂不处理此字段
            </Button>
          </div>
          <div className={styles.resolveRow}>
            <label className={styles.resolveField}>
              人工口径数值
              <input
                value={overrideValue}
                maxLength={200}
                placeholder="如 0.05"
                onChange={(event) => setOverrideValue(event.target.value)}
                aria-label={`人工口径数值（${fieldLabel}）`}
                data-testid="field-override-value"
              />
            </label>
            <label className={styles.resolveField}>
              采用说明
              <input
                value={overrideNote}
                maxLength={500}
                onChange={(event) => setOverrideNote(event.target.value)}
                aria-label={`人工口径采用说明（${fieldLabel}）`}
              />
            </label>
            <Button type="button" variant="outline" disabled={manual.busy || !overrideValue.trim()}
              onClick={override} data-testid="field-override">
              按人工口径采用
            </Button>
          </div>
          <p role="status" aria-live="polite" className={styles.manualStatus} data-testid="field-status">
            {manual.message || '“暂不处理此字段”只静默该字段，不改写商品资料。'}
          </p>
        </>
      )}
    </div>
  );
}

/** 缺码：优先直接采用最新来源已读到的正式货号；没有候选时才手填（禁止 TEST- 测试码）。 */
function PendingCodeBlock({ issue }: { issue: ProductSourceIssueDto }) {
  const manual = useManualAction();
  const candidate = issue.pendingCodeCandidate;
  const [typedCode, setTypedCode] = useState('');
  const [reason, setReason] = useState(candidate
    ? '已核对：飞书已补充货号，确认为同一商品'
    : '人工核对后补录正式货号');
  const open = issue.reviewState === 'open';
  const itemId = issue.itemId;
  const itemRevision = issue.itemRevision;
  const code = candidate?.sourceCode ?? typedCode;

  function assign() {
    const trimmedCode = code.trim();
    if (!itemId || itemRevision === null || !trimmedCode) return;
    const trimmedReason = reason.trim() || '人工核对后补录正式货号';
    manual.run(
      () =>
        assignProductSourceCodeAction({
          requestId: crypto.randomUUID(),
          itemId,
          expectedRevision: itemRevision,
          code: trimmedCode,
          reason: trimmedReason,
        }),
      candidate
        ? `已确认采用来源货号 ${trimmedCode}；原商品身份、修订历史与在途关联保留。`
        : `已补录正式货号 ${trimmedCode}；原商品身份与修订历史保留。`,
    );
  }

  return (
    <div className={styles.pendingCodeBlock} data-testid="product-source-pending-code">
      {candidate ? (
        <>
          <p className={styles.pendingCodeNotice}>飞书已补充货号，请确认用于这款商品。</p>
          <p className={styles.pendingCodeDiff} data-testid="pending-code-candidate">
            <span>正式货号</span>
            <span className={styles.pendingCodeOld}>未填写</span>
            <span aria-hidden="true">→</span>
            <span className={styles.pendingCodeNew}>{candidate.sourceCode}</span>
          </p>
          <p className={styles.hintNote}>
            来源读取：{candidate.capturedAtDisplay}
            {candidate.rowNumbers.length > 0 ? ` · 第 ${candidate.rowNumbers.join('、')} 行` : ''}
            {candidate.matchedItemName ? ` · 与「${candidate.matchedItemName}」名称一致` : ''}
          </p>
        </>
      ) : issue.pendingCode ? (
        <p className={styles.pendingCodeNotice}>货号待确认：测试修订已纠正，等待正式货号</p>
      ) : null}
      {itemId && itemRevision !== null ? (
        <>
          <p className={styles.hintNote}>
            {candidate
              ? '确认后按正式货号补录，不新建商品、不改写历史；后续批次按正式货号正常匹配。'
              : '不得使用 TEST- 测试码或替代业务货号；补录后追加一条正式修订。'}
          </p>
          {open && (
            <>
              <div className={styles.resolveRow}>
                {!candidate && (
                  <label className={styles.resolveField}>
                    正式货号
                    <input
                      value={typedCode}
                      maxLength={50}
                      placeholder="输入 ICE 正式货号"
                      onChange={(event) => setTypedCode(event.target.value)}
                      aria-label={`正式货号（${itemTitle(issue)}）`}
                      data-testid="pending-code-code"
                    />
                  </label>
                )}
                <label className={styles.resolveField}>
                  确认说明
                  <input
                    value={reason}
                    maxLength={500}
                    onChange={(event) => setReason(event.target.value)}
                    aria-label={`补录原因（${itemTitle(issue)}）`}
                  />
                </label>
                <Button type="button" variant="outline" disabled={manual.busy || !code.trim()}
                  onClick={assign} data-testid="pending-code-assign">
                  {candidate ? '确认采用此货号' : '补录正式货号'}
                </Button>
              </div>
              <p role="status" aria-live="polite" className={styles.manualStatus} data-testid="pending-code-status">
                {manual.message || (candidate
                  ? '确认后“货号待确认”事项自动关闭；不需要先采用整批来源资料。'
                  : '补录成功后“货号待确认”事项随之关闭。')}
              </p>
            </>
          )}
        </>
      ) : itemId ? (
        <p className={styles.hintNote}>
          该来源行缺少当前商品版本信息；请刷新后重新核对，不能自动生成测试码或替代货号。
        </p>
      ) : (
        <p className={styles.hintNote}>
          该来源行尚未对应商品；不能自动生成测试码或替代货号，请先在商品库人工建档或核对原表。
        </p>
      )}
    </div>
  );
}

/** 缺货号候选关系确认：先人工确认是同一商品，再把来源货号补到现有商品上。 */
function RelationConfirmBlock({
  issue,
  candidate,
}: {
  issue: ProductSourceIssueDto;
  candidate: CandidateRelation;
}) {
  const manual = useManualAction();
  const [code, setCode] = useState(candidate.sourceCode ?? '');
  const [reason, setReason] = useState('人工确认为同一商品后补录来源货号');
  const itemId = issue.itemId;
  const itemRevision = issue.itemRevision;
  const hasSourceCode = Boolean(candidate.sourceCode);
  const relationLabel = candidate.nameNormalized ? '名称一致（仅空格不同）' : '名称一致';
  const itemCodeLabel = candidate.itemCode ? `现有货号 ${candidate.itemCode}` : '货号待确认';
  const matchText = matchedByText(candidate.matchedBy);
  const sourceCodeText = candidate.sourceCode ?? '（来源未提供货号）';
  const itemNameText = candidate.itemName ?? '未命名商品';

  function confirmRelation() {
    const trimmedCode = code.trim();
    if (!itemId || itemRevision === null || !trimmedCode) return;
    const trimmedReason = reason.trim() || '人工确认为同一商品后补录来源货号';
    manual.run(
      () =>
        assignProductSourceCodeAction({
          requestId: crypto.randomUUID(),
          itemId,
          expectedRevision: itemRevision,
          code: trimmedCode,
          reason: trimmedReason,
        }),
      `已确认为同一商品并补录正式货号 ${trimmedCode}；原商品 UUID、修订历史与在途关联保留。`,
    );
  }

  return (
    <div className={styles.relationBlock} data-testid="product-source-relation-confirm">
      <p className={styles.relationTitle}>
        来源货号 {sourceCodeText} 与现有商品「{itemNameText}」（{itemCodeLabel}）{relationLabel}
      </p>
      {hasSourceCode ? (
        <p className={styles.pendingCodeDiff} data-testid="candidate-code-diff">
          <span>正式货号</span>
          <span className={styles.pendingCodeOld}>未填写</span>
          <span aria-hidden="true">→</span>
          <span className={styles.pendingCodeNew}>{candidate.sourceCode}</span>
        </p>
      ) : null}
      {matchText && <p className={styles.hintNote}>匹配依据：{matchText}。</p>}
      <p className={styles.hintNote}>
        确认同一商品后再补录货号；原商品 UUID、修订历史与在途关联保留，不会新建商品或自动绑定。
      </p>
      <p className={styles.relationWarning}>
        如不是同一商品：不要补录，先到商品库/原表核对；系统不会自动建档或绑定。
      </p>
      <div className={styles.resolveRow}>
        {!hasSourceCode && (
          <label className={styles.resolveField}>
            正式货号
            <input
              value={code}
              maxLength={50}
              placeholder="输入 ICE 正式货号"
              onChange={(event) => setCode(event.target.value)}
              aria-label={`候选关系确认正式货号（${itemNameText}）`}
              data-testid="candidate-code-code"
            />
          </label>
        )}
        <label className={styles.resolveField}>
          确认说明
          <input
            value={reason}
            maxLength={500}
            onChange={(event) => setReason(event.target.value)}
            aria-label={`候选关系确认说明（${itemNameText}）`}
          />
        </label>
        <Button
          type="button"
          variant="outline"
          disabled={manual.busy || !itemId || itemRevision === null || !code.trim()}
          title={!itemId || itemRevision === null ? '缺少商品或当前版本信息；请刷新后重试' : undefined}
          onClick={confirmRelation}
          data-testid="candidate-code-confirm"
        >
          {hasSourceCode ? '确认采用此货号' : '确认同一商品并补录货号'}
        </Button>
      </div>
      <p role="status" aria-live="polite" className={styles.manualStatus} data-testid="candidate-code-status">
        {manual.message || '确认后补录到现有商品；不确认不要补录。'}
      </p>
    </div>
  );
}

/** 已登记的人工决定：字段级暂不处理/人工口径/来源列解释 + 同号多行选择，可恢复处理。 */
function ManualDecisions({ dto }: { dto: ProductSourcePanelDto }) {
  const manual = useManualAction();
  const { fieldDecisions, duplicateDecisions } = dto.manualDecisions;
  const empty = fieldDecisions.length === 0 && duplicateDecisions.length === 0;

  return (
    <section aria-label="已登记的人工决定" className={pageStyles.subsection} data-testid="manual-decisions">
      <h3 className={pageStyles.subsectionTitle}>已登记的人工决定</h3>
      <p className={pageStyles.muted}>
        这里列出仍在生效的字段级决定与同号多行选择；恢复处理只撤销决定，下次读取或应用会重新提示，已写入的商品资料不会回滚。
      </p>
      {empty ? (
        <p className={pageStyles.muted} data-testid="manual-decisions-empty">当前没有登记的人工决定。</p>
      ) : (
        <>
          {fieldDecisions.length > 0 && (
            <ul className={styles.decisionList} aria-label="字段级人工决定">
              {fieldDecisions.map((decision) => {
                const ruleText = decision.action === 'interpret'
                  ? decision.ruleLabel ?? decision.rule
                  : null;
                return (
                  <li key={decision.decisionId} className={styles.decisionItem} data-testid="field-decision-item">
                    <p className={styles.decisionTitle}>
                      {decision.iceCode ?? decision.nameCn ?? '商品'} · {decision.fieldLabel} · {decision.actionLabel}
                      {decision.valueRaw ? ` → ${decision.valueRaw}` : ''}
                    </p>
                    {ruleText && (
                      <p className={styles.decisionMeta} data-testid="field-decision-rule">
                        解释规则：{ruleText}
                      </p>
                    )}
                    <p className={styles.decisionMeta}>
                      决定时间：{decision.decidedAtDisplay} · 原因：{decision.reason}
                      {decision.note ? ` · 备注：${decision.note}` : ''}
                    </p>
                    <Button type="button" variant="outline" disabled={manual.busy}
                      onClick={() => manual.run(
                        () => restoreProductSourceFieldAction({
                          requestId: crypto.randomUUID(),
                          decisionId: decision.decisionId,
                          note: '恢复处理',
                        }),
                        '已恢复处理；下次读取/应用会重新提示。',
                      )}
                      data-testid="field-decision-restore">
                      恢复处理
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
          {duplicateDecisions.length > 0 && (
            <ul className={styles.decisionList} aria-label="同号多行人工选择">
              {duplicateDecisions.map((decision) => {
                const shownFields = decision.chosenFields.slice(0, 4);
                const restCount = decision.chosenFields.length - shownFields.length;
                const fieldsSummary = shownFields.length > 0
                  ? `已选字段：${shownFields
                    .map((field) => `${field.fieldLabel}：${displayValue(field.value)}`)
                    .join('；')}${restCount > 0 ? `；等 ${restCount} 项` : ''}`
                  : null;
                return (
                  <li key={decision.decisionId} className={styles.decisionItem} data-testid="duplicate-decision-item">
                    <p className={styles.decisionTitle}>
                      {decision.iceCode} · {decision.chosenRowNumber === null
                        ? '以指定来源行为准'
                        : `以来源第 ${decision.chosenRowNumber} 行为准`}
                    </p>
                    {fieldsSummary && <p className={styles.decisionMeta}>{fieldsSummary}</p>}
                    <p className={styles.decisionMeta}>
                      决定时间：{decision.decidedAtDisplay}
                      {decision.note ? ` · 备注：${decision.note}` : ''}
                    </p>
                    <Button type="button" variant="outline" disabled={manual.busy}
                      onClick={() => manual.run(
                        () => restoreDuplicateSourceDecisionAction({
                          requestId: crypto.randomUUID(),
                          decisionId: decision.decisionId,
                          note: '恢复处理',
                        }),
                        '已恢复处理；下次读取/应用会重新提示。',
                      )}
                      data-testid="duplicate-decision-restore">
                      撤销选择
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
      <p role="status" aria-live="polite" className={styles.manualStatus} data-testid="manual-decisions-status">
        {manual.message}
      </p>
    </section>
  );
}


/* ------------------------------------------------------------------ *
 * 页面降级：无权限 / 读取失败时明确说出“没有读到”，不显示 0、不伪造空清单
 * ------------------------------------------------------------------ */

export function ProductSourcePanelFallback({ reason }: { reason: 'forbidden' | 'read_failed' }) {
  return (
    <section className={styles.fallbackPanel} aria-label="飞书商品来源不可用"
      data-testid="product-source-unavailable" role="alert">
      <h2 className={styles.fallbackTitle}>飞书商品来源</h2>
      {reason === 'forbidden' ? (
        <>
          <p className={styles.fallbackText}>当前账号无权读取飞书商品来源批次：未显示数量，也不当作 0 条或没有变化。</p>
          <p className={styles.fallbackText}>如需处理来源更新，请使用具备来源维护权限的账号；本页不隐藏按钮来假装已授权。</p>
        </>
      ) : (
        <>
          <p className={styles.fallbackText}>飞书商品来源读取失败（网络、传输或环境异常）：本次没有读到任何来源状态。</p>
          <p className={styles.fallbackText}>不显示数量、不补造批次，也不把失败当作“没有变化”；可刷新本页重试。</p>
        </>
      )}
    </section>
  );
}
