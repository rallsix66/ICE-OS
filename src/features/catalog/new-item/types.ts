import type { FieldObservation } from '../types';
import type { SourceScopeDto } from '../source-identity/types';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export const NEW_ITEM_ACTIONS = ['import_product_capture', 'classify_observation', 'confirm_new_item', 'associate_existing_item',
  'attach_source_identity', 'assign_initial_code', 'append_nonprice_revision'] as const;
export type NewItemAction = typeof NEW_ITEM_ACTIONS[number];
export type ProductClassification = 'new_item' | 'item_update' | 'external_sku' | 'suspected_version';
export const ADOPTABLE_FIELD_KEYS = ['nameCn', 'englishName', 'specification', 'barcode', 'factory', 'packaging', 'cartonQuantity'] as const;
export type AdoptableFieldKey = typeof ADOPTABLE_FIELD_KEYS[number];
export interface SourceSnapshot { recordId: string; revision: number; claimId: string }
export interface ProductEndpoint { kind: 'product_observation'; captureKey: string; recordPointer: string; bytesSha256: string; payloadSha256: string }
export interface BaselineEndpoint { kind: 'baseline_anchor'; releaseId: string; artifactId: string; jsonPointer: string; bundleSha256: string; payloadSha256: string }
export interface IdentityEndpoint { kind: 'identity_observation'; evidenceId: string; recordPointer: string; bytesSha256: string; payloadSha256: string }
export interface AssociationProof { proofKey: string; semantics: 'same_catalog_item' | 'same_source_record'; from: ProductEndpoint; to: ProductEndpoint | BaselineEndpoint | IdentityEndpoint }
export interface AssociationProofRef { captureId: string; proofKey: string }
export interface ProductCaptureEnvelope {
  approvedFixtureId: string; fixtureManifestId: string; fixtureManifestSha256: string; scopeId: string; captureKey: string;
  bytesSha256: string; sizeBytes: number; format: string; parserId: string; parserVersion: string; schemaVersion: string;
  coverage: { [key: string]: JsonValue }; projectionSha256: string; associationProofs: AssociationProof[];
  sourceAvailability: 'known' | 'not_observed'; sourceEffectiveAt: string | null;
  documentAvailability: 'known' | 'not_observed'; documentModifiedAt: string | null; collectedAt: string;
}
export interface PreparedProductObservation {
  recordPointer: string; position: { [key: string]: JsonValue }; fields: Record<string, FieldObservation>;
  marketContext: JsonValue; warehouseContext: JsonValue; payloadSha256: string; rawRef: string;
}
export interface PreparedProductCapture extends ProductCaptureEnvelope {
  adoptionDigest: string; storageHandle?: string; observations: PreparedProductObservation[];
}
export interface ClassificationDto { revision: number; classification: ProductClassification; reviewState: 'proposed' | 'needs_review';
  proposedItemId: string | null; expectedItemRevision: number | null; proposedFieldKeys?: string[] }
export interface SourceDispositionDto { sha256: string; conflicts?: string[]; targetItemIds?: string[]; sourceState?: string; [key: string]: JsonValue | undefined }
export interface SourceSlotPreviewDto { basisKind: 'source_slot'; observationId: string; classificationRevision: number;
  sourceCoverage: { [key: string]: JsonValue }; sourceDispositionSha256: string;
  slot: { sourceRecordId: string; itemId: string; creationDecisionId: string; originId: string }; itemRevision: number; previewId: string }
export interface ProductObservationDto {
  observationId: string; captureId: string; recordPointer: string; payloadSha256: string;
  fields: Record<string, FieldObservation>; position: { [key: string]: JsonValue };
  classification: ClassificationDto | null; classificationHistory: ClassificationDto[];
  currentSource: (SourceSnapshot & { contractId?: string; contractRevision?: number; state?: string }) | null;
  sourceDisposition: SourceDispositionDto; sourceSlotPreview: SourceSlotPreviewDto | null; origin: ProductOriginDto | null;
}
export interface ProductOriginDto { originId: string; observationId: string; itemId: string; originKind: 'created' | 'associated_existing' | 'source_attached';
  associationBasisKind?: 'none' | 'catalog_proof' | 'source_slot'; creationDecisionId?: string | null; sourceRecordId?: string | null }
export interface ProductCaptureDto { captureId: string; captureKey: string; approvedFixtureId: string; sha256: string; size?: number;
  sourceEffectiveAt?: string | null; documentModifiedAt?: string | null; collectedAt?: string }
export interface NewItemPermissions { read: boolean; manage: boolean; publish: boolean; evidence: boolean; amount: boolean }
export interface NewItemWorkspaceDto { scope: SourceScopeDto; permissions: NewItemPermissions; captures: ProductCaptureDto[];
  observations: ProductObservationDto[]; origins: ProductOriginDto[]; fixtures?: string[] }
export interface NewItemWorkspace { enabled: boolean; scopes: SourceScopeDto[]; scopeId: string | null; workspace: NewItemWorkspaceDto | null;
  fixtures: { approvedFixtureId: string; scopeId: string; label: string }[] }
export interface NewItemMutationResult { itemId?: string; revision?: number; iceCode?: string | null; created?: boolean; associated?: boolean;
  originId?: string; creationDecisionId?: string; captureId?: string; observationIds?: string[]; imported?: boolean; classificationRevision?: number;
  codeState?: 'awaiting_code' | 'coded'; identityStatus?: string; relationshipUsable?: false }
export interface SensitiveHistoryEvent { requestId: string; action: NewItemAction; observationId: string | null; itemId: string | null;
  itemRevision: number | null; classificationRevision: number | null; privateReason: string; associationProof: JsonValue;
  fieldEvidence: JsonValue; actorId: string; recordedAt: string }
export interface SensitiveHistoryDto { projection: 'sensitive_history'; scopeId: string; observationId: string | null; events: SensitiveHistoryEvent[] }
export interface ProductEvidenceMetadata { evidenceId: string; scopeId: string; sha256: string; size: number; format: string; storageHandle: string }
export interface ConfirmationPreview { scopeId: string; observationId: string; expectedClassificationRevision: number;
  expectedSourceSnapshot: SourceSnapshot | null; expectedSourceDisposition: string; previewId: string; adoptedFieldKeys: AdoptableFieldKey[]; initialCode: string | null }
export interface CatalogProofOption { label: string; observationId: string; expectedClassificationRevision: number; expectedSourceDisposition: string;
  previewId: string; basis: { kind: 'catalog_proof'; basisAnchorOrOrigin: { kind: 'origin'; originId: string }; associationProofRef: AssociationProofRef;
    targetItemId: string; expectedItemRevision: number } }
export interface AttachIdentityOption { label: string; originId: string; observationId: string; itemId: string; expectedItemRevision: number;
  sourceRecordId: string; expectedRecordRevision: number; expectedClaimId: string; supportIdentityObservationId: string;
  expectedSourceDisposition: string; associationProofRef: AssociationProofRef | null }
