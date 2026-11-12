'use client';

import Link from 'next/link';
import { useRef, useState, useTransition } from 'react';
import {
  assignProductSourceCodeAction,
  decideDuplicateSourceRowAction,
} from '../product-source/actions';
import type { CatalogPendingItem } from '../issues/types';
import styles from './catalog-pending-entry.module.css';

/**
 * 商品库「待处理」可操作卡片：弹窗与整页待处理界面**共用同一套卡片与动作**，
 * 保证总览、商品库徽标、弹窗、完整待处理页看到的是同一份 5 项清单。
 *
 * - 同号多行：两张来源行选项卡 + 「确认使用这份资料」→ decideDuplicateSourceRowAction；
 * - 缺货号（飞书已补号）：显示「飞书已补充货号 X」→「确认采用此货号」→ assignProductSourceCodeAction；
 * - 其余事项只显示原因与商品详情定位，不提供旧来源页跳转。
 */

type SourceActionResult = { success: boolean; error?: string; data?: { message?: string } };

function readSuccessMessage(data: unknown): string | null {
  if (!data || typeof data !== 'object' || !('message' in data)) return null;
  const message = (data as { message?: unknown }).message;
  return typeof message === 'string' && message.trim() !== '' ? message.trim() : null;
}

export function CatalogPendingCards({
  items,
  onResolved,
  onNavigate,
  startIndex = 0,
}: {
  items: CatalogPendingItem[];
  onResolved: (item: CatalogPendingItem, index: number, message: string) => void;
  /** 卡片内跳转到商品详情时调用（弹窗需要先关闭自己）。 */
  onNavigate?: () => void;
  /** 整页视图可接着全局序号；弹窗从 1 开始。 */
  startIndex?: number;
}) {
  return (
    <ol className={styles.list}>
      {items.map((item, index) => (
        <PendingCard
          key={item.key}
          item={item}
          index={startIndex + index}
          onNavigate={onNavigate}
          onResolved={onResolved}
        />
      ))}
    </ol>
  );
}

function PendingCard({
  item,
  index,
  onNavigate,
  onResolved,
}: {
  item: CatalogPendingItem;
  index: number;
  onNavigate?: () => void;
  onResolved: (item: CatalogPendingItem, index: number, message: string) => void;
}) {
  const formulaErrors = item.formulaErrors ?? null;
  const formulaHint = item.formulaState === 'fixed' || item.formulaState === 'unreadable';
  const duplicate = item.sourceKind === 'duplicate_code_inconsistent' && item.candidateRows.length >= 2;
  const missingCode = (item.sourceKind === 'missing_code' || item.sourceKind === 'missing_code_candidate')
    && item.candidateCode !== null;
  return (
    <li
      className={styles.card}
      data-testid="catalog-pending-card"
      data-pending-kind={item.sourceKind ?? item.kind}
      tabIndex={-1}
    >
      {formulaHint ? (
        <FormulaHintItem item={item} index={index} onNavigate={onNavigate} />
      ) : formulaErrors ? (
        <FormulaErrorItem item={item} index={index} group={formulaErrors} />
      ) : (
        <>
          <p className={styles.identity} data-testid="catalog-pending-identity">
            <span className={styles.index}>{index + 1}.</span>
            {' '}
            {item.nameCn}
            <span className={styles.sep}> · </span>
            {item.iceCode ?? '货号未填写'}
            <span className={styles.sep}> · </span>
            {item.specificationText}
          </p>
          {duplicate ? (
            <DuplicateChoice item={item} index={index} onNavigate={onNavigate} onResolved={onResolved} />
          ) : missingCode ? (
            <MissingCodeChoice item={item} index={index} onNavigate={onNavigate} onResolved={onResolved} />
          ) : (
            <ReadOnlyItem item={item} onNavigate={onNavigate} />
          )}
        </>
      )}
    </li>
  );
}

/**
 * 飞书原表「生产工厂」公式错误：合并一条展示，可展开逐行明细（货号/品名/单元格/错误原文），
 * 并可直接打开飞书原表；不在页面修数据，也不写飞书/数据库。
 */
function FormulaErrorItem({
  item,
  index,
  group,
}: {
  item: CatalogPendingItem;
  index: number;
  group: NonNullable<CatalogPendingItem['formulaErrors']>;
}) {
  return (
    <div className={styles.formula} data-testid="catalog-pending-formula">
      <p className={styles.identity} data-testid="catalog-pending-identity">
        <span className={styles.index}>{index + 1}.</span>
        {' '}
        {item.nameCn}
        <span className={styles.sep}> · </span>
        <span data-testid="catalog-pending-formula-count">{group.count} 个公式错误（#REF!）</span>
      </p>
      <p className={styles.reason}>{item.reason}</p>
      <details className={styles.formulaDetails} data-testid="catalog-pending-formula-details">
        <summary className={styles.formulaSummary}>
          查看明细（{group.count} 条 · 读取时间 {group.capturedAtDisplay}）
        </summary>
        <div className={styles.formulaTableWrap}>
          <table className={styles.formulaTable}>
            <thead>
              <tr>
                <th scope="col">货号</th>
                <th scope="col">品名</th>
                <th scope="col">单元格</th>
                <th scope="col">错误原文</th>
              </tr>
            </thead>
            <tbody>
              {group.rows.map((row) => (
                <tr key={row.cell} data-testid="catalog-pending-formula-row">
                  <td>{row.iceCode ?? '（空）'}</td>
                  <td>{row.nameCn ?? '（空）'}</td>
                  <td data-testid="catalog-pending-formula-cell">{row.cell}</td>
                  <td data-testid="catalog-pending-formula-error">{row.error}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      {item.referenceHref ? (
        <div className={styles.actions}>
          <a
            className={styles.secondaryLink}
            href={item.referenceHref}
            target="_blank"
            rel="noreferrer"
            data-testid="catalog-pending-formula-open"
          >
            打开飞书原表
          </a>
        </div>
      ) : null}
    </div>
  );
}

/**
 * 飞书工厂资料的两条状态提示（不是公式错误明细）：
 * - fixed：成功读到零个公式错误、上一批工厂待办还在 → 一条「已修好，等待确认更新」+「查看更新」；
 * - unreadable：这次没读到快照 → 如实说无法确认，绝不显示成已修好。
 * 两种提示各只有一条，确认采用后旧待办退出，fixed 提示随之消失。
 */
function FormulaHintItem({
  item,
  index,
  onNavigate,
}: {
  item: CatalogPendingItem;
  index: number;
  onNavigate?: () => void;
}) {
  const fixed = item.formulaState === 'fixed';
  return (
    <div
      className={styles.formula}
      data-testid={fixed ? 'catalog-pending-formula-fixed' : 'catalog-pending-formula-unreadable'}
    >
      <p className={styles.identity} data-testid="catalog-pending-identity">
        <span className={styles.index}>{index + 1}.</span>
        {' '}
        {item.nameCn}
      </p>
      <p className={styles.reason}>{item.reason}</p>
      {item.referenceHref ? (
        <div className={styles.actions}>
          <Link
            className={styles.primaryButton}
            href={item.referenceHref}
            onClick={onNavigate}
            data-testid={fixed ? 'catalog-pending-formula-fixed-open' : 'catalog-pending-formula-unreadable-open'}
          >
            {item.formulaActionLabel ?? (fixed ? '查看更新' : '检查更新')}
          </Link>
        </div>
      ) : null}
    </div>
  );
}

/** 同号多行：两张来源行选项卡 + 「确认使用这份资料」。 */
function DuplicateChoice({
  item,
  index,
  onNavigate,
  onResolved,
}: {
  item: CatalogPendingItem;
  index: number;
  onNavigate?: () => void;
  onResolved: (item: CatalogPendingItem, index: number, message: string) => void;
}) {
  const [chosenRowNumber, setChosenRowNumber] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [busy, startTransition] = useTransition();
  /** 同一张卡片的重试复用同一 requestId：服务端按既有请求幂等返回，不重复写入。 */
  const requestIdRef = useRef<string | null>(null);

  function confirm() {
    if (chosenRowNumber === null || item.issueId === null) return;
    requestIdRef.current ??= crypto.randomUUID();
    const requestId = requestIdRef.current;
    setError('');
    startTransition(async () => {
      try {
        const result: SourceActionResult = await decideDuplicateSourceRowAction({
          requestId,
          issueId: item.issueId,
          chosenRowNumber,
          note: '已核对：飞书同号两行资料，确认以后更新采用这一份',
        });
        if (result.success) {
          onResolved(
            item,
            index,
            readSuccessMessage(result.data) ?? `已保存，以后更新使用来源第 ${chosenRowNumber} 行的这份资料。`,
          );
        } else {
          setError(result.error ?? '本次未保存；请重新确认后重试。');
        }
      } catch {
        setError('提交结果暂未确认；请刷新后重试（同一请求不会重复写入）。');
      }
    });
  }

  return (
    <div className={styles.interactive}>
      <p className={styles.question}>飞书有两份这款商品的资料，以后更新用哪份？</p>
      <div className={styles.options} role="radiogroup" aria-label={`选择以后采用的来源行（${item.nameCn}）`}>
        {item.candidateRows.map((row) => {
          const active = chosenRowNumber === row.rowNumber;
          return (
            <button
              key={row.rowNumber}
              type="button"
              role="radio"
              aria-checked={active}
              className={`${styles.option} ${active ? styles.optionActive : ''}`}
              disabled={busy}
              onClick={() => setChosenRowNumber(row.rowNumber)}
              data-testid={`catalog-pending-choice-${row.rowNumber}`}
            >
              <span className={styles.optionHead}>来源第 {row.rowNumber} 行</span>
              <span className={styles.optionFields}>
                {row.fieldLines.map((line) => (
                  <span key={line} className={styles.optionField}>{line}</span>
                ))}
              </span>
            </button>
          );
        })}
      </div>
      {error ? (
        <p className={styles.error} role="alert" data-testid="catalog-pending-error">{error}</p>
      ) : null}
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.primaryButton}
          disabled={busy || chosenRowNumber === null}
          onClick={confirm}
          data-testid="catalog-pending-confirm-duplicate"
        >
          {busy ? '正在保存…' : '确认使用这份资料'}
        </button>
        <ReadOnlyLink item={item} onNavigate={onNavigate} />
      </div>
      {chosenRowNumber === null ? (
        <p className={styles.hint}>先选择一份资料，再点确认；未选择前不会保存任何内容。</p>
      ) : null}
    </div>
  );
}

/** 缺货号：飞书已补充正式货号，直接「确认采用此货号」。 */
function MissingCodeChoice({
  item,
  index,
  onNavigate,
  onResolved,
}: {
  item: CatalogPendingItem;
  index: number;
  onNavigate?: () => void;
  onResolved: (item: CatalogPendingItem, index: number, message: string) => void;
}) {
  const [error, setError] = useState('');
  const [busy, startTransition] = useTransition();
  const requestIdRef = useRef<string | null>(null);
  const actionable = Boolean(item.itemId) && item.itemRevision !== null && Boolean(item.candidateCode);

  function confirm() {
    if (!actionable || !item.itemId || item.itemRevision === null || !item.candidateCode) return;
    requestIdRef.current ??= crypto.randomUUID();
    const requestId = requestIdRef.current;
    const code = item.candidateCode;
    setError('');
    startTransition(async () => {
      try {
        const result: SourceActionResult = await assignProductSourceCodeAction({
          requestId,
          itemId: item.itemId,
          expectedRevision: item.itemRevision,
          code,
          reason: '人工确认采用飞书补充货号',
        });
        if (result.success) {
          onResolved(item, index, readSuccessMessage(result.data) ?? `已采用飞书补充货号 ${code}。`);
        } else {
          setError(result.error ?? '本次未采用；请刷新后重试。');
        }
      } catch {
        setError('提交结果暂未确认；请刷新后重试（同一请求不会重复写入）。');
      }
    });
  }

  return (
    <div className={styles.interactive}>
      <p className={styles.candidateCode}>
        飞书已补充货号 <strong data-testid="catalog-pending-candidate-code">{item.candidateCode}</strong>
        {item.iceCode ? null : '；当前商品还没有正式货号。'}
      </p>
      {actionable ? null : (
        <p className={styles.hint}>缺少商品或当前版本信息；请先在商品详情核对后再试。</p>
      )}
      {error ? (
        <p className={styles.error} role="alert" data-testid="catalog-pending-error">{error}</p>
      ) : null}
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.primaryButton}
          disabled={busy || !actionable}
          onClick={confirm}
          data-testid="catalog-pending-confirm-code"
        >
          {busy ? '正在保存…' : '确认采用此货号'}
        </button>
        <ReadOnlyLink item={item} onNavigate={onNavigate} />
      </div>
    </div>
  );
}

/** 只读事项：只给原因与只读定位，不提供旧来源页跳转。 */
function ReadOnlyItem({ item, onNavigate }: { item: CatalogPendingItem; onNavigate?: () => void }) {
  return (
    <div className={styles.readOnly}>
      <p className={styles.reason}>{item.reason}</p>
      {item.differences.length > 0 ? (
        <ul className={styles.differences}>
          {item.differences.map((line) => <li key={line}>{line}</li>)}
        </ul>
      ) : null}
      <div className={styles.actions}>
        <ReadOnlyLink item={item} onNavigate={onNavigate} />
      </div>
    </div>
  );
}

function ReadOnlyLink({ item, onNavigate }: { item: CatalogPendingItem; onNavigate?: () => void }) {
  if (!item.referenceHref) return null;
  return (
    <Link
      href={item.referenceHref}
      onClick={onNavigate}
      className={styles.secondaryLink}
      data-testid="catalog-pending-detail-link"
    >
      在商品详情查看
    </Link>
  );
}
