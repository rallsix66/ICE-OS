import styles from './loading.module.css';

export default function DashboardLoading() {
  return (
    <div className={styles.skeleton} role="status" aria-label="正在加载">
      <div className={styles.title} />
      <div className={styles.toolbar}>
        <div className={styles.search} />
        <div className={styles.select} />
        <div className={styles.select} />
      </div>
      <div className={styles.panel}>
        <div className={styles.panelHead} />
        {Array.from({ length: 7 }).map((_, index) => (
          <div key={index} className={styles.row} />
        ))}
      </div>
    </div>
  );
}
