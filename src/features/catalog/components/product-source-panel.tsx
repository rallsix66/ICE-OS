'use client';

import { useState, useTransition } from 'react';
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
  refreshProductSourceAction,
  resolveProductSourceIssueAction,
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
 * 操作请求（结果未知时原请求由服务端保存；核对沿用原 requestId，不新建请求）
 * ------------------------------------------------------------------ */

type ActionOutcome = ProductSourceActionOutcome;

export function ProductSourcePanel({ dto }: { dto: ProductSourcePanelDto }) {
  const router = useRouter();
  const [busy, startTransition] = useTransition();
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState<PendingRequest | null>(null);
  const latest = dto.latest;
  const pendingSnapshot = dto.pending;
  const locked = isPanelLocked(busy, pending);
  const disabledReason = dto.actions.disabledReason;
  const counts = latest?.counts ?? null;
  const isLocalSnapshot = dto.source.mode === 'local_snapshot';
  const caution = latest ? batchStatusCaution(latest.status) : null;
  const showSimulationNotice = dto.source.simulation && (latest !== null || pendingSnapshot !== null);
  /** 首次应用只认“尚未应用的快照”；latest.snapshotToken 只用于重试最近批次。 */
  const applyToken = pendingSnapshot?.snapshotToken ?? null;
  const applyDisabledReason = applyToken && dto.actions.canApply
    ? null
    : disabledReason ?? '当前没有待应用的新来源快照。';

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
    <section className={pageStyles.panel} aria-label="飞书商品来源（本地模拟）" data-testid="product-source-panel">
      <header className={pageStyles.panelHeader}>
        <div className={pageStyles.panelHeading}>
          <h2 className={pageStyles.panelTitle}>飞书商品来源（本地模拟）</h2>
          <p className={pageStyles.panelNote}>
            来源：{dto.source.displayName} · 文档：{dto.source.documentLabel} · 工作表：{dto.source.sheetName}
          </p>
          <p className={pageStyles.panelNote}>
            {isLocalSnapshot
              ? '读取方式：本地模拟读取（未开通飞书 API）；只读取本地快照副本，不连接飞书账号。'
              : `读取方式：${dto.source.modeLabel}（只读）。`}
          </p>
        </div>
        <div className={styles.badgeCluster}>
          <span className={`${pageStyles.badge} ${pageStyles.badgeIndigo}`}>{dto.source.modeLabel}</span>
          {dto.source.simulation && <span className={`${pageStyles.badge} ${pageStyles.badgeWarn}`}>本地模拟</span>}
        </div>
      </header>

      <div className={pageStyles.panelBody}>
        <div className={pageStyles.actionRow} data-testid="product-source-actions">
          <Button type="button" variant="outline" onClick={refreshPreview} disabled={refreshDisabled}
            title={pending ? '请先核对/重试原请求，再读取新快照' : '读取本地最新快照并校验，只做预览，不写入商品资料'}>
            读取最新快照（仅预览，不写入）
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
              “应用本批”使用这一条快照；应用前可先“读取最新快照”核对摘要，待核对项不会自动改写商品。
            </p>
          </div>
        )}

        {showSimulationNotice && (
          <p className={styles.simulationNote} data-testid="product-source-simulation-notice">
            本地模拟变化，非飞书真实修改：本面板的批次与变化来自本地快照副本，用于验证来源更新链路。
          </p>
        )}

        {latest === null ? (
          <div className={pageStyles.emptyBox} data-testid="product-source-empty">
            <p className={pageStyles.emptyText}>尚未读取到飞书商品来源批次（不是读取失败，也不当作没有变化）。</p>
            <p className={pageStyles.muted}>可先“读取最新快照”生成只读预览；预览不写入商品资料。</p>
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
          {dto.issues.length === 0 ? (
            <p className={pageStyles.muted} data-testid="product-source-issues-empty">
              当前显示范围内没有待核对事项。
            </p>
          ) : (
            <ul className={styles.issueList}>
              {dto.issues.map((issue, index) => (
                <IssueCard key={`${issue.issueKey}-${index}`} issue={issue}
                  canResolve={pending === null} busy={busy} onResolve={resolveIssue} />
              ))}
            </ul>
          )}
        </section>

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
  canResolve,
  busy,
  onResolve,
}: {
  issue: ProductSourceIssueDto;
  canResolve: boolean;
  busy: boolean;
  onResolve: (issue: ProductSourceIssueDto, resolution: 'resolved' | 'ignored', note: string) => void;
}) {
  const [note, setNote] = useState('已在页面核对');
  const title = itemTitle(issue);
  const rowsText = rowNumbersText(issue.rows);
  const open = issue.reviewState === 'open';
  return (
    <li className={styles.issueItem} data-testid="product-source-issue">
      <div className={styles.issueHead}>
        <p className={styles.issueTitle}>{title}</p>
        <span className={`${pageStyles.badge} ${pageStyles.badgeWarn}`}>{issue.kindLabel}</span>
      </div>
      <p className={styles.issueDetail}>{issue.detailLabel}</p>
      {rowsText && <p className={styles.rowsLine}>{rowsText}</p>}
      <p className={styles.issueState}>核对状态：{issue.reviewStateLabel}</p>
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

/* ------------------------------------------------------------------ *
 * 页面降级：无权限 / 读取失败时明确说出“没有读到”，不显示 0、不伪造空清单
 * ------------------------------------------------------------------ */

export function ProductSourcePanelFallback({ reason }: { reason: 'forbidden' | 'read_failed' }) {
  return (
    <section className={styles.fallbackPanel} aria-label="飞书商品来源（本地模拟）不可用"
      data-testid="product-source-unavailable" role="alert">
      <h2 className={styles.fallbackTitle}>飞书商品来源（本地模拟）</h2>
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
