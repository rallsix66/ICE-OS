'use client';

import { useSyncExternalStore, useState } from 'react';
import { useRouter } from 'next/navigation';
import { X, Pencil } from 'lucide-react';
import { Disclosure, StatusDot } from '@/ui/ice-v4/data-surface';
import styles from './inventory.module.css';
import { StatusPill } from './display';
import {
  buildConfirmMappingsIntent,
  detailTotalsDisplay,
  domesticReviewLabel,
  formatQuantity,
  formatQuantityOr,
  timestampOr,
  UNKNOWN_MARKET_TOKEN,
  warehouseRowLastKnownText,
  warehouseRowQuantitySummary,
  warehouseRowStatusDisplay,
  warehouseRowTitleDisplay,
  type InventoryQueryState,
} from '../model';
import type {
  InventoryDomesticRowDto,
  InventoryItemDetailDto,
  InventoryItemMappingDto,
  InventoryItemWarehouseDto,
  InventoryTargetItemDto,
  InventoryWarehouseDto,
  InventoryWarehouseRowDto,
  SourceBindingDto,
} from '../types';
import type { InventoryDetailTarget } from './detail-context';
import { executeBindingWrite } from './binding-write';
import {
  confirmInventoryMappingsAction,
  getSourceBindingAction,
  searchMappingTargetItemsAction,
} from '../server/actions';
import {
  getLocalUnknownServerSnapshot,
  getLocalUnknownSnapshot,
  subscribeLocalUnknown,
} from '../client-pending';

type BindingViewer = { actorId: string; accountId: string | null; accountLabel?: string | null };
type BindingFeedback = { text: string; tone: 'ok' | 'warn' | 'error' };

/* ------------------------------------------------------------------ *
 * 详情内绑定编辑（UI-2）：固定来源（账号/仓/原 SKU），搜索商品库商品后明确选中保存。
 * 仓库明细详情和商品汇总详情的仓库/SKU 行共用这一编辑器；写动作复用既有确认/版本/恢复机制。
 * ------------------------------------------------------------------ */

const CURRENT_ITEM_LABEL = '当前商品';

function BindingEditor({
  warehouseExternalId,
  warehouseName,
  market,
  externalSku,
  unit,
  currentVersion,
  currentItemId,
  currentItemLabel,
  viewer,
  pendingLocked,
  onSaved,
  onCancel,
}: {
  warehouseExternalId: string | null;
  warehouseName: string;
  market: string | null;
  externalSku: string;
  unit: string | null;
  currentVersion: number | null;
  currentItemId: string | null;
  /** 当前绑定商品的可读标签（“品名 · ICE 货号”）；未绑定时为 null。 */
  currentItemLabel: string | null;
  viewer: BindingViewer | null;
  pendingLocked: boolean;
  onSaved: (message: string) => void;
  onCancel: () => void;
}) {
  const router = useRouter();
  const local = useSyncExternalStore(subscribeLocalUnknown, getLocalUnknownSnapshot, getLocalUnknownServerSnapshot);
  const writeLocked = pendingLocked || Boolean(local);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<InventoryTargetItemDto[]>([]);
  const [searched, setSearched] = useState(false);
  const [selected, setSelected] = useState<InventoryTargetItemDto | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<null | 'search' | 'save'>(null);
  const [message, setMessage] = useState<BindingFeedback | null>(null);

  async function runSearch() {
    const term = search.trim();
    if (!term) {
      setMessage({ text: '请输入搜索词', tone: 'error' });
      return;
    }
    setBusy('search');
    try {
      const result = await searchMappingTargetItemsAction({ search: term });
      setResults(result.items);
      setSearched(true);
      setSelected(null);
      setMessage({ text: result.message, tone: result.ok ? 'ok' : 'error' });
    } catch {
      setMessage({ text: '搜索失败，可重试', tone: 'error' });
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    if (!selected) {
      setMessage({ text: '请先选中商品', tone: 'error' });
      return;
    }
    if (!warehouseExternalId) {
      setMessage({ text: '缺少仓库来源身份，无法保存', tone: 'error' });
      return;
    }
    if (writeLocked) {
      setMessage({ text: '原请求待核对，不能写入', tone: 'error' });
      return;
    }
    const targetLabel = [selected.nameCn, selected.iceCode].filter(Boolean).join(' · ') || selected.itemId;
    const reason = `库存详情绑定商品：${warehouseName} ${externalSku}→${targetLabel}`;
    const mappingInput = {
      externalSku,
      warehouseExternalId,
      itemId: selected.itemId,
      // 目标商品已确认的默认单位优先（搜索 DTO 返回），其次沿用来源现有单位，最后按 BS 单件口径“件”。
      unit: (selected.unit ?? '').trim() || (unit && unit.trim()) || '件',
      reason,
      note: note.trim() || null,
      expectedVersion: currentVersion,
      verification: false,
    };
    const requestId = crypto.randomUUID();
    const intent = buildConfirmMappingsIntent([mappingInput]);
    setBusy('save');
    setMessage({ text: '正在保存…', tone: 'ok' });
    const result = await executeBindingWrite({
      requestId,
      action: 'confirm_inventory_mapping',
      intent,
      payload: { mappings: [mappingInput] },
      viewer,
      execute: () => confirmInventoryMappingsAction({ mappings: [mappingInput], requestId, intent }),
    });
    setBusy(null);
    if (result.reload) {
      setMessage({ text: result.message, tone: result.tone });
      window.location.reload();
      return;
    }
    if (result.tone === 'ok') {
      // 绑定已更新；数量仍等下一次完整成功批次采用，不显示为已计入。
      onSaved('已更换绑定，库存待同步');
      router.refresh();
      return;
    }
    // 失败保留当前搜索与选择，供修改后重试。
    setMessage({ text: result.message, tone: result.tone });
  }

  return (
    <div className={styles.mappingEditor} data-testid="inventory-binding-editor">
      <p className={styles.fieldHint} data-testid="inventory-binding-context">
        固定来源：{viewer?.accountLabel ? `${viewer.accountLabel} · ` : ''}{warehouseName}
        {market ? ` · 市场 ${market}` : ''}
        {' · 原 SKU '}
        <strong>{externalSku}</strong>
        {currentItemLabel ? ` · 当前绑定 ${currentItemLabel}` : ' · 未绑定商品'}
        {currentVersion ? `（第 ${currentVersion} 版）` : ''}
      </p>
      <div className={styles.intervalRow}>
        <input
          type="search"
          value={search}
          maxLength={120}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="商品库货号 / 品名 / 条码"
          aria-label={`搜索要绑定到 ${warehouseName} ${externalSku} 的商品库商品`}
          disabled={busy !== null || writeLocked}
          data-testid="inventory-binding-search"
        />
        <button
          type="button"
          className={styles.secondaryButton}
          onClick={runSearch}
          disabled={busy !== null || writeLocked}
          data-testid="inventory-binding-search-button"
        >
          {busy === 'search' ? '搜索中…' : '搜索商品库'}
        </button>
      </div>
      {results.length > 0 ? (
        <div className={styles.searchResultList} data-testid="inventory-binding-results">
          {results.map((target) => {
            const isCurrent = Boolean(currentItemId) && target.itemId === currentItemId;
            const isSelected = selected?.itemId === target.itemId;
            const meta = [
              target.iceCode ?? '未编号',
              target.gtin ? `69 ${target.gtin}` : null,
              target.specification ? `规格 ${target.specification}` : null,
            ].filter(Boolean).join(' · ');
            return (
              <button
                key={target.itemId}
                type="button"
                className={`${styles.searchResultButton} ${styles.bindingResultButton}`}
                onClick={() => setSelected(target)}
                disabled={busy !== null || writeLocked || isCurrent}
                data-testid="inventory-binding-result"
                data-selected={isSelected ? 'true' : undefined}
                data-current={isCurrent ? 'true' : undefined}
                aria-pressed={isSelected}
              >
                <strong>{target.nameCn ?? '未命名商品'}</strong>
                <span className={styles.rowSub}>
                  {meta}
                  {isCurrent ? ` · ${CURRENT_ITEM_LABEL}（无需更换）` : ''}
                </span>
              </button>
            );
          })}
        </div>
      ) : searched && busy === null && message?.tone === 'ok' ? (
        <p className={styles.inlineNotice} data-testid="inventory-binding-empty">
          没有匹配商品
        </p>
      ) : null}
      {selected ? (
        <p className={styles.fieldHint} data-testid="inventory-binding-selected">
          已选择：{[selected.nameCn, selected.iceCode].filter(Boolean).join(' · ') || selected.itemId}
        </p>
      ) : null}
      <label className={styles.field}>
        <span>备注（选填）</span>
        <input
          value={note}
          maxLength={200}
          onChange={(event) => setNote(event.target.value)}
          aria-label="绑定备注（选填）"
          disabled={busy !== null || writeLocked}
          data-testid="inventory-binding-note"
        />
      </label>
      <div className={styles.buttonRow}>
        <button
          type="button"
          className={styles.primaryButton}
          onClick={save}
          disabled={busy !== null || writeLocked || !selected}
          data-testid="inventory-binding-save"
        >
          {busy === 'save' ? '正在保存…' : '保存绑定'}
        </button>
        <button
          type="button"
          className={styles.secondaryButton}
          onClick={onCancel}
          disabled={busy !== null}
          data-testid="inventory-binding-cancel"
        >
          取消
        </button>
      </div>
      {writeLocked ? (
        <p className={styles.inlineNotice}>
          原请求待核对，不能写入
        </p>
      ) : null}
      <p
        className={styles.statusMessage}
        data-tone={message?.tone === 'ok' ? undefined : message?.tone}
        role="status"
        aria-live="polite"
        data-testid="inventory-binding-message"
      >
        {message?.text ?? '先选中商品再保存'}
      </p>
    </div>
  );
}

/** 仓库行详情：显示“绑定的商品库商品”，已绑定可更换、未绑定可绑定；读取失败可重试。 */
function RowBinding({
  row,
  initialBinding,
  error,
  ready,
  viewer,
  pendingLocked,
}: {
  row: InventoryWarehouseRowDto;
  initialBinding: SourceBindingDto | null;
  error: string | null;
  ready: boolean;
  viewer: BindingViewer | null;
  pendingLocked: boolean;
}) {
  // 服务端读数是基值；详情内重试/保存后的重读作为本地覆盖，避免在 effect 里同步 props。
  const [override, setOverride] = useState<{ binding: SourceBindingDto | null; error: string | null } | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [editing, setEditing] = useState(false);
  const [feedback, setFeedback] = useState<BindingFeedback | null>(null);

  const binding = override ? override.binding : initialBinding;
  const loadError = override ? override.error : error;

  const effectiveViewer = binding?.viewer ?? viewer;
  const locked = Boolean(binding?.pendingLocked) || pendingLocked;
  const current = binding?.mapping ?? null;
  const currentLabel = current
    ? [current.nameCn, current.iceCode].filter(Boolean).join(' · ') || '已绑定商品'
    : null;
  // R4：采用状态按服务端返回的批次事实显示，不能对所有 confirmed 固定提示“待下一次采用”。
  const adoption = binding?.adoption ?? null;
  const adoptionText = adoption === 'adopted'
    ? '本批已计入'
    : adoption === 'pending_adoption'
      ? '库存待下一次完整成功批次采用'
      : adoption === 'inactive'
        ? '对应已退出，当前不计入'
        : adoption === 'unseen'
          ? '本批未见，库存待同步'
          : null;

  async function reload() {
    if (!row.warehouseId) {
      setOverride({ binding, error: '缺少仓库身份，无法读取绑定' });
      return;
    }
    setRetrying(true);
    try {
      const result = await getSourceBindingAction({ warehouseId: row.warehouseId, externalSku: row.externalSku });
      if (result.ok && result.data) {
        setOverride({ binding: result.data, error: null });
      } else if (result.ok) {
        setOverride({ binding: null, error: '没有读取到绑定信息' });
      } else {
        setOverride({ binding: null, error: result.message ?? '读取失败' });
      }
    } catch {
      setOverride({ binding: null, error: '网络或后台异常' });
    } finally {
      setRetrying(false);
    }
  }

  return (
    <section className={styles.detailBinding} data-testid="inventory-binding-section">
      <h3 className={styles.subTitle}>绑定的商品库商品</h3>
      {loadError ? (
        <p className={styles.inlineError} data-testid="inventory-binding-error">
          绑定读取失败，可重试：{loadError}
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={reload}
            disabled={retrying}
            data-testid="inventory-binding-retry"
          >
            {retrying ? '读取中…' : '重试读取'}
          </button>
        </p>
      ) : !ready && !binding ? (
        <p className={styles.detailLoading} data-testid="inventory-binding-loading">正在读取该来源的绑定信息…</p>
      ) : current ? (
        <>
          <p className={styles.detailLead} data-testid="inventory-binding-current">
            {currentLabel}
          </p>
          <div className={styles.detailStatusLine}>
            <StatusPill tone={current.status === 'confirmed' ? 'green' : 'amber'}>
              {current.status === 'confirmed' ? '对应已确认' : '对应待处理'}
            </StatusPill>
            <span>第 {current.version} 版{adoptionText ? ` · ${adoptionText}` : ''}</span>
          </div>
        </>
      ) : (
        <p className={styles.detailNote} data-testid="inventory-binding-unbound">
          该来源未绑定商品
        </p>
      )}
      {feedback ? (
        <p
          className={styles.statusMessage}
          data-tone={feedback.tone === 'ok' ? undefined : feedback.tone}
          role="status"
          aria-live="polite"
          data-testid="inventory-binding-feedback"
        >
          {feedback.text}
        </p>
      ) : null}
      {!loadError && (ready || binding) ? (
        editing ? (
          <BindingEditor
            warehouseExternalId={binding?.warehouseExternalId ?? null}
            warehouseName={binding?.warehouseName ?? row.warehouseName}
            market={binding?.market ?? row.market}
            externalSku={row.externalSku}
            unit={binding?.unit ?? row.unit}
            currentVersion={current?.version ?? null}
            currentItemId={current?.itemId ?? null}
            currentItemLabel={currentLabel}
            viewer={effectiveViewer}
            pendingLocked={locked}
            onSaved={(text) => {
              setFeedback({ text, tone: 'ok' });
              setEditing(false);
              void reload();
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <div className={styles.detailActions}>
            <button
              type="button"
              className={styles.primaryButton}
              onClick={() => {
                setFeedback(null);
                setEditing(true);
              }}
              disabled={locked}
              data-testid="inventory-binding-edit"
            >
              {current ? '更换商品' : '绑定商品'}
            </button>
          </div>
        )
      ) : null}
      {locked && !editing ? (
        <p className={styles.inlineNotice}>原请求待核对，不能写入</p>
      ) : null}
    </section>
  );
}

function RowFacts({
  row,
  binding,
  bindingError,
  bindingReady,
  viewer,
  pendingLocked,
}: {
  row: InventoryWarehouseRowDto;
  binding: SourceBindingDto | null;
  bindingError: string | null;
  bindingReady: boolean;
  viewer: BindingViewer | null;
  pendingLocked: boolean;
}) {
  const title = warehouseRowTitleDisplay(row);
  const status = warehouseRowStatusDisplay(row);
  const quantity = warehouseRowQuantitySummary(row);
  const lastKnown = warehouseRowLastKnownText(row);
  const isDomestic = row.source === 'domestic';
  const mappingStatusLabel = row.mappingStatus === 'confirmed'
    ? '对应已确认'
    : row.mappingStatus === 'recheck'
      ? '对应待重核'
      : row.mappingStatus === 'disabled'
        ? '对应已停用'
        : row.itemId ? '已关联商品' : '未建立对应';
  return (
    <div data-testid="inventory-row-facts">
      <p className={styles.detailLead}>
        {title.subtitle}
        <span className={styles.detailSub}>
          {row.warehouseName}
          {row.market ? ` · 市场 ${row.market}` : isDomestic ? '' : ' · 市场待确认'}
        </span>
      </p>
      <div className={styles.detailStatusLine}>
        <StatusPill tone={status.tone}>{status.label}</StatusPill>
        <span>{mappingStatusLabel}</span>
      </div>
      <dl className={styles.factGrid}>
        <div><dt>实物库存</dt><dd>{quantity.primary}</dd></div>
        <div><dt>{isDomestic ? '可用数（原表）' : '可售库存'}</dt><dd>{quantity.secondary ?? '—'}</dd></div>
        <div><dt>{isDomestic ? '运营云仓可用（原文）' : '订单锁定'}</dt><dd>{isDomestic ? (row.cloudAvailableText ?? '—') : formatQuantityOr(row.orderLocked, '—')}</dd></div>
        <div><dt>{isDomestic ? '文件日期' : '活动预留'}</dt><dd>{isDomestic ? (row.fileDate ?? '见原表') : formatQuantityOr(row.activityReserved, '—')}</dd></div>
        <div><dt>{isDomestic ? '原表行号' : '来源在途'}</dt><dd>{isDomestic ? (row.excelRow ?? '—') : formatQuantityOr(row.inTransit, '—')}</dd></div>
        <div><dt>数据时间</dt><dd>{isDomestic ? '原表未注明观测时间' : timestampOr(row.observationAt, '尚无成功观测')}</dd></div>
      </dl>
      {!isDomestic ? (
        <RowBinding
          key={row.rowKey}
          row={row}
          initialBinding={binding}
          error={bindingError}
          ready={bindingReady}
          viewer={viewer}
          pendingLocked={pendingLocked}
        />
      ) : null}
      {lastKnown ? <p className={styles.detailNote} data-testid="inventory-row-last-known">{lastKnown}</p> : null}
      {row.note ? <p className={styles.detailNote}>{row.note}</p> : null}
      {!isDomestic ? (
        <details className={styles.detailMore}>
          <summary>来源批次与文件（按需展开）</summary>
          <dl className={styles.factGrid}>
            <div><dt>来源</dt><dd>BigSeller 自动读取</dd></div>
            <div><dt>原始数量文本</dt><dd>{row.rawOnHand ?? '来源未提供'}</dd></div>
            <div><dt>批次</dt><dd>{row.batchId ?? '—'}</dd></div>
            <div><dt>原表行号</dt><dd>{row.excelRow ?? '—'}</dd></div>
            <div><dt>69 编码</dt><dd>{row.gtin ?? '—'}</dd></div>
            <div><dt>商品资料版本</dt><dd>{row.itemRevision ?? '—'}</dd></div>
          </dl>
        </details>
      ) : null}
    </div>
  );
}

/** 商品汇总详情：具体仓库/SKU 行上的“绑定/更换商品”编辑按钮 + 行内编辑器。 */
function DetailItemRow({
  row,
  mapping,
  bound,
  editing,
  viewer,
  pendingLocked,
  onEdit,
  onSaved,
  onCancel,
}: {
  row: InventoryItemWarehouseDto;
  /** 仅用于按钮文案：本详情商品在该仓/SKU 是否有当前映射；编辑身份一律按来源实时读取。 */
  mapping: InventoryItemMappingDto | null;
  /** 展示层绑定判断：有已确认对应/已采用 SKU 即为已绑定。 */
  bound: boolean;
  editing: boolean;
  viewer: BindingViewer | null;
  pendingLocked: boolean;
  onEdit: () => void;
  onSaved: (message: string) => void;
  onCancel: () => void;
}) {
  const seenOldValue = row.status === 'unseen' && row.lastKnownQty !== null && row.lastKnownQty !== undefined;
  // R3：没有真实来源 SKU 的仓库状态占位行不进入固定来源编辑（不为占位行发明 SKU）。
  const hasRealSku = row.externalSku.trim().length > 0;
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [binding, setBinding] = useState<SourceBindingDto | null>(null);

  /**
   * 打开编辑前按真实来源（仓 + 原 SKU）读取当前绑定：
   * 不用旧详情商品的 mapping 猜当前目标；读取失败只显示错误与重试，不打开空编辑器。
   */
  async function startEdit() {
    if (!hasRealSku || !row.warehouseId) return;
    setLoading(true);
    setLoadError(null);
    try {
      const result = await getSourceBindingAction({ warehouseId: row.warehouseId, externalSku: row.externalSku });
      if (result.ok && result.data) {
        setBinding(result.data);
        onEdit();
      } else if (result.ok) {
        setLoadError('没有读取到当前绑定，可重试');
      } else {
        setLoadError(result.message ?? '读取当前绑定失败');
      }
    } catch {
      setLoadError('网络或后台异常');
    } finally {
      setLoading(false);
    }
  }

  const current = binding?.mapping ?? null;
  const currentItemLabel = current
    ? [current.nameCn, current.iceCode].filter(Boolean).join(' · ') || '已绑定商品'
    : null;

  return (
    <>
      <tr data-testid="inventory-detail-item-row" data-status={row.status}>
        <td>{row.warehouseName}</td>
        <td>{row.externalSku}</td>
        <td className={styles.numCell}>
          {seenOldValue
            ? <span className={styles.quantityUnknown}>旧值 {formatQuantity(row.lastKnownQty)}</span>
            : formatQuantityOr(row.onHand, '—')}
        </td>
        <td className={styles.numCell}>{formatQuantityOr(row.warehouseAvailable, '—')}</td>
        <td>
          <StatusPill tone={bound ? 'green' : 'amber'}>{bound ? '已绑定' : '未绑定'}</StatusPill>
        </td>
        <td>{timestampOr(row.observedAt, '未记录')}</td>
        <td className={styles.actionCell}>
          {editing ? null : hasRealSku ? (
            <>
              <button
                type="button"
                className={styles.detailActionButton}
                onClick={startEdit}
                disabled={pendingLocked || loading}
                data-testid="inventory-detail-binding-edit"
              >
                <Pencil size={13} strokeWidth={1.8} aria-hidden />
                {loading ? '读取中…' : mapping ? '更换商品' : '绑定商品'}
              </button>
              {loadError ? (
                <span className={styles.rowSub} data-testid="inventory-detail-binding-load-error">
                  {loadError}
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    onClick={startEdit}
                    disabled={pendingLocked || loading}
                    data-testid="inventory-detail-binding-load-retry"
                  >
                    重试读取
                  </button>
                </span>
              ) : null}
            </>
          ) : (
            <span className={styles.rowSub} data-testid="inventory-detail-binding-placeholder">—</span>
          )}
        </td>
      </tr>
      {editing && binding ? (
        <tr data-testid="inventory-detail-binding-editor-row">
          <td colSpan={7}>
            <BindingEditor
              warehouseExternalId={binding.warehouseExternalId ?? null}
              warehouseName={binding.warehouseName}
              market={binding.market ?? row.market ?? null}
              externalSku={binding.externalSku || row.externalSku}
              unit={binding.unit ?? row.unit}
              currentVersion={current?.version ?? null}
              currentItemId={current?.itemId ?? null}
              currentItemLabel={currentItemLabel}
              viewer={binding.viewer ?? viewer}
              pendingLocked={binding.pendingLocked || pendingLocked}
              onSaved={(text) => {
                onSaved(text);
                onCancel();
              }}
              onCancel={onCancel}
            />
          </td>
        </tr>
      ) : null}
    </>
  );
}

/** 国内冻结记录：只展示该商品国内原数量/编码/文件日期；不与海外相加，也不提供 BS 对应动作。 */
function DomesticRecords({ rows }: { rows: InventoryDomesticRowDto[] }) {
  if (rows.length === 0) {
    return (
      <p className={styles.detailNote} data-testid="inventory-detail-domestic-empty">
        没有国内冻结记录
      </p>
    );
  }
  const dates = [...new Set(rows.map((row) => row.fileDate).filter(Boolean))].sort();
  return (
    <div data-testid="inventory-detail-domestic">
      <p className={styles.detailNote}>
        聚水潭（只读）· 文件 {dates.join(' / ') || '日期见原表'} · {rows.length} 条
      </p>
      <div className={styles.detailTableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>来源编码</th>
              <th>原表名称</th>
              <th className={styles.numericHead}>实际库存数</th>
              <th className={styles.numericHead}>可用数</th>
              <th>文件日期</th>
              <th>原表状态 / 说明</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.legacyCandidateId} data-testid="inventory-detail-domestic-row">
                <td>{row.externalSku}</td>
                <td className={styles.wrapCell}>{row.sourceName ?? row.itemNameCn ?? '原表未注明'}</td>
                <td className={styles.numCell}>
                  {formatQuantityOr(row.actualQty, row.rawActualText ? `原文「${row.rawActualText}」` : '原表为空')}
                  {row.quantityState !== 'ok' ? (
                    <span className={styles.rowSub}>
                      {row.quantityState === 'missing' ? '原表未注明数量' : row.quantityState === 'invalid' ? '原表不是整数' : '同商品多条记录冲突'}
                    </span>
                  ) : null}
                </td>
                <td className={styles.numCell}>{formatQuantityOr(row.availableQty, '—')}</td>
                <td>{row.fileDate || '见原表'}</td>
                <td className={styles.wrapCell}>
                  {domesticReviewLabel(row.reviewState)}
                  {row.note ? <span className={styles.rowSub}>{row.note}</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ProductDetail({
  detail,
  itemError,
  query,
  warehouses,
  domesticRows,
  includeDomestic,
  viewer,
  pendingLocked,
}: {
  detail: InventoryItemDetailDto | null;
  itemError: string | null;
  query: InventoryQueryState;
  /** 页面已读的参与仓清单（overview.warehouses）；详情只做展示层判断，不再多读一次。 */
  warehouses: InventoryWarehouseDto[];
  domesticRows: InventoryDomesticRowDto[];
  includeDomestic: boolean;
  viewer: BindingViewer | null;
  pendingLocked: boolean;
}) {
  const includeOverseas = query.source !== 'domestic';
  const totals = detail ? detailTotalsDisplay(detail) : null;
  const router = useRouter();
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<BindingFeedback | null>(null);
  const rows = detail?.warehouses ?? [];
  const history = detail?.history ?? [];

  function mappingFor(row: InventoryItemWarehouseDto): InventoryItemMappingDto | null {
    const skuKey = row.externalSku.trim().toLowerCase();
    const matched = (detail?.mapping ?? []).filter((mapping) => (
      mapping.warehouseId === row.warehouseId
      && mapping.externalSku.trim().toLowerCase() === skuKey
    ));
    if (matched.length === 0) return null;
    return matched.reduce((latest, mapping) => (mapping.version > latest.version ? mapping : latest), matched[0]);
  }

  function isRowBound(row: InventoryItemWarehouseDto): boolean {
    if (mappingFor(row)?.status === 'confirmed') return true;
    if ((row.mappedSkus ?? []).length > 0) return true;
    if ((row.adoptedSkus ?? []).length > 0) return true;
    return row.status === 'current';
  }

  const boundWarehouseIds = new Set(rows.filter(isRowBound).map((row) => row.warehouseId));

  // 参与仓：优先用页面已读的参与仓清单，按当前筛选范围收窄；读不到清单时回落到详情行。
  const marketFilter = query.market === UNKNOWN_MARKET_TOKEN ? null : query.market;
  const participantSource = warehouses.filter((warehouse) => {
    if (warehouse.status !== 'confirmed') return false;
    if (query.warehouse !== 'all') return warehouse.id === query.warehouse;
    if (query.market !== 'all') return (warehouse.market ?? null) === marketFilter;
    return true;
  });
  const fallbackNames = new Map<string, string>();
  for (const row of rows) fallbackNames.set(row.warehouseId, row.warehouseName);
  const participantSeeds = participantSource.length > 0
    ? participantSource.map((warehouse) => ({ id: warehouse.id, name: warehouse.name }))
    : [...fallbackNames.entries()].map(([id, name]) => ({ id, name }));
  const participants = participantSeeds.map(({ id, name }) => {
    const bound = boundWarehouseIds.has(id);
    const boundRow = rows.find((row) => row.warehouseId === id && isRowBound(row) && row.onHand !== null);
    const qty = bound && boundRow
      ? `实物 ${formatQuantity(boundRow.onHand)}${boundRow.unit ? ` ${boundRow.unit}` : ''}`
      : null;
    return { id, name, bound, qty };
  });
  const boundCount = participants.filter((participant) => participant.bound).length;
  const unboundCount = participants.length - boundCount;
  const stockCount = participants.filter((participant) => rows.some((row) => (
    row.warehouseId === participant.id && row.status === 'current' && (row.onHand ?? 0) > 0
  ))).length;
  const failedCount = new Set(rows
    .filter((row) => row.failed || row.status === 'failed' || row.status === 'stale')
    .map((row) => row.warehouseId)).size;
  const currentWarehouseIds = new Set(rows.filter((row) => row.status === 'current').map((row) => row.warehouseId));
  const gapCount = Math.max(0, participants.length - participants.filter((participant) => currentWarehouseIds.has(participant.id)).length);

  // 问题：每行一句短句；不出现原文件行号、数量保留、待确认归属这类后台细节。
  const problems: string[] = [];
  const seenProblems = new Set<string>();
  const pushProblem = (text: string) => {
    if (seenProblems.has(text)) return;
    seenProblems.add(text);
    problems.push(text);
  };
  for (const row of rows) {
    if (!isRowBound(row)) {
      pushProblem(`${row.warehouseName}：未绑定来源 SKU`);
      continue;
    }
    if (row.failed || row.status === 'failed' || row.status === 'stale') pushProblem(`${row.warehouseName}：同步失败，沿用旧值`);
    else if (row.status === 'unseen') pushProblem(`${row.warehouseName}：本次未见`);
  }
  for (const participant of participants) {
    if (!participant.bound && !rows.some((row) => row.warehouseId === participant.id)) {
      pushProblem(`${participant.name}：未绑定来源 SKU`);
    }
  }

  const bannerParts: string[] = [];
  if (unboundCount > 0) bannerParts.push(`${unboundCount} 个仓库未绑定`);
  if (failedCount > 0) bannerParts.push(`${failedCount} 个仓同步失败`);
  if (stockCount > 0) bannerParts.push(`${stockCount} 个仓库有库存`);
  const bannerTone = failedCount > 0 ? 'red' : unboundCount > 0 ? 'amber' : stockCount > 0 ? 'green' : 'neutral';
  const bannerText = bannerParts.join(' · ') || '无当前库存';
  const singleUnit = detail && detail.totals.byUnit.length === 1 ? detail.totals.byUnit[0].unit : null;
  const unitSuffix = totals && singleUnit && !totals.unitConflict && totals.subtotalText !== '暂无已知数量'
    ? ` ${singleUnit}`
    : '';
  const totalLabel = totals?.unitConflict ? '多单位' : '已知合计';

  return (
    <div data-testid="inventory-item-detail">
      {includeOverseas && detail ? (
        <div className={styles.detailBanner} data-tone={bannerTone}>
          <StatusDot tone={bannerTone}>{bannerText}</StatusDot>
        </div>
      ) : null}
      {itemError ? (
        <p className={styles.inlineError} data-testid="inventory-detail-error">
          读取失败：{itemError}
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={() => router.refresh()}
            data-testid="inventory-detail-retry"
          >
            重试
          </button>
        </p>
      ) : null}

      {includeOverseas ? (
        <>
          {totals ? (
            <div className={styles.detailTotals}>
              <span>{totalLabel}：<strong>{totals.subtotalText}{unitSuffix}</strong></span>
              <span>{totals.coverageText}</span>
              {gapCount > 0 ? <span>缺口 {gapCount} 仓</span> : null}
            </div>
          ) : !itemError ? (
            <p className={styles.detailLoading} data-testid="inventory-detail-loading">
              正在读取…
            </p>
          ) : null}

          {detail ? (
            <>
              <Disclosure
                summary="参与仓"
                count={`${boundCount}/${participants.length} 已绑定`}
                defaultOpen
                testId="inventory-detail-participants"
              >
                <ul className={styles.participantList}>
                  {participants.map((participant) => (
                    <li key={participant.id} className={styles.participantRow}>
                      <span className={styles.participantName}>{participant.name}</span>
                      <span className={styles.participantState} data-bound={participant.bound ? 'true' : undefined}>
                        <span className={styles.participantDot} data-bound={participant.bound ? 'true' : undefined} aria-hidden />
                        {participant.bound ? '已绑定' : '未绑定'}
                      </span>
                      {participant.qty ? <span className={styles.participantQty}>{participant.qty}</span> : null}
                    </li>
                  ))}
                </ul>
              </Disclosure>

              {problems.length > 0 ? (
                <Disclosure summary="问题" count={problems.length} tone="warn" testId="inventory-detail-problems">
                  <ul className={styles.problemList}>
                    {problems.map((problem) => <li key={problem}>{problem}</li>)}
                  </ul>
                </Disclosure>
              ) : null}

              {feedback ? (
                <p
                  className={styles.statusMessage}
                  data-tone={feedback.tone === 'ok' ? undefined : feedback.tone}
                  role="status"
                  aria-live="polite"
                  data-testid="inventory-detail-binding-feedback"
                >
                  {feedback.text}
                </p>
              ) : null}

              <h3 className={styles.subTitle}>海外（BigSeller）各仓</h3>
              <div className={styles.detailTableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>仓库</th>
                      <th>来源 SKU</th>
                      <th className={styles.numericHead}>实物</th>
                      <th className={styles.numericHead}>可售</th>
                      <th>状态</th>
                      <th>来源时间</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => {
                      const rowKey = `${row.warehouseId}-${row.externalSku}`;
                      return (
                        <DetailItemRow
                          key={`${rowKey}-${row.status}`}
                          row={row}
                          mapping={mappingFor(row)}
                          bound={isRowBound(row)}
                          editing={editingKey === rowKey}
                          viewer={viewer}
                          pendingLocked={pendingLocked}
                          onEdit={() => {
                            setFeedback(null);
                            setEditingKey(rowKey);
                          }}
                          onSaved={(text) => {
                            // R1：真实成功才关闭编辑器并刷新详情/列表；失败留在编辑器内保留选择。
                            setFeedback({ text, tone: 'ok' });
                            router.refresh();
                          }}
                          onCancel={() => setEditingKey(null)}
                        />
                      );
                    })}
                    {rows.length === 0 ? (
                      <tr>
                        <td colSpan={7} className={styles.wrapCell}>当前范围没有来源行</td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
              {history.length > 0 ? (
                <Disclosure summary="最近批次历史" count={`${history.length} 条`} testId="inventory-detail-history">
                  <ul className={styles.detailHistory}>
                    {history.slice(0, 12).map((entry, index) => (
                      <li key={`${entry.batchId}-${entry.externalSku}-${index}`}>
                        {timestampOr(entry.observationAt ?? entry.publishedAt, '时间未记录')} · {entry.warehouseName} · {entry.externalSku}
                        {' · 实物 '}{formatQuantityOr(entry.onHand, '—')}
                        {entry.unit ? ` ${entry.unit}` : ''}
                      </li>
                    ))}
                  </ul>
                </Disclosure>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}

      {includeDomestic ? (
        <Disclosure
          summary="聚水潭（国内快照）"
          count={`${domesticRows.length} 条`}
          testId="inventory-detail-domestic-fold"
        >
          <DomesticRecords rows={domesticRows} />
        </Disclosure>
      ) : null}
    </div>
  );
}

/** 唯一的库存详情层：右侧抽屉 + 遮罩；关闭、Esc、浏览器后退都回原列表位置。 */
export function InventoryDetailPanel({
  target,
  query,
  itemDetail,
  itemError,
  domesticRows,
  domesticIncluded,
  warehouses,
  sourceBinding,
  sourceBindingError,
  bindingReady,
  viewer,
  pendingLocked,
  onClose,
}: {
  target: InventoryDetailTarget | null;
  query: InventoryQueryState;
  itemDetail: InventoryItemDetailDto | null;
  itemError: string | null;
  domesticRows: InventoryDomesticRowDto[];
  /** 列表有效范围是否包含国内（与列/计数同一判断）。 */
  domesticIncluded: boolean;
  /** 页面已读的参与仓清单（overview.warehouses）：汇总详情用它列全参与仓，只做展示。 */
  warehouses: InventoryWarehouseDto[];
  /** 当前打开仓库行的固定来源绑定（服务端读取；未打开海外行时为 null）。 */
  sourceBinding: SourceBindingDto | null;
  sourceBindingError: string | null;
  /** 服务端已针对当前行尝试读取绑定（false = 等待页面读取，不显示“失败/未绑定”）。 */
  bindingReady: boolean;
  viewer: BindingViewer | null;
  pendingLocked: boolean;
  onClose: () => void;
}) {
  if (!target) return null;
  const row = target.kind === 'row' ? target.row : null;
  const productLabel = target.kind === 'product' ? target.label : null;
  const productSublabel = target.kind === 'product' ? target.sublabel : null;
  const domesticItem = domesticRows[0];
  const title = row
    ? warehouseRowTitleDisplay(row).title
    : (itemDetail?.item.nameCn ?? productLabel ?? domesticItem?.itemNameCn ?? domesticItem?.iceCode ?? '商品详情');
  const subtitle = row
    ? `${row.warehouseName} · 来源 SKU ${row.externalSku}`
    : [
      productSublabel ?? itemDetail?.item.iceCode ?? domesticItem?.iceCode ?? '未编号',
      query.source === 'domestic' ? '聚水潭' : '各仓库存',
    ].filter(Boolean).join(' · ');
  return (
    <div className={styles.detailBackdrop} role="presentation" onClick={onClose} data-testid="inventory-detail-backdrop">
      <aside
        className={styles.detailDrawer}
        role="dialog"
        aria-modal="true"
        aria-label={`${title} 库存详情`}
        onClick={(event) => event.stopPropagation()}
        data-testid="inventory-detail-dialog"
        data-kind={target.kind}
      >
        <header className={styles.detailDrawerHead}>
          <div>
            <h2>{title}</h2>
            <p>{subtitle}</p>
          </div>
          <button
            type="button"
            className={styles.detailClose}
            onClick={onClose}
            aria-label="关闭"
            title="关闭"
            data-testid="inventory-detail-close"
          >
            <X size={18} strokeWidth={1.8} aria-hidden />
          </button>
        </header>
        <div className={styles.detailDrawerBody}>
          {row
            ? (
              <RowFacts
                row={row}
                binding={sourceBinding}
                bindingError={sourceBindingError}
                bindingReady={bindingReady}
                viewer={viewer}
                pendingLocked={pendingLocked}
              />
            )
            : (
              <ProductDetail
                key={target.kind === 'product' ? target.itemId : 'product'}
                detail={itemDetail}
                itemError={itemError}
                query={query}
                warehouses={warehouses}
                domesticRows={domesticRows}
                includeDomestic={domesticIncluded}
                viewer={viewer}
                pendingLocked={pendingLocked}
              />
            )}
        </div>
      </aside>
    </div>
  );
}
