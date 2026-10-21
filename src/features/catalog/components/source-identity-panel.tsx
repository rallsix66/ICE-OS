'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { prepareSourceFixtureCaptureAction, importSourceFixtureCaptureAction, registerSourceIdentityAction,
  reviseSourceIdentityAction, linkSourceObservationAction, recoverSourceIdentityRequestAction } from '../source-identity/actions';
import type { IdentityMutationResult, IdentityWorkspaceDto, LinkIdentityInput, ObservationField, RegisterIdentityInput,
  ReviseIdentityInput, SourceIdentityActionResult, SourceIdentityPanelDto, SourceScopeDto } from '../source-identity/types';

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
const stateLabel = { active: '已核实（fixture）', review_required: '待复核', suspended: '身份暂停', revoked: '身份已撤销' };
const actionGuidance: Record<string, string> = {
  IDENTITY_PROOF_COVERAGE_REQUIRED: '原请求未保存：新证明未覆盖本次复核观测。请选择包含该来源的新采集证明和对应观测。',
  IDENTITY_FROZEN_SCOPE_CONTRADICTION: '原请求未保存：冻结观测的已知范围与来源身份范围冲突，未建立关联；原人工选择与历史保持。',
};

/** This annotation is current scope-authorized evidence, never a replacement for the item revision. */
export function SourceIdentityAttachment({ panel }: { panel: SourceIdentityPanelDto & { enabled?: boolean } }) {
  if (panel.enabled === false) return null;
  return <section className="rounded-lg border p-4 space-y-2" aria-label="当前来源核实附注">
    <h2 className="font-semibold">当前来源核实附注</h2>
    <p>仅本地虚构fixture核实；当前附注不改写当时资料版本及原人工选择。正式关系未启用。</p>
    <p data-testid="identity-attachment-counts">授权范围 {panel.scopes.length} · 关联来源 {panel.sourceIdentity.length} · 真实长期身份核实 0</p>
    {panel.sourceIdentity.map((record) => <p key={record.recordId}>{record.recordId} · {stateLabel[record.state]} · 身份版本 {record.revision}</p>)}
    <Link className="underline text-sm" href="/dashboard/catalog/sources">查看来源身份与观测</Link>
  </section>;
}

/** Pending intentions live only in component memory; recovery never mixes in new form values. */
export function SourceIdentityWorkspace({ view }: { view: IdentityWorkspaceView }) {
  const router = useRouter();
  const [busy, transition] = useTransition();
  const [message, setMessage] = useState('');
  const [preview, setPreview] = useState<{ fixtureId: string; previewId: string } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const workspace = view.workspace;
  const locked = busy || pending !== null;

  function confirm(request: Pending, result: IdentityMutationResult) {
    setPending(null); setUncertain(false);
    if (request.kind === 'capture') setPreview(null);
    setMessage(`原请求已确认：${result.requestId}；${request.kind === 'capture' ? '观测已原子保存' : '身份或关联事实已保存'}。正式关系仍未启用。`);
    router.refresh();
  }

  async function recoverOriginal(request: Pending) {
    setMessage('正在只读核对原请求；未创建新请求或采用新表单输入。');
    try {
      const result = await recoverSourceIdentityRequestAction({ action: request.kind === 'capture' ? 'import_capture' : request.kind,
        input: request.input });
      if (result.status === 'success' && result.data) { confirm(request, result.data); return; }
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
        confirm(request, result.data);
      } else setMessage(actionGuidance[result.code] ?? `原请求未保存：${result.code}。请核对当前授权和版本。`);
      if (result.status !== 'success') router.refresh();
    } catch {
      setUncertain(true);
      setMessage('提交结果暂未确认。请使用“核对/重试原请求”，不要创建另一意图。');
    }
  }
  if (!view.enabled) return <section aria-label="来源身份未启用"><p>来源身份模块未启用。既有冻结资料及人工选择保持。</p></section>;
  const options = workspace?.records ?? [];
  const proofOptions = workspace?.proofs ?? [];
  const currentLinks = new Map<string, IdentityWorkspaceDto['links'][number]>();
  for (const link of workspace?.links ?? []) {
    if ((currentLinks.get(link.observationKey)?.linkRevision ?? 0) < link.linkRevision) currentLinks.set(link.observationKey, link);
  }
  return <div className="space-y-5">
    <p className="text-sm">隔离fixture；人工选择、长期来源核实与正式关系分别显示。真实长期身份核实数仍为0。</p>
    <nav aria-label="授权来源范围" className="flex gap-4 flex-wrap">{view.scopes.map((scope) => pending
      ? <span key={scope.scopeId} aria-disabled="true">{scope.displayName}</span>
      : <Link key={scope.scopeId} className="underline" href={`/dashboard/catalog/sources?scope=${scope.scopeId}`}>{scope.displayName}</Link>)}</nav>
    {!workspace ? <p data-testid="identity-unavailable">当前没有可查看的授权来源范围。</p> : <>
      <section className="rounded-lg border p-4 space-y-2" aria-label="当前身份范围">
        <h2 className="font-semibold">{workspace.scope.displayName}</h2>
        <p data-testid="identity-scope-id">{workspace.scope.scopeId}</p>
        <p>范围状态 {workspace.scope.scopeState} · 目标决定尚未实施 · 正式关系不可用</p>
        <p data-testid="identity-counts">观测 {workspace.observations.length} · 来源记录 {workspace.records.length} · 原审阅快照 {workspace.frozenHumanChoice.length} · 原有效人工选择 {workspace.frozenHumanChoice.filter((choice) => choice.reviewState === 'manual_selected' && choice.selectedItemId !== null).length}</p>
      </section>
      <section aria-label="冻结fixture观测摄取" className="rounded-lg border p-4 space-y-3">
        <h2 className="font-semibold">读取固定虚构fixture</h2>
        <form action={(data) => transition(async () => {
          const fixtureId = text(data, 'fixtureId');
          const result = await prepareSourceFixtureCaptureAction({ fixtureId });
          if (result.status === 'success') { setPreview({ fixtureId, previewId: result.data.previewId }); setMessage('受控fixture预览已准备；原bytes、解析、范围和投影已固定，尚未导入。'); }
          else setMessage(`预览不可用：${result.code}`);
        })}><fieldset disabled={locked || !workspace.permissions.manage} className="flex flex-wrap gap-3 items-end">
          <label>固定fixture<select className="block rounded border p-2" name="fixtureId" aria-label="固定fixture">
            {view.fixtures.filter((fixture) => fixture.scopeId === workspace.scope.scopeId).map((fixture) => <option key={fixture.fixtureId} value={fixture.fixtureId}>{fixture.label}</option>)}
          </select></label><Button type="submit">准备来源观测预览</Button>
        </fieldset></form>
        {preview && <div data-testid="identity-preview" className="space-y-2"><p>预览 {preview.fixtureId} · {preview.previewId}</p>
          <Button disabled={locked || !workspace.permissions.manage} onClick={() => transition(() => submitOriginal({ kind: 'capture', input: { ...preview, requestId: crypto.randomUUID() } }))}>原子导入来源观测</Button></div>}
      </section>
      <section aria-label="来源身份登记" className="rounded-lg border p-4 space-y-3">
        <h2 className="font-semibold">来源观测与身份登记</h2>
        <p className="text-sm">无可靠键只保留观测；名称、条码和行位置不能代替长期身份。登记不创建商品或目标决定。</p>
        {workspace.observations.map((observation) => <article key={observation.observationId} data-testid={`identity-observation-${observation.observationId}`} className="border-t py-3 space-y-2">
          <h3>{fieldValue(observation.fields.name)} · {fieldValue(observation.fields.sku)}</h3>
          <p className="text-xs break-all">观测 <span data-testid="observation-id">{observation.observationId}</span> · 证据位置 {observation.recordPointer}</p>
          <p className="text-sm">市场 {observation.marketContext.state} · 仓库 {observation.warehouseContext.state}</p>
          {workspace.contracts.map((contract) => <p key={contract.contractId} className="text-sm">{contract.strategy} v{contract.revision}：
            {contract.keyFields.map((key) => `${key}=${fieldValue(observation.fields[key])}`).join('；')}
            {contract.keyFields.some((key) => observation.fields[key]?.state !== 'value') ? '；必要身份字段未齐，仅保留观测' : '；仍须证明与预期版本核对'}</p>)}
          <form action={(data) => transition(async () => {
            const expectedId = text(data, 'expectedRecord');
            const expectedRecord = options.find((record) => record.recordId === expectedId);
            await submitOriginal({ kind: 'register', input: { requestId: crypto.randomUUID(), scopeId: workspace.scope.scopeId,
              observationId: observation.observationId, contractId: text(data, 'contractId'), proofId: text(data, 'proofId'),
              expectedMatch: expectedRecord ? { kind: 'record', recordId: expectedRecord.recordId, revision: expectedRecord.revision } : { kind: 'none' }, reason: text(data, 'reason') } });
          })}><fieldset disabled={locked || !workspace.permissions.manage} className="flex flex-wrap gap-3 items-end">
            <label>键合同<select className="block border rounded p-2" name="contractId" aria-label="键合同">{workspace.contracts.map((contract) => <option key={contract.contractId} value={contract.contractId}>{contract.strategy} v{contract.revision}</option>)}</select></label>
            <label>核实证明<select className="block border rounded p-2" name="proofId" aria-label="核实证明">{proofOptions.map((proof) => <option key={proof.evidenceId} value={proof.evidenceId}>{proof.captureKey}</option>)}</select></label>
            <label>预期来源<select className="block border rounded p-2" name="expectedRecord" aria-label="预期来源"><option value="">尚无已核实记录</option>{options.map((record) => <option key={record.recordId} value={record.recordId}>{record.recordId} v{record.revision}</option>)}</select></label>
            <label>登记理由<Input required name="reason" maxLength={1000} /></label><Button type="submit">核实来源身份</Button>
          </fieldset></form>
        </article>)}
      </section>
      <section aria-label="来源记录与历史" className="rounded-lg border p-4 space-y-3">
        <h2 className="font-semibold">来源记录与复核</h2>
        {options.map((record) => {
          const contract = workspace.contracts.find((entry) => entry.contractId === record.currentContractId);
          const originIds = new Set([...currentLinks.values()].filter((link) => link.status === 'linked' && link.recordId === record.recordId && link.originKind === 'frozen').map((link) => link.originId));
          const choices = workspace.frozenHumanChoice.filter((choice) => originIds.has(choice.observationId));
          const targets = new Set(choices.filter((choice) => choice.reviewState === 'manual_selected' && choice.selectedItemId).map((choice) => choice.selectedItemId));
          return <article key={record.recordId} data-testid={`identity-record-${record.recordId}`} className="border-t py-3 space-y-2">
          <p>来源UUID <span data-testid="source-record-id">{record.recordId}</span> · 版本 <span data-testid="source-record-revision">{record.revision}</span> · {stateLabel[record.state]}</p>
          <p>当前键合同 {record.currentContractId} · {contract?.strategy} v{contract?.revision}</p>
          <section aria-label="该来源原人工决定" className="space-y-2" data-testid="identity-record-frozen-choices">
            <p>{targets.size > 1 ? '该来源原选择目标冲突，待核；全部原决定保持，未产生新目标决定。' : '原人工选择保持；来源身份核实不批准商品目标或正式关系。'}</p>
            {choices.length === 0 ? <p>该来源暂无已关联原审阅快照。</p> : choices.map((choice) => <p key={choice.decisionId} className="text-xs break-all">
              决定 {choice.decisionId} · 观测 {choice.observationId} · 原状态 {choice.reviewState ?? '未记录'} · 原目标 {choice.selectedItemId ?? '暂无选择'} · JST引用 {choice.selectedJushuitanRef ?? '未提供'}
            </p>)}
          </section>
          <form action={(data) => transition(() => {
            const command = text(data, 'command') as ReviseIdentityInput['command'];
            return submitOriginal({ kind: 'revise', input: { requestId: crypto.randomUUID(), scopeId: workspace.scope.scopeId, recordId: record.recordId,
              expectedRecordRevision: record.revision, command, proofId: text(data, 'proofId'), reason: text(data, 'reason'),
              ...(command === 'reverify' ? { contractId: text(data, 'contractId'), observationId: text(data, 'observationId'), expectedClaimId: record.activeClaimId } : {}) } });
          })}><fieldset disabled={locked || !workspace.permissions.manage} className="flex flex-wrap gap-3 items-end">
            <label>身份操作<select className="block border rounded p-2" name="command" aria-label="身份操作"><option value="open_review">提出重核</option><option value="suspend">暂停身份</option><option value="revoke">撤销身份</option><option value="reverify">新证明显式复核</option></select></label>
            <label>新证明<select className="block border rounded p-2" name="proofId" aria-label="新证明">{proofOptions.map((proof) => <option key={proof.evidenceId} value={proof.evidenceId}>{proof.captureKey}</option>)}</select></label>
            <label>复核合同<select className="block border rounded p-2" name="contractId" aria-label="复核合同">{workspace.contracts.map((contract) => <option key={contract.contractId} value={contract.contractId}>{contract.strategy} v{contract.revision}</option>)}</select></label>
            <label>复核观测<select className="block border rounded p-2" name="observationId" aria-label="复核观测">{workspace.observations.map((observation) => <option key={observation.observationId} value={observation.observationId}>{observation.recordPointer} · {fieldValue(observation.fields.sku)}</option>)}</select></label>
            <label>复核理由<Input required name="reason" maxLength={1000} /></label><Button type="submit">保存身份状态</Button>
          </fieldset></form>
        </article>; })}
        <details><summary>查看范围内身份历史</summary><p>系统记录时间与来源业务时间分别保存，未观察到不会推造。</p>
          <ul className="space-y-2">{workspace.history.map((entry) => <li key={entry.requestId} data-testid="identity-history-entry" className="border-t py-2 break-all">
            <p>{entry.action} · {entry.recordId ?? '观测/关联操作'} · 版本 {entry.revision ?? '不改record头'}</p>
            <p>{entry.reason} · 操作者 {entry.actorId} · 系统时间 <time dateTime={entry.recordedAt}>{entry.recordedAt}</time></p>
            <p>来源业务时间 {entry.sourceEffectiveAt ?? '未观察到'}</p>
            <details><summary>当时身份版本事实</summary><pre className="text-xs whitespace-pre-wrap">{JSON.stringify({ beforeState: entry.beforeState, afterState: entry.afterState }, null, 2)}</pre></details>
          </li>)}</ul>
        </details>
      </section>
      <section aria-label="观测关联" className="rounded-lg border p-4 space-y-3">
        <h2 className="font-semibold">观测关联（不改商品目标）</h2>
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
        })}><fieldset disabled={locked || !workspace.permissions.manage || !options.length} className="flex flex-wrap gap-3 items-end">
          <label>观测<select className="block border rounded p-2 max-w-sm" name="origin" aria-label="观测">{workspace.observations.map((observation) => <option key={observation.observationId} value={`identity:${observation.observationId}`}>fixture · {observation.recordPointer}</option>)}
            {workspace.frozenHumanChoice.map((choice) => <option key={choice.decisionId} value={`frozen:${choice.observationId}`}>原选择 · {choice.observationId}</option>)}</select></label>
          <label>已核来源<select className="block border rounded p-2" name="recordId" aria-label="已核来源">{options.map((record) => <option key={record.recordId} value={record.recordId}>{record.recordId} v{record.revision}</option>)}</select></label>
          <label>关联操作<select className="block border rounded p-2" name="operation" aria-label="关联操作"><option value="link">关联观测</option><option value="revoke">撤销观测关联</option></select></label>
          <label>关联证明<select className="block border rounded p-2" name="proofId" aria-label="关联证明">{proofOptions.map((proof) => <option key={proof.evidenceId} value={proof.evidenceId}>{proof.captureKey}</option>)}</select></label>
          <label>关联理由<Input required name="reason" maxLength={1000} /></label><Button type="submit">保存观测关联</Button>
        </fieldset></form>
        <ul>{[...currentLinks.values()].map((link) => <li key={link.observationKey} data-testid="identity-link" className="break-all">{link.observationKey} → {link.recordId} · {link.status} v{link.linkRevision}</li>)}</ul>
        <details><summary>查看全部观测关联版本</summary><ul>{workspace.links.map((link) => <li key={`${link.observationKey}:${link.linkRevision}`} data-testid="identity-link-history" className="border-t py-2 break-all text-sm">
          {link.observationKey} → {link.recordId} · {link.status} v{link.linkRevision} · 当时合同 {link.contractId} · 证明 {link.proofId} · {link.reason} · 操作者 {link.actorId} · 系统时间 <time dateTime={link.recordedAt}>{link.recordedAt}</time>
        </li>)}</ul></details>
      </section>
      <section aria-label="来源证据与导出" className="rounded-lg border p-4 space-y-2"><h2 className="font-semibold">范围内证据与导出</h2>
        <p>非金额投影按read授权；原bytes另需evidence与amount。找到图片引用不表示内容已核验。</p>
        <ul>{proofOptions.map((proof) => <li key={proof.evidenceId} className="py-1 break-all" data-testid="identity-evidence">
          {proof.captureKey} · <span>{proof.sha256}</span> · <a className="underline" href={`/api/catalog/source-evidence/${proof.evidenceId}?projection=export`}>非金额导出</a>
          {workspace.permissions.evidence && workspace.permissions.amount && <> · <a className="underline" href={`/api/catalog/source-evidence/${proof.evidenceId}?projection=raw`}>受限原始证据</a></>}
        </li>)}</ul>
      </section>
    </>}
    <p role="status" aria-live="polite">{message}</p>
    {pending && <section aria-label="身份原请求待核对" data-testid="identity-pending-request" className="border rounded p-4 space-y-2">
      <h2 className="font-semibold">原请求结果待核对</h2><p>仅核对以下原意图，新操作已暂停；新输入不作为已保存内容。请保留本页核对原请求。</p>
      <pre data-testid="identity-pending-input" className="text-xs whitespace-pre-wrap break-all">{JSON.stringify(pending, null, 2)}</pre>
      <Button type="button" disabled={busy} onClick={() => transition(() => recoverOriginal(pending))}>核对/重试原请求</Button>
    </section>}
  </div>;
}
