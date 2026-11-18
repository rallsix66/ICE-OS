import Link from 'next/link';

import { PageHeading } from '@/ui/ice-v4/data-surface';
import styles from './access.module.css';

/** 权限设置页的拒绝态：只给中文结论与返回入口，不回显错误细节。 */
export function AccessDeniedPanel({ message }: { message?: string }) {
  return (
    <div className={styles.page} data-testid="access-denied">
      <PageHeading title="权限设置" />
      <section className={styles.panel}>
        <div className={styles.panelBody}>
          <p style={{ margin: 0, fontSize: 14 }}>
            {message ?? '当前账号没有权限使用权限设置；请用管理员账号登录。'}
          </p>
          <p className={styles.muted} style={{ marginTop: 8 }}>
            成员请从左侧「商品库存」查看被授权的海外库存。
          </p>
          <div className={styles.actions} style={{ marginTop: 12 }}>
            <Link className={styles.secondaryButton} href="/dashboard">返回工作台</Link>
            <Link className={styles.secondaryButton} href="/dashboard/inventory">查看商品库存</Link>
          </div>
        </div>
      </section>
    </div>
  );
}
