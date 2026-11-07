/**
 * 货票在途「定时读取」状态（运维入口）。
 *
 * 同时看三件事：
 *   1. 本实例后台读取进程是否在运行、是否确属本实例（marker + 进程归属）；
 *   2. 数据库里的定时读取状态（启用、间隔、最近一次结果/失败原因、下次计划、心跳是否在线）；
 *   3. 当前来源与绑定计数（最近成功快照 revision、票/明细、已关联/未关联、已确认对应条数）。
 *
 * 用法：node scripts/shipment/status.mjs --run-id <run-2026...>
 */
import fs from 'node:fs';
import path from 'node:path';
import { openRun, readArgs } from '../catalog/prepare.mjs';
import { pidAlive, verifyWorkerOwnership } from './process-ownership.mjs';

const args = readArgs(process.argv.slice(2));
const run = openRun(args);
const inventoryEnvPath = path.join(run.instanceRoot, 'env.inventory.json');
const report = { runId: args.runId, database: null, readerProcess: null, readerState: null, source: null };
if (!fs.existsSync(inventoryEnvPath)) {
  console.log(JSON.stringify({ ...report, prepared: false }, null, 2));
  process.exit(1);
}
const inventoryEnv = JSON.parse(fs.readFileSync(inventoryEnvPath, 'utf8'));
report.database = {
  host: inventoryEnv.host,
  port: inventoryEnv.port,
  database: inventoryEnv.database,
  webPort: inventoryEnv.webPort,
  url: `${inventoryEnv.previewUrl}/dashboard/in-transit`,
};

const markerPath = path.join(run.instanceRoot, 'shipment-auto-reader.pid.json');
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
    report.readerProcess = { pid: marker.pid, workerId: marker.workerId, alive: false, owned: false,
      code: 'SHIPMENT_READER_PID_NOT_ALIVE', logFile: marker.logFile ?? null };
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

const { default: pg } = await import('pg');
const pool = new pg.Pool({ connectionString: inventoryEnv.ownerDbUrl ?? inventoryEnv.syncDbUrl, max: 1 });
try {
  const state = (await pool.query(
    `SELECT enabled, interval_minutes, next_run_at, last_started_at, last_finished_at, last_result,
            last_read_at, last_ticket_count, last_item_count, last_error_code, last_error_message,
            heartbeat_at, runner_pid,
            (heartbeat_at IS NOT NULL AND now()-heartbeat_at < interval '90 seconds') AS worker_online,
            (read_lease_until IS NOT NULL AND read_lease_until > now()) AS running
     FROM catalog.shipment_auto_reader WHERE id`)).rows[0] ?? null;
  report.readerState = state;
  const source = (await pool.query(
    `SELECT s.id AS snapshot_id, s.revision, s.read_finished_at, s.status,
            s.ticket_count, s.item_count
     FROM catalog.shipment_source_snapshot s
     WHERE s.status='success' ORDER BY s.read_finished_at DESC, s.created_at DESC, s.id DESC LIMIT 1`
  )).rows[0] ?? null;
  if (source) {
    const counts = (await pool.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE product_id IS NOT NULL)::int AS bound,
              count(*) FILTER (WHERE product_id IS NULL)::int AS unbound,
              count(*) FILTER (WHERE association_method='confirmed_mapping')::int AS confirmed_mapping,
              count(*) FILTER (WHERE association_method='manual_cleared')::int AS manual_cleared
       FROM catalog.shipment_item WHERE last_seen_snapshot_id=$1`, [source.snapshot_id])).rows[0];
    const mappings = (await pool.query(
      'SELECT count(*)::int AS mappings FROM catalog.shipment_product_mapping')).rows[0].mappings;
    report.source = { ...source, counts, mappings };
  }
} finally {
  await pool.end();
}

report.summary = {
  readerProcessOwned: report.readerProcess?.owned === true,
  workerOnline: report.readerState?.worker_online === true,
  enabled: report.readerState?.enabled ?? null,
  intervalMinutes: report.readerState?.interval_minutes ?? null,
  lastResult: report.readerState?.last_result ?? null,
  nextRunAt: report.readerState?.next_run_at ?? null,
  bound: report.source?.counts?.bound ?? null,
  unbound: report.source?.counts?.unbound ?? null,
};
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.summary.readerProcessOwned && report.summary.workerOnline ? 0 : 1;
