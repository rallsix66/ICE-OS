/**
 * 货票在途：飞书物流表定时读取后台进程。
 *
 * - 每 pollSeconds 上报一次心跳，并向数据库申请「到点的读取租约」；拿到租约才真实读取飞书。
 * - 读取/解析/身份匹配/入库复用页面手动刷新同一套 TS 代码（src/features/shipment/server），
 *   不复制业务口径；数据库入库函数会同时采用已确认的商品对应。
 * - 数据库运行身份是受限的 ice_p0_02_sync_runner（只用 027 的后台 RPC），不依赖浏览器登录，
 *   不保存管理员密码；操作者/读取人记为 NULL，不冒充人工操作。
 * - 同一来源同时只允许一轮读取（租约，手动刷新与定时读取共用）。读取失败只写 failed 快照，
 *   上一份成功数据与来源时间保留，下一周期继续重试。
 *
 * 用法：node scripts/shipment/worker.mjs --config <instance/shipment-auto-reader.json>
 *      [--run-once]  受控验证用：只处理一轮（到点才跑），不常驻。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function readArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else { args[key] = next; i += 1; }
  }
  return args;
}

const args = readArgs(process.argv.slice(2));
if (!args.config || typeof args.config !== 'string') {
  console.error('SHIPMENT_READER_CONFIG_REQUIRED: use --config <instance/shipment-auto-reader.json>');
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(path.resolve(args.config), 'utf8'));
const runOnce = args['run-once'] === true;

// 明确把飞书 CLI 运行账户/路径接入启动方式（start-worker.mjs 写入配置并传环境）。
if (config.cliRunnerPath && !process.env.SHIPMENT_LARK_CLI_RUNNER) {
  process.env.SHIPMENT_LARK_CLI_RUNNER = config.cliRunnerPath;
}

const logDir = config.logPath;
fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, `reader-${new Date().toISOString().slice(0, 10)}.jsonl`);
function log(event, detail = {}) {
  const line = JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event, ...detail });
  fs.appendFileSync(logFile, `${line}\n`);
  if (!runOnce) console.log(line);
}

const owner = `auto:${config.workerId}:${process.pid}`;
let stopping = false;
let pool = null;
let timeoutTimer = null;
/** 由 main() 通过 TS loader 加载的共享模块（读取/解析/入库 pipeline 与归一化）。 */
let source = null;
let pipeline = null;
let normalize = null;

function sleep(ms) {
  return new Promise((resolve) => {
    timeoutTimer = setTimeout(resolve, ms);
  });
}

async function rpc(spec, params = []) {
  const result = await pool.query(`SELECT ${spec} AS result`, params);
  return result.rows[0]?.result;
}

async function loadPipeline() {
  const { createTsLoader } = await import('../catalog/feishu-source/ts-loader.mjs');
  const loader = createTsLoader({ tempDir: config.tsTempDir });
  const source = await loader.load(path.join(REPO_ROOT, 'src/features/shipment/server/source-core.ts'));
  const pipeline = await loader.load(path.join(REPO_ROOT, 'src/features/shipment/server/refresh-pipeline.ts'));
  const normalize = await loader.load(path.join(REPO_ROOT, 'src/features/shipment/server/normalize.ts'));
  return { source, pipeline, normalize };
}

/** 一轮：申请租约 → 读取/解析/身份匹配/入库（同时采用已确认对应）→ 回写结果。 */
async function runOneCycle() {
  const claim = await rpc('catalog.worker_claim_shipment_read($1,$2)', [owner, process.pid]);
  if (!claim || claim.claimed !== true) {
    return { claimed: false, claim };
  }
  const startedAt = new Date().toISOString();
  log('cycle-start', { startedAt, sourceKey: claim.sourceKey, intervalMinutes: claim.intervalMinutes });
  let outcome;
  try {
    outcome = await pipeline.runShipmentRefresh({
      readBy: null,
      readSource: () => source.readShipmentSource(),
      identityIndex: async () => {
        const raw = await rpc('catalog.worker_read_shipment_identity_index()');
        return normalize.normalizeIdentityIndex(raw);
      },
      grouping: async () => normalize.normalizeGroupingContext(
        await rpc('catalog.worker_read_shipment_grouping_state()')),
      // 第十四轮：拆/合票检测对照上一成功读取的飞书原始分组（不自动沿用绑定）。
      previousSnapshotRaw: async () => normalize.normalizeSnapshotRaw(
        await rpc('catalog.worker_read_shipment_latest_snapshot_raw()')),
      recordGroupingReviews: async (reviews) => {
        await rpc('catalog.worker_record_shipment_grouping_reviews($1)', [JSON.stringify(
          reviews.map((review) => ({
            kind: review.kind,
            signature: review.signature,
            evidence: review.evidence,
            fromSnapshotId: review.fromSnapshotId,
            toSnapshotId: review.toSnapshotId,
          })),
        )]);
      },
      ingest: async (snapshot) => rpc('catalog.worker_ingest_shipment_snapshot($1)',
        [JSON.stringify(snapshot)]),
      recordFailure: async (failure) => {
        await rpc('catalog.worker_record_shipment_read_failure($1)', [JSON.stringify({
          sourceKey: config.sourceKey,
          readAt: failure.readAt,
          errorCode: failure.errorCode,
          errorMessage: failure.errorMessage,
        })]);
      },
    });
  } catch (error) {
    outcome = {
      ok: false,
      readAt: startedAt,
      ticketCount: 0,
      itemCount: 0,
      createdTickets: 0,
      updatedTickets: 0,
      snapshotId: null,
      errorCode: 'SHIPMENT_READER_FAILED',
      errorMessage: String(error?.message ?? error).slice(0, 500),
    };
  }
  const unchanged = outcome.ok && outcome.createdTickets === 0 && outcome.updatedTickets === 0;
  const status = outcome.ok ? (unchanged ? 'unchanged' : 'success') : 'failed';
  const finish = await rpc('catalog.worker_finish_shipment_read($1,$2)', [owner, JSON.stringify({
    status,
    snapshotId: outcome.snapshotId ?? null,
    readAt: outcome.readAt,
    ticketCount: outcome.ticketCount,
    itemCount: outcome.itemCount,
    errorCode: outcome.errorCode,
    errorMessage: outcome.errorMessage,
  })]);
  log('cycle-finish', {
    status,
    ok: outcome.ok,
    readAt: outcome.readAt,
    snapshotId: outcome.snapshotId ?? null,
    ticketCount: outcome.ticketCount,
    itemCount: outcome.itemCount,
    adoptedAssociations: outcome.adoptedAssociations ?? 0,
    errorCode: outcome.errorCode,
    errorMessage: outcome.errorMessage,
    finished: finish?.ok === true,
  });
  return { claimed: true, status, outcome };
}

async function main() {
  const { default: pg } = await import('pg');
  pool = new pg.Pool({ connectionString: config.syncDbUrl, max: 1 });
  const modules = await loadPipeline();
  source = modules.source;
  pipeline = modules.pipeline;
  normalize = modules.normalize;
  log('start', {
    workerId: config.workerId,
    owner,
    sourceKey: config.sourceKey,
    cliRunnerPath: process.env.SHIPMENT_LARK_CLI_RUNNER ?? null,
    runOnce,
  });
  // 启动即上报一次心跳：页面无需等第一个读取周期就能看出后台是否在运行。
  await rpc('catalog.worker_shipment_heartbeat($1)', [process.pid]);
  const pollMs = Math.max(5, Number(config.pollSeconds ?? 20)) * 1000;
  while (!stopping) {
    try {
      await rpc('catalog.worker_shipment_heartbeat($1)', [process.pid]);
      const result = await runOneCycle();
      if (runOnce) {
        log('run-once-finished', { claimed: result.claimed === true, status: result.status ?? null });
        break;
      }
      if (result.claimed === false && result.claim?.busy) {
        log('skip-busy', { leaseOwner: result.claim.leaseOwner, leaseUntil: result.claim.leaseUntil });
      }
    } catch (error) {
      log('cycle-error', { message: String(error?.message ?? error).slice(0, 500) });
      if (runOnce) process.exitCode = 1;
    }
    if (runOnce) break;
    await sleep(pollMs);
  }
  log('stop', { stopping });
  if (pool) await pool.end().catch(() => {});
  if (timeoutTimer) clearTimeout(timeoutTimer);
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log('signal', { signal });
  if (timeoutTimer) clearTimeout(timeoutTimer);
  // 让 while 循环尽快结束；数据库连接在 main 末尾关闭。
  setTimeout(() => process.exit(0), 50).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch((error) => {
  log('fatal', { message: String(error?.stack ?? error?.message ?? error).slice(0, 2000) });
  process.exitCode = 1;
});
