'use client';

import { useState } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { fetchCatalogDetailAttachmentsAction } from '../actions';
import { NewItemDetailAttachment } from './new-item-intake';
import { SourceIdentityAttachment } from './source-identity-panel';
import styles from './catalog-content.module.css';

type IdentityPanel = ComponentProps<typeof SourceIdentityAttachment>['panel'];
type ProductPanel = NonNullable<ComponentProps<typeof NewItemDetailAttachment>['panel']>;

export type AttachmentSideKey = 'identity' | 'product';
/**
 * 逐侧读取状态（R6）：未启用、无权限、读取失败、真实空、可用必须分开表达，
 * 不允许任何一侧的失败被写成“未启用”或被 null 吞掉。
 */
export type AttachmentSideStatus = 'ready' | 'empty' | 'disabled' | 'forbidden' | 'read_failed' | 'invalid' | 'unknown';
export type DetailAttachmentSide<Panel> = {
  status: AttachmentSideStatus;
  panel: Panel | null;
  recordCount: number;
  reason: string | null;
};
export type DetailAttachmentsFailure = {
  side: AttachmentSideKey;
  status: Exclude<AttachmentSideStatus, 'ready' | 'empty' | 'disabled'>;
};
export type DetailAttachmentsSummary = 'ready' | 'partial' | 'failed' | 'forbidden' | 'unavailable';

/**
 * 弹窗与直链共用的附件投影（同一 DTO、同一组件、同一文案）。
 * 服务端（直链）与 action（弹窗/重试）都返回该结构；`DetailAttachmentsModel` 保留旧名供既有调用方使用。
 */
export type DetailAttachmentsState = {
  identity: DetailAttachmentSide<IdentityPanel>;
  product: DetailAttachmentSide<ProductPanel>;
  summary: DetailAttachmentsSummary;
  failures: DetailAttachmentsFailure[];
};
/** 旧容器仍可能传“面板或 null”的兼容形状；null 会被当作“状态未确认”，不会写成“未启用”。 */
export type LegacyDetailAttachmentsModel = {
  identity?: IdentityPanel | null;
  product?: ProductPanel | null;
};
export type DetailAttachmentsModel = DetailAttachmentsState | LegacyDetailAttachmentsModel;

export type DetailAttachmentsProps = {
  identity?: DetailAttachmentSide<IdentityPanel> | IdentityPanel | null;
  product?: DetailAttachmentSide<ProductPanel> | ProductPanel | null;
  summary?: DetailAttachmentsSummary;
  failures?: DetailAttachmentsFailure[];
  /** 新调用方也可显式传整份状态。 */
  state?: DetailAttachmentsState;
  itemId?: string;
  fromHref?: string;
};

const SIDE_LABEL: Record<AttachmentSideKey, string> = { identity: '来源身份与观测', product: '新品候选' };
const FAILURE_STATUSES: ReadonlySet<AttachmentSideStatus> = new Set(['read_failed', 'forbidden', 'invalid', 'unknown']);

const STATUS_LABEL: Record<AttachmentSideStatus, string> = {
  ready: '已读取',
  empty: '已读取 · 无记录',
  disabled: '当前未启用',
  forbidden: '无权限',
  read_failed: '读取失败',
  invalid: '商品标识无效',
  unknown: '状态未确认',
};

const STATUS_MESSAGE: Record<Exclude<AttachmentSideStatus, 'ready' | 'empty'>, string> = {
  disabled: '该模块当前未启用；既有冻结资料与人工选择保持，不当作 0 项。',
  forbidden: '账号没有这一侧的读取权限（系统拒绝）；这不代表没有记录，也不等于模块未启用。',
  read_failed: '读取失败（网络或传输异常）；这不等于未启用，也不当作 0 项。可单独重试这一侧。',
  invalid: '商品标识无效，无法读取这一侧的附件。',
  unknown: '读取状态未确认（可能是无权限或传输失败）；可重新读取确认，不当作 0 项。',
};

const SUMMARY_LABEL: Record<DetailAttachmentsSummary, string> = {
  ready: '可用',
  partial: '部分可用',
  failed: '读取失败',
  forbidden: '无权限',
  unavailable: '当前未启用',
};

/** 服务端返回的失败原因可能在文案里残留实现术语；展示层统一成业务中文，不改服务端事实。 */
function displayReason(reason: string | null): string | null {
  return reason ? reason.replace(/服务端/g, '系统') : null;
}

function isSide(value: unknown): value is DetailAttachmentSide<unknown> {
  return Boolean(value) && typeof value === 'object' && typeof (value as { status?: unknown }).status === 'string';
}

function identityCount(panel: IdentityPanel | null): number {
  if (!panel) return 0;
  return panel.sourceIdentity.length + panel.links.length + panel.observations.length + panel.frozenHumanChoice.length;
}

function productCount(panel: ProductPanel | null): number {
  if (!panel) return 0;
  return panel.candidates.bigseller.length + panel.candidates.jushuitan.length;
}

function deriveSummary(sides: { status: AttachmentSideStatus }[]): DetailAttachmentsSummary {
  const resolved = sides.filter((side) => side.status === 'ready' || side.status === 'empty');
  const failures = sides.filter((side) => FAILURE_STATUSES.has(side.status));
  if (resolved.length === sides.length) return 'ready';
  if (resolved.length > 0) return 'partial';
  if (failures.length === sides.length && sides.every((side) => side.status === 'forbidden')) return 'forbidden';
  if (failures.length > 0) return 'failed';
  return 'unavailable';
}

function deriveFailures(sides: { side: AttachmentSideKey; status: AttachmentSideStatus }[]): DetailAttachmentsFailure[] {
  return sides
    .filter((side): side is { side: AttachmentSideKey; status: DetailAttachmentsFailure['status'] } => FAILURE_STATUSES.has(side.status))
    .map((side) => ({ side: side.side, status: side.status }));
}

/** 旧调用方（容器仍传 `{identity, product}` 面板或 null）兼容：null 表示“状态未确认”，绝不写成“未启用”。 */
function legacySide<Panel>(panel: Panel | null | undefined, key: AttachmentSideKey): DetailAttachmentSide<Panel> {
  if (panel === null || panel === undefined) {
    return { status: 'unknown', panel: null, recordCount: 0, reason: STATUS_MESSAGE.unknown };
  }
  if ((panel as { enabled?: boolean }).enabled === false) {
    return { status: 'disabled', panel: null, recordCount: 0, reason: STATUS_MESSAGE.disabled };
  }
  const recordCount = key === 'identity'
    ? identityCount(panel as unknown as IdentityPanel)
    : productCount(panel as unknown as ProductPanel);
  return recordCount === 0
    ? { status: 'empty', panel, recordCount, reason: null }
    : { status: 'ready', panel, recordCount, reason: null };
}

function normalize(props: DetailAttachmentsProps): DetailAttachmentsState {
  if (props.state) return props.state;
  const identity = isSide(props.identity) ? props.identity : legacySide(props.identity ?? null, 'identity');
  const product = isSide(props.product) ? props.product : legacySide(props.product ?? null, 'product');
  const summary = props.summary ?? deriveSummary([identity, product]);
  const failures = props.failures ?? deriveFailures([
    { side: 'identity', status: identity.status },
    { side: 'product', status: product.status },
  ]);
  return { identity, product, summary, failures };
}

/** 重试只替换被点的一侧；已成功读取的另一侧保留，避免一次重试把成功内容清空。 */
function mergeRetry(current: DetailAttachmentsState, next: DetailAttachmentsState, side: AttachmentSideKey): DetailAttachmentsState {
  const keep = <Panel,>(resolved: DetailAttachmentSide<Panel>) =>
    resolved.status === 'ready' || resolved.status === 'empty' || resolved.status === 'disabled';
  const identity = side === 'identity' ? next.identity : (keep(current.identity) ? current.identity : next.identity);
  const product = side === 'product' ? next.product : (keep(current.product) ? current.product : next.product);
  return {
    identity, product,
    summary: deriveSummary([identity, product]),
    failures: deriveFailures([
      { side: 'identity', status: identity.status },
      { side: 'product', status: product.status },
    ]),
  };
}

function signature(state: DetailAttachmentsState): string {
  return `${state.identity.status}:${state.identity.recordCount}|${state.product.status}:${state.product.recordCount}|${state.summary}`;
}

export function DetailAttachments(props: DetailAttachmentsProps) {
  const base = normalize(props);
  const baseKey = signature(base);
  const [override, setOverride] = useState<{ key: string; state: DetailAttachmentsState } | null>(null);
  const [retrying, setRetrying] = useState<AttachmentSideKey | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const view = override && override.key === baseKey ? override.state : base;

  async function retry(side: AttachmentSideKey) {
    if (!props.itemId || retrying) return;
    setRetrying(side);
    setRetryError(null);
    try {
      const next = await fetchCatalogDetailAttachmentsAction(props.itemId);
      setOverride({ key: baseKey, state: mergeRetry(view, next, side) });
    } catch {
      setRetryError('重新读取失败（网络或传输异常）；已读取的内容保持不变，可再次重试。');
    } finally {
      setRetrying(null);
    }
  }

  function renderSide<Panel>(side: AttachmentSideKey, state: DetailAttachmentSide<Panel>, renderPanel: (panel: Panel) => ReactNode) {
    const failure = FAILURE_STATUSES.has(state.status);
    const canRetry = failure && Boolean(props.itemId);
    const label = SIDE_LABEL[side];
    return <article className={styles.attachmentSide} data-side={side} data-status={state.status}
      data-testid={`catalog-attachment-${side}`}>
      <header className={styles.attachmentSideHead}>
        <h4 className={styles.attachmentSideTitle}>{label}</h4>
        <span className={`${styles.badge} ${failure ? styles.badgeWarn : styles.badgeIndigo}`}>{STATUS_LABEL[state.status]}</span>
      </header>
      {(state.status === 'ready' || state.status === 'empty') && state.panel && (
        <>
          <p className={styles.attachmentSideNote}>
            {state.status === 'empty'
              ? '已启用，当前已读范围没有相关记录（不是读取失败，也不当作 0 项）。'
              : `已读取 ${state.recordCount} 项；只读附注，不改写资料版本或原人工决定。`}
          </p>
          {renderPanel(state.panel)}
        </>
      )}
      {failure && (
        <div className={styles.attachmentSideError} role="alert" data-testid={`catalog-attachment-${side}-error`}>
          <p className={styles.attachmentSideErrorText}>{displayReason(state.reason) ?? STATUS_MESSAGE[state.status as keyof typeof STATUS_MESSAGE]}</p>
          {canRetry && (
            <Button type="button" variant="outline" disabled={Boolean(retrying)}
              data-testid={`catalog-attachment-${side}-retry`} onClick={() => void retry(side)}>
              {retrying === side ? '正在重新读取…' : `重新读取${label}`}
            </Button>
          )}
          {!props.itemId && <p className={styles.attachmentSideNote}>缺少商品标识，本页无法重试；请回到商品详情重新打开。</p>}
        </div>
      )}
      {state.status === 'disabled' && <p className={styles.attachmentSideNote}>{STATUS_MESSAGE.disabled}</p>}
    </article>;
  }

  return <div className={styles.attachmentBlock} data-testid="catalog-detail-attachments" data-attachment-state={view.summary}>
    <header className={styles.attachmentHead}>
      <div>
        <h3 className={styles.attachmentTitle}>相关处理入口</h3>
        <p className={styles.attachmentNote} data-testid={view.summary === 'unavailable' ? 'catalog-detail-attachments-unavailable' : undefined}>
          {view.summary === 'unavailable'
            ? '来源身份核实与新品候选当前都不可读（未启用或未授权）；不把不可读写成 0 项，也不隐藏入口。'
            : '来源核实与新品候选各自独立读取：失败的一侧可单独重试，已读取的一侧保留；失败不代表未启用。'}
        </p>
      </div>
      <span className={`${styles.badge} ${view.summary === 'ready' ? styles.badgeIndigo : styles.badgeWarn}`}>
        {SUMMARY_LABEL[view.summary]}
      </span>
    </header>
    {retryError && <p className={styles.attachmentSideErrorText} role="alert">{retryError}</p>}
    <div className={styles.attachmentSides}>
      {renderSide('identity', view.identity, (panel) => (
        <SourceIdentityAttachment panel={panel} itemId={props.itemId} fromHref={props.fromHref} />
      ))}
      {renderSide('product', view.product, (panel) => <NewItemDetailAttachment panel={panel} />)}
    </div>
  </div>;
}
