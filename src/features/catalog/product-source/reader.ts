/**
 * Reader contract and content-digest helpers.
 *
 * The reader is the only layer that will be replaced when the real Feishu API is
 * enabled; the rest of the pipeline only consumes `SourceSnapshot` objects.
 * Digests use node:crypto, so this module is server/script-only (never imported
 * by client components); `contract.ts` stays import-safe for the UI.
 */
import { createHash } from 'node:crypto';
import {
  SNAPSHOT_CONTRACT,
  SOURCE_PROFILE_KEY,
  canonicalJson,
  snapshotContentPayload,
  type ProductSourceBatchRow,
  type ProductSourcePlanPayload,
  type SnapshotOrigin,
  type SourceRow,
  type SourceSnapshot,
} from './contract';

export interface SourceSnapshotSummary {
  snapshotKey: string;
  capturedAt: string;
  origin: SnapshotOrigin;
  complete: boolean;
  /** File name within the snapshot directory (evidence only). */
  fileName: string;
}

export interface ProductSourceReader {
  profileKey: string;
  describe(): { mode: 'local_snapshot' | 'feishu_api'; label: string; detail: string };
  /** Readable snapshots sorted by capturedAt ascending. */
  listSnapshots(): Promise<SourceSnapshotSummary[]>;
  readSnapshot(snapshotKey: string): Promise<SourceSnapshot>;
}

export type ProductSourceReaderErrorCode =
  | 'SOURCE_READER_ROOT_NOT_CONFIGURED'
  | 'SOURCE_SNAPSHOT_DIR_MISSING'
  | 'SOURCE_SNAPSHOT_INVALID'
  | 'SOURCE_SNAPSHOT_KEY_MISMATCH'
  | 'SOURCE_SNAPSHOT_NOT_FOUND'
  | 'FEISHU_API_NOT_CONFIGURED';

export class ProductSourceReaderError extends Error {
  readonly code: ProductSourceReaderErrorCode;
  constructor(code: ProductSourceReaderErrorCode, message?: string) {
    super(message ? `${code}: ${message}` : code);
    this.name = 'ProductSourceReaderError';
    this.code = code;
  }
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Content version of a snapshot (normalized rows + collection, per contract §3). */
export function computeSnapshotKey(snapshot: Pick<SourceSnapshot, 'collection' | 'rows'>): string {
  return sha256Hex(snapshotContentPayload(snapshot));
}

export function computeRowSha256(row: Pick<SourceRow, 'rowNumber' | 'cells' | 'fields'>): string {
  return sha256Hex(canonicalJson({ rowNumber: row.rowNumber, cells: row.cells, fields: row.fields }));
}

/** Digest of the batch rows handed to the database (rowNumber/iceCode/cells/hash). */
export function computeRowsSha256(rows: readonly ProductSourceBatchRow[]): string {
  return sha256Hex(
    canonicalJson(
      rows.map((row) => ({
        rowNumber: row.rowNumber,
        isBusinessRow: row.isBusinessRow,
        iceCode: row.iceCode,
        cells: row.cells,
        rowSha256: row.rowSha256,
      })),
    ),
  );
}

/** Digest of the adoption updates of a plan (baseline_release.adoption_sha256). */
export function computeAdoptionDigest(payload: Pick<ProductSourcePlanPayload, 'results'>): string {
  const entries = payload.results
    .flatMap((result) =>
      result.adoptions.map((adoption) => ({
        itemId: result.itemId,
        sourceKey: result.sourceKey,
        fieldKey: adoption.fieldKey,
        raw: adoption.raw,
        state: adoption.state,
        unitState: adoption.unitState,
      })),
    )
    .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  return sha256Hex(canonicalJson(entries));
}

const SHA256_HEX = /^[a-f0-9]{64}$/;
const ORIGINS: readonly SnapshotOrigin[] = ['real_capture', 'local_simulation'];

export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Structural check of an untrusted JSON document loaded from disk. */
export function assertSnapshotShape(value: unknown): SourceSnapshot {
  const fail = (detail: string): never => {
    throw new ProductSourceReaderError('SOURCE_SNAPSHOT_INVALID', detail);
  };
  if (!isRecord(value)) fail('快照不是 JSON 对象');
  const snapshot = value as Record<string, unknown>;
  if (snapshot.contract !== SNAPSHOT_CONTRACT) fail(`快照 contract 不是 ${SNAPSHOT_CONTRACT}`);
  if (typeof snapshot.profileKey !== 'string' || snapshot.profileKey === '') fail('快照缺少 profileKey');
  if (!isSha256Hex(snapshot.snapshotKey)) fail('快照 snapshotKey 不是 64 位小写十六进制');
  if (typeof snapshot.origin !== 'string' || !ORIGINS.includes(snapshot.origin as SnapshotOrigin)) {
    fail('快照 origin 非法');
  }
  if (typeof snapshot.capturedAt !== 'string' || Number.isNaN(Date.parse(snapshot.capturedAt))) {
    fail('快照 capturedAt 不是合法 ISO 时间');
  }
  if (!isRecord(snapshot.collection)) fail('快照缺少 collection');
  const collection = snapshot.collection as Record<string, unknown>;
  if (!isRecord(collection.headers)) fail('快照 collection.headers 非法');
  for (const key of ['gridRows', 'gridColumns', 'businessRowCount', 'emptyRowCount', 'headerRow']) {
    if (typeof collection[key] !== 'number' || !Number.isInteger(collection[key] as number)) fail(`collection.${key} 非法`);
  }
  if (!Array.isArray(snapshot.rows)) fail('快照 rows 非法');
  const rawRows = snapshot.rows as unknown[];
  for (const rawRowValue of rawRows) {
    if (!isRecord(rawRowValue)) fail('快照行不是对象');
    const rawRow = rawRowValue as Record<string, unknown>;
    if (typeof rawRow.rowNumber !== 'number' || !Number.isInteger(rawRow.rowNumber)) fail('快照行号非法');
    if (!isRecord(rawRow.cells)) fail(`第 ${String(rawRow.rowNumber)} 行 cells 非法`);
    if (!isRecord(rawRow.fields)) fail(`第 ${String(rawRow.rowNumber)} 行 fields 非法`);
    if (!isSha256Hex(rawRow.rowSha256)) fail(`第 ${String(rawRow.rowNumber)} 行 rowSha256 非法`);
  }
  return value as unknown as SourceSnapshot;
}

/** True when the stored snapshotKey matches the content (rows + collection). */
export function verifySnapshotKey(snapshot: Pick<SourceSnapshot, 'snapshotKey' | 'collection' | 'rows'>): boolean {
  return computeSnapshotKey(snapshot) === snapshot.snapshotKey;
}

export { SOURCE_PROFILE_KEY };
