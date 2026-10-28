import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { BASELINE_DIRECTORY } from '@/features/catalog/sources/baseline-adapter';
import {
  DOMESTIC_RELEASE_KEY,
  DOMESTIC_SOURCE_RECORDS_SHA256,
  DOMESTIC_WAREHOUSE_LABEL,
  buildDomesticSnapshot,
  fileDateFromOriginalName,
  loadDomesticSource,
  parseDomesticQuantity,
  parseDomesticSourceRecords,
  unavailableDomesticSnapshot,
  type DomesticFrozenRecord,
  type DomesticLinkRecord,
} from '@/features/inventory/domestic/snapshot';
import type { InventoryDomesticRowDto } from '@/features/inventory/types';

/**
 * 国内聚水潭冻结表格快照（UI-04）纯逻辑测试。
 * - 读真实冻结文件验证 887 / 118 / 877+10 / 111+7 与商品 UUID 关联口径；
 * - 数量异常不转 0；未确认为有效选择的记录可查但不计入；
 * - DTO 不携带私有原始 bundle/价格字段。
 * 文件缺失时冻结文件相关用例整体 skip（不伪造 fixture）。
 */

const FROZEN_INPUT_2_SHA256 = '9f42843af2bfe1828f07e8ac7c96c57b16d1c397026184ed893cc2ab9de563f8';
const FROZEN_INPUT_3_SHA256 = '7fca9bee434847ff62582b85497c7af76d8b03b32d3e599a4db029fa91fc019f';
const FILE_20261015 = '商品资料_20261015165159_200874071_1.xlsx';
const FILE_20261016 = '商品资料_20261016111727_201045638_1.xlsx';

const sourcePath = path.resolve(process.cwd(), BASELINE_DIRECTORY, 'coverage', 'source-records.json');
const hasFrozen = fs.existsSync(sourcePath);
const describeFrozen = hasFrozen ? describe : describe.skip;

function syntheticRecord(overrides: Partial<DomesticFrozenRecord> = {}): DomesticFrozenRecord {
  return {
    legacyCandidateId: 'mc-test-1',
    frozenReviewState: 'pending',
    sourceSku: 'TEST-1',
    sourceName: '测试来源名称',
    sheet: 'Sheet1',
    excelRow: 2,
    fileName: FILE_20261015,
    fileDate: '2026-10-15',
    frozenFileSha256: FROZEN_INPUT_2_SHA256,
    rawActualText: '3800',
    rawAvailableText: '3000',
    cloudAvailableText: null,
    actualQty: 3800,
    availableQty: 3000,
    quantityState: 'ok',
    ...overrides,
  };
}

function syntheticLink(overrides: Partial<DomesticLinkRecord> = {}): DomesticLinkRecord {
  return {
    legacyCandidateId: 'mc-test-1',
    reviewState: 'manual_selected',
    sourceSku: 'TEST-1',
    sourceName: '测试来源名称',
    sheet: 'Sheet1',
    excelRow: 2,
    itemId: '11111111-1111-4111-8111-111111111102',
    iceCode: 'WM0003',
    itemNameCn: '测试标准商品',
    ...overrides,
  };
}

describe('parseDomesticQuantity', () => {
  it('只把能确定为整数的文本转成 number', () => {
    expect(parseDomesticQuantity('3800')).toEqual({ qty: 3800, state: 'ok', raw: '3800' });
    expect(parseDomesticQuantity('3,800')).toEqual({ qty: 3800, state: 'ok', raw: '3,800' });
    expect(parseDomesticQuantity('3800.0')).toEqual({ qty: 3800, state: 'ok', raw: '3800.0' });
    expect(parseDomesticQuantity('-2')).toEqual({ qty: -2, state: 'ok', raw: '-2' });
    expect(parseDomesticQuantity('0')).toEqual({ qty: 0, state: 'ok', raw: '0' });
    expect(parseDomesticQuantity(12)).toEqual({ qty: 12, state: 'ok', raw: '12' });
  });

  it('缺失与空白标为 missing，不转 0', () => {
    expect(parseDomesticQuantity(null)).toEqual({ qty: null, state: 'missing', raw: null });
    expect(parseDomesticQuantity(undefined)).toEqual({ qty: null, state: 'missing', raw: null });
    expect(parseDomesticQuantity('')).toEqual({ qty: null, state: 'missing', raw: '' });
    expect(parseDomesticQuantity('   ')).toEqual({ qty: null, state: 'missing', raw: '   ' });
  });

  it('小数、单位文本、非数字字符串标为 invalid，不四舍五入、不猜', () => {
    for (const value of ['3.8', '3800.5', '3,80', '约3800', '3800个', '1e3', '3,800.5', '--1', true, {}, []]) {
      expect(parseDomesticQuantity(value)).toEqual({ qty: null, state: 'invalid', raw: typeof value === 'string' ? value : null });
    }
  });
});

describe('fileDateFromOriginalName', () => {
  it('只从文件名中的 8 位日期取 YYYY-MM-DD', () => {
    expect(fileDateFromOriginalName(FILE_20261015)).toBe('2026-10-15');
    expect(fileDateFromOriginalName(FILE_20261016)).toBe('2026-10-16');
  });

  it('文件名没有合法日期时返回 null，不编造日期', () => {
    expect(fileDateFromOriginalName('商品资料.xlsx')).toBeNull();
    expect(fileDateFromOriginalName('商品资料_20261301120000_1.xlsx')).toBeNull();
    expect(fileDateFromOriginalName('商品资料_20260230120000_1.xlsx')).toBeNull();
  });
});

describe('buildDomesticSnapshot 归集口径', () => {
  it('只有 manual_selected 且关联到商品 UUID 的记录计入国内汇总', () => {
    const records = [
      syntheticRecord({ legacyCandidateId: 'mc-a', sourceSku: 'SKU-A' }),
      syntheticRecord({ legacyCandidateId: 'mc-b', sourceSku: 'SKU-B', actualQty: 7, rawActualText: '7' }),
      syntheticRecord({ legacyCandidateId: 'mc-c', sourceSku: 'SKU-C' }),
    ];
    const links = [
      syntheticLink({ legacyCandidateId: 'mc-a', itemId: 'item-a' }),
      syntheticLink({ legacyCandidateId: 'mc-b', itemId: null, iceCode: null, itemNameCn: null }),
      syntheticLink({ legacyCandidateId: 'mc-c', reviewState: 'pending', itemId: null }),
    ];
    const snapshot = buildDomesticSnapshot({
      records,
      links,
      sourceRecordsSha256: DOMESTIC_SOURCE_RECORDS_SHA256,
      cached: false,
    });
    expect(snapshot.available).toBe(true);
    expect(snapshot.reason).toBeNull();
    expect(snapshot.releaseKey).toBe(DOMESTIC_RELEASE_KEY);
    expect(snapshot.recordCount).toBe(3);
    expect(snapshot.selectedCount).toBe(2);
    expect(snapshot.linkedSelectedCount).toBe(1);
    expect(snapshot.unlinkedSelectedCount).toBe(1);
    expect(snapshot.linkedItemCount).toBe(1);
    const unlinked = snapshot.rows.find((row) => row.legacyCandidateId === 'mc-b');
    expect(unlinked?.itemId).toBeNull();
    expect(unlinked?.actualQty).toBe(7);
    expect(unlinked?.note).toContain('未计入国内汇总');
    const notSelected = snapshot.rows.find((row) => row.legacyCandidateId === 'mc-c');
    expect(notSelected?.actualQty).toBe(3800);
    expect(notSelected?.note).toContain('非冻结有效选择');
  });

  it('缺值/异常数量保留 null 与状态，不写成 0', () => {
    const missing = parseDomesticQuantity(null);
    const invalid = parseDomesticQuantity('待盘点');
    const snapshot = buildDomesticSnapshot({
      records: [
        syntheticRecord({ legacyCandidateId: 'mc-missing', rawActualText: missing.raw, actualQty: missing.qty, quantityState: missing.state }),
        syntheticRecord({ legacyCandidateId: 'mc-invalid', rawActualText: invalid.raw, actualQty: invalid.qty, quantityState: invalid.state }),
        syntheticRecord({ legacyCandidateId: 'mc-zero', actualQty: 0, rawActualText: '0' }),
      ],
      links: [syntheticLink({ legacyCandidateId: 'mc-missing', itemId: 'item-m' })],
      sourceRecordsSha256: DOMESTIC_SOURCE_RECORDS_SHA256,
      cached: true,
    });
    expect(snapshot.cached).toBe(true);
    const byId = new Map(snapshot.rows.map((row) => [row.legacyCandidateId, row]));
    expect(byId.get('mc-missing')?.actualQty).toBeNull();
    expect(byId.get('mc-missing')?.quantityState).toBe('missing');
    expect(byId.get('mc-invalid')?.actualQty).toBeNull();
    expect(byId.get('mc-invalid')?.quantityState).toBe('invalid');
    expect(byId.get('mc-zero')?.actualQty).toBe(0);
    expect(byId.get('mc-zero')?.quantityState).toBe('ok');
  });

  it('单位/仓库/观测时间不补造：unit=null、warehouseLabel 固定、无 observationAt 字段', () => {
    const snapshot = buildDomesticSnapshot({
      records: [syntheticRecord()],
      links: [syntheticLink()],
      sourceRecordsSha256: DOMESTIC_SOURCE_RECORDS_SHA256,
      cached: false,
    });
    const row = snapshot.rows[0] as InventoryDomesticRowDto;
    expect(row.unit).toBeNull();
    expect(row.warehouseLabel).toBe(DOMESTIC_WAREHOUSE_LABEL);
    expect(row.cloudAvailableText).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(row, 'observationAt')).toBe(false);
    expect(Object.keys(row).sort()).toEqual([
      'actualQty', 'availableQty', 'cloudAvailableText', 'excelRow', 'externalSku', 'fileDate', 'fileName',
      'frozenFileSha256', 'iceCode', 'itemId', 'itemNameCn', 'legacyCandidateId', 'note', 'quantityState',
      'rawActualText', 'rawAvailableText', 'reviewState', 'sheet', 'source', 'sourceName', 'unit', 'warehouseLabel',
    ]);
  });

  it('DTO 不携带私有原始 bundle/价格字段', () => {
    const snapshot = buildDomesticSnapshot({
      records: [syntheticRecord()],
      links: [syntheticLink()],
      sourceRecordsSha256: DOMESTIC_SOURCE_RECORDS_SHA256,
      cached: false,
    });
    const serialized = JSON.stringify(snapshot);
    for (const privateToken of ['selected_master', 'match-bundle.json', 'original_path', 'candidate_targets',
      'payload', 'review_notes', '成本价格', '运营价格', 'cost', 'price']) {
      expect(serialized).not.toContain(privateToken);
    }
  });

  it('未读取/失败时 available=false 且不提供行，不使用 0 冒充成功', () => {
    const snapshot = unavailableDomesticSnapshot('国内冻结快照文件缺失，未读取数量');
    expect(snapshot.available).toBe(false);
    expect(snapshot.reason).toContain('未读取数量');
    expect(snapshot.rows).toEqual([]);
    expect(snapshot.fileDates).toEqual([]);
  });

  it('parseDomesticSourceRecords 对非聚水潭记录忽略、对畸形记录报错', () => {
    const jst = {
      candidate_id: 'mc-1',
      source: { source_system: 'jushuitan', external_sku_raw: 'SKU-1', external_name: '名称', available_qty: '3', extra: { actual_qty: '2', cloud_available_qty: 'x' } },
      provenance: { effective_origin: { original_file: FILE_20261015, sha256: FROZEN_INPUT_2_SHA256, sheet: 'Sheet1', excel_row: 2 } },
      review_state: 'manual_selected',
    };
    const bs = { source: { source_system: 'bigseller' } };
    const parsed = parseDomesticSourceRecords([jst, bs]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.actualQty).toBe(2);
    expect(parsed[0]?.availableQty).toBe(3);
    expect(parsed[0]?.cloudAvailableText).toBe('x');
    expect(parsed[0]?.fileDate).toBe('2026-10-15');
    expect(() => parseDomesticSourceRecords({})).toThrow(/DOMESTIC_SOURCE_DOCUMENT_INVALID/);
    expect(() => parseDomesticSourceRecords([{ candidate_id: 'mc-x', source: { source_system: 'jushuitan' } }])).toThrow(/DOMESTIC_SOURCE_RECORD_INVALID/);
  });
});

describeFrozen('冻结文件（真实 coverage/source-records.json）', () => {
  it('SHA256 固定，解析出 887 条聚水潭来源记录', async () => {
    const source = await loadDomesticSource();
    expect(source.sourceRecordsSha256).toBe(DOMESTIC_SOURCE_RECORDS_SHA256);
    expect(source.records).toHaveLength(887);
    expect(new Set(source.records.map((record) => record.legacyCandidateId)).size).toBe(887);
  });

  it('文件分布 877 + 10，选择分布 111 + 7，日期各自来自原文件名', async () => {
    const source = await loadDomesticSource();
    const byFile = new Map<string, { count: number; selected: number; dates: Set<string>; shas: Set<string> }>();
    for (const record of source.records) {
      const entry = byFile.get(record.fileName) ?? { count: 0, selected: 0, dates: new Set<string>(), shas: new Set<string>() };
      entry.count += 1;
      if (record.frozenReviewState === 'manual_selected') entry.selected += 1;
      entry.dates.add(record.fileDate);
      entry.shas.add(record.frozenFileSha256);
      byFile.set(record.fileName, entry);
    }
    expect(Object.fromEntries([...byFile].map(([file, entry]) => [file, entry.count]))).toEqual({
      [FILE_20261015]: 877,
      [FILE_20261016]: 10,
    });
    expect(byFile.get(FILE_20261015)?.selected).toBe(111);
    expect(byFile.get(FILE_20261016)?.selected).toBe(7);
    expect([...(byFile.get(FILE_20261015)?.dates ?? [])]).toEqual(['2026-10-15']);
    expect([...(byFile.get(FILE_20261016)?.dates ?? [])]).toEqual(['2026-10-16']);
    expect([...(byFile.get(FILE_20261015)?.shas ?? [])]).toEqual([FROZEN_INPUT_2_SHA256]);
    expect([...(byFile.get(FILE_20261016)?.shas ?? [])]).toEqual([FROZEN_INPUT_3_SHA256]);
  });

  it('118 条 manual_selected；数量原文都是整数，0 保留为 0，负数原样保留', async () => {
    const source = await loadDomesticSource();
    const selected = source.records.filter((record) => record.frozenReviewState === 'manual_selected');
    expect(selected).toHaveLength(118);
    expect(source.records.every((record) => record.quantityState === 'ok')).toBe(true);
    expect(source.records.every((record) => record.actualQty !== null && Number.isInteger(record.actualQty))).toBe(true);
    expect(source.records.every((record) => record.availableQty !== null && Number.isInteger(record.availableQty))).toBe(true);
    expect(source.records.some((record) => record.actualQty === 0)).toBe(true);
    // 可用数里有负数（原表欠账/超卖），保留原值，不并入实际库存数。
    expect(source.records.some((record) => (record.availableQty ?? 0) < 0)).toBe(true);
    expect(source.records.some((record) => record.cloudAvailableText !== null)).toBe(false);
    for (const record of source.records) {
      expect(record.rawActualText).toBe(String(record.actualQty));
      expect(record.rawAvailableText).toBe(String(record.availableQty));
      expect(record.cloudAvailableText).toBeNull();
    }
    expect(source.records.filter((record) => record.actualQty === 0)).toHaveLength(46);
  });

  it('用 118 条有效选择构造关联后：118/118 已关联、WM0003 国内合计 2375 来自原表记录', async () => {
    const source = await loadDomesticSource();
    const links: DomesticLinkRecord[] = source.records
      .filter((record) => record.frozenReviewState === 'manual_selected')
      .map((record) => ({
        legacyCandidateId: record.legacyCandidateId,
        reviewState: 'manual_selected',
        sourceSku: record.sourceSku,
        sourceName: record.sourceName,
        sheet: record.sheet,
        excelRow: record.excelRow,
        itemId: `item-${record.sourceSku}`,
        iceCode: record.sourceSku,
        itemNameCn: record.sourceName,
      }));
    const snapshot = buildDomesticSnapshot({
      records: source.records,
      links,
      sourceRecordsSha256: source.sourceRecordsSha256,
      cached: false,
    });
    expect(snapshot.recordCount).toBe(887);
    expect(snapshot.selectedCount).toBe(118);
    expect(snapshot.linkedSelectedCount).toBe(118);
    expect(snapshot.unlinkedSelectedCount).toBe(0);
    expect(snapshot.linkedItemCount).toBe(118);
    expect(snapshot.fileDates.map((entry) => [entry.fileDate, entry.recordCount])).toEqual([
      ['2026-10-15', 877],
      ['2026-10-16', 10],
    ]);
    const wm0003 = snapshot.rows.filter((row) => row.iceCode === 'WM0003' && row.reviewState === 'manual_selected');
    expect(wm0003).toHaveLength(1);
    expect(wm0003[0]?.actualQty).toBe(2375);
    expect(wm0003[0]?.fileDate).toBe('2026-10-15');
    // 抽样：其余记录仍是来源现状，不因未计入而消失。
    expect(snapshot.rows.filter((row) => row.reviewState === 'manual_selected')).toHaveLength(118);
    expect(snapshot.rows.filter((row) => row.reviewState !== 'manual_selected')).toHaveLength(769);
  });
});
