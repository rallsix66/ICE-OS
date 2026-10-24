'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { ActionResult } from '@/types/common';
import { ADOPTABLE_FIELD_KEYS, type AttachIdentityOption, type CatalogProofOption, type ConfirmationPreview,
  type NewItemAction, type NewItemMutationResult, type ProductObservationDto, type SensitiveHistoryDto, type SourceSlotPreviewDto } from '../new-item/types';
import { appendNewItemRevisionAction, assignNewItemCodeAction, associateExistingItemAction, attachSourceIdentityAction,
  classifyProductObservationAction, confirmNewItemAction, importProductCaptureAction, prepareAttachSourceIdentityAction,
  prepareCatalogProofAssociationAction, prepareNewItemConfirmationAction, prepareProductCaptureAction,
  prepareSourceSlotAssociationAction, readNewItemSensitiveHistoryAction, recoverNewItemRequestAction } from '../new-item/actions';
import type { getNewItemDetailPanel, getNewItemWorkspace } from '../new-item/service';
import type { FieldObservation } from '../types';
import { CATALOG_FIELD_LABELS } from '../local-display/field-labels';
import { CANDIDATE_CONFLICT_LABELS } from './source-identity-panel';
import styles from './catalog-content.module.css';

type Workspace = Awaited<ReturnType<typeof getNewItemWorkspace>>;
type Outcome = ActionResult<NewItemMutationResult> & { outcome?: 'unknown'; code?: string };
type Pending = { action: NewItemAction; input: Record<string, unknown> };
const operations: Record<NewItemAction, (input: unknown) => Promise<Outcome>> = {
  import_product_capture: importProductCaptureAction, classify_observation: classifyProductObservationAction,
  confirm_new_item: confirmNewItemAction, associate_existing_item: associateExistingItemAction,
  attach_source_identity: attachSourceIdentityAction, assign_initial_code: assignNewItemCodeAction,
  append_nonprice_revision: appendNewItemRevisionAction,
};
const text = (data: FormData, name: string) => String(data.get(name) ?? '');
function observedName(observation: ProductObservationDto) {
  const name = observation.fields.nameCn; return name?.state === 'observed' && name.meaning === 'value' ? name.raw : '名称尚未取得';
}
function fieldText(field: FieldObservation) {
  if (field.state === 'observed') return field.meaning === 'explicit_empty' ? '明确空串' : field.meaning === 'explicit_null' ? '明确空值' : field.raw;
  return ({ no_text: '未读到文本', not_read: '未读取', parse_failed: '解析失败' })[field.state];
}
/**
 * 风险提示的中文化（只改呈现，不改 candidate-service 的事实）：
 * 已知编码给中文说明；未知/自由文本原样保留，避免丢事实。
 */
function riskLabels(conflicts: string[] | undefined) {
  const labels = (conflicts ?? []).map((code) => CANDIDATE_CONFLICT_LABELS[code] ?? code);
  return labels.length ? labels.join('；') : '仍须核当前来源、目标历史和版本风险';
}

/* ---------- 中文业务摘要（记录编码保留在“技术说明（维护）”层） ---------- */

const CLASSIFICATION_LABELS: Record<string, string> = {
  new_item: '新品候选', item_update: '已有资料修订建议', external_sku: '外部新增 SKU', suspected_version: '疑似版本或换款',
};
const REVIEW_STATE_LABELS: Record<string, string> = {
  proposed: '建议', needs_review: '待核', approved: '已批准', rejected: '已拒绝', ignored: '已忽略',
};
const IDENTITY_STATE_LABELS: Record<string, string> = {
  active: '已核实（本地样本）', review_required: '待复核', suspended: '身份暂停', revoked: '身份已撤销',
};
const classificationLabel = (code: string | null | undefined) =>
  code ? CLASSIFICATION_LABELS[code] ?? '其他分类（未记录）' : '尚未分类';
const reviewStateLabel = (code: string | null | undefined) =>
  code ? REVIEW_STATE_LABELS[code] ?? '其他复核状态（未记录）' : '未批准';
const identityStateLabel = (code: string | null | undefined) =>
  code ? IDENTITY_STATE_LABELS[code] ?? '已核本地事实' : '已核本地事实';
const fieldLabel = (key: string) => CATALOG_FIELD_LABELS[key] ?? '其他资料字段（其他资料字段）';
const originKindLabel = (kind: string) => ({
  created: '本批新建', associated_existing: '关联已有商品', source_attached: '后补来源身份',
} as Record<string, string>)[kind] ?? '已关联商品';
const PENDING_ACTION_LABELS: Record<string, string> = {
  import_product_capture: '导入商品观测', classify_observation: '保存分类', confirm_new_item: '确认新增商品',
  associate_existing_item: '关联已有商品', attach_source_identity: '后补来源身份',
  assign_initial_code: '保存首次货号', append_nonprice_revision: '保存非价格修订',
};
const pendingActionLabel = (action: string) => PENDING_ACTION_LABELS[action] ?? '资料操作';

export function NewItemIntake({ data, returnHref, focusObservationId, itemId }: {
  data: Workspace;
  /** R8：页面级安全返回点（仅站内路径，由页面校验后传入），渲染为“返回原位置”入口。 */
  returnHref?: string;
  /** R8：待处理/详情带入的原观测；只在当前已有数据内定位并高亮，不切换范围、不伪造观测。 */
  focusObservationId?: string;
  /** R8：待处理/详情带入的商品 UUID；切范围时随 href 保留，不新增读取、不改权限。 */
  itemId?: string;
}) {
  const router = useRouter(), [busy, startTransition] = useTransition();
  const pageRef = useRef<HTMLDivElement>(null);
  const [message, setMessage] = useState(''), [pending, setPending] = useState<Pending | null>(null);
  const [saved, setSaved] = useState<NewItemMutationResult | null>(null);
  const [fixtureId, setFixtureId] = useState(data.fixtures.find((fixture) => fixture.scopeId === data.scopeId)?.approvedFixtureId ?? '');
  const [capturePreview, setCapturePreview] = useState<Awaited<ReturnType<typeof prepareProductCaptureAction>>['data'] | null>(null);
  const [history, setHistory] = useState<SensitiveHistoryDto | null>(null);
  const workspace = data.workspace;
  const focusObservationLocated = Boolean(focusObservationId && workspace?.observations.some((observation) => observation.observationId === focusObservationId));

  /* R8：定位并聚焦原观测。只做一次性滚动/聚焦，不加动画，也不改服务端读取范围。 */
  useEffect(() => {
    if (!focusObservationId || !focusObservationLocated) return;
    const target = pageRef.current?.querySelector<HTMLElement>(`[data-testid="product-observation-${focusObservationId}"]`);
    if (!target) return;
    target.scrollIntoView({ block: 'center' });
    target.focus({ preventScroll: true });
  }, [focusObservationId, focusObservationLocated]);
  async function send(request: Pending) {
    setPending(request); setMessage('正在提交固定原意图，请勿发起另一操作。');
    try {
      const result = await operations[request.action](request.input);
      if (result.outcome === 'unknown') { setMessage(result.error ?? '提交结果暂未确认。'); return; }
      setPending(null);
      if (result.success) { setSaved(result.data ?? null); setMessage('本次操作已保存；历史沿原商品记录保留。'); router.refresh(); }
      else setMessage(result.error ?? '本次操作未完成。');
    } catch { setMessage('提交结果暂未确认。请独立核对原请求，勿创建新请求。'); }
  }
  async function reconcile() {
    if (!pending) return;
    try {
      const result = await recoverNewItemRequestAction(pending);
      if (!result.success) { setMessage('原请求核对未完成，仍保留未知状态与原意图。'); return; }
      if (result.data) { setSaved(result.data); setPending(null); setMessage('已只读核实原请求成功，未重复执行。'); router.refresh(); }
      else await send(pending);
    } catch { setMessage('原请求尚无法确认，仍保留原意图。'); }
  }
  if (!data.enabled) return <section data-testid="new-item-intake" className={styles.panel} aria-label="持续新品资料未启用">
    <div className={styles.panelBody}>
      <h1 className={styles.pageTitle}>持续新品资料</h1>
      <p className={styles.emptyText}>该模块当前未启用；既有冻结资料与人工选择保持，不当作 0 项。</p>
      <p className={styles.muted}><Link className={styles.backLink} href="/dashboard/catalog">返回商品资料</Link></p>
    </div>
  </section>;
  if (!workspace) return <section data-testid="new-item-intake" className={styles.panel} aria-label="持续新品资料范围不可用">
    <div className={styles.panelBody}>
      <h1 className={styles.pageTitle}>持续新品资料</h1>
      <p className={styles.emptyText}>当前账号没有可用的来源范围（不是读取失败，也不是 0 项）。请从有权限的范围进入。</p>
      <p className={styles.muted}><Link className={styles.backLink} href="/dashboard/catalog">返回商品资料</Link></p>
    </div>
  </section>;
  const locked = busy || pending !== null, canPublish = workspace.permissions.manage && workspace.permissions.publish;
  const scopeFixtures = data.fixtures.filter((fixture) => fixture.scopeId === data.scopeId);
  return <div data-testid="new-item-intake" className={styles.page} ref={pageRef}>
    <header className={styles.pageHeader}>
      <p className={styles.eyebrow}>新品处理 · 固定虚构来源</p>
      <p className={styles.lead}>
        逐条查看固定来源样本，四类分流后决定建档、沿用或后补来源。分类只是建议，不等于建档决定；
        正式长期来源关系未启用，本页不接触真实账号。
      </p>
      <p><Link className={styles.backLink} href="/dashboard/catalog">返回商品资料</Link>
        {returnHref && <>{' · '}<Link className={styles.backLink} href={returnHref} data-testid="new-item-return">返回原位置</Link></>}</p>
    </header>
    {focusObservationId && !focusObservationLocated && <p className={styles.muted} data-testid="new-item-focus-unavailable">
      请求定位的原观测不在当前授权范围数据里：未切换范围，也不伪造观测；请核对观测标识或返回待处理索引。
    </p>}

    <section className={styles.panel} aria-label="来源范围与固定样本">
      <header className={styles.panelHeader}>
        <div className={styles.panelHeading}>
          <h2 className={styles.panelTitle}>来源范围与固定样本</h2>
          <p className={styles.panelNote}>先确认授权来源范围，再读取该范围的固定样本；准备预览不写入任何业务事实，导入才保存观测。</p>
        </div>
        <span className={`${styles.badge} ${styles.badgeIndigo}`}>隔离数据</span>
      </header>
      <div className={styles.panelBody}>
        <div className={styles.fieldRow}>
          <label className={styles.field}>来源范围<select aria-label="来源范围" value={data.scopeId ?? ''} disabled={locked}
            onChange={(event) => {
              const params = new URLSearchParams({ scope: event.target.value });
              if (itemId) params.set('item', itemId);
              if (returnHref) params.set('from', returnHref);
              if (focusObservationId) params.set('observation', focusObservationId);
              router.push(`/dashboard/catalog/intake?${params.toString()}`);
            }}>{data.scopes.map((scope) => <option key={scope.scopeId} value={scope.scopeId}>{scope.displayName}</option>)}</select></label>
          <label className={styles.field}>取样商品资料<select aria-label="取样商品资料" value={fixtureId} disabled={locked} onChange={(event) => { setFixtureId(event.target.value); setCapturePreview(null); }}>
            {scopeFixtures.map((fixture, index) => <option key={fixture.approvedFixtureId} value={fixture.approvedFixtureId}>样本 · 第 {index + 1} 份</option>)}</select></label>
          <Button disabled={locked || !workspace.permissions.manage || !fixtureId} onClick={() => startTransition(async () => {
            const result = await prepareProductCaptureAction({ approvedFixtureId: fixtureId });
            if (result.success) { setCapturePreview(result.data); setMessage('商品观测预览已固定，尚未导入。'); } else setMessage(result.error ?? '预览未完成。');
          })}>准备商品观测预览</Button>
          {capturePreview && <Button disabled={locked || !workspace.permissions.manage} onClick={() => startTransition(() => send({ action: 'import_product_capture',
            input: { requestId: crypto.randomUUID(), approvedFixtureId: capturePreview.approvedFixtureId, previewId: capturePreview.previewId } }))}>导入商品观测</Button>}
        </div>
        {capturePreview && <p data-testid="product-capture-preview" className={styles.summaryLine}>
          已固定观测预览：{capturePreview.observationCount} 条观测 · 尚未导入
        </p>}
        <p className={styles.muted}>本地验收样本，不代表真实来源；预览只核对固定样本与覆盖范围，日常界面不展示内部编码。</p>
      </div>
    </section>

    <section className={styles.panel} aria-label="本次操作状态">
      <div className={styles.panelBody}>
        <p role="status" aria-live="polite" data-testid="new-item-status" className={styles.summaryLine}>
          {message || '尚未执行操作；逐条观测可分别处理。'}
        </p>
        {saved?.itemId && <p data-testid="new-item-result" data-item-id={saved.itemId} className={styles.summaryLine}>
          已保存商品：<Link className={styles.backLink} href={`/dashboard/catalog?${new URLSearchParams({ detail: saved.itemId, ...(returnHref ? { from: returnHref } : {}) }).toString()}`}>打开已保存商品</Link>
          {' '}· 资料版本 {saved.revision} · {saved.created ? '首次建档' : '沿用原记录'}
        </p>}
        {pending && <section data-testid="new-item-request-recovery" aria-label="独立核对原请求" className={styles.emptyBox}>
          <p className={styles.emptyText}>结果未知：{pendingActionLabel(pending.action)} · 已保留原操作意图</p>
          <p className={styles.muted}>原意图只保留在本页内存，新操作已暂停；核对不依赖任何必填表单，也不新建请求。</p>
          <div className={styles.actionRow}><Button type="button" disabled={busy} onClick={() => startTransition(reconcile)}>独立核对原请求</Button></div>
        </section>}
      </div>
    </section>

    {workspace.observations.length === 0
      ? <section className={styles.panel} aria-label="当前范围的商品观测">
        <div className={styles.panelBody}>
          <p className={styles.emptyText}>当前授权范围没有商品观测（已确认 0 条，不是读取失败）。</p>
          <p className={styles.muted}>可以先读取固定样本，或核对该范围是否已导入观测。</p>
        </div>
      </section>
      : workspace.observations.map((observation) => <ObservationEditor key={`${observation.observationId}:${observation.classification?.revision ?? 0}:${observation.origin?.originId ?? ''}`}
        observation={observation} scopeId={workspace.scope.scopeId} locked={locked} canManage={workspace.permissions.manage} canPublish={canPublish}
        focused={focusObservationId === observation.observationId} returnHref={returnHref}
        proofOptions={data.catalogProofOptions.filter((option) => option.observationId === observation.observationId)}
        attachOptions={data.attachOptions.filter((option) => option.observationId === observation.observationId)}
        report={setMessage} submit={(request) => startTransition(() => send(request))} />)}

    <section aria-label="来源历史" className={styles.panel}>
      <header className={styles.panelHeader}>
        <div className={styles.panelHeading}>
          <h2 className={styles.panelTitle}>来源历史</h2>
          <p className={styles.panelNote}>部分历史需要额外授权；无权限时保持不可读，不当作 0 条。</p>
        </div>
        <span className={`${styles.badge} ${styles.badgeWarn}`}>需授权</span>
      </header>
      <div className={styles.panelBody}>
        <div className={styles.actionRow}>
          <Button disabled={busy} variant="outline" onClick={() => startTransition(async () => {
            setHistory(null);
            const result = await readNewItemSensitiveHistoryAction({ scopeId: workspace.scope.scopeId, observationId: null, projection: 'sensitive_history' });
            if (result.success) setHistory(result.data ?? null); else setMessage(result.error ?? '无权读取来源历史。');
          })}>读取来源历史（需授权）</Button>
        </div>
        {history && workspace.permissions.read && workspace.permissions.amount && workspace.permissions.evidence && (
          <ul className={styles.recordList} data-testid="sensitive-product-history">
            {history.events.map((event, index) => (
              <li key={`${event.recordedAt}-${index}`} className={styles.record}>
                <p className={styles.recordTitle}>来源历史 {index + 1}</p>
                <p className={styles.recordMeta}>{event.privateReason} · {event.recordedAt.slice(0, 16).replace('T', ' ')}</p>
              </li>
            ))}
          </ul>
        )}
        <ul className={styles.recordList}>{workspace.captures.map((capture, index) => <li key={capture.captureId} className={styles.record}>
          <p className={styles.recordTitle}>来源证据 {index + 1}</p>
          <p className={styles.recordMeta}>来源证明已保存；日常界面不提供文件下载。</p>
        </li>)}</ul>
      </div>
    </section>
  </div>;
}

function ObservationEditor({ observation, scopeId, locked, canManage, canPublish, proofOptions, attachOptions, focused = false, returnHref, report, submit }: {
  observation: ProductObservationDto; scopeId: string; locked: boolean; canManage: boolean; canPublish: boolean;
  proofOptions: CatalogProofOption[]; attachOptions: AttachIdentityOption[]; focused?: boolean; returnHref?: string;
  report: (message: string) => void; submit: (request: Pending) => void;
}) {
  const confirmForm = useRef<HTMLFormElement>(null);
  const [preview, setPreview] = useState<ConfirmationPreview | null>(null), [slot, setSlot] = useState<SourceSlotPreviewDto | null>(null);
  const [proof, setProof] = useState<CatalogProofOption | null>(null), [attach, setAttach] = useState<AttachIdentityOption | null>(null);
  const [preparing, startPreparing] = useTransition();
  const blocked = locked || preparing;
  return <section data-testid={`product-observation-${observation.observationId}`} data-record-pointer={observation.recordPointer}
    className={`${styles.panel} ${focused ? styles.panelFocused : ''}`} tabIndex={focused ? -1 : undefined}
    aria-current={focused ? 'true' : undefined}>
    <header className={styles.panelHeader}>
      <div className={styles.panelHeading}>
        <h2 className={styles.panelTitle}>{observedName(observation)}</h2>
        <p className={styles.panelNote}>逐条分流这一条来源观测；分类与关联都保留原记录，不覆盖已有关联。</p>
      </div>
      <span className={`${styles.badge} ${observation.origin ? styles.badgeIndigo : ''}`}>
        {observation.origin ? '已关联商品' : '尚未建档或关联'}
      </span>
    </header>
    <div className={styles.panelBody}>
      <dl className={styles.summaryGrid}>
        <div><dt>当前分类</dt><dd>{classificationLabel(observation.classification?.classification)} · {reviewStateLabel(observation.classification?.reviewState)}</dd></div>
        <div><dt>目标商品</dt><dd>{observation.origin
          ? <Link className={styles.backLink} href={`/dashboard/catalog?${new URLSearchParams({ detail: observation.origin.itemId, ...(returnHref ? { from: returnHref } : {}) }).toString()}`}>已有商品（{originKindLabel(observation.origin.originKind)}）</Link>
          : '尚未建档或关联'}</dd></div>
        <div><dt>范围内来源身份</dt><dd>{observation.currentSource
          ? `${identityStateLabel(observation.currentSource.state)} · 身份版本 ${observation.currentSource.revision}`
          : '尚无已核实身份'}</dd></div>
        <div><dt>正式长期关系</dt><dd className={styles.notEnabled}>未启用（不建立长期绑定）</dd></div>
      </dl>
      <dl className={styles.summaryGrid} data-testid="product-observation-fields">
        {Object.entries(observation.fields).map(([key, field]) => <div key={key}>
          <dt>{fieldLabel(key)}</dt><dd>{fieldText(field)}</dd>
        </div>)}
      </dl>
      <p data-testid="product-risk" className={styles.recordMeta}>{riskLabels(observation.sourceDisposition.conflicts)}</p>

      <form action={(form) => {
        const target = text(form, 'targetItemId'), revision = text(form, 'targetRevision');
        submit({ action: 'classify_observation', input: { requestId: crypto.randomUUID(), scopeId, observationId: observation.observationId,
          expectedClassificationRevision: observation.classification?.revision ?? 0, classification: text(form, 'classification'), reviewState: text(form, 'reviewState'),
          proposedItemId: target || null, expectedItemRevision: revision ? Number(revision) : null, proposedFieldKeys: [],
          expectedSourceSnapshot: observation.currentSource ? { recordId: observation.currentSource.recordId, revision: observation.currentSource.revision, claimId: observation.currentSource.claimId } : null,
          privateReason: text(form, 'privateReason') } });
      }}><fieldset disabled={blocked || !canManage} className={styles.formFieldset}><legend>四类分流</legend>
        <div className={styles.fieldRow}>
          <label className={styles.field}>分类<select name="classification" aria-label="分类" defaultValue="new_item"><option value="new_item">新品候选</option><option value="item_update">已有资料修订建议</option><option value="external_sku">外部新增SKU</option><option value="suspected_version">疑似版本或换款</option></select></label>
          <label className={styles.field}>复核状态<select name="reviewState" defaultValue="proposed"><option value="proposed">建议</option><option value="needs_review">待核</option></select></label>
          <label className={styles.field}>建议目标商品编号（修订建议必填）<Input name="targetItemId" /></label>
          <label className={styles.field}>目标资料版本<Input name="targetRevision" type="number" min={1} /></label>
        </div>
        <label className={styles.field}>分类理由<Input name="privateReason" required defaultValue="本地虚构资料分类核对" maxLength={1000} /></label>
        <div className={styles.actionRow}><Button type="submit">保存分类</Button></div>
      </fieldset></form>

      <form ref={confirmForm} onChange={(event) => { if (event.target instanceof HTMLInputElement && ['adoptedFieldKeys', 'initialCode'].includes(event.target.name)) setPreview(null); }}
        action={(form) => { if (preview) submit({ action: 'confirm_new_item', input: { ...preview, requestId: crypto.randomUUID(), privateReason: text(form, 'privateReason') } }); }}>
        <fieldset disabled={blocked || !canPublish} className={styles.formFieldset}><legend>明确新品采用</legend>
          <p>仅勾选本次确认为真实值的字段；未勾选字段不写入。人工货号可留空，不自动编号。</p>
          <div className={styles.checkRow}>{ADOPTABLE_FIELD_KEYS.map((field) => <label key={field} className={styles.checkLabel}><input name="adoptedFieldKeys" type="checkbox" value={field} defaultChecked={field === 'nameCn'} /> {fieldLabel(field)}</label>)}</div>
          <label className={styles.field}>人工首次货号（可空，不自动编号）<Input name="initialCode" maxLength={50} /></label>
          <label className={styles.field}>新品确认理由<Input name="privateReason" required defaultValue="明确确认本次虚构新品" maxLength={1000} /></label>
          <div className={styles.actionRow}><Button type="button" onClick={() => startPreparing(async () => {
            if (!confirmForm.current) return; const values = new FormData(confirmForm.current);
            const result = await prepareNewItemConfirmationAction({ scopeId, observationId: observation.observationId,
              adoptedFieldKeys: values.getAll('adoptedFieldKeys'), initialCode: text(values, 'initialCode') || null });
            if (result.success) { setPreview(result.data ?? null); report('新品采用预览已固定，尚未创建。'); } else report(result.error ?? '采用预览未完成。');
          })}>准备新品采用预览</Button>
          {preview && <><p data-testid="new-item-adoption-preview" className={styles.summaryLine}>采用字段：{preview.adoptedFieldKeys.map(fieldLabel).join('、')} · 人工货号 {preview.initialCode ?? '待补货号'} · 预览已固定</p><Button type="submit">确认新增商品</Button></>}</div>
        </fieldset>
      </form>

      <form action={(form) => { if (slot) submit({ action: 'associate_existing_item', input: { requestId: crypto.randomUUID(), scopeId,
        observationId: observation.observationId, expectedClassificationRevision: slot.classificationRevision, previewId: slot.previewId,
        expectedSourceDisposition: slot.sourceDispositionSha256, privateReason: text(form, 'privateReason'), basis: { kind: 'source_slot' } } }); }}>
        <fieldset disabled={blocked || !canPublish} className={styles.formFieldset}><legend>同可靠来源沿用</legend>
          <p>该来源已有永久创建出处时，由服务器固定原商品；不需要重新选择，也不额外编造同商品证明。</p>
          <label className={styles.field}>复用理由<Input name="privateReason" required defaultValue="同可靠来源新批观测明确复用" /></label>
          <div className={styles.actionRow}><Button type="button" onClick={() => startPreparing(async () => { const result = await prepareSourceSlotAssociationAction({ scopeId, observationId: observation.observationId });
            if (result.success) { setSlot(result.data ?? null); report('已核同源复用预览，原目标由服务器固定。'); } else report(result.error ?? '同源复用仍需核对。'); })}>准备同源复用</Button>
          {slot && <><p data-testid="source-slot-preview" className={styles.summaryLine}>原商品已由服务器固定 · 资料版本 {slot.itemRevision}</p><Button type="submit">确认沿用原商品</Button></>}</div>
        </fieldset>
      </form>

      <form action={(form) => { if (proof) { const { label: _label, ...prepared } = proof; void _label;
        submit({ action: 'associate_existing_item', input: { ...prepared, scopeId, requestId: crypto.randomUUID(), privateReason: text(form, 'privateReason') } }); } }}>
        <fieldset disabled={blocked || !canPublish || !proofOptions.length} className={styles.formFieldset}><legend>有证据的跨批关联</legend>
          <p>只在存在已批准的双端证据时，才能把这条观测关联到已有商品。</p>
          <div className={styles.fieldRow}>
            <label className={styles.field}>同商品批准证据<select name="proofIndex" aria-label="同商品批准证据">{proofOptions.map((option, index) => <option key={option.basis.associationProofRef.proofKey} value={index}>{option.label}</option>)}</select></label>
            <label className={styles.field}>关联理由<Input name="privateReason" required defaultValue="依据批准双端证据关联" /></label>
          </div>
          <div className={styles.actionRow}><Button type="button" onClick={(event) => { const values = new FormData(event.currentTarget.form!); const option = proofOptions[Number(values.get('proofIndex'))]; if (!option) return;
            startPreparing(async () => { const result = await prepareCatalogProofAssociationAction({ scopeId, observationId: observation.observationId, associationProofRef: option.basis.associationProofRef });
              if (result.success) { setProof(result.data ?? null); report('批准双端证据与原商品预览已固定。'); } else report(result.error ?? '证据关联未准备。'); }); }}>准备证据关联</Button>
          {proof && <><p className={styles.summaryLine}>明确目标 {proof.basis.targetItemId}</p><Button type="submit">确认关联已有商品</Button></>}</div>
        </fieldset>
      </form>

      <form action={(form) => { if (attach) { const { label: _label, ...prepared } = attach; void _label;
        submit({ action: 'attach_source_identity', input: { ...prepared, scopeId, requestId: crypto.randomUUID(), privateReason: text(form, 'privateReason') } }); } }}>
        <fieldset disabled={blocked || !canPublish || !attachOptions.length} className={styles.formFieldset}><legend>沿原商品后补来源身份</legend>
          <p>已有商品沿用原商品编号，只追加本次来源出处；不创建新商品。</p>
          <div className={styles.fieldRow}>
            <label className={styles.field}>同来源批准证据<select name="attachIndex" aria-label="同来源批准证据">{attachOptions.map((option, index) => <option key={option.label} value={index}>{option.label}</option>)}</select></label>
            <label className={styles.field}>后补依据<Input name="privateReason" required defaultValue="依据批准同来源证据追加出处" /></label>
          </div>
          <div className={styles.actionRow}><Button type="button" onClick={(event) => { const values = new FormData(event.currentTarget.form!); const option = attachOptions[Number(values.get('attachIndex'))]; if (!option?.associationProofRef) return;
            startPreparing(async () => { const result = await prepareAttachSourceIdentityAction({ scopeId, observationId: observation.observationId, associationProofRef: option.associationProofRef! });
              if (result.success) { setAttach(result.data ?? null); report('后补来源预览已核，原商品保持不变。'); } else report(result.error ?? '后补来源未准备。'); }); }}>准备后补来源身份</Button>
          {attach && <><p className={styles.summaryLine}>原商品已关联；确认后会保留原有商品与来源历史。</p><Button type="submit">确认后补来源身份</Button></>}</div>
        </fieldset>
      </form>


    </div>
  </section>;
}

export function NewItemDetailAttachment({ panel }: { panel: Awaited<ReturnType<typeof getNewItemDetailPanel>> }) {
  if (!panel.enabled) return null;
  const sources = [
    { key: 'jushuitan' as const, label: '聚水潭（JST）' },
    { key: 'bigseller' as const, label: 'BigSeller（BS）' },
  ];
  const total = panel.candidates.jushuitan.length + panel.candidates.bigseller.length;
  return <section data-testid="scoped-product-candidates" className={styles.subsection}>
    <header className={styles.attachmentSideHead}>
      <h4 className={styles.subsectionTitle}>当前授权来源候选</h4>
      <span className={styles.badge}>{total > 0 ? `${total} 条候选` : '无候选'}</span>
    </header>
    <p className={styles.attachmentSideNote}>只读资料候选，两个系统独立推进；无候选不代表真实账号已查全，也不代表库存为 0。</p>
    {sources.map(({ key, label }) => <div key={key} data-testid={`scoped-candidates-${key}`}>
      <p className={styles.recordMeta}><strong>{label}</strong></p>
      {panel.candidates[key].length
        ? <ul className={styles.evidenceList}>{panel.candidates[key].map((candidate) => <li key={candidate.observationId} className={styles.evidenceItem}>
          <span className={styles.evidenceItemTitle}>{candidate.sku ?? '未提供SKU'} · {candidate.name ?? '未提供名称'}</span>
          <span className={styles.muted}>{riskLabels(candidate.conflicts)}</span>
        </li>)}</ul>
        : <p className={styles.muted}>暂无候选（当前已读范围）。</p>}
    </div>)}
    <p className={styles.muted}>候选只作来源核对参考，不改变已有选择；冲突按业务提示保留。</p>
  </section>;
}
