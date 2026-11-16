'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { SearchField } from '@/ui/ice-v4/data-surface';
import surface from '@/ui/ice-v4/data-surface.module.css';
import styles from './shipment.module.css';
import { associationErrorText, productSearchSpecText } from '../model';
import type {
  ProductSearchRowDto,
  ShipmentAssociationRulePreviewDto,
  ShipmentAssociationSavedPayloadDto,
  ShipmentAssociationSuggestionDto,
  ShipmentLinkedProductDto,
} from '../types';
import {
  associateShipmentItem,
  associateShipmentItemFromValue,
  previewShipmentAssociationRule,
  searchProductsForShipment,
} from '../server/actions';

const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_LIMIT = 20;

/**
 * 关联编辑的目标明细（详情抽屉与货值汇总/未计入列表共用）：
 * - 抽屉里的明细带当前 revision，直接走 associateShipmentItem 的乐观并发；
 * - 货值汇总 DTO 不带 revision，但带 shipmentId：保存前由服务端读取当前 revision 再走同一入口。
 */
export interface AssociationEditorTarget {
  itemId: string;
  shipmentId?: string | null;
  productNameRaw: string;
  product: ShipmentLinkedProductDto | null;
  revision: number | null;
}

/** 编辑里选中的一个商品（搜索结果与建议按钮统一成同一形状）。 */
interface AssociationChoice {
  itemId: string;
  iceCode: string | null;
  nameCn: string;
  /** 规格/条码等辨认信息（正文小字，不是标签）。 */
  meta: string;
}

function choiceFromSearch(row: ProductSearchRowDto): AssociationChoice {
  const spec = productSearchSpecText(row);
  return {
    itemId: row.itemId,
    iceCode: row.iceCode,
    nameCn: row.nameCn,
    meta: [...row.identifiers.slice(0, 2), ...(spec ? [`规格 ${spec}`] : [])].join(' / '),
  };
}

function choiceFromSuggestion(suggestion: ShipmentAssociationSuggestionDto): AssociationChoice {
  return {
    itemId: suggestion.productId,
    iceCode: suggestion.iceCode,
    nameCn: suggestion.nameCn ?? '名称待补充',
    meta: suggestion.basis === 'manual'
      ? `旧单 ${suggestion.ticketNo ?? '（票号未记录）'} 上人工确认过`
      : `同市场同品名已确认 ${suggestion.count} 次`,
  };
}

/** 人工确认依据：有真实人工选择记录时写清旧票号与确认时间（不伪造依据）。 */
function suggestionBasisText(suggestion: ShipmentAssociationSuggestionDto): string {
  if (suggestion.basis === 'manual') {
    const ticket = suggestion.ticketNo ? `旧单 ${suggestion.ticketNo}` : '旧单';
    const time = formatRecordedMinute(suggestion.recordedAt);
    return time ? `${ticket} 人工确认过（${time}）` : `${ticket} 人工确认过`;
  }
  return `同市场同品名已确认 ${suggestion.count} 次`;
}

function formatRecordedMinute(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const time = Date.parse(raw);
  if (!Number.isFinite(time)) return null;
  const date = new Date(time);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 保存前的影响预告文案（040 只读）：按当前所选商品算，已关联到它的明细计 0 条。 */
function rulePreviewText(
  preview: ShipmentAssociationRulePreviewDto | null,
  loading: boolean,
  hasSelection: boolean,
  productLabel: string,
): string | null {
  if (!hasSelection) return '选择商品后，这里会显示这条规则会影响哪些其他明细；以后新到的同市场同品名明细也会自动匹配。';
  if (loading) return '正在读取这条规则会影响哪些其他明细…';
  if (!preview || !preview.ok) return null;
  if (preview.market === null) return '市场未提供，无法保存沿用规则；本次只能只用于本票。';
  if (preview.matchingCount > 0) {
    return `其他明细中有 ${preview.matchingCount} 条（${preview.ticketCount} 票）会按这条规则改为「${productLabel}」；`
      + '以后新到的同市场同品名明细也会自动匹配。';
  }
  return '其他明细无需改动；以后新到的同市场同品名明细也会自动匹配。';
}

/**
 * 「关联商品」编辑器（详情抽屉 / 货值汇总未计入列表共用）：
 * - 输入即搜商品库（货号/名称/条码），选中后保存；
 * - 未关联明细可先选「同市场同品名已确认过的商品」建议（一键填入，仍可再搜索更换）；
 * - 保存前明确选择沿用范围：**只用于本票**（默认）或 **以后同市场同品名也沿用**（rememberMapping）；
 * - 版本冲突/失败：显示失败原因并保留当前选择，不自动重试、不覆盖。
 */
export function ShipmentAssociationEditor({
  item,
  suggestions = [],
  onCancel,
  onSaved,
}: {
  item: AssociationEditorTarget;
  suggestions?: ShipmentAssociationSuggestionDto[];
  onCancel: () => void;
  /** 保存成功：把本条的实际去向、规则是否保存、本次按规则另外关联条数交给调用方显示。 */
  onSaved: (payload: ShipmentAssociationSavedPayloadDto) => void;
}) {
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<ProductSearchRowDto[]>([]);
  const [selected, setSelected] = useState<AssociationChoice | null>(null);
  const [remember, setRemember] = useState(false);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  /**
   * 040 只读预告：按用户**当前选中的商品**计算，换选商品时重新读取。
   * 已关联到所选商品的其他明细不会改动，显示 0 条（「其他明细无需改动」）。
   * 用「结果属于哪个商品」派生 loading，避免在 effect 内同步 setState。
   */
  const [rulePreviewState, setRulePreviewState] = useState<{
    productId: string;
    preview: ShipmentAssociationRulePreviewDto | null;
  } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seqRef = useRef(0);
  const scopeName = `shipment-assoc-scope-${item.itemId}`;
  const selectedProductId = selected?.itemId ?? null;
  const selectedProductLabel = selected
    ? [selected.iceCode, selected.nameCn].filter((part): part is string => Boolean(part && part.trim())).join(' · ')
    : '';
  const previewLoading = selectedProductId !== null
    && rulePreviewState?.productId !== selectedProductId;
  const rulePreview = selectedProductId !== null && rulePreviewState?.productId === selectedProductId
    ? rulePreviewState.preview
    : null;

  useEffect(() => {
    if (!selectedProductId) return;
    let alive = true;
    previewShipmentAssociationRule(item.itemId, selectedProductId)
      .then((result) => {
        if (alive) setRulePreviewState({ productId: selectedProductId, preview: result });
      })
      .catch(() => {
        // 只读预告失败静默降级：不显示影响说明，不影响编辑与保存。
        if (alive) setRulePreviewState({ productId: selectedProductId, preview: null });
      });
    return () => { alive = false; };
  }, [item.itemId, selectedProductId]);

  const previewText = rulePreviewText(
    rulePreview,
    previewLoading,
    selectedProductId !== null,
    selectedProductLabel,
  );

  function clearTimer() {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }

  async function runSearch(value: string) {
    clearTimer();
    const searchTerm = value.trim();
    if (!searchTerm) {
      seqRef.current += 1;
      setResults([]);
      setSearching(false);
      return;
    }
    const seq = seqRef.current + 1;
    seqRef.current = seq;
    setSearching(true);
    try {
      const rows = await searchProductsForShipment(searchTerm, SEARCH_LIMIT);
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
      const result = item.revision !== null
        ? await associateShipmentItem({
          itemId: item.itemId,
          productId,
          expectedRevision: item.revision,
          reason,
          rememberMapping,
          shipmentId: item.shipmentId ?? null,
        })
        : item.shipmentId
          ? await associateShipmentItemFromValue({
            shipmentId: item.shipmentId,
            itemId: item.itemId,
            productId,
            reason,
            rememberMapping,
          })
          : null;
      if (result === null) {
        setError('缺少货票信息，无法保存关联；请刷新后重试');
        return;
      }
      if (!result.ok) {
        // 保留当前选择，不自动重试；等用户刷新/重新打开后再保存。
        setError(associationErrorText(result.errorCode, result.errorMessage));
        return;
      }
      const productLabel = productId !== null && selected
        ? [selected.iceCode, selected.nameCn].filter((part): part is string => Boolean(part && part.trim())).join(' · ')
        : null;
      onSaved({
        cleared: productId === null,
        productLabel,
        outcome: result.outcome ?? null,
        ruleRequested: rememberMapping === true && productId !== null,
        mappingSaved: result.mappingSaved === true,
        mappingNote: result.mappingNote ?? null,
        ruleAdoptedCount: result.ruleAdoptedCount ?? 0,
      });
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

      {suggestions.length > 0 ? (
        <div className={styles.assocSuggestions} data-testid="shipment-assoc-suggestions">
          <span className={styles.assocSuggestionsTitle}>
            同市场、同品名的商品：旧票上人工确认过的记录会写清旧单号与确认时间，点选后仍可再搜索更换
          </span>
          <div className={styles.assocSuggestionList}>
            {suggestions.map((suggestion) => {
              const active = selected?.itemId === suggestion.productId;
              return (
                <button
                  key={suggestion.productId}
                  type="button"
                  className={styles.assocSuggestion}
                  data-selected={active ? 'true' : undefined}
                  data-basis={suggestion.basis ?? 'current'}
                  data-old-ticket={suggestion.ticketNo ?? ''}
                  onClick={() => {
                    setSelected(choiceFromSuggestion(suggestion));
                    setError('');
                  }}
                  data-testid="shipment-assoc-suggestion"
                >
                  <strong>{suggestion.iceCode ?? '待补货号'}</strong>
                  <span>{suggestion.nameCn ?? '名称待补充'}</span>
                  <small data-testid="shipment-assoc-suggestion-basis">{suggestionBasisText(suggestion)}</small>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

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
            const choice = choiceFromSearch(row);
            return (
              <button
                key={row.itemId}
                type="button"
                role="option"
                aria-selected={selected?.itemId === row.itemId}
                className={styles.assocResult}
                data-selected={selected?.itemId === row.itemId ? 'true' : undefined}
                data-testid="shipment-product-result"
                onClick={() => setSelected(choice)}
              >
                <span className={styles.assocResultCode}>{choice.iceCode ?? '待补货号'}</span>
                <span className={styles.assocResultName}>{choice.nameCn}</span>
                <span className={styles.assocResultMeta}>{choice.meta}</span>
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
        <fieldset className={styles.assocScope} data-testid="shipment-assoc-scope">
          <legend className={styles.assocScopeLegend}>沿用范围（保存前必须选一个）</legend>
          {previewText ? (
            <p className={styles.assocRulePreview} data-testid="shipment-assoc-rule-preview">{previewText}</p>
          ) : null}
          <label className={styles.assocScopeOption} data-selected={remember ? undefined : 'true'}>
            <input
              type="radio"
              name={scopeName}
              checked={!remember}
              onChange={() => setRemember(false)}
              data-testid="shipment-assoc-scope-this"
            />
            <span>
              <strong>只用于本票</strong>
              <small>只改这一条在途明细，以后其它货票不受影响</small>
            </span>
          </label>
          <label className={styles.assocScopeOption} data-selected={remember ? 'true' : undefined}>
            <input
              type="radio"
              name={scopeName}
              checked={remember}
              onChange={() => setRemember(true)}
              data-testid="shipment-assoc-remember"
            />
            <span>
              <strong>以后同市场同品名也沿用</strong>
              <small>本条保存后，再遇到同市场、同品名的明细会自动采用这个商品</small>
            </span>
          </label>
        </fieldset>
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
