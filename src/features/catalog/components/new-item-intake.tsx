'use client';

import { useRef, useState, useTransition } from 'react';
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
export function NewItemIntake({ data }: { data: Workspace }) {
  const router = useRouter(), [busy, startTransition] = useTransition();
  const [message, setMessage] = useState(''), [pending, setPending] = useState<Pending | null>(null);
  const [saved, setSaved] = useState<NewItemMutationResult | null>(null);
  const [fixtureId, setFixtureId] = useState(data.fixtures.find((fixture) => fixture.scopeId === data.scopeId)?.approvedFixtureId ?? '');
  const [capturePreview, setCapturePreview] = useState<Awaited<ReturnType<typeof prepareProductCaptureAction>>['data'] | null>(null);
  const [history, setHistory] = useState<SensitiveHistoryDto | null>(null);
  const workspace = data.workspace;
  async function send(request: Pending) {
    setPending(request); setMessage('正在提交固定原意图，请勿发起另一操作。');
    try {
      const result = await operations[request.action](request.input);
      if (result.outcome === 'unknown') { setMessage(result.error ?? '提交结果暂未确认。'); return; }
      setPending(null);
      if (result.success) { setSaved(result.data ?? null); setMessage('本次操作已保存；沿原UUID保留历史。'); router.refresh(); }
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
  if (!data.enabled || !workspace) return <section data-testid="new-item-intake"><h1>持续新品资料</h1><p>当前账号没有可用的来源工作区，或模块未启用。</p></section>;
  const locked = busy || pending !== null, canPublish = workspace.permissions.manage && workspace.permissions.publish;
  return <div data-testid="new-item-intake" className="space-y-6">
    <header><h1 className="text-2xl font-semibold">持续新品资料</h1><p>本地虚构来源 · 分类建议不等于建档决定 · 正式关系未启用</p><Link href="/dashboard/catalog" className="underline">返回商品资料</Link></header>
    <label className="block">来源范围<select aria-label="来源范围" className="block border rounded p-2" value={data.scopeId ?? ''} disabled={locked}
      onChange={(event) => router.push(`/dashboard/catalog/intake?scope=${event.target.value}`)}>{data.scopes.map((scope) => <option key={scope.scopeId} value={scope.scopeId}>{scope.displayName}</option>)}</select></label>
    <section aria-label="冻结商品观测" className="border rounded p-4 space-y-2">
      <label>固定商品资料<select aria-label="固定商品资料" value={fixtureId} disabled={locked} onChange={(event) => { setFixtureId(event.target.value); setCapturePreview(null); }}>
        {data.fixtures.filter((fixture) => fixture.scopeId === data.scopeId).map((fixture) => <option key={fixture.approvedFixtureId} value={fixture.approvedFixtureId}>{fixture.approvedFixtureId}</option>)}</select></label>
      <Button disabled={locked || !workspace.permissions.manage || !fixtureId} onClick={() => startTransition(async () => {
        const result = await prepareProductCaptureAction({ approvedFixtureId: fixtureId });
        if (result.success) { setCapturePreview(result.data); setMessage('商品观测预览已固定，尚未导入。'); } else setMessage(result.error ?? '预览未完成。');
      })}>准备商品观测预览</Button>
      {capturePreview && <><p data-testid="product-capture-preview">{capturePreview.approvedFixtureId} · {capturePreview.observationCount}条观测 · {capturePreview.previewId}</p>
        <Button disabled={locked || !workspace.permissions.manage} onClick={() => startTransition(() => send({ action: 'import_product_capture',
          input: { requestId: crypto.randomUUID(), approvedFixtureId: capturePreview.approvedFixtureId, previewId: capturePreview.previewId } }))}>导入商品观测</Button></>}
    </section>
    <p role="status" aria-live="polite" data-testid="new-item-status">{message}</p>
    {saved?.itemId && <p data-testid="new-item-result">商品UUID：<Link className="underline" href={`/dashboard/catalog/${saved.itemId}`}>{saved.itemId}</Link> · 版本 {saved.revision} · {saved.created ? '首次建档' : '沿用原记录'}</p>}
    {pending && <section data-testid="new-item-request-recovery" aria-label="独立核对原请求" className="border rounded p-4 space-y-2">
      <p>结果未知：{pending.action} · 原请求 {String(pending.input.requestId)}</p><p>原意图保留在本页内存，新操作已暂停；核对不依赖任何必填表单。</p>
      <Button type="button" disabled={busy} onClick={() => startTransition(reconcile)}>独立核对原请求</Button>
    </section>}
    {workspace.observations.map((observation) => <ObservationEditor key={`${observation.observationId}:${observation.classification?.revision ?? 0}:${observation.origin?.originId ?? ''}`}
      observation={observation} scopeId={workspace.scope.scopeId} locked={locked} canManage={workspace.permissions.manage} canPublish={canPublish}
      proofOptions={data.catalogProofOptions.filter((option) => option.observationId === observation.observationId)}
      attachOptions={data.attachOptions.filter((option) => option.observationId === observation.observationId)}
      report={setMessage} submit={(request) => startTransition(() => send(request))} />)}
    <section aria-label="受限来源历史" className="border rounded p-4 space-y-2"><h2 className="font-semibold">受限来源历史</h2>
      <p>默认资料不含私人理由、原证明或金额。敏感历史另核当前read、evidence、amount权限。</p>
      <Button disabled={busy} variant="outline" onClick={() => startTransition(async () => {
        setHistory(null);
        const result = await readNewItemSensitiveHistoryAction({ scopeId: workspace.scope.scopeId, observationId: null, projection: 'sensitive_history' });
        if (result.success) setHistory(result.data ?? null); else setMessage(result.error ?? '无权读取敏感历史。');
      })}>读取敏感来源历史</Button>
      {history && workspace.permissions.read && workspace.permissions.amount && workspace.permissions.evidence
        && <pre data-testid="sensitive-product-history" className="text-xs whitespace-pre-wrap break-all">{JSON.stringify(history, null, 2)}</pre>}
      <ul>{workspace.captures.map((capture) => <li key={capture.captureId}>{capture.captureKey} · <a className="underline" href={`/api/catalog/product-evidence/${capture.captureId}?projection=export`}>安全导出</a>
        {workspace.permissions.amount && workspace.permissions.evidence && <> · <a className="underline" href={`/api/catalog/product-evidence/${capture.captureId}?projection=raw`}>受限原始证据</a></>}</li>)}</ul>
    </section>
  </div>;
}
function ObservationEditor({ observation, scopeId, locked, canManage, canPublish, proofOptions, attachOptions, report, submit }: {
  observation: ProductObservationDto; scopeId: string; locked: boolean; canManage: boolean; canPublish: boolean;
  proofOptions: CatalogProofOption[]; attachOptions: AttachIdentityOption[]; report: (message: string) => void; submit: (request: Pending) => void;
}) {
  const confirmForm = useRef<HTMLFormElement>(null);
  const [preview, setPreview] = useState<ConfirmationPreview | null>(null), [slot, setSlot] = useState<SourceSlotPreviewDto | null>(null);
  const [proof, setProof] = useState<CatalogProofOption | null>(null), [attach, setAttach] = useState<AttachIdentityOption | null>(null);
  const [preparing, startPreparing] = useTransition();
  const blocked = locked || preparing;
  return <section data-testid={`product-observation-${observation.observationId}`} data-record-pointer={observation.recordPointer} className="border rounded p-4 space-y-4">
    <h2 className="font-semibold">{observedName(observation)}</h2><p className="text-xs">观测 {observation.observationId} · 位置 {observation.recordPointer}</p>
    <p>当前分类：{observation.classification?.classification ?? '尚未分类'} / {observation.classification?.reviewState ?? '未批准'} · {observation.origin ? <Link href={`/dashboard/catalog/${observation.origin.itemId}`} className="underline">已有商品 {observation.origin.itemId}</Link> : '尚未建档或关联'}</p>
    <p>范围内来源身份：{observation.currentSource ? `${observation.currentSource.state ?? '已核本地事实'} · 版本 ${observation.currentSource.revision}` : '尚无已核实身份'}；仅本地虚构验证，正式关系不可使用。</p>
    <details><summary>查看本次已读非金额资料</summary><dl className="grid gap-2 sm:grid-cols-2" data-testid="product-observation-fields">
      {Object.entries(observation.fields).map(([key, field]) => <div key={key}><dt className="text-xs text-gray-500">{key}</dt><dd>{fieldText(field)}</dd></div>)}
    </dl></details>
    <p data-testid="product-risk">{observation.sourceDisposition.conflicts?.join('；') || '仍须核当前来源、目标历史和版本风险'}</p>
    <form action={(form) => {
      const target = text(form, 'targetItemId'), revision = text(form, 'targetRevision');
      submit({ action: 'classify_observation', input: { requestId: crypto.randomUUID(), scopeId, observationId: observation.observationId,
        expectedClassificationRevision: observation.classification?.revision ?? 0, classification: text(form, 'classification'), reviewState: text(form, 'reviewState'),
        proposedItemId: target || null, expectedItemRevision: revision ? Number(revision) : null, proposedFieldKeys: [],
        expectedSourceSnapshot: observation.currentSource ? { recordId: observation.currentSource.recordId, revision: observation.currentSource.revision, claimId: observation.currentSource.claimId } : null,
        privateReason: text(form, 'privateReason') } });
    }}><fieldset disabled={blocked || !canManage} className="space-y-2"><legend>四类分流</legend>
      <label>分类<select name="classification" aria-label="分类" defaultValue="new_item"><option value="new_item">新品候选</option><option value="item_update">已有资料修订建议</option><option value="external_sku">外部新增SKU</option><option value="suspected_version">疑似版本或换款</option></select></label>
      <label>复核状态<select name="reviewState" defaultValue="proposed"><option value="proposed">建议</option><option value="needs_review">待核</option></select></label>
      <label className="block">建议目标UUID（修订建议必填）<Input name="targetItemId" /></label><label className="block">目标资料版本<Input name="targetRevision" type="number" min={1} /></label>
      <label className="block">分类理由<Input name="privateReason" required defaultValue="本地虚构资料分类核对" maxLength={1000} /></label><Button type="submit">保存分类</Button>
    </fieldset></form>
    <form ref={confirmForm} onChange={(event) => { if (event.target instanceof HTMLInputElement && ['adoptedFieldKeys', 'initialCode'].includes(event.target.name)) setPreview(null); }}
      action={(form) => { if (preview) submit({ action: 'confirm_new_item', input: { ...preview, requestId: crypto.randomUUID(), privateReason: text(form, 'privateReason') } }); }}>
      <fieldset disabled={blocked || !canPublish} className="space-y-2"><legend>明确新品采用</legend>
        {ADOPTABLE_FIELD_KEYS.map((field) => <label key={field} className="mr-3 inline-block"><input name="adoptedFieldKeys" type="checkbox" value={field} defaultChecked={field === 'nameCn'} /> {field}</label>)}
        <label className="block">人工首次货号（可空，不自动编号）<Input name="initialCode" maxLength={50} /></label>
        <label className="block">新品确认理由<Input name="privateReason" required defaultValue="明确确认本次虚构新品" maxLength={1000} /></label>
        <Button type="button" onClick={() => startPreparing(async () => {
          if (!confirmForm.current) return; const values = new FormData(confirmForm.current);
          const result = await prepareNewItemConfirmationAction({ scopeId, observationId: observation.observationId,
            adoptedFieldKeys: values.getAll('adoptedFieldKeys'), initialCode: text(values, 'initialCode') || null });
          if (result.success) { setPreview(result.data ?? null); report('新品采用预览已固定，尚未创建。'); } else report(result.error ?? '采用预览未完成。');
        })}>准备新品采用预览</Button>
        {preview && <><p data-testid="new-item-adoption-preview">采用字段：{preview.adoptedFieldKeys.join('、')} · 人工货号 {preview.initialCode ?? '待补货号'} · {preview.previewId}</p><Button type="submit">确认新增商品</Button></>}
      </fieldset>
    </form>
    <form action={(form) => { if (slot) submit({ action: 'associate_existing_item', input: { requestId: crypto.randomUUID(), scopeId,
      observationId: observation.observationId, expectedClassificationRevision: slot.classificationRevision, previewId: slot.previewId,
      expectedSourceDisposition: slot.sourceDispositionSha256, privateReason: text(form, 'privateReason'), basis: { kind: 'source_slot' } } }); }}>
      <fieldset disabled={blocked || !canPublish} className="space-y-2"><legend>同可靠来源沿用</legend><p>已有永久创建出处时由服务器固定原商品，不需重选，也不额外编造同商品证明。</p>
        <label>复用理由<Input name="privateReason" required defaultValue="同可靠来源新批观测明确复用" /></label>
        <Button type="button" onClick={() => startPreparing(async () => { const result = await prepareSourceSlotAssociationAction({ scopeId, observationId: observation.observationId });
          if (result.success) { setSlot(result.data ?? null); report('已核同源复用预览，原目标由服务器固定。'); } else report(result.error ?? '同源复用仍需核对。'); })}>准备同源复用</Button>
        {slot && <><p data-testid="source-slot-preview">原商品 {slot.slot.itemId} · 版本 {slot.itemRevision}</p><Button type="submit">确认沿用原商品</Button></>}
      </fieldset>
    </form>
    <form action={(form) => { if (proof) { const { label: _label, ...prepared } = proof; void _label;
      submit({ action: 'associate_existing_item', input: { ...prepared, scopeId, requestId: crypto.randomUUID(), privateReason: text(form, 'privateReason') } }); } }}>
      <fieldset disabled={blocked || !canPublish || !proofOptions.length} className="space-y-2"><legend>有证据的跨批关联</legend>
        <select name="proofIndex" aria-label="同商品批准证据">{proofOptions.map((option, index) => <option key={option.basis.associationProofRef.proofKey} value={index}>{option.label}</option>)}</select>
        <label>关联理由<Input name="privateReason" required defaultValue="依据批准双端证据关联" /></label>
        <Button type="button" onClick={(event) => { const values = new FormData(event.currentTarget.form!); const option = proofOptions[Number(values.get('proofIndex'))]; if (!option) return;
          startPreparing(async () => { const result = await prepareCatalogProofAssociationAction({ scopeId, observationId: observation.observationId, associationProofRef: option.basis.associationProofRef });
            if (result.success) { setProof(result.data ?? null); report('批准双端证据与原商品预览已固定。'); } else report(result.error ?? '证据关联未准备。'); }); }}>准备证据关联</Button>
        {proof && <><p>明确目标 {proof.basis.targetItemId}</p><Button type="submit">确认关联已有商品</Button></>}
      </fieldset>
    </form>
    <form action={(form) => { if (attach) { const { label: _label, ...prepared } = attach; void _label;
      submit({ action: 'attach_source_identity', input: { ...prepared, scopeId, requestId: crypto.randomUUID(), privateReason: text(form, 'privateReason') } }); } }}>
      <fieldset disabled={blocked || !canPublish || !attachOptions.length} className="space-y-2"><legend>沿原商品后补来源身份</legend>
        <select name="attachIndex" aria-label="同来源批准证据">{attachOptions.map((option, index) => <option key={option.label} value={index}>{option.label}</option>)}</select>
        <label>后补依据<Input name="privateReason" required defaultValue="依据批准同来源证据追加出处" /></label>
        <Button type="button" onClick={(event) => { const values = new FormData(event.currentTarget.form!); const option = attachOptions[Number(values.get('attachIndex'))]; if (!option?.associationProofRef) return;
          startPreparing(async () => { const result = await prepareAttachSourceIdentityAction({ scopeId, observationId: observation.observationId, associationProofRef: option.associationProofRef! });
            if (result.success) { setAttach(result.data ?? null); report('后补来源预览已核，商品UUID保持。'); } else report(result.error ?? '后补来源未准备。'); }); }}>准备后补来源身份</Button>
        {attach && <><p>原商品 {attach.itemId}</p><Button type="submit">确认后补来源身份</Button></>}
      </fieldset>
    </form>
  </section>;
}
export function NewItemDetailAttachment({ panel }: { panel: Awaited<ReturnType<typeof getNewItemDetailPanel>> }) {
  if (!panel.enabled) return null;
  return <section data-testid="scoped-product-candidates" className="border rounded p-4 space-y-3"><h2 className="font-semibold">当前授权来源候选</h2>
    <p>只读资料候选，两个系统独立推进；无候选不代表真实账号已查全或库存0。</p>
    {(['jushuitan', 'bigseller'] as const).map((system) => <div key={system} data-testid={`scoped-candidates-${system}`}><h3>{system === 'jushuitan' ? 'JST' : 'BS'}</h3>
      {panel.candidates[system].length ? <ul>{panel.candidates[system].map((candidate) => <li key={candidate.observationId}>{candidate.sku} · {candidate.name} · {candidate.basis.join('、')} · {candidate.conflicts.join('；')}</li>)}</ul> : <p>当前授权已读范围暂无候选。</p>}</div>)}
  </section>;
}
