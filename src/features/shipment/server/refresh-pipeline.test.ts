import { describe, expect, it } from 'vitest';

import {
  ShipmentSourceError,
  type IngestShipmentSnapshot,
  type ShipmentGroupingContextDto,
  type ShipmentIdentityIndexRow,
} from '../types';
import { applyGroupingInterpretationHash } from '../grouping';
import { runShipmentRefresh, type ShipmentRefreshDeps } from './refresh-pipeline';
import type { ShipmentSnapshotRawDto } from './normalize';

const HEADERS = ['产品', '数量', '国家', '报关方式', '运单号', '采购单号', '物流情况', '预计到货时间'];

const SNAPSHOT_ID = '33333333-3333-4333-8333-333333333333';
const PREVIOUS_SNAPSHOT_ID = '44444444-4444-4444-8444-444444444444';
const SHIPMENT_A = '55555555-5555-4555-8555-555555555555';
const SHIPMENT_B = '66666666-6666-4666-8666-666666666666';

function fakeRead(values: Array<Array<string | number | null>> = [
  HEADERS,
  ['ICE LERSKIN 测试款', 10, '泰国', '海运', '', 'PO-TEST-001', '运输中', ''],
]) {
  return {
    collection: {
      sourceKey: 'feishu_logistics_sheet',
      url: 'http://controlled.local/test',
      docTitle: '受控测试表',
      docToken: 'doc',
      documentEditedAt: '2026-11-03T01:00:00.000Z',
      sheetId: 'sheet',
      sheetTitle: 'Sheet1',
      revision: 900,
      readStartedAt: '2026-11-03T01:00:01.000Z',
      readFinishedAt: '2026-11-03T01:00:02.000Z',
      readBy: null,
      gridRows: values.length,
      readRows: values.length,
      lastNonEmptyRow: values.length,
      headers: [],
      merges: [],
      rawContentHash: 'a'.repeat(64),
    },
    values,
    merges: [],
  };
}

/** 上一成功读取的原始网格（拆/合票检测的「上一侧」）。 */
function fakeRaw(
  values: Array<Array<string | number | null>>,
  snapshotId: string | null = PREVIOUS_SNAPSHOT_ID,
): ShipmentSnapshotRawDto {
  const read = fakeRead(values);
  return {
    snapshotId,
    values: read.values,
    merges: [],
    collection: read.collection,
  };
}

function identityRow(ticketKey: string, shipmentId: string, productNames: string[]): ShipmentIdentityIndexRow {
  return {
    shipmentId,
    ticketKey,
    purchaseOrder: ticketKey.startsWith('PO:') ? ticketKey.slice(3) : null,
    waybillsText: ticketKey.startsWith('WB:') ? ticketKey.slice(3) : null,
    market: '泰国',
    customsMethod: '海运',
    productNameNorms: productNames,
    identityStatus: 'confirmed',
    identityNote: null,
  };
}

function groupingContext(overrides: ShipmentGroupingContextDto['overrides'] = []): ShipmentGroupingContextDto {
  return { snapshotId: PREVIOUS_SNAPSHOT_ID, tickets: [], overrides, reviewSignatures: [] };
}

function baseDeps(overrides: Partial<ShipmentRefreshDeps> = {}) {
  const calls: {
    ingest: IngestShipmentSnapshot[];
    failures: unknown[];
    reviews: unknown[];
  } = { ingest: [], failures: [], reviews: [] };
  const deps: ShipmentRefreshDeps = {
    readBy: '11111111-1111-4111-8111-111111111101',
    readSource: async () => fakeRead(),
    identityIndex: async () => [],
    grouping: async () => groupingContext(),
    previousSnapshotRaw: async () => null,
    ingest: async (snapshot) => {
      calls.ingest.push(snapshot);
      return {
        ok: true,
        readAt: '2026-11-03T01:00:02.000Z',
        snapshotId: SNAPSHOT_ID,
        ticketCount: 1,
        itemCount: 1,
        createdTickets: 1,
        updatedTickets: 0,
        unchangedTickets: 0,
        createdItems: 1,
        updatedItems: 0,
        revisionsAdded: 2,
        associationsPreserved: 0,
        absentTickets: 0,
        absentItems: 0,
        adoptedAssociations: 2,
        errorCode: null,
        errorMessage: null,
      };
    },
    recordGroupingReviews: async (reviews) => {
      calls.reviews.push(...reviews);
    },
    recordFailure: async (failure) => {
      calls.failures.push(failure);
    },
    now: () => new Date('2026-11-03T01:00:03.000Z'),
    ...overrides,
  };
  return { deps, calls };
}

describe('runShipmentRefresh（手动刷新与后台定时读取共用流程）', () => {
  it('成功：读取 → 解析 → 身份匹配 → 入库，并保留读取人与采用条数', async () => {
    const { deps, calls } = baseDeps();
    const result = await runShipmentRefresh(deps);
    expect(result.ok).toBe(true);
    expect(result.ticketCount).toBe(1);
    expect(result.itemCount).toBe(1);
    expect(result.adoptedAssociations).toBe(2);
    expect(calls.ingest).toHaveLength(1);
    const snapshot = calls.ingest[0];
    expect(snapshot.collection.readBy).toBe('11111111-1111-4111-8111-111111111101');
    expect(snapshot.tickets[0]?.ticketNo).toBe('PO-TEST-001');
    expect(snapshot.tickets[0]?.market).toBe('泰国');
    expect(snapshot.tickets[0]?.identityStatus).toBe('confirmed');
    expect(snapshot.tickets[0]?.matchedShipmentId).toBeNull();
    expect(calls.failures).toHaveLength(0);
    expect(calls.reviews).toHaveLength(0);
  });

  it('身份匹配：采购单号唯一命中已有票时沿用原票 UUID', async () => {
    const existing: ShipmentIdentityIndexRow[] = [
      identityRow('PO:PO-TEST-001', SHIPMENT_A, ['icelerskin测试款']),
    ];
    const { deps, calls } = baseDeps({ identityIndex: async () => existing });
    const result = await runShipmentRefresh(deps);
    expect(result.ok).toBe(true);
    expect(calls.ingest[0]?.tickets[0]?.matchedShipmentId).toBe(SHIPMENT_A);
  });

  it('失败：读取失败只登记失败（保留上一份成功数据的语义在数据库侧），不调用入库', async () => {
    const { deps, calls } = baseDeps({
      readSource: async () => {
        throw new ShipmentSourceError('SOURCE_CLI_TIMEOUT', 'lark-cli timeout');
      },
    });
    const result = await runShipmentRefresh(deps);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('SOURCE_CLI_TIMEOUT');
    expect(result.errorMessage).toBe('lark-cli timeout');
    expect(calls.ingest).toHaveLength(0);
    expect(calls.failures).toHaveLength(1);
    expect((calls.failures[0] as { readAt: string }).readAt).toBe('2026-11-03T01:00:03.000Z');
  });

  it('非来源异常也保留稳定错误码与原因，不吞错', async () => {
    const { deps } = baseDeps({
      ingest: async () => {
        throw new Error('SHIPMENT_INVALID_INPUT:tickets');
      },
    });
    const result = await runShipmentRefresh(deps);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('SHIPMENT_INVALID_INPUT');
    expect(result.errorMessage).toContain('tickets');
  });

  it('后台读取（readBy=null）不冒充人工操作者', async () => {
    const { deps, calls } = baseDeps({ readBy: null });
    await runShipmentRefresh(deps);
    expect(calls.ingest[0]?.collection.readBy).toBeNull();
  });

  it('内容哈希加入分组解释盐：人工覆盖会让同一份来源重新入库', async () => {
    const { deps, calls } = baseDeps();
    await runShipmentRefresh(deps);
    const collection = calls.ingest[0]!.collection;
    expect(collection.baseContentHash).toBe('a'.repeat(64));
    expect(collection.rawContentHash).toBe(applyGroupingInterpretationHash('a'.repeat(64), []));

    const merged = baseDeps({
      grouping: async () => groupingContext([{
        id: 'ov-1',
        reviewId: 'review-1',
        kind: 'merge',
        signature: 'b'.repeat(64),
        active: true,
        createdAt: '2026-11-03T00:00:00.000Z',
        spec: { kind: 'merge', targetKey: 'WB:X', absorbedKeys: ['WB:Y'] },
      }]),
    });
    await runShipmentRefresh(merged.deps);
    expect(merged.calls.ingest[0]!.collection.rawContentHash)
      .not.toBe(collection.rawContentHash);
  });

  it('首次读取（没有上一成功原始网格）不产生复核', async () => {
    const read = fakeRead([
      HEADERS,
      ['产品A', 10, '泰国', '海运', 'WB-X', '', '运输中', ''],
      ['产品B', 20, '', '', '', '', '', ''],
    ]);
    const { deps, calls } = baseDeps({
      readSource: async () => read,
      identityIndex: async () => [],
      previousSnapshotRaw: async () => null,
    });
    const result = await runShipmentRefresh(deps);
    expect(result.ok).toBe(true);
    expect(calls.reviews).toHaveLength(0);
  });

  it('上一成功原始分组一票、本次原始分组两票 → 登记一条拆票复核（from=上一快照）', async () => {
    const previousValues = [
      HEADERS,
      ['产品A', 10, '泰国', '海运', 'WB-A', '', '运输中', ''],
      ['产品B', 20, '', '', '', '', '', ''],
    ];
    const currentValues = [
      HEADERS,
      ['产品A', 10, '泰国', '海运', 'WB-A', '', '运输中', ''],
      ['产品B', 20, '泰国', '海运', 'WB-B', 'PO-B', '', ''],
    ];
    const { deps, calls } = baseDeps({
      readSource: async () => fakeRead(currentValues),
      identityIndex: async () => [
        identityRow('WB:WB-A', SHIPMENT_A, ['产品a', '产品b']),
        identityRow('PO:PO-B', SHIPMENT_B, ['产品b']),
      ],
      grouping: async () => groupingContext(),
      previousSnapshotRaw: async () => fakeRaw(previousValues),
    });
    const result = await runShipmentRefresh(deps);
    expect(result.ok).toBe(true);
    expect(calls.reviews).toHaveLength(1);
    const review = calls.reviews[0] as {
      kind: string; toSnapshotId: string; fromSnapshotId: string | null;
      evidence: { previous: { snapshotId: string | null }; current: { snapshotId: string | null } };
    };
    expect(review.kind).toBe('split');
    expect(review.fromSnapshotId).toBe(PREVIOUS_SNAPSHOT_ID);
    expect(review.toSnapshotId).toBe(SNAPSHOT_ID);
    expect(review.evidence.previous.snapshotId).toBe(PREVIOUS_SNAPSHOT_ID);
    expect(review.evidence.current.snapshotId).toBe(SNAPSHOT_ID);
    // 普通同步不沿用绑定：deps 里没有 adoptAssociations，且入库票据按人工覆盖后的结果（本次无覆盖）。
    expect(calls.ingest[0]?.tickets).toHaveLength(2);
  });

  it('人工覆盖只控制展示/入库，不遮住后续来源变化：原始分组仍报拆票', async () => {
    const previousValues = [
      HEADERS,
      ['产品A', 10, '泰国', '海运', 'WB-A', '', '运输中', ''],
      ['产品B', 20, '', '', '', '', '', ''],
    ];
    const currentValues = [
      HEADERS,
      ['产品A', 10, '泰国', '海运', 'WB-A', '', '运输中', ''],
      ['产品B', 20, '泰国', '海运', 'WB-B', 'PO-B', '', ''],
    ];
    const { deps, calls } = baseDeps({
      readSource: async () => fakeRead(currentValues),
      identityIndex: async () => [
        identityRow('WB:WB-A', SHIPMENT_A, ['产品a']),
        identityRow('PO:PO-B', SHIPMENT_B, ['产品b']),
      ],
      // 生效中的「仍是一票」覆盖：入库按一票，但检测必须用原始两票。
      grouping: async () => groupingContext([{
        id: 'ov-merge',
        reviewId: 'review-merge',
        kind: 'merge',
        signature: 'e'.repeat(64),
        active: true,
        createdAt: '2026-11-03T00:00:00.000Z',
        spec: { kind: 'merge', targetKey: 'WB:WB-A', absorbedKeys: ['PO:PO-B'] },
      }]),
      previousSnapshotRaw: async () => fakeRaw(previousValues),
    });
    const result = await runShipmentRefresh(deps);
    expect(result.ok).toBe(true);
    // 入库用覆盖后的分组（一票）。
    expect(calls.ingest[0]?.tickets).toHaveLength(1);
    // 检测仍按原始分组报拆票。
    expect(calls.reviews).toHaveLength(1);
    expect((calls.reviews[0] as { kind: string }).kind).toBe('split');
  });

  it('同内容连续同步：相邻两次原始分组相同，不重复提醒', async () => {
    const values = [
      HEADERS,
      ['产品A', 10, '泰国', '海运', 'WB-A', '', '运输中', ''],
      ['产品B', 20, '', '', '', '', '', ''],
    ];
    const { deps, calls } = baseDeps({
      readSource: async () => fakeRead(values),
      identityIndex: async () => [identityRow('WB:WB-A', SHIPMENT_A, ['产品a', '产品b'])],
      previousSnapshotRaw: async () => fakeRaw(values),
    });
    const result = await runShipmentRefresh(deps);
    expect(result.ok).toBe(true);
    expect(calls.reviews).toHaveLength(0);
  });

  it('原票前插入无关新票（原票整体下移）→ 不产生拆/合票复核', async () => {
    const previousValues = [
      HEADERS,
      ['产品A', 10, '泰国', '海运', 'WB-A', '', '运输中', ''],
      ['产品B', 20, '', '', '', '', '', ''],
    ];
    const currentValues = [
      HEADERS,
      ['新产品C', 30, '泰国', '海运', 'WB-NEW', 'PO-NEW', '运输中', ''],
      ['产品A', 10, '泰国', '海运', 'WB-A', '', '运输中', ''],
      ['产品B', 20, '', '', '', '', '', ''],
    ];
    const { deps, calls } = baseDeps({
      readSource: async () => fakeRead(currentValues),
      identityIndex: async () => [
        identityRow('WB:WB-A', SHIPMENT_A, ['产品a', '产品b']),
      ],
      previousSnapshotRaw: async () => fakeRaw(previousValues),
    });
    const result = await runShipmentRefresh(deps);
    expect(result.ok).toBe(true);
    expect(calls.reviews).toHaveLength(0);
  });
});
