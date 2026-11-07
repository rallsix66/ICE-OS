'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FileSpreadsheet, Loader2, RefreshCw } from 'lucide-react';
import syncStyles from '@/features/inventory/components/sync-view.module.css';
import demoStyles from '@/ui/ice-v4/ice-v4.module.css';
import { StatusPill } from '@/features/inventory/components/display';
import type { Tone } from '@/features/inventory/model';
import { ShipmentGroupingReviewEntry } from './shipment-grouping-review';
import { formatTimestamp, shipmentFailureReason } from '../model';
import type {
  ShipmentGroupingReviewsDto,
  ShipmentRefreshResultDto,
  ShipmentSourceStatusDto,
} from '../types';
import { refreshShipmentSource } from '../server/actions';

/**
 * 「数据同步」里的飞书 · 物流在途来源卡（第十五轮：去掉卡片「详情」）。
 *
 * - 与 BigSeller、聚水潭同一网格/等高：主区域字段顺序固定「最近成功 / 下次同步 / 待处理」；
 * - 卡片不再有「详情」按钮或展开区；最近尝试、自动读取、技术错误统一放在三卡下方的同步记录里；
 * - 失败在卡片上只显示一句简短原因；
 * - 待处理 = 当前拆票/合票待复核数，点击打开与物流在途页相同的复核弹窗（同一组件）；
 * - 刷新来源仍是唯一写动作，读取状态统一在本页；库存同步 worker 不在这里启停。
 */
export function ShipmentSyncSource({
  status,
  error,
  reviews,
  reviewsError,
}: {
  status: ShipmentSourceStatusDto | null;
  error: string | null;
  /** 拆票/合票待复核数据（服务端读取；null = 未读到）。 */
  reviews: ShipmentGroupingReviewsDto | null;
  reviewsError: string | null;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ShipmentRefreshResultDto | null>(null);
  const [localError, setLocalError] = useState('');

  async function onRefresh() {
    if (pending) return;
    setPending(true);
    setLocalError('');
    try {
      const next = await refreshShipmentSource();
      setResult(next);
      router.refresh();
    } catch {
      setLocalError('刷新失败：网络或传输异常');
    } finally {
      setPending(false);
    }
  }

  const auto = status?.autoReader ?? null;
  const attempt = status?.lastAttempt ?? null;
  const lastSuccess = status?.lastSuccess ?? null;
  const attemptFailed = attempt?.status === 'failed' || Boolean(localError)
    || (result !== null && !result.ok);
  const failed = attemptFailed;

  let label = '未读取';
  let tone: Tone = 'neutral';
  if (error) {
    label = '状态读取失败';
    tone = 'red';
  } else if (pending || auto?.running) {
    label = '读取中';
    tone = 'blue';
  } else if (failed) {
    label = '读取失败';
    tone = 'red';
  } else if (attempt?.status === 'success') {
    label = '正常';
    tone = 'green';
  }

  const lastSuccessText = lastSuccess
    ? `${formatTimestamp(lastSuccess.readAt) || '时间未记录'} · ${lastSuccess.ticketCount ?? 0} 票 / ${lastSuccess.itemCount ?? 0} 条明细`
    : '还没有成功读取';

  /* 卡片上只用一句失败原因，不铺技术解释；错误码与最近尝试在下方同步记录里。 */
  const failureReason = localError
    || (result && !result.ok ? shipmentFailureReason(result.errorCode, result.errorMessage) : '')
    || (attempt?.status === 'failed' ? shipmentFailureReason(attempt.errorCode, attempt.errorMessage) : '')
    || (auto?.lastResult === 'failed' ? auto.lastErrorMessage ?? '' : '');

  const nextPlanText = auto?.enabled
    ? (formatTimestamp(auto.nextRunAt) || '待确认')
    : '自动读取未启用';

  return (
    <section
      className={`${syncStyles.sourceCard} ${syncStyles.cardFeishu}`}
      id="feishu-shipment"
      data-testid="sync-shipment-source"
      data-stagger="2"
      aria-label="飞书物流在途"
    >
      <header className={syncStyles.cardHead}>
        <span className={syncStyles.cardIcon} aria-hidden>
          <FileSpreadsheet size={18} strokeWidth={1.8} />
        </span>
        <div className={syncStyles.cardIdentity}>
          <h2>飞书</h2>
          <span className={syncStyles.cardPurpose}>物流在途</span>
        </div>
        <div className={syncStyles.cardStatus} data-testid="sync-shipment-status">
          <StatusPill tone={tone}>{label}</StatusPill>
        </div>
      </header>

      <dl className={syncStyles.cardFacts}>
        <div data-testid="sync-shipment-last-success">
          <dt>最近成功</dt>
          <dd>{lastSuccessText}</dd>
        </div>
        <div data-testid="sync-shipment-next">
          <dt>下次同步</dt>
          <dd>{nextPlanText}</dd>
        </div>
        <div data-testid="sync-shipment-pending">
          <dt>待处理</dt>
          <dd>
            <ShipmentGroupingReviewEntry reviews={reviews} error={reviewsError} />
          </dd>
        </div>
      </dl>

      {failureReason ? (
        <p className={syncStyles.blockedNote} data-testid="sync-shipment-failure-reason">
          {failureReason}
        </p>
      ) : null}

      <div className={syncStyles.cardActions}>
        <button
          type="button"
          className={syncStyles.primaryButton}
          onClick={() => void onRefresh()}
          disabled={pending}
          data-testid="sync-shipment-refresh"
        >
          {pending ? <Loader2 size={14} aria-hidden /> : <RefreshCw size={14} aria-hidden />}
          {pending ? '正在读取' : '刷新来源'}
        </button>
        <Link className={syncStyles.sourceLink} href="/dashboard/in-transit" data-testid="sync-shipment-open">
          查看物流在途
        </Link>
      </div>
    </section>
  );
}

/** 飞书来源读取记录：三卡下方「同步记录」里的原卡片「详情」内容（最近尝试/自动读取/技术错误）。 */
export function ShipmentSourceNotes({
  status,
  error,
}: {
  status: ShipmentSourceStatusDto | null;
  error: string | null;
}) {
  const auto = status?.autoReader ?? null;
  const attempt = status?.lastAttempt ?? null;
  const lastSuccess = status?.lastSuccess ?? null;
  const attemptText = attempt
    ? `${formatTimestamp(attempt.readAt) || '时间未记录'} · ${attempt.status === 'failed'
      ? `失败 · ${shipmentFailureReason(attempt.errorCode, attempt.errorMessage)}`
      : `成功 · ${lastSuccess?.ticketCount ?? 0} 票 / ${lastSuccess?.itemCount ?? 0} 条明细`}`
    : '还没有读取记录';
  const autoText = auto
    ? `${auto.enabled ? `每 ${auto.intervalMinutes} 分钟` : '未启用'} · 最近结果 ${
      auto.lastResult === 'success' ? '成功' : auto.lastResult === 'unchanged' ? '无变化' : auto.lastResult === 'failed' ? '失败' : '未记录'
    }`
    : '自动读取状态未读取';
  const technical = [
    attempt?.errorCode ? `最近尝试错误码：${attempt.errorCode}` : null,
    attempt?.errorMessage ? `最近尝试错误：${attempt.errorMessage}` : null,
    auto?.lastResult === 'failed' && auto.lastErrorMessage ? `后台读取错误：${auto.lastErrorMessage}` : null,
    error ? `状态读取错误：${error}` : null,
  ].filter(Boolean) as string[];
  return (
    <section className={syncStyles.detailSection} data-testid="sync-shipment-notes" aria-label="飞书来源读取记录">
      <div className={syncStyles.sectionHeader}>
        <h2>飞书来源读取记录</h2>
      </div>
      <div className={syncStyles.sectionBody}>
        <dl className={demoStyles.detailList}>
          <div data-testid="sync-shipment-last-attempt">
            <dt>最近尝试</dt>
            <dd>{attemptText}</dd>
          </div>
          <div>
            <dt>自动读取</dt>
            <dd>{autoText}</dd>
          </div>
        </dl>
        {technical.length > 0 ? (
          <ul className={syncStyles.cardAlerts} data-testid="sync-shipment-technical">
            {technical.map((entry) => <li key={entry}>{entry}</li>)}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
