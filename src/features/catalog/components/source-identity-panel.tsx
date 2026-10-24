'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { prepareSourceFixtureCaptureAction, importSourceFixtureCaptureAction, registerSourceIdentityAction,
  reviseSourceIdentityAction, linkSourceObservationAction, recoverSourceIdentityRequestAction } from '../source-identity/actions';
import type { IdentityContext, IdentityMutationResult, IdentityStrategy, IdentitySystem, IdentityWorkspaceDto, LinkIdentityInput,
  ObservationField, RegisterIdentityInput, ReviseIdentityInput, SourceIdentityActionResult, SourceIdentityPanelDto,
  SourceScopeDto } from '../source-identity/types';
import styles from './catalog-content.module.css';

export interface IdentityWorkspaceView {
  enabled: boolean; scopes: SourceScopeDto[]; scopeId: string | null; workspace: IdentityWorkspaceDto | null;
  fixtures: { fixtureId: string; scopeId: string; label: string }[];
}
type Pending =
  | { kind: 'capture'; input: { fixtureId: string; previewId: string; requestId: string } }
  | { kind: 'register'; input: RegisterIdentityInput }
  | { kind: 'revise'; input: ReviseIdentityInput }
  | { kind: 'link'; input: LinkIdentityInput };
const text = (data: FormData, key: string) => String(data.get(key) ?? '');
function fieldValue(field: ObservationField | undefined) {
  if (!field) return '未观察到';
  return field.state === 'value' ? field.value : ({ empty: '明确空值', not_observed: '未观察到', parse_failed: '解析失败' })[field.state];
}
const stateLabel = { active: '已核实（本地样本）', review_required: '待复核', suspended: '身份暂停', revoked: '身份已撤销' };
const actionGuidance: Record<string, string> = {
  IDENTITY_PROOF_COVERAGE_REQUIRED: '原请求未保存：新证明未覆盖本次复核观测。请选择包含该来源的新采集证明和对应观测。',
  IDENTITY_FROZEN_SCOPE_CONTRADICTION: '原请求未保存：冻结观测的已知范围与来源身份范围冲突，未建立关联；原人工选择与历史保持。',
};

/* ------------------------------------------------------------------ *
 * 中文业务摘要（内部英文编码一律保留在“原始证据”展开层，facts 不变）
 * ------------------------------------------------------------------ */

const SYSTEM_LABELS: Record<IdentitySystem, string> = {
  bigseller: 'BigSeller（BS）', jushuitan: '聚水潭（JST）', feishu: '飞书',
};
const ENTITY_LABELS = { product_record: '商品记录', sku_record: 'SKU 记录' } as const;
const SCOPE_STATE_LABELS = {
  identity_ready: '范围可核实（仅本地样本）',
  unresolved: '范围未解析（不能据此核实）',
} as const;
const STRATEGY_LABELS: Record<IdentityStrategy, string> = {
  vendor_stable_id: '供应商稳定身份规则',
  scoped_business_key: '范围内业务身份规则',
};
const ACTION_LABELS: Record<string, string> = {
  import_capture: '导入来源观测', register: '登记来源身份', revise: '变更身份状态', link: '变更观测关联',
};
const REVIEW_STATE_LABELS: Record<string, string> = {
  manual_selected: '已有有效人工选择',
  pending_confirmation: '待确认',
  ignored: '已忽略（保留，不重新打开）',
  rejected: '已拒绝（保留，不重新打开）',
  outside_rules: '规则外（保留，不重新打开）',
};
const LINK_STATUS_LABELS = { linked: '关联有效', revoked: '已撤销（关联版本保留）' } as const;
const FIELD_LABELS: Record<string, string> = {
  vendorRecordId: '供应商记录ID', sku: '来源SKU', name: '来源名称', barcode: '条码',
  styleCode: '款式编码', productCode: '商品编码', specification: '规格', packaging: '包装',
  factory: '工厂', category: '分类', unit: '单位', cartonQuantity: '装箱数量',
};
const fieldLabel = (key: string) => FIELD_LABELS[key] ?? `其他字段 ${key}`;
const strategyLabel = (strategy: IdentityStrategy) => STRATEGY_LABELS[strategy] ?? '其他身份规则';
const reviewStateLabel = (state: string | null) => state ? REVIEW_STATE_LABELS[state] ?? '其他审阅状态（未记录）' : '未记录审阅状态';
const linkStatusLabel = (status: 'linked' | 'revoked') => LINK_STATUS_LABELS[status] ?? '状态未记录';


/** 预览失败给业务中文，不回传内部错误码。 */
const PREVIEW_FAILURE_LABELS: Record<string, string> = {
  IDENTITY_PREVIEW_CHANGED: '固定样本内容已变化，请重新准备预览。',
  IDENTITY_FORBIDDEN: '当前账号没有该范围的操作权限。',
  IDENTITY_MODULE_DISABLED: '该模块当前未启用。',
};
const previewFailureMessage = (code: string) =>
  PREVIEW_FAILURE_LABELS[code] ?? '预览未准备：当前授权或样本状态不满足条件，请核对后重试。';

/** 市场/仓库等上下文：只展示人能直接理解的业务摘要。 */
function contextSummary(context: IdentityContext): string {
  if (context.state === 'known') return `已解析：${context.canonical}`;
  if (context.state === 'unknown') return '未观察到';
  return '不适用';
}

/* ------------------------------------------------------------------ *
 * 候选来源标记的中文说明（供详情候选表等既有消费者按需复用，
 * 不改变 candidate-service 的算法或 conflicts 事实）
 * ------------------------------------------------------------------ */

export const CANDIDATE_BASIS_LABELS: Record<string, string> = {
  exact_code_hint: '货号完全一致（原文提示，不是正式身份核实）',
  exact_barcode_hint: '条码完全一致（原文提示）',
  name_hint: '名称相近（原文提示）',
  existing_choice: '已有有效人工选择',
};
export const CANDIDATE_CONFLICT_LABELS: Record<string, string> = {
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
export const describeCandidateBasis = (code: string) => CANDIDATE_BASIS_LABELS[code] ?? '其他候选依据（需人工核对）';
export const describeCandidateConflict = (code: string) => CANDIDATE_CONFLICT_LABELS[code] ?? '其他冲突提示（需人工复核）';

const SOURCES_PATH = '/dashboard/catalog/sources';
/** 来源处理页入口：保留授权范围（scope）、来源记录（record）与返回来源（from）。 */
function buildSourcesHref(params: { scopeId?: string; itemId?: string; recordId?: string; fromHref?: string }): string {
  const query = new URLSearchParams();
  if (params.scopeId) query.set('scope', params.scopeId);
  if (params.itemId) query.set('item', params.itemId);
  if (params.recordId) query.set('record', params.recordId);
  if (params.fromHref) query.set('from', params.fromHref);
  const search = query.toString();
  return search ? `${SOURCES_PATH}?${search}` : SOURCES_PATH;
}

/** This annotation is current scope-authorized evidence, never a replacement for the item revision. */
export function SourceIdentityAttachment({
  panel,
  itemId,
  fromHref,
}: {
  panel: SourceIdentityPanelDto & { enabled?: boolean };
  /** 当前商品标识（弹窗/直链都传）；无则不把来源页说成该商品的上下文。 */
  itemId?: string;
  /** 返回来源（弹窗=列表 URL，直链=当前详情 URL）。 */
  fromHref?: string;
}) {
  if (panel.enabled === false) return null;
  const sourcesHref = itemId ? buildSourcesHref({ itemId, fromHref }) : SOURCES_PATH;
  return <section className={styles.panel} aria-label="当前来源核实附注">
    <header className={styles.panelHeader}>
      <div className={styles.panelHeading}>
        <h2 className={styles.panelTitle}>当前来源核实附注</h2>
        <p className={styles.panelNote}>仅本地虚构样本核实；当前附注不改写当时资料版本及原人工选择，正式长期关系未启用。</p>
      </div>
      <span className={`${styles.badge} ${styles.badgeIndigo}`}>只读</span>
    </header>
    <div className={styles.panelBody}>
      <p className={styles.summaryLine} data-testid="identity-attachment-counts">授权范围 {panel.scopes.length} · 关联来源 {panel.sourceIdentity.length} · 真实长期身份核实 0</p>
      <ul className={styles.recordList}>
        {panel.sourceIdentity.map((record) => <li key={record.recordId} className={styles.record}>
          <p className={styles.recordTitle}>{stateLabel[record.state]} · 身份版本 {record.revision}</p>
          <p className={styles.recordMeta}>来源记录只读保留；本附注不改变原记录。</p>
        </li>)}
      </ul>
      <p className={styles.muted}>“已核实（本地样本）”只表示在本地验收样本中建立了来源记录；正式身份核实与长期关系仍未启用，本附注不批准商品目标。</p>
      <Link className={styles.backLink} href={sourcesHref}>查看来源身份与观测</Link>
    </div>
  </section>;
}

/** Pending intentions live only in component memory; recovery never mixes in new form values. */
export function SourceIdentityWorkspace({ view, fromHref, focusRecordId, itemId }: {
  view: IdentityWorkspaceView;
  /** 从详情跳入时保留返回来源；切范围不丢 scope，也不丢返回点。 */
  fromHref?: string;
  /** R8：待处理/详情带入的原来源记录；只在本组件已有数据内定位并高亮，不切换范围、不伪造记录。 */
  focusRecordId?: string;
  /** R8：待处理/详情带入的商品 UUID；切范围时随 href 保留，不新增任何读取、不改权限。 */
  itemId?: string;
}) {
  const router = useRouter();
  const pageRef = useRef<HTMLDivElement>(null);
  const [busy, transition] = useTransition();
  const [message, setMessage] = useState('');
  const [preview, setPreview] = useState<{ fixtureId: string; previewId: string } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const workspace = view.workspace;
  const locked = busy || pending !== null;
  const focusRecordLocated = Boolean(focusRecordId && workspace?.records.some((record) => record.recordId === focusRecordId));

  /* R8：定位并聚焦原记录。只做一次性滚动/聚焦，不加动画，也不改服务端读取范围。 */
  useEffect(() => {
    if (!focusRecordId || !focusRecordLocated) return;
    const target = pageRef.current?.querySelector<HTMLElement>(`[data-testid="identity-record-${focusRecordId}"]`);
    if (!target) return;
    target.scrollIntoView({ block: 'center' });
    target.focus({ preventScroll: true });
  }, [focusRecordId, focusRecordLocated]);

  function confirm(request: Pending) {
    setPending(null); setUncertain(false);
    if (request.kind === 'capture') setPreview(null);
    setMessage(`原请求已确认并保存；${request.kind === 'capture' ? '观测已原子保存' : '身份或关联事实已保存'}。正式关系仍未启用。`);
    router.refresh();
  }

  async function recoverOriginal(request: Pending) {
    setMessage('正在只读核对原请求；未创建新请求或采用新表单输入。');
    try {
      const result = await recoverSourceIdentityRequestAction({ action: request.kind === 'capture' ? 'import_capture' : request.kind,
        input: request.input });
      if (result.status === 'success' && result.data) { confirm(request); return; }
      if (result.status === 'success') { await submitOriginal(request); return; }
      setMessage('当前无法确认原结果，请保留原请求核对；这不表示原事务一定未保存。');
    } catch { setMessage('原请求核对尚未完成，请保留本页后重试。'); }
  }

  async function submitOriginal(request: Pending) {
    setPending(request);
    setMessage('正在核对原请求，请勿开始另一项操作。');
    try {
      let result: SourceIdentityActionResult<IdentityMutationResult>;
      switch (request.kind) {
        case 'capture': result = await importSourceFixtureCaptureAction(request.input); break;
        case 'register': result = await registerSourceIdentityAction(request.input); break;
        case 'revise': result = await reviseSourceIdentityAction(request.input); break;
        case 'link': result = await linkSourceObservationAction(request.input); break;
      }
      if (result.status === 'unknown') {
        setUncertain(true);
        setMessage('提交结果暂未确认。请核对/重试原请求，勿重新填写后创建新请求。');
        return;
      }
      if (uncertain && result.status !== 'success') {
        setMessage('当前权限或版本下无法确认原结果，请保留原请求核对；这不表示原事务一定未保存。');
        return;
      }
      setPending(null);
      setUncertain(false);
      if (result.status === 'success') {
        confirm(request);
      } else setMessage(actionGuidance[result.code] ?? '原请求未保存：当前授权或版本不满足条件，请核对后重试。');
      if (result.status !== 'success') router.refresh();
    } catch {
      setUncertain(true);
      setMessage('提交结果暂未确认。请使用“核对/重试原请求”，不要创建另一意图。');
    }
  }
  if (!view.enabled) return <section className={styles.panel} aria-label="来源身份未启用">
    <div className={styles.panelBody}><p className={styles.summaryLine}>来源身份模块未启用。既有冻结资料及人工选择保持。</p></div>
  </section>;
  const options = workspace?.records ?? [];
  const proofOptions = workspace?.proofs ?? [];
  const currentLinks = new Map<string, IdentityWorkspaceDto['links'][number]>();
  for (const link of workspace?.links ?? []) {
    if ((currentLinks.get(link.observationKey)?.linkRevision ?? 0) < link.linkRevision) currentLinks.set(link.observationKey, link);
  }
  return <div className={styles.page} ref={pageRef}>
    <section className={styles.legend} aria-label="阅读说明">
      <h2 className={styles.legendTitle}>阅读说明：先看业务摘要，页面只展示业务内容</h2>
      <ul className={styles.legendList}>
        <li>本页内容全部来自隔离虚构样本，不连接真实账号，也不产生正式长期来源关系。</li>
        <li>“已有有效人工选择”只表示原审阅决定当时选中的商品，只读保持；它不等于来源身份已核实，也不批准商品目标。</li>
        <li>来源、账号与仓库范围以授权范围名和每条观测摘要为准；日常界面只展示业务摘要；后台受控证据仍保留。</li>
      </ul>
    </section>
    <nav aria-label="授权来源范围" className={styles.actionRow}>{view.scopes.map((scope) => pending
      ? <span key={scope.scopeId} className={styles.muted} aria-disabled="true">{scope.displayName}</span>
      : <Link key={scope.scopeId} className={styles.backLink}
        href={buildSourcesHref({ scopeId: scope.scopeId, itemId, recordId: focusRecordId, fromHref })}>{scope.displayName}</Link>)}</nav>
    {focusRecordId && !focusRecordLocated && <p className={styles.muted} data-testid="identity-focus-unavailable">
      请求定位的来源记录不在当前授权范围的数据里：未切换范围，也不伪造记录；请核对记录标识或返回待处理索引。
    </p>}
    {!workspace ? <p data-testid="identity-unavailable">当前没有可查看的授权来源范围。</p> : <>
      <section className={styles.panel} aria-label="当前身份范围">
        <header className={styles.panelHeader}>
          <div className={styles.panelHeading}>
            <h2 className={styles.panelTitle}>{workspace.scope.displayName}</h2>
            <p className={styles.panelNote}>当前授权来源范围（只读）；来源系统、记录类型与范围状态如下。</p>
          </div>
          <span className={`${styles.badge} ${styles.badgeIndigo}`}>隔离样本</span>
        </header>
        <div className={styles.panelBody}>
          <dl className={styles.summaryGrid}>
            <div><dt>来源系统</dt><dd>{SYSTEM_LABELS[workspace.scope.system]}</dd></div>
            <div><dt>记录类型</dt><dd>{ENTITY_LABELS[workspace.scope.entityKind]}</dd></div>
            <div><dt>范围状态</dt><dd>{SCOPE_STATE_LABELS[workspace.scope.scopeState]}</dd></div>
            <div><dt>正式长期来源关系</dt><dd className={styles.notEnabled}>未启用（本批不做长期绑定）</dd></div>
            <div><dt>商品目标决定</dt><dd>尚未实施（本批不产生目标决定）</dd></div>
          </dl>
          <p className={styles.summaryLine} data-testid="identity-counts">观测 {workspace.observations.length} · 来源记录 {workspace.records.length} · 原审阅记录 {workspace.frozenHumanChoice.length} · 原有效人工选择 {workspace.frozenHumanChoice.filter((choice) => choice.reviewState === 'manual_selected' && choice.selectedItemId !== null).length}</p>
          <p className={styles.muted}>“原有效人工选择”是原审阅记录中已选中商品的条数，只读保持；它不代表正式身份核实，也不构成长期绑定。</p>
          <p className={styles.muted}>
            当前可查看本范围来源摘要{workspace.permissions.manage ? '，可执行维护动作' : '，仅可只读查看'}。
          </p>
        </div>
      </section>

      <section aria-label="固定样本摄取" className={styles.panel}>
        <header className={styles.panelHeader}>
          <div className={styles.panelHeading}>
            <h2 className={styles.panelTitle}>读取固定来源样本（虚构）</h2>
            <p className={styles.panelNote}>只准备与导入本地虚构样本，不接触真实来源。导入前会核对样本与来源范围；日常界面不展示文件或内部标识。</p>
          </div>
          <span className={styles.badge}>隔离数据</span>
        </header>
        <div className={styles.panelBody}>
          <form action={(data) => transition(async () => {
            const fixtureId = text(data, 'fixtureId');
            const result = await prepareSourceFixtureCaptureAction({ fixtureId });
            if (result.status === 'success') { setPreview({ fixtureId, previewId: result.data.previewId }); setMessage('本地样本预览已准备；核对通过，尚未导入。'); }
            else setMessage(previewFailureMessage(result.code));
          })}><fieldset disabled={locked || !workspace.permissions.manage} className={styles.fieldRow}>
            <label className={styles.field}>取样样本文件<select name="fixtureId" aria-label="取样样本文件">
              {view.fixtures.filter((fixture) => fixture.scopeId === workspace.scope.scopeId).map((fixture, index) => <option key={fixture.fixtureId} value={fixture.fixtureId}>本地样本 · 第 {index + 1} 份</option>)}
            </select></label><Button type="submit">准备来源观测预览</Button>
          </fieldset></form>
          {preview && <div data-testid="identity-preview" className={styles.subsection}><p className={styles.summaryLine}>样本观测预览已准备 · 尚未导入</p>
            <div className={styles.actionRow}><Button disabled={locked || !workspace.permissions.manage} onClick={() => transition(() => submitOriginal({ kind: 'capture', input: { ...preview, requestId: crypto.randomUUID() } }))}>原子导入来源观测</Button></div></div>}
          <p className={styles.muted}>预览会核对固定样本与来源范围；一致才允许导入。</p>
        </div>
      </section>

      <section aria-label="来源身份登记" className={styles.panel}>
        <header className={styles.panelHeader}>
          <div className={styles.panelHeading}>
            <h2 className={styles.panelTitle}>来源观测与身份登记</h2>
            <p className={styles.panelNote}>无可靠键只保留观测；名称、条码和行位置不能代替长期身份。登记不创建商品或目标决定。</p>
          </div>
          <span className={styles.badge}>维护动作在每条内</span>
        </header>
        <div className={styles.panelBody}>
          <ul className={styles.recordList}>
            {workspace.observations.map((observation) => <li key={observation.observationId} data-testid={`identity-observation-${observation.observationId}`} className={styles.record}>
              <h3 className={styles.recordTitle}>{fieldValue(observation.fields.name)} · {fieldValue(observation.fields.sku)}</h3>
              <dl className={styles.summaryGrid}>
                <div><dt>市场范围</dt><dd>{contextSummary(observation.marketContext)}</dd></div>
                <div><dt>仓库范围</dt><dd>{contextSummary(observation.warehouseContext)}</dd></div>
              </dl>
              {workspace.contracts.map((contract) => <p key={contract.contractId} className={styles.recordMeta}>
                {strategyLabel(contract.strategy)} · 第 {contract.revision} 版：
                {contract.keyFields.map((key) => `${fieldLabel(key)}=${fieldValue(observation.fields[key])}`).join('；')}
                {contract.keyFields.some((key) => observation.fields[key]?.state !== 'value') ? '；必要身份字段未齐，仅保留观测' : '；仍须证明与预期版本核对'}
              </p>)}
              <form action={(data) => transition(async () => {
                const expectedId = text(data, 'expectedRecord');
                const expectedRecord = options.find((record) => record.recordId === expectedId);
                await submitOriginal({ kind: 'register', input: { requestId: crypto.randomUUID(), scopeId: workspace.scope.scopeId,
                  observationId: observation.observationId, contractId: text(data, 'contractId'), proofId: text(data, 'proofId'),
                  expectedMatch: expectedRecord ? { kind: 'record', recordId: expectedRecord.recordId, revision: expectedRecord.revision } : { kind: 'none' }, reason: text(data, 'reason') } });
              })}><fieldset disabled={locked || !workspace.permissions.manage} className={styles.fieldRow}>
                <label className={styles.field}>身份核对规则<select name="contractId" aria-label="身份核对规则">{workspace.contracts.map((contract) => <option key={contract.contractId} value={contract.contractId}>{strategyLabel(contract.strategy)} 第{contract.revision}版</option>)}</select></label>
                <label className={styles.field}>核实证明<select name="proofId" aria-label="核实证明">{proofOptions.map((proof, index) => <option key={proof.evidenceId} value={proof.evidenceId}>来源证据 {index + 1} · 采集 {proof.collectedAt.slice(0, 10)}</option>)}</select></label>
                <label className={styles.field}>预期来源<select name="expectedRecord" aria-label="预期来源"><option value="">尚无已核实记录</option>{options.map((record, index) => <option key={record.recordId} value={record.recordId}>已核来源 {index + 1} · 第 {record.revision} 版</option>)}</select></label>
                <label className={styles.field}>登记理由<Input required name="reason" maxLength={1000} /></label><Button type="submit">核实来源身份</Button>
              </fieldset></form>
              <p className={styles.muted}>该条来源观测保留原记录与上下文；日常界面只展示业务摘要，不展示记录编码或完整字段。</p>
            </li>)}
          </ul>
        </div>
      </section>

      <section aria-label="来源记录与历史" className={styles.panel}>
        <header className={styles.panelHeader}>
          <div className={styles.panelHeading}>
            <h2 className={styles.panelTitle}>来源记录与复核</h2>
            <p className={styles.panelNote}>来源记录只在隔离样本内有效；原人工决定只读保持，来源身份核实不批准商品目标或正式关系。</p>
          </div>
          <span className={styles.badge}>历史只读</span>
        </header>
        <div className={styles.panelBody}>
          <ul className={styles.recordList}>
            {options.map((record) => {
              const contract = workspace.contracts.find((entry) => entry.contractId === record.currentContractId);
              const originIds = new Set([...currentLinks.values()].filter((link) => link.status === 'linked' && link.recordId === record.recordId && link.originKind === 'frozen').map((link) => link.originId));
              const choices = workspace.frozenHumanChoice.filter((choice) => originIds.has(choice.observationId));
              const targets = new Set(choices.filter((choice) => choice.reviewState === 'manual_selected' && choice.selectedItemId).map((choice) => choice.selectedItemId));
              return <li key={record.recordId} data-testid={`identity-record-${record.recordId}`}
                className={`${styles.record} ${focusRecordId === record.recordId ? styles.recordFocused : ''}`}
                tabIndex={focusRecordId === record.recordId ? -1 : undefined}
                aria-current={focusRecordId === record.recordId ? 'true' : undefined}>
                <h3 className={styles.recordTitle}>来源记录 · {stateLabel[record.state]}</h3>
                <dl className={styles.summaryGrid}>
                  <div><dt>来源状态</dt><dd>{stateLabel[record.state]}</dd></div>
                  <div><dt>身份版本</dt><dd><span data-testid="source-record-revision">{record.revision}</span></dd></div>
                  <div><dt>当前身份核对规则</dt><dd>{contract ? `${strategyLabel(contract.strategy)} · 第 ${contract.revision} 版` : '身份核对规则未记录'}</dd></div>
                  <div><dt>正式长期关系</dt><dd className={styles.notEnabled}>未启用（不产生长期绑定）</dd></div>
                </dl>
                <p className={styles.summaryLine}>原人工决定只读保持；“已核实（本地样本）”不等于真实来源核实或长期关系。</p>
                <section aria-label="该来源原人工决定" className={styles.subsection} data-testid="identity-record-frozen-choices">
                  <h4 className={styles.subsectionTitle}>原人工决定（只读）</h4>
                  <p className={styles.recordMeta}>{targets.size > 1 ? '该来源原选择目标冲突，待核；全部原决定保持，未产生新目标决定。' : '原人工选择保持；来源身份核实不批准商品目标或正式关系。'}</p>
                  {choices.length === 0 ? <p className={styles.muted}>该来源暂无已关联原审阅记录。</p> : <ul className={styles.recordList}>{choices.map((choice) => <li key={choice.decisionId} className={styles.record}>
                    <p className={styles.recordMeta}>{reviewStateLabel(choice.reviewState)} · {choice.selectedItemId ? '原决定已选中商品' : '原决定当时未选中商品'}</p>
                    <p className={styles.recordMeta}>聚水潭引用：{choice.selectedJushuitanRef ? '已记录' : '未提供'}</p>
                  </li>)}</ul>}
                </section>
                <form action={(data) => transition(() => {
                  const command = text(data, 'command') as ReviseIdentityInput['command'];
                  return submitOriginal({ kind: 'revise', input: { requestId: crypto.randomUUID(), scopeId: workspace.scope.scopeId, recordId: record.recordId,
                    expectedRecordRevision: record.revision, command, proofId: text(data, 'proofId'), reason: text(data, 'reason'),
                    ...(command === 'reverify' ? { contractId: text(data, 'contractId'), observationId: text(data, 'observationId'), expectedClaimId: record.activeClaimId } : {}) } });
                })}><fieldset disabled={locked || !workspace.permissions.manage} className={styles.fieldRow}>
                  <label className={styles.field}>身份操作<select name="command" aria-label="身份操作"><option value="open_review">提出重核</option><option value="suspend">暂停身份</option><option value="revoke">撤销身份</option><option value="reverify">新证明显式复核</option></select></label>
                  <label className={styles.field}>新证明<select name="proofId" aria-label="新证明">{proofOptions.map((proof, index) => <option key={proof.evidenceId} value={proof.evidenceId}>来源证据 {index + 1} · 采集 {proof.collectedAt.slice(0, 10)}</option>)}</select></label>
                  <label className={styles.field}>复核规则<select name="contractId" aria-label="复核规则">{workspace.contracts.map((contract) => <option key={contract.contractId} value={contract.contractId}>{strategyLabel(contract.strategy)} 第{contract.revision}版</option>)}</select></label>
                  <label className={styles.field}>复核观测<select name="observationId" aria-label="复核观测">{workspace.observations.map((observation, index) => <option key={observation.observationId} value={observation.observationId}>观测 {index + 1} · {fieldValue(observation.fields.sku)}</option>)}</select></label>
                  <label className={styles.field}>复核理由<Input required name="reason" maxLength={1000} /></label><Button type="submit">保存身份状态</Button>
                </fieldset></form>
                <p className={styles.muted}>该来源记录只读保留；日常界面不展示内部编号或完整记录。</p>
              </li>; })}
          </ul>
          <details className={styles.details}><summary>查看范围内身份历史</summary><p className={styles.recordMeta}>系统时间与来源业务时间分开保存，未观察到不会补造。以下为历史记录，只读。</p>
            <ul className={styles.recordList}>{workspace.history.map((entry) => <li key={entry.requestId} data-testid="identity-history-entry" className={styles.record}>
              <p className={styles.recordTitle}>{ACTION_LABELS[entry.action] ?? '身份/关联操作'} · {entry.recordId ? '来源记录变更' : '观测/关联操作'} · 版本 {entry.revision ?? '不改变记录本身'}</p>
              <p className={styles.recordMeta}>{entry.reason} · 操作者已记录 · 系统时间 <time dateTime={entry.recordedAt}>{entry.recordedAt}</time></p>
              <p className={styles.recordMeta}>来源业务时间 {entry.sourceEffectiveAt ?? '未观察到'}</p>
            </li>)}</ul>
          </details>
        </div>
      </section>

      <section aria-label="观测关联" className={styles.panel}>
        <header className={styles.panelHeader}>
          <div className={styles.panelHeading}>
            <h2 className={styles.panelTitle}>观测关联（不改商品目标）</h2>
            <p className={styles.panelNote}>把冻结原观测或本地样本观测关联到已核来源；关联不改变商品目标，也不建立长期关系。</p>
          </div>
          <span className={styles.badge}>维护动作在此区</span>
        </header>
        <div className={styles.panelBody}>
          <form action={(data) => transition(() => {
            const [kind, id] = text(data, 'origin').split(':');
            const record = options.find((entry) => entry.recordId === text(data, 'recordId'));
            if (!record) { setMessage('请先核实一个来源记录。'); return; }
            const previous = currentLinks.get(`${kind}:${id}`);
            const previousRecord = options.find((entry) => entry.recordId === previous?.recordId);
            return submitOriginal({ kind: 'link', input: { requestId: crypto.randomUUID(), scopeId: workspace.scope.scopeId,
              operation: text(data, 'operation') as 'link' | 'revoke', origin: { kind: kind as 'frozen' | 'identity', id }, recordId: record.recordId,
              expectedRecordRevision: record.revision, expectedLinkRevision: previous?.linkRevision ?? 0,
              ...(previousRecord && previousRecord.recordId !== record.recordId ? { expectedPreviousRecordRevision: previousRecord.revision } : {}),
              proofId: text(data, 'proofId'), reason: text(data, 'reason') } });
          })}><fieldset disabled={locked || !workspace.permissions.manage || !options.length} className={styles.fieldRow}>
            <label className={styles.field}>观测<select name="origin" aria-label="观测">{workspace.observations.map((observation, index) => <option key={observation.observationId} value={`identity:${observation.observationId}`}>本地样本观测 {index + 1}</option>)}
              {workspace.frozenHumanChoice.map((choice, index) => <option key={choice.decisionId} value={`frozen:${choice.observationId}`}>原人工选择 {index + 1}</option>)}</select></label>
            <label className={styles.field}>已核来源<select name="recordId" aria-label="已核来源">{options.map((record, index) => <option key={record.recordId} value={record.recordId}>已核来源 {index + 1} · 第 {record.revision} 版</option>)}</select></label>
            <label className={styles.field}>关联操作<select name="operation" aria-label="关联操作"><option value="link">关联观测</option><option value="revoke">撤销观测关联</option></select></label>
            <label className={styles.field}>关联证明<select name="proofId" aria-label="关联证明">{proofOptions.map((proof, index) => <option key={proof.evidenceId} value={proof.evidenceId}>来源证据 {index + 1} · 采集 {proof.collectedAt.slice(0, 10)}</option>)}</select></label>
            <label className={styles.field}>关联理由<Input required name="reason" maxLength={1000} /></label><Button type="submit">保存观测关联</Button>
          </fieldset></form>
          <ul className={styles.recordList}>{[...currentLinks.values()].map((link) => <li key={link.observationKey} data-testid="identity-link" className={styles.record}>
            <p className={styles.recordTitle}>{linkStatusLabel(link.status)} · {link.originKind === 'frozen' ? '冻结原观测' : '本地样本观测'} · 关联版本 {link.linkRevision}</p>
            <p className={styles.recordMeta}>系统时间 <time dateTime={link.recordedAt}>{link.recordedAt}</time></p>
            <p className={styles.muted}>关联版本与当时依据只读保留；日常界面不展示内部编号。</p>
          </li>)}</ul>
          <details className={styles.details}><summary>查看全部观测关联版本</summary>
            <ul className={styles.recordList}>{workspace.links.map((link) => <li key={`${link.observationKey}:${link.linkRevision}`} data-testid="identity-link-history" className={styles.record}>
              <p className={styles.recordTitle}>{linkStatusLabel(link.status)} · 关联版本 {link.linkRevision}</p>
              <p className={styles.recordMeta}>{link.reason} · 系统时间 <time dateTime={link.recordedAt}>{link.recordedAt}</time></p>
            </li>)}</ul>
          </details>
        </div>
      </section>

      <section aria-label="来源证明" className={styles.panel}>
        <header className={styles.panelHeader}>
          <div className={styles.panelHeading}>
            <h2 className={styles.panelTitle}>来源证明</h2>
            <p className={styles.panelNote}>按授权展示已保存的来源证明摘要；日常界面不提供文件下载。</p>
          </div>
          <span className={styles.badge}>只读</span>
        </header>
        <div className={styles.panelBody}>
          <ul className={styles.recordList}>{proofOptions.map((proof, index) => <li key={proof.evidenceId} data-testid="identity-evidence" className={styles.record}>
            <p className={styles.recordTitle}>来源证明 {index + 1}</p>
            <p className={styles.recordMeta}>采集时间 {proof.collectedAt} · 来源业务时间 {proof.sourceEffectiveAt ?? '未观察到'}（来源可用性 {proof.sourceAvailability === 'known' ? '已记录' : '未观察到'}）</p>
            <p className={styles.recordMeta}>来源证明已保存；日常界面不提供文件下载。</p>
          </li>)}</ul>
        </div>
      </section>
    </>}
    <p role="status" aria-live="polite" className={styles.summaryLine}>{message}</p>
    {pending && <section aria-label="身份原请求待核对" data-testid="identity-pending-request" className={styles.panel}>
      <header className={styles.panelHeader}>
        <div className={styles.panelHeading}>
          <h2 className={styles.panelTitle}>原请求结果待核对</h2>
          <p className={styles.panelNote}>仅核对以下原意图，新操作已暂停；新输入不作为已保存内容。请保留本页核对原请求。</p>
        </div>
        <span className={`${styles.badge} ${styles.badgeWarn}`}>未知结果</span>
      </header>
      <div className={styles.panelBody}>
        <p data-testid="identity-pending-input" className={styles.muted}>已保留原请求编号与原始意图；核对只读，不会自动重发。</p>
        <div className={styles.actionRow}><Button type="button" disabled={busy} onClick={() => transition(() => recoverOriginal(pending))}>核对/重试原请求</Button></div>
      </div>
    </section>}
  </div>;
}
