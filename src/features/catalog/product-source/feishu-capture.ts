/**
 * 飞书「ICE产品库」商品来源的真实读取（只读 capture）。
 *
 * 与旧的 `local-reader.ts`（本地快照模拟）互补：本模块真实调用本机 `lark-cli`
 * （bot 身份，凭据在系统凭据库，不进入 ICEOS），把工作表整格读成一份
 * `SourceSnapshot`（origin='real_capture'）落盘到 snapshotDir，并记录
 * 原始响应（`.capture.json`）、取证元数据（`.capture-metadata.json`）与
 * 定时读取状态（`reader-status.json`）。
 *
 * 关键约束：
 * - 只读：只调用 wiki +node-get / sheets +info / sheets +read，不写飞书、不应用批次、不连数据库；
 * - 失败不抛（除磁盘不可恢复错误）：返回 `{status:'failed', errorCode, errorMessage}`，
 *   不写快照、不回退旧数据，由服务层把 errorCode 映射成中文提示；
 * - 价格列（成本价格/运营价格/单品运费）只作受限来源证据保存在快照 cells 与 .local
 *   原始响应里；状态与返回值只给计数，不给值；
 * - 子进程 stdout/stderr 重定向到临时文件再读：当前 Windows 沙箱里 Node 的 pipe stdio
 *   可能被拒绝（EPERM），文件重定向在 Windows/macOS 都可用（同 scripts/runtime/check-runtime.mjs 的 runToFile）。
 *
 * 本文件不引 `server-only`：后台 worker 经 TS loader 直接加载。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  IMAGE_CELL_PREFIX,
  SNAPSHOT_CONTRACT,
  SOURCE_PROFILE_KEY,
  canonicalJson,
  encodeImageCell,
  type SourceCell,
  type SourceRow,
  type SourceSnapshot,
  type SourceSnapshotCollection,
} from './contract';
import { resolveHeaderMapping } from './headers';
import { buildRowFields } from './normalize';
import { computeRowSha256, computeSnapshotKey, sha256Hex } from './reader';
import {
  writeReaderStatus,
  type ProductSourceReaderCounts,
} from './reader-status';

/** ICE产品库 wiki 节点（用户确认事实；真实读取只读该节点指向的电子表格）。 */
export const FEISHU_PRODUCT_SOURCE_URL =
  'https://ygr1tb7cyf.feishu.cn/wiki/TC2AwLgRniqWKhkg9D2cEx79n0b';
export const FEISHU_PRODUCT_SOURCE_HOST = 'ygr1tb7cyf.feishu.cn';
/** 每条 lark-cli 命令的超时（毫秒）。 */
export const FEISHU_CAPTURE_CLI_TIMEOUT_MS = 120_000;
/** 快照文件名前缀（snapshotDir 内）。 */
export const FEISHU_SNAPSHOT_FILE_PREFIX = 'feishu-';

export const FEISHU_CAPTURE_ERROR_CODES = [
  'FEISHU_CLI_MISSING',
  'FEISHU_CLI_FAILED',
  'FEISHU_DOC_INVALID',
  'FEISHU_SHEET_MISSING',
  'FEISHU_HEADER_INVALID',
  'FEISHU_GRID_INVALID',
  'FEISHU_EMPTY_PAYLOAD',
  'FEISHU_CAPTURE_WRITE_FAILED',
  'FEISHU_CAPTURE_FAILED',
] as const;
export type FeishuCaptureErrorCode = (typeof FEISHU_CAPTURE_ERROR_CODES)[number];

export type FeishuCaptureStatus = 'captured' | 'unchanged' | 'failed';

export interface FeishuCaptureResult {
  status: FeishuCaptureStatus;
  snapshotKey: string | null;
  /** 文件名（不含目录）；失败/首轮未落盘时为 null。 */
  snapshotFile: string | null;
  /** 本次读取开始时间（ISO）。 */
  capturedAt: string;
  /** wiki 节点的最新修改时间（obj_edit_time 的 ISO 形式，缺失时为原始值）。 */
  documentModifiedLabel: string | null;
  counts: ProductSourceReaderCounts | null;
  errorCode: FeishuCaptureErrorCode | null;
  errorMessage: string | null;
}

export interface FeishuCaptureOptions {
  /** 快照目录（真实读取只写这里；服务层/worker 从 reader-status.json 读状态）。 */
  snapshotDir: string;
  /** 显式 lark-cli run.js 路径；不传则按环境变量/默认候选解析。 */
  cliRunnerPath?: string;
  /** 可注入时钟（测试/确定性）。 */
  now?: () => Date;
}

interface CliRunner {
  /** lark-cli 包内 run.js 绝对路径。 */
  runnerPath: string;
  /** 解析来源：显式环境变量 / 默认候选。 */
  source: 'option' | 'PRODUCT_SOURCE_LARK_CLI_RUNNER' | 'SHIPMENT_LARK_CLI_RUNNER' | 'candidate';
}

interface CliRunResult {
  stdout: string;
  stderr: string;
  /** stdout 原始字节数（取证用）。 */
  stdoutBytes: number;
}

class FeishuCaptureError extends Error {
  readonly code: FeishuCaptureErrorCode;
  constructor(code: FeishuCaptureErrorCode, message: string) {
    super(message);
    this.name = 'FeishuCaptureError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text === '' ? null : text;
}

function integerOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** lark-cli run.js 候选（与 scripts/runtime/platform.mjs 保持同一顺序）。 */
export function feishuCliCandidates(env: Partial<NodeJS.ProcessEnv> = process.env): string[] {
  const candidates: string[] = [];
  if (env.APPDATA) {
    candidates.push(path.join(env.APPDATA, 'npm', 'node_modules', '@larksuite', 'cli', 'scripts', 'run.js'));
  }
  const home = env.HOME || env.USERPROFILE || os.homedir();
  candidates.push(
    '/opt/homebrew/lib/node_modules/@larksuite/cli/scripts/run.js',
    '/usr/local/lib/node_modules/@larksuite/cli/scripts/run.js',
    path.join(home, '.npm-global', 'lib', 'node_modules', '@larksuite', 'cli', 'scripts', 'run.js'),
  );
  return candidates;
}

/**
 * 解析 lark-cli 入口：
 * PRODUCT_SOURCE_LARK_CLI_RUNNER > SHIPMENT_LARK_CLI_RUNNER > 默认候选。
 * 显式配置指向不存在文件时直接报错（不静默回退到别的 CLI）。
 */
export function resolveFeishuCliRunner(
  options: { cliRunnerPath?: string; env?: Partial<NodeJS.ProcessEnv> } = {},
): CliRunner {
  const env = options.env ?? process.env;
  const explicit = options.cliRunnerPath?.trim();
  if (explicit) {
    if (!fs.existsSync(explicit)) {
      throw new FeishuCaptureError('FEISHU_CLI_MISSING', `lark-cli run.js 不存在：${explicit}`);
    }
    return { runnerPath: explicit, source: 'option' };
  }
  for (const [name, source] of [
    ['PRODUCT_SOURCE_LARK_CLI_RUNNER', 'PRODUCT_SOURCE_LARK_CLI_RUNNER'],
    ['SHIPMENT_LARK_CLI_RUNNER', 'SHIPMENT_LARK_CLI_RUNNER'],
  ] as const) {
    const configured = env[name]?.trim();
    if (!configured) continue;
    if (!fs.existsSync(configured)) {
      throw new FeishuCaptureError('FEISHU_CLI_MISSING', `${name} 指向的文件不存在：${configured}`);
    }
    return { runnerPath: configured, source };
  }
  for (const candidate of feishuCliCandidates(env)) {
    if (fs.existsSync(candidate)) return { runnerPath: candidate, source: 'candidate' };
  }
  throw new FeishuCaptureError(
    'FEISHU_CLI_MISSING',
    '未找到 lark-cli（可设置 PRODUCT_SOURCE_LARK_CLI_RUNNER 或 SHIPMENT_LARK_CLI_RUNNER 指定 run.js 路径）',
  );
}

/**
 * 运行一次 lark-cli 并返回 stdout/stderr。
 *
 * stdout/stderr 都重定向到临时文件（不用 pipe）；超时杀进程并报 FEISHU_CLI_FAILED。
 */
function runLarkCli(runnerPath: string, args: string[], timeoutMs = FEISHU_CAPTURE_CLI_TIMEOUT_MS): CliRunResult {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iceos-feishu-capture-'));
  const stdoutFile = path.join(tempDir, 'stdout.json');
  const stderrFile = path.join(tempDir, 'stderr.log');
  let stdoutFd: number | undefined;
  let stderrFd: number | undefined;
  try {
    stdoutFd = fs.openSync(stdoutFile, 'w');
    stderrFd = fs.openSync(stderrFile, 'w');
    const result = spawnSync(process.execPath, [runnerPath, ...args], {
      stdio: ['ignore', stdoutFd, stderrFd],
      timeout: timeoutMs,
      windowsHide: true,
      env: process.env,
    });
    const stdoutRaw = fs.readFileSync(stdoutFile);
    const stderr = stripBom(fs.readFileSync(stderrFile, 'utf8'));
    const stdout = stripBom(stdoutRaw.toString('utf8'));
    if (result.error) {
      const detail = String(result.error.message ?? result.error).slice(0, 300);
      throw new FeishuCaptureError(
        'FEISHU_CLI_FAILED',
        `${args[0] ?? 'lark-cli'} ${args[1] ?? ''} 启动失败：${detail}${stderr.trim() ? `；stderr=${stderr.trim().slice(0, 200)}` : ''}`,
      );
    }
    if (result.status !== 0) {
      const detail = stderr.trim().slice(0, 400) || `lark-cli 退出码 ${String(result.status)}`;
      throw new FeishuCaptureError(
        'FEISHU_CLI_FAILED',
        `${args[0] ?? 'lark-cli'} ${args[1] ?? ''} 失败：${detail}`,
      );
    }
    return { stdout, stderr, stdoutBytes: stdoutRaw.byteLength };
  } finally {
    if (stdoutFd !== undefined) fs.closeSync(stdoutFd);
    if (stderrFd !== undefined) fs.closeSync(stderrFd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

interface CliJsonRun {
  payload: Record<string, unknown>;
  /** 去除 BOM 后的 stdout 全文（取证摘要用）。 */
  stdout: string;
  stdoutBytes: number;
}

/** 运行 lark-cli 子命令并解析其 stdout JSON（要求 ok=true）。 */
function runLarkCliJson(runnerPath: string, args: string[]): CliJsonRun {
  const run = runLarkCli(runnerPath, args);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(run.stdout));
  } catch {
    const detail = run.stdout.trim().slice(0, 200) || run.stderr.trim().slice(0, 200) || '输出不是 JSON';
    throw new FeishuCaptureError('FEISHU_CLI_FAILED', `${args[0] ?? 'lark-cli'} ${args[1] ?? ''} 输出无法解析：${detail}`);
  }
  if (!isRecord(parsed)) {
    throw new FeishuCaptureError('FEISHU_CLI_FAILED', `${args[0] ?? 'lark-cli'} 输出不是 JSON 对象`);
  }
  if (parsed.ok !== true) {
    const error = isRecord(parsed.error) ? parsed.error : {};
    const message = textOrNull(error.message) ?? 'lark-cli 返回 ok=false';
    throw new FeishuCaptureError('FEISHU_CLI_FAILED', `${args[0] ?? 'lark-cli'} 返回失败：${message.slice(0, 400)}`);
  }
  return { payload: parsed, stdout: run.stdout, stdoutBytes: run.stdoutBytes };
}

function excelColumnName(index: number): string {
  let value = index;
  let name = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function utcStamp(date: Date): string {
  const iso = date.toISOString();
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** 图片单元格对象判定（飞书 embed-image / 其它带 fileToken 的图片形式）。 */
function isImageCell(value: Record<string, unknown>): boolean {
  const type = textOrNull(value.type);
  if (type === 'embed-image') return typeof value.fileToken === 'string' && value.fileToken.trim() !== '';
  return (
    typeof value.fileToken === 'string'
    && value.fileToken.trim() !== ''
    && (type ?? '').toLowerCase().includes('image')
  );
}

/**
 * 单元格值 -> 快照字符串。
 * null→''；string/number/boolean→字符串；embed-image→encodeImageCell；其它对象取 .text 否则 canonical JSON。
 */
function cellToSnapshotString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (Array.isArray(value)) return canonicalJson(value);
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (isImageCell(record)) {
      return encodeImageCell({
        fileToken: String(record.fileToken),
        type: textOrNull(record.type) ?? 'embed-image',
        width: finiteNumberOrNaN(record.width),
        height: finiteNumberOrNaN(record.height),
      });
    }
    const text = record.text;
    if (typeof text === 'string' && text !== '') return text;
    return canonicalJson(record);
  }
  return String(value);
}

function finiteNumberOrNaN(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Number.NaN;
}

interface ParsedSheetRead {
  snapshot: SourceSnapshot;
  collection: SourceSnapshotCollection;
  counts: ProductSourceReaderCounts;
  cellValues: unknown[][];
  rawEvidenceSha256: string;
  rawEvidenceBytes: number;
  wikiNode: Record<string, unknown>;
  sheetInfo: Record<string, unknown>;
  requestedRange: string;
  observedRange: string;
  documentModifiedLabel: string | null;
  sheetId: string;
  worksheetTitle: string;
  url: string;
  readRevision: number | null;
}

/**
 * 真实读取 + 转换成契约快照（不落盘）。任何校验失败抛 FeishuCaptureError。
 * 拆成纯读取函数便于单测（fixture 注入由测试直接测 captureFeishuProductSource 的文件读取路径）。
 */
function readSheet(runnerPath: string, now: () => Date): ParsedSheetRead {
  // 1) wiki 节点 -> spreadsheet token / 文档修改时间
  const nodeRun = runLarkCliJson(runnerPath, ['wiki', '+node-get', '--token', FEISHU_PRODUCT_SOURCE_URL]);
  const nodeData = nodeRun.payload.data;
  if (!isRecord(nodeData)) {
    throw new FeishuCaptureError('FEISHU_DOC_INVALID', 'wiki 节点响应缺少 data 对象');
  }
  const docToken = textOrNull(nodeData.obj_token);
  if (!docToken) throw new FeishuCaptureError('FEISHU_DOC_INVALID', 'wiki 节点没有解析到 obj_token');
  const objType = textOrNull(nodeData.obj_type);
  if (objType !== 'sheet') {
    throw new FeishuCaptureError('FEISHU_DOC_INVALID', `wiki 节点不是电子表格（obj_type=${String(objType)}）`);
  }
  const documentModifiedLabel = textOrNull(nodeData.updated_at) ?? textOrNull(nodeData.obj_edit_time);
  const sheetUrl = `https://${FEISHU_PRODUCT_SOURCE_HOST}/sheets/${docToken}`;

  // 2) 工作表信息 -> sheet_id / 标题 / 网格
  const infoRun = runLarkCliJson(runnerPath, ['sheets', '+info', '--url', sheetUrl]);
  const infoData = infoRun.payload.data;
  if (!isRecord(infoData)) throw new FeishuCaptureError('FEISHU_SHEET_MISSING', '工作表信息响应缺少 data');
  const sheetsBox = infoData.sheets;
  const sheetEntries = isRecord(sheetsBox) && Array.isArray(sheetsBox.sheets) ? sheetsBox.sheets : null;
  if (!sheetEntries || sheetEntries.length === 0) {
    throw new FeishuCaptureError('FEISHU_SHEET_MISSING', '文档里没有工作表');
  }
  const entryRecords = sheetEntries.map((entry, index) => {
    if (!isRecord(entry)) throw new FeishuCaptureError('FEISHU_SHEET_MISSING', `工作表 #${index + 1} 不是对象`);
    return entry;
  });
  const target = entryRecords[0];
  const sheetId = textOrNull(target.sheet_id);
  if (!sheetId) throw new FeishuCaptureError('FEISHU_SHEET_MISSING', '工作表缺少 sheet_id');
  const worksheetTitle = textOrNull(target.title) ?? sheetId;
  const grid = target.grid_properties;
  if (!isRecord(grid)) throw new FeishuCaptureError('FEISHU_GRID_INVALID', '工作表缺少 grid_properties');
  const gridRows = integerOrNull(grid.row_count);
  const gridColumns = integerOrNull(grid.column_count);
  if (gridRows === null || gridRows < 2) {
    throw new FeishuCaptureError('FEISHU_GRID_INVALID', `工作表行数异常：${String(gridRows)}`);
  }
  if (gridColumns === null || gridColumns < 1 || gridColumns > 64) {
    throw new FeishuCaptureError('FEISHU_GRID_INVALID', `工作表列数异常：${String(gridColumns)}`);
  }

  // 3) 读取整格（FormattedValue：展示值，与人工看到的一致）
  const lastColumn = excelColumnName(gridColumns);
  const requestedRange = `${sheetId}!A1:${lastColumn}${gridRows}`;
  const readRun = runLarkCliJson(runnerPath, [
    'sheets', '+read', '--url', sheetUrl, '--range', requestedRange, '--value-render-option', 'FormattedValue',
  ]);
  const readData = readRun.payload.data;
  if (!isRecord(readData)) throw new FeishuCaptureError('FEISHU_GRID_INVALID', '工作表读取响应缺少 data');
  const valueRange = isRecord(readData.valueRange) ? readData.valueRange : null;
  if (!valueRange || !Array.isArray(valueRange.values)) {
    throw new FeishuCaptureError('FEISHU_GRID_INVALID', '工作表读取响应缺少 valueRange.values');
  }
  const cellValues = valueRange.values.map((row, index) => {
    if (!Array.isArray(row)) throw new FeishuCaptureError('FEISHU_GRID_INVALID', `第 ${index + 1} 行不是数组`);
    return row;
  });
  if (cellValues.length !== gridRows) {
    throw new FeishuCaptureError(
      'FEISHU_GRID_INVALID',
      `读取行数 ${cellValues.length} 与工作表网格行数 ${gridRows} 不一致`,
    );
  }
  for (let rowIndex = 0; rowIndex < cellValues.length; rowIndex += 1) {
    if (cellValues[rowIndex].length !== gridColumns) {
      throw new FeishuCaptureError(
        'FEISHU_GRID_INVALID',
        `第 ${rowIndex + 1} 行数据列数 ${cellValues[rowIndex].length} 与网格列数 ${gridColumns} 不一致`,
      );
    }
  }
  if (cellValues.length < 2) throw new FeishuCaptureError('FEISHU_EMPTY_PAYLOAD', '工作表只有表头，没有数据行');
  const observedRange = textOrNull(valueRange.range) ?? requestedRange;

  // 4) 表头契约（按精确标签匹配，列字母只作证据）
  const headers: Record<string, string> = {};
  const headerRow = cellValues[0];
  for (let columnIndex = 0; columnIndex < gridColumns; columnIndex += 1) {
    headers[excelColumnName(columnIndex + 1)] = cellToSnapshotString(headerRow[columnIndex]);
  }
  const resolution = resolveHeaderMapping(headers);
  if (!resolution.ok) {
    const detail = resolution.issues.map((issue) => issue.detail).join('；').slice(0, 500);
    throw new FeishuCaptureError('FEISHU_HEADER_INVALID', `表头不符合 27 个已知表头：${detail}`);
  }
  const fieldColumns = resolution.fieldColumns;
  const nameColumn = fieldColumns.nameCn;
  if (!nameColumn) throw new FeishuCaptureError('FEISHU_HEADER_INVALID', '缺少中文产品名称列');
  const restrictedColumns = Object.values(resolution.restrictedColumns);

  // 5) 行转换（与 build-snapshot.mjs 同一口径：所有数据行都保存，空行也保存）
  const rows: SourceRow[] = [];
  let imageCells = 0;
  let priceCells = 0;
  const codeCounts = new Map<string, number>();
  const missingCodeRows: number[] = [];
  for (let index = 1; index < cellValues.length; index += 1) {
    const rowNumber = index + 1;
    const rawRow = cellValues[index];
    const cells: Record<string, string> = {};
    for (let columnIndex = 0; columnIndex < gridColumns; columnIndex += 1) {
      const encoded = cellToSnapshotString(rawRow[columnIndex]);
      cells[excelColumnName(columnIndex + 1)] = encoded;
      if (encoded.startsWith(IMAGE_CELL_PREFIX)) imageCells += 1;
    }
    for (const column of restrictedColumns) {
      if ((cells[column] ?? '').trim() !== '') priceCells += 1;
    }
    const nameCn = (cells[nameColumn] ?? '').trim();
    const isBusinessRow = nameCn !== '';
    let fields: Record<string, SourceCell> = {};
    if (isBusinessRow) {
      fields = buildRowFields(cells, fieldColumns);
      const codeCell = fields.iceCode;
      const code = codeCell && codeCell.state === 'observed' ? codeCell.raw.trim() : '';
      if (code === '') missingCodeRows.push(rowNumber);
      else codeCounts.set(code, (codeCounts.get(code) ?? 0) + 1);
    }
    rows.push({
      rowNumber,
      isBusinessRow,
      cells,
      fields,
      rowSha256: computeRowSha256({ rowNumber, cells, fields }),
    });
  }
  const businessRows = rows.filter((row) => row.isBusinessRow).length;
  if (businessRows === 0) throw new FeishuCaptureError('FEISHU_EMPTY_PAYLOAD', '工作表没有有效业务行');
  const duplicateCodes = [...codeCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([code]) => code)
    .sort();

  const collection: SourceSnapshotCollection = {
    method: 'feishu_api',
    url: FEISHU_PRODUCT_SOURCE_URL,
    worksheetTitle,
    headerRow: 1,
    requestedRange,
    observedRange,
    gridRows,
    gridColumns,
    businessRowCount: businessRows,
    emptyRowCount: rows.length - businessRows,
    complete: true,
    headers,
    rawEvidenceSha256: sha256Hex(readRun.stdout),
    rawEvidenceBytes: readRun.stdoutBytes,
    truncated: false,
    readError: null,
  };
  const capturedAt = now().toISOString();
  const snapshot: SourceSnapshot = {
    contract: SNAPSHOT_CONTRACT,
    profileKey: SOURCE_PROFILE_KEY,
    snapshotKey: '',
    origin: 'real_capture',
    capturedAt,
    documentModifiedLabel,
    collection,
    simulation: null,
    redaction: null,
    rows,
  };
  snapshot.snapshotKey = computeSnapshotKey(snapshot);

  const counts: ProductSourceReaderCounts = {
    gridRows,
    gridColumns,
    businessRows,
    emptyRows: rows.length - businessRows,
    uniqueCodes: codeCounts.size,
    duplicateCodes,
    missingCodeRows,
    imageCells,
    priceCells,
  };

  return {
    snapshot,
    collection,
    counts,
    cellValues,
    rawEvidenceSha256: collection.rawEvidenceSha256 ?? '',
    rawEvidenceBytes: collection.rawEvidenceBytes ?? 0,
    wikiNode: nodeData,
    sheetInfo: infoData,
    requestedRange,
    observedRange,
    documentModifiedLabel,
    sheetId,
    worksheetTitle,
    url: FEISHU_PRODUCT_SOURCE_URL,
    readRevision: integerOrNull(readData.revision) ?? integerOrNull(valueRange.revision),
  };
}

/** snapshotDir 里已有的同内容快照文件名（内容相同则不重复写文件）。 */
function findExistingSnapshotFile(snapshotDir: string, snapshotKey: string): string | null {
  const key8 = snapshotKey.slice(0, 8);
  let entries: string[];
  try {
    entries = fs.readdirSync(snapshotDir);
  } catch {
    return null;
  }
  const suffix = `-${key8}.json`;
  return entries.find((name) => name.startsWith(FEISHU_SNAPSHOT_FILE_PREFIX) && name.endsWith(suffix)) ?? null;
}

function writeJsonFile(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * 真实读取飞书商品来源并落盘快照。
 *
 * - status='captured'：首次（或内容变化后）写入快照 + 原始响应 + 取证元数据；
 * - status='unchanged'：内容 snapshotKey 与已有快照相同，不重复写快照文件（仍写 reader-status）；
 * - status='failed'：任何校验/CLI 失败；不写快照、不回退旧数据，只记录状态与错误码。
 */
export async function captureFeishuProductSource(options: FeishuCaptureOptions): Promise<FeishuCaptureResult> {
  const snapshotDir = typeof options.snapshotDir === 'string' ? options.snapshotDir.trim() : '';
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const fail = (code: FeishuCaptureErrorCode, message: string): FeishuCaptureResult => {
    if (snapshotDir !== '') {
      try {
        writeReaderStatus(snapshotDir, {
          lastResult: 'failed',
          lastRunAt: startedAt,
          updatedAt: startedAt,
          errorCode: code,
          errorMessage: message.slice(0, 800),
        });
      } catch {
        // 状态文件写不进去也不能掩盖真实错误；worker 会记录本轮失败日志。
      }
    }
    return {
      status: 'failed',
      snapshotKey: null,
      snapshotFile: null,
      capturedAt: startedAt,
      documentModifiedLabel: null,
      counts: null,
      errorCode: code,
      errorMessage: message.slice(0, 800),
    };
  };

  if (snapshotDir === '') {
    return fail('FEISHU_CAPTURE_FAILED', 'snapshotDir 不能为空');
  }
  try {
    const runner = resolveFeishuCliRunner({ cliRunnerPath: options.cliRunnerPath });
    const parsed = readSheet(runner.runnerPath, now);
    const snapshotKey = parsed.snapshot.snapshotKey;
    const existing = findExistingSnapshotFile(snapshotDir, snapshotKey);
    const baseName = `${FEISHU_SNAPSHOT_FILE_PREFIX}${utcStamp(new Date(parsed.snapshot.capturedAt))}-${snapshotKey.slice(0, 8)}`;
    if (existing) {
      writeReaderStatus(snapshotDir, {
        lastResult: 'unchanged',
        lastRunAt: parsed.snapshot.capturedAt,
        updatedAt: parsed.snapshot.capturedAt,
        snapshotKey,
        capturedAt: parsed.snapshot.capturedAt,
        counts: parsed.counts,
        errorCode: null,
        errorMessage: null,
      });
      return {
        status: 'unchanged',
        snapshotKey,
        snapshotFile: existing,
        capturedAt: parsed.snapshot.capturedAt,
        documentModifiedLabel: parsed.documentModifiedLabel,
        counts: parsed.counts,
        errorCode: null,
        errorMessage: null,
      };
    }

    // 落盘：快照 + 完整原始响应 + 取证元数据（都在 snapshotDir 内，真实读取只写 .local）。
    try {
      fs.mkdirSync(snapshotDir, { recursive: true });
      const snapshotFile = `${baseName}.json`;
      const snapshotPath = path.join(snapshotDir, snapshotFile);
      writeJsonFile(snapshotPath, parsed.snapshot);
      writeJsonFile(path.join(snapshotDir, `${baseName}.capture.json`), {
        capturedAt: parsed.snapshot.capturedAt,
        method: 'feishu_api',
        url: parsed.url,
        sheetId: parsed.sheetId,
        worksheetTitle: parsed.worksheetTitle,
        requestedRange: parsed.requestedRange,
        observedRange: parsed.observedRange,
        cliRunnerPath: runner.runnerPath,
        cliRunnerSource: runner.source,
        requests: {
          wiki: ['wiki', '+node-get', '--token', FEISHU_PRODUCT_SOURCE_URL],
          info: ['sheets', '+info', '--url', `https://${FEISHU_PRODUCT_SOURCE_HOST}/sheets/${textOrNull(parsed.wikiNode.obj_token) ?? ''}`],
          read: [
            'sheets', '+read',
            '--url', `https://${FEISHU_PRODUCT_SOURCE_HOST}/sheets/${textOrNull(parsed.wikiNode.obj_token) ?? ''}`,
            '--range', parsed.requestedRange,
            '--value-render-option', 'FormattedValue',
          ],
        },
        wikiNode: parsed.wikiNode,
        sheetInfo: parsed.sheetInfo,
        valueRange: {
          range: parsed.observedRange,
          revision: parsed.readRevision,
          values: parsed.cellValues,
        },
      });
      writeJsonFile(path.join(snapshotDir, `${baseName}.capture-metadata.json`), {
        // 注意：这里刻意不用 `contract` 键。local-reader 会扫描同目录所有 *.json，
        // 只认 contract=ice-product-source-snapshot-v1 的文件为快照；元数据文件若带
        // `contract` 会被当成缺 rows/origin 的快照而抛 SOURCE_SNAPSHOT_INVALID。
        snapshotContract: SNAPSHOT_CONTRACT,
        profileKey: SOURCE_PROFILE_KEY,
        capturedAt: parsed.snapshot.capturedAt,
        snapshotKey,
        snapshotFile,
        documentModifiedLabel: parsed.documentModifiedLabel,
        collection: parsed.collection,
        counts: parsed.counts,
        rawEvidenceSha256: parsed.rawEvidenceSha256,
        rawEvidenceBytes: parsed.rawEvidenceBytes,
      });
      writeReaderStatus(snapshotDir, {
        lastResult: 'captured',
        lastRunAt: parsed.snapshot.capturedAt,
        updatedAt: parsed.snapshot.capturedAt,
        snapshotKey,
        capturedAt: parsed.snapshot.capturedAt,
        counts: parsed.counts,
        errorCode: null,
        errorMessage: null,
      });
      return {
        status: 'captured',
        snapshotKey,
        snapshotFile,
        capturedAt: parsed.snapshot.capturedAt,
        documentModifiedLabel: parsed.documentModifiedLabel,
        counts: parsed.counts,
        errorCode: null,
        errorMessage: null,
      };
    } catch (error) {
      const message = String((error as Error)?.message ?? error).slice(0, 500);
      return fail('FEISHU_CAPTURE_WRITE_FAILED', message);
    }
  } catch (error) {
    if (error instanceof FeishuCaptureError) return fail(error.code, error.message);
    const message = String((error as Error)?.message ?? error).slice(0, 500);
    return fail('FEISHU_CAPTURE_FAILED', message);
  }
}

/** 供脚本/服务层判断「当前配置能不能读」而不真正读表。 */
export function feishuCaptureConfigState(options: { cliRunnerPath?: string } = {}): {
  configured: boolean;
  url: string;
  runnerPath: string | null;
  errorCode: FeishuCaptureErrorCode | null;
  errorMessage: string | null;
} {
  try {
    const runner = resolveFeishuCliRunner({ cliRunnerPath: options.cliRunnerPath });
    return { configured: true, url: FEISHU_PRODUCT_SOURCE_URL, runnerPath: runner.runnerPath, errorCode: null, errorMessage: null };
  } catch (error) {
    if (error instanceof FeishuCaptureError) {
      return { configured: false, url: FEISHU_PRODUCT_SOURCE_URL, runnerPath: null, errorCode: error.code, errorMessage: error.message };
    }
    const message = String((error as Error)?.message ?? error);
    return { configured: false, url: FEISHU_PRODUCT_SOURCE_URL, runnerPath: null, errorCode: 'FEISHU_CAPTURE_FAILED', errorMessage: message };
  }
}

export { SNAPSHOT_CONTRACT, SOURCE_PROFILE_KEY };
