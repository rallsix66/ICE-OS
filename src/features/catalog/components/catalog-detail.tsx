'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Package } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import demoStyles from '@/ui/ice-v4/ice-v4.module.css';
import { Pill } from '@/ui/ice-v4/primitives';
import { adoptedUnitCostFromFinancial, type AdoptedUnitCost } from '../local-display/adopted-price';
import { formatCnyPrice } from '../local-display/money-display';
import {
  CATALOG_FIELD_LABELS,
  fieldAuditValue,
  fieldBusinessValue,
  optionalFieldRow,
} from '../local-display/field-labels';
import {
  appendNonPriceRevisionAction,
  assignInitialCodeAction,
  checkCatalogRequestOutcomeAction,
  fetchCatalogDetailHistoryAction,
} from '../actions';
import { DetailAttachments, type DetailAttachmentsModel } from './detail-attachments';
import { DetailRetryButton } from './detail-retry-button';
import { useUnsavedLeaveGuard } from './use-unsaved-leave-guard';
import styles from './catalog-detail.module.css';
import type { getCatalogDetailCore, getCatalogItemBsSample } from '../service';
import type { CatalogRevisionHistoryDto, FieldObservation } from '../types';

export type CatalogDetailCoreView = Awaited<ReturnType<typeof getCatalogDetailCore>>;
type BsSampleDetail = Awaited<ReturnType<typeof getCatalogItemBsSample>>;
type CodeRequest = { itemId: string; expectedRevision: number; requestId: string; code: string; reason: string };
type RevisionRequest = { itemId: string; expectedRevision: number; requestId: string; reason: string; fields: Record<string, FieldObservation> };
type PendingRequest = { kind: 'initial_code'; input: CodeRequest } | { kind: 'nonprice_revision'; input: RevisionRequest };

type EditDraft = { code: string; codeReason: string; field: string; fieldValue: string; evidenceRef: string; reason: string; confirmEmpty: boolean };
const EMPTY_DRAFT: EditDraft = { code: '', codeReason: '', field: 'factory', fieldValue: '', evidenceRef: '', reason: '', confirmEmpty: false };

/**
 * 可修订字段：只保留冻结输入中确有来源列的业务字段。
 * `packaging` 在本批 126 份主资料中没有来源列（baseline-adapter 无该映射），
 * 因此不再作为默认可填项；已有历史值仍按原样读取和展示，不改写。
 */
const REVISION_FIELDS: Array<{ value: string; label: string }> = [
  { value: 'factory', label: '工厂' },
  { value: 'specification', label: '规格' },
  { value: 'nameCn', label: '中文名称' },
  { value: 'barcode', label: '辅助条码' },
  { value: 'cartonQuantity', label: '装箱数量' },
  { value: 'englishName', label: '英文名称' },
  { value: 'imageRef', label: '图片引用' },
];

/** 商品资料分区：真实来源列（尺寸/重量/装箱）分组，单产品与外箱不混用。 */
const SINGLE_SIZE_KEYS = ['length', 'width', 'height'] as const;
const CARTON_SIZE_KEYS = ['cartonLength', 'cartonWidth', 'cartonHeight'] as const;

const SECTIONS = [
  { key: 'material', label: '商品资料' },
  { key: 'inventory', label: '库存明细' },
  { key: 'history', label: '变更记录' },
] as const;
export type CatalogDetailSection = (typeof SECTIONS)[number]['key'];

type Fact = { value: string; hint?: string | null; warn?: boolean };

function qtyCell(value: unknown) {
  return value == null ? '—' : String(value);
}

/**
 * V3-02：体积等小数值不用裸科学计数法，也不能因为两位小数把小正数变成 0。
 * 正常可读值原样保留（不改写底层精确值），仅把 1e-5 这类形态转成十进制并去掉多余零。
 */
export function formatMeasureValue(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  if (!/^[-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?$/i.test(trimmed)) return trimmed;
  if (!/e/i.test(trimmed) && Math.abs(Number(trimmed)) >= 0.01) return trimmed;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return trimmed;
  const fixed = value.toFixed(10);
  const withoutZero = fixed.replace(/0+$/, '').replace(/\.$/, '');
  return withoutZero === '-0' ? '0' : withoutZero;
}

/** 附加字段只在确有真实值时显示；未读取/无文本/解析失败不制造空项。 */
function legacyFieldValue(field: FieldObservation | undefined): string | null {
  if (!field) return null;
  if (field.state !== 'observed') return null;
  if (field.meaning === 'explicit_empty') return '明确为空';
  if (field.meaning === 'explicit_null') return '明确空值';
  const raw = field.raw?.trim();
  return raw ? raw : null;
}

/** 缺值 / 明确为空 / 未读取 的表述互斥，不把缺失写成 0。 */
export function catalogSpecFact(item: CatalogDetailCoreView['item']): Fact {
  const field = item.fields.specification ?? item.specification;
  const business = fieldBusinessValue(field);
  const unit = fieldBusinessValue(item.fields.unit);
  const unitPart = unit === '待补' || unit === '未知' || unit === '解析失败' ? '' : ` / ${unit}`;
  if (business === '待补') return { value: '规格缺失（待补）', hint: '单位待补', warn: true };
  if (business === '未知') return { value: '规格未知', hint: null, warn: true };
  if (business === '解析失败') return { value: '规格解析失败', hint: null, warn: true };
  return { value: `${business}${unitPart}`, hint: unitPart ? null : '单位待补' };
}

function imageCaption(item: CatalogDetailCoreView['item']): string {
  const field = item.fields.imageRef;
  if (!field) return '暂无图片';
  if (field.state === 'not_read') return '暂无图片';
  if (field.state === 'parse_failed') return '图片引用解析失败';
  if (field.state === 'no_text') return '暂无图片';
  if (field.state !== 'observed') return '暂无图片';
  if (field.meaning === 'explicit_empty' || field.meaning === 'explicit_null') return '暂无图片';
  const raw = field.raw.trim();
  if (raw) return '已记录图片引用，暂未展示';
  return '暂无图片';
}

export function warehouseLabelOf(warehouse?: string): string {
  const trimmed = warehouse?.trim();
  return trimmed && trimmed !== 'all' ? trimmed : '全部仓库';
}

/**
 * 海外库存（当前仓已确认 BS 现有库存）。
 * 数量与货值都来自同一仓库范围投影；未确认、缺价、未建档、读取失败、无权限分别表达，不写 0。
 */
function overseasInventoryFact(params: {
  historical: boolean;
  bsSample: BsSampleDetail | null;
  bsSampleError: { code: string; message: string } | null;
  bsNotCreated: boolean;
}): Fact {
  if (params.historical) return { value: '—', hint: '历史版本不显示当前库存' };
  if (params.bsSampleError) {
    return {
      value: params.bsSampleError.code === 'forbidden' ? '无读取权限（不是 0）' : '读取失败（不是 0）',
      hint: params.bsSampleError.message,
      warn: true,
    };
  }
  const sample = params.bsSample;
  if (!sample || sample.status !== 'loaded') return { value: '—', hint: '库存未接入（不是 0）', warn: true };
  if (params.bsNotCreated) return { value: '—', hint: 'BS 未建档', warn: true };
  const scope = sample.valuation;
  if (scope.pendingTotal) return { value: '合计待核对', hint: '同仓多个来源编码逐行显示；未确认合计口径前不擅自相加', warn: true };
  if (scope.inventoryState === 'failed') return { value: '本仓同步失败', hint: '现值保留上次成功批次，不用 0 代替', warn: true };
  if (scope.confirmedOnHandTotal !== null) {
    const isZero = scope.confirmedOnHandTotal === '0';
    return {
      value: isZero ? '0 个（来源明确为 0）' : `${scope.confirmedOnHandTotal} 个`,
      hint: `${scope.confirmedLineCount} 行已采用 · 单个商品计数`,
    };
  }
  if (scope.inventoryState === 'unmapped_source') return { value: '—', hint: '本仓有来源行但未确认对应（不是 0）', warn: true };
  if (scope.inventoryState === 'unseen') return { value: '—', hint: '对应已确认，等待下一次完整同步采用（不是 0）', warn: true };
  if (scope.inventoryState === 'no_source' || scope.inventoryState === 'no_data') return { value: '—', hint: scope.valuationReason ?? '本仓没有该商品的来源记录（不是 0）', warn: true };
  return { value: '—', hint: scope.valuationReason ?? '库存不可确认', warn: true };
}

/** 当前货值：本包不新做估值；旧样表价格不能乘新库存冒充当前货值。 */
function valuatedFact(params: {
  historical: boolean;
  bsSample: BsSampleDetail | null;
  bsSampleError: { code: string; message: string } | null;
}): Fact {
  if (params.historical) return { value: '—', hint: '历史版本只保留当时口径的估值记录，不重算' };
  if (params.bsSampleError) {
    return { value: '暂未计算', hint: '库存读取失败时不估值，也不沿用旧金额', warn: true };
  }
  return { value: '暂未计算', hint: '本包不新做估值：旧样表价格不能乘新库存当作当前货值' };
}

function unitCostFact(params: { historical: boolean; adopted: AdoptedUnitCost | null; bsSampleError: { code: string; message: string } | null }): Fact {
  if (params.historical) return { value: '历史版本不显示当前价格', hint: '历史快照只代表当时资料版本，不掺当前价格' };
  if (params.bsSampleError) {
    return {
      value: params.bsSampleError.code === 'forbidden' ? '不可见' : '价格读取失败',
      hint: params.bsSampleError.code === 'forbidden' ? '账号没有金额读取权限（服务端限制）' : params.bsSampleError.message,
      warn: true,
    };
  }
  const adopted = params.adopted;
  if (!adopted) return { value: '价格未读取', hint: '未取得当前采用价格版本', warn: true };
  if (adopted.state === 'priced') return { value: formatCnyPrice(adopted.amountCny) ?? `¥${adopted.amountCny}`, hint: '人民币 / 单品 · 不含运费不含税' };
  return { value: adopted.reason, hint: '缺价不当作 0', warn: true };
}

function OverviewCard({
  label,
  fact,
  testId,
  extra,
}: {
  label: string;
  fact: Fact;
  testId: string;
  extra?: React.ReactNode;
}) {
  return (
    <div className={styles.overviewItem}>
      <dt>{label}</dt>
      <dd>
        <span data-testid={testId} className={fact.warn ? styles.overviewValueWarn : undefined}>{fact.value}</span>
        {fact.hint ? <span className={styles.overviewHint}>{fact.hint}</span> : null}
        {extra}
      </dd>
    </div>
  );
}

function SpecLine({ item }: { item: CatalogDetailCoreView['item'] }) {
  const spec = catalogSpecFact(item);
  return (
    <span className={spec.warn ? styles.identityWarn : undefined} data-testid="catalog-detail-spec">
      {spec.value}
    </span>
  );
}

/** 尺寸/重量分组：只显示确有来源值的小项；全部缺失时整行不显示（不制造“待补”墙）。 */
function dimensionLine(item: CatalogDetailCoreView['item'], keys: readonly string[]) {
  const parts = keys
    .map((key) => ({ key, value: fieldBusinessValue(item.fields[key]) }))
    .filter((part) => part.value !== '待补');
  if (parts.length === 0) return null;
  return parts.map((part) => `${CATALOG_FIELD_LABELS[part.key] ?? part.key} ${part.value}`).join(' · ');
}

function MaterialRow({ label, children, testId }: { label: string; children: React.ReactNode; testId?: string }) {
  return (
    <div data-testid={testId}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * F13 编辑资料：只允许既有首次补码与非价格修订范围。
 *
 * V3-04（R4/V2-02）：草稿、提示与“结果未知的原请求”分键存储，且键必须带当前主体：
 * - `catalog:edit-state:v3:<principalKey>:<itemId>`          普通未提交草稿
 * - `catalog:pending-request:v3:<principalKey>:<itemId>`     可能已提交但结果未知的原请求
 * 恢复时同时校验 version/principalKey/itemId，账户切换后 B 不会读到 A 的输入或 requestId。
 * 旧的无主体键 `catalog:edit-state:<itemId>` 无法确认所有者：不读取、不迁移、不删除，只在编辑区报告隔离保留。
 * 放弃草稿不得删除待核请求；核对只读，只有显式“重试原请求”才以同 requestId/参数/expectedRevision 重投。
 */
type StoredDraft = { version: 3; principalKey: string; itemId: string; draft: EditDraft; notice: string; savedAt: number };
type StoredPendingRequest = { version: 3; principalKey: string; itemId: string; pendingRequest: PendingRequest; savedAt: number };

const DRAFT_STORAGE_PREFIX = 'catalog:edit-state:v3:';
const PENDING_STORAGE_PREFIX = 'catalog:pending-request:v3:';
const LEGACY_DRAFT_PREFIX = 'catalog:edit-state:';

function editStorageKey(prefix: string, principalKey: string, itemId: string): string {
  return `${prefix}${principalKey}:${itemId}`;
}

function readStoredValue<T>(key: string, guard: (value: T) => boolean): T | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as T;
    if (!parsed || typeof parsed !== 'object') return null;
    return guard(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeStoredValue(key: string, value: unknown | null) {
  if (typeof window === 'undefined') return;
  try {
    if (!value) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 隐私模式等禁用存储时保持内存态，不阻断编辑 */
  }
}

function readStoredDraft(principalKey: string, itemId: string): StoredDraft | null {
  return readStoredValue<StoredDraft>(
    editStorageKey(DRAFT_STORAGE_PREFIX, principalKey, itemId),
    (value) => value.version === 3 && value.principalKey === principalKey && value.itemId === itemId && Boolean(value.draft),
  );
}

function readStoredPendingRequest(principalKey: string, itemId: string): StoredPendingRequest | null {
  return readStoredValue<StoredPendingRequest>(
    editStorageKey(PENDING_STORAGE_PREFIX, principalKey, itemId),
    (value) => value.version === 3 && value.principalKey === principalKey && value.itemId === itemId
      && Boolean(value.pendingRequest && value.pendingRequest.input),
  );
}

function writeStoredDraft(principalKey: string, itemId: string, value: StoredDraft | null) {
  writeStoredValue(editStorageKey(DRAFT_STORAGE_PREFIX, principalKey, itemId), value);
}

function writeStoredPendingRequest(principalKey: string, itemId: string, value: StoredPendingRequest | null) {
  writeStoredValue(editStorageKey(PENDING_STORAGE_PREFIX, principalKey, itemId), value);
}

/** 只检测旧键是否存在；不读取内容、不认领给当前登录者、不删除。 */
function hasLegacyDraft(itemId: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return Boolean(window.sessionStorage.getItem(`${LEGACY_DRAFT_PREFIX}${itemId}`));
  } catch {
    return false;
  }
}

function DetailEditPanel({ core, principalKey, onDirtyChange, onSaved, registerDraftBridge }: {
  core: CatalogDetailCoreView;
  /** V3-04：草稿/待核请求必须与当前登录主体绑定，不能只按 itemId 存取。 */
  principalKey: string;
  onDirtyChange?: (dirty: boolean) => void;
  onSaved?: () => void;
  /** 供外层（关闭/切分区/后退/切版本提示）落盘或清理草稿；待核请求单独保留。 */
  registerDraftBridge?: (bridge: { persist: () => void; clearDraft: () => void; clearAll: () => void }) => void;
}) {
  const { item } = core;
  const router = useRouter();
  const [busy, startTransition] = useTransition();
  /* 首次渲染即恢复“本主体、本商品”的草稿与未核对原请求（V3-04）；不在 effect 里 setState。 */
  const [initialDraft] = useState(() => readStoredDraft(principalKey, item.itemId));
  const [initialPending] = useState(() => readStoredPendingRequest(principalKey, item.itemId));
  const [legacyQuarantined] = useState(() => hasLegacyDraft(item.itemId));
  const [message, setMessage] = useState(initialDraft?.notice ?? '');
  const [pendingRequest, setPendingRequest] = useState<PendingRequest | null>(initialPending?.pendingRequest ?? null);
  const [draft, setDraft] = useState<EditDraft>(() => ({ ...EMPTY_DRAFT, ...(initialDraft?.draft ?? {}) }));
  const [restored] = useState(Boolean(initialDraft || initialPending));
  const specField = item.fields.specification ?? item.specification;

  const dirty = draft.code.trim() !== '' || draft.codeReason.trim() !== ''
    || draft.fieldValue !== '' || draft.evidenceRef.trim() !== '' || draft.reason.trim() !== ''
    || draft.confirmEmpty;

  /* 草稿与待核请求分别落盘：放弃编辑只清草稿，不抹掉原 requestId 与核对依据。 */
  useEffect(() => {
    if (!dirty) { writeStoredDraft(principalKey, item.itemId, null); return; }
    writeStoredDraft(principalKey, item.itemId, {
      version: 3, principalKey, itemId: item.itemId, draft, notice: message, savedAt: Date.now(),
    });
  }, [dirty, draft, message, principalKey, item.itemId]);

  useEffect(() => {
    if (!pendingRequest) { writeStoredPendingRequest(principalKey, item.itemId, null); return; }
    writeStoredPendingRequest(principalKey, item.itemId, {
      version: 3, principalKey, itemId: item.itemId, pendingRequest, savedAt: Date.now(),
    });
  }, [pendingRequest, principalKey, item.itemId]);

  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  /* 收起/卸载编辑表单时清空“未保存”标记，避免下次进入编辑态被上一轮草稿误判。 */
  useEffect(() => () => { onDirtyChange?.(false); }, [onDirtyChange]);

  useEffect(() => {
    registerDraftBridge?.({
      persist: () => {
        if (dirty) {
          writeStoredDraft(principalKey, item.itemId, {
            version: 3, principalKey, itemId: item.itemId, draft, notice: message, savedAt: Date.now(),
          });
        }
        if (pendingRequest) {
          writeStoredPendingRequest(principalKey, item.itemId, {
            version: 3, principalKey, itemId: item.itemId, pendingRequest, savedAt: Date.now(),
          });
        }
      },
      clearDraft: () => writeStoredDraft(principalKey, item.itemId, null),
      clearAll: () => {
        writeStoredDraft(principalKey, item.itemId, null);
        writeStoredPendingRequest(principalKey, item.itemId, null);
      },
    });
  }, [registerDraftBridge, principalKey, draft, message, pendingRequest, dirty, item.itemId]);

  async function submitOriginal(request: PendingRequest) {
    setPendingRequest(request);
    setMessage('正在提交原请求，请勿开始另一项操作。');
    try {
      const result = request.kind === 'initial_code'
        ? await assignInitialCodeAction(request.input) : await appendNonPriceRevisionAction(request.input);
      if (result.outcome === 'unknown') {
        /* 结果未知 ≠ 未保存：保留原 requestId 与原意图，不自动用新 ID 重发。 */
        setMessage(result.error ?? '提交结果暂未确认，请核对原请求。');
        return;
      }
      setPendingRequest(null);
      if (result.success) {
        setDraft(EMPTY_DRAFT);
        writeStoredDraft(principalKey, item.itemId, null);
        writeStoredPendingRequest(principalKey, item.itemId, null);
        const savedIntent = request.kind === 'initial_code' ? `首次补码已保存：${request.input.code}`
          : '资料修订已保存；旧版本和采用价格保持';
        setMessage(savedIntent);
        onSaved?.();
        router.refresh();
      } else setMessage(result.error ?? '原请求未保存。');
    } catch {
      setMessage('提交结果暂未确认。请使用“核对原请求”，不要创建另一项操作。');
    }
  }

  /**
   * V3-04.5：只读核对回执，绝不重发。找不到回执只说明“暂无回执”，不代表未提交；
   * 只有用户显式点击“重试原请求”才以同 requestId/参数/expectedRevision 调用既有幂等操作。
   */
  async function checkOriginal(request: PendingRequest) {
    setMessage('正在只读核对原请求回执…');
    try {
      const result = await checkCatalogRequestOutcomeAction({
        ...request.input,
        kind: request.kind,
      });
      if (!result.success) {
        setMessage(`核对未完成：${result.error ?? '回执读取失败'}。原请求保留，可稍后重试。`);
        return;
      }
      if (!result.data) {
        setMessage('当前账号暂无权核对原请求回执；原请求保留，权限恢复后可继续核对。');
        return;
      }
      const outcome = result.data;
      if (outcome.status === 'applied') {
        setPendingRequest(null);
        setDraft(EMPTY_DRAFT);
        writeStoredDraft(principalKey, item.itemId, null);
        writeStoredPendingRequest(principalKey, item.itemId, null);
        setMessage(`已核实原请求已保存（${outcome.actionLabel ?? '资料变更'}，资料版本 ${outcome.revision ?? '—'}）。`);
        onSaved?.();
        router.refresh();
        return;
      }
      if (outcome.status === 'no_receipt') {
        setMessage('未找到原请求回执；这不等于尚未提交。可稍后重新核对，确认后再显式重试原请求。');
        return;
      }
      if (outcome.status === 'scope_mismatch') {
        setMessage('回执与当前商品、版本或原始意图不一致，未认领；请人工核对后再处理。');
        return;
      }
      setMessage('当前账号暂无权核对原请求回执；原请求保留，权限恢复后可继续核对。');
    } catch {
      setMessage('核对失败（网络或传输异常）；原请求保留，可重试。');
    }
  }

  return (
    <section aria-label="补充资料" className={styles.formStack}>
      {restored && (
        <p className={styles.formMessage} role="status" data-testid="catalog-edit-restored">
          已恢复上次未保存的输入或未核对的原始请求；核对完成前不会另发请求。
        </p>
      )}
      {!item.iceCode && (
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            if (pendingRequest) return;
            startTransition(async () => {
              await submitOriginal({
                kind: 'initial_code',
                input: {
                  itemId: item.itemId,
                  expectedRevision: item.revision,
                  requestId: crypto.randomUUID(),
                  code: draft.code,
                  reason: draft.codeReason,
                },
              });
            });
          }}
        >
          <h3 className={styles.formTitle}>首次补码（本品还没有 ICE 货号）</h3>
          <div className={styles.currentValue}>当前值：待补货号（尚未分配 ICE 货号）</div>
          <fieldset className={styles.formStack} disabled={busy || pendingRequest !== null} style={{ border: 0, padding: 0, margin: 0 }}>
            <label className={styles.field}>
              首次ICE货号
              <Input name="code" required maxLength={50} value={draft.code} onChange={(event) => setDraft((prev) => ({ ...prev, code: event.target.value }))} />
            </label>
            <label className={styles.field}>
              补码依据
              <Input name="reason" required maxLength={1000} value={draft.codeReason} onChange={(event) => setDraft((prev) => ({ ...prev, codeReason: event.target.value }))} />
              <span className={styles.fieldHint}>依据会写入修订审计；不改变已有货号，也不重新分配。</span>
            </label>
            <div className={styles.formActions}>
              <Button type="submit">保存首次货号</Button>
            </div>
          </fieldset>
        </form>
      )}

      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          if (pendingRequest) return;
          const raw = draft.fieldValue;
          if (raw === '' && !draft.confirmEmpty) {
            setMessage('尚未输入采用值：请输入明确采用值，或勾选“确认明确清空（空串）”。');
            return;
          }
          const value: FieldObservation = raw === ''
            ? { state: 'observed', meaning: 'explicit_empty', raw: '', evidenceRef: draft.evidenceRef }
            : { state: 'observed', meaning: 'value', raw, evidenceRef: draft.evidenceRef };
          const request: PendingRequest = {
            kind: 'nonprice_revision',
            input: {
              itemId: item.itemId,
              expectedRevision: item.revision,
              requestId: crypto.randomUUID(),
              reason: draft.reason,
              fields: { [draft.field]: value },
            },
          };
          startTransition(async () => { await submitOriginal(request); });
        }}
      >
        <h3 className={styles.formTitle}>非价格资料修订</h3>
        <fieldset className={styles.formStack} disabled={busy || pendingRequest !== null} style={{ border: 0, padding: 0, margin: 0 }}>
          <div className={styles.formRow}>
            <label className={styles.field}>
              修订字段
              <select
                name="field"
                aria-label="修订字段"
                className={styles.select}
                value={draft.field}
                onChange={(event) => setDraft((prev) => ({ ...prev, field: event.target.value }))}
              >
                {REVISION_FIELDS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <div className={styles.field}>
              当前值
              <span className={styles.currentValue} data-testid="catalog-edit-current-value">
                {fieldBusinessValue(draft.field === 'specification' ? specField : item.fields[draft.field])}
                <span className={styles.fieldHint}>当前记录值：{fieldAuditValue(draft.field === 'specification' ? specField : item.fields[draft.field])}</span>
              </span>
            </div>
          </div>
          <label className={styles.field}>
            明确采用值（留空表示明确空串）
            <Input
              name="fieldValue"
              maxLength={2000}
              value={draft.fieldValue}
              onChange={(event) => setDraft((prev) => ({ ...prev, fieldValue: event.target.value }))}
            />
            <span className={styles.fieldHint}>拟采用值即上方输入内容；留空时须勾选下方“确认明确清空”，否则视为尚未输入，不提交。</span>
          </label>
          <label className={styles.checkRow}>
            <input
              type="checkbox"
              name="confirmEmpty"
              checked={draft.confirmEmpty}
              onChange={(event) => setDraft((prev) => ({ ...prev, confirmEmpty: event.target.checked }))}
            />
            确认明确清空（空串，不是“尚未输入”）
          </label>
          <div className={styles.formRow}>
            <label className={styles.field}>
              证据引用
              <Input name="evidenceRef" required maxLength={500} value={draft.evidenceRef} onChange={(event) => setDraft((prev) => ({ ...prev, evidenceRef: event.target.value }))} />
            </label>
            <label className={styles.field}>
              修订理由
              <Input name="revisionReason" required maxLength={1000} value={draft.reason} onChange={(event) => setDraft((prev) => ({ ...prev, reason: event.target.value }))} />
            </label>
          </div>
          <div className={styles.formActions}>
            <Button type="submit">保存非价格修订</Button>
          </div>
        </fieldset>
      </form>

      <p role="status" aria-live="polite" className={styles.formMessage}>{message}</p>
      {legacyQuarantined && (
        <p className={styles.formMessage} role="status" data-testid="catalog-edit-legacy-quarantined">
          发现未绑定账户的旧草稿，已隔离保留，未载入；确认归属前不会用它提交。
        </p>
      )}
      {pendingRequest && (
        <section aria-label="待核对原请求" data-testid="pending-original-request" className={styles.pendingBox}>
          <strong>原请求结果待核对</strong>
          <span>保留原请求编号与原始意图；不会自动用新请求编号重发。</span>
          <p data-testid="pending-original-input" className={styles.fieldHint}>
            原请求：{pendingRequest.kind === 'initial_code' ? '首次补码' : '非价格资料修订'} · 资料版本 {pendingRequest.input.expectedRevision}
            {' '}· 原字段、理由与请求编号已保留，未自动改写。
          </p>
          <div className={styles.formActions}>
            <Button type="button" variant="outline" disabled={busy} data-testid="catalog-check-original" onClick={() => startTransition(() => checkOriginal(pendingRequest))}>
              只读核对原请求
            </Button>
            <Button type="button" variant="outline" disabled={busy} data-testid="catalog-retry-original" onClick={() => startTransition(() => submitOriginal(pendingRequest))}>
              重试原请求（同一编号）
            </Button>
          </div>
          <p className={styles.fieldHint}>核对不会写入；“重试原请求”才会以同一请求编号与原参数重投。</p>
        </section>
      )}
    </section>
  );
}

export function CatalogDetail({
  core,
  principalKey,
  bsSample = null,
  bsSampleError = null,
  warehouseFilter,
  embedded = false,
  onRevisionSaved,
  editing: editingProp,
  onEditingChange,
  onDirtyChange,
  onRetry,
  warehouseOptions,
  onWarehouseChange,
  attachmentInitial = null,
  attachmentLoad,
  returnHref,
  listHref,
  currentHref,
  defaultSection = 'material',
  bodyRef,
  notices,
  onSectionChange,
  onSelectRevision,
  onBackToCurrent,
  onOpenEvidence,
}: {
  core: CatalogDetailCoreView;
  /** V3-04：草稿/待核请求必须绑定当前登录主体。 */
  principalKey: string;
  bsSample?: BsSampleDetail | null;
  bsSampleError?: { code: string; message: string } | null;
  warehouseFilter?: string;
  embedded?: boolean;
  onRevisionSaved?: () => void;
  /** 弹窗由标题区控制编辑入口；直链页自己渲染入口。 */
  editing?: boolean;
  onEditingChange?: (editing: boolean) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onRetry?: () => void;
  warehouseOptions?: string[];
  onWarehouseChange?: (warehouse: string) => void;
  attachmentInitial?: DetailAttachmentsModel | null;
  attachmentLoad?: () => Promise<DetailAttachmentsModel | null>;
  /** 返回壳（保留搜索、仓库与分页；仅旧入口兜底使用）。 */
  returnHref?: string;
  /** 列表级来源（用于处理/附件返回上下文，不含嵌套 from）。 */
  listHref?: string;
  currentHref?: string;
  defaultSection?: CatalogDetailSection;
  /** 弹窗把自己的滚动体 ref 交给详情：同一滚动体，分区切换才不改变外框。 */
  bodyRef?: React.RefObject<HTMLDivElement | null>;
  /** 弹窗状态行（列表摘要 / 过期 / 失败 / 同步中）在滚动体内呈现，不挤压固定外壳。 */
  notices?: React.ReactNode;
  onSectionChange?: (section: CatalogDetailSection) => void;
  /** V3-01：在同一个弹窗内切换历史版本；不新开页面、不叠加第二个弹窗。 */
  onSelectRevision?: (revision: number) => void;
  /** V3-01：历史版本内原位返回当前资料。 */
  onBackToCurrent?: () => void;
  /** V3-01：在弹窗内容区打开“来源与证据”子视图（授权后按需读取）。 */
  onOpenEvidence?: (revision?: number) => void;
}) {
  const { item, flags, writeAccess, historical } = core;
  const router = useRouter();
  const [history, setHistory] = useState<CatalogRevisionHistoryDto[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyEmptyConfirmed, setHistoryEmptyConfirmed] = useState(false);
  const [dirtyState, setDirtyState] = useState(false);
  const [section, setSection] = useState<CatalogDetailSection>(defaultSection);
  const sectionRef = useRef<CatalogDetailSection>(defaultSection);
  const scrollPositions = useRef<Record<CatalogDetailSection, number>>({ material: 0, inventory: 0, history: 0 });
  const localBodyRef = useRef<HTMLDivElement | null>(null);
  const activeBodyRef = bodyRef ?? localBodyRef;
  const dirtyBridge = useRef<{ persist: () => void; clearDraft: () => void; clearAll: () => void } | null>(null);
  const pendingHref = useRef<string | null>(null);

  /* 编辑入口：弹窗由标题区（loader）控制，直链页自己控制。 */
  const [internalEditing, setInternalEditing] = useState(false);
  const [editingConfirm, setEditingConfirm] = useState(false);
  const [leavePrompt, setLeavePrompt] = useState<null | { kind: 'section'; next: CatalogDetailSection } | { kind: 'href'; href: string } | { kind: 'back' }>(null);
  const editing = editingProp ?? internalEditing;
  const applyEditing = useCallback((next: boolean) => {
    if (onEditingChange) onEditingChange(next);
    else setInternalEditing(next);
  }, [onEditingChange]);

  const barcodeBusiness = fieldBusinessValue(item.fields.barcode) !== '待补'
    ? fieldBusinessValue(item.fields.barcode)
    : fieldBusinessValue(item.barcodeRefs[0]);
  const adopted = bsSample?.status === 'loaded' ? adoptedUnitCostFromFinancial(bsSample.adoptedUnitCost) : null;
  const resolvedWarehouse = warehouseFilter ?? undefined;
  /**
   * V4-01：选项顺序只由“完整仓库清单/已读到的仓库集合”决定，绝不按当前选中仓排序。
   * 完整选项与备用路径都做同一稳定排序；切仓、加载、缓存命中、后台校验或局部失败都不改变顺序。
   */
  const sampleWarehouseChoices = useMemo(() => (
    bsSample?.status === 'loaded'
      ? Array.from(new Set((bsSample.rows as unknown as Array<Record<string, unknown>>).map((row) => String(row.warehouse ?? '')).filter(Boolean)))
      : []
  ), [bsSample]);
  const [seenWarehouses, setSeenWarehouses] = useState<string[]>([]);
  /**
   * 完整选项缺失时，已见过的仓库也保留在集合里；当前选中仓只加入集合，不排到第一位。
   * 顺序只按稳定排序，不依赖当前选中仓。
   */
  const warehouseChoices = useMemo(() => {
    const source = warehouseOptions && warehouseOptions.length > 0
      ? warehouseOptions
      : [...seenWarehouses, ...sampleWarehouseChoices];
    const unique = new Set<string>();
    for (const entry of source) if (entry && entry !== 'all') unique.add(entry);
    if (resolvedWarehouse && resolvedWarehouse !== 'all') unique.add(resolvedWarehouse);
    return [...unique].sort();
  }, [warehouseOptions, seenWarehouses, sampleWarehouseChoices, resolvedWarehouse]);

  const dirty = editing && dirtyState;

  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

  /* 未保存草稿的站内链接离开保护（R4）：直链页与弹窗共用。 */
  useUnsavedLeaveGuard({
    active: dirty,
    onBlocked: (href) => { dirtyBridge.current?.persist(); pendingHref.current = href; setLeavePrompt({ kind: 'href', href }); },
  });

  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const asyncHistoryRef = useRef(false);
  const [historyRetryToken, setHistoryRetryToken] = useState(0);
  const loadHistory = useCallback(async (force = false) => {
    if (asyncHistoryRef.current) return;
    if (!force && (history.length > 0 || historyEmptyConfirmed)) return;
    asyncHistoryRef.current = true;
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const result = await fetchCatalogDetailHistoryAction(item.itemId);
      if (!result.success) {
        setHistoryError(result.error ?? '变更记录读取失败');
        return;
      }
      const rows = result.data ?? [];
      setHistory(rows);
      if (rows.length === 0) setHistoryEmptyConfirmed(true);
    } catch {
      setHistoryError('变更记录读取失败，请重试。');
    } finally {
      asyncHistoryRef.current = false;
      setHistoryLoading(false);
    }
  }, [history.length, historyEmptyConfirmed, item.itemId]);

  useEffect(() => {
    if (defaultSection !== 'history') return;
    const frame = window.requestAnimationFrame(() => { void loadHistory(); });
    return () => window.cancelAnimationFrame(frame);
  }, [defaultSection, loadHistory, historyRetryToken]);

  /* V4-01：切仓不重挂载组件，也不清空三分区滚动记录或强制回顶。
     新仓内容更短时由浏览器在渲染后做最小收敛（必要时自动 clamp），不额外指定 scrollTop。 */

  /* ---- 附件（F07：与直链同一展示组件；只在确有处理事项时出现） ---- */
  const [attachments, setAttachments] = useState<DetailAttachmentsModel | null>(attachmentInitial);
  const [attachmentsState, setAttachmentsState] = useState<'idle' | 'loading' | 'ready' | 'error'>(attachmentInitial ? 'ready' : 'idle');
  const [attachmentsError, setAttachmentsError] = useState<string | null>(null);
  const attachmentsAttempted = useRef(false);

  const loadAttachments = useCallback(async (force = false) => {
    if (!attachmentLoad) return;
    if (!force && attachmentsAttempted.current) return;
    attachmentsAttempted.current = true;
    setAttachmentsState('loading');
    setAttachmentsError(null);
    try {
      const result = await attachmentLoad();
      if (!result) {
        setAttachmentsState('error');
        setAttachmentsError('相关处理入口读取失败（不等于已处理完成或模块未启用），可重试。');
        return;
      }
      setAttachments(result);
      setAttachmentsState('ready');
    } catch {
      setAttachmentsState('error');
      setAttachmentsError('相关处理入口读取失败，请重试。');
    }
  }, [attachmentLoad]);

  /* ---- 返回壳与历史链接 ---- */
  const historyFrom = listHref;
  const returnTarget = returnHref ?? listHref ?? '/dashboard/catalog';
  const attachmentFromHref = embedded ? (listHref ?? returnTarget) : (currentHref ?? listHref ?? returnTarget);
  const showWarehouseSwitcher = !historical && (Boolean(onWarehouseChange) || (!embedded && warehouseChoices.length > 0));

  function switchWarehouse(next: string) {
    setSeenWarehouses((prev) => {
      const union = new Set(prev);
      for (const entry of warehouseChoices) if (entry && entry !== 'all') union.add(entry);
      if (next && next !== 'all') union.add(next);
      return union.size === prev.length ? prev : [...union];
    });
    if (onWarehouseChange) { onWarehouseChange(next); return; }
    const params = new URLSearchParams();
    if (next && next !== 'all') params.set('warehouse', next);
    if (historyFrom) params.set('from', historyFrom);
    const qs = params.toString();
    router.replace(qs ? `/dashboard/catalog/${item.itemId}?${qs}` : `/dashboard/catalog/${item.itemId}`, { scroll: false });
  }

  /* V4-03：版本切换不清空三分区滚动记录，也不无条件回顶。
     从历史来源返回时由弹窗在目标版本就绪后恢复原滚动位置；普通版本切换保持在当前阅读位置。 */

  const canEdit = !historical && writeAccess.canWrite;
  const brushPending = flags.brushPending;
  const hasProcessingIssue = brushPending || (item.newProductConfirmed && !item.iceCode);

  const editingRequested = (next: boolean) => {
    /* 直链页自己处理未保存修改的收起确认；弹窗交给标题区的离开提示。 */
    if (!next && !onEditingChange && dirty) { setEditingConfirm(true); return; }
    setEditingConfirm(false);
    if (!next) setDirtyState(false);
    applyEditing(next);
  };

  const persistScroll = () => {
    const body = activeBodyRef.current;
    if (embedded) scrollPositions.current[sectionRef.current] = body?.scrollTop ?? 0;
    else scrollPositions.current[sectionRef.current] = window.scrollY;
  };

  const restoreScroll = (next: CatalogDetailSection) => {
    window.requestAnimationFrame(() => {
      if (embedded) {
        const body = activeBodyRef.current;
        if (body) body.scrollTop = scrollPositions.current[next];
      } else {
        window.scrollTo({ top: scrollPositions.current[next], left: 0 });
      }
    });
  };

  const applySection = (next: CatalogDetailSection) => {
    persistScroll();
    sectionRef.current = next;
    setSection(next);
    onSectionChange?.(next);
    if (next === 'history') void loadHistory();
    restoreScroll(next);
  };

  const changeSection = (next: CatalogDetailSection) => {
    if (next === section) return;
    /* 在商品资料分区编辑时切换到其它分区会卸载编辑器：先共用草稿保护（R4）。 */
    if (editing && dirty) {
      dirtyBridge.current?.persist();
      setLeavePrompt({ kind: 'section', next });
      return;
    }
    if (editing) applyEditing(false);
    applySection(next);
  };

  const resolveLeave = () => {
    /* V3-04：放弃普通草稿只清草稿；待核请求（原 requestId 与依据）必须保留。 */
    dirtyBridge.current?.clearDraft();
    setLeavePrompt(null);
    setDirtyState(false);
    setEditingConfirm(false);
    applyEditing(false);
  };

  const overviewInventory = overseasInventoryFact({ historical, bsSample, bsSampleError, bsNotCreated: flags.bsNotCreated });
  const overviewValue = valuatedFact({ historical, bsSample, bsSampleError });
  const overviewUnitCost = unitCostFact({ historical, adopted, bsSampleError });

  const domesticFact: Fact = { value: '未接入', hint: null };
  const transitFact: Fact = { value: '未接入', hint: null };

  const overview = (
    <section className={styles.overview} aria-label="库存与货值概览" data-testid="catalog-detail-overview">
      <div className={styles.overviewHead}>
        <div className={styles.overviewIdentity}>
          <Pill tone={item.newProductConfirmed && !item.iceCode ? 'amber' : historical ? 'neutral' : 'green'}>
            {item.newProductConfirmed && !item.iceCode ? '新品，待补货号' : historical ? '历史资料版本' : '当前采用资料'}
          </Pill>
          {brushPending && <Pill tone="amber">刷子待确认</Pill>}
        </div>
        <p className={styles.overviewMeta}>
          仓库范围 <strong data-testid="catalog-overview-warehouse">{warehouseLabelOf(resolvedWarehouse)}</strong>
          {' · '}
          <span data-testid="catalog-overview-sample">
            {(() => {
              const observationAt = bsSample?.status === 'loaded' ? bsSample.observationAt : null;
              return observationAt ? `BigSeller · 最近来源 ${new Date(observationAt).toLocaleString('zh-CN', { hour12: false })}` : 'BigSeller 库存';
            })()}
          </span>
        </p>
      </div>
      <dl className={styles.overviewGrid}>
        <OverviewCard label="国内库存" fact={domesticFact} testId="catalog-overview-domestic" />
        <OverviewCard label="BigSeller 库存" fact={overviewInventory} testId="catalog-overview-overseas" />
        <OverviewCard label="在途库存" fact={transitFact} testId="catalog-overview-transit" />
        <OverviewCard label="当前货值" fact={overviewValue} testId="catalog-overview-valuated" />
      </dl>
    </section>
  );

  const pageHeader = !embedded ? (
    <header className={styles.pageHeader}>
      <nav className={styles.returnBar} aria-label="返回">
        <Link
          className={styles.returnLink}
          href={returnTarget}
          onClick={(event) => {
            if (!dirty) return;
            event.preventDefault();
            dirtyBridge.current?.persist();
            setLeavePrompt({ kind: 'href', href: returnTarget });
          }}
        >
          ← 返回商品库（保留搜索与仓库）
        </Link>
        {historical && onBackToCurrent && (
          <button type="button" className={styles.returnLink} data-testid="catalog-detail-back-current" onClick={onBackToCurrent}>
            返回当前资料
          </button>
        )}
      </nav>
      <div className={styles.pageTitleRow}>
        <div>
          <h1 className={styles.pageTitle} data-testid="catalog-detail-title">
            {item.iceCode ?? '待补货号'} · {item.nameCn}
          </h1>
          <p className={styles.pageMeta}>
            <SpecLine item={item} />
            {' · '}
            资料版本 <span data-testid="catalog-detail-version">{item.revision}</span>
            {' · '}
            当前仓 {warehouseLabelOf(resolvedWarehouse)}
            {historical ? ' · 历史版本（只读）' : ''}
          </p>
        </div>
        {canEdit && (
          <button
            type="button"
            className={styles.headerButton}
            aria-pressed={editing}
            onClick={() => editingRequested(!editing)}
          >
            {editing ? '收起编辑' : '编辑资料'}
          </button>
        )}
      </div>
      {historical && (
        <p className={styles.sectionNote}>
          只读历史版本：不显示当前库存、当前价格与编辑入口。
        </p>
      )}
    </header>
  ) : null;

  const tabBar = (
    <div className={styles.tabBar} role="tablist" aria-label="商品详情分区" data-testid="catalog-detail-tabs">
      {SECTIONS.map((entry) => {
        const selected = entry.key === section;
        return (
          <button
            key={entry.key}
            type="button"
            role="tab"
            id={`catalog-tab-${entry.key}`}
            aria-selected={selected}
            aria-controls={`catalog-panel-${entry.key}`}
            tabIndex={selected ? 0 : -1}
            className={selected ? `${styles.tab} ${styles.tabActive}` : styles.tab}
            data-testid={`catalog-tab-${entry.key}`}
            onClick={() => changeSection(entry.key)}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
              event.preventDefault();
              const index = SECTIONS.findIndex((option) => option.key === entry.key);
              const delta = event.key === 'ArrowRight' ? 1 : -1;
              const next = SECTIONS[(index + delta + SECTIONS.length) % SECTIONS.length];
              changeSection(next.key);
              window.requestAnimationFrame(() => document.getElementById(`catalog-tab-${next.key}`)?.focus());
            }}
          >
            {entry.label}
          </button>
        );
      })}
    </div>
  );

  const leavePromptNode = leavePrompt ? (
    <div className={styles.leaveNotice} role="alert" data-testid="catalog-edit-leave-notice">
      <span>
        {leavePrompt.kind === 'section'
          ? '有尚未保存的资料修改；切换到其它分区会离开编辑。'
          : leavePrompt.kind === 'back'
            ? '浏览器后退被取消：有尚未保存的资料修改。'
            : '有尚未保存的资料修改，离开后输入会暂存，可再次进入编辑继续。'}
      </span>
      <button type="button" className={styles.headerButton} onClick={() => { setLeavePrompt(null); pendingHref.current = null; }}>继续编辑</button>
      <button
        type="button"
        className={styles.headerButton}
        onClick={() => {
          const prompt = leavePrompt;
          resolveLeave();
          if (prompt.kind === 'section') applySection(prompt.next);
          else if (prompt.kind === 'href') router.push(prompt.href);
        }}
      >
        {leavePrompt.kind === 'section' ? '放弃修改并切换' : '放弃修改并离开'}
      </button>
    </div>
  ) : null;

  const editingLeaveConfirm = editingConfirm ? (
    <div className={styles.leaveNotice} role="alert" style={{ padding: '10px 12px' }}>
      <span>有尚未保存的资料修改，收起后输入会暂存；再次进入编辑可继续。</span>
      <button type="button" className={styles.headerButton} onClick={() => setEditingConfirm(false)}>继续编辑</button>
      <button
        type="button"
        className={styles.headerButton}
        onClick={() => { setEditingConfirm(false); setDirtyState(false); applyEditing(false); }}
      >
        放弃修改并收起
      </button>
    </div>
  ) : null;

  const extraLegacyFields = ([
    { key: 'packaging', label: CATALOG_FIELD_LABELS.packaging, value: legacyFieldValue(item.fields.packaging) },
    { key: 'depth', label: CATALOG_FIELD_LABELS.depth, value: legacyFieldValue(item.fields.depth) },
    { key: 'weight', label: CATALOG_FIELD_LABELS.weight, value: legacyFieldValue(item.fields.weight) },
  ] as const).filter((entry) => entry.value !== null);

  const materialPanel = (
    <div role="tabpanel" id="catalog-panel-material" aria-labelledby="catalog-tab-material" className={styles.sectionStack} data-testid="catalog-tabpanel-material">
      {editing && canEdit && (
        <section className={styles.section} aria-label="编辑资料" data-testid="catalog-detail-edit">
          <div className={styles.sectionHead}>
            <div>
              <h2 className={styles.sectionTitle}>编辑资料</h2>
              <p className={styles.sectionNote}>只允许既有首次补码与非价格修订；显示当前值、拟采用值与依据，保存后旧版本保持。</p>
            </div>
          </div>
          {editingLeaveConfirm}
          <div style={{ marginTop: 12 }}>
            <DetailEditPanel
              core={core}
              principalKey={principalKey}
              onDirtyChange={setDirtyState}
              onSaved={() => {
                onRevisionSaved?.();
                setHistory([]);
                setHistoryEmptyConfirmed(false);
                /* V3-04.8：保存前已经打开的历史必须更新，不能继续显示旧记录。 */
                if (sectionRef.current === 'history') void loadHistory(true);
              }}
              registerDraftBridge={(bridge) => { dirtyBridge.current = bridge; }}
            />
          </div>
        </section>
      )}

      <section className={styles.section} aria-label="商品资料">
        <div className={styles.sectionHead}>
          <div>
            <h2 className={styles.sectionTitle}>商品资料</h2>
          </div>
        </div>
        <div className={styles.sectionBody}>
          {!historical && !writeAccess.canWrite && (
            <p data-testid="catalog-write-denied" className={styles.deniedNote}>
              当前账号仅可查看，不能编辑资料。
            </p>
          )}
          <div className={styles.hero}>
            <span className={`${demoStyles.productArt} ${demoStyles.productArtLarge}`} aria-label="商品图片占位">
              <Package size={32} strokeWidth={1.3} />
              <small>占位</small>
            </span>
            <div className={styles.heroText}>
              {optionalFieldRow(item.fields.englishName).show && (
                <p className={styles.heroMeta}>{optionalFieldRow(item.fields.englishName).value}</p>
              )}
              <p className={styles.heroCaption}>{imageCaption(item)}</p>
            </div>
          </div>
          <dl className={styles.identityGrid} data-testid="catalog-material-details">
            <MaterialRow label="中文产品名称" testId="catalog-material-name">{item.nameCn}</MaterialRow>
            <MaterialRow label="公司货号（ICE）" testId="catalog-material-ice-code">{item.iceCode ?? '待补货号'}</MaterialRow>
            <MaterialRow label="69编码（字符串）" testId="catalog-material-barcode"><span className={styles.codeCell}>{barcodeBusiness}</span></MaterialRow>
            {optionalFieldRow(item.fields.englishName).show && (
              <MaterialRow label="英文名称" testId="catalog-material-english-name">{optionalFieldRow(item.fields.englishName).value}</MaterialRow>
            )}
            <MaterialRow label="规格 / 单位" testId="catalog-material-spec">
              {catalogSpecFact(item).value}
              {catalogSpecFact(item).hint ? <span className={styles.fieldHint}>{catalogSpecFact(item).hint}</span> : null}
            </MaterialRow>
            {optionalFieldRow(item.fields.category).show && (
              <MaterialRow label="商品分类" testId="catalog-material-category">{optionalFieldRow(item.fields.category).value}</MaterialRow>
            )}
            {optionalFieldRow(item.fields.factory).show && (
              <MaterialRow label="生产工厂" testId="catalog-material-factory">{optionalFieldRow(item.fields.factory).value}</MaterialRow>
            )}
            {dimensionLine(item, SINGLE_SIZE_KEYS) && (
              <MaterialRow label="单产品尺寸" testId="catalog-material-single-size">{dimensionLine(item, SINGLE_SIZE_KEYS)}</MaterialRow>
            )}
            {optionalFieldRow(item.fields.unitWeight).show && (
              <MaterialRow label="单产品重量" testId="catalog-material-single-weight">
                {`${optionalFieldRow(item.fields.unitWeight).value} kg`}
              </MaterialRow>
            )}
            {optionalFieldRow(item.fields.cartonQuantity).show && (
              <MaterialRow label="装箱数量" testId="catalog-material-carton-quantity">{optionalFieldRow(item.fields.cartonQuantity).value}</MaterialRow>
            )}
            {dimensionLine(item, CARTON_SIZE_KEYS) && (
              <MaterialRow label="外箱尺寸" testId="catalog-material-carton-size">{dimensionLine(item, CARTON_SIZE_KEYS)}</MaterialRow>
            )}
            {optionalFieldRow(item.fields.cartonWeight).show && (
              <MaterialRow label="外箱重量" testId="catalog-material-carton-weight">
                {formatMeasureValue(optionalFieldRow(item.fields.cartonWeight).value)}
              </MaterialRow>
            )}
            {optionalFieldRow(item.fields.cartonVolume).show && (
              <MaterialRow label="单箱体积" testId="catalog-material-carton-volume">
                {formatMeasureValue(optionalFieldRow(item.fields.cartonVolume).value)}
              </MaterialRow>
            )}
            {optionalFieldRow(item.fields.unitVolume).show && (
              <MaterialRow label="单瓶体积" testId="catalog-material-unit-volume">
                {formatMeasureValue(optionalFieldRow(item.fields.unitVolume).value)}
              </MaterialRow>
            )}
            <MaterialRow label="图片引用" testId="catalog-material-image">{imageCaption(item)}</MaterialRow>
            <MaterialRow label="采用进货价" testId="catalog-material-unit-cost">
              <span data-testid="catalog-material-unit-cost-value">{overviewUnitCost.value}</span>
              <span className={styles.fieldHint}>{overviewUnitCost.hint ?? '人民币 / 单品 · 不含运费不含税'}</span>
            </MaterialRow>
          </dl>
          {onOpenEvidence && (
            <p className={styles.sectionNote} data-testid="catalog-material-source-link">
              资料来源：本批采用资料、真实修订与来源对应。
              {' '}
              <button type="button" className={demoStyles.textLink} onClick={() => onOpenEvidence()}>查看数据来源</button>
            </p>
          )}
          {extraLegacyFields.length > 0 && (
            <details className={styles.subDetails} data-testid="catalog-material-extra">
              <summary>附加字段</summary>
              <div className={styles.subDetailsBody}>
                <dl className={styles.auditGrid}>
                  {extraLegacyFields.map((entry) => (
                    <div key={entry.key}>
                      <dt>{entry.label}</dt>
                      <dd data-testid={entry.key === 'packaging' ? 'catalog-material-packaging-legacy' : undefined}>{entry.value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </details>
          )}
        </div>
      </section>
    </div>
  );

  const inventoryPanel = (
    <div role="tabpanel" id="catalog-panel-inventory" aria-labelledby="catalog-tab-inventory" className={styles.sectionStack} data-testid="catalog-tabpanel-inventory">
      <section className={styles.section} aria-label="库存明细">
        <div className={styles.sectionHead}>
          <div>
            <h2 className={styles.sectionTitle}>库存明细</h2>
            <p className={styles.sectionNote}>BigSeller 库存（海外）；数量按单个商品计数，锁定与在途不计入当前货值。</p>
          </div>
        </div>
        <div className={styles.sectionBody}>
          {showWarehouseSwitcher && (
            <div className={styles.controls} role="group" aria-label="仓库范围" data-testid="catalog-inventory-warehouse">
              <span className={styles.controlsLabel}>仓库范围</span>
              {[{ value: 'all', label: '全部仓库' }, ...warehouseChoices.filter((w) => w !== 'all').map((w) => ({ value: w, label: w }))].map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={styles.chip}
                  data-warehouse-option={option.value}
                  aria-pressed={(resolvedWarehouse ?? 'all') === option.value}
                  disabled={dirty}
                  onClick={() => switchWarehouse(option.value)}
                >
                  {option.label}
                </button>
              ))}
              {dirty && <span className={styles.fieldHint}>有未保存修改：保存或放弃后才能切换仓库。</span>}
            </div>
          )}
          {!historical && (
            <BsSampleBusinessBlock
              sample={bsSample}
              sampleError={bsSampleError ?? null}
              warehouse={resolvedWarehouse}
              onRetry={onRetry}
              onOpenEvidence={onOpenEvidence ? () => onOpenEvidence() : undefined}
              onShowAllWarehouses={showWarehouseSwitcher ? () => switchWarehouse('all') : undefined}
            />
          )}
          {historical && (
            <p className={styles.sectionNote} data-testid="catalog-inventory-historical">
              历史版本不显示当前库存、当前价格与估算货值。
              {onBackToCurrent ? (
                <> {' '}
                  <button type="button" className={demoStyles.textLink} onClick={onBackToCurrent}>返回当前资料</button>
                </>
              ) : null}
            </p>
          )}

          {hasProcessingIssue && !historical && (attachmentInitial || attachmentLoad) && (
            <section className={styles.processing} aria-label="相关处理入口" data-testid="catalog-processing-entry">
              <h3 className={styles.sectionTitle}>相关处理</h3>
              <p className={styles.sectionNote}>
                该商品有{brushPending ? '来源待确认' : ''}{brushPending && item.newProductConfirmed && !item.iceCode ? '、' : ''}
                {item.newProductConfirmed && !item.iceCode ? '新品待补货号' : ''}事项。
              </p>
              {attachmentInitial
                ? <DetailAttachments {...attachmentInitial} itemId={item.itemId} fromHref={attachmentFromHref} />
                : (
                  <details className={styles.subDetails} onToggle={(event) => {
                    if ((event.target as HTMLDetailsElement).open) void loadAttachments();
                  }}>
                    <summary>打开处理入口</summary>
                    <div className={styles.subDetailsBody}>
                      {attachmentsState === 'loading' && <p className={styles.sectionNote} role="status">正在读取处理入口…</p>}
                      {attachmentsState === 'error' && (
                        <p role="alert">
                          {attachmentsError ?? '处理入口读取失败。'}
                          {' '}
                          <button type="button" className={demoStyles.textLink} onClick={() => void loadAttachments(true)}>重试</button>
                        </p>
                      )}
                      {attachmentsState === 'ready' && attachments && (
                        <DetailAttachments {...attachments} itemId={item.itemId} fromHref={attachmentFromHref} />
                      )}
                    </div>
                  </details>
                )}
            </section>
          )}
          {onOpenEvidence && (
            <p className={styles.sectionNote} data-testid="catalog-inventory-source-link">
              库存来源：BigSeller 自动导出（账号/仓库/来源编码）与当前参与仓库范围。
              {' '}
              <button type="button" className={demoStyles.textLink} onClick={() => onOpenEvidence()}>查看数据来源</button>
            </p>
          )}
        </div>
      </section>
    </div>
  );

  const historyPanel = (
    <div role="tabpanel" id="catalog-panel-history" aria-labelledby="catalog-tab-history" className={styles.sectionStack} data-testid="catalog-tabpanel-history">
      <section className={styles.section} aria-label="变更记录">
        <div className={styles.sectionHead}>
          <div>
            <h2 className={styles.sectionTitle}>资料修改</h2>
          </div>
          {historical && onBackToCurrent && (
            <button type="button" className={styles.returnLink} data-testid="catalog-history-back-current" onClick={onBackToCurrent}>
              返回当前资料
            </button>
          )}
        </div>
        <div className={styles.sectionBody}>
          <p className={styles.sectionNote}>
            当前查看：资料版本 <strong>{item.revision}</strong>{historical ? '（历史只读）' : '（当前）'}
          </p>
          {historyLoading && <p className={styles.sectionNote} role="status">加载变更记录…</p>}
          {historyError && (
            <p role="alert">
              {historyError}{' '}
              <button type="button" className={demoStyles.textLink} onClick={() => { setHistory([]); setHistoryEmptyConfirmed(false); setHistoryRetryToken((n) => n + 1); void loadHistory(true); }}>重试</button>
            </p>
          )}
          {!historyLoading && historyEmptyConfirmed && history.length === 0 && (
            <p className={styles.sectionNote} data-testid="catalog-history-empty">暂无历史版本记录。</p>
          )}
          <ul className={styles.historyList} data-testid="catalog-history-list">
            {history.map((entry) => {
              const display = entry.display;
              return (
                <li
                  key={entry.revision}
                  data-testid={`revision-history-${entry.revision}`}
                  data-current={display.isCurrent ? 'true' : 'false'}
                  className={styles.historyItem}
                >
                  <div className={styles.historyRow}>
                    <strong className={styles.historyVersion}>版本 {entry.revision}</strong>
                    {display.isCurrent ? (
                      <span className={styles.historyCurrentBadge} data-testid="revision-current-badge">当前</span>
                    ) : onSelectRevision ? (
                      <button
                        type="button"
                        className={demoStyles.textLink}
                        data-testid={`revision-switch-${entry.revision}`}
                        onClick={() => onSelectRevision(entry.revision)}
                      >
                        查看此版本
                      </button>
                    ) : null}
                  </div>
                  <p className={styles.historyMeta} data-testid="revision-summary">
                    {entry.iceCode ?? '待补货号'} · {entry.nameCn} · {display.kind === 'initial' ? '初始资料' : '人工修订'}
                  </p>
                  <p className={styles.historyMeta} data-testid="revision-reason">{display.reasonLabel}</p>
                  {display.changedFields.length > 0 && (
                    <ul className={styles.historyChanges} data-testid="revision-changed-fields">
                      {display.changedFields.map((change) => (
                        <li key={change.key}>{change.label}：{change.before || '（空）'} → {change.after || '（空）'}</li>
                      ))}
                    </ul>
                  )}
                  <p className={styles.historyMeta}>
                    记录时间 <span data-testid="revision-recorded-at">{display.recordedAtDisplay}</span>
                    {display.actorLabel ? (
                      <> {' · '}操作者 <span data-testid="revision-actor">{display.actorLabel}</span></>
                    ) : null}
                    {onOpenEvidence ? (
                      <> {' · '}
                        <button
                          type="button"
                          className={demoStyles.textLink}
                          data-testid="revision-evidence-open"
                          data-evidence-revision={entry.revision}
                          onClick={() => onOpenEvidence(entry.revision)}
                        >
                          查看数据来源
                        </button>
                      </>
                    ) : null}
                  </p>
                </li>
              );
            })}
          </ul>
        </div>
      </section>

      <section className={styles.section} aria-label="库存变化">
        <div className={styles.sectionHead}>
          <div>
            <h2 className={styles.sectionTitle}>库存变化</h2>
          </div>
        </div>
        <div className={styles.sectionBody}>
          <p className={styles.sectionNote} data-testid="catalog-history-stock-note">暂无库存变化记录。</p>
        </div>
      </section>
    </div>
  );

  return (
    <div className={embedded ? styles.dialogFrame : styles.pageRoot}>
      {pageHeader}
      {tabBar}
      <div
        ref={activeBodyRef}
        className={styles.detailBody}
        data-detail-container={embedded ? 'dialog' : 'page'}
        data-testid="catalog-detail-body"
        role={embedded ? 'region' : undefined}
        aria-label={embedded ? '商品详情内容' : undefined}
        tabIndex={embedded ? 0 : undefined}
      >
        {notices}
        {leavePromptNode}
        {/* V4-03：概览只在商品资料首屏出现；库存/历史分区优先露出该分区实际业务内容。 */}
        {!historical && section === 'material' && overview}
        {section === 'material' && materialPanel}
        {section === 'inventory' && inventoryPanel}
        {section === 'history' && historyPanel}
      </div>
    </div>
  );
}

/** 库存明细：BigSeller（海外）逐仓 × 来源编码；数量原值、同仓多编码逐行、合计未定不擅自相加。 */
function BsSampleBusinessBlock({
  sample,
  sampleError,
  warehouse,
  onRetry,
  onOpenEvidence,
  onShowAllWarehouses,
}: {
  sample: BsSampleDetail | null;
  sampleError: { code: string; message: string } | null;
  warehouse?: string;
  onRetry?: () => void;
  onOpenEvidence?: () => void;
  onShowAllWarehouses?: () => void;
}) {
  if (sampleError) {
    return (
      <section className={styles.statusLine} role="alert" data-testid="catalog-bs-sample-error">
        <span>
          <strong>BigSeller 库存读取失败：</strong>
          {sampleError.message}
          <span className={styles.overviewHint}>
            {sampleError.code === 'forbidden' ? '权限不足，不是「库存为 0」，也不回退旧样表。' : '请重试；失败期间不以 0 或旧仓数据代替，也不回退旧样表。'}
          </span>
        </span>
        {onRetry
          ? <Button type="button" variant="outline" onClick={onRetry}>重试</Button>
          : <DetailRetryButton label="重试库存读取" />}
      </section>
    );
  }
  if (!sample) return null;
  if (sample.status === 'not_available') {
    return <p className={styles.sectionNote} data-testid="catalog-bs-sample-not-imported">库存模块当前未接入：{sample.message}；不当作 0。</p>;
  }
  if (sample.status !== 'loaded') return null;
  const sourceLabel = sample.sourceLabel ?? 'BigSeller 自动导出';
  const observationText = sample.observationAt
    ? new Date(sample.observationAt).toLocaleString('zh-CN', { hour12: false })
    : '未读取到';
  const valuation = sample.valuation;
  const rows = sample.rows;
  const filtered = warehouse ? rows.filter((row) => row.warehouse === warehouse) : rows;
  const hasRows = filtered.length > 0;
  const pendingGroups = sample.totals.pendingTotalWarehouses.filter((group) => !warehouse || group.name === warehouse);
  const pendingTotal = pendingGroups.length > 0 || Boolean(valuation.pendingTotal);
  const knownTotalText = pendingTotal
    ? '合计待核对（逐行显示，未相加）'
    : valuation.confirmedOnHandTotal === '0'
      ? '0 个（来源明确为 0）'
      : valuation.confirmedOnHandTotal !== null
        ? `${valuation.confirmedOnHandTotal} 个${valuation.knownSubtotalComplete ? '' : '（不完整）'}`
        : (valuation.valuationReason ?? '库存不可确认');
  const scopedWarehouses = warehouse
    ? sample.warehouses.filter((entry) => entry.name === warehouse)
    : sample.warehouses;
  const pendingSources = scopedWarehouses.flatMap((entry) =>
    entry.pendingSourceRows.filter((row) => !row.mapped).map((row) => ({ ...row, warehouseName: entry.name })));
  const scopeReason = (() => {
    if (!warehouse) {
      if (sample.totals.hasCurrentData) return null;
      return '当前范围暂无已采用的 BigSeller 库存行；不当作库存 0，也不回退旧样表。';
    }
    const entry = scopedWarehouses[0];
    if (!entry) return '该仓库不在本次参与范围。';
    if (entry.status === 'failed') {
      return `本仓最近一次同步失败${entry.lastErrorCode ? `（${entry.lastErrorCode}）` : ''}；当前值保留上次成功时间${entry.lastSuccessAt ? ` ${new Date(entry.lastSuccessAt).toLocaleString('zh-CN', { hour12: false })}` : '（暂无成功批次）'}，不用 0 代替。`;
    }
    if (entry.status === 'unseen') return '本仓对应已确认，但当前完整批次还没有该商品的采用行；等待下一次完整同步，不是 0。';
    if (entry.status === 'not_mapped' && entry.reason === 'unmapped_source') return '本仓有该商品的已知来源行，但尚未确认对应；未计入合计，不是 0。';
    if (entry.status === 'not_mapped' && entry.reason === 'no_source') return '本仓没有该商品的来源记录；不当作库存 0。';
    /* 正常有已采用行（含多码待合计/同仓待核）不显示“暂无采用”空态；待合计与待核由各自区块说明。 */
    if (entry.status === 'current' && entry.rows.length > 0) return null;
    return '本仓暂无已采用的 BigSeller 库存行；不当作库存 0，也不回退旧样表。';
  })();
  const coverage = sample.totals.coverage;
  const coverageText = coverage
    ? `${coverage.coveredWarehouses} / ${coverage.scopeWarehouses} 仓有当前库存`
    : '覆盖未读取（不是 0/0）';
  return (
    <section className={styles.sectionBody} aria-label="BigSeller库存" data-testid="catalog-bs-sample-panel" data-warehouse-scope={warehouse ?? 'all'}>
      <div className={styles.sectionHead} style={{ marginBottom: 0 }}>
        <div>
          <h3 className={styles.sectionTitle}>BigSeller 库存（海外）</h3>
          <p className={styles.sectionNote}>
            {sourceLabel} · 最近来源：{observationText}
          </p>
        </div>
        <p className={styles.sectionNote}>
          当前仓库：<strong>{warehouse ?? '全部仓库'}</strong>
          {warehouse && onShowAllWarehouses && (
            <>
              {' · '}
              <button type="button" className={demoStyles.textLink} onClick={onShowAllWarehouses}>查看全部仓库</button>
            </>
          )}
        </p>
      </div>
      {scopeReason && (
        <p className={styles.sectionNote} data-testid="catalog-inventory-empty-reason">{scopeReason}</p>
      )}
      {hasRows && (
        <div className={demoStyles.tableScroll}>
          <table className={demoStyles.table} data-testid="catalog-bs-sample-inventory-table">
            <thead><tr>
              <th>仓库</th><th>来源编码</th><th>单位</th><th>现有</th><th>订单已锁</th><th>整仓可用</th><th>活动预留</th><th>在途</th><th>来源时间</th><th>状态</th>
            </tr></thead>
            <tbody>{filtered.map((r) => (
              <tr key={`${r.warehouseExternalId}-${r.externalSku}`} data-testid={`bs-row-${r.warehouse}-${r.externalSku}`}>
                <td>{r.warehouse}</td><td>{r.externalSku}</td><td>{r.unit ?? '—'}</td><td data-testid="bs-on-hand">{qtyCell(r.onHand)}</td>
                <td data-testid="bs-order-locked">{qtyCell(r.orderLocked)}</td>
                <td data-testid="bs-warehouse-available">{qtyCell(r.warehouseAvailable)}</td>
                <td data-testid="bs-activity-reserved">{qtyCell(r.activityReserved)}</td>
                <td data-testid="bs-in-transit">{qtyCell(r.inTransit)}</td>
                <td>{r.observedAt ? new Date(r.observedAt).toLocaleString('zh-CN', { hour12: false }) : '—'}</td>
                <td>已采用</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {pendingTotal && (
        <p className={styles.sectionNote} data-testid="catalog-inventory-pending-total">
          合计待核对：{pendingGroups.map((group) => `${group.name}${group.unit ? `（${group.unit}）` : ''}：${group.rows.map((line) => `${line.externalSku}=${line.onHand ?? '未知'}`).join('、')}`).join('；')}
          {pendingGroups.length === 0 ? '同仓多个来源编码，逐行显示，未确认合计口径前不擅自相加。' : ' —— 逐行显示；未确认合计口径前不擅自相加，也不选一条充当完整库存。'}
        </p>
      )}
      {pendingSources.length > 0 && (
        <div data-testid="catalog-pending-sources">
          <p className={styles.sectionNote}>
            同仓待确认来源 {pendingSources.length} 行：未确认对应、未计入合计；来源数量 0 表示“来源为 0、待确认归属”，不是没有来源，也不自动绑定。
          </p>
          <div className={demoStyles.tableScroll}>
            <table className={demoStyles.table} data-testid="catalog-pending-sources-table">
              <thead><tr><th>仓库</th><th>来源编码</th><th>来源数量</th><th>原表行</th><th>状态</th></tr></thead>
              <tbody>{pendingSources.map((row) => (
                <tr key={`${row.warehouseName}-${row.externalSku}-${row.excelRow ?? ''}`} data-testid="catalog-pending-source-row">
                  <td>{row.warehouseName}</td>
                  <td data-testid="catalog-pending-source-sku">{row.externalSku}</td>
                  <td data-testid="catalog-pending-source-qty">{qtyCell(row.onHand === null ? null : String(row.onHand))}</td>
                  <td data-testid="catalog-pending-source-row-number">{row.excelRow ?? '—'}</td>
                  <td>待确认归属 · 未计入合计</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      )}
      <dl className={styles.facts}>
        <div>
          <dt>已采用来源行</dt>
          <dd>{filtered.length} 行</dd>
        </div>
        <div>
          <dt>本范围已知库存</dt>
          <dd data-testid="bs-known-total">{knownTotalText}</dd>
        </div>
        <div>
          <dt>当前货值</dt>
          <dd>暂未计算（本包不新做估值：旧样表价格不能乘新库存冒充当前货值）</dd>
        </div>
        <div>
          <dt>覆盖</dt>
          <dd data-testid="catalog-inventory-coverage">{coverageText}</dd>
        </div>
      </dl>
      <p className={styles.sectionNote} data-testid="catalog-inventory-transit-note">
        数量按单个商品计数、原值保存，不乘除装箱数；同仓多编码逐行保留（0 库存也显示）；在途为来源观测值，不是业务在途；旧来源证据不用于判断当前来源。
      </p>
      {onOpenEvidence && (
        <p className={styles.sectionNote} data-testid="catalog-inventory-source-link">
          旧来源证据仅作历史记录，不用于判断当前库存。
          {' '}
          <button type="button" className={demoStyles.textLink} onClick={() => onOpenEvidence()}>查看数据来源</button>
        </p>
      )}
      {sample.warnings.length > 0 && (
        <ul className={styles.sectionNote} data-testid="catalog-inventory-warnings">
          {sample.warnings.map((warning) => <li key={warning}>{warning}</li>)}
        </ul>
      )}
    </section>
  );
}
