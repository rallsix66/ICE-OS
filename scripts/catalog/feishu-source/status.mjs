/**
 * 飞书商品来源「只读定时读取」状态（运维入口）。
 *
 * 同时看三件事：
 *   1. 本实例后台读取进程是否在运行、是否确属本实例（marker + 进程归属）；
 *   2. snapshotDir/reader-status.json 里最近一次真实读取的结果、时间、计数、失败原因；
 *   3. 本实例配置（snapshotDir、间隔、lark-cli 路径）。
 *
 * 用法：node scripts/catalog/feishu-source/status.mjs --run-id <run-2026...>
 * 退出码：0 = 进程归属成立且最近一次读取不是 failed；1 = 其它。
 */
import fs from 'node:fs';
import path from 'node:path';
import { openRun, readArgs } from '../../catalog/prepare.mjs';
import { pidAlive, verifyWorkerOwnership } from '../../shipment/process-ownership.mjs';

const args = readArgs(process.argv.slice(2));
const run = openRun(args);
const instanceRoot = run.instanceRoot;
const configPath = path.join(instanceRoot, 'product-source-reader.json');
const markerPath = path.join(instanceRoot, 'product-source-reader.pid.json');

const report = {
  runId: args.runId,
  configured: false,
  config: null,
  snapshotDir: null,
  readerProcess: null,
  readerStatus: null,
  summary: null,
};

if (fs.existsSync(configPath)) {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    report.configured = true;
    report.config = {
      workerId: config.workerId ?? null,
      intervalMinutes: config.intervalMinutes ?? null,
      snapshotDir: config.snapshotDir ?? null,
      cliRunnerPath: config.cliRunnerPath ?? null,
      createdAt: config.createdAt ?? null,
    };
    report.snapshotDir = typeof config.snapshotDir === 'string' && config.snapshotDir
      ? config.snapshotDir
      : path.join(run.root, 'source-snapshots');
  } catch {
    report.configured = false;
  }
}
if (!report.snapshotDir) report.snapshotDir = path.join(run.root, 'source-snapshots');

if (fs.existsSync(markerPath)) {
  let marker = null;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch {
    marker = null;
  }
  if (!marker) {
    report.readerProcess = { markerInvalid: true, owned: false, alive: false };
  } else if (!pidAlive(marker.pid)) {
    report.readerProcess = {
      pid: marker.pid,
      workerId: marker.workerId,
      alive: false,
      owned: false,
      code: 'PRODUCT_SOURCE_READER_PID_NOT_ALIVE',
      logFile: marker.logFile ?? null,
    };
  } else {
    const ownership = verifyWorkerOwnership(marker);
    report.readerProcess = {
      pid: marker.pid,
      workerId: marker.workerId,
      startedAt: marker.startedAt,
      processCreatedAt: marker.processCreatedAt,
      configPath: marker.configPath,
      workerScript: marker.workerScript,
      cliRunnerPath: marker.cliRunnerPath ?? null,
      snapshotDir: marker.snapshotDir ?? null,
      logFile: marker.logFile ?? null,
      alive: true,
      owned: ownership.ok,
      code: ownership.ok ? null : ownership.code,
      message: ownership.ok ? null : ownership.message,
    };
  }
} else {
  report.readerProcess = null;
}

const statusFile = path.join(report.snapshotDir, 'reader-status.json');
if (fs.existsSync(statusFile)) {
  try {
    const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    report.readerStatus = {
      method: status.method ?? null,
      updatedAt: status.updatedAt ?? null,
      lastRunAt: status.lastRunAt ?? null,
      nextRunAt: status.nextRunAt ?? null,
      intervalMinutes: status.intervalMinutes ?? null,
      lastResult: status.lastResult ?? null,
      snapshotKey: status.snapshotKey ?? null,
      capturedAt: status.capturedAt ?? null,
      counts: status.counts ?? null,
      errorCode: status.errorCode ?? null,
      errorMessage: status.errorMessage ?? null,
      worker: status.worker ?? null,
    };
  } catch {
    report.readerStatus = { invalid: true };
  }
} else {
  report.readerStatus = null;
}

const owned = report.readerProcess?.owned === true;
const lastResult = report.readerStatus?.lastResult ?? null;
report.summary = {
  configured: report.configured,
  readerProcessOwned: owned,
  lastResult,
  lastRunAt: report.readerStatus?.lastRunAt ?? null,
  nextRunAt: report.readerStatus?.nextRunAt ?? null,
  intervalMinutes: report.readerStatus?.intervalMinutes ?? report.config?.intervalMinutes ?? null,
  snapshotDir: report.snapshotDir,
  businessRows: report.readerStatus?.counts?.businessRows ?? null,
  uniqueCodes: report.readerStatus?.counts?.uniqueCodes ?? null,
  imageCells: report.readerStatus?.counts?.imageCells ?? null,
  errorCode: report.readerStatus?.errorCode ?? null,
};
console.log(JSON.stringify(report, null, 2));
process.exitCode = owned && lastResult !== 'failed' && lastResult !== null ? 0 : 1;
