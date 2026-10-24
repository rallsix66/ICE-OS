/**
 * 变更记录的展示投影（V3-01.3，纯函数，无数据库/无环境变量）。
 *
 * 原则：
 * - 原始审计事实（actor UUID、证据引用、内部英文 reason、原始 ISO 时间）留在服务端；
 *   日常投影只输出中文业务理由、可核实的显示名或 null、确定性本地时间、字段级差异与“有无证据”布尔。
 * - 不编造操作者或修改内容：显示名只在服务端能由真实用户表核实后传入；核实不了就是 null。
 * - 不把内部英文 key 原样透出；已知基线理由只在证据支持时映射为“初始资料承接（系统批量）”。
 */
import type {
  CatalogItemDto,
  CatalogRevisionChange,
  CatalogRevisionDisplay,
  CatalogRevisionHistoryDto,
  CatalogItemRevisionDto,
  FieldObservation,
} from './types';
import { CATALOG_FIELD_LABELS, fieldBusinessValue } from './local-display/field-labels';

/** 冻结基线发布时写入的固定理由（db/catalog/002_catalog_security.sql）。 */
export const BASELINE_INITIAL_REASON = 'accepted frozen baseline';
/** 内部英文理由的中性中文替代表达；不在日常记录里指路技术证据。 */
export const GENERIC_REVISION_REASON_LABEL = '资料修订';
/** 仅在基线首版且证据存在时使用。 */
export const BASELINE_INITIAL_REASON_LABEL = '初始资料承接（系统批量）';
/** 未知字段键的中性标签：不把内部字段名透出到日常投影。 */
export const OTHER_FIELD_LABEL = '其他资料字段';

const CJK_PATTERN = /[\u3400-\u9fff\uf900-\ufaff]/;
/** 人为填写的中文理由会出现在这里；只接受含中日韩字符的非空文本。 */
function isHumanChineseReason(reason: string): boolean {
  return CJK_PATTERN.test(reason);
}

const SHANGHAI_TIME_ZONE = 'Asia/Shanghai';
const shanghaiFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: SHANGHAI_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/**
 * 确定性本地时间：Asia/Shanghai 'YYYY-MM-DD HH:mm'。
 * 逐段拼接 formatToParts，避免系统 locale/时区差异改变输出；无效时间返回空串（不编造）。
 */
export function formatRecordedAtDisplay(iso: string): string {
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return '';
  const parts = shanghaiFormatter.formatToParts(new Date(timestamp));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  const year = value('year');
  const month = value('month');
  const day = value('day');
  const hour = value('hour');
  const minute = value('minute');
  if (!year || !month || !day || !hour || !minute) return '';
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

export interface RevisionReasonInput {
  /** 原始 reason（可能为内部英文 key 或人为填写的中文）。 */
  reason: string;
  revision: number;
  /** 商品是否来自已发布冻结基线（first_release_id 非空）。 */
  baselineOrigin: boolean;
  /** 是否存在原始证据（evidenceRef 非空）。 */
  hasEvidence: boolean;
}

/**
 * 理由标签：
 * - 人为填写的中文理由 → 原样透传；
 * - 基线发布理由且 revision=1、基线来源、证据存在 → “初始资料承接（系统批量）”；
 * - 其余内部英文 key / 空理由 → “资料修订（依据见原始证据）”。
 */
export function revisionReasonLabel(input: RevisionReasonInput): string {
  const reason = input.reason.trim();
  if (reason && isHumanChineseReason(reason)) return reason;
  if (reason === BASELINE_INITIAL_REASON && input.revision === 1 && input.baselineOrigin && input.hasEvidence) {
    return BASELINE_INITIAL_REASON_LABEL;
  }
  return GENERIC_REVISION_REASON_LABEL;
}

function fieldLabel(key: string): string {
  return CATALOG_FIELD_LABELS[key] ?? OTHER_FIELD_LABEL;
}

function fieldToken(field: FieldObservation | undefined): string {
  if (!field) return 'absent';
  if (field.state !== 'observed') return `${field.state}|`;
  return `observed|${field.meaning}|${field.raw ?? ''}`;
}

function fieldDisplay(field: FieldObservation | undefined): string {
  return fieldBusinessValue(field);
}

/**
 * 与上一版本比较字段级差异：
 * 只比较业务可见值（fieldBusinessValue），没有真实差异不产出条目；首版没有上一版本 → 空数组。
 */
export function buildChangedFields(previous: CatalogItemDto | null, current: CatalogItemDto): CatalogRevisionChange[] {
  if (!previous) return [];
  const changes: CatalogRevisionChange[] = [];
  const keys = new Set([...Object.keys(previous.fields), ...Object.keys(current.fields)]);
  for (const key of [...keys].sort()) {
    const before = previous.fields[key];
    const after = current.fields[key];
    if (fieldToken(before) === fieldToken(after)) continue;
    const beforeText = fieldDisplay(before);
    const afterText = fieldDisplay(after);
    if (beforeText === afterText) continue;
    changes.push({ key, label: fieldLabel(key), before: beforeText, after: afterText });
  }
  if (previous.nameCn !== current.nameCn && !keys.has('nameCn')) {
    changes.push({ key: 'nameCn', label: fieldLabel('nameCn'), before: previous.nameCn, after: current.nameCn });
  }
  if (previous.iceCode !== current.iceCode) {
    changes.push({ key: 'iceCode', label: 'ICE 货号', before: previous.iceCode ?? '未分配', after: current.iceCode ?? '未分配' });
  }
  return changes;
}

export interface RevisionDisplayInput {
  rows: CatalogItemRevisionDto[];
  /** item_current.revision；缺失时调用方退回最近一次 revision（仍由服务端事实判定）。 */
  currentRevision: number;
  originKind: 'baseline' | 'new_item' | null;
  /** actorId → 可核实显示名；未命中或 null 时不显示操作者。 */
  actorLabels: Map<string, string>;
}

/** 由服务端原始历史行生成日常投影行（顺序与输入一致：revision 降序）。 */
export function buildRevisionHistoryDisplay(input: RevisionDisplayInput): CatalogRevisionHistoryDto[] {
  const byRevision = new Map(input.rows.map((row) => [row.revision, row]));
  const baselineOrigin = input.originKind === 'baseline';
  return input.rows.map((row) => {
    const previous = byRevision.get(row.revision - 1) ?? null;
    const hasEvidence = row.revisionAudit.evidenceRef.trim().length > 0;
    const actorLabel = input.actorLabels.get(row.revisionAudit.actorId) ?? null;
    const display: CatalogRevisionDisplay = {
      isCurrent: row.revision === input.currentRevision,
      kind: row.revision === 1 ? 'initial' : 'revision',
      reasonLabel: revisionReasonLabel({ reason: row.revisionAudit.reason, revision: row.revision, baselineOrigin, hasEvidence }),
      actorLabel: actorLabel && actorLabel.trim() ? actorLabel.trim() : null,
      recordedAtDisplay: formatRecordedAtDisplay(row.revisionAudit.recordedAt),
      changedFields: buildChangedFields(previous, row),
      hasEvidence,
    };
    return {
      revision: row.revision,
      iceCode: row.iceCode,
      nameCn: row.nameCn,
      newProductConfirmed: row.newProductConfirmed,
      display,
    };
  });
}
