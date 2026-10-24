'use client';

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { prepareBaselineAction, publishBaselineAction, importFrozenObservationsAction,
  fetchCatalogAdminDecisionsAction, fetchCatalogAdminObservationsAction } from '../actions';
import type { getCatalogOverview } from '../service';
import styles from './catalog-content.module.css';

type Overview = Awaited<ReturnType<typeof getCatalogOverview>>;

type DecisionRow = {
  decisionId: string; entryKind: string; entryKey: string; observationId: string | null;
  selectedItemId: string | null; selectedJushuitanRef: string | null; reviewState: string | null;
  rawRef: string; summary: Record<string, unknown>;
};
type ObservationRow = {
  observationId: string; sourceSystem: string; entryKey: string; legacyCandidateId?: string | null;
  position: Record<string, unknown>; fields: Record<string, unknown>; reviewState: string | null;
  rawRef: string; selectedItemId: string | null; existingDecisionRef?: string | null; conflicts: string[];
};

type ReadErrorKind = 'network' | 'forbidden' | 'disabled' | 'read_failed';
type ReadError = { kind: ReadErrorKind; message: string };
type Chunk<Row> = {
  loading: boolean; error: ReadError | null; total: number; rows: Row[]; nextOffset: number; loaded: boolean; atEnd: boolean;
};
const emptyChunk = <Row,>(): Chunk<Row> => ({ loading: false, error: null, total: 0, rows: [], nextOffset: 0, loaded: false, atEnd: false });

/** 成功页追加：只把已验证的页接在已成功加载的记录后，失败页不追加、不跳页。空页视为已到末页。 */
function withPage<Row>(prev: Chunk<Row>, page: { total: number; rows: readonly unknown[] }, offset: number): Chunk<Row> {
  const rows = offset === 0 ? page.rows as unknown as Row[] : [...prev.rows, ...page.rows as unknown as Row[]];
  return { ...prev, error: null, loaded: true, total: page.total, rows,
    nextOffset: offset + page.rows.length, atEnd: page.rows.length === 0 };
}

/** 业务失败分类：无权限 / 未启用 / 其他读取失败必须可区分，不能都写成“读取失败”。 */
function classifyReadError(message: string): ReadError {
  if (/无权|权限|FORBIDDEN|未登录|停用/.test(message)) {
    return { kind: 'forbidden', message: '账号没有这一页的读取权限（系统拒绝）；不代表没有记录，也不当作 0 条。' };
  }
  if (/未启用|不可用|UNAVAILABLE|本地平台/.test(message)) {
    return { kind: 'disabled', message: '当前未启用：商品资料读取在此环境不可用；不当作 0 条。' };
  }
  return { kind: 'read_failed', message };
}

const DECISION_PAGE_SIZE = 20;
const OBSERVATION_PAGE_SIZE = 20;
const NETWORK_ERROR = '读取失败（网络或传输异常），请重试。已成功加载的记录保留，不会重复追加或跳页。';

/* ---------- 中文业务摘要（记录编码/JSON 一律保留在技术层） ---------- */

const ENTRY_KIND_LABELS: Record<string, string> = {
  candidate_snapshot: '候选选择决定（人工选择）',
  'history:batch_brush_preservation': '历史：两刷子待确认保留',
  'history:batch_bs_not_created': '历史：BS 未建档保留',
};
const entryKindLabel = (kind: string) => ENTRY_KIND_LABELS[kind] ?? '其他历史记录';

const REVIEW_STATE_LABELS: Record<string, string> = {
  manual_selected: '已有有效人工选择',
  pending_confirmation: '待确认',
  ignored: '已忽略（保留，不重新打开）',
  rejected: '已拒绝（保留，不重新打开）',
  outside_rules: '规则外（保留，不重新打开）',
};
const reviewStateLabel = (state: string | null) =>
  state ? REVIEW_STATE_LABELS[state] ?? '其他审阅状态' : '未记录审阅状态';

const SOURCE_LABELS: Record<string, string> = {
  bigseller: 'BigSeller（BS）', jushuitan: '聚水潭（JST）', feishu: '飞书',
};
const sourceLabel = (system: string) => SOURCE_LABELS[system] ?? '其他来源';

const CONFLICT_LABELS: Record<string, string> = {
  SOURCE_IDENTITY_UNVERIFIED: '来源身份未核实（通用提示，不是待办异常）',
  SOURCE_SKU_REPEATED_REVIEW_SCOPE: '同一来源 SKU 在本次范围重复，需按版本复核',
  BARCODE_SHARED_REVIEW_VERSION: '条码与其他记录共用，需按版本复核',
  EXISTING_CHOICE_OTHER_ITEM: '已有有效人工选择指向其他商品',
  PRESERVED_IGNORED: '原记录已忽略（保留，不重新打开）',
  PRESERVED_REJECTED: '原记录已拒绝（保留，不重新打开）',
  PRESERVED_OUTSIDE_RULES: '原记录在规则外（保留，不重新打开）',
  MANY_TO_ONE: '多条来源记录指向同一商品（保留原决定）',
  SPECIFICATION_DIFF_REVIEW_VERSION_OR_PACKAGING: '规格与已采用值不一致（可能版本或包装差异），需复核',
  PACKAGING_DIFFERENCE_REQUIRES_REVIEW: '包装与已采用值不一致，需复核',
};
const conflictLabel = (code: string) => CONFLICT_LABELS[code] ?? '其他冲突提示';

function observedRaw(fields: Record<string, unknown>, key: string): string | null {
  const field = fields[key];
  if (!field || typeof field !== 'object') return null;
  const entry = field as { state?: unknown; meaning?: unknown; raw?: unknown };
  return entry.state === 'observed' && entry.meaning === 'value' && typeof entry.raw === 'string' ? entry.raw : null;
}

function displayStatusLabel(status: Overview['displayStatus']): { text: string; detail: string } {
  switch (status) {
    case 'loaded':
      return { text: '已读取（本页只显示状态，不展开明细）', detail: '样表库存可读；明细在商品库列表与详情。' };
    case 'not_imported':
      return { text: '尚未导入（不是 0 条）', detail: '当前没有承接的样表库存，未读不等于 0。' };
    case 'read_failed':
      return { text: '读取失败（不代表 0 条）', detail: '样表库存读取失败；请保留本页并稍后重试，不要据此判断无库存。' };
    case 'forbidden':
      return { text: '当前账号无权读取', detail: '权限由系统校验；隐藏按钮不代表已授权。' };
    default:
      return { text: '状态未记录', detail: '未识别的读取状态，按“未确认”处理。' };
  }
}

/* ---------- 通用分页只读记录区 ---------- */

type Column<Row> = { key: string; label: string; render: (row: Row) => ReactNode };

function ReadOnlyRecords<Row>({
  ariaLabel, title, note, testIdPrefix, state, rowKey, columns, emptyNote, onRetry, onLoadMore, rawNote,
}: {
  ariaLabel: string; title: string; note: string; testIdPrefix: string; state: Chunk<Row>;
  rowKey: (row: Row, index: number) => string; columns: Column<Row>[]; emptyNote: string;
  onRetry: () => void; onLoadMore: () => void; rawNote: string;
}) {
  const error = state.error;
  const errorMessage = error
    ? error.kind === 'network' ? NETWORK_ERROR
      : error.kind === 'forbidden' ? error.message
        : error.kind === 'disabled' ? error.message
          : `读取失败：${error.message.replace(/[。.]$/, '')}。已成功加载的记录保留；可重试本页，若仍失败请核对当前权限与版本。`
    : null;
  const retryLabel = error?.kind === 'forbidden' ? '重新检查权限' : error?.kind === 'disabled' ? '重新检查启用状态' : '重试本页';
  return <section className={styles.panel} aria-label={ariaLabel}>
    <header className={styles.panelHeader}>
      <div className={styles.panelHeading}>
        <h2 className={styles.panelTitle}>{title}</h2>
        <p className={styles.panelNote}>{note}</p>
      </div>
      <span className={`${styles.badge} ${styles.badgeIndigo}`}>只读</span>
    </header>
    <div className={styles.panelBody}>
      {errorMessage && <div className={styles.errorBox} role="alert" data-testid={`${testIdPrefix}-error`}
        data-error-kind={error?.kind}>
        <p className={styles.errorText}>{errorMessage}</p>
        <div className={styles.actionRow}>
          <Button type="button" variant="outline" disabled={state.loading} onClick={onRetry}>
            {state.loading ? '读取中…' : retryLabel}
          </Button>
        </div>
      </div>}
      {!state.loaded && state.loading && <div className={styles.skeletonBlock} aria-busy="true" data-testid={`${testIdPrefix}-loading`}>
        <div className={styles.skeletonRow} />
        <div className={styles.skeletonRow} />
        <div className={`${styles.skeletonRow} ${styles.skeletonRowShort}`} />
        <p className={styles.skeletonNote}>正在读取第 1 批记录（只读）；失败会显示可重试的错误，不会当作空列表。</p>
      </div>}
      {!state.loaded && !state.loading && !state.error && <div className={styles.skeletonBlock} data-testid={`${testIdPrefix}-idle`}>
        <p className={styles.skeletonNote}>尚未读取记录（只读）。</p>
      </div>}
      {state.loaded && state.total === 0 && <div className={styles.emptyBox} data-testid={`${testIdPrefix}-empty`}>
        <p className={styles.emptyText}>没有符合条件的记录（已确认 0 条，不是读取失败）。</p>
        <p className={styles.muted}>{emptyNote}</p>
      </div>}
      {state.rows.length > 0 && <div className={styles.tableScroll}>
        <table className={styles.table}>
          <thead><tr>{columns.map((column) => <th key={column.key} scope="col">{column.label}</th>)}</tr></thead>
          <tbody>
            {state.rows.map((row, index) => <tr key={rowKey(row, index)} data-testid={`${testIdPrefix}-row`}>
              {columns.map((column) => <td key={column.key}>{column.render(row)}</td>)}
            </tr>)}
          </tbody>
        </table>
      </div>}
      {state.rows.length > 0 && <p className={styles.tableNote} data-testid={`${testIdPrefix}-count`}>
        已显示 {state.rows.length} / 共 {state.total} 条；只读浏览不会触发任何业务写操作。
      </p>}
      <div className={styles.statusRow}>
        {state.loaded && !state.atEnd && state.rows.length < state.total && <Button type="button" variant="outline" data-testid={`${testIdPrefix}-more`}
          disabled={state.loading} onClick={onLoadMore}>
          {state.loading ? '加载中…' : `加载更多（已显示 ${state.rows.length}/${state.total}）`}
        </Button>}
        {state.loaded && state.total > 0 && (state.atEnd || state.rows.length >= state.total) && <span className={styles.muted}>已全部读取。</span>}
      </div>
      {state.rows.length > 0 && <p className={styles.tableNote}>{rawNote}</p>}
    </div>
  </section>;
}

export function CatalogAdminPanel({ overview }: { overview: Overview }) {
  const router = useRouter();
  const pathname = usePathname();
  const [preview, setPreview] = useState<{ previewId: string; fullManifestCount: number; subsetManifestCount: number } | null>(null);
  const [message, setMessage] = useState('');
  const [unresolved, setUnresolved] = useState(false);
  const [busy, startTransition] = useTransition();
  const [decisions, setDecisions] = useState<Chunk<DecisionRow>>(() => ({ ...emptyChunk<DecisionRow>(), loading: true }));
  const [observations, setObservations] = useState<Chunk<ObservationRow>>(() => ({ ...emptyChunk<ObservationRow>(), loading: true }));
  const [evidenceQuery, setEvidenceQuery] = useState('');
  const publishRequest = useRef<{ requestId: string; previewId: string } | null>(null);
  const frozenRequest = useRef<{ requestId: string; approvedSnapshotId: 'feishu-partial-20261020-v2' } | null>(null);
  const decisionSeq = useRef(0);
  const observationSeq = useRef(0);

  /** Read-only page load. try/catch/finally keeps the last successful page, never leaves loading on. */
  const loadDecisions = useCallback(async (offset: number) => {
    const sequence = ++decisionSeq.current;
    setDecisions((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const result = await fetchCatalogAdminDecisionsAction(offset, DECISION_PAGE_SIZE);
      if (sequence !== decisionSeq.current) return;
      if (!result.success || !result.data) {
        setDecisions((prev) => ({ ...prev, error: classifyReadError(result.error ?? '系统未返回记录') }));
        return;
      }
      setDecisions((prev) => withPage(prev, result.data!, offset));
    } catch {
      if (sequence !== decisionSeq.current) return;
      setDecisions((prev) => ({ ...prev, error: { kind: 'network', message: NETWORK_ERROR } }));
    } finally {
      if (sequence === decisionSeq.current) setDecisions((prev) => (prev.loading ? { ...prev, loading: false } : prev));
    }
  }, []);

  const loadObservations = useCallback(async (offset: number) => {
    const sequence = ++observationSeq.current;
    setObservations((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const result = await fetchCatalogAdminObservationsAction(offset, OBSERVATION_PAGE_SIZE);
      if (sequence !== observationSeq.current) return;
      if (!result.success || !result.data) {
        setObservations((prev) => ({ ...prev, error: classifyReadError(result.error ?? '系统未返回记录') }));
        return;
      }
      setObservations((prev) => withPage(prev, result.data!, offset));
    } catch {
      if (sequence !== observationSeq.current) return;
      setObservations((prev) => ({ ...prev, error: { kind: 'network', message: NETWORK_ERROR } }));
    } finally {
      if (sequence === observationSeq.current) setObservations((prev) => (prev.loading ? { ...prev, loading: false } : prev));
    }
  }, []);

  /** 首屏只读：挂载后读取第 1 页。状态只在异步结果里写入，失败页可重试、不永久 loading。 */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [decisionRead, observationRead] = await Promise.allSettled([
          fetchCatalogAdminDecisionsAction(0, DECISION_PAGE_SIZE),
          fetchCatalogAdminObservationsAction(0, OBSERVATION_PAGE_SIZE),
        ]);
        if (cancelled) return;
        if (decisionRead.status === 'fulfilled') {
          const result = decisionRead.value;
          if (result.success && result.data) setDecisions((prev) => withPage(prev, result.data!, 0));
          else setDecisions((prev) => ({ ...prev, error: classifyReadError(result.error ?? '系统未返回记录') }));
        } else {
          setDecisions((prev) => ({ ...prev, error: { kind: 'network', message: NETWORK_ERROR } }));
        }
        if (observationRead.status === 'fulfilled') {
          const result = observationRead.value;
          if (result.success && result.data) setObservations((prev) => withPage(prev, result.data!, 0));
          else setObservations((prev) => ({ ...prev, error: classifyReadError(result.error ?? '系统未返回记录') }));
        } else {
          setObservations((prev) => ({ ...prev, error: { kind: 'network', message: NETWORK_ERROR } }));
        }
      } catch {
        if (cancelled) return;
        setDecisions((prev) => ({ ...prev, error: { kind: 'network', message: NETWORK_ERROR } }));
        setObservations((prev) => ({ ...prev, error: { kind: 'network', message: NETWORK_ERROR } }));
      } finally {
        if (!cancelled) {
          setDecisions((prev) => (prev.loading ? { ...prev, loading: false } : prev));
          setObservations((prev) => (prev.loading ? { ...prev, loading: false } : prev));
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const display = displayStatusLabel(overview.displayStatus);

  /* V5-05：数据来源入口按真实货号/名称识别商品，不要求用户输入内部记录编号。 */
  const itemOptions = (overview.display?.rows ?? [])
    .map((row) => ({ id: row.item.itemId, code: row.item.iceCode, name: row.item.nameCn }))
    .filter((entry) => entry.code || entry.name)
    .sort((left, right) => (left.code ?? '').localeCompare(right.code ?? '') || left.name.localeCompare(right.name));
  const itemById = new Map(itemOptions.map((entry) => [entry.id, entry]));
  const evidenceItemIds = Array.from(new Set([
    ...decisions.rows.map((row) => row.selectedItemId),
    ...observations.rows.map((row) => row.selectedItemId),
  ].filter((value): value is string => typeof value === 'string' && itemById.has(value)))).sort();
  const evidenceTarget = evidenceQuery && itemById.has(evidenceQuery) ? evidenceQuery : null;
  const evidenceReturnHref = pathname || '/dashboard/catalog/admin';
  const evidenceHrefFor = (itemId: string) =>
    `/dashboard/catalog?${new URLSearchParams({ detail: itemId, evidence: '1', from: evidenceReturnHref }).toString()}`;

  const decisionColumns: Column<DecisionRow>[] = [
    { key: 'kind', label: '记录类型', render: (row) => entryKindLabel(row.entryKind) },
    { key: 'review', label: '人工决定', render: (row) => reviewStateLabel(row.reviewState) },
    { key: 'item', label: '关联商品', render: (row) => row.selectedItemId
      ? <span>已关联商品</span>
      : <span className={styles.muted}>未关联商品</span> },
  ];

  const observationColumns: Column<ObservationRow>[] = [
    { key: 'source', label: '来源', render: (row) => sourceLabel(row.sourceSystem) },
    { key: 'name', label: '来源名称 / SKU', render: (row) => {
      const name = observedRaw(row.fields, 'name'), sku = observedRaw(row.fields, 'sku');
      return <span>{name ?? '名称未观察到'}<br /><span className={styles.codeCell}>{sku ?? 'SKU 未观察到'}</span></span>;
    } },
    { key: 'review', label: '审阅状态', render: (row) => reviewStateLabel(row.reviewState) },
    { key: 'selected', label: '现有选择', render: (row) => row.selectedItemId
      ? <span>已有人工选择</span>
      : <span className={styles.muted}>当前无人工选择（原决定保持）</span> },
    { key: 'conflicts', label: '冲突提示', render: (row) => row.conflicts.length
      ? <span>{row.conflicts.map(conflictLabel).join('；')}</span>
      : <span className={styles.muted}>无</span> },
  ];

  return <div className={styles.page}>
    <div className={styles.pageHeader}>
      <Link className={styles.backLink} href="/dashboard/catalog">返回商品资料浏览</Link>
      <p className={styles.eyebrow}>商品资料维护</p>
      <h1 className={styles.pageTitle}>商品资料维护</h1>
      <p className={styles.lead}>查看商品资料、库存摘要和已有处理记录；维护动作在页面底部的独立分区。</p>
      <nav className={styles.actionRow} aria-label="维护快捷入口">
        <Link className={styles.evidenceLink} href="/dashboard/catalog/issues" data-testid="admin-issues-open">打开待处理索引</Link>
        <span className={styles.muted}>待处理索引只读派生既有事实（不是审批流程），不创建也不关闭任何业务状态。</span>
      </nav>
    </div>

    <section className={styles.panel} aria-label="固定基线只读摘要">
      <header className={styles.panelHeader}>
        <div className={styles.panelHeading}>
          <h2 className={styles.panelTitle}>固定基线摘要</h2>
          <p className={styles.panelNote}>本区只读；数字来自当前承接的固定基线与资料库计数，不代表生产发布。</p>
        </div>
        <span className={`${styles.badge} ${styles.badgeIndigo}`}>只读摘要</span>
      </header>
      <div className={styles.panelBody}>
        <p className={styles.summaryLine} data-testid="catalog-counts">资料 {overview.stats.items} · 货号 {overview.stats.coded} · 冻结基线资料 {overview.release?.itemCount ?? 0} · 基线来源 {overview.stats.observations} · 有效人工选择 {overview.stats.choices} · 历史证据 {overview.stats.history}</p>
        <dl className={styles.summaryGrid}>
          <div>
            <dt>固定基线</dt>
            <dd>{overview.release ? '已发布固定基线' : '尚未发布固定基线'}</dd>
          </div>
          <div>
            <dt>冻结基线资料</dt>
            <dd>{overview.release ? `${overview.release.itemCount} 份` : '未发布'}</dd>
          </div>
          <div>
            <dt>基线来源观测</dt>
            <dd>{overview.release ? `${overview.release.observationCount} 条` : '未发布'}</dd>
          </div>
          <div>
            <dt>基线有效人工选择</dt>
            <dd>{overview.release ? `${overview.release.selectedCount} 条` : '未发布'}</dd>
          </div>
          <div>
            <dt>样表库存</dt>
            <dd className={overview.displayStatus === 'loaded' ? styles.positive : styles.notEnabled}>{display.text}</dd>
          </div>
          <div>
            <dt>金额</dt>
            <dd>本页不显示金额；读取与导出需要单独授权。</dd>
          </div>
        </dl>
        <p className={styles.muted}>{display.detail}</p>
        <p className={styles.tableNote}>
          {overview.release ? `已载入基线：${overview.release.itemCount} 款商品、${overview.release.observationCount} 条来源记录。` : '尚未载入可读基线。'}
          {' '}样表明细与金额不在本页展开。
        </p>
      </div>
    </section>

    <ReadOnlyRecords ariaLabel="人工决定与历史索引（只读，分页）" title="人工决定与历史索引"
      note="既有记录类型、人工决定状态与关联引用；只读，按页读取，不改变任何决定。"
      testIdPrefix="admin-decisions" state={decisions}
      rowKey={(row) => `decision-${row.decisionId}`} columns={decisionColumns}
      emptyNote="当前承接范围内没有任何人工决定或历史索引记录。"
      onRetry={() => void loadDecisions(decisions.nextOffset)}
      onLoadMore={() => void loadDecisions(decisions.nextOffset)}
      rawNote="只读分页；成功页按顺序追加，失败页不会重复追加或跳页。" />

    <ReadOnlyRecords ariaLabel="来源记录（只读，分页）" title="来源记录"
      note="来源系统、来源编码/名称、审阅状态与冲突提示；只读分页。"
      testIdPrefix="admin-observations" state={observations}
      rowKey={(row) => `observation-${row.observationId}`} columns={observationColumns}
      emptyNote="当前承接范围内没有任何来源观测记录。"
      onRetry={() => void loadObservations(observations.nextOffset)}
      onLoadMore={() => void loadObservations(observations.nextOffset)}
      rawNote="来源记录只读；金额按单独授权读取，本页不展示金额。" />

    <section className={styles.panel} aria-label="数据来源（授权维护入口）">
      <header className={styles.panelHeader}>
        <div className={styles.panelHeading}>
          <h2 className={styles.panelTitle}>数据来源</h2>
          <p className={styles.panelNote}>按商品查看来源系统、对应状态与资料差异。日常浏览不经过这里；本区只生成入口，不提前读取或缓存来源内容。</p>
        </div>
        <span className={`${styles.badge} ${styles.badgeIndigo}`}>授权维护入口</span>
      </header>
      <div className={styles.panelBody}>
        <div className={styles.evidenceEntry}>
          <div className={styles.fieldRow}>
            <label className={styles.field}>选择商品（按货号或名称）
              <select
                name="evidenceItem"
                aria-label="选择商品"
                value={evidenceTarget ?? ''}
                onChange={(event) => setEvidenceQuery(event.target.value)}
              >
                <option value="">请选择商品</option>
                {itemOptions.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.code ?? '待补货号'} · {entry.name}
                  </option>
                ))}
              </select>
            </label>
            {evidenceTarget
              ? <Link className={styles.evidenceLink} href={evidenceHrefFor(evidenceTarget)} data-testid="admin-evidence-open">打开数据来源</Link>
              : <span className={styles.muted}>选择商品后打开；数据来源会进入该商品的统一详情弹窗。</span>}
          </div>
          <div>
            <h3 className={styles.subsectionTitle}>已加载记录中的商品</h3>
            {evidenceItemIds.length > 0
              ? <ul className={styles.evidenceList} data-testid="admin-evidence-items">
                {evidenceItemIds.map((itemId) => {
                  const entry = itemById.get(itemId)!;
                  return <li key={itemId} className={styles.evidenceItem} data-testid={`admin-evidence-item-${itemId}`}>
                    <span className={styles.evidenceItemTitle}>{entry.code ?? '待补货号'} · {entry.name}</span>
                    <Link className={styles.evidenceLink} href={evidenceHrefFor(itemId)}>打开数据来源</Link>
                  </li>;
                })}
              </ul>
              : <p className={styles.muted}>先在上方记录中读取，或从商品清单选择商品。</p>}
          </div>
          <p className={styles.muted}>
            数据来源只读显示来源系统、对应状态、差异和价格出处；不提供技术下载或内部编号输入。
          </p>
        </div>
      </div>
    </section>

    <section className={styles.panel} aria-label="维护动作（会写入固定基线或冻结观测）">
      <header className={styles.panelHeader}>
        <div className={styles.panelHeading}>
          <h2 className={styles.panelTitle}>维护动作（会写入）</h2>
          <p className={styles.panelNote}>与只读浏览分离；以下动作会写入固定基线或冻结观测。既有权限、重复执行与结果未知的核对方式保持不变，允许的操作为原有三项。</p>
        </div>
        <span className={`${styles.badge} ${styles.badgeWarn}`}>写入</span>
      </header>
      <div className={styles.panelBody}>
        <div className={styles.maintenanceNote}>
          <p className={styles.maintenanceText}>只读浏览不需要执行任何动作。结果未知时再次点击会沿用原请求编号与原意图，不要关闭页面后盲目重复操作。</p>
        </div>
        <div className={styles.subsection}>
          <h3 className={styles.subsectionTitle}>1. 准备固定基线预览</h3>
          <dl className={styles.summaryGrid}>
            <div><dt>动作</dt><dd>按当前磁盘资料生成预览与产物清单（只读准备）。</dd></div>
            <div><dt>后果</dt><dd>不写入基线；资料变化后预览失效，发布前需重新准备。</dd></div>
            <div><dt>重复执行与结果未知</dt><dd>可以重复准备，不会写入任何内容；本步不承接基线。</dd></div>
          </dl>
          <div className={styles.actionRow}>
            <Button disabled={busy} onClick={() => startTransition(async () => {
              const result = await prepareBaselineAction();
              if (result.success) { setPreview(result.data!); setMessage('固定基线预览已准备，尚未发布'); }
              else setMessage(result.error ?? '操作未完成');
            })}>准备固定基线预览</Button>
          </div>
          {preview && <p className={styles.summaryLine} data-testid="manifest-counts">完整产物 {preview.fullManifestCount} 份；结构化子集 {preview.subsetManifestCount} 份。</p>}
        </div>
        <div className={styles.subsection}>
          <h3 className={styles.subsectionTitle}>2. 发布固定基线</h3>
          <dl className={styles.summaryGrid}>
            <div><dt>动作</dt><dd>把当前预览对应的固定基线原子承接。</dd></div>
            <div><dt>后果</dt><dd>改变当前承接状态；重导沿用既有记录，不覆盖已存在的资料版本。</dd></div>
            <div><dt>重复执行与结果未知</dt><dd>同一意图沿用原请求编号；结果未知时再次点击只核对原请求，不新建意图。</dd></div>
          </dl>
          <div className={styles.actionRow}>
            <Button disabled={busy || !preview} onClick={() => {
              if (!preview) return;
              startTransition(async () => {
                const input = publishRequest.current ?? { requestId: crypto.randomUUID(), previewId: preview.previewId };
                publishRequest.current = input;
                const result = await publishBaselineAction(input);
                if (result.outcome !== 'unknown') publishRequest.current = null;
                setUnresolved(result.outcome === 'unknown');
                setMessage(result.success ? '固定基线已原子承接；重导沿用既有记录' : (result.error ?? '操作未完成'));
                router.refresh();
              });
            }}>发布固定基线</Button>
          </div>
          {!preview && <p className={styles.muted}>尚未准备预览：本步不可执行（先完成第 1 步）；这不是失败，也没有承接任何内容。</p>}
        </div>
        <div className={styles.subsection}>
          <h3 className={styles.subsectionTitle}>3. 承接冻结飞书观测</h3>
          <dl className={styles.summaryGrid}>
            <div><dt>动作</dt><dd>承接冻结的飞书观测（部分列，159 个观测格）。</dd></div>
            <div><dt>后果</dt><dd>新增冻结观测；这次承接不核实资料完整性，不能当作货票余额。</dd></div>
            <div><dt>重复执行与结果未知</dt><dd>同一意图沿用原请求编号；结果未知时再次点击只核对原请求，不新建意图。</dd></div>
          </dl>
          <div className={styles.actionRow}>
            <Button variant="outline" disabled={busy || !overview.release} onClick={() => {
              if (!overview.release) return;
              startTransition(async () => {
                const input = frozenRequest.current ?? { requestId: crypto.randomUUID(), approvedSnapshotId: 'feishu-partial-20261020-v2' as const };
                frozenRequest.current = input;
                const result = await importFrozenObservationsAction(input);
                if (result.outcome !== 'unknown') frozenRequest.current = null;
                setUnresolved(result.outcome === 'unknown');
                setMessage(result.success ? '飞书冻结观测已承接：159格，完整性未核实' : (result.error ?? '操作未完成'));
                router.refresh();
              });
            }}>承接冻结飞书观测</Button>
          </div>
          {!overview.release && <p className={styles.muted}>当前没有已发布的固定基线：本步不可执行（不是 0 格）；先发布固定基线。</p>}
        </div>
        <p role="status" aria-live="polite" className={styles.summaryLine}>{message}</p>
        {unresolved && <p className={styles.muted}>请求结果待核对。再次点击沿用原请求与意图；请勿关闭页面后盲目重复操作。</p>}
      </div>
    </section>
  </div>;
}
