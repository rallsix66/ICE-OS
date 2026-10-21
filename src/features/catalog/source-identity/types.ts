export type IdentitySystem = 'bigseller' | 'jushuitan' | 'feishu';
export type EntityKind = 'product_record' | 'sku_record';
export type IdentityStrategy = 'vendor_stable_id' | 'scoped_business_key';
export type IdentityState = 'active' | 'review_required' | 'suspended' | 'revoked';
export type IdentityAction = 'import_capture' | 'register' | 'revise' | 'link';
export type ObservationField<T = string> =
  | { state: 'value'; value: T; evidenceRef: string }
  | { state: 'empty'; value: null; evidenceRef: string }
  | { state: 'not_observed' | 'parse_failed'; value: null; reason: string; evidenceRef: string };
export type IdentityContext =
  | { state: 'known'; raw: string; canonical: string; evidenceRef: string }
  | { state: 'unknown'; raw: null; reason: string }
  | { state: 'not_applicable'; raw: null; evidenceRef: string };
export interface ScopeIdentityInput {
  system: IdentitySystem; entityKind: EntityKind;
  accountKind: 'account' | 'tenant_account' | 'fixture_account'; accountParts: string[];
  resourceKind: 'sheet_tab' | 'api_collection' | 'fixture_dataset'; resourceParts: string[];
  marketRole: 'identity' | 'context'; marketIdentity: string | null;
  warehouseRole: 'identity' | 'context'; warehouseIdentity: string | null;
}
export interface IdentityHead {
  state: IdentityState; activeClaimId: string; currentContractId: string;
}
export interface IdentityRecordDto {
  recordId: string; scopeId: string; entityKind: EntityKind; revision: number; state: IdentityState;
  activeClaimId: string; currentContractId: string; verificationEnvironment: 'fixture'; relationshipUsable: false;
}
export interface IdentityMutationResult {
  requestId: string; scopeId: string; action: IdentityAction; recordId?: string; revision?: number;
  state?: IdentityState; claimId?: string; evidenceId?: string; observationIds?: string[];
  observationKey?: string; linkRevision?: number; created?: boolean;
  verificationEnvironment: 'fixture'; relationshipUsable: false;
}
export interface ExpectedIdentityMatch { kind: 'record'; recordId: string; revision: number }
export type ExpectedMatch = { kind: 'none' } | ExpectedIdentityMatch;
export interface RegisterIdentityInput {
  requestId: string; scopeId: string; contractId: string; observationId: string; proofId: string;
  expectedMatch: ExpectedMatch; reason: string;
}
export interface ReviseIdentityInput {
  requestId: string; scopeId: string; recordId: string; expectedRecordRevision: number;
  command: 'open_review' | 'suspend' | 'revoke' | 'reverify'; proofId: string; reason: string;
  contractId?: string; observationId?: string; expectedClaimId?: string;
}
export interface LinkIdentityInput {
  requestId: string; scopeId: string; operation: 'link' | 'revoke'; recordId: string;
  expectedRecordRevision: number; expectedLinkRevision: number; expectedPreviousRecordRevision?: number;
  origin: { kind: 'frozen' | 'identity'; id: string }; proofId: string; reason: string;
}
export interface PreparedIdentityObservation {
  observationId: string; recordPointer: string; fields: Record<string, ObservationField>;
  marketContext: IdentityContext; warehouseContext: IdentityContext; position: Record<string, string | number | null>;
  payloadSha256: string; sourceEffectiveAt: string | null; sourceAvailability: 'known' | 'not_observed';
}
export interface PreparedIdentityCapture {
  captureKey: string; evidenceId: string; manifestId: string; bytesSha256: string; size: number; format: string;
  parserId: string; parserVersion: string; contractId: string; contractRevision: number; coverage: Record<string, unknown>;
  projectionSha256: string; adoptionDigest: string; storageHandle: string; observations: PreparedIdentityObservation[];
  proofSemantics: { uniqueness: boolean; stability: boolean; keyChange: boolean; reuse: boolean; oldObservationCompatible: boolean; disjointKeyDomain?: boolean; migrationClaimId?: string };
}
export interface SourceScopeDto {
  scopeId: string; displayName: string; system: IdentitySystem; entityKind: EntityKind;
  scopeState: 'identity_ready' | 'unresolved'; verificationEnvironment: 'fixture';
}
export interface IdentityContractDto { contractId: string; revision: number; strategy: IdentityStrategy; keyFields: string[]; proofId: string }
export interface IdentityEvidenceDto { evidenceId: string; scopeId: string; captureKey: string; sha256: string; format: string; parserId: string; parserVersion: string; coverage: Record<string, unknown>; collectedAt: string; sourceEffectiveAt: string | null; sourceAvailability: string }
export interface IdentityObservationDto { observationId: string; evidenceId: string; recordPointer: string; fields: Record<string, ObservationField>; marketContext: IdentityContext; warehouseContext: IdentityContext; position: Record<string, string | number | null> }
export interface IdentityLinkDto { observationKey: string; linkRevision: number; originKind: 'frozen' | 'identity'; originId: string; recordId: string; contractId: string; actorId: string; status: 'linked' | 'revoked'; proofId: string; reason: string; recordedAt: string }
export interface FrozenChoiceDto { decisionId: string; observationId: string; selectedItemId: string | null; selectedJushuitanRef: string | null; reviewState: string | null }
export interface IdentityWorkspaceDto { scope: SourceScopeDto; permissions: { read: boolean; manage: boolean; evidence: boolean; amount: boolean };
  contracts: IdentityContractDto[]; proofs: IdentityEvidenceDto[]; observations: IdentityObservationDto[]; records: IdentityRecordDto[];
  links: IdentityLinkDto[]; history: SourceIdentityHistoryDto[]; frozenHumanChoice: FrozenChoiceDto[];
  verificationEnvironment: 'fixture'; catalogTargetDecision: 'not_implemented'; formalRelationship: { usable: false; reason: 'N2_NOT_IMPLEMENTED' } }
export interface SourceIdentityPanelDto {
  verificationEnvironment: 'fixture'; scopes: SourceScopeDto[]; frozenHumanChoice: FrozenChoiceDto[];
  sourceIdentity: IdentityRecordDto[]; observations: IdentityObservationDto[]; links: IdentityLinkDto[];
  catalogTargetDecision: 'not_implemented'; formalRelationship: { usable: false; reason: 'N2_NOT_IMPLEMENTED' };
}
export interface SourceIdentityHistoryDto {
  requestId: string; scopeId: string; action: string; recordId: string | null; revision: number | null;
  beforeState: IdentityHead | null; afterState: IdentityHead | null; reason: string; actorId: string; recordedAt: string;
  sourceEffectiveAt: string | null; sourceAvailability: 'not_observed';
}
export type SourceIdentityActionResult<T> = { status: 'success'; data: T } | { status: 'denied' | 'conflict' | 'unknown'; code: string };
