/**
 * 飞书商品来源真实读取（feishu-capture）+ 只读定时状态（reader-status）的单元/契约测试。
 *
 * 用 Lead 在 2026-11-10 实测的真实响应（.local/catalog/fs-catalog-real-20261110/capture/）
 * 作为 lark-cli 的替身输出：临时目录里放一个 stub CLI（按 argv 返回对应 JSON），
 * 这样全链路（命令调用 → 解析 → 表头校验 → 快照 → 状态文件 → worker --once）都可离线重复验证。
 *
 * 真实 fixture 不在 Git 里（.local 被忽略），fixture 缺失时整组 skip，不让别的机器挂掉。
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  FEISHU_PRODUCT_SOURCE_URL,
  captureFeishuProductSource,
  resolveFeishuCliRunner,
  type FeishuCaptureResult,
} from '@/features/catalog/product-source/feishu-capture';
import {
  READER_STATUS_FILE,
  readReaderStatus,
  writeReaderStatus,
} from '@/features/catalog/product-source/reader-status';
import { validateSnapshot } from '@/features/catalog/product-source/headers';
import { computeSnapshotKey } from '@/features/catalog/product-source/reader';
import {
  IMAGE_CELL_PREFIX,
  SNAPSHOT_CONTRACT,
  SOURCE_PROFILE_KEY,
  decodeImageCell,
  type SourceSnapshot,
} from '@/features/catalog/product-source/contract';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE_DIR = path.join(REPO_ROOT, '.local/catalog/fs-catalog-real-20261110/capture');
const HAS_FIXTURE = existsSync(path.join(FIXTURE_DIR, 'sheet-values.json'));
const NOW = '2026-11-10T09:30:00.000Z';
const SNAPSHOT_FILE_PATTERN = /^feishu-\d{8}T\d{6}Z-[a-f0-9]{8}\.json$/;

function readJson(file: string): unknown {
  const text = readFileSync(file, 'utf8');
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

interface Fixtures {
  wiki: Record<string, unknown>;
  info: Record<string, unknown>;
  values: Record<string, unknown>;
}

function realFixtures(): Fixtures {
  return {
    wiki: readJson(path.join(FIXTURE_DIR, 'wiki-node.json')) as Record<string, unknown>,
    info: readJson(path.join(FIXTURE_DIR, 'sheet-info.json')) as Record<string, unknown>,
    values: readJson(path.join(FIXTURE_DIR, 'sheet-values.json')) as Record<string, unknown>,
  };
}

type StubMode = 'ok' | 'bad_json' | 'exit_nonzero' | 'ok_false';

/** 临时目录里的 lark-cli 替身：按 argv 输出 wiki/sheet-info/sheet-values，可切换故障模式。 */
function writeStubCli(rootDir: string, fixtures: Fixtures, mode: StubMode = 'ok'): string {
  const dir = path.join(rootDir, 'stub-cli');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'mode.json'), JSON.stringify({ mode }), 'utf8');
  writeFileSync(path.join(dir, 'wiki-node.json'), JSON.stringify(fixtures.wiki), 'utf8');
  writeFileSync(path.join(dir, 'sheet-info.json'), JSON.stringify(fixtures.info), 'utf8');
  writeFileSync(path.join(dir, 'sheet-values.json'), JSON.stringify(fixtures.values), 'utf8');
  const stub = [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    'const here = path.dirname(fileURLToPath(import.meta.url));',
    "const { mode } = JSON.parse(fs.readFileSync(path.join(here, 'mode.json'), 'utf8'));",
    'const args = process.argv.slice(2);',
    "if (mode === 'bad_json') { process.stdout.write('this is not json'); process.exit(0); }",
    "if (mode === 'exit_nonzero') { process.stderr.write('stub lark-cli failure\\n'); process.exit(2); }",
    "if (mode === 'ok_false') { process.stdout.write(JSON.stringify({ ok: false, error: { message: 'stub says no' } })); process.exit(0); }",
    "const step = args[0] === 'wiki' ? 'wiki-node' : args[1] === '+info' ? 'sheet-info' : 'sheet-values';",
    "process.stdout.write(fs.readFileSync(path.join(here, `${step}.json`), 'utf8'));",
  ].join('\n');
  const stubPath = path.join(dir, 'cli.mjs');
  writeFileSync(stubPath, `${stub}\n`, 'utf8');
  return stubPath;
}

interface CaptureCase {
  root: string;
  snapshotDir: string;
  stubPath: string;
  cleanup(): void;
}

function createCase(options: { fixtures?: Fixtures; mode?: StubMode } = {}): CaptureCase {
  const root = mkdtempSync(path.join(os.tmpdir(), 'iceos-feishu-capture-test-'));
  const snapshotDir = path.join(root, 'snapshots');
  const stubPath = writeStubCli(root, options.fixtures ?? realFixtures(), options.mode ?? 'ok');
  return {
    root,
    snapshotDir,
    stubPath,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function capture(caseValue: CaptureCase, nowIso = NOW): Promise<FeishuCaptureResult> {
  return captureFeishuProductSource({
    snapshotDir: caseValue.snapshotDir,
    cliRunnerPath: caseValue.stubPath,
    now: () => new Date(nowIso),
  });
}

function snapshotFiles(snapshotDir: string): string[] {
  if (!existsSync(snapshotDir)) return [];
  return readdirSync(snapshotDir).filter((name) => SNAPSHOT_FILE_PATTERN.test(name)).sort();
}

function readSnapshot(snapshotDir: string, fileName: string): SourceSnapshot {
  return readJson(path.join(snapshotDir, fileName)) as SourceSnapshot;
}

const EXPECTED_COUNTS = {
  gridRows: 404,
  gridColumns: 31,
  businessRows: 131,
  emptyRows: 272,
  uniqueCodes: 125,
  duplicateCodes: ['WM0069', 'WM0070', 'WM0071', 'WM0072', 'WM0073'],
  missingCodeRows: [122],
  imageCells: 128,
  priceCells: 365,
};

describe.skipIf(!HAS_FIXTURE)('feishu product-source capture (real 2026-11-10 response fixtures)', () => {
  it('captures a contract-valid snapshot with the verified 404x31 / 131-row numbers', async () => {
    const caseValue = createCase();
    try {
      const result = await capture(caseValue);
      expect(result.status).toBe('captured');
      expect(result.errorCode).toBeNull();
      expect(result.errorMessage).toBeNull();
      expect(result.counts).toEqual(EXPECTED_COUNTS);
      expect(result.capturedAt).toBe(NOW);
      expect(result.documentModifiedLabel).toBe('2026-10-20T06:37:19Z');
      expect(result.snapshotKey).toMatch(/^[a-f0-9]{64}$/);
      expect(result.snapshotFile).toMatch(SNAPSHOT_FILE_PATTERN);

      const files = snapshotFiles(caseValue.snapshotDir);
      expect(files).toEqual([result.snapshotFile]);
      for (const suffix of ['.capture.json', '.capture-metadata.json']) {
        expect(existsSync(path.join(caseValue.snapshotDir, `${result.snapshotFile!.replace(/\.json$/, suffix)}`))).toBe(true);
      }

      const snapshot = readSnapshot(caseValue.snapshotDir, result.snapshotFile!);
      expect(snapshot.contract).toBe(SNAPSHOT_CONTRACT);
      expect(snapshot.profileKey).toBe(SOURCE_PROFILE_KEY);
      expect(snapshot.origin).toBe('real_capture');
      expect(snapshot.snapshotKey).toBe(computeSnapshotKey(snapshot));
      expect(snapshot.snapshotKey).toBe(result.snapshotKey);
      expect(snapshot.collection.method).toBe('feishu_api');
      expect(snapshot.collection.url).toBe(FEISHU_PRODUCT_SOURCE_URL);
      expect(snapshot.collection.worksheetTitle).toBe('Sheet1');
      expect(snapshot.collection.headerRow).toBe(1);
      expect(snapshot.collection.requestedRange).toBe('33bab4!A1:AE404');
      expect(snapshot.collection.observedRange).toBe('33bab4!A1:AE404');
      expect(snapshot.collection.complete).toBe(true);
      expect(snapshot.collection.truncated).toBe(false);
      expect(snapshot.collection.readError).toBeNull();
      expect(snapshot.collection.rawEvidenceSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(snapshot.collection.rawEvidenceBytes).toBeGreaterThan(100_000);
      expect(snapshot.rows).toHaveLength(403);
      expect(snapshot.rows.filter((row) => row.isBusinessRow)).toHaveLength(131);
      expect(Object.keys(snapshot.collection.headers)).toHaveLength(31);

      const validation = validateSnapshot(snapshot);
      expect(validation.issues).toEqual([]);
      expect(validation.ok).toBe(true);
      expect(validation.status).toBe('validated');

      const firstBusiness = snapshot.rows.find((row) => row.isBusinessRow)!;
      expect(firstBusiness.fields.nameCn.state).toBe('observed');
      expect(firstBusiness.fields.nameCn.raw).toBe('HUNMUI素颜隔离防晒霜');
      // 图片只作来源证据：编码为 image:<JSON>，可解码，但仍然不是可采纳字段。
      expect(firstBusiness.fields.imageRef.state).toBe('observed');
      expect(firstBusiness.fields.imageRef.raw.startsWith(IMAGE_CELL_PREFIX)).toBe(true);
      expect(decodeImageCell(firstBusiness.fields.imageRef.raw)).toEqual({
        fileToken: 'RqFAb5jhqoP7jdxjpRnch4TwnUh',
        type: 'embed-image',
        width: 478,
        height: 489,
      });
      // 价格列只进 cells（受限证据），不进 fields、不进计数以外的输出。
      expect(firstBusiness.fields).not.toHaveProperty('costPrice');
      expect(firstBusiness.cells.I).not.toBe('');
    } finally {
      caseValue.cleanup();
    }
  }, 120_000);

  it('does not write a second snapshot when the content snapshotKey is unchanged', async () => {
    const caseValue = createCase();
    try {
      const first = await capture(caseValue, '2026-11-10T09:30:00.000Z');
      expect(first.status).toBe('captured');
      const second = await capture(caseValue, '2026-11-10T10:45:00.000Z');
      expect(second.status).toBe('unchanged');
      expect(second.snapshotKey).toBe(first.snapshotKey);
      expect(second.snapshotFile).toBe(first.snapshotFile);
      expect(second.counts).toEqual(EXPECTED_COUNTS);
      expect(snapshotFiles(caseValue.snapshotDir)).toHaveLength(1);
      const status = readReaderStatus(caseValue.snapshotDir);
      expect(status?.lastResult).toBe('unchanged');
      expect(status?.snapshotKey).toBe(first.snapshotKey);
      expect(status?.capturedAt).toBe('2026-11-10T10:45:00.000Z');
      expect(status?.errorCode).toBeNull();
    } finally {
      caseValue.cleanup();
    }
  }, 120_000);

  it('fails with FEISHU_HEADER_INVALID and writes no snapshot when a known header is missing', async () => {
    const fixtures = realFixtures();
    const values = fixtures.values as { data: { valueRange: { values: unknown[][] } } };
    values.data.valueRange.values[0][10] = '未知列标题';
    const caseValue = createCase({ fixtures });
    try {
      const result = await capture(caseValue);
      expect(result.status).toBe('failed');
      expect(result.errorCode).toBe('FEISHU_HEADER_INVALID');
      expect(result.snapshotFile).toBeNull();
      expect(result.snapshotKey).toBeNull();
      expect(snapshotFiles(caseValue.snapshotDir)).toEqual([]);
      const status = readReaderStatus(caseValue.snapshotDir);
      expect(status?.lastResult).toBe('failed');
      expect(status?.errorCode).toBe('FEISHU_HEADER_INVALID');
    } finally {
      caseValue.cleanup();
    }
  }, 120_000);

  it('fails with FEISHU_GRID_INVALID when the read dimensions do not match the grid', async () => {
    const fixtures = realFixtures();
    const values = fixtures.values as { data: { valueRange: { values: unknown[][] } } };
    values.data.valueRange.values.pop();
    const caseValue = createCase({ fixtures });
    try {
      const result = await capture(caseValue);
      expect(result.status).toBe('failed');
      expect(result.errorCode).toBe('FEISHU_GRID_INVALID');
      expect(snapshotFiles(caseValue.snapshotDir)).toEqual([]);
    } finally {
      caseValue.cleanup();
    }
  }, 120_000);

  it('fails with FEISHU_DOC_INVALID when the wiki node is not a spreadsheet', async () => {
    const fixtures = realFixtures();
    const wiki = fixtures.wiki as { data: Record<string, unknown> };
    wiki.data.obj_type = 'docx';
    const caseValue = createCase({ fixtures });
    try {
      const result = await capture(caseValue);
      expect(result.status).toBe('failed');
      expect(result.errorCode).toBe('FEISHU_DOC_INVALID');
      expect(snapshotFiles(caseValue.snapshotDir)).toEqual([]);
    } finally {
      caseValue.cleanup();
    }
  }, 120_000);

  it('fails with FEISHU_CLI_FAILED when lark-cli exits non-zero, and with ok=false', async () => {
    const failing = createCase({ mode: 'exit_nonzero' });
    const refusing = createCase({ mode: 'ok_false' });
    try {
      const failed = await capture(failing);
      expect(failed.status).toBe('failed');
      expect(failed.errorCode).toBe('FEISHU_CLI_FAILED');
      expect(failed.errorMessage).toContain('stub lark-cli failure');
      expect(snapshotFiles(failing.snapshotDir)).toEqual([]);

      const refused = await capture(refusing);
      expect(refused.status).toBe('failed');
      expect(refused.errorCode).toBe('FEISHU_CLI_FAILED');
      expect(refused.errorMessage).toContain('stub says no');
    } finally {
      failing.cleanup();
      refusing.cleanup();
    }
  }, 120_000);

  it('fails with FEISHU_CLI_FAILED when lark-cli output is not JSON', async () => {
    const caseValue = createCase({ mode: 'bad_json' });
    try {
      const result = await capture(caseValue);
      expect(result.status).toBe('failed');
      expect(result.errorCode).toBe('FEISHU_CLI_FAILED');
      expect(snapshotFiles(caseValue.snapshotDir)).toEqual([]);
    } finally {
      caseValue.cleanup();
    }
  }, 120_000);

  it('returns FEISHU_CLI_MISSING for a missing runner without throwing or writing a snapshot', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'iceos-feishu-capture-test-'));
    const snapshotDir = path.join(root, 'not-created-yet', 'snapshots');
    try {
      const result = await captureFeishuProductSource({
        snapshotDir,
        cliRunnerPath: path.join(root, 'no-such-run.js'),
        now: () => new Date(NOW),
      });
      expect(result.status).toBe('failed');
      expect(result.errorCode).toBe('FEISHU_CLI_MISSING');
      expect(result.counts).toBeNull();
      expect(result.snapshotFile).toBeNull();
      expect(snapshotFiles(snapshotDir)).toEqual([]);
      // 状态仍要写出来（服务层据此显示失败原因）。
      const status = readReaderStatus(snapshotDir);
      expect(status?.lastResult).toBe('failed');
      expect(status?.errorCode).toBe('FEISHU_CLI_MISSING');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('worker --once exits 0 for captured/unchanged and 1 for a failed read', async () => {
    const caseValue = createCase();
    const workerScript = path.join(REPO_ROOT, 'scripts/catalog/feishu-source/worker.mjs');
    const writeConfig = (cliRunnerPath: string): string => {
      const configPath = path.join(caseValue.root, `worker-${path.basename(cliRunnerPath)}.json`);
      writeFileSync(configPath, JSON.stringify({
        workerId: 'test-product-source-reader',
        snapshotDir: caseValue.snapshotDir,
        logPath: path.join(caseValue.root, 'logs'),
        tsTempDir: path.join(caseValue.root, 'ts-tmp'),
        intervalMinutes: 5,
        cliRunnerPath,
      }), 'utf8');
      return configPath;
    };
    const runWorker = (configPath: string) => spawnSync(
      process.execPath,
      [workerScript, '--config', configPath, '--once'],
      { encoding: 'utf8', windowsHide: true, timeout: 180_000 },
    );
    try {
      const configPath = writeConfig(caseValue.stubPath);
      const first = runWorker(configPath);
      expect(first.status).toBe(0);
      const statusAfterFirst = readReaderStatus(caseValue.snapshotDir);
      expect(statusAfterFirst?.lastResult).toBe('captured');
      expect(statusAfterFirst?.intervalMinutes).toBe(5);
      expect(statusAfterFirst?.counts?.businessRows).toBe(131);
      // --once 是手动验证入口：只更新最近结果/计数，不改写定时计划（N5）。
      expect(statusAfterFirst?.nextRunAt).toBeNull();

      const second = runWorker(configPath);
      expect(second.status).toBe(0);
      expect(readReaderStatus(caseValue.snapshotDir)?.lastResult).toBe('unchanged');
      expect(snapshotFiles(caseValue.snapshotDir)).toHaveLength(1);

      const brokenConfig = writeConfig(path.join(caseValue.root, 'missing-run.js'));
      const broken = runWorker(brokenConfig);
      expect(broken.status).toBe(1);
      expect(readReaderStatus(caseValue.snapshotDir)?.lastResult).toBe('failed');
    } finally {
      caseValue.cleanup();
    }
  }, 240_000);

  it('reader-status read/write merges patches and tolerates missing or broken files', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'iceos-reader-status-test-'));
    const snapshotDir = path.join(root, 'snapshots');
    try {
      expect(readReaderStatus(snapshotDir)).toBeNull();
      const first = writeReaderStatus(snapshotDir, {
        intervalMinutes: 60,
        lastResult: 'captured',
        snapshotKey: 'a'.repeat(64),
        counts: EXPECTED_COUNTS,
        worker: { running: true, pid: 4321, startedAt: NOW },
        errorCode: null,
      });
      expect(first.method).toBe('feishu_api');
      expect(first.lastResult).toBe('captured');
      expect(existsSync(path.join(snapshotDir, READER_STATUS_FILE))).toBe(true);

      const merged = writeReaderStatus(snapshotDir, { lastResult: 'unchanged', lastRunAt: NOW });
      expect(merged.lastResult).toBe('unchanged');
      expect(merged.snapshotKey).toBe('a'.repeat(64));
      expect(merged.counts).toEqual(EXPECTED_COUNTS);
      expect(merged.worker).toEqual({ running: true, pid: 4321, startedAt: NOW });
      expect(readReaderStatus(snapshotDir)?.lastRunAt).toBe(NOW);

      // 坏 JSON 读 → null，不抛；写仍然成功（覆盖坏文件）。
      writeFileSync(path.join(snapshotDir, READER_STATUS_FILE), '{oops', 'utf8');
      expect(readReaderStatus(snapshotDir)).toBeNull();
      const repaired = writeReaderStatus(snapshotDir, { lastResult: 'failed', errorCode: 'FEISHU_CLI_FAILED' });
      expect(repaired.lastResult).toBe('failed');
      expect(readReaderStatus(snapshotDir)?.errorCode).toBe('FEISHU_CLI_FAILED');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves the lark-cli runner with PRODUCT_SOURCE > SHIPMENT > candidates precedence', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'iceos-feishu-runner-test-'));
    try {
      const productRunner = path.join(root, 'product-runner.js');
      const shipmentRunner = path.join(root, 'shipment-runner.js');
      writeFileSync(productRunner, '', 'utf8');
      writeFileSync(shipmentRunner, '', 'utf8');

      const both = { HOME: root, APPDATA: '', PRODUCT_SOURCE_LARK_CLI_RUNNER: productRunner, SHIPMENT_LARK_CLI_RUNNER: shipmentRunner };
      expect(resolveFeishuCliRunner({ env: both }).runnerPath).toBe(productRunner);
      expect(resolveFeishuCliRunner({ env: { ...both, PRODUCT_SOURCE_LARK_CLI_RUNNER: '' } }).runnerPath)
        .toBe(shipmentRunner);
      const expectCode = (run: () => unknown, code: string) => {
        try {
          run();
        } catch (error) {
          expect((error as { code?: string }).code).toBe(code);
          return;
        }
        throw new Error(`expected ${code} but nothing was thrown`);
      };
      expectCode(() => resolveFeishuCliRunner({
        env: { HOME: root, APPDATA: '', PRODUCT_SOURCE_LARK_CLI_RUNNER: path.join(root, 'missing.js') },
      }), 'FEISHU_CLI_MISSING');
      expectCode(() => resolveFeishuCliRunner({ env: { HOME: path.join(root, 'empty-home'), APPDATA: '' } }),
        'FEISHU_CLI_MISSING');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
