'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import surface from '@/ui/ice-v4/data-surface.module.css';
import styles from './shipment.module.css';
import {
  formatQuantity,
  formatQuantityOr,
  manualCorrectionPreview,
  manualStatusFromReceiptBasis,
  manualStatusLabel,
  receiptBasisLabel,
  type ManualInputMode,
} from '../model';
import type { ShipmentDetailItemDto, ShipmentManualStatus } from '../types';
import { applyShipmentItemManualCorrection, restoreShipmentItemSourceJudgement } from '../server/actions';

const STATUS_OPTIONS: ShipmentManualStatus[] = [
  'in_transit',
  'arrived_pending_shelving',
  'fully_shelved',
  'partial_shelved',
  'unknown',
];

function manualResultErrorText(result: { errorCode: string | null; errorMessage: string | null }): string {
  const code = result.errorCode ?? '';
  const message = result.errorMessage ?? '';
  if (code && message) return `保存失败（${code}）：${message}`;
  if (code) return `保存失败（${code}）`;
  if (message) return `保存失败：${message}`;
  return '保存失败，请重试';
}

/**
 * 「修正在途」弹窗（第八轮）：
 * - 5 个状态单选；分批上架时可选 箱 / 商品数量，箱只在绑定商品有商品库装箱数时可选；
 * - 实时显示将采用的累计到货/剩余与算式（非法输入提示原因，不写 0）；
 * - 保存调用服务端 action；失败显示结构化错误码/原因；成功后由调用方刷新并关闭；
 * - 已有手工修正时提供「恢复按原表判断」。
 */
export function ShipmentManualCorrectionDialog({
  item,
  onClose,
  onSaved,
}: {
  item: ShipmentDetailItemDto;
  onClose: () => void;
  onSaved: () => void;
}) {
  const cartonQuantity = item.product?.cartonQuantity ?? null;
  const hasCarton = typeof cartonQuantity === 'number' && Number.isSafeInteger(cartonQuantity) && cartonQuantity > 0;
  const [status, setStatus] = useState<ShipmentManualStatus>(
    item.manualStatus ?? manualStatusFromReceiptBasis(item.sourceReceiptBasis),
  );
  const [inputMode, setInputMode] = useState<ManualInputMode>('quantity');
  const [cumulativeShelvedText, setCumulativeShelvedText] = useState(
    item.manualStatus === 'partial_shelved' && item.manualShelvedQuantity !== null
      ? String(item.manualShelvedQuantity)
      : '',
  );
  const [pending, setPending] = useState(false);
  const [restorePending, setRestorePending] = useState(false);
  const [serverError, setServerError] = useState('');
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const preview = manualCorrectionPreview({
    shippedQuantity: item.shippedQuantity,
    status,
    cumulativeShelvedText,
    cartonQuantity,
    inputMode,
  });
  const busy = pending || restorePending;
  const manualActive = item.manualStatus !== null;

  async function onSave() {
    if (!preview.ok || busy) return;
    setPending(true);
    setServerError('');
    try {
      const result = await applyShipmentItemManualCorrection({
        itemId: item.itemId,
        restore: false,
        status,
        cumulativeShelved: status === 'partial_shelved' ? preview.receivedQuantity : null,
        expectedManualRevision: item.manualRevision,
      });
      if (!result.ok) {
        setServerError(manualResultErrorText(result));
        return;
      }
      onSaved();
    } catch {
      setServerError('保存失败：网络或传输异常，未保存');
    } finally {
      setPending(false);
    }
  }

  async function onRestore() {
    if (busy) return;
    setRestorePending(true);
    setServerError('');
    try {
      const result = await restoreShipmentItemSourceJudgement({
        itemId: item.itemId,
        restore: true,
        status,
        cumulativeShelved: null,
        expectedManualRevision: item.manualRevision,
      });
      if (!result.ok) {
        setServerError(manualResultErrorText(result));
        return;
      }
      onSaved();
    } catch {
      setServerError('恢复失败：网络或传输异常，未保存');
    } finally {
      setRestorePending(false);
    }
  }

  return (
    <div
      className={styles.manualDialogBackdrop}
      data-testid="shipment-manual-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="shipment-manual-dialog-title"
        className={styles.manualDialog}
        data-testid="shipment-manual-dialog"
        ref={panelRef}
        tabIndex={-1}
      >
        <header className={styles.manualDialogHead}>
          <div>
            <h3 id="shipment-manual-dialog-title">修正在途</h3>
            <p>{item.productNameRaw}</p>
          </div>
          <button
            type="button"
            className={styles.detailClose}
            aria-label="关闭修正在途"
            data-testid="shipment-manual-close"
            onClick={onClose}
            disabled={busy}
          >
            <X size={18} aria-hidden />
          </button>
        </header>

        <div className={styles.manualDialogBody}>
          <dl className={styles.manualCurrent}>
            <div><dt>发货量</dt><dd>{formatQuantityOr(item.shippedQuantity)}</dd></div>
            <div><dt>当前累计到货</dt><dd>{formatQuantityOr(item.receivedQuantity)}</dd></div>
            <div><dt>当前剩余在途</dt><dd>{formatQuantityOr(item.remainingQuantity)}</dd></div>
            <div><dt>原表依据</dt><dd>{receiptBasisLabel(item.sourceReceiptBasis)}</dd></div>
          </dl>

          {item.manualConflict ? (
            <p className={styles.manualConflictNotice} data-testid="shipment-manual-conflict">
              原表发货量已变更：旧发货量 {formatQuantityOr(item.manualShippedQuantity)} → 新发货量 {formatQuantityOr(item.shippedQuantity)}；
              之前确认上架 {item.previousConfirmedShelvedQuantity === null
                ? '未确认'
                : formatQuantity(item.previousConfirmedShelvedQuantity)}。
              重新保存后按新发货量计算；矛盾未解决前这条不计入市场货值。
            </p>
          ) : null}

          <fieldset className={styles.manualFieldset}>
            <legend>修正后的状态</legend>
            <div className={styles.manualRadioList} role="radiogroup" aria-label="修正后的状态">
              {STATUS_OPTIONS.map((option) => (
                <label key={option} className={styles.manualRadio} data-selected={status === option ? 'true' : undefined}>
                  <input
                    type="radio"
                    name="shipment-manual-status"
                    value={option}
                    checked={status === option}
                    disabled={busy}
                    data-testid={`shipment-manual-status-${option}`}
                    onChange={() => {
                      setStatus(option);
                      setServerError('');
                    }}
                  />
                  <span>{manualStatusLabel(option)}</span>
                </label>
              ))}
            </div>
          </fieldset>

          {status === 'partial_shelved' ? (
            <>
              <div className={styles.manualField}>
                <span className={styles.manualLabel}>分批累计已上架（累计数，第二次修改替换上次，不做累加）</span>
                <div className={styles.manualSegmented} role="group" aria-label="输入方式">
                  <button
                    type="button"
                    className={styles.manualSegmentedButton}
                    aria-pressed={inputMode === 'quantity'}
                    disabled={busy}
                    data-testid="shipment-manual-mode-quantity"
                    onClick={() => setInputMode('quantity')}
                  >
                    商品数量
                  </button>
                  <button
                    type="button"
                    className={styles.manualSegmentedButton}
                    aria-pressed={inputMode === 'boxes'}
                    disabled={busy || !hasCarton}
                    title={hasCarton ? '按商品库装箱数换算' : '该商品没有商品库装箱数量，只能直接填商品数量'}
                    data-testid="shipment-manual-mode-boxes"
                    onClick={() => setInputMode('boxes')}
                  >
                    箱
                  </button>
                </div>
                {hasCarton ? (
                  <span className={styles.manualHint} data-testid="shipment-manual-carton">
                    商品库装箱数：每箱 {formatQuantity(cartonQuantity)} 件（单位字段未标注时按件计）
                  </span>
                ) : (
                  <span className={styles.manualHint} data-testid="shipment-manual-carton-missing">
                    该商品没有商品库装箱数量，请直接填商品数量
                  </span>
                )}
              </div>

              <label className={styles.manualField}>
                <span className={styles.manualLabel}>
                  {inputMode === 'boxes' ? '累计已上架箱数' : '累计已上架商品数量'}
                </span>
                <input
                  className={styles.manualInput}
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  value={cumulativeShelvedText}
                  disabled={busy}
                  placeholder={inputMode === 'boxes' ? '例如 40' : '例如 3200'}
                  data-testid="shipment-manual-cumulative"
                  onChange={(event) => {
                    setCumulativeShelvedText(event.target.value);
                    setServerError('');
                  }}
                />
              </label>

              {inputMode === 'boxes' && hasCarton && preview.boxConversion ? (
                <p className={styles.manualConversion} data-testid="shipment-manual-box-conversion">
                  箱数 × 装箱数 = {formatQuantity(preview.boxConversion.boxes)} × {formatQuantity(preview.boxConversion.cartonQuantity)} = {formatQuantity(preview.boxConversion.quantity)}
                </p>
              ) : null}
            </>
          ) : null}

          <div className={styles.manualPreview} data-testid="shipment-manual-preview">
            <strong>
              将采用：累计到货 {preview.receivedQuantity === null ? '未提供' : formatQuantity(preview.receivedQuantity)}
              {' · '}
              剩余在途 {preview.remainingQuantity === null ? '未提供（待核）' : formatQuantity(preview.remainingQuantity)}
            </strong>
            {preview.ok ? (
              <ul className={styles.manualFormula} data-testid="shipment-manual-formula">
                {preview.formulaLines.map((line) => <li key={line}>{line}</li>)}
              </ul>
            ) : (
              <p className={styles.manualError} role="alert" data-testid="shipment-manual-preview-error">
                {preview.error}
              </p>
            )}
          </div>

          {serverError ? (
            <p className={styles.manualError} role="alert" data-testid="shipment-manual-error">{serverError}</p>
          ) : null}
        </div>

        <footer className={styles.manualDialogFoot}>
          {manualActive ? (
            <button
              type="button"
              className={`${surface.button} ${surface.buttonSmall}`}
              onClick={() => void onRestore()}
              disabled={busy}
              data-testid="shipment-manual-dialog-restore"
            >
              {restorePending ? <Loader2 className={styles.spinning} size={14} strokeWidth={2} aria-hidden /> : null}
              恢复按原表判断
            </button>
          ) : null}
          <span className={styles.manualFootSpacer} />
          <button
            type="button"
            className={`${surface.button} ${surface.buttonSmall}`}
            onClick={onClose}
            disabled={busy}
            data-testid="shipment-manual-cancel"
          >
            取消
          </button>
          <button
            type="button"
            className={`${surface.button} ${surface.buttonSmall} ${surface.buttonPrimary}`}
            onClick={() => void onSave()}
            disabled={busy || !preview.ok}
            data-testid="shipment-manual-save"
          >
            {pending ? <Loader2 className={styles.spinning} size={14} strokeWidth={2} aria-hidden /> : null}
            保存修正
          </button>
        </footer>
      </div>
    </div>
  );
}
