'use client';

import { useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { assignInitialCodeAction, appendNonPriceRevisionAction, getCatalogAmountsAction, recoverCatalogNewItemRequestAction } from '../actions';
import type { getCatalogDetail } from '../service';
import type { FieldObservation } from '../types';

type Detail = Awaited<ReturnType<typeof getCatalogDetail>>;
type CodeRequest = { itemId: string; expectedRevision: number; requestId: string; code: string; reason: string };
type RevisionRequest = { itemId: string; expectedRevision: number; requestId: string; reason: string; fields: Record<string, FieldObservation> };
type PendingRequest = { kind: 'initial_code'; input: CodeRequest } | { kind: 'nonprice_revision'; input: RevisionRequest };
function fieldText(field: FieldObservation): string {
  if (field.state === 'observed') {
    if (field.meaning === 'explicit_empty') return '明确空串';
    if (field.meaning === 'explicit_null') return '明确空值';
    return field.raw;
  }
  return ({ no_text: '未读到文本', not_read: '未读取', parse_failed: '解析失败' })[field.state];
}

export function CatalogDetail({ detail, historical }: { detail: Detail; historical: boolean }) {
  const { item } = detail;
  const router = useRouter();
  const [busy, startTransition] = useTransition();
  const [message, setMessage] = useState('');
  const [pendingRequest, setPendingRequest] = useState<PendingRequest | null>(null);
  const [amounts, setAmounts] = useState<unknown>(null);
  const codeForm = useRef<HTMLFormElement>(null);
  const revisionForm = useRef<HTMLFormElement>(null);
  async function submitOriginal(request: PendingRequest) {
    setPendingRequest(request);
    setMessage('正在核对原请求，请勿开始另一项操作。');
    try {
      const result = request.kind === 'initial_code'
        ? await assignInitialCodeAction(request.input) : await appendNonPriceRevisionAction(request.input);
      if (result.outcome === 'unknown') {
        setMessage(result.error ?? '提交结果暂未确认，请核对原请求。');
        return;
      }
      setPendingRequest(null);
      if (result.success) {
        codeForm.current?.reset();
        revisionForm.current?.reset();
        const savedIntent = request.kind === 'initial_code' ? `首次补码已保存：${request.input.code}，仍为同一商品记录`
          : `资料修订已保存：${Object.entries(request.input.fields).map(([key, value]) => `${key} = ${fieldText(value)}`).join('；')}；旧版本和采用价格保持`;
        setMessage(`${savedIntent}。已确认原请求 ${request.input.requestId}，资料版本 ${result.data?.revision}。`);
      } else setMessage(result.error ?? '原请求未保存。');
      router.refresh();
    } catch {
      // A transport error cannot prove whether the server committed. Keep the
      // original intent in component memory, with no new request or payload log.
      setMessage('提交结果暂未确认。请使用“核对/重试原请求”，不要创建另一项操作。');
    }
  }
  async function reconcileOriginal(request: PendingRequest) {
    if (!detail.writeAccess.isScoped) return submitOriginal(request);
    try {
      const result = await recoverCatalogNewItemRequestAction(request);
      if (!result.success) { setMessage('原请求尚无法核对，仍保留未知状态与原意图。'); return; }
      if (!result.data) return submitOriginal(request);
      setPendingRequest(null); setMessage(`已只读核实原请求 ${request.input.requestId}，资料版本 ${result.data.revision}。`); router.refresh();
    } catch { setMessage('原请求尚无法核对，仍保留未知状态与原意图。'); }
  }
  const brushPending = detail.decisions.some((d) => d.entryKind === 'history:batch_brush_preservation' && d.summary.status === 'pending_confirmation');
  return <div className="space-y-6">
    <Link className="underline text-sm" href="/dashboard/catalog">返回商品资料</Link>
    <header className="space-y-2"><h1 className="text-2xl font-semibold">{item.nameCn}</h1>
      <p data-testid="item-uuid">{item.itemId}</p>
      <p>资料版本 <span data-testid="item-revision">{item.revision}</span> · ICE货号 <strong data-testid="item-code">{item.iceCode ?? '待补货号'}</strong></p>
      <Badge variant="outline">{item.newProductConfirmed && !item.iceCode ? '新品，待补货号' : historical ? '历史资料版本' : '当前采用资料'}</Badge>
      {brushPending && <Badge variant="outline">刷子待确认，分列保留</Badge>}
      <p className="text-sm">人工决定：JST {item.humanChoices.jushuitan}条，BS {item.humanChoices.bigseller}条 · <Link className="underline" href="/dashboard/catalog/sources">逐来源核实附注</Link> · 正式关系未启用</p>
      {historical && <p className="text-amber-700">正在查看当时版本，货号按当时状态显示。<Link className="underline" href={`/dashboard/catalog/${item.itemId}`}>查看当前资料</Link></p>}
    </header>
    <section aria-label="采用资料" className="rounded-lg border p-4"><h2 className="font-semibold mb-3">采用资料</h2>
      <dl className="grid gap-2 sm:grid-cols-2">{Object.entries(item.fields).map(([key, value]) => <div key={key} className="border-b py-2"><dt className="text-xs text-gray-500">{key}</dt><dd>{fieldText(value)}</dd></div>)}</dl>
      <p className="text-xs text-gray-500 mt-3">原始位置只作为固定证据锚点；缺失资料不会补0或从商品名推填。</p>
    </section>
    {!historical && detail.writeAccess.canWrite && <section className="rounded-lg border p-4 space-y-4" aria-label="补充资料"><h2 className="font-semibold">补充资料</h2>
      {!item.iceCode && <form ref={codeForm} className="space-y-2 max-w-xl" action={(data) => startTransition(async () => {
        if (pendingRequest) return;
        await submitOriginal({ kind: 'initial_code', input: { itemId: item.itemId, expectedRevision: item.revision,
          requestId: crypto.randomUUID(), code: String(data.get('code') ?? ''), reason: String(data.get('reason') ?? '') } });
      })}>
        <fieldset className="space-y-2" disabled={busy || pendingRequest !== null}>
        <label className="block text-sm">首次ICE货号<Input name="code" required maxLength={50} /></label>
        <label className="block text-sm">补码依据<Input name="reason" required maxLength={1000} /></label>
        <Button type="submit">保存首次货号</Button>
        </fieldset>
      </form>}
      <form ref={revisionForm} className="space-y-2 max-w-xl" action={(data) => startTransition(async () => {
        if (pendingRequest) return;
        const reason = String(data.get('revisionReason') ?? '');
        const raw = String(data.get('fieldValue') ?? '');
        const field = String(data.get('field') ?? '');
        const evidenceRef = String(data.get('evidenceRef') ?? '');
        const value: FieldObservation = raw === '' ? { state: 'observed', meaning: 'explicit_empty', raw: '', evidenceRef } : { state: 'observed', meaning: 'value', raw, evidenceRef };
        await submitOriginal({ kind: 'nonprice_revision', input: { itemId: item.itemId, expectedRevision: item.revision,
          requestId: crypto.randomUUID(), reason, fields: { [field]: value } } });
      })}>
        <fieldset className="space-y-2" disabled={busy || pendingRequest !== null}>
        <label className="block text-sm">修订字段<select className="block rounded border p-2" name="field" aria-label="修订字段" defaultValue="factory"><option value="factory">工厂</option><option value="specification">规格</option><option value="nameCn">中文名称</option><option value="barcode">辅助条码</option><option value="packaging">包装</option><option value="cartonQuantity">装箱数量</option><option value="englishName">英文名称</option><option value="imageRef">图片引用</option></select></label>
        <label className="block text-sm">明确采用值（留空表示明确空串）<Input name="fieldValue" maxLength={2000} /></label>
        <label className="block text-sm">证据引用<Input name="evidenceRef" required maxLength={500} /></label>
        <label className="block text-sm">修订理由<Input name="revisionReason" required maxLength={1000} /></label>
        <p className="text-sm text-amber-700">规格、条码、包装变化可能涉及版本或换款；本操作只修订资料并留历史。</p>
        <Button type="submit">保存非价格修订</Button>
        </fieldset>
      </form>
      <p role="status" aria-live="polite">{message}</p>
      {pendingRequest && <section aria-label="待核对原请求" data-testid="pending-original-request" className="space-y-2 border rounded p-3">
        <h3 className="font-semibold">结果待核对：{pendingRequest.kind === 'initial_code' ? '首次补码' : '非价格资料修订'}</h3>
        <p className="text-sm text-amber-700">仅核对以下原意图。新操作已暂停；其他输入不会作为本次保存内容。请勿关闭页面后盲目重复操作。</p>
        <pre data-testid="pending-original-input" className="text-xs whitespace-pre-wrap break-all">{JSON.stringify(pendingRequest.input, null, 2)}</pre>
        <Button type="button" variant="outline" disabled={busy} onClick={() => startTransition(() => reconcileOriginal(pendingRequest))}>核对/重试原请求</Button>
      </section>}
    </section>}
    {!historical && !detail.writeAccess.canWrite && <p data-testid="catalog-write-denied">当前账号仅可查看已采用资料；补码和修订需要创建来源范围的当前发布权限。</p>}
    <section aria-label="独立来源候选" className="space-y-4"><h2 className="font-semibold">JST与BS分别查看</h2>
      {(['jushuitan', 'bigseller'] as const).map((source) => <div key={source} className="border rounded-lg p-4"><h3 className="font-semibold">{source === 'jushuitan' ? 'JST' : 'BS'}</h3>
        {detail.decisions.some((d) => d.entryKind === 'history:batch_bs_not_created' && d.summary.sourceSystem === source && d.summary.status === 'user_confirmed_not_created') && <p className="text-amber-700">本批冻结说明：该系统尚未建档（用户已确认）；不代表实时账号状态或库存0。</p>}
        <p>{item.humanChoices[source] ? `${item.humanChoices[source]}条人工选择已确认（本批证据）` : '暂无已确认对应'}</p>
        <p className="text-xs text-gray-500">候选仅覆盖冻结样本；没有候选不代表真实系统未建档，两系统互不等待。</p>
        <Table><TableHeader><TableRow><TableHead>SKU / 名称</TableHead><TableHead>依据</TableHead><TableHead>原状态</TableHead><TableHead>冲突提示</TableHead></TableRow></TableHeader><TableBody>
          {detail.candidates[source].map((c) => <TableRow key={c.observationId}><TableCell>{c.sku ?? '未提供SKU'}<p>{c.name}</p></TableCell><TableCell>{c.basis.join('、')}</TableCell><TableCell>{c.reviewState ?? '未确认'}</TableCell><TableCell>{c.conflicts.join('；') || '未观察到明确冲突'}</TableCell></TableRow>)}
        </TableBody></Table>
        {!detail.candidates[source].length && <p>当前已读范围暂无候选。</p>}
      </div>)}
    </section>
    <section className="border rounded-lg p-4" aria-label="资料历史"><h2 className="font-semibold">资料历史</h2>
      <p className="text-xs text-gray-500">系统记录时间表示本系统追加修订的时间，不代表来源业务更新时间。操作者保留原UUID。</p>
      <ul className="space-y-2 mt-2">{detail.history.map((h) => <li key={h.revision} data-testid={`revision-history-${h.revision}`}>
        <Link className="underline" href={`/dashboard/catalog/${item.itemId}?revision=${h.revision}`}>版本 {h.revision} · {h.iceCode ?? '待补货号'} · {h.nameCn}</Link>
        <dl className="text-sm break-all"><div><dt className="inline">修订理由：</dt><dd className="inline" data-testid="revision-reason">{h.revisionAudit.reason}</dd></div>
          <div><dt className="inline">原操作者UUID：</dt><dd className="inline" data-testid="revision-actor">{h.revisionAudit.actorId}</dd></div>
          <div><dt className="inline">系统记录时间：</dt><dd className="inline"><time dateTime={h.revisionAudit.recordedAt} data-testid="revision-recorded-at">{h.revisionAudit.recordedAt}</time></dd></div>
          <div><dt className="inline">证据引用：</dt><dd className="inline" data-testid="revision-evidence">{h.revisionAudit.evidenceRef}</dd></div></dl>
      </li>)}</ul></section>
    <section className="border rounded-lg p-4" aria-label="差异与决定"><h2 className="font-semibold">来源差异与原人工决定</h2>
      <p className="text-sm">飞书仍为partial：27列表头、16个行位置的部分字段。新观测作为修订建议保存，未覆盖采用资料。</p>
      <details><summary>查看非金额差异</summary><pre className="text-xs whitespace-pre-wrap break-all">{JSON.stringify(detail.differences, null, 2)}</pre></details>
      <details><summary>查看本商品决定与历史索引</summary><pre className="text-xs whitespace-pre-wrap break-all">{JSON.stringify(detail.decisions, null, 2)}</pre></details>
      <details><summary>查看非金额来源观测</summary><pre className="text-xs whitespace-pre-wrap break-all">{JSON.stringify(detail.observations, null, 2)}</pre></details>
    </section>
    <section className="border rounded-lg p-4 space-y-3" aria-label="受限证据"><h2 className="font-semibold">金额与原始证据</h2>
      <p className="text-sm">默认资料不含价格；启用管理员可显式读取受限投影，首包不提供价格编辑。</p>
      <Button variant="outline" disabled={busy} onClick={() => startTransition(async () => {
        const result = await getCatalogAmountsAction(item.itemId);
        if (result.success) setAmounts(result.data);
        else { setAmounts(null); setMessage(result.error ?? '操作未完成'); }
      })}>读取受限金额</Button>
      {amounts !== null && <pre data-testid="restricted-amounts" className="text-xs whitespace-pre-wrap break-all">{JSON.stringify(amounts, null, 2)}</pre>}
      <details><summary>完整原始证据下载（含价格，受限）</summary><ul className="text-sm space-y-1">{detail.artifacts.map((a) => <li key={a.artifactId}><a className="underline" href={`/api/catalog/evidence/${a.artifactId}?projection=raw`}>{a.logicalName}</a></li>)}</ul></details>
      <a className="text-sm underline" href={`/api/catalog/evidence/${item.itemId}?projection=export`}>导出本商品非金额资料及历史</a>
    </section>
  </div>;
}
