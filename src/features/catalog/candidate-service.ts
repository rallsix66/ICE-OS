import type { CandidateDto, CatalogItemDto, FieldObservation } from './types';

export const CANDIDATE_ALGORITHM = 'catalog-candidate-v1';
export const NAME_SEARCH_ALGORITHM = 'name-search-v1';
export const normalizeName = (value: string) => value.normalize('NFKC').toLowerCase().replace(/\s/gu, '');
const fieldValue = (field: FieldObservation | undefined): string | null => field?.state === 'observed' && field.meaning === 'value' ? field.raw : null;
export interface CandidateObservation {
  observationId: string; sourceSystem: 'bigseller' | 'jushuitan'; fields: Record<string, FieldObservation>;
  reviewState: string | null; existingDecisionRef?: string | null; selectedItemId?: string | null; conflicts?: string[];
}

/** Independent per-item/per-system preview. Never updates a decision or returns a score. */
export function findCandidates(item: Pick<CatalogItemDto, 'itemId' | 'iceCode' | 'nameCn' | 'barcodeRefs'>,
  sourceSystem: 'bigseller' | 'jushuitan', observations: CandidateObservation[]): CandidateDto[] {
  const name = normalizeName(item.nameCn), barcodes = item.barcodeRefs.map(fieldValue).filter((value): value is string => value !== null);
  return observations.filter((observation) => observation.sourceSystem === sourceSystem).flatMap((observation) => {
    const basis: CandidateDto['basis'] = [];
    if (item.iceCode && ['sku', 'styleCode', 'productCode'].some((key) => fieldValue(observation.fields[key]) === item.iceCode)) basis.push('exact_code_hint');
    const sourceBarcode = fieldValue(observation.fields.barcode);
    if (sourceBarcode && barcodes.includes(sourceBarcode)) basis.push('exact_barcode_hint');
    const sourceNameRaw = fieldValue(observation.fields.name), sourceName = sourceNameRaw ? normalizeName(sourceNameRaw) : '';
    if (name && sourceName && (name.includes(sourceName) || sourceName.includes(name))) basis.push('name_hint');
    if (observation.selectedItemId === item.itemId) basis.push('existing_choice');
    if (!basis.length) return [];
    const conflicts = ['SOURCE_IDENTITY_UNVERIFIED', ...(observation.conflicts ?? []).filter((flag) => /^[A-Z][A-Z0-9_]*$/.test(flag))];
    const sourceSku = fieldValue(observation.fields.sku);
    if (sourceSku && observations.filter((other) => other.sourceSystem === sourceSystem && fieldValue(other.fields.sku) === sourceSku).length > 1) {
      conflicts.push('SOURCE_SKU_REPEATED_REVIEW_SCOPE');
    }
    if (sourceBarcode && observations.filter((other) => other.sourceSystem === sourceSystem && fieldValue(other.fields.barcode) === sourceBarcode).length > 1) {
      conflicts.push('BARCODE_SHARED_REVIEW_VERSION');
    }
    if (observation.selectedItemId && observation.selectedItemId !== item.itemId) conflicts.push('EXISTING_CHOICE_OTHER_ITEM');
    if (['ignored', 'rejected', 'outside_rules'].includes(observation.reviewState ?? '')) conflicts.push(`PRESERVED_${observation.reviewState!.toUpperCase()}`);
    return [{ itemId: item.itemId, sourceSystem, observationId: observation.observationId, basis,
      existingDecisionRef: observation.existingDecisionRef ?? null, conflicts: [...new Set(conflicts)], sourceRecordId: null,
      relationshipUsable: false, name: sourceNameRaw, sku: fieldValue(observation.fields.sku), reviewState: observation.reviewState }];
  });
}

export interface DifferenceObservation {
  observationId: string; sourceSystem: 'bigseller' | 'jushuitan' | 'feishu';
  position: Record<string, string | number | null>; fields: Record<string, FieldObservation>; rawRef: string;
}
export interface CatalogDifference {
  observationId: string; field: string; adopted: FieldObservation | null; observed: FieldObservation | null;
  status: 'different' | 'unresolved' | 'restricted_reference'; evidenceRef: string;
}
export function buildCandidates(item: CatalogItemDto, observations: (DifferenceObservation & {
  reviewState: string | null; selectedItemId: string | null; existingDecisionRef: string | null; conflicts?: string[];
})[], sourceSystem: 'bigseller' | 'jushuitan'): CandidateDto[] {
  const eligible = observations.filter((observation): observation is typeof observation & { sourceSystem: 'bigseller' | 'jushuitan' } => observation.sourceSystem !== 'feishu');
  return findCandidates(item, sourceSystem, eligible).map((candidate) => {
    const observation = eligible.find((entry) => entry.observationId === candidate.observationId)!;
    const sourceSpecification = fieldValue(observation.fields.specification), adoptedSpecification = fieldValue(item.specification);
    const sourcePackaging = fieldValue(observation.fields.packaging), adoptedPackaging = fieldValue(item.fields.packaging);
    if (sourceSpecification && adoptedSpecification && sourceSpecification !== adoptedSpecification) candidate.conflicts.push('SPECIFICATION_DIFF_REVIEW_VERSION_OR_PACKAGING');
    if (sourcePackaging && adoptedPackaging && sourcePackaging !== adoptedPackaging) candidate.conflicts.push('PACKAGING_DIFFERENCE_REQUIRES_REVIEW');
    return candidate;
  });
}

/** Cell grid grouping is local preview only; it never creates source identity. */
export function buildDifferences(item: Pick<CatalogItemDto, 'iceCode' | 'nameCn' | 'fields'>, observations: DifferenceObservation[]): CatalogDifference[] {
  if (!item.iceCode) return [];
  const rows = new Map<string, Map<string, DifferenceObservation>>();
  for (const observation of observations) {
    if (observation.sourceSystem !== 'feishu' || typeof observation.position.cell !== 'string' || observation.position.row === 1) continue;
    const key = `${String(observation.position.sheet)}:${String(observation.position.row)}`;
    if (!rows.has(key)) rows.set(key, new Map());
    rows.get(key)!.set(observation.position.cell.replace(/\d+$/, ''), observation);
  }
  const differences: CatalogDifference[] = [];
  for (const columns of rows.values()) {
    if (fieldValue(columns.get('G')?.fields.value) !== item.iceCode || fieldValue(columns.get('B')?.fields.value) !== item.nameCn) continue;
    for (const [column, field] of [['A', 'sourceDate'], ['C', 'specification'], ['E', 'factory'], ['F', 'imageRef'], ['H', 'barcode']] as const) {
      const observation = columns.get(column), observed = observation?.fields.value, adopted = item.fields[field];
      if (!observation || !observed || !adopted || (observed.state === 'observed' && observed.raw === adopted.raw)) continue;
      differences.push({ observationId: observation.observationId, field, adopted, observed,
        status: observed.state === 'observed' ? 'different' : 'unresolved', evidenceRef: observation.rawRef });
    }
    // These references allow the separately authorized amount projection to resolve
    // its cells. The general projection contains no value, formula or price state.
    for (const column of ['I', 'J', 'Y']) {
      const observation = columns.get(column);
      if (observation) differences.push({ observationId: observation.observationId, field: 'restricted_amount',
        adopted: null, observed: null, status: 'restricted_reference', evidenceRef: observation.rawRef });
    }
  }
  return differences;
}
