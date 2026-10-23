'use client';

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Package } from 'lucide-react';
import demoStyles from '@/ui/ice-v4/ice-v4.module.css';
import { Pill } from '@/ui/ice-v4/primitives';
import { adoptedUnitCostFromFinancial } from '../local-display/adopted-price';
import { CATALOG_FIELD_LABELS, fieldAuditValue, fieldBusinessValue } from '../local-display/field-labels';
import { assignInitialCodeAction, appendNonPriceRevisionAction, fetchCatalogDetailArtifactsAction, fetchCatalogDetailAuditAction, fetchCatalogDetailHistoryAction, getCatalogAmountsAction, recoverCatalogNewItemRequestAction } from '../actions';
import type { getCatalogDetailAudit, getCatalogDetailCore, getCatalogItemBsSample } from '../service';
import type { CatalogItemRevisionDto, FieldObservation } from '../types';

export type CatalogDetailCoreView = Awaited<ReturnType<typeof getCatalogDetailCore>>;
type CatalogDetailAuditView = Awaited<ReturnType<typeof getCatalogDetailAudit>>;
type BsSampleDetail = Awaited<ReturnType<typeof getCatalogItemBsSample>>;
type CodeRequest = { itemId: string; expectedRevision: number; requestId: string; code: string; reason: string };
type RevisionRequest = { itemId: string; expectedRevision: number; requestId: string; reason: string; fields: Record<string, FieldObservation> };
type PendingRequest = { kind: 'initial_code'; input: CodeRequest } | { kind: 'nonprice_revision'; input: RevisionRequest };

const PRIMARY_FIELD_KEYS = ['nameCn', 'englishName', 'specification', 'unit', 'category', 'factory', 'packaging', 'cartonQuantity', 'barcode', 'width', 'height', 'depth', 'weight', 'imageRef'] as const;

function bsSelectionLabel(state: string) {
  if (state === 'confirmed') return '已确认';
  if (state === 'unselected') return '未选择';
  return state;
}

function qtyCell(value: unknown) {
  return value == null ? '—' : String(value);
}

function BsSampleBusinessBlock({
  itemId,
  bsSample,
  bsSampleError,
  warehouse,
}: {
  itemId: string;
  bsSample: BsSampleDetail | null;
  bsSampleError: { code: string; message: string } | null;
  warehouse?: string;
}) {
  if (bsSampleError) {
    return <section className={demoStyles.panel} role="alert" data-testid="catalog-bs-sample-error">
      <h2 className="font-semibold">BS 样表库存</h2>
      <p>{bsSampleError.message}</p>
      <p className={demoStyles.subtle}>{bsSampleError.code === 'forbidden' ? '权限不足，不是「尚未导入」。' : '请检查实例 SQL 与估值口径文件。'}</p>
    </section>;
  }
  if (bsSample?.status === 'not_imported') {
    return <p className={demoStyles.subtle} data-testid="catalog-bs-sample-not-imported">尚未载入 BS 样表库存投影。</p>;
  }
  if (bsSample?.status !== 'loaded') return null;
  const adopted = adoptedUnitCostFromFinancial(bsSample.adoptedUnitCost);
  const exportLabel = typeof bsSample.exportLabel === 'string' ? bsSample.exportLabel : 'BS 样表';
  const valuation = bsSample.valuation;
  const rows = bsSample.rows as Array<Record<string, unknown>>;
  const filtered = warehouse ? rows.filter((r) => r.warehouse === warehouse) : rows;
  return <section className={demoStyles.panel} aria-label="BS样表库存" data-testid="catalog-bs-sample-panel" data-warehouse-scope={warehouse ?? 'all'}>
    <h2 className="font-semibold">BS 样表库存与估算货值</h2>
    <p className={demoStyles.subtle}>{exportLabel} · 人民币单品进货价（不含运费、不含税）</p>
    {warehouse && <p className={demoStyles.subtle}>当前仓库：<strong>{warehouse}</strong> · <Link className={demoStyles.inlineLink} href={`/dashboard/catalog/${itemId}`}>查看全部仓库</Link></p>}
    <dl className={demoStyles.identityGrid}>
      <div><dt>采用进货价</dt><dd>{adopted.state === 'priced' ? <span data-testid="bs-adopted-unit-cost">¥{adopted.amountCny}</span> : adopted.reason ?? '缺价'}</dd></div>
      <div><dt>估算货值（{warehouse ?? '全部仓库'}）</dt><dd>
        {valuation.valuationState === 'valued' ? <strong data-testid="bs-estimated-value">¥{valuation.estimatedValueCny}</strong>
          : valuation.valuationReason ?? valuation.valuationState}
      </dd></div>
      <div><dt>已确认样表行</dt><dd>{filtered.filter((r) => r.selectionState === 'confirmed').length} 行</dd></div>
    </dl>
    {!filtered.length && <p className={demoStyles.subtle}>{warehouse ? '本仓无对应 BS 样表行（不当作 0）' : '暂无样表行'}</p>}
    {filtered.length > 0 && <div className={demoStyles.tableScroll}><table className={demoStyles.table} data-testid="catalog-bs-sample-inventory-table">
      <thead><tr>
        <th>仓库</th><th>SKU</th><th>选择</th><th>现有</th><th>订单已锁</th><th>整仓可用</th><th>活动预留</th><th>在途</th>
      </tr></thead>
      <tbody>{filtered.map((r) => <tr key={`${String(r.excelRow)}-${String(r.warehouse)}`} data-testid={`bs-row-${String(r.warehouse)}-${String(r.sku)}`}>
        <td>{String(r.warehouse)}</td><td>{String(r.sku)}</td><td>{bsSelectionLabel(String(r.selectionState))}</td>
        <td data-testid="bs-on-hand">{qtyCell(r.onHand)}</td>
        <td data-testid="bs-order-locked">{qtyCell(r.orderLocked)}</td>
        <td data-testid="bs-warehouse-available">{qtyCell(r.warehouseAvailable)}</td>
        <td data-testid="bs-activity-reserved">{qtyCell(r.activityReserved)}</td>
        <td data-testid="bs-in-transit">{qtyCell(r.inTransit)}</td>
      </tr>)}</tbody>
    </table></div>}
  </section>;
}

export function CatalogDetail({
  core,
  bsSample = null,
  bsSampleError = null,
  warehouseFilter,
  embedded = false,
  onRevisionSaved,
}: {
  core: CatalogDetailCoreView;
  bsSample?: BsSampleDetail | null;
  bsSampleError?: { code: string; message: string } | null;
  warehouseFilter?: string;
  embedded?: boolean;
  onRevisionSaved?: () => void;
}) {
  const { item, flags, writeAccess, historical } = core;
  const router = useRouter();
  const [busy, startTransition] = useTransition();
  const [message, setMessage] = useState('');
  const [pendingRequest, setPendingRequest] = useState<PendingRequest | null>(null);
  const [amounts, setAmounts] = useState<unknown>(null);
  const [audit, setAudit] = useState<CatalogDetailAuditView | null>(null);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [history, setHistory] = useState<CatalogItemRevisionDto[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyEmptyConfirmed, setHistoryEmptyConfirmed] = useState(false);
  const [auditEmptyConfirmed, setAuditEmptyConfirmed] = useState(false);
  const [artifacts, setArtifacts] = useState<Array<{ artifactId: string; logicalName: string }> | null>(null);
  const [artifactsLoading, setArtifactsLoading] = useState(false);
  const [artifactsError, setArtifactsError] = useState<string | null>(null);
  const [artifactsEmptyConfirmed, setArtifactsEmptyConfirmed] = useState(false);
  const [amountsLoading, setAmountsLoading] = useState(false);
  const [amountsError, setAmountsError] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const codeForm = useRef<HTMLFormElement>(null);
  const revisionForm = useRef<HTMLFormElement>(null);
  const specField = item.fields.specification ?? item.specification;
  const specBusiness = specField ? fieldBusinessValue(specField) : fieldBusinessValue(item.specification);
  const barcodeBusiness = fieldBusinessValue(item.fields.barcode) !== '待补'
    ? fieldBusinessValue(item.fields.barcode)
    : fieldBusinessValue(item.barcodeRefs[0]);

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
        const savedIntent = request.kind === 'initial_code' ? `首次补码已保存：${request.input.code}`
          : '资料修订已保存；旧版本和采用价格保持';
        setMessage(savedIntent);
        onRevisionSaved?.();
      } else setMessage(result.error ?? '原请求未保存。');
      router.refresh();
    } catch {
      setMessage('提交结果暂未确认。请使用“核对/重试原请求”，不要创建另一项操作。');
    }
  }
  const auditRequestSeq = useRef(0);
  const auditInFlightRef = useRef(false);
  const auditAttemptedRef = useRef(false);
  const auditAliveRef = useRef(true);

  useEffect(() => {
    auditAliveRef.current = true;
    return () => { auditAliveRef.current = false; };
  }, []);

  /**
   * One bounded automatic prefetch per mounted item. `auditAttemptedRef` is set before the request so a
   * failure cannot re-trigger the effect (the callback identity no longer depends on the loading state);
   * retries are explicit only. Late responses after unmount/item switch are dropped.
   */
  const loadAudit = useCallback(async (force = false) => {
    if (auditInFlightRef.current) return;
    if (!force && auditAttemptedRef.current) return;
    auditAttemptedRef.current = true;
    auditInFlightRef.current = true;
    const seq = ++auditRequestSeq.current;
    setAuditLoading(true);
    setAuditError(null);
    try {
      const result = await fetchCatalogDetailAuditAction(item.itemId);
      if (!auditAliveRef.current || seq !== auditRequestSeq.current) return;
      if (!result.success || !result.data) {
        setAuditError(result.error ?? '审计区读取失败');
        return;
      }
      setAudit(result.data);
      const empty = result.data.candidates.bigseller.length === 0 && result.data.candidates.jushuitan.length === 0;
      if (empty) setAuditEmptyConfirmed(true);
    } catch {
      if (!auditAliveRef.current || seq !== auditRequestSeq.current) return;
      setAuditError('审计区读取失败，请重试。');
    } finally {
      auditInFlightRef.current = false;
      if (auditAliveRef.current && seq === auditRequestSeq.current) setAuditLoading(false);
    }
  }, [item.itemId]);

  useEffect(() => {
    if (historical) return;
    startTransition(() => {
      void loadAudit();
    });
  }, [historical, loadAudit, startTransition]);

  function retryAudit() {
    if (auditInFlightRef.current) return;
    auditAttemptedRef.current = false;
    setAudit(null);
    setAuditEmptyConfirmed(false);
    void loadAudit(true);
  }

  async function loadArtifacts(force = false) {
    if (!force && (artifacts || artifactsLoading || artifactsEmptyConfirmed)) return;
    setArtifactsLoading(true);
    setArtifactsError(null);
    try {
      const result = await fetchCatalogDetailArtifactsAction();
      if (!result.success || !result.data) {
        setArtifactsError(result.error ?? '证据清单读取失败');
        return;
      }
      setArtifacts(result.data);
      if (result.data.length === 0) setArtifactsEmptyConfirmed(true);
    } catch {
      setArtifactsError('证据清单读取失败，请重试。');
    } finally {
      setArtifactsLoading(false);
    }
  }

  function retryArtifacts() {
    setArtifacts(null);
    setArtifactsEmptyConfirmed(false);
    void loadArtifacts(true);
  }

  async function loadHistory() {
    if (history.length > 0 || historyLoading || historyEmptyConfirmed) return;
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const result = await fetchCatalogDetailHistoryAction(item.itemId);
      if (!result.success) {
        setHistoryError(result.error ?? '历史版本读取失败');
        return;
      }
      const rows = result.data ?? [];
      setHistory(rows);
      if (rows.length === 0) setHistoryEmptyConfirmed(true);
    } catch {
      setHistoryError('历史版本读取失败，请重试。');
    } finally {
      setHistoryLoading(false);
    }
  }

  async function reconcileOriginal(request: PendingRequest) {
    if (!writeAccess.isScoped) return submitOriginal(request);
    try {
      const result = await recoverCatalogNewItemRequestAction(request);
      if (!result.success) { setMessage('原请求尚无法核对，仍保留未知状态与原意图。'); return; }
      if (!result.data) return submitOriginal(request);
      setPendingRequest(null); setMessage(`已只读核实原请求 ${request.input.requestId}，资料版本 ${result.data.revision}。`); router.refresh();
    } catch { setMessage('原请求尚无法核对，仍保留未知状态与原意图。'); }
  }
  const brushPending = flags.brushPending;

  return <div className={demoStyles.detailOnly}>
    {!auditLoading && (audit || auditError) ? (
      <span data-testid="catalog-audit-ready" aria-hidden="true" className="sr-only" />
    ) : null}
    {!embedded && <Link className={demoStyles.textLink} href="/dashboard/catalog">返回商品资料</Link>}
    <section className={demoStyles.panel}>
      {!embedded && (
      <div className={demoStyles.detailHeader}>
        <div>
          <p className={demoStyles.eyebrow}>PRODUCT / TRACEABILITY</p>
          <h1 style={{ fontSize: 22, margin: 0 }}>{item.iceCode ?? '待补货号'} · {item.nameCn}</h1>
          <p className={demoStyles.subtle}>真实商品档案 · 身份、来源与样表库存</p>
        </div>
      </div>
      )}
      <div className={demoStyles.identityHero}>
        <span className={`${demoStyles.productArt} ${demoStyles.productArtLarge}`} aria-label="暂无商品图片"><Package size={32} strokeWidth={1.3} /><small>暂无商品图片</small></span>
        <div>
          <Pill tone="blue">人工维护货号</Pill>
          <h3 style={{ margin: '8px 0 4px' }}>{item.nameCn}</h3>
          <p>资料版本 <span data-testid="item-revision">{item.revision}</span> · ICE货号 <strong data-testid="item-code">{item.iceCode ?? '待补货号'}</strong></p>
          <Pill tone={item.newProductConfirmed && !item.iceCode ? 'amber' : historical ? 'neutral' : 'green'}>{item.newProductConfirmed && !item.iceCode ? '新品，待补货号' : historical ? '历史资料版本' : '当前采用资料'}</Pill>
          {brushPending && <Pill tone="amber">刷子待确认，分列保留</Pill>}
        </div>
      </div>
      <p className={demoStyles.detailHint}>人工决定：JST {item.humanChoices.jushuitan}条，BS {item.humanChoices.bigseller}条 · <Link className={demoStyles.inlineLink} href="/dashboard/catalog/sources">逐来源核实附注</Link></p>
      {historical && <p className={demoStyles.detailHint}>正在查看当时版本。<Link className={demoStyles.inlineLink} href={`/dashboard/catalog/${item.itemId}`}>查看当前资料</Link></p>}
      {!embedded && (
        <Link className={demoStyles.inlineLink} target="_blank" rel="noreferrer" href={`/dashboard/catalog/${item.itemId}${warehouseFilter ? `?warehouse=${encodeURIComponent(warehouseFilter)}` : ''}`}>在新标签打开可分享地址</Link>
      )}
    </section>

    <section aria-label="基础资料" className={demoStyles.panel}>
      <h2 className="font-semibold mb-3">基础资料</h2>
      <dl className={demoStyles.identityGrid}>
        <div><dt>公司货号（ICE）</dt><dd data-testid="item-code-inline">{item.iceCode ?? '待补货号'}</dd></div>
        <div><dt>中文产品名称</dt><dd>{item.nameCn}</dd></div>
        <div><dt>69编码（字符串）</dt><dd className={demoStyles.codeCell}>{barcodeBusiness}</dd></div>
        <div><dt>英文名称</dt><dd>{fieldBusinessValue(item.fields.englishName)}</dd></div>
        <div><dt>规格 / 单位</dt><dd>{specBusiness} / {fieldBusinessValue(item.fields.unit)}</dd></div>
        <div><dt>商品分类</dt><dd>{fieldBusinessValue(item.fields.category)}</dd></div>
        <div><dt>生产工厂</dt><dd>{fieldBusinessValue(item.fields.factory)}</dd></div>
        <div><dt>包装</dt><dd>{fieldBusinessValue(item.fields.packaging)}</dd></div>
        <div><dt>装箱数量</dt><dd>{fieldBusinessValue(item.fields.cartonQuantity)}</dd></div>
      </dl>
      <details className="mt-4"><summary className={demoStyles.subtle}>展开审计字段与内部键名</summary>
        <dl className="grid gap-2 sm:grid-cols-2 mt-2 text-sm">
          <div><dt>商品 UUID</dt><dd data-testid="item-uuid" className="break-all">{item.itemId}</dd></div>
          {PRIMARY_FIELD_KEYS.map((key) => {
            const field = key === 'specification' ? specField : item.fields[key];
            if (!field && key !== 'nameCn') return null;
            return <div key={key}><dt>{CATALOG_FIELD_LABELS[key] ?? key}</dt><dd>{field ? fieldAuditValue(field) : '—'}</dd></div>;
          })}
        </dl>
      </details>
    </section>

    {!historical && <BsSampleBusinessBlock itemId={item.itemId} bsSample={bsSample} bsSampleError={bsSampleError ?? null} warehouse={warehouseFilter} />}

    {!historical && writeAccess.canWrite && <details className={demoStyles.panel} open={editOpen} onToggle={(e) => setEditOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="font-semibold cursor-pointer">编辑资料（点击展开）</summary>
      <div className="space-y-4 mt-3" aria-label="补充资料">
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
        <Button type="submit">保存非价格修订</Button>
        </fieldset>
      </form>
      <p role="status" aria-live="polite">{message}</p>
      {pendingRequest && <section aria-label="待核对原请求" data-testid="pending-original-request" className="space-y-2 border rounded p-3">
        <Button type="button" variant="outline" disabled={busy} onClick={() => startTransition(() => reconcileOriginal(pendingRequest))}>核对/重试原请求</Button>
      </section>}
      </div>
    </details>}
    {!historical && !writeAccess.canWrite && <p data-testid="catalog-write-denied">当前账号仅可查看已采用资料；补码和修订需要创建来源范围的当前发布权限。</p>}

    <details className={demoStyles.panel} onToggle={(event) => {
      if ((event.target as HTMLDetailsElement).open) void loadAudit();
    }}><summary className="font-semibold cursor-pointer">JST 与 BS 来源候选（按需审计）</summary>
      {auditLoading && <p className={demoStyles.subtle} role="status">加载来源候选…</p>}
      {auditError && <p role="alert" data-testid="catalog-audit-error">{auditError} <button type="button" className={demoStyles.textLink} onClick={retryAudit}>重试</button></p>}
      {!auditLoading && auditEmptyConfirmed && audit && audit.candidates.bigseller.length === 0 && audit.candidates.jushuitan.length === 0 && (
        <p className={demoStyles.subtle} data-testid="catalog-candidates-empty">已确认：当前资料下 JST 与 BS 均无候选观测（不是读取失败）。</p>
      )}
      {audit && <div className="space-y-4 mt-3">
        {(['jushuitan', 'bigseller'] as const).map((source) => <div key={source}><h3 className="font-semibold">{source === 'jushuitan' ? 'JST' : 'BS'}</h3>
          <Table><TableHeader><TableRow><TableHead>SKU / 名称</TableHead><TableHead>依据</TableHead><TableHead>冲突提示</TableHead></TableRow></TableHeader><TableBody>
            {audit.candidates[source].map((c) => <TableRow key={c.observationId} data-testid={`catalog-candidate-${c.observationId}`}><TableCell>{c.sku ?? '未提供SKU'}<p>{c.name}</p></TableCell><TableCell>{c.basis.join('、')}</TableCell><TableCell>{c.conflicts.join('；') || '—'}</TableCell></TableRow>)}
          </TableBody></Table>
        </div>)}
      </div>}
    </details>

    <details className={demoStyles.panel} onToggle={(event) => {
      if ((event.target as HTMLDetailsElement).open) void loadHistory();
    }}><summary className="font-semibold cursor-pointer">资料历史（按需审计）</summary>
      {historyLoading && <p className={demoStyles.subtle}>加载历史版本…</p>}
      {historyError && <p role="alert">{historyError} <button type="button" className={demoStyles.textLink} onClick={() => { setHistoryEmptyConfirmed(false); setHistory([]); void loadHistory(); }}>重试</button></p>}
      {!historyLoading && historyEmptyConfirmed && history.length === 0 && <p className={demoStyles.subtle} data-testid="catalog-history-empty">暂无历史版本记录。</p>}
      <ul className="space-y-2 mt-2">{history.map((h) => <li key={h.revision} data-testid={`revision-history-${h.revision}`}>
        <Link className="underline" href={`/dashboard/catalog/${item.itemId}?revision=${h.revision}`}>版本 {h.revision} · {h.iceCode ?? '待补货号'} · {h.nameCn}</Link>
        <p className="text-sm break-all" data-testid="revision-reason">{h.revisionAudit.reason}</p>
      </li>)}</ul>
    </details>

    <details className={demoStyles.panel} onToggle={(event) => {
      if ((event.target as HTMLDetailsElement).open) void loadAudit();
    }}><summary className="font-semibold cursor-pointer">来源差异与原始观测 JSON（按需审计）</summary>
      {auditLoading && <p className={demoStyles.subtle} role="status">加载审计 JSON…</p>}
      {auditError && !audit && <p role="alert" data-testid="catalog-audit-json-error">{auditError} <button type="button" className={demoStyles.textLink} onClick={retryAudit}>重试</button></p>}
      {audit && <pre className="text-xs whitespace-pre-wrap break-all mt-2 max-h-[420px] overflow-auto" data-testid="catalog-audit-json">{JSON.stringify({ differences: audit.differences, decisions: audit.decisions, observations: audit.observations }, null, 2)}</pre>}
    </details>

    <section className={`${demoStyles.panel} space-y-3`} aria-label="受限证据">
      <h2 className="font-semibold">金额与原始证据（按需）</h2>
      {bsSample?.status === 'loaded' && (
        <details className={demoStyles.subtle}>
          <summary>技术说明：估值口径指纹</summary>
          <p data-testid="bs-basis-sha">SHA256：{bsSample.basisDocumentSha256 ?? '—'}</p>
        </details>
      )}
      <Button variant="outline" disabled={busy || amountsLoading} data-testid="load-restricted-amounts" onClick={() => startTransition(async () => {
        setAmountsLoading(true);
        setAmountsError(null);
        setAmounts(null);
        try {
          const result = await getCatalogAmountsAction(item.itemId);
          if (result.success) setAmounts(result.data);
          else {
            setAmounts(null);
            setAmountsError(result.error ?? '金额读取失败');
          }
        } catch {
          setAmounts(null);
          setAmountsError('金额读取失败（网络或传输异常），无效数值已清除。');
        } finally {
          setAmountsLoading(false);
        }
      })}>{amountsLoading ? '读取中…' : '读取受限金额'}</Button>
      {amountsError && <p role="alert" data-testid="restricted-amounts-error">{amountsError}</p>}
      {amounts !== null && <pre data-testid="restricted-amounts" className="text-xs whitespace-pre-wrap break-all">{JSON.stringify(amounts, null, 2)}</pre>}
      <details onToggle={(event) => { if ((event.target as HTMLDetailsElement).open) void loadArtifacts(); }}>
        <summary>完整原始证据下载（含价格，受限）</summary>
        {artifactsLoading && <p className={demoStyles.subtle} role="status">加载证据清单…</p>}
        {artifactsError && <p role="alert" data-testid="catalog-artifacts-error">{artifactsError} <button type="button" className={demoStyles.textLink} onClick={retryArtifacts}>重试</button></p>}
        {artifacts && artifacts.length === 0 && !artifactsLoading && !artifactsError && <p className={demoStyles.subtle} data-testid="catalog-artifacts-empty">已确认：当前无可用原始证据下载项。</p>}
        {artifacts && artifacts.length > 0 && <ul className="text-sm space-y-1">{artifacts.map((a) => <li key={a.artifactId}><a className="underline" href={`/api/catalog/evidence/${a.artifactId}?projection=raw`}>{a.logicalName}</a></li>)}</ul>}
      </details>
    </section>
  </div>;
}
