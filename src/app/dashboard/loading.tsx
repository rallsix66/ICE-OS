import demoStyles from '@/ui/ice-v4/ice-v4.module.css';

export default function DashboardLoading() {
  return (
    <div className={demoStyles.panel} role="status" aria-live="polite">
      <p className={demoStyles.subtle}>正在加载工作台…</p>
    </div>
  );
}
