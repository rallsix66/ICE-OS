import 'server-only';

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { BASELINE_DIRECTORY, BASELINE_RELEASE_KEY } from '../../catalog/sources/baseline-adapter';
import { catalogSourceRoot, sha256 } from '../../catalog/evidence-store';
import type { InventoryDomesticRowDto, InventoryDomesticSnapshotDto } from '../types';

/**
 * 国内聚水潭冻结表格快照的只读适配（任务包 UI-04）。
 *
 * 权威输入：`src/features/catalog/sources/baseline-adapter.ts` 的 `BASELINE_DIRECTORY` 冻结目录下的
 * `coverage/source-records.json`（SHA256 固定，读取时校验，不覆盖、不重新找桌面 CSV）。
 * 该文件里聚水潭来源记录 887 条，`source.extra.actual_qty` 是原表「实际库存数」、
 * `source.available_qty` 是「可用数」，`source.extra.cloud_available_qty` 单独保留。
 * 文件日期只从原文件名（`商品资料_202610xx…xlsx`）得出；原表未注明仓库/账号/单位/精确观测时间。
 *
 * 本模块只做「冻结文件 → 展示行」的解析与规格化；数据库关联（商品 UUID / 核对状态）由
 * `server/domestic-reads.ts` 通过 023 只读函数取得后合并。两个视图共用同一份结果。
 */

/** 冻结 `coverage/source-records.json` 的 SHA256（合同 §UI-04）。 */
export const DOMESTIC_SOURCE_RECORDS_SHA256 = 'bcee12bcb555e73f50a3eabd504766ff3c401d2fb58e194ebb6c24441f6ba25d';
/** 只读证据标识：冻结发布 + 国内表格来源。 */
export const DOMESTIC_RELEASE_KEY = `${BASELINE_RELEASE_KEY}-domestic`;
/** 原表未注明仓库：固定文案，不伪造 BigSeller 国内仓。 */
export const DOMESTIC_WAREHOUSE_LABEL = '国内 · 原表未注明仓库';

const SOURCE_RECORDS_FILE = path.join('coverage', 'source-records.json');

export interface DomesticFrozenRecord {
  legacyCandidateId: string;
  /** 冻结文件里的 review_state，仅当数据库没有这条关联行时兜底使用。 */
  frozenReviewState: string;
  sourceSku: string;
  sourceName: string | null;
  sheet: string | null;
  excelRow: number | null;
  fileName: string;
  /** YYYY-MM-DD，仅从原文件名日期得出。 */
  fileDate: string;
  /** 该记录冻结来源 xlsx 的 SHA256（input-2/input-3.frozen.xlsx）。 */
  frozenFileSha256: string;
  rawActualText: string | null;
  rawAvailableText: string | null;
  cloudAvailableText: string | null;
  actualQty: number | null;
  availableQty: number | null;
  quantityState: InventoryDomesticRowDto['quantityState'];
}

/** 023 只读函数返回的关联行（数据库为准）。 */
export interface DomesticLinkRecord {
  legacyCandidateId: string;
  reviewState: string | null;
  sourceSku: string | null;
  sourceName: string | null;
  sheet: string | null;
  excelRow: number | null;
  itemId: string | null;
  iceCode: string | null;
  itemNameCn: string | null;
}

export interface DomesticFrozenSource {
  sourceRecordsSha256: string;
  records: DomesticFrozenRecord[];
}

export interface BuildDomesticSnapshotInput {
  records: DomesticFrozenRecord[];
  links: DomesticLinkRecord[];
  sourceRecordsSha256: string;
  /** true = 本进程复用已校验的冻结快照（不是实时刷新）。 */
  cached: boolean;
}

type QuantityParse = {
  qty: number | null;
  state: 'ok' | 'missing' | 'invalid';
  raw: string | null;
};

const INT_TEXT = /^[-+]?[0-9]+$/;
const INT_WITH_GROUPING = /^[-+]?[0-9]{1,3}(,[0-9]{3})+$/;
const DECIMAL_ZERO = /^[-+]?[0-9]+\.0+$/;
const SHA256_TEXT = /^[a-f0-9]{64}$/;

/**
 * 原表数量文本 → 整数或明确异常。只有能确定为整数时返回 number：
 * "3800" / "3,800" / "3800.0" → 整数；" " / null → missing；其余（小数、百分数、文本）→ invalid。
 * 不做四舍五入、不猜单位、不用可用数替代实际库存数。
 */
export function parseDomesticQuantity(value: unknown): QuantityParse {
  const raw = value === null || value === undefined
    ? null
    : typeof value === 'string'
      ? value
      : typeof value === 'number'
        ? String(value)
        : null;
  if (value === null || value === undefined) return { qty: null, state: 'missing', raw: null };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { qty: value, state: 'ok', raw } : { qty: null, state: 'invalid', raw };
  }
  if (typeof value !== 'string') return { qty: null, state: 'invalid', raw };
  const text = value.trim();
  if (text === '') return { qty: null, state: 'missing', raw };
  if (INT_TEXT.test(text)) return { qty: Number(text), state: 'ok', raw };
  if (INT_WITH_GROUPING.test(text)) return { qty: Number(text.replace(/,/g, '')), state: 'ok', raw };
  if (DECIMAL_ZERO.test(text)) return { qty: Number(text.replace(/\.[0]+$/, '')), state: 'ok', raw };
  return { qty: null, state: 'invalid', raw };
}

/** 文件名里的日期（商品资料_20261015165159_…xlsx → 2026-10-15）；拿不到合法日期返回 null。 */
export function fileDateFromOriginalName(fileName: string): string | null {
  const run = /[0-9]{8,}/.exec(fileName);
  if (!run) return null;
  const [yearText, monthText, dayText] = [run[0].slice(0, 4), run[0].slice(4, 6), run[0].slice(6, 8)];
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${yearText}-${monthText}-${dayText}`;
}

function objectOf(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`DOMESTIC_SOURCE_RECORD_INVALID:${label}:NOT_OBJECT`);
  }
  return value as Record<string, unknown>;
}

function stringOf(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`DOMESTIC_SOURCE_RECORD_INVALID:${label}:NOT_STRING`);
  return value;
}

function nullableStringOf(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error(`DOMESTIC_SOURCE_RECORD_INVALID:${label}:NOT_STRING_OR_NULL`);
  return value;
}

function nullableIntegerOf(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`DOMESTIC_SOURCE_RECORD_INVALID:${label}:NOT_INTEGER_OR_NULL`);
  }
  return value;
}

/**
 * 冻结 source-records.json → 聚水潭记录（入口校验一次，形状不符直接报错，不静默转 0）。
 * 只保留聚水潭记录；BigSeller 记录 530 条由既有库存读取路径负责，不在这里混合。
 */
export function parseDomesticSourceRecords(document: unknown): DomesticFrozenRecord[] {
  if (!Array.isArray(document)) throw new Error('DOMESTIC_SOURCE_DOCUMENT_INVALID');
  const records: DomesticFrozenRecord[] = [];
  const seen = new Set<string>();
  document.forEach((entry, index) => {
    const label = `#${index}`;
    const item = objectOf(entry, label);
    const source = objectOf(item.source, `${label}/source`);
    if (source.source_system !== 'jushuitan') return;
    const extra = objectOf(source.extra, `${label}/source/extra`);
    const provenance = objectOf(item.provenance, `${label}/provenance`);
    const origin = objectOf(provenance.effective_origin, `${label}/provenance/effective_origin`);
    const legacyCandidateId = stringOf(item.candidate_id, `${label}/candidate_id`);
    if (seen.has(legacyCandidateId)) throw new Error(`DOMESTIC_SOURCE_DUPLICATE_CANDIDATE:${legacyCandidateId}`);
    seen.add(legacyCandidateId);
    const fileName = stringOf(origin.original_file, `${label}/original_file`);
    const fileDate = fileDateFromOriginalName(fileName);
    if (!fileDate) throw new Error(`DOMESTIC_SOURCE_FILE_DATE_UNPARSED:${fileName}`);
    const frozenFileSha256 = stringOf(origin.sha256, `${label}/sha256`);
    if (!SHA256_TEXT.test(frozenFileSha256)) throw new Error(`DOMESTIC_SOURCE_FILE_SHA_INVALID:${label}`);
    const actual = parseDomesticQuantity(extra.actual_qty);
    const available = parseDomesticQuantity(source.available_qty);
    records.push({
      legacyCandidateId,
      frozenReviewState: nullableStringOf(item.review_state, `${label}/review_state`) ?? 'unknown',
      sourceSku: stringOf(source.external_sku_raw, `${label}/external_sku_raw`),
      sourceName: nullableStringOf(source.external_name, `${label}/external_name`),
      sheet: nullableStringOf(origin.sheet, `${label}/sheet`) ?? nullableStringOf(source.sheet_name, `${label}/sheet_name`),
      excelRow: nullableIntegerOf(origin.excel_row, `${label}/excel_row`),
      fileName,
      fileDate,
      frozenFileSha256,
      rawActualText: actual.raw,
      rawAvailableText: available.raw,
      cloudAvailableText: nullableStringOf(extra.cloud_available_qty, `${label}/cloud_available_qty`),
      actualQty: actual.qty,
      availableQty: available.qty,
      quantityState: actual.state,
    });
  });
  if (records.length === 0) throw new Error('DOMESTIC_SOURCE_EMPTY');
  return records;
}

/** 023 返回的关联数组 → 明确类型（数据库到服务端的信任边界，校验一次）。 */
export function normalizeDomesticLinks(raw: unknown): DomesticLinkRecord[] {
  if (!Array.isArray(raw)) throw new Error('DOMESTIC_LINKS_INVALID');
  return raw.map((entry, index) => {
    const label = `links#${index}`;
    const record = objectOf(entry, label);
    const legacyCandidateId = stringOf(record.legacyCandidateId, `${label}/legacyCandidateId`);
    const itemId = nullableStringOf(record.itemId, `${label}/itemId`);
    return {
      legacyCandidateId,
      reviewState: nullableStringOf(record.reviewState, `${label}/reviewState`),
      sourceSku: nullableStringOf(record.sourceSku, `${label}/sourceSku`),
      sourceName: nullableStringOf(record.sourceName, `${label}/sourceName`),
      sheet: nullableStringOf(record.sheet, `${label}/sheet`),
      excelRow: nullableIntegerOf(record.excelRow, `${label}/excelRow`),
      itemId,
      iceCode: itemId ? nullableStringOf(record.iceCode, `${label}/iceCode`) : null,
      itemNameCn: itemId ? nullableStringOf(record.itemNameCn, `${label}/itemNameCn`) : null,
    };
  });
}

function compareRows(left: InventoryDomesticRowDto, right: InventoryDomesticRowDto): number {
  const byDate = left.fileDate.localeCompare(right.fileDate);
  if (byDate !== 0) return byDate;
  const byFile = left.fileName.localeCompare(right.fileName);
  if (byFile !== 0) return byFile;
  if (left.excelRow !== right.excelRow) {
    if (left.excelRow === null) return 1;
    if (right.excelRow === null) return -1;
    return left.excelRow - right.excelRow;
  }
  return left.legacyCandidateId.localeCompare(right.legacyCandidateId);
}

function rowNote(reviewState: string, itemId: string | null): string | null {
  if (reviewState !== 'manual_selected') return '非冻结有效选择，不计入标准商品国内汇总';
  if (itemId === null) return '已核对选择但未关联到标准商品，未计入国内汇总';
  return null;
}

/**
 * 冻结记录 + 数据库关联 → 两个视图共用的国内快照 DTO。
 * 只把 `reviewState === 'manual_selected'` 且 `itemId` 非空的记录计为有效选择（UI 归集口径）；
 * 其余记录仍保留在 rows 里可查，状态如实。
 */
export function buildDomesticSnapshot(input: BuildDomesticSnapshotInput): InventoryDomesticSnapshotDto {
  const links = new Map<string, DomesticLinkRecord>();
  for (const link of input.links) links.set(link.legacyCandidateId, link);
  const rows = input.records.map((record): InventoryDomesticRowDto => {
    const link = links.get(record.legacyCandidateId) ?? null;
    const itemId = link?.itemId ?? null;
    const reviewState = link?.reviewState ?? record.frozenReviewState;
    return {
      source: 'domestic',
      legacyCandidateId: record.legacyCandidateId,
      itemId,
      iceCode: itemId ? (link?.iceCode ?? null) : null,
      itemNameCn: itemId ? (link?.itemNameCn ?? null) : null,
      externalSku: record.sourceSku,
      sourceName: record.sourceName,
      actualQty: record.actualQty,
      availableQty: record.availableQty,
      cloudAvailableText: record.cloudAvailableText,
      rawActualText: record.rawActualText,
      rawAvailableText: record.rawAvailableText,
      unit: null,
      warehouseLabel: DOMESTIC_WAREHOUSE_LABEL,
      sheet: record.sheet,
      excelRow: record.excelRow,
      fileDate: record.fileDate,
      fileName: record.fileName,
      frozenFileSha256: record.frozenFileSha256,
      reviewState,
      quantityState: record.quantityState,
      note: rowNote(reviewState, itemId),
    };
  });
  rows.sort(compareRows);
  const selected = rows.filter((row) => row.reviewState === 'manual_selected');
  const linkedSelected = selected.filter((row) => row.itemId !== null);
  const itemIds = new Set(rows.flatMap((row) => (row.itemId === null ? [] : [row.itemId])));
  const fileMap = new Map<string, { fileDate: string; fileName: string; frozenFileSha256: string; recordCount: number }>();
  for (const record of input.records) {
    const key = `${record.fileDate}|${record.fileName}|${record.frozenFileSha256}`;
    const entry = fileMap.get(key);
    if (entry) entry.recordCount += 1;
    else fileMap.set(key, {
      fileDate: record.fileDate,
      fileName: record.fileName,
      frozenFileSha256: record.frozenFileSha256,
      recordCount: 1,
    });
  }
  const fileDates = [...fileMap.values()].sort((left, right) => left.fileDate.localeCompare(right.fileDate)
    || left.fileName.localeCompare(right.fileName));
  return {
    available: true,
    reason: null,
    releaseKey: DOMESTIC_RELEASE_KEY,
    sourceRecordsSha256: input.sourceRecordsSha256,
    recordCount: rows.length,
    selectedCount: selected.length,
    linkedSelectedCount: linkedSelected.length,
    linkedItemCount: itemIds.size,
    unlinkedSelectedCount: selected.length - linkedSelected.length,
    fileDates,
    rows,
    cached: input.cached,
  };
}

/** 未读取/读取失败：明确不可用，不写 0、不伪造空成功。 */
export function unavailableDomesticSnapshot(reason: string): InventoryDomesticSnapshotDto {
  return {
    available: false,
    reason,
    releaseKey: DOMESTIC_RELEASE_KEY,
    sourceRecordsSha256: DOMESTIC_SOURCE_RECORDS_SHA256,
    recordCount: 0,
    selectedCount: 0,
    linkedSelectedCount: 0,
    linkedItemCount: 0,
    unlinkedSelectedCount: 0,
    fileDates: [],
    rows: [],
    cached: false,
  };
}

let memo: DomesticFrozenSource | null = null;
let loading: Promise<DomesticFrozenSource> | null = null;

/** true = 本进程已经校验并复用冻结快照。 */
export function isDomesticSourceCached(): boolean {
  return memo !== null;
}

async function readDomesticSource(): Promise<DomesticFrozenSource> {
  const root = catalogSourceRoot();
  const absolute = path.resolve(root, BASELINE_DIRECTORY, SOURCE_RECORDS_FILE);
  const relative = path.relative(root, absolute);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('DOMESTIC_SOURCE_PATH_DENIED');
  }
  const bytes = await fs.readFile(absolute);
  const digest = sha256(bytes);
  if (digest !== DOMESTIC_SOURCE_RECORDS_SHA256) throw new Error(`DOMESTIC_SOURCE_SHA256_MISMATCH:${digest}`);
  const document: unknown = JSON.parse(bytes.toString('utf8'));
  return { sourceRecordsSha256: digest, records: parseDomesticSourceRecords(document) };
}

/**
 * 读取并校验冻结快照（进程级 memo；SHA 固定的只读冻结文件，不是实时来源）。
 * 失败时抛错且不缓存失败结果，由读取入口转成 `available=false` + 中文原因。
 */
export async function loadDomesticSource(): Promise<DomesticFrozenSource> {
  if (memo) return memo;
  if (!loading) {
    loading = readDomesticSource()
      .then((source) => {
        memo = source;
        return source;
      })
      .finally(() => {
        loading = null;
      });
  }
  return loading;
}
