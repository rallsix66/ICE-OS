'use client';

import { useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { prepareBaselineAction, publishBaselineAction, importFrozenObservationsAction } from '../actions';
import type { getCatalogOverview } from '../service';

type Overview = Awaited<ReturnType<typeof getCatalogOverview>>;

export function CatalogAdminPanel({ overview }: { overview: Overview }) {
  const router = useRouter();
  const [preview, setPreview] = useState<{ previewId: string; fullManifestCount: number; subsetManifestCount: number } | null>(null);
  const [message, setMessage] = useState('');
  const [unresolved, setUnresolved] = useState(false);
  const [busy, startTransition] = useTransition();
  const publishRequest = useRef<{ requestId: string; previewId: string } | null>(null);
  const frozenRequest = useRef<{ requestId: string; approvedSnapshotId: 'feishu-partial-20261020-v2' } | null>(null);
  return <div className="space-y-4">
    <Link className="underline text-sm" href="/dashboard/catalog">返回商品资料浏览</Link>
    <h1 className="text-2xl font-semibold">商品资料管理与审计</h1>
    <p className="text-sm text-gray-600">固定基线承接、冻结观测导入及完整人工决定/来源 JSON 仅在此入口操作。</p>
    <section className="rounded-lg border p-4 space-y-3" aria-label="基线承接">
      <p data-testid="catalog-counts">资料 {overview.stats.items} · 货号 {overview.stats.coded} · 冻结基线资料 {overview.release?.itemCount ?? 0} · 基线来源 {overview.stats.observations} · 有效人工选择 {overview.stats.choices} · 历史证据 {overview.stats.history}</p>
      <div className="flex flex-wrap gap-2">
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
      {unresolved && <p className="text-sm text-amber-700">请求结果待核对。再次点击沿用原请求与意图；请勿关闭页面后盲目重复操作。</p>}
    </section>
    <details className="border rounded p-4"><summary>查看全部原人工决定与历史索引（只读）</summary><pre className="text-xs whitespace-pre-wrap break-all">{JSON.stringify(overview.decisions, null, 2)}</pre></details>
    <details className="border rounded p-4"><summary>查看全部非金额来源观测（含忽略、拒绝及未确认）</summary><pre className="text-xs whitespace-pre-wrap break-all">{JSON.stringify(overview.observations, null, 2)}</pre></details>
  </div>;
}
