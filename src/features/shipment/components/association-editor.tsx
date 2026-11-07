'use client';

import { useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { SearchField } from '@/ui/ice-v4/data-surface';
import surface from '@/ui/ice-v4/data-surface.module.css';
import styles from './shipment.module.css';
import { associationErrorText, productSearchSpecText } from '../model';
import type { ProductSearchRowDto, ShipmentDetailItemDto } from '../types';
import { associateShipmentItem, searchProductsForShipment } from '../server/actions';

const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_LIMIT = 20;

/**
 * 抽屉内「关联商品」编辑器：输入即搜商品库（货号/名称/条码），选中后保存。
 * 版本冲突/失败：显示失败原因并保留当前选择，不自动重试、不覆盖。
 */
export function ShipmentAssociationEditor({
  item,
  onCancel,
  onSaved,
}: {
  item: ShipmentDetailItemDto;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<ProductSearchRowDto[]>([]);
  const [selected, setSelected] = useState<ProductSearchRowDto | null>(null);
  const [remember, setRemember] = useState(false);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seqRef = useRef(0);

  function clearTimer() {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }

  async function runSearch(value: string) {
    clearTimer();
    const term = value.trim();
    if (!term) {
      seqRef.current += 1;
      setResults([]);
      setSearching(false);
      return;
    }
    const seq = seqRef.current + 1;
    seqRef.current = seq;
    setSearching(true);
    try {
      const rows = await searchProductsForShipment(term, SEARCH_LIMIT);
      if (seqRef.current !== seq) return;
      setResults(rows);
    } catch {
      if (seqRef.current !== seq) return;
      setResults([]);
      setError('商品搜索失败，请重试');
    } finally {
      if (seqRef.current === seq) setSearching(false);
    }
  }

  function onTermChange(value: string) {
    setTerm(value);
    setError('');
    clearTimer();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void runSearch(value);
    }, SEARCH_DEBOUNCE_MS);
  }

  async function save(productId: string | null, reason: string, rememberMapping: boolean) {
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      const result = await associateShipmentItem({
        itemId: item.itemId,
        productId,
        expectedRevision: item.revision,
        reason,
        rememberMapping,
      });
      if (!result.ok) {
        // 保留当前选择，不自动重试；等用户刷新/重新打开后再保存。
        setError(associationErrorText(result.errorCode, result.errorMessage));
        return;
      }
      onSaved();
    } catch {
      setError('保存失败，请重试');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className={styles.assocEditor} data-testid="shipment-association-editor">
      <div className={styles.assocEditorHead}>
        <span>为「{item.productNameRaw}」关联 ICE 商品</span>
        <small>{item.product ? `当前：${item.product.iceCode ?? '待补货号'} · ${item.product.nameCn ?? ''}` : '当前未关联'}</small>
      </div>
      <SearchField
        value={term}
        onChange={onTermChange}
        placeholder="搜索货号 / 名称 / 条码"
        ariaLabel="搜索商品库（货号、名称或条码）"
        testId="shipment-product-search"
        pending={searching}
      />
      {results.length > 0 ? (
        <div className={styles.assocResults} role="listbox" aria-label="商品搜索结果" data-testid="shipment-product-results">
          {results.map((row) => {
            /* 关联时辨认规格：商品库独立规格列优先、名称补充，与商品库列表/详情同一解析。 */
            const spec = productSearchSpecText(row);
            return (
              <button
                key={row.itemId}
                type="button"
                role="option"
                aria-selected={selected?.itemId === row.itemId}
                className={styles.assocResult}
                data-selected={selected?.itemId === row.itemId ? 'true' : undefined}
                data-testid="shipment-product-result"
                onClick={() => setSelected(row)}
              >
                <span className={styles.assocResultCode}>{row.iceCode ?? '待补货号'}</span>
                <span className={styles.assocResultName}>{row.nameCn}</span>
                <span className={styles.assocResultMeta}>
                  {[...row.identifiers.slice(0, 2), ...(spec ? [`规格 ${spec}`] : [])].join(' / ')}
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <p className={styles.assocEmpty} data-testid="shipment-product-hint">
          {searching ? '正在搜索…' : term.trim() ? '没有匹配的商品' : '输入货号、名称或条码后选择商品'}
        </p>
      )}
      {error ? <p className={styles.inlineError} role="alert" data-testid="shipment-assoc-error">{error}</p> : null}
      {selected ? (
        <label className={styles.assocRemember}>
          <input
            type="checkbox"
            checked={remember}
            onChange={(event) => setRemember(event.target.checked)}
            data-testid="shipment-assoc-remember"
          />
          后续同来源、同品名、同市场沿用此对应
          <small>（默认不勾选：只改这一条；勾选后本条绑定和通用对应一起保存）</small>
        </label>
      ) : null}
      <div className={styles.assocActions}>
        <button
          type="button"
          className={`${surface.button} ${surface.buttonSmall} ${surface.buttonPrimary}`}
          onClick={() => void save(selected?.itemId ?? null, '手动关联', remember)}
          disabled={!selected || saving}
          data-testid="shipment-assoc-save"
        >
          {saving ? <Loader2 className={styles.spinning} size={14} strokeWidth={2} aria-hidden /> : null}
          保存关联
        </button>
        {item.product ? (
          <button
            type="button"
            className={`${surface.button} ${surface.buttonSmall}`}
            onClick={() => void save(null, '手动清除', false)}
            disabled={saving}
            data-testid="shipment-assoc-clear"
          >
            清除关联
          </button>
        ) : null}
        <button
          type="button"
          className={`${surface.button} ${surface.buttonSmall}`}
          onClick={onCancel}
          disabled={saving}
          data-testid="shipment-assoc-cancel"
        >
          取消
        </button>
      </div>
    </section>
  );
}
