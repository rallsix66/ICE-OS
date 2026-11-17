'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ChevronDown } from 'lucide-react';
import {
  OPERATION_ITEM_CHUNK,
  operationDetailView,
  type OperationChange,
} from '../model';
import type { OperationRecordDto } from '../types';
import styles from './operations.module.css';

/**
 * 一条记录的展开内容（客户端小岛，仅为“明细分段展开”保留状态）。
 *
 * 顺序：处理结果 → 事实 → 字段变化 → 涉及商品（变化与入口放一起）→ 货票 → 入口 → 说明 → 来源信息。
 * 明细不截断：每段 20 条，显示“已显示 x / 共 n”，可继续展开或一次显示全部。
 */
export function OperationRecordDetail({ record }: { record: OperationRecordDto }) {
  const view = operationDetailView(record);
  const [visible, setVisible] = useState(OPERATION_ITEM_CHUNK);
  const shown = Math.min(visible, view.items.length);

  return (
    <div className={styles.recordBody} data-testid="operation-record-detail">
      <p className={styles.resultLine}>{view.resultText}</p>

      {view.facts.length > 0 ? (
        <dl className={styles.facts}>
          {view.facts.map((fact) => (
            <div key={`${fact.label}:${fact.value}`}>
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {view.changes.length > 0 ? (
        <div className={styles.block}>
          <h3 className={styles.blockTitle}>字段变化</h3>
          <ChangeTable changes={view.changes} testId="operation-record-changes" />
        </div>
      ) : null}

      {view.items.length > 0 ? (
        <div className={styles.block}>
          <div className={styles.blockHead}>
            <h3 className={styles.blockTitle}>{itemSectionTitle(record.action)}</h3>
            <span className={styles.itemProgress} data-testid="operation-items-progress">
              已显示 {shown} / 共 {view.items.length} 款
            </span>
          </div>
          <ul className={styles.itemList} data-testid="operation-detail-items">
            {view.items.slice(0, visible).map((item) => (
              <li key={item.key}>
                <div className={styles.itemMain}>
                  <div className={styles.itemHead}>
                    <strong>{item.title}</strong>
                    <span className={styles.itemLinks}>
                      {item.productHref ? <Link href={item.productHref}>商品资料</Link> : null}
                      {item.inventoryHref ? <Link href={item.inventoryHref}>商品库存</Link> : null}
                    </span>
                  </div>
                  {item.meta ? <small>{item.meta}</small> : null}
                  {item.changes.length > 0 ? <ChangeTable changes={item.changes} compact /> : null}
                  {item.note ? <small className={styles.itemNote}>{item.note}</small> : null}
                </div>
              </li>
            ))}
          </ul>
          {visible < view.items.length ? (
            <div className={styles.itemMore}>
              <button
                type="button"
                className={styles.moreButton}
                data-testid="operation-items-more"
                onClick={() => setVisible((current) => Math.min(current + OPERATION_ITEM_CHUNK, view.items.length))}
              >
                再显示 {Math.min(OPERATION_ITEM_CHUNK, view.items.length - visible)} 款
              </button>
              <button
                type="button"
                className={styles.moreLink}
                data-testid="operation-items-all"
                onClick={() => setVisible(view.items.length)}
              >
                显示全部 {view.items.length} 款
              </button>
            </div>
          ) : view.items.length > OPERATION_ITEM_CHUNK ? (
            <p className={styles.allShown}>已显示全部 {view.items.length} 款。</p>
          ) : null}
        </div>
      ) : null}

      {view.tickets.length > 0 ? (
        <div className={styles.block}>
          <h3 className={styles.blockTitle}>涉及货票</h3>
          <ul className={styles.itemList} data-testid="operation-detail-tickets">
            {view.tickets.map((ticket) => (
              <li key={`${ticket.ticketNo}:${ticket.meta}`}>
                <div className={styles.itemMain}>
                  <div className={styles.itemHead}>
                    <strong>{ticket.ticketNo}</strong>
                    <span className={styles.itemLinks}>
                      {ticket.href ? <Link href={ticket.href}>物流在途</Link> : null}
                    </span>
                  </div>
                  {ticket.meta ? <small>{ticket.meta}</small> : null}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {view.links.length > 0 ? (
        <div className={styles.entryLinks} data-testid="operation-record-links">
          {view.links.map((entry) => (
            <Link key={`${entry.label}:${entry.href}`} href={entry.href}>{entry.label}</Link>
          ))}
        </div>
      ) : null}

      {view.notes.length > 0 ? (
        <ul className={styles.notes}>
          {view.notes.map((note) => <li key={note}>{note}</li>)}
        </ul>
      ) : null}

      {view.sources.length > 0 ? (
        <details className={styles.sources} data-testid="operation-record-sources">
          <summary>
            <span>来源信息</span>
            <small>批次号、快照哈希、请求号</small>
            <ChevronDown size={14} strokeWidth={1.8} aria-hidden />
          </summary>
          <dl className={styles.sourceList}>
            {view.sources.map((source) => (
              <div key={`${source.label}:${source.value}`}>
                <dt>{source.label}</dt>
                <dd>{source.value}</dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}
    </div>
  );
}

function itemSectionTitle(action: string): string {
  if (action === 'source_batch_applied') return '本批写入商品';
  if (action === 'shipment_association_manual' || action === 'shipment_association_cleared') return '涉及商品明细';
  if (action === 'inventory_confirm' || action === 'inventory_rebind') return '涉及商品对应';
  return '涉及明细';
}

function ChangeTable({ changes, compact = false, testId }: { changes: OperationChange[]; compact?: boolean; testId?: string }) {
  return (
    <div className={compact ? styles.changeScrollCompact : styles.tableScroll}>
      <table className={compact ? `${styles.table} ${styles.compactTable}` : styles.table} data-testid={testId}>
        <thead>
          <tr><th>字段</th><th>修改前</th><th>修改后</th></tr>
        </thead>
        <tbody>
          {changes.map((change, index) => (
            <tr key={`${change.field}:${index}`} data-change-kind={change.kind}>
              <th scope="row">{change.field}</th>
              <td className={styles.beforeCell}>{change.before}</td>
              <td className={change.kind === 'removed' ? styles.removedCell : undefined}>{change.after}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
