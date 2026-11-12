'use client';

import { useId, useState } from 'react';
import Link from 'next/link';
import surface from '@/ui/ice-v4/data-surface.module.css';
import type { HomeGapItem } from '../aggregate';
import { formatHomeQuantity } from '../model';
import styles from './business-overview.module.css';

/**
 * 「需要处理」里的缺价商品动作：按钮就在本条事项上，清单在本区块就地展开，不跳转、不新开页。
 *
 * 每款只显示货号、品名与已知数量（库存+在途，来自 aggregate.valuation.missingCostProducts），
 * 「查看」进入既有商品库存详情；数量未知的商品不会出现在这里（不补 0）。
 */
export function HomeMissingCost({
  label,
  items,
}: {
  label: string;
  items: HomeGapItem[];
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  return (
    <>
      <button
        type="button"
        className={`${surface.button} ${surface.buttonSmall}`}
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((current) => !current)}
        data-testid="home-missing-cost-toggle"
      >
        {label}
      </button>
      {open ? (
        <div className={styles.missingCostList} id={listId} data-testid="home-missing-cost-list">
          <ul>
            {items.map((item) => (
              <li key={item.itemId} data-item-id={item.itemId}>
                <span className={styles.missingCostName}>
                  {item.iceCode ?? '缺货号'} · {item.nameCn ?? '未命名商品'}
                </span>
                <span className={styles.missingCostQty}>
                  已知数量 {formatHomeQuantity(item.quantity)} 件
                </span>
                <Link
                  className={`${surface.buttonGhost} ${surface.buttonSmall}`}
                  href={`/dashboard/inventory?view=product&item=${item.itemId}`}
                >
                  查看
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}
