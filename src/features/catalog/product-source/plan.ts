/**
 * Apply-plan builder: turns one snapshot + current catalog state into the exact
 * `p_plan` JSON consumed by `catalog.apply_product_source_batch`, and the
 * `p_batch` JSON consumed alongside it.
 *
 * Decisions (Lead, 2026-10-25):
 * - `needs_review` has two forms: nextFields=null (whole item deferred) and
 *   nextFields!=null + expectedRevision (partial write of non-conflicting
 *   fields while the result stays needs_review and issues stay open).
 * - missing bound items: action='unchanged' + missing=true; never delete/unbind.
 * - restricted amount columns only ever appear in batch rows' `cells` / `amounts`
 *   (and the private DB table); plans, results, issues and changes never do.
 */
import type { FieldObservation } from '../types';
import {
  ADOPTABLE_FIELD_KEYS,
  FIELD_GROUPS,
  FIELD_UNITS,
  IMAGE_NOT_READ_BY_SNAPSHOT,
  PLAN_CONTRACT,
  PRODUCT_SOURCE_FIELD_KEYS,
  REASON_TEXT,
  codeSourceKey,
  type BatchArtifact,
  type BuildPlanInput,
  type FieldGroupKey,
  type IssueKind,
  type PlanAction,
  type PlanAdoptionRow,
  type PlanBoundItem,
  type PlanChangeKind,
  type PlanCounts,
  type PlanFieldAdoption,
  type PlanFieldChange,
  type PlanIssue,
  type ProductSourceBatchAmountRow,
  type ProductSourceBatchPayload,
  type ProductSourceBatchRow,
  type ProductSourcePlan,
  type ProductSourcePlanPayload,
  type ProductSourcePlanResult,
  type ProductSourceReasonCode,
  type RestrictedAmountKey,
  type SnapshotIssue,
  type SnapshotIssueCode,
  type SourceCell,
  type SourceRowEvaluation,
  type SourceSnapshot,
} from './contract';
import {
  detectSuspectedCodeChange,
  evaluateSourceRows,
  fieldIssueKind,
  fieldIssueReasonCode,
  matchUncodedItemByName,
  validateSnapshot,
  type SuspectedCodeCandidate,
} from './anomaly';
import { diffItem, isUnitUnconfirmedField, type FieldDiff, type ItemDiff } from './diff';
import { fieldObservationFromSource, localRawOf, normalizeCellText } from './normalize';
import { resolveHeaderMapping } from './headers';
import { computeRowsSha256 } from './reader';
import { sourceIceCode } from './grouping';

export const ZERO_COUNTS: PlanCounts = {
  created: 0,
  updated: 0,
  unchanged: 0,
  needsReview: 0,
  failed: 0,
  missing: 0,
};

interface ParsedFieldIssue {
  issue: PlanIssue;
  reasonCode: ProductSourceReasonCode;
}

function parseFailedIssues(evaluation: SourceRowEvaluation): ParsedFieldIssue[] {
  return evaluation.fieldIssues.map((note) => ({
    issue: {
      kind: fieldIssueKind(note.reason),
      detail: {
        rowNumber: note.rowNumber,
        fieldKey: note.fieldKey,
        reason: note.reason,
        raw: note.raw,
      },
    },
    reasonCode: fieldIssueReasonCode(note.reason),
  }));
}

function withLocalName(item: PlanBoundItem): Record<string, FieldObservation> {
  const fields: Record<string, FieldObservation> = { ...item.fields };
  if (!fields.nameCn) {
    fields.nameCn = {
      state: 'observed',
      raw: item.nameCn,
      meaning: 'value',
      evidenceRef: `catalog:item:${item.itemId}`,
    };
  }
  return fields;
}

function evidenceRefFor(snapshotKey: string, rowNumbers: readonly number[], fieldKey: string): string {
  return `source:${snapshotKey}#rows=${rowNumbers.join('+')}&field=${fieldKey}`;
}

function overlayFields(
  localFields: Record<string, FieldObservation>,
  writeFields: readonly FieldDiff[],
  snapshotKey: string,
  rowNumbers: readonly number[],
): Record<string, FieldObservation> {
  const next: Record<string, FieldObservation> = { ...localFields };
  for (const field of writeFields) {
    const observation = fieldObservationFromSource(
      field.source,
      evidenceRefFor(snapshotKey, rowNumbers, field.fieldKey),
    );
    if (observation) next[field.fieldKey] = observation;
  }
  return next;
}

function adoptionOf(field: FieldDiff): PlanFieldAdoption | null {
  if (field.source.state !== 'observed') return null;
  return {
    fieldKey: field.fieldKey,
    raw: normalizeCellText(field.source.raw),
    state: 'observed',
    unitState: FIELD_UNITS[field.fieldKey].state,
  };
}

function changeOf(field: FieldDiff): PlanFieldChange {
  const kind: PlanChangeKind =
    field.outcome === 'initial_adopt'
      ? 'initial_baseline'
      : isUnitUnconfirmedField(field.fieldKey)
        ? 'unit_unconfirmed'
        : 'update';
  return {
    fieldKey: field.fieldKey,
    beforeRaw: field.localRaw,
    afterRaw: normalizeCellText(field.source.raw),
    kind,
  };
}

function itemDiffIssues(itemDiff: ItemDiff, evaluation: SourceRowEvaluation): PlanIssue[] {
  const issues: PlanIssue[] = [];
  for (const field of itemDiff.fields) {
    if (field.issue === null) continue;
    const kind: IssueKind = field.issue;
    issues.push({
      kind,
      detail: {
        fieldKey: field.fieldKey,
        beforeRaw: field.localRaw,
        baseRaw: field.baseRaw,
        sourceRaw: normalizeCellText(field.source.raw),
        rows: evaluation.rowNumbers,
      },
    });
  }
  for (const groupKey of itemDiff.blockedGroups) {
    issues.push({
      kind: 'group_field_conflict',
      detail: {
        group: groupKey,
        fields: [...FIELD_GROUPS[groupKey as FieldGroupKey]],
        rows: evaluation.rowNumbers,
      },
    });
  }
  return issues;
}

function reviewReasonCode(itemDiff: ItemDiff, parsedIssues: readonly ParsedFieldIssue[]): ProductSourceReasonCode {
  if (itemDiff.blockedGroups.length > 0) return 'FIELD_GROUP_CONFLICT';
  if (itemDiff.fields.some((field) => field.issue === 'field_conflict')) return 'FIELD_CONFLICT';
  if (itemDiff.fields.some((field) => field.issue === 'unit_unconfirmed')) return 'UNIT_UNCONFIRMED';
  if (itemDiff.fields.some((field) => field.issue === 'initial_baseline_diff')) return 'INITIAL_BASELINE_DIFF';
  const parsed = parsedIssues[0];
  if (parsed) return parsed.reasonCode;
  return 'FIELD_CONFLICT';
}

type ResultSeed = Omit<ProductSourcePlanResult, 'reasonText'>;

function resultOf(seed: ResultSeed): ProductSourcePlanResult {
  return { ...seed, reasonText: REASON_TEXT[seed.reasonCode] };
}

function baseResult(
  sourceKey: string,
  action: PlanAction,
  reasonCode: ProductSourceReasonCode,
  overrides: Partial<ResultSeed> = {},
): ProductSourcePlanResult {
  return resultOf({
    sourceKey,
    iceCode: null,
    itemId: null,
    action,
    reasonCode,
    rowNumbers: [],
    expectedRevision: null,
    changes: [],
    adoptions: [],
    nextFields: null,
    nameCn: null,
    createCode: null,
    issues: [],
    missing: false,
    ...overrides,
  });
}

function buildCreateFields(
  logicalFields: Record<string, SourceCell>,
  snapshotKey: string,
  rowNumbers: readonly number[],
): Record<string, FieldObservation> {
  const fields: Record<string, FieldObservation> = {};
  for (const fieldKey of PRODUCT_SOURCE_FIELD_KEYS) {
    if (fieldKey === 'iceCode' || fieldKey === 'sourceDate') continue;
    // Unconfirmed-unit fields are never written, not even for a brand-new item.
    if (isUnitUnconfirmedField(fieldKey)) continue;
    const evidenceRef = evidenceRefFor(snapshotKey, rowNumbers, fieldKey);
    if (fieldKey === 'imageRef') {
      fields.imageRef = {
        state: 'not_read',
        raw: null,
        reason: IMAGE_NOT_READ_BY_SNAPSHOT,
        evidenceRef,
      };
      continue;
    }
    const cell = logicalFields[fieldKey];
    if (!cell) continue;
    const observation = fieldObservationFromSource(cell, evidenceRef);
    if (observation) fields[fieldKey] = observation;
  }
  return fields;
}

function observedRaw(logicalFields: Record<string, SourceCell> | null, fieldKey: string): string | null {
  const cell = logicalFields?.[fieldKey];
  if (!cell || cell.state !== 'observed') return null;
  const value = normalizeCellText(cell.raw);
  return value === '' ? null : value;
}

function expectedRevisionOf(input: BuildPlanInput, item: PlanBoundItem): number {
  const configured = input.expectedRevisions?.[item.itemId];
  return typeof configured === 'number' ? configured : item.revision;
}

export function buildPlan(input: BuildPlanInput): ProductSourcePlan {
  const snapshot = input.snapshot;
  const planBase = {
    contract: PLAN_CONTRACT,
    profileKey: snapshot.profileKey,
    snapshotKey: snapshot.snapshotKey,
  } as const;

  const validation = validateSnapshot(snapshot);
  if (!validation.ok) {
    const result = rejectedBatchResult(validation.issues);
    return {
      ...planBase,
      decision: 'rejected_invalid',
      countsHint: { ...ZERO_COUNTS, failed: 1 },
      results: [result],
      seenItemIds: [],
      batchStatusHint: 'failed',
      issues: result.issues,
    };
  }

  // Retry-of-failed-items mode skips the replay decision: the snapshot may already
  // have a partial batch, but the failed source keys still need a fresh plan.
  const retryMode = input.retryFailedSourceKeys !== undefined;
  const replay = retryMode
    ? undefined
    : (input.appliedSnapshots ?? []).find(
        (candidate) =>
          candidate.snapshotKey === snapshot.snapshotKey &&
          (candidate.status === 'applied' || candidate.status === 'partial'),
      );
  if (replay) {
    return {
      ...planBase,
      decision: 'replay',
      countsHint: { ...ZERO_COUNTS },
      results: [],
      seenItemIds: [],
      batchStatusHint: 'applied',
      issues: [
        {
          kind: 'already_applied',
          detail: {
            snapshotKey: snapshot.snapshotKey,
            priorStatus: replay.status,
            priorCapturedAt: replay.capturedAt,
          },
        },
      ],
    };
  }

  const latestApplied = input.latestAppliedCapturedAt;
  if (
    latestApplied !== null &&
    latestApplied !== undefined &&
    Date.parse(snapshot.capturedAt) < Date.parse(latestApplied)
  ) {
    return {
      ...planBase,
      decision: 'rejected_stale',
      countsHint: { ...ZERO_COUNTS },
      results: [],
      seenItemIds: [],
      batchStatusHint: 'failed',
      issues: [
        {
          kind: 'stale_snapshot',
          detail: {
            snapshotKey: snapshot.snapshotKey,
            capturedAt: snapshot.capturedAt,
            latestAppliedCapturedAt: latestApplied,
          },
        },
      ],
    };
  }

  const evaluations = input.evaluations ?? evaluateSourceRows(snapshot);
  const itemById = new Map<string, PlanBoundItem>();
  for (const item of input.items) itemById.set(item.itemId, item);
  const itemByCode = new Map<string, PlanBoundItem>();
  for (const item of input.items) {
    if (item.iceCode !== null && item.iceCode !== '') itemByCode.set(item.iceCode, item);
  }
  const bindingByCode = new Map<string, string>();
  for (const binding of input.bindings) bindingByCode.set(binding.iceCode, binding.itemId);
  const adoptionsByItem = new Map<string, PlanAdoptionRow[]>();
  for (const adoption of input.adoptions) {
    const list = adoptionsByItem.get(adoption.itemId);
    if (list) list.push(adoption);
    else adoptionsByItem.set(adoption.itemId, [adoption]);
  }
  const uncodedItems = input.items
    .filter((item) => item.iceCode === null || item.iceCode === '')
    .map((item) => ({ itemId: item.itemId, nameCn: item.nameCn }));
  /**
   * Identity hints for brand-new coded rows: a source row whose exact name or
   * barcode already belongs to an existing item (coded or uncoded) must NOT be
   * auto-created — names and barcodes are hints only, never merge targets.
   */
  const identityCandidates = input.items.map((item) => ({
    itemId: item.itemId,
    iceCode: item.iceCode,
    nameCn: item.nameCn,
    barcode: localRawOf(item.fields.barcode),
  }));
  const suspectedCandidates: SuspectedCodeCandidate[] = input.items
    .filter((item): item is PlanBoundItem & { iceCode: string } => item.iceCode !== null && item.iceCode !== '')
    .map((item) => {
      const itemAdoptions = adoptionsByItem.get(item.itemId) ?? [];
      const adoptionFor = (fieldKey: string) => itemAdoptions.find((adoption) => adoption.fieldKey === fieldKey);
      return {
        itemId: item.itemId,
        iceCode: item.iceCode,
        nameCn: item.nameCn,
        barcode: localRawOf(item.fields.barcode),
        adoptionNameCn: adoptionFor('nameCn')?.adoptedRaw ?? null,
        adoptionBarcode: adoptionFor('barcode')?.adoptedRaw ?? null,
      };
    });

  const resolveBoundItem = (evaluation: SourceRowEvaluation): PlanBoundItem | null => {
    if (evaluation.iceCode === null) return null;
    const boundId = bindingByCode.get(evaluation.iceCode);
    if (boundId !== undefined) {
      const item = itemById.get(boundId);
      if (item) return item;
    }
    // Fallback: an item already carrying this source code is treated as bound
    // (prevents duplicate creation when a binding row is missing).
    return itemByCode.get(evaluation.iceCode) ?? null;
  };

  const results: ProductSourcePlanResult[] = [];
  const seenItemIds = new Set<string>();
  const seenCodes = new Set<string>();
  const failedBoundCodes = new Set<string>();

  for (const evaluation of evaluations) {
    const boundItem = resolveBoundItem(evaluation);
    if (evaluation.iceCode !== null && boundItem === null) {
      const parsed = parseFailedIssues(evaluation);
      // Unbound coded row: create / suspected-code-change / invalid new item.
      results.push(planUnboundCode(evaluation, suspectedCandidates, identityCandidates, snapshot.snapshotKey, parsed));
      continue;
    }

    if (boundItem !== null) {
      if (evaluation.iceCode !== null) {
        seenCodes.add(evaluation.iceCode);
        seenItemIds.add(boundItem.itemId);
      }
      if (evaluation.classification === 'inconsistent') {
        const parsed = parseFailedIssues(evaluation);
        results.push(
          baseResult(evaluation.sourceKey, 'needs_review', 'DUPLICATE_CODE_INCONSISTENT', {
            iceCode: evaluation.iceCode,
            itemId: boundItem.itemId,
            nameCn: boundItem.nameCn,
            rowNumbers: evaluation.rowNumbers,
            issues: [
              {
                kind: 'duplicate_code_inconsistent',
                detail: {
                  code: evaluation.iceCode,
                  rows: evaluation.rowNumbers,
                  fields: evaluation.conflicts.map((conflict) => ({
                    fieldKey: conflict.fieldKey,
                    values: conflict.values.map((value) => ({
                      rowNumber: value.rowNumber,
                      raw: value.raw,
                      state: value.state,
                    })),
                  })),
                },
              },
              ...parsed.map((entry) => entry.issue),
            ],
          }),
        );
        continue;
      }
      if (!evaluation.logicalFields) {
        results.push(
          baseResult(evaluation.sourceKey, 'failed', 'SNAPSHOT_INVALID', {
            iceCode: evaluation.iceCode,
            itemId: boundItem.itemId,
            rowNumbers: evaluation.rowNumbers,
            issues: [{ kind: 'snapshot_invalid', detail: { code: 'SNAPSHOT_ROW_INVALID', rows: evaluation.rowNumbers } }],
          }),
        );
        failedBoundCodes.add(evaluation.iceCode ?? '');
        continue;
      }
      const parsed = parseFailedIssues(evaluation);
      results.push(
        planBoundItem({
          item: boundItem,
          evaluation,
          adoptions: adoptionsByItem.get(boundItem.itemId) ?? [],
          parsedIssues: parsed,
          snapshotKey: snapshot.snapshotKey,
          expectedRevision: expectedRevisionOf(input, boundItem),
        }),
      );
      continue;
    }

    // Missing code row (no bound item possible).
    const parsed = parseFailedIssues(evaluation);
    results.push(planMissingCodeRow(evaluation, uncodedItems, parsed));
  }

  // Bound items not seen in this snapshot: mark only, never delete/unbind/zero.
  for (const binding of input.bindings) {
    if (seenCodes.has(binding.iceCode)) continue;
    if (failedBoundCodes.has(binding.iceCode)) continue;
    const item = itemById.get(binding.itemId);
    if (!item) {
      results.push(
        baseResult(codeSourceKey(binding.iceCode), 'failed', 'SNAPSHOT_INVALID', {
          iceCode: binding.iceCode,
          itemId: binding.itemId,
          issues: [
            {
              kind: 'snapshot_invalid',
              detail: { code: 'BOUND_ITEM_NOT_PROVIDED', itemId: binding.itemId, iceCode: binding.iceCode },
            },
          ],
        }),
      );
      continue;
    }
    results.push(
      baseResult(codeSourceKey(binding.iceCode), 'unchanged', 'SOURCE_ROW_MISSING', {
        iceCode: binding.iceCode,
        itemId: item.itemId,
        nameCn: item.nameCn,
        missing: true,
      }),
    );
  }

  // Retry mode: keep only the requested failed source keys, but `seenItemIds`
  // stays the COMPLETE seen set so the database does not mark successful items
  // as missing. An empty filter list yields 0 results (service decides not to
  // submit) while the decision remains 'apply'.
  const retryFilter = input.retryFailedSourceKeys;
  const finalResults =
    retryFilter === undefined
      ? results
      : results.filter((result) => retryFilter.includes(result.sourceKey));
  const countsHint = countResults(finalResults);
  return {
    ...planBase,
    decision: 'apply',
    countsHint,
    results: finalResults,
    seenItemIds: [...seenItemIds].sort(),
    batchStatusHint: batchStatusOf(countsHint),
    issues: [],
  };
}

interface IdentityCandidate {
  itemId: string;
  iceCode: string | null;
  nameCn: string;
  barcode: string | null;
}

/** Exact name or non-empty barcode equality only (never fuzzy merge). */
function findIdentityHint(
  nameCn: string | null,
  barcode: string | null,
  candidates: readonly IdentityCandidate[],
): { itemId: string; itemIceCode: string | null; matchedBy: 'nameCn' | 'barcode' } | null {
  const normalizedName = nameCn === null ? null : normalizeCellText(nameCn).toLowerCase();
  const normalizedBarcode = barcode === null ? null : normalizeCellText(barcode);
  for (const candidate of candidates) {
    const candidateBarcode = candidate.barcode === null ? null : normalizeCellText(candidate.barcode);
    if (normalizedBarcode !== null && normalizedBarcode !== '' && candidateBarcode === normalizedBarcode) {
      return { itemId: candidate.itemId, itemIceCode: candidate.iceCode, matchedBy: 'barcode' };
    }
  }
  if (normalizedName !== null && normalizedName !== '') {
    for (const candidate of candidates) {
      if (normalizeCellText(candidate.nameCn).toLowerCase() === normalizedName) {
        return { itemId: candidate.itemId, itemIceCode: candidate.iceCode, matchedBy: 'nameCn' };
      }
    }
  }
  return null;
}

function planUnboundCode(
  evaluation: SourceRowEvaluation,
  suspectedCandidates: readonly SuspectedCodeCandidate[],
  identityCandidates: readonly IdentityCandidate[],
  snapshotKey: string,
  parsedIssues: ParsedFieldIssue[],
): ProductSourcePlanResult {
  const logical = evaluation.logicalFields;
  const base = {
    iceCode: evaluation.iceCode,
    rowNumbers: evaluation.rowNumbers,
  };
  if (!logical) {
    return baseResult(evaluation.sourceKey, 'failed', 'SNAPSHOT_INVALID', {
      ...base,
      issues: [{ kind: 'snapshot_invalid', detail: { code: 'SNAPSHOT_ROW_INVALID', rows: evaluation.rowNumbers } }],
    });
  }
  const logicalName = observedRaw(logical, 'nameCn');
  const logicalBarcode = observedRaw(logical, 'barcode');
  const identityHint = findIdentityHint(logicalName, logicalBarcode, identityCandidates);
  if (identityHint) {
    const matchedUncoded = identityHint.itemIceCode === null;
    return baseResult(
      evaluation.sourceKey,
      'needs_review',
      matchedUncoded ? 'MISSING_CODE_CANDIDATE' : 'SUSPECTED_CODE_CHANGE',
      {
        ...base,
        nameCn: logicalName,
        issues: [
          {
            kind: matchedUncoded ? 'missing_code_candidate' : 'suspected_code_change',
            detail: {
              rows: evaluation.rowNumbers,
              matchedItemId: identityHint.itemId,
              matchedBy: identityHint.matchedBy,
              matchedItemCode: identityHint.itemIceCode,
              sourceCode: evaluation.iceCode,
            },
          },
          ...parsedIssues.map((entry) => entry.issue),
        ],
      },
    );
  }
  const suspected = detectSuspectedCodeChange({
    iceCode: evaluation.iceCode ?? '',
    logicalFields: logical,
    candidates: [...suspectedCandidates],
  });
  if (suspected.suspected) {
    return baseResult(evaluation.sourceKey, 'needs_review', 'SUSPECTED_CODE_CHANGE', {
      ...base,
      issues: [
        {
          kind: 'suspected_code_change',
          detail: {
            rows: evaluation.rowNumbers,
            matchedItemId: suspected.matchedItemId,
            matchedBy: suspected.matchedBy,
          },
        },
        ...parsedIssues.map((entry) => entry.issue),
      ],
    });
  }

  const nameCn = observedRaw(logical, 'nameCn');
  if (nameCn === null) {
    return baseResult(evaluation.sourceKey, 'needs_review', 'NEW_ITEM_NAME_MISSING', {
      ...base,
      issues: [
        { kind: 'invalid_value', detail: { fieldKey: 'nameCn', reason: 'NAME_MISSING', rows: evaluation.rowNumbers } },
        ...parsedIssues.map((entry) => entry.issue),
      ],
    });
  }
  if (parsedIssues.length > 0) {
    return baseResult(evaluation.sourceKey, 'needs_review', 'NEW_ITEM_VALUE_INVALID', {
      ...base,
      nameCn,
      issues: parsedIssues.map((entry) => entry.issue),
    });
  }

  const nextFields = buildCreateFields(logical, snapshotKey, evaluation.rowNumbers);
  // Unconfirmed-unit source values are excluded from nextFields/changes/adoptions.
  // Only NON-EMPTY observed source values open a review issue; an empty source
  // cell is a no-op (never invent an empty value to review).
  const unconfirmedSourceFields = ADOPTABLE_FIELD_KEYS.filter(
    (fieldKey) =>
      isUnitUnconfirmedField(fieldKey) &&
      logical[fieldKey]?.state === 'observed' &&
      normalizeCellText(logical[fieldKey].raw) !== '',
  );
  const unitIssues: PlanIssue[] = unconfirmedSourceFields.map((fieldKey) => ({
    kind: 'unit_unconfirmed',
    detail: {
      fieldKey,
      beforeRaw: null,
      sourceRaw: normalizeCellText(logical[fieldKey].raw),
      rows: evaluation.rowNumbers,
    },
  }));
  const adoptedFields = ADOPTABLE_FIELD_KEYS.filter(
    (fieldKey) => !isUnitUnconfirmedField(fieldKey) && logical[fieldKey]?.state === 'observed',
  );
  const changes: PlanFieldChange[] = adoptedFields.map((fieldKey) => ({
    fieldKey,
    beforeRaw: null,
    afterRaw: normalizeCellText(logical[fieldKey].raw),
    kind: 'initial_baseline',
  }));
  const adoptions: PlanFieldAdoption[] = adoptedFields.map((fieldKey) => ({
    fieldKey,
    raw: normalizeCellText(logical[fieldKey].raw),
    state: 'observed',
    unitState: FIELD_UNITS[fieldKey].state,
  }));
  return baseResult(evaluation.sourceKey, 'create', 'NEW_ITEM_CREATED', {
    ...base,
    nameCn,
    createCode: evaluation.iceCode,
    nextFields,
    changes,
    adoptions,
    issues: unitIssues,
  });
}

function planMissingCodeRow(
  evaluation: SourceRowEvaluation,
  uncodedItems: readonly { itemId: string; nameCn: string }[],
  parsedIssues: ParsedFieldIssue[],
): ProductSourcePlanResult {
  const logical = evaluation.logicalFields;
  const nameCn = observedRaw(logical, 'nameCn');
  const candidate = nameCn === null ? null : matchUncodedItemByName(nameCn, [...uncodedItems]);
  const extraIssues = parsedIssues.map((entry) => entry.issue);
  if (candidate) {
    return baseResult(evaluation.sourceKey, 'needs_review', 'MISSING_CODE_CANDIDATE', {
      itemId: candidate.itemId,
      rowNumbers: evaluation.rowNumbers,
      nameCn,
      issues: [
        {
          kind: 'missing_code_candidate',
          detail: { rows: evaluation.rowNumbers, nameCn, candidateItemId: candidate.itemId },
        },
        ...extraIssues,
      ],
    });
  }
  return baseResult(evaluation.sourceKey, 'needs_review', 'MISSING_CODE', {
    rowNumbers: evaluation.rowNumbers,
    nameCn,
    issues: [{ kind: 'missing_code', detail: { rows: evaluation.rowNumbers, nameCn } }, ...extraIssues],
  });
}

function planBoundItem(context: {
  item: PlanBoundItem;
  evaluation: SourceRowEvaluation;
  adoptions: readonly PlanAdoptionRow[];
  parsedIssues: ParsedFieldIssue[];
  snapshotKey: string;
  expectedRevision: number;
}): ProductSourcePlanResult {
  const { item, evaluation, adoptions, parsedIssues, snapshotKey, expectedRevision } = context;
  const logical = evaluation.logicalFields;
  if (!logical) {
    return baseResult(evaluation.sourceKey, 'failed', 'SNAPSHOT_INVALID', {
      iceCode: evaluation.iceCode,
      itemId: item.itemId,
      rowNumbers: evaluation.rowNumbers,
      issues: [{ kind: 'snapshot_invalid', detail: { code: 'SNAPSHOT_ROW_INVALID', rows: evaluation.rowNumbers } }],
    });
  }
  const localFields = withLocalName(item);
  const itemDiff = diffItem({ sourceFields: logical, localFields, adoptions });
  const hasParseIssues = parsedIssues.length > 0;
  const hasReview = itemDiff.hasReview || hasParseIssues;
  const changes = itemDiff.writeFields.map(changeOf);
  const adoptionsOut = itemDiff.adoptedFields
    .map(adoptionOf)
    .filter((adoption): adoption is PlanFieldAdoption => adoption !== null);
  const nextFields =
    changes.length > 0
      ? overlayFields(localFields, itemDiff.writeFields, snapshotKey, evaluation.rowNumbers)
      : null;
  const issues = [...parsedIssues.map((entry) => entry.issue), ...itemDiffIssues(itemDiff, evaluation)];
  const nameCn =
    (nextFields?.nameCn && nextFields.nameCn.state === 'observed' ? nextFields.nameCn.raw : null) ?? item.nameCn;

  if (hasReview) {
    return baseResult(evaluation.sourceKey, 'needs_review', reviewReasonCode(itemDiff, parsedIssues), {
      iceCode: evaluation.iceCode,
      itemId: item.itemId,
      nameCn,
      rowNumbers: evaluation.rowNumbers,
      expectedRevision: changes.length > 0 ? expectedRevision : null,
      changes,
      adoptions: adoptionsOut,
      nextFields,
      issues,
    });
  }
  if (changes.length > 0) {
    const initial = itemDiff.writeFields.every((field) => field.outcome === 'initial_adopt');
    return baseResult(evaluation.sourceKey, 'update', initial ? 'INITIAL_SOURCE_BASELINE' : 'SOURCE_FIELD_UPDATE', {
      iceCode: evaluation.iceCode,
      itemId: item.itemId,
      nameCn,
      rowNumbers: evaluation.rowNumbers,
      expectedRevision,
      changes,
      adoptions: adoptionsOut,
      nextFields,
    });
  }
  return baseResult(evaluation.sourceKey, 'unchanged', adoptionsOut.length > 0 ? 'SAME_VALUE_NO_REVISION' : 'SOURCE_UNCHANGED', {
    iceCode: evaluation.iceCode,
    itemId: item.itemId,
    nameCn,
    rowNumbers: evaluation.rowNumbers,
    adoptions: adoptionsOut,
    issues: [],
  });
}

function countResults(results: readonly ProductSourcePlanResult[]): PlanCounts {
  const counts: PlanCounts = { ...ZERO_COUNTS };
  for (const result of results) {
    if (result.missing) counts.missing += 1;
    switch (result.action) {
      case 'create':
        counts.created += 1;
        break;
      case 'update':
        counts.updated += 1;
        break;
      case 'unchanged':
        counts.unchanged += 1;
        break;
      case 'needs_review':
        counts.needsReview += 1;
        break;
      case 'failed':
        counts.failed += 1;
        break;
      default:
        break;
    }
  }
  return counts;
}

function batchStatusOf(counts: PlanCounts): 'applied' | 'partial' | 'failed' {
  const processed = counts.created + counts.updated + counts.unchanged + counts.needsReview + counts.missing;
  if (counts.failed > 0) return processed === 0 ? 'failed' : 'partial';
  if (counts.needsReview > 0) return 'partial';
  return 'applied';
}

function snapshotIssueKind(code: SnapshotIssueCode): IssueKind {
  switch (code) {
    case 'HEADER_CONTRACT_INVALID':
      return 'header_contract_invalid';
    case 'COLUMN_COUNT_INVALID':
      return 'column_count_invalid';
    case 'CAPTURE_INCOMPLETE':
      return 'capture_incomplete';
    default:
      return 'snapshot_invalid';
  }
}

function snapshotFailureReason(code: SnapshotIssueCode): ProductSourceReasonCode {
  switch (code) {
    case 'HEADER_CONTRACT_INVALID':
      return 'SNAPSHOT_HEADER_INVALID';
    case 'COLUMN_COUNT_INVALID':
      return 'SNAPSHOT_COLUMN_COUNT_INVALID';
    case 'CAPTURE_INCOMPLETE':
      return 'SNAPSHOT_INCOMPLETE';
    default:
      return 'SNAPSHOT_INVALID';
  }
}

function rejectedBatchResult(issues: readonly SnapshotIssue[]): ProductSourcePlanResult {
  const first = issues[0];
  const reasonCode = first ? snapshotFailureReason(first.code) : 'SNAPSHOT_INVALID';
  return baseResult('batch', 'failed', reasonCode, {
    issues: issues.map((issue) => ({
      kind: snapshotIssueKind(issue.code),
      detail: { code: issue.code, detail: issue.detail },
    })),
  });
}

/** Strip the service-only fields and produce the exact p_plan JSON payload. */
export function toPlanPayload(plan: ProductSourcePlan): ProductSourcePlanPayload {
  return {
    countsHint: plan.countsHint,
    results: plan.results,
    seenItemIds: plan.seenItemIds,
    batchStatusHint: plan.batchStatusHint,
  };
}

/**
 * Build the exact p_batch JSON payload.
 *
 * Restricted amount columns are resolved by their actual header labels
 * (`resolveHeaderMapping(headers).restrictedColumns`), never by fixed I/J/Y
 * letters: after a column reorder the price columns can live at AB/AC/AD while
 * I/J/Y hold ordinary text. The public `rows[].cells` map is stripped of those
 * restricted columns only (ordinary text in other columns is preserved), and
 * `amounts[].payload` uses semantic keys (`costPrice`/`operatingPrice`/
 * `shippingPrice`) for the private evidence table.
 */
export function buildBatchPayload(input: {
  snapshot: SourceSnapshot;
  plan: ProductSourcePlan;
  artifacts: BatchArtifact[];
  adoptionSha256: string;
  parentBatchId?: string | null;
  /** Set when this batch retries the failed items of an earlier batch. */
  retryOfBatchId?: string | null;
}): ProductSourceBatchPayload {
  const snapshot = input.snapshot;
  const restrictedColumns = resolveHeaderMapping(snapshot.collection.headers).restrictedColumns;
  const restrictedColumnSet = new Set(
    Object.values(restrictedColumns).filter((column): column is string => column !== undefined),
  );
  const publicCells = (cells: Record<string, string>): Record<string, string> => {
    const copy: Record<string, string> = {};
    for (const [column, raw] of Object.entries(cells)) {
      if (!restrictedColumnSet.has(column)) copy[column] = raw;
    }
    return copy;
  };
  const rows: ProductSourceBatchRow[] = snapshot.rows.map((row) => ({
    rowNumber: row.rowNumber,
    isBusinessRow: row.isBusinessRow,
    iceCode: row.isBusinessRow ? sourceIceCode(row) : null,
    cells: publicCells(row.cells),
    // Original snapshot row hash is kept as evidence even though the public cells
    // map is redacted at the boundary.
    rowSha256: row.rowSha256,
  }));
  const amounts: ProductSourceBatchAmountRow[] = [];
  const costColumn = restrictedColumns.costPrice;
  const operatingColumn = restrictedColumns.operatingPrice;
  const shippingColumn = restrictedColumns.shippingPrice;
  for (const row of snapshot.rows) {
    const payload: Partial<Record<RestrictedAmountKey, string>> = {};
    const cost = costColumn === undefined ? undefined : row.cells[costColumn];
    const operating = operatingColumn === undefined ? undefined : row.cells[operatingColumn];
    const shipping = shippingColumn === undefined ? undefined : row.cells[shippingColumn];
    if (cost !== undefined && cost !== '') payload.costPrice = cost;
    if (operating !== undefined && operating !== '') payload.operatingPrice = operating;
    if (shipping !== undefined && shipping !== '') payload.shippingPrice = shipping;
    if (Object.keys(payload).length > 0) amounts.push({ rowNumber: row.rowNumber, payload });
  }
  return {
    snapshotKey: snapshot.snapshotKey,
    origin: snapshot.origin,
    capturedAt: snapshot.capturedAt,
    sourceModifiedLabel: snapshot.documentModifiedLabel,
    collection: snapshot.collection,
    rowsSha256: computeRowsSha256(rows),
    adoptionSha256: input.adoptionSha256,
    retryOfBatchId: input.retryOfBatchId ?? null,
    parentBatchId: input.parentBatchId ?? null,
    simulationNote: snapshot.simulation?.note ?? null,
    artifacts: input.artifacts,
    rows,
    amounts,
  };
}
