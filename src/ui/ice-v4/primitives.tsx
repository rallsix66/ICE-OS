'use client';

import type { ReactNode } from 'react';
import { Search } from 'lucide-react';
import styles from './ice-v4.module.css';

export function Pill({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'green' | 'amber' | 'red' | 'blue' }) {
  return <span className={`${styles.pill} ${styles[`pill_${tone}`]}`}>{children}</span>;
}

export function SectionHeading({ title, eyebrow, action }: { title: string; eyebrow?: string; action?: ReactNode }) {
  return (
    <div className={styles.sectionHeading}>
      <div>{eyebrow && <p className={styles.eyebrow}>{eyebrow}</p>}<h2>{title}</h2></div>
      {action}
    </div>
  );
}

export function EmptyState({ onReset, text = '没有符合条件的记录' }: { onReset?: () => void; text?: string }) {
  return (
    <div className={styles.empty}>
      <Search size={28} strokeWidth={1.4} aria-hidden />
      <h3>{text}</h3>
      <p>试试其他货号、69编码或外部 SKU，也可以清空筛选。</p>
      {onReset && (
        <button type="button" className={styles.secondaryButton} onClick={onReset}>
          清空筛选
        </button>
      )}
    </div>
  );
}
