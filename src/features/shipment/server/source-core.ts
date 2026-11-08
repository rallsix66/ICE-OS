import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';

import {
  ShipmentSourceError,
  SHIPMENT_SOURCE_KEY,
  type ShipmentSourceCollection,
  type ShipmentSourceMergedRange,
} from '../types';
import { computeLastNonEmptyRow, excelColumnLetter } from './parse';

/**
 * 货票来源读取的核心实现（Next 服务端动作与后台定时任务共用同一套读取逻辑）。
 *
 * 已授权读取入口是本机 `lark-cli`（bot 身份，凭据在系统凭据库，不进入 ICEOS）。
 * 每次刷新由服务端重新读取，不是一次性导入；任何一步失败都抛 ShipmentSourceError，
 * 由调用方记失败快照并保留上一份有效数据。
 *
 * 本文件不引 `server-only`：本机后台进程（scripts/shipment/worker.mjs）用 TS loader
 * 直接复用它；`source.ts` 保留 server-only 标记供页面/动作入口使用。
 */

const DEFAULT_WIKI_URL =
  'https://ygr1tb7cyf.feishu.cn/wiki/EZXAwpgA8iCms2kF2l1cnzQDnhd?from=from_copylink&sheet=b42d8b';

const CLI_TIMEOUT_MS = 90_000;

export function shipmentSourceUrl(): string {
  const configured = process.env.SHIPMENT_FEISHU_URL?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_WIKI_URL;
}

interface CliRunner {
  command: string;
  prefixArgs: string[];
}

/**
 * lark-cli 启动方式：优先直接跑包内 run.js（避免 .cmd/引号问题），可用环境变量覆盖。
 * 显式覆盖是权威配置：指到不存在的文件就直接失败（不静默回退到别的 CLI）。
 */
function resolveCliRunner(): CliRunner | null {
  const override = process.env.SHIPMENT_LARK_CLI_RUNNER?.trim();
  if (override) {
    return existsSync(override) ? { command: process.execPath, prefixArgs: [override] } : null;
  }
  const appData = process.env.APPDATA;
  if (appData) {
    const fallback = path.join(appData, 'npm', 'node_modules', '@larksuite', 'cli', 'scripts', 'run.js');
    if (existsSync(fallback)) return { command: process.execPath, prefixArgs: [fallback] };
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ShipmentSourceError('SOURCE_CLI_BAD_JSON', `${what} 不是对象`);
  return value;
}

function requireArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new ShipmentSourceError('SOURCE_CLI_BAD_JSON', `${what} 不是数组`);
  return value;
}

function textOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text === '' ? null : text;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

/** 运行一次 lark-cli 子命令并解析 stdout JSON（stderr 只作失败诊断，不当成功输出）。 */
function runLarkCli(runner: CliRunner, args: string[]): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn(runner.command, [...runner.prefixArgs, ...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new ShipmentSourceError('SOURCE_CLI_TIMEOUT', `${args[0]} ${args[1]} 超过 ${CLI_TIMEOUT_MS}ms`));
    }, CLI_TIMEOUT_MS);
    const finish = (error: ShipmentSourceError | null, value?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value ?? {});
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      finish(new ShipmentSourceError('SOURCE_CLI_MISSING', error.message));
    });
    child.on('close', (code) => {
      if (code !== 0) {
        const detail = stderr.trim().slice(0, 400) || `lark-cli 退出码 ${code}`;
        finish(new ShipmentSourceError('SOURCE_CLI_FAILED', detail));
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        const detail = stdout.trim().slice(0, 200) || stderr.trim().slice(0, 200);
        finish(new ShipmentSourceError('SOURCE_CLI_BAD_JSON', detail));
        return;
      }
      const payload = requireRecord(parsed, 'lark-cli 输出');
      if (payload.ok !== true) {
        const error = isRecord(payload.error) ? payload.error : {};
        const message = textOrNull(error.message) ?? 'lark-cli 返回 ok=false';
        finish(new ShipmentSourceError('SOURCE_CLI_FAILED', message.slice(0, 400)));
        return;
      }
      finish(null, payload);
    });
  });
}

export interface RawShipmentSourceRead {
  collection: ShipmentSourceCollection;
  values: Array<Array<string | number | null>>;
  merges: ShipmentSourceMergedRange[];
}

export interface ShipmentSourceConfigState {
  configured: boolean;
  url: string;
  runnerPath: string | null;
}

/** 页面/动作入口判断“来源是否已配置可用”，不读表格。 */
export function shipmentSourceConfig(): ShipmentSourceConfigState {
  const runner = resolveCliRunner();
  return {
    configured: runner !== null,
    url: shipmentSourceUrl(),
    runnerPath: runner ? runner.prefixArgs[0] ?? null : null,
  };
}

/**
 * 读取真实来源。成功返回网格与合并区（未解析业务口径），失败抛 ShipmentSourceError。
 * 每次调用都真实访问飞书，不使用缓存或一次性快照。
 */
export async function readShipmentSource(): Promise<RawShipmentSourceRead> {
  const runner = resolveCliRunner();
  if (!runner) {
    const override = process.env.SHIPMENT_LARK_CLI_RUNNER?.trim();
    const detail = override
      ? `SHIPMENT_LARK_CLI_RUNNER 指向的文件不存在：${override}`
      : '未找到 lark-cli（可设置 SHIPMENT_LARK_CLI_RUNNER 指定 run.js 路径）';
    throw new ShipmentSourceError('SOURCE_CLI_MISSING', detail);
  }
  const url = shipmentSourceUrl();
  const readStartedAt = new Date().toISOString();

  // 1) wiki 节点 → spreadsheet token / 文档编辑时间
  const nodePayload = await runLarkCli(runner, ['wiki', '+node-get', '--token', url]);
  const node = requireRecord(nodePayload.data, 'wiki 节点数据');
  const docToken = textOrNull(node.obj_token);
  const objType = textOrNull(node.obj_type);
  if (!docToken) throw new ShipmentSourceError('SOURCE_DOC_UNRESOLVED', '没有解析到文档 token');
  if (objType && objType !== 'sheet') {
    throw new ShipmentSourceError('SOURCE_DOC_UNRESOLVED', `文档类型不是电子表格：${objType}`);
  }
  const docTitle = textOrNull(node.title);
  const documentEditedAt = textOrNull(node.updated_at);

  const sourceUrl = new URL(url);
  const sheetUrl = `https://${sourceUrl.host}/sheets/${docToken}`;
  const urlSheetId = textOrNull(sourceUrl.searchParams.get('sheet'));

  // 2) 工作表信息（工作表 id、行数、合并区）
  const infoPayload = await runLarkCli(runner, ['sheets', '+info', '--url', sheetUrl]);
  const infoData = requireRecord(infoPayload.data, '工作表信息');
  const sheetsBox = requireRecord(infoData.sheets, '工作表集合');
  const sheetEntries = requireArray(sheetsBox.sheets, '工作表列表').map((entry, index) =>
    requireRecord(entry, `工作表 #${index + 1}`),
  );
  if (sheetEntries.length === 0) throw new ShipmentSourceError('SOURCE_SHEET_MISSING', '文档里没有工作表');
  const target = urlSheetId
    ? sheetEntries.find((entry) => textOrNull(entry.sheet_id) === urlSheetId)
    : sheetEntries[0];
  if (!target) throw new ShipmentSourceError('SOURCE_SHEET_MISSING', `没有找到工作表 ${urlSheetId}`);
  const sheetId = textOrNull(target.sheet_id);
  if (!sheetId) throw new ShipmentSourceError('SOURCE_SHEET_MISSING', '工作表缺少 sheet_id');
  const sheetTitle = textOrNull(target.title) ?? sheetId;
  const grid = requireRecord(target.grid_properties, '工作表网格属性');
  const gridRows = numberOrNull(grid.row_count);
  const gridColumns = numberOrNull(grid.column_count);
  if (!gridRows || gridRows < 2) throw new ShipmentSourceError('SOURCE_GRID_INVALID', `工作表行数异常：${gridRows}`);
  if (!gridColumns || gridColumns < 3) {
    throw new ShipmentSourceError('SOURCE_GRID_INVALID', `工作表列数异常：${gridColumns}`);
  }
  const merges: ShipmentSourceMergedRange[] = requireArray(target.merges ?? [], '合并区').map((entry) => {
    const record = requireRecord(entry, '合并区');
    const startRow = numberOrNull(record.start_row_index);
    const endRow = numberOrNull(record.end_row_index);
    const startColumn = numberOrNull(record.start_column_index);
    const endColumn = numberOrNull(record.end_column_index);
    if (startRow === null || endRow === null || startColumn === null || endColumn === null) {
      throw new ShipmentSourceError('SOURCE_GRID_INVALID', '合并区索引不完整');
    }
    return { startRow, endRow, startColumn, endColumn };
  });

  // 3) 读取全部网格
  const lastColumn = excelColumnLetter(gridColumns);
  const range = `${sheetId}!A1:${lastColumn}${gridRows}`;
  const readPayload = await runLarkCli(runner, ['sheets', '+read', '--url', sheetUrl, '--range', range]);
  const readData = requireRecord(readPayload.data, '工作表读取结果');
  const valueRange = requireRecord(readData.valueRange, '读取值范围');
  const revision = numberOrNull(readData.revision) ?? numberOrNull(valueRange.revision);
  if (revision === null) throw new ShipmentSourceError('SOURCE_REVISION_MISSING', '读取结果缺少 revision');
  const rawRows = requireArray(valueRange.values, '读取值').map((row) => requireArray(row, '读取值行'));
  const values = rawRows.map((row) =>
    row.map((cell) => {
      if (cell === null || cell === undefined) return null;
      if (typeof cell === 'number') return Number.isFinite(cell) ? cell : null;
      if (typeof cell === 'string') return cell;
      return String(cell);
    }),
  );
  if (values.length < 2) throw new ShipmentSourceError('SOURCE_EMPTY', '工作表只有表头，没有数据行');

  const readFinishedAt = new Date().toISOString();
  const contentHash = hashContent({ revision, values, merges });
  const collection: ShipmentSourceCollection = {
    sourceKey: SHIPMENT_SOURCE_KEY,
    url,
    docTitle,
    docToken,
    documentEditedAt,
    sheetId,
    sheetTitle,
    revision,
    readStartedAt,
    readFinishedAt,
    readBy: null,
    gridRows,
    readRows: values.length,
    lastNonEmptyRow: computeLastNonEmptyRow(values),
    headers: [], // 由解析层的表头定位填充
    merges,
    rawContentHash: contentHash,
  };

  return { collection, values, merges };
}

/**
 * 解析口径版本：只参与内容哈希，不改变来源时间。
 * 口径变化（如 2026-11-01 改为“到货只按 H 判断”）时递增，保证同一份来源内容会被
 * 重新解析入库一次，而不是被旧的 unchanged 判断挡住；版本不变时重复读取仍然 unchanged。
 */
const SHIPMENT_PARSER_VERSION = 'shipment-parse-2026-11-04-item-arrival-v3';

function hashContent(input: { revision: number; values: Array<Array<string | number | null>>; merges: ShipmentSourceMergedRange[] }): string {
  // 只用业务内容 + 解析口径版本做哈希（不含读取时间），用于“内容是否变化”的证据判断。
  return createHash('sha256')
    .update(JSON.stringify({ ...input, parserVersion: SHIPMENT_PARSER_VERSION }))
    .digest('hex');
}
