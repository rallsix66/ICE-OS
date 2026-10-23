import Link from 'next/link';
import type { ReactNode } from 'react';
import styles from './ice-v4.module.css';

export function SealedLegacyRoute({
  title,
  children,
  primaryHref = '/dashboard/catalog',
  primaryLabel = '前往 ICE 商品库',
}: {
  title: string;
  children: ReactNode;
  primaryHref?: string;
  primaryLabel?: string;
}) {
  return (
    <section className={styles.panel} style={{ maxWidth: '42rem' }} aria-labelledby="sealed-legacy-title">
      <p className={styles.eyebrow}>LEGACY / SEALED</p>
      <h2 id="sealed-legacy-title" className="text-lg font-semibold" style={{ margin: '0.25rem 0 0.75rem' }}>
        {title}
      </h2>
      <div className={styles.subtle} style={{ display: 'grid', gap: '0.75rem' }}>
        {children}
      </div>
      <p style={{ marginTop: '1.25rem' }}>
        <Link href={primaryHref} className={styles.textLink}>
          {primaryLabel}
        </Link>
      </p>
    </section>
  );
}
