'use client';

import { useEffect, useState } from 'react';
import { fetchCatalogSourceViewAction } from '../actions';
import surface from '@/ui/ice-v4/data-surface.module.css';
import styles from './catalog-detail.module.css';

type HintState =
  | { status: 'loading' }
  | { status: 'ready'; adopted: number; unadopted: number }
  | { status: 'error'; forbidden: boolean };



/**
 * 库存空态的证据补充（V5-01）。
 *
 * 只在“本仓没有已确认库存行”时读取已有来源记录，说明本仓是否存在本批未采用的来源。
 * 它不自动采用记录、不改变库存归属，也不把“有来源”说成“已有库存”。
 */
export function InventorySourceHint({
  itemId,
  warehouse,
  onOpenEvidence,
}: {
  itemId: string;
  warehouse: string;
  onOpenEvidence?: () => void;
}) {
  const [state, setState] = useState<HintState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    /* 异步边界后再置 loading，避免在 effect 内同步 setState 触发级联渲染。 */
    Promise.resolve().then(() => { if (!cancelled) setState({ status: 'loading' }); });
    void (async () => {
      try {
        /* V6-01：不再复用共享来源结果；每次核对都重新走服务端鉴权。 */
        const result = await fetchCatalogSourceViewAction(itemId, 0);
        if (cancelled) return;
        if (!result.success || !result.data) {
          const forbidden = result.errorKind === 'forbidden'
            || /无权|权限|FORBIDDEN|DENIED|42501|停用|登录/i.test(result.error ?? '');
          setState({ status: 'error', forbidden });
          return;
        }
        const records = result.data.systems
          .flatMap((system) => system.records)
          .filter((record) => record.sourceWarehouse === warehouse && record.confirmation !== 'other_item');
        setState({
          status: 'ready',
          adopted: records.filter((record) => record.adoptedInBatch).length,
          unadopted: records.filter((record) => !record.adoptedInBatch).length,
        });
      } catch {
        if (!cancelled) setState({ status: 'error', forbidden: false });
      }
    })();
    return () => { cancelled = true; };
  }, [itemId, warehouse, attempt]);

  return (
    <div className={styles.sectionNote} data-testid="catalog-inventory-source-hint" data-state={state.status}>
      {state.status === 'loading' && <span role="status">正在核对本仓来源记录…</span>}
      {state.status === 'error' && (
        <>
          <span role="alert">
            {state.forbidden
              ? '当前账号无来源记录读取权限；这不等于库存为 0。'
              : '本仓来源记录读取失败；这不等于库存为 0。'}
          </span>
          <button type="button" className={`${surface.button} ${surface.buttonSmall}`} onClick={() => setAttempt((n) => n + 1)}>重试核对</button>
        </>
      )}
      {state.status === 'ready' && (
        <>
          <span>
            {state.unadopted > 0
              ? `本仓有 ${state.unadopted} 条来源记录本批未采用，未计入库存。`
              : state.adopted > 0
                ? '本仓来源记录显示本批已采用，但当前没有已确认库存行；不当作 0。'
                : '本仓没有记录到来源对应；这不等于仓库没有货，也不表示库存为 0。'}
          </span>
          {onOpenEvidence && <button type="button" className={`${surface.button} ${surface.buttonSmall}`} onClick={onOpenEvidence}>查看数据来源</button>}
        </>
      )}
    </div>
  );
}
