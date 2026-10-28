/**
 * Three-way field diff (`local` = current catalog value, `base` = last adopted
 * source value, `source` = this snapshot) with the Lead decisions of
 * 2026-10-25 baked in.
 *
 * Rules implemented here (single source of truth for plan.ts):
 *
 * 1. Source cell not observed (blank / not read / parse failed): NEVER overwrite
 *    local; keep the existing adoption; outcome `kept_blank`; no revision.
 *    (Formula / invalid-value issues are collected at the item level.)
 * 2. First round (no adoption row):
 *    - local empty → adopt source, change kind `initial_baseline`;
 *    - local non-empty & ≈ source (tolerance) → adoption only, no revision;
 *    - local non-empty & different → KEEP local, write adoption=source,
 *      issue `initial_baseline_diff` (needs_review), other fields still processed.
 * 3. Later rounds:
 *    - source ≈ base → no change (keep local unilateral modification);
 *    - local ≈ base or local empty → adopt source, change kind `update`;
 *    - local ≈ source (but ≠ base) → adoption=source, no revision (converged);
 *    - otherwise → KEEP local, adoption unchanged, issue `field_conflict`.
 * 4. Unconfirmed-unit fields (cartonLength/Width/Height/Weight, cartonVolume,
 *    unitVolume — whatever `FIELD_UNITS[key].state === 'unconfirmed'`): the
 *    source value is NEVER adopted or written (adopt=false, write=false).
 *    - source raw empty → no-op (no issue, no adoption);
 *    - local == source → `unit_unconfirmed_equal`: no-op, no issue, no adoption;
 *    - local empty OR different (non-empty source) → `unit_unconfirmed`: keep
 *      local (empty stays empty), no adoption, issue `unit_unconfirmed` with the
 *      source raw retained. No conversion is ever performed.
 * 5. Blocking field group `cartonDimensions`: any conflict / unconfirmed-unit /
 *    first-round difference inside the group → the WHOLE group keeps local and
 *    adoption of group members that would update is blocked; fields outside the
 *    group are processed normally; issue `group_field_conflict`.
 * 6. Equality is tolerance-based for numeric adoptable fields (`|a-b| <= 1e-9`
 *    or relative `<= 1e-5`); cartonQuantity is strict; text is trim-exact.
 *    When different, the source raw text is adopted as-is (never converted).
 */
import type { FieldObservation } from '../types';
import {
  ADOPTABLE_FIELD_KEYS,
  CONFLICT_BLOCKING_FIELD_GROUPS,
  FIELD_GROUPS,
  FIELD_UNITS,
  FIELD_CONFLICT,
  FIELD_GROUP_CONFLICT,
  INITIAL_BASELINE_DIFF,
  INITIAL_SOURCE_BASELINE,
  SAME_VALUE_NO_REVISION,
  SOURCE_FIELD_UPDATE,
  SOURCE_UNCHANGED,
  UNIT_UNCONFIRMED,
  type AdoptableFieldKey,
  type FieldGroupKey,
  type PlanAdoptionRow,
  type ProductSourceFieldKey,
  type ProductSourceReasonCode,
  type SourceCell,
} from './contract';
import { areSameFieldValue, localRawOf, normalizeCellText } from './normalize';

export type FieldDiffOutcome =
  | 'kept_blank'
  | 'initial_adopt'
  | 'initial_baseline_equal'
  | 'initial_baseline_diff'
  | 'unchanged_base'
  | 'update'
  | 'converged'
  | 'conflict'
  | 'unit_unconfirmed'
  | 'unit_unconfirmed_equal'
  | 'group_blocked';

export type FieldIssueKind = 'field_conflict' | 'initial_baseline_diff' | 'unit_unconfirmed';

export interface FieldDiff {
  fieldKey: AdoptableFieldKey;
  outcome: FieldDiffOutcome;
  source: SourceCell;
  localRaw: string | null;
  baseRaw: string | null;
  /** Source raw text written when `write` is true; null otherwise. */
  afterRaw: string | null;
  /** Whether an adoption (adopted_raw = source) is written for this field. */
  adopt: boolean;
  /** Whether an item revision change is produced for this field. */
  write: boolean;
  issue: FieldIssueKind | null;
  reasonCode: ProductSourceReasonCode | null;
  note: string | null;
}

export interface FieldDiffInput {
  fieldKey: AdoptableFieldKey;
  source: SourceCell;
  local: FieldObservation | undefined;
  /** Adoption row of this item+field, when one exists. */
  base: PlanAdoptionRow | undefined;
}

const UNIT_UNCONFIRMED_FIELD_KEYS: ReadonlySet<ProductSourceFieldKey> = new Set(
  (Object.keys(FIELD_UNITS) as ProductSourceFieldKey[]).filter((key) => FIELD_UNITS[key].state === 'unconfirmed'),
);

export function isUnitUnconfirmedField(fieldKey: ProductSourceFieldKey): boolean {
  return UNIT_UNCONFIRMED_FIELD_KEYS.has(fieldKey);
}

function sourceObservedRaw(source: SourceCell): string {
  return normalizeCellText(source.raw);
}

export function diffField(input: FieldDiffInput): FieldDiff {
  const { fieldKey, source } = input;
  const localRaw = localRawOf(input.local);
  const hasBase = input.base !== undefined;
  const baseRaw =
    hasBase && input.base?.adoptedState === 'observed' && input.base.adoptedRaw !== null
      ? normalizeCellText(input.base.adoptedRaw) || null
      : null;

  const baseResult = {
    fieldKey,
    source,
    localRaw,
    baseRaw,
    afterRaw: null,
    adopt: false,
    write: false,
    issue: null,
    reasonCode: null,
    note: null,
  } satisfies Omit<FieldDiff, 'outcome'>;

  if (source.state !== 'observed') {
    const reasonCode =
      source.reason === 'SOURCE_FORMULA_ERROR'
        ? 'SOURCE_FORMULA_ERROR'
        : source.reason === 'INVALID_CARTON_QUANTITY'
          ? 'INVALID_CARTON_QUANTITY'
          : source.reason === 'SOURCE_VALUE_NOT_NUMERIC'
            ? 'SOURCE_VALUE_NOT_NUMERIC'
            : null;
    return {
      ...baseResult,
      outcome: 'kept_blank',
      reasonCode,
      note:
        source.state === 'parse_failed'
          ? '来源字段解析失败，未采用并保留本地值'
          : '来源单元格为空或未读取，未采用并保留本地值',
    };
  }

  const sourceRaw = sourceObservedRaw(source);

  // Rule 4: unconfirmed-unit fields are NEVER adopted or written from the source
  // (adopt=false / write=false in every branch).
  // - source raw empty → no-op (no value to review);
  // - local == source → no-op, no issue, no adoption;
  // - local empty OR different (with non-empty source) → keep local, issue
  //   unit_unconfirmed; the source raw is retained in the issue detail.
  if (isUnitUnconfirmedField(fieldKey)) {
    if (sourceRaw === '' || (localRaw !== null && areSameFieldValue(fieldKey, localRaw, sourceRaw))) {
      return {
        ...baseResult,
        outcome: 'unit_unconfirmed_equal',
        adopt: false,
        write: false,
        reasonCode: SAME_VALUE_NO_REVISION,
        note: '来源字段单位未确认，不采用来源值；无写入、无待核对',
      };
    }
    return {
      ...baseResult,
      outcome: 'unit_unconfirmed',
      adopt: false,
      write: false,
      afterRaw: null,
      issue: 'unit_unconfirmed',
      reasonCode: UNIT_UNCONFIRMED,
      note:
        localRaw === null
          ? '来源字段单位未确认，本地为空也不采用来源值，待人工核对'
          : '来源字段单位未确认，保留本地值，不换算',
    };
  }

  // Rule 2: first round baseline takeover.
  if (!hasBase) {
    if (localRaw === null) {
      return {
        ...baseResult,
        outcome: 'initial_adopt',
        adopt: true,
        write: true,
        afterRaw: sourceRaw,
        reasonCode: INITIAL_SOURCE_BASELINE,
        note: '首轮来源基线，采用来源值',
      };
    }
    if (areSameFieldValue(fieldKey, localRaw, sourceRaw)) {
      return {
        ...baseResult,
        outcome: 'initial_baseline_equal',
        adopt: true,
        reasonCode: INITIAL_SOURCE_BASELINE,
        note: '首轮来源基线与本地一致，仅记录基线',
      };
    }
    return {
      ...baseResult,
      outcome: 'initial_baseline_diff',
      adopt: true,
      issue: 'initial_baseline_diff',
      reasonCode: INITIAL_BASELINE_DIFF,
      note: '首轮来源基线与本地不同，保留本地值并记录来源基线',
    };
  }

  // Rule 3: later rounds.
  const sourceEqualsBase = baseRaw !== null && areSameFieldValue(fieldKey, sourceRaw, baseRaw);
  if (sourceEqualsBase) {
    const localDiverged = localRaw !== null && !areSameFieldValue(fieldKey, localRaw, baseRaw);
    return {
      ...baseResult,
      outcome: 'unchanged_base',
      reasonCode: SOURCE_UNCHANGED,
      note: localDiverged ? '来源与基线一致，保留本地单方修改' : null,
    };
  }
  if (localRaw === null || (baseRaw !== null && areSameFieldValue(fieldKey, localRaw, baseRaw))) {
    return {
      ...baseResult,
      outcome: 'update',
      adopt: true,
      write: true,
      afterRaw: sourceRaw,
      reasonCode: SOURCE_FIELD_UPDATE,
      note: localRaw === null ? '本地无值或显式空，采用来源值' : '本地与基线一致，采用来源更新',
    };
  }
  if (areSameFieldValue(fieldKey, localRaw, sourceRaw)) {
    return {
      ...baseResult,
      outcome: 'converged',
      adopt: true,
      reasonCode: SAME_VALUE_NO_REVISION,
      note: '本地与来源已相同，仅更新采用基线',
    };
  }
  return {
    ...baseResult,
    outcome: 'conflict',
    issue: 'field_conflict',
    reasonCode: FIELD_CONFLICT,
    note: '本地与来源同时修改，保留本地值',
  };
}

export interface ItemDiff {
  fields: FieldDiff[];
  conflictFields: AdoptableFieldKey[];
  /** Blocking groups (e.g. cartonDimensions) held as a unit. */
  blockedGroups: FieldGroupKey[];
  /** Fields that produce an item revision change. */
  writeFields: FieldDiff[];
  /** Fields whose adoption is written. */
  adoptedFields: FieldDiff[];
  issues: { kind: FieldIssueKind; fieldKey: AdoptableFieldKey }[];
  hasReview: boolean;
}

export function diffItem(input: {
  sourceFields: Record<string, SourceCell>;
  localFields: Record<string, FieldObservation>;
  /** Adoption rows for this item only. */
  adoptions: readonly PlanAdoptionRow[];
}): ItemDiff {
  const adoptionByField = new Map<ProductSourceFieldKey, PlanAdoptionRow>();
  for (const adoption of input.adoptions) adoptionByField.set(adoption.fieldKey, adoption);

  const fields: FieldDiff[] = [];
  for (const fieldKey of ADOPTABLE_FIELD_KEYS) {
    const source = input.sourceFields[fieldKey] ?? {
      raw: '',
      state: 'not_read' as const,
      reason: 'HEADER_COLUMN_NOT_MAPPED',
    };
    fields.push(
      diffField({
        fieldKey,
        source,
        local: input.localFields[fieldKey],
        base: adoptionByField.get(fieldKey),
      }),
    );
  }

  // Rule 5: blocking field groups.
  const blockedGroups: FieldGroupKey[] = [];
  const groupReviewOutcomes = new Set<FieldDiffOutcome>(['conflict', 'unit_unconfirmed', 'initial_baseline_diff']);
  for (const groupKey of CONFLICT_BLOCKING_FIELD_GROUPS) {
    const memberKeys = FIELD_GROUPS[groupKey] as readonly AdoptableFieldKey[];
    const members = fields.filter((field) => memberKeys.includes(field.fieldKey));
    if (!members.some((field) => groupReviewOutcomes.has(field.outcome))) continue;
    blockedGroups.push(groupKey);
    for (const member of members) {
      if (member.outcome === 'initial_adopt' || member.outcome === 'update') {
        member.outcome = 'group_blocked';
        member.adopt = false;
        member.write = false;
        member.afterRaw = null;
        member.issue = null;
        member.reasonCode = FIELD_GROUP_CONFLICT;
        member.note = '外箱尺寸字段组存在冲突，整组保留本地值';
      }
    }
  }

  const writeFields = fields.filter((field) => field.write);
  const adoptedFields = fields.filter((field) => field.adopt);
  const issues = fields
    .filter((field): field is FieldDiff & { issue: FieldIssueKind } => field.issue !== null)
    .map((field) => ({ kind: field.issue, fieldKey: field.fieldKey }));

  return {
    fields,
    conflictFields: fields.filter((field) => field.outcome === 'conflict').map((field) => field.fieldKey),
    blockedGroups,
    writeFields,
    adoptedFields,
    issues,
    hasReview: issues.length > 0 || blockedGroups.length > 0,
  };
}
