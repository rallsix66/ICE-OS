import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  collectFactoryFormulaErrors,
  readFactoryFormulaErrorGroup,
  readFactoryFormulaErrorState,
} from '../product-source/service';
import { computeRowSha256, computeSnapshotKey } from '../product-source/reader';
import type { SourceRow, SourceSnapshot } from '../product-source/contract';

/**
 * 飞书原表「生产工厂」公式错误纯函数：
 * 93 个 #REF! 合并为一条；在原表修好一行（93→92）后，该行立即从明细消失。
 * 数据形状按真实快照构造（133 业务行 = 93 错误 + 39 空 + 1 手填），不依赖本机 .local 文件。
 */

const CAPTURED_AT = '2026-11-11T10:12:58.552Z';

function formulaErrorRow(rowNumber: number, iceCode: string, nameCn: string): SourceRow {
  return {
    rowNumber,
    isBusinessRow: true,
    cells: { B: nameCn, E: '#REF!', G: iceCode },
    fields: { factory: { raw: '#REF!', state: 'parse_failed', reason: 'SOURCE_FORMULA_ERROR' } },
    rowSha256: `row-${rowNumber}`,
  };
}

function factoryRow(
  rowNumber: number,
  iceCode: string,
  nameCn: string,
  factory: SourceRow['fields']['factory'],
  cells: SourceRow['cells'] = {},
): SourceRow {
  return {
    rowNumber,
    isBusinessRow: true,
    cells: { B: nameCn, E: '', G: iceCode, ...cells },
    fields: { factory },
    rowSha256: `row-${rowNumber}`,
  };
}

/** 与现役快照一致的行数口径：133 业务行（93 错误 / 39 空 / 1 手填）+ 1 条非业务行。 */
function buildSnapshotRows(): SourceRow[] {
  const rows: SourceRow[] = [formulaErrorRow(3, 'LS101295', 'ICE LERSKIN海茴香焕肤水')];
  for (let index = 1; index < 93; index += 1) {
    rows.push(formulaErrorRow(3 + index, `LS10${String(1295 + index)}`, `测试品名${index + 1}`));
  }
  for (let index = 0; index < 39; index += 1) {
    rows.push(factoryRow(100 + index, `LS20${index}`, `空工厂${index}`, { raw: '', state: 'explicit_empty' }));
  }
  rows.push(factoryRow(200, 'LS3000', '手填工厂商品', { raw: '广州某工厂', state: 'observed' }, { E: '广州某工厂' }));
  // 非业务行即使带公式错误也不计入。
  rows.push({
    rowNumber: 401,
    isBusinessRow: false,
    cells: { B: '', E: '#REF!', G: '' },
    fields: { factory: { raw: '#REF!', state: 'parse_failed', reason: 'SOURCE_FORMULA_ERROR' } },
    rowSha256: 'row-401',
  });
  return rows;
}

function snapshotOf(rows: SourceRow[]): Pick<SourceSnapshot, 'rows' | 'capturedAt'> {
  return { rows, capturedAt: CAPTURED_AT };
}

describe('collectFactoryFormulaErrors（飞书原表生产工厂公式错误）', () => {
  it('合并统计 93 个 #REF!，逐行给货号/品名/单元格/错误原文', () => {
    const result = collectFactoryFormulaErrors(snapshotOf(buildSnapshotRows()));
    expect(result).not.toBeNull();
    expect(result!.count).toBe(93);
    expect(result!.capturedAt).toBe(CAPTURED_AT);
    expect(result!.rows).toHaveLength(93);
    expect(result!.rows[0]).toEqual({
      iceCode: 'LS101295',
      nameCn: 'ICE LERSKIN海茴香焕肤水',
      cell: 'E3',
      error: '#REF!',
    });
    // 空白 E 列与手填值不属于公式错误；非业务行不进入明细。
    expect(result!.rows.some((row) => row.nameCn === '手填工厂商品')).toBe(false);
    expect(result!.rows.some((row) => row.cell === 'E401')).toBe(false);
  });

  it('原表修好一行后（93→92）该行立即从明细消失，条目仍保留其余 92 条', () => {
    const rows = buildSnapshotRows();
    const fixed = rows.map((row) => (
      row.rowNumber === 3
        ? factoryRow(
          row.rowNumber,
          'LS101295',
          'ICE LERSKIN海茴香焕肤水',
          { raw: '广州某工厂', state: 'observed' },
          { E: '广州某工厂' },
        )
        : row
    ));
    const before = collectFactoryFormulaErrors(snapshotOf(rows));
    const after = collectFactoryFormulaErrors(snapshotOf(fixed));
    expect(before!.count).toBe(93);
    expect(after!.count).toBe(92);
    expect(after!.rows.some((row) => row.cell === 'E3')).toBe(false);
    expect(after!.rows.some((row) => row.cell === 'E4')).toBe(true);
  });

  it('没有公式错误（全部空/手填）时返回 null，不伪造成 0 项', () => {
    const rows = buildSnapshotRows().filter((row) => row.rowNumber !== 401).filter((row) => {
      const factory = row.fields.factory;
      return !(factory?.state === 'parse_failed' && factory.reason === 'SOURCE_FORMULA_ERROR');
    });
    expect(collectFactoryFormulaErrors(snapshotOf(rows))).toBeNull();
  });

  it('E 列原文缺失时回退分类时的 raw 原文', () => {
    const row = formulaErrorRow(9, 'LS9999', '缺原文商品');
    const cells = { ...row.cells };
    delete (cells as Record<string, string>).E;
    const result = collectFactoryFormulaErrors(snapshotOf([{ ...row, cells }]));
    expect(result!.rows[0]).toEqual({
      iceCode: 'LS9999',
      nameCn: '缺原文商品',
      cell: 'E9',
      error: '#REF!',
    });
  });
});

/* 本机现役实例的最近一次成功读取快照（只读本地文件；快照不在时跳过，CI 不依赖 .local）。 */
const REAL_RUN_ROOT = path.join(process.cwd(), '.local/catalog/run-20261026T211500Z-11a22b33');
const REAL_SNAPSHOT = path.join(
  REAL_RUN_ROOT,
  'source-snapshots/feishu-20261111T101258Z-7c9a77bd.json',
);

describe.skipIf(!existsSync(REAL_SNAPSHOT))('现役最近一次成功读取快照（只读）', () => {
  it('真实快照里 93 条生产工厂公式错误，LS101295 在 E3', () => {
    const snapshot = JSON.parse(readFileSync(REAL_SNAPSHOT, 'utf8')) as SourceSnapshot;
    const result = collectFactoryFormulaErrors(snapshot);
    expect(result).not.toBeNull();
    expect(result!.count).toBe(93);
    expect(result!.rows[0]).toMatchObject({
      iceCode: 'LS101295',
      cell: 'E3',
      error: '#REF!',
    });
  });

  it('readFactoryFormulaErrorState 区分「仍有错误」与「成功读到 0 个错误」', async () => {
    const previousRun = process.env.CATALOG_RUN_ROOT;
    process.env.CATALOG_RUN_ROOT = REAL_RUN_ROOT;
    try {
      const state = await readFactoryFormulaErrorState();
      expect(state.state).toBe('errors');
      if (state.state === 'errors') expect(state.group.count).toBe(93);
    } finally {
      if (previousRun === undefined) delete process.env.CATALOG_RUN_ROOT;
      else process.env.CATALOG_RUN_ROOT = previousRun;
    }

    // 全部工厂公式修好：同一份真实快照改掉公式错误 → 必须返回 clean，而不是 unavailable。
    const raw = JSON.parse(readFileSync(REAL_SNAPSHOT, 'utf8')) as SourceSnapshot;
    for (const row of raw.rows) {
      const factory = row.fields?.factory;
      if (!factory || factory.state !== 'parse_failed') continue;
      row.cells = { ...row.cells, E: '广州奥琪生物科技有限公司' };
      row.fields = { ...row.fields, factory: { ...factory, raw: '广州奥琪生物科技有限公司', state: 'observed' } };
      row.rowSha256 = computeRowSha256(row);
    }
    raw.capturedAt = new Date().toISOString();
    const cleanRoot = mkdtempSync(path.join(os.tmpdir(), 'iceos-formula-clean-'));
    const snapshotDir = path.join(cleanRoot, 'source-snapshots');
    mkdirSync(snapshotDir, { recursive: true });
    const clean = { ...raw, snapshotKey: computeSnapshotKey(raw) };
    writeFileSync(path.join(snapshotDir, 'feishu-clean.json'), JSON.stringify(clean), 'utf8');
    try {
      process.env.CATALOG_RUN_ROOT = cleanRoot;
      const state = await readFactoryFormulaErrorState();
      expect(state.state).toBe('clean');
      if (state.state === 'clean') expect(state.capturedAtDisplay.length).toBeGreaterThan(0);
      expect(await readFactoryFormulaErrorGroup()).toBeNull();
    } finally {
      if (previousRun === undefined) delete process.env.CATALOG_RUN_ROOT;
      else process.env.CATALOG_RUN_ROOT = previousRun;
      rmSync(cleanRoot, { recursive: true, force: true });
    }
  });

  it('没读到快照时返回 unavailable，不能当成「读到 0 个错误」', async () => {
    const previousRun = process.env.CATALOG_RUN_ROOT;
    process.env.CATALOG_RUN_ROOT = path.join(os.tmpdir(), 'iceos-no-snapshot-root-does-not-exist');
    try {
      const state = await readFactoryFormulaErrorState();
      expect(state.state).toBe('unavailable');
    } finally {
      if (previousRun === undefined) delete process.env.CATALOG_RUN_ROOT;
      else process.env.CATALOG_RUN_ROOT = previousRun;
    }
  });

  it('readFactoryFormulaErrorGroup 从 CATALOG_RUN_ROOT 取最近完整快照并返回 93 条', async () => {
    const previous = process.env.CATALOG_RUN_ROOT;
    process.env.CATALOG_RUN_ROOT = REAL_RUN_ROOT;
    try {
      const group = await readFactoryFormulaErrorGroup();
      expect(group).not.toBeNull();
      expect(group!.count).toBe(93);
      expect(group!.capturedAtDisplay.length).toBeGreaterThan(0);
      expect(group!.rows[0]?.cell).toBe('E3');
      expect(group!.rows[0]?.iceCode).toBe('LS101295');
    } finally {
      if (previous === undefined) delete process.env.CATALOG_RUN_ROOT;
      else process.env.CATALOG_RUN_ROOT = previous;
    }
  });
});
