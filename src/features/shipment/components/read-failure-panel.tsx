import Link from 'next/link';
import type { ReactNode } from 'react';
import surface from '@/ui/ice-v4/data-surface.module.css';
import styles from './shipment.module.css';
import type { ShipmentReadFailureKind } from '../model';

const READ_FAILURE_TEXT: Record<ShipmentReadFailureKind, { title: string; body: string }> = {
  forbidden: {
    title: '没有访问权限',
    body: '当前账号不是已启用的管理员，或所请求的货票不在授权范围内。本页没有显示票数或数量，也不当作 0 条。',
  },
  unavailable: {
    title: '货票功能尚未就绪',
    body: '当前实例还没有安装货票读取所需的数据库函数（或运行环境未启用）。本次没有读到任何货票，不等于没有在途货票。',
  },
  read_failed: {
    title: '货票读取失败（网络或传输异常）',
    body: '本次读取因网络或后台异常中断。这不等于没有货票或无权限；可刷新重试。',
  },
};

/**
 * 读取失败/无权限的统一中文降级面板（与现役 ReadFailurePanel 同一风格）：
 * 明确说出「没读到」，不显示 0 票、不显示空表。
 */
export function ShipmentReadFailurePanel({
  kind,
  backHref = '/dashboard/catalog',
  backLabel = '返回 ICE 商品库',
  extra,
}: {
  kind: ShipmentReadFailureKind;
  backHref?: string;
  backLabel?: string;
  extra?: ReactNode;
}) {
  const text = READ_FAILURE_TEXT[kind];
  return (
    <section className={styles.failurePanel} data-testid="shipment-read-failure" data-failure-kind={kind} role="alert">
      <h1>{text.title}</h1>
      <p>{text.body}</p>
      {extra}
      <div className={styles.failurePanelActions}>
        <Link href={backHref} className={surface.button}>{backLabel}</Link>
      </div>
    </section>
  );
}
