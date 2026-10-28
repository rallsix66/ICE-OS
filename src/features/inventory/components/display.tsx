import Link from 'next/link';
import type { ReactNode } from 'react';
import styles from './inventory.module.css';
import visual from '@/ui/shared/workspace-visual.module.css';
import { NOT_CONNECTED_SOURCES, type ReadFailureKind, type Tone } from '../model';

/** 复用既有视觉体系的小组件（服务端/客户端都可用，无副作用、无状态）。 */

const TONE_CLASS: Record<Tone, string> = {
  neutral: visual.pill_neutral,
  green: visual.pill_green,
  amber: visual.pill_amber,
  red: visual.pill_red,
  blue: visual.pill_blue,
};

export function StatusPill({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`${visual.pill} ${TONE_CLASS[tone] ?? visual.pill_neutral}`}>{children}</span>;
}

export function Card({
  title,
  hint,
  lead,
  wide,
  testId,
  children,
}: {
  title: string;
  hint?: string;
  lead?: ReactNode;
  wide?: boolean;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <section className={`${styles.card} ${wide ? styles.cardWide : ''}`} data-testid={testId}>
      <h2>
        {title}
        {hint ? <small>{hint}</small> : null}
      </h2>
      {lead ? <p className={styles.cardLead}>{lead}</p> : null}
      {children}
    </section>
  );
}

export interface FactRow {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
}

export function FactList({ rows }: { rows: FactRow[] }) {
  return (
    <dl className={styles.factList}>
      {rows.map((row) => (
        <div key={row.label}>
          <dt>{row.label}</dt>
          <dd>
            {row.value}
            {row.hint ? <small>{row.hint}</small> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** 未接入来源统一表达：只有“未接入”和说明，没有能点却没作用的按钮。 */
export function NotConnectedSources() {
  return (
    <section className={styles.section} data-testid="inventory-not-connected" aria-label="未接入的数据来源">
      <div className={styles.sectionHeader}>
        <h2>尚未接入的来源</h2>
        <p>下列来源本包未接入：不显示 0，也不并入 BigSeller 库存合计。</p>
      </div>
      <div className={styles.sectionBody}>
        <ul className={styles.notConnectedList}>
          {NOT_CONNECTED_SOURCES.map((source) => (
            <li key={source.key} className={styles.notConnectedItem} data-testid={`not-connected-${source.key}`}>
              <strong>
                {source.name}
                <StatusPill tone="neutral">未接入</StatusPill>
              </strong>
              <p>{source.detail}</p>
            </li>
          ))}
        </ul>
        <p className={styles.mappingNote}>
          “未接入”不是 0，也不代表没有库存；只是本包没有读取该来源。需要时另行安排接入与验证。
        </p>
      </div>
    </section>
  );
}

const READ_FAILURE_TEXT: Record<ReadFailureKind, { title: string; body: string }> = {
  forbidden: {
    title: '没有访问权限',
    body: '当前账号不是已启用的管理员，或所请求的数据不在授权范围内。本页没有显示数量，也不当作 0 条。',
  },
  unavailable: {
    title: '库存同步功能尚未就绪',
    body: '当前实例还没有安装库存同步所需的数据库函数（或运行环境未启用）。本次没有读到任何库存，不等于没有库存。',
  },
  read_failed: {
    title: '库存读取失败（网络或传输异常）',
    body: '本次读取因网络或后台异常中断。这不等于没有库存、没有任务或无权限；可刷新重试。',
  },
};

/** 读取失败/无权限的统一中文降级面板：明确说出“没读到”，不显示 0。 */
export function ReadFailurePanel({
  kind,
  backHref = '/dashboard/catalog',
  backLabel = '返回 ICE 商品库',
  extra,
}: {
  kind: ReadFailureKind;
  backHref?: string;
  backLabel?: string;
  extra?: ReactNode;
}) {
  const text = READ_FAILURE_TEXT[kind];
  return (
    <section className={styles.section} data-testid="inventory-read-failure" data-failure-kind={kind} role="alert">
      <div className={styles.sectionBody} style={{ paddingTop: '18px' }}>
        <h1 style={{ margin: 0, fontSize: '20px', color: '#233044' }}>{text.title}</h1>
        <p style={{ margin: '10px 0 0', color: '#667184', fontSize: '12px', lineHeight: 1.9 }}>{text.body}</p>
        {extra}
        <p style={{ marginTop: '16px' }}>
          <Link href={backHref} className={styles.headerLink}>
            {backLabel}
          </Link>
        </p>
      </div>
    </section>
  );
}

/** 旧库存地址的安全引导：说明旧范围与新库存页的对应关系，不恢复旧写入链。 */
export function LegacyInventoryGuidance({
  title,
  lede,
  points,
  primaryHref = '/dashboard/inventory',
  primaryLabel = '前往「商品库存」',
}: {
  title: string;
  lede: string;
  points: string[];
  primaryHref?: string;
  primaryLabel?: string;
}) {
  return (
    <section className={styles.section} data-testid="legacy-inventory-guidance">
      <div className={styles.legacyPanel}>
        <p className={visual.eyebrow}>LEGACY / SAFE REDIRECT</p>
        <h1>{title}</h1>
        <p>{lede}</p>
        <h2>这里现在能做什么</h2>
        <ul className={styles.noteList}>
          {points.map((point) => (
            <li key={point}>{point}</li>
          ))}
        </ul>
        <div className={styles.legacyActions}>
          <Link href={primaryHref} className={styles.primaryButton} style={{ textDecoration: 'none' }}>
            {primaryLabel}
          </Link>
          <Link href="/dashboard/sync" className={styles.headerLink} style={{ alignSelf: 'center' }}>
            查看数据同步状态
          </Link>
        </div>
      </div>
    </section>
  );
}
