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

/**
 * 变更记录的日常展示投影（V3-01.3）。
 *
 * 原始审计字段（actor UUID、证据引用/路径、内部英文 reason、原始 ISO 时间）只留在服务端，
 * 或仅经授权的证据子视图（fetchCatalogRevisionEvidenceAction）按需读取；日常投影只给可核实的中文事实。
 */
export type CatalogRevisionChange = { key: string; label: string; before: string; after: string };

export interface CatalogRevisionDisplay {
  /** 是否当前版本（由 item_current 判定，不由列表顺序推断）。 */
  isCurrent: boolean;
  /** initial：首版资料；revision：后续修订。 */
  kind: 'initial' | 'revision';
  /** 中文业务理由；内部英文 key 已映射，不进入日常投影。 */
  reasonLabel: string;
  /** 仅在服务端能由 public.profiles 核实显示名时给出；无法核实为 null，绝不回传 UUID。 */
  actorLabel: string | null;
  /** Asia/Shanghai 'YYYY-MM-DD HH:mm'，确定性格式化（不随系统 locale 变化）。 */
  recordedAtDisplay: string;
  /** 与上一版本的字段级差异；首版或没有真实差异时为空数组。 */
  changedFields: CatalogRevisionChange[];
  /** 是否存在原始证据；只给布尔，不给路径。 */
  hasEvidence: boolean;
}

/** 历史记录每天投影的一行；不含 actorId/evidenceRef/reason 原文。 */
export interface CatalogRevisionHistoryDto {
  revision: number;
  iceCode: string | null;
  nameCn: string;
  newProductConfirmed: boolean;
  display: CatalogRevisionDisplay;
}

/** 授权原始证据（只在弹窗内“来源与证据”子视图渲染）。 */
export interface CatalogRevisionEvidenceDto {
  reason: string | null;
  actorId: string | null;
  evidenceRef: string | null;
  recordedAt: string;
}

export type CatalogRequestKind = 'initial_code' | 'nonprice_revision';

/**
 * 只读核对原请求回执的状态。
 * - applied：回执与请求范围一致且已落库；
 * - no_receipt：没有查到可对应的回执——**不等于**“未提交”，不得自动重发；
 * - scope_mismatch：回执存在但 action/商品/版本与本次核对范围不一致；
 * - not_authorized：当前账户没有核对权限（不等于原事务失败）。
 */
export type CatalogRequestOutcomeStatus = 'applied' | 'no_receipt' | 'scope_mismatch' | 'not_authorized';

export interface CatalogRequestOutcome {
  status: CatalogRequestOutcomeStatus;
  /** applied 时为落库版本；其他状态为 null。 */
  revision: number | null;
  /** 中文业务动作名；不回传内部 action key。 */
  actionLabel: string | null;
}

export interface CatalogItemStatusFlags { bsNotCreated: boolean; brushPending: boolean }
export interface CatalogWriteAccess { isScoped: boolean; canWrite: boolean }

/** 与 getCatalogDetailCore 相同的服务端核心投影。 */
export interface CatalogDetailCoreView {
  item: CatalogItemDto;
  flags: CatalogItemStatusFlags;
  writeAccess: CatalogWriteAccess;
  historical: boolean;
}

/** 历史版本核心视图：只读、无 BS 样表投影（历史不混入当前库存/价格）。 */
export interface CatalogDetailRevisionView extends CatalogDetailCoreView {
  historical: true;
  bsSample: null;
  bsSampleError: null;
}
export interface CandidateDto {
  itemId: string; sourceSystem: 'bigseller' | 'jushuitan'; observationId: string;
  basis: ('exact_code_hint' | 'exact_barcode_hint' | 'name_hint' | 'existing_choice')[];
  existingDecisionRef: string | null; conflicts: string[];
  sourceRecordId: null; relationshipUsable: false;
  name: string | null; sku: string | null; reviewState: string | null;
}
