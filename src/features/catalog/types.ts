/** Catalog contracts are independent of legacy database and vendor row types. */
export type FieldObservation =
  | { state: 'observed'; raw: string; meaning: 'value' | 'explicit_empty'; evidenceRef: string }
  | { state: 'observed'; raw: null; meaning: 'explicit_null'; evidenceRef: string }
  | { state: 'no_text'; raw: null; evidenceRef: string }
  | { state: 'not_read' | 'parse_failed'; raw: null; reason: string; evidenceRef: string };

export type SourceSystem = 'bigseller' | 'jushuitan' | 'feishu';
export type ScopeValue =
  | { state: 'known'; raw: string; canonical: string; evidenceRef: string }
  | { state: 'unknown'; raw: null; reason: string }
  | { state: 'not_applicable'; raw: null; evidenceRef: string };

export interface ArtifactMetadata {
  logicalName: string; sha256: string; size: number; format: string;
  sensitivity: 'restricted'; storageHandle: string;
}
export interface PreparedFinancial {
  cost: FieldObservation; operatingPrice: FieldObservation;
  sourceRow: number | null; versions: { sourceRow: number; cost: FieldObservation; operatingPrice: FieldObservation }[];
  currency: 'unknown'; unit: 'unknown'; tax: 'unknown'; freight: 'unknown'; valuationAuthorized: false;
  rawRef: string;
}
export interface PreparedItem {
  anchorPointer: string; rowPosition: number; iceCode: string | null; nameCn: string;
  newProductConfirmed: boolean; fields: Record<string, FieldObservation>;
  financial: PreparedFinancial; payloadSha256: string; rawRef: string;
}
export interface PreparedObservation {
  system: SourceSystem; entryKey: string; legacyCandidateId: string | null;
  position: { sheet: string | null; row: number | null; cell?: string; sourceRowKey?: string };
  fields: Record<string, FieldObservation>; amounts: Record<string, FieldObservation>;
  reviewState: string | null; rawRef: string; payloadSha256: string;
  scope: { account: ScopeValue; market: ScopeValue; warehouse: ScopeValue };
}
export interface PreparedDecision {
  entryKind: string; entryKey: string; observationEntryKey: string | null;
  selectedItemAnchor: string | null; selectedJushuitanRef: string | null;
  selectedJushuitanSha256: string | null; reviewState: string | null;
  payloadSha256: string; rawRef: string;
  summary: Record<string, string | number | boolean | null | string[]>;
}
export interface PreparedBaseline {
  releaseKey: string; bundleSha256: string; effectiveCsvSha256: string; parserVersion: string;
  artifacts: ArtifactMetadata[]; items: PreparedItem[]; observations: PreparedObservation[];
  decisions: PreparedDecision[];
  counts: { items: number; coded: number; observations: number; selected: number; csvRecords: number; historyEntries: number };
  fullManifest: ArtifactMetadata[]; subsetManifest: ArtifactMetadata[];
  contentSha256: string;
}
export interface PreparedFrozenObservations {
  approvedSnapshotId: 'feishu-partial-20261020-v2'; snapshotKey: string; parserVersion: string;
  artifact: ArtifactMetadata; artifacts: ArtifactMetadata[]; observations: PreparedObservation[];
  coverage: { complete: false; headers: number; dataRowPositions: number[]; cells: number; sourceUrl: string;
    collectedAtStart: string; collectedAtEnd: string; sourceUpdatedAt: null; cursor: null; stableRecordId: null };
  contentSha256: string;
}
export interface CatalogItemDto {
  itemId: string; revision: number; iceCode: string | null; codeState: 'coded' | 'awaiting_code';
  newProductConfirmed: boolean; nameCn: string; specification: FieldObservation; barcodeRefs: FieldObservation[];
  fields: Record<string, FieldObservation>; humanChoices: { bigseller: number; jushuitan: number };
  sourceRecordId: null; sourceIdentityVerified: false; relationshipUsable: false; provenanceRefs: string[];
}
/** Stored revision audit metadata; recordedAt is system time, never a source update time. */
export interface CatalogRevisionAuditDto {
  reason: string; actorId: string; recordedAt: string; evidenceRef: string;
}
export interface CatalogItemRevisionDto extends CatalogItemDto {
  revisionAudit: CatalogRevisionAuditDto;
}
export interface CandidateDto {
  itemId: string; sourceSystem: 'bigseller' | 'jushuitan'; observationId: string;
  basis: ('exact_code_hint' | 'exact_barcode_hint' | 'name_hint' | 'existing_choice')[];
  existingDecisionRef: string | null; conflicts: string[];
  sourceRecordId: null; relationshipUsable: false;
  name: string | null; sku: string | null; reviewState: string | null;
}
