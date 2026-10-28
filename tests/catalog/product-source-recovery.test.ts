/**
 * Service-level recovery-chain tests (mocked repository/reader).
 *
 * These tests pin behaviour that cannot be observed from the pure plan or the
 * SQL layer alone:
 * - the original request + full intent is recorded BEFORE submit;
 * - an unknown submit result is reconciled by replaying the STORED intent and
 *   payload instead of rebuilding the plan (which would change the intent);
 * - a known partial failure is retried by re-planning only the failed source
 *   keys and linking the new batch to the failed parent;
 * - successful items stay out of the retry plan, so they are not re-revisioned.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HEADER_CONTRACT,
  SOURCE_PROFILE_KEY,
  type SourceSnapshot,
} from '../../src/features/catalog/product-source/contract';
import { resolveHeaderMapping } from '../../src/features/catalog/product-source/headers';
import { buildRowFields } from '../../src/features/catalog/product-source/normalize';
import { computeSnapshotKey } from '../../src/features/catalog/product-source/reader';

const ADMIN = '11111111-1111-4111-8111-111111111101';
const CODE = 'WM-RECOVERY';
const NAME = '服务恢复测试商品';
const REQUEST_APPLY = '11111111-1111-4111-8111-111111111201';
const REQUEST_STORED = '11111111-1111-4111-8111-111111111202';
const REQUEST_DONE = '11111111-1111-4111-8111-111111111203';
const REQUEST_RETRY = '11111111-1111-4111-8111-111111111204';

const mocks = vi.hoisted(() => ({
  recordIntent: vi.fn(),
  readIntent: vi.fn(),
  receiptByRequest: vi.fn(),
  applyWithIntent: vi.fn(),
  overview: vi.fn(),
  itemState: vi.fn(),
  listSnapshots: vi.fn(),
  readSnapshot: vi.fn(),
  storePrivateArtifact: vi.fn(),
  withAppDb: vi.fn(),
}));

vi.mock('../../src/features/catalog/authorization', () => ({
  requireCatalogAdmin: async () => ({ profileUserId: ADMIN }),
}));

vi.mock('@/lib/database/app-db', () => ({
  withAppDb: (...args: unknown[]) => mocks.withAppDb(...args),
}));

vi.mock('../../src/features/catalog/evidence-store', () => ({
  storePrivateArtifact: (...args: unknown[]) => mocks.storePrivateArtifact(...args),
}));

vi.mock('../../src/features/catalog/product-source/local-reader', () => ({
  createLocalSnapshotReader: () => ({
    profileKey: SOURCE_PROFILE_KEY,
    describe: () => ({ mode: 'local_snapshot', label: '本地模拟读取', detail: '' }),
    listSnapshots: () => mocks.listSnapshots(),
    readSnapshot: (snapshotKey: string) => mocks.readSnapshot(snapshotKey),
  }),
}));

vi.mock('../../src/features/catalog/product-source/repository', async () => ({
  PRODUCT_SOURCE_APPLY_ACTION: 'apply_product_source_batch',
  sourceIntent: (identity: { profileUserId: string }, action: string, payload: unknown) =>
    createHash('sha256')
      .update(JSON.stringify(['iceos-product-source-request-v1', identity.profileUserId, action, payload]))
      .digest('hex'),
  productSourceRepository: {
    recordIntent: (...args: unknown[]) => mocks.recordIntent(...args),
    readIntent: (...args: unknown[]) => mocks.readIntent(...args),
    receiptByRequest: (...args: unknown[]) => mocks.receiptByRequest(...args),
    receipt: vi.fn(),
    applyWithIntent: (...args: unknown[]) => mocks.applyWithIntent(...args),
    overview: (...args: unknown[]) => mocks.overview(...args),
    itemState: (...args: unknown[]) => mocks.itemState(...args),
    resolveIssue: vi.fn(),
    assignCode: vi.fn(),
  },
}));

import { applyProductSourceSnapshot, retryProductSourceSnapshot } from '../../src/features/catalog/product-source/service';

interface ServerState {
  bindings: Array<{ item_id: string; ice_code: string; state: string }>;
  items: Array<{ id: string; revision: number; ice_code: string | null; name_cn: string; fields: unknown }>;
}

let serverState: ServerState;
let tempRoot: string;
let snapshot: SourceSnapshot;

function buildSnapshot(): SourceSnapshot {
  const headers: Record<string, string> = {};
  for (const entry of HEADER_CONTRACT) headers[entry.evidenceColumn] = entry.label;
  for (const column of ['AB', 'AC', 'AD', 'AE']) headers[column] = '';
  const cells: Record<string, string> = {};
  for (const column of Object.keys(headers)) cells[column] = '';
  const resolution = resolveHeaderMapping(headers);
  const put = (fieldKey: string, raw: string) => {
    const column = resolution.fieldColumns[fieldKey as keyof typeof resolution.fieldColumns];
    if (column) cells[column] = raw;
  };
  put('nameCn', NAME);
  put('iceCode', CODE);
  put('cartonQuantity', '24');
  const fields = buildRowFields(cells, resolution.fieldColumns);
  const base = {
    contract: 'ice-product-source-snapshot-v1',
    profileKey: SOURCE_PROFILE_KEY,
    origin: 'local_simulation' as const,
    capturedAt: '2026-10-25T10:00:00.000Z',
    documentModifiedLabel: null,
    collection: {
      method: 'mock_reader' as const,
      url: 'https://example.invalid',
      worksheetTitle: 'Sheet1',
      headerRow: 1,
      requestedRange: 'A1:AE2',
      observedRange: 'A1:AE2',
      gridRows: 2,
      gridColumns: Object.keys(headers).length,
      businessRowCount: 1,
      emptyRowCount: 0,
      complete: true,
      headers,
      rawEvidenceSha256: null,
      rawEvidenceBytes: null,
      truncated: false,
      readError: null,
    },
    simulation: { baseSnapshotKey: 'a'.repeat(64), note: 'test', changes: [] },
    redaction: null,
    rows: [
      {
        rowNumber: 2,
        isBusinessRow: true,
        cells,
        fields,
        rowSha256: createHash('sha256').update(JSON.stringify({ rowNumber: 2, cells, fields })).digest('hex'),
      },
    ],
  };
  return { ...base, snapshotKey: computeSnapshotKey(base) } as SourceSnapshot;
}

function receipt(status: 'applied' | 'partial' = 'applied') {
  return {
    status,
    batchId: 'batch-1',
    snapshotKey: snapshot.snapshotKey,
    counts: { created: 0, updated: status === 'applied' ? 1 : 0, unchanged: 0, needsReview: 0, failed: status === 'partial' ? 1 : 0, missing: 0 },
    results: [],
    message: null,
  };
}

function storedIntent() {
  return {
    requestId: REQUEST_STORED,
    action: 'apply_product_source_batch',
    intentSha256: 'b'.repeat(64),
    profileKey: SOURCE_PROFILE_KEY,
    snapshotKey: snapshot.snapshotKey,
    payload: {
      profile: { profileKey: SOURCE_PROFILE_KEY },
      batch: { snapshotKey: snapshot.snapshotKey, retryOfBatchId: null },
      plan: { results: [{ sourceKey: `code:${CODE}`, action: 'update' }] },
    },
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'product-source-recovery-'));
  process.env.CATALOG_RUN_ROOT = tempRoot;
  fs.mkdirSync(path.join(tempRoot, 'source-snapshots'), { recursive: true });
  snapshot = buildSnapshot();
  fs.writeFileSync(path.join(tempRoot, 'source-snapshots', 'snapshot-test.json'), `${JSON.stringify(snapshot)}\n`, 'utf8');

  serverState = {
    bindings: [{ item_id: 'item-1', ice_code: CODE, state: 'active' }],
    items: [
      {
        id: 'item-1',
        revision: 1,
        ice_code: CODE,
        name_cn: NAME,
        fields: {
          nameCn: { state: 'observed', raw: NAME, meaning: 'value', evidenceRef: 'local:name' },
          cartonQuantity: { state: 'observed', raw: '12', meaning: 'value', evidenceRef: 'local:carton' },
        },
      },
    ],
  };
  mocks.withAppDb.mockImplementation(async (_identity: unknown, fn: (client: unknown) => Promise<unknown>) =>
    fn({
      query: async (sql: string) => {
        if (sql.includes('FROM catalog.product_source_binding')) return { rows: serverState.bindings };
        if (sql.includes('FROM catalog.catalog_item i')) return { rows: serverState.items };
        if (sql.includes('FROM catalog.product_source_adoption')) return { rows: [] };
        if (sql.includes('FROM catalog.product_source_batch b')) return { rows: [] };
        return { rows: [] };
      },
    }),
  );
  mocks.listSnapshots.mockResolvedValue([
    { snapshotKey: snapshot.snapshotKey, capturedAt: snapshot.capturedAt, origin: snapshot.origin, complete: true, fileName: 'snapshot-test.json' },
  ]);
  mocks.readSnapshot.mockImplementation(async () => snapshot);
  mocks.storePrivateArtifact.mockImplementation(async (logicalName: string, bytes: Buffer) => ({
    logicalName,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
    format: 'json',
    storageHandle: `memory://${logicalName}`,
  }));
  mocks.recordIntent.mockResolvedValue({ recorded: true });
  mocks.readIntent.mockResolvedValue(null);
  mocks.receiptByRequest.mockResolvedValue(null);
  mocks.applyWithIntent.mockResolvedValue(receipt('applied'));
});

afterEach(() => {
  delete process.env.CATALOG_RUN_ROOT;
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('product source recovery chain (service)', () => {
  it('records the original request and full intent before submitting, then applies exactly once', async () => {
    const result = await applyProductSourceSnapshot({ requestId: REQUEST_APPLY, snapshotKey: snapshot.snapshotKey });

    expect(result.message).toContain('本批处理完成');
    expect(mocks.recordIntent).toHaveBeenCalledTimes(1);
    expect(mocks.applyWithIntent).toHaveBeenCalledTimes(1);
    expect(mocks.recordIntent.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.applyWithIntent.mock.invocationCallOrder[0],
    );
    const stored = mocks.recordIntent.mock.calls[0][6] as {
      batch: { retryOfBatchId: unknown };
      plan: { results: Array<{ sourceKey: string }> };
    };
    expect(stored.batch.retryOfBatchId).toBeNull();
    expect(stored.plan.results.map((entry) => entry.sourceKey)).toContain(`code:${CODE}`);
    const appliedArgs = mocks.applyWithIntent.mock.calls[0];
    expect(appliedArgs[1]).toBe(REQUEST_APPLY);
    expect(appliedArgs[2]).toBe(mocks.recordIntent.mock.calls[0][3]);
  });

  it('reconciles an unknown submit result by replaying the stored request instead of rebuilding the plan', async () => {
    const stored = storedIntent();
    mocks.readIntent.mockResolvedValue(stored);

    const result = await retryProductSourceSnapshot({ requestId: REQUEST_STORED, snapshotKey: snapshot.snapshotKey });

    expect(result.message).toContain('已核对到原请求回执');
    expect(result.message).toContain('未重复修订');
    expect(mocks.readSnapshot).not.toHaveBeenCalled();
    expect(mocks.applyWithIntent).toHaveBeenCalledTimes(1);
    const args = mocks.applyWithIntent.mock.calls[0];
    expect(args[1]).toBe(REQUEST_STORED);
    expect(args[2]).toBe(stored.intentSha256);
    expect(args[4]).toEqual(stored.payload.batch);
    expect(args[5]).toEqual(stored.payload.plan);
  });

  it('returns the original receipt for an already completed request without re-planning', async () => {
    mocks.readIntent.mockResolvedValue(null);
    mocks.receiptByRequest.mockResolvedValue(receipt('applied'));

    const result = await applyProductSourceSnapshot({ requestId: REQUEST_DONE, snapshotKey: snapshot.snapshotKey });

    expect(result.message).toContain('已核对到原请求回执');
    expect(mocks.readSnapshot).not.toHaveBeenCalled();
    expect(mocks.applyWithIntent).not.toHaveBeenCalled();
  });

  it('retries a known partial failure with only the failed source keys and links the retry batch to its parent', async () => {
    mocks.overview.mockResolvedValue({
      latest: { batchId: 'parent-batch', snapshotKey: snapshot.snapshotKey, status: 'partial', counts: {}, message: null, capturedAt: '2026-10-25T10:00:00.000Z', origin: 'local_simulation', sourceModifiedLabel: null, collection: {} },
      results: [{ sourceKey: `code:${CODE}`, action: 'failed', reasonCode: 'CATALOG_REVISION_CONFLICT' }],
      batches: [],
      issues: [],
      source: {},
      bindingCount: 1,
    });

    const result = await retryProductSourceSnapshot({ requestId: REQUEST_RETRY, snapshotKey: snapshot.snapshotKey });

    expect(result.message).toContain('失败项补做完成');
    expect(result.message).toContain('成功商品未重复修订');
    expect(mocks.applyWithIntent).toHaveBeenCalledTimes(1);
    const stored = mocks.recordIntent.mock.calls[0][6] as {
      batch: { retryOfBatchId: string };
      plan: { results: Array<{ sourceKey: string }> };
    };
    expect(stored.batch.retryOfBatchId).toBe('parent-batch');
    expect(stored.plan.results.map((entry) => entry.sourceKey)).toEqual([`code:${CODE}`]);
  });

  it('refuses a supplement retry when the latest batch has no failed item keys', async () => {
    mocks.overview.mockResolvedValue({
      latest: { batchId: 'parent-batch', snapshotKey: snapshot.snapshotKey, status: 'failed', counts: {}, message: null, createdAt: '2026-10-25T10:00:00.000Z', capturedAt: '2026-10-25T10:00:00.000Z', origin: 'local_simulation', sourceModifiedLabel: null, collection: {} },
      results: [{ sourceKey: 'batch', action: 'failed', reasonCode: 'SNAPSHOT_INCOMPLETE' }],
      batches: [],
      issues: [],
      source: {},
      bindingCount: 0,
    });

    await expect(retryProductSourceSnapshot({ requestId: REQUEST_RETRY, snapshotKey: snapshot.snapshotKey }))
      .rejects.toThrow('CATALOG_SOURCE_RETRY_NOTHING');
    expect(mocks.applyWithIntent).not.toHaveBeenCalled();
  });
});
