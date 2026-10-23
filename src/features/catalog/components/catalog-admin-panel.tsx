'use client';

import { useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import demoStyles from '@/ui/ice-v4/ice-v4.module.css';
import { Button } from '@/components/ui/button';
import { prepareBaselineAction, publishBaselineAction, importFrozenObservationsAction, fetchCatalogAdminDecisionsAction, fetchCatalogAdminObservationsAction } from '../actions';
import type { getCatalogOverview } from '../service';

type Overview = Awaited<ReturnType<typeof getCatalogOverview>>;

type ChunkState = {
  loading: boolean;
  error: string | null;
  total: number;
  rows: unknown[];
  offset: number;
};

const emptyChunk = (): ChunkState => ({ loading: false, error: null, total: 0, rows: [], offset: 0 });

export function CatalogAdminPanel({ overview }: { overview: Overview }) {
  const router = useRouter();
  const [preview, setPreview] = useState<{ previewId: string; fullManifestCount: number; subsetManifestCount: number } | null>(null);
  const [message, setMessage] = useState('');
  const [unresolved, setUnresolved] = useState(false);
  const [busy, startTransition] = useTransition();
  const [decisions, setDecisions] = useState<ChunkState>(emptyChunk);
  const [observations, setObservations] = useState<ChunkState>(emptyChunk);
  const publishRequest = useRef<{ requestId: string; previewId: string } | null>(null);
  const frozenRequest = useRef<{ requestId: string; approvedSnapshotId: 'feishu-partial-20261020-v2' } | null>(null);

  async function loadDecisions(offset = 0) {
    setDecisions((prev) => ({ ...prev, loading: true, error: null }));
    const result = await fetchCatalogAdminDecisionsAction(offset, 100);
    const data = result.success ? result.data : undefined;
    if (!data) {
      setDecisions((prev) => ({ ...prev, loading: false, error: result.error ?? '读取失败' }));
      return;
    }
    setDecisions((prev) => ({
      loading: false,
      error: null,
      total: data.total,
      offset,
      rows: offset === 0 ? data.rows : [...prev.rows, ...data.rows],
    }));
  }

  async function loadObservations(offset = 0) {
    setObservations((prev) => ({ ...prev, loading: true, error: null }));
    const result = await fetchCatalogAdminObservationsAction(offset, 50);
    const data = result.success ? result.data : undefined;
    if (!data) {
      setObservations((prev) => ({ ...prev, loading: false, error: result.error ?? '读取失败' }));
      return;
    }
    setObservations((prev) => ({
      loading: false,
      error: null,
      total: data.total,
      offset,
      rows: offset === 0 ? data.rows : [...prev.rows, ...data.rows],
    }));
  }

  return <div className={`${demoStyles.panel} space-y-4`}>
    <Link className={demoStyles.textLink} href="/dashboard/catalog">返回商品资料浏览</Link>
    <h1 className="text-2xl font-semibold">商品资料管理与审计</h1>
    <p className={demoStyles.subtle}>固定基线承接、冻结观测导入；完整人工决定/来源 JSON 按需分页读取，不在首屏序列化。</p>
    <section className={`${demoStyles.panel} space-y-3`} aria-label="基线承接">
      <p data-testid="catalog-counts">资料 {overview.stats.items} · 货号 {overview.stats.coded} · 冻结基线资料 {overview.release?.itemCount ?? 0} · 基线来源 {overview.stats.observations} · 有效人工选择 {overview.stats.choices} · 历史证据 {overview.stats.history}</p>
      <div className={demoStyles.buttonRow}>
        <Button disabled={busy} onClick={() => startTransition(async () => {
          const result = await prepareBaselineAction();
          if (result.success) { setPreview(result.data!); setMessage('固定基线预览已准备，尚未发布'); }
          else setMessage(result.error ?? '操作未完成');
        })}>准备固定基线预览</Button>
        {preview && <Button disabled={busy} onClick={() => startTransition(async () => {
          const input = publishRequest.current ?? { requestId: crypto.randomUUID(), previewId: preview.previewId };
          publishRequest.current = input;
          const result = await publishBaselineAction(input);
          if (result.outcome !== 'unknown') publishRequest.current = null;
          setUnresolved(result.outcome === 'unknown');
          setMessage(result.success ? '固定基线已原子承接；重导沿用既有记录' : (result.error ?? '操作未完成')); router.refresh();
        })}>发布固定基线</Button>}
        {overview.release && <Button variant="outline" disabled={busy} onClick={() => startTransition(async () => {
          const input = frozenRequest.current ?? { requestId: crypto.randomUUID(), approvedSnapshotId: 'feishu-partial-20261020-v2' as const };
          frozenRequest.current = input;
          const result = await importFrozenObservationsAction(input);
          if (result.outcome !== 'unknown') frozenRequest.current = null;
          setUnresolved(result.outcome === 'unknown');
          setMessage(result.success ? '飞书冻结 partial 观测已承接：159格，完整性未核实' : (result.error ?? '操作未完成')); router.refresh();
        })}>承接冻结飞书观测</Button>}
      </div>
      {preview && <p data-testid="manifest-counts">完整产物 {preview.fullManifestCount} 份；JSON/CSV子集 {preview.subsetManifestCount} 份。</p>}
      <p role="status" aria-live="polite">{message}</p>
      {unresolved && <p className={demoStyles.subtle}>请求结果待核对。再次点击沿用原请求与意图；请勿关闭页面后盲目重复操作。</p>}
    </section>
    <details className={`${demoStyles.panel} border rounded p-4`} onToggle={(event) => {
      if ((event.target as HTMLDetailsElement).open && decisions.rows.length === 0 && !decisions.loading) void loadDecisions(0);
    }}>
      <summary>查看人工决定与历史索引（分页只读）</summary>
      {decisions.error && <p role="alert">{decisions.error}</p>}
      {decisions.loading && decisions.rows.length === 0 && <p className={demoStyles.subtle}>加载首批记录…</p>}
      {decisions.rows.length > 0 && <pre className="text-xs whitespace-pre-wrap break-all max-h-[420px] overflow-auto">{JSON.stringify(decisions.rows, null, 2)}</pre>}
      {decisions.rows.length < decisions.total && (
        <Button type="button" variant="outline" disabled={decisions.loading} onClick={() => void loadDecisions(decisions.offset + 100)}>
          {decisions.loading ? '加载中…' : `加载更多（已显示 ${decisions.rows.length}/${decisions.total}）`}
        </Button>
      )}
    </details>
    <details className={`${demoStyles.panel} border rounded p-4`} onToggle={(event) => {
      if ((event.target as HTMLDetailsElement).open && observations.rows.length === 0 && !observations.loading) void loadObservations(0);
    }}>
      <summary>查看非金额来源观测（分页只读）</summary>
      {observations.error && <p role="alert">{observations.error}</p>}
      {observations.loading && observations.rows.length === 0 && <p className={demoStyles.subtle}>加载首批记录…</p>}
      {observations.rows.length > 0 && <pre className="text-xs whitespace-pre-wrap break-all max-h-[420px] overflow-auto">{JSON.stringify(observations.rows, null, 2)}</pre>}
      {observations.rows.length < observations.total && (
        <Button type="button" variant="outline" disabled={observations.loading} onClick={() => void loadObservations(observations.offset + 50)}>
          {observations.loading ? '加载中…' : `加载更多（已显示 ${observations.rows.length}/${observations.total}）`}
        </Button>
      )}
    </details>
  </div>;
}
