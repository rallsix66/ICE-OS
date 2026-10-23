/**
 * Isolated VM evaluation of actual start-local-preview.mjs and stop-local-preview.mjs.
 * Requires: node --experimental-vm-modules
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { priorPreviewAction } from './preview-start-prior-action.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function buildStartExports(scenario, events, marker, runId, instanceRoot, virtualRoot) {
  let alive = true;
  let markerExists = true;
  return {
    exportsByModule: {
      'node:fs': {
        default: {
          existsSync(p) {
            if (p.endsWith('local-sample-valuation-basis-20261021.json')) return true;
            if (p === path.join(instanceRoot, 'preview-server.json')) {
              if (['build-failed', 'increments-failed'].includes(scenario)) return false;
              return markerExists;
            }
            return true;
          },
          readFileSync(p) {
            if (p.endsWith('catalog-instance.json')) return JSON.stringify({ previewReady: true, port: 5432 });
            if (p === path.join(instanceRoot, 'preview-server.json')) return JSON.stringify(marker);
            if (p.endsWith('env.catalog.json')) return '{}';
            throw new Error(`Unexpected read ${p}`);
          },
          rmSync(p) {
            events.push({ action: 'remove-marker', path: p });
            if (p === path.join(instanceRoot, 'preview-server.json')) markerExists = false;
          },
          writeFileSync() {
            events.push({ action: 'write-file' });
          },
          openSync() {
            return 1;
          },
        },
      },
      'node:path': { default: path },
      'node:net': {
        default: {
          createConnection(_opts, cb) {
            const sock = { end() {}, on() {} };
            queueMicrotask(cb);
            return sock;
          },
        },
      },
      'node:child_process': {
        spawnSync(_exec, args) {
          const joined = args.join(' ');
          if (joined.includes('stop-local-preview')) {
            events.push({ action: 'controlled-stop' });
            if (scenario === 'unready-exit-timeout' || scenario === 'controlled-stop-failed') {
              return { status: 1, stderr: 'simulated stop timeout' };
            }
            alive = false;
            markerExists = false;
            return { status: 0 };
          }
          if (joined.includes('build')) {
            events.push({ action: 'next-build' });
            if (scenario === 'build-failed') return { status: 1, stderr: 'simulated build failure' };
            return { status: 0 };
          }
          events.push({ action: 'spawn-sync-other', args: joined });
          return { status: 0 };
        },
        spawn() {
          events.push({ action: 'spawn-new' });
          if (scenario === 'increments-failed') throw new Error('REVIEW_REACHED_SPAWN');
          throw new Error('REVIEW_REACHED_SPAWN');
        },
      },
      './preview-start-prior-action.mjs': { priorPreviewAction },
      './prepare.mjs': {
        REPO_ROOT,
        detachedHiddenSpawnOptions: (x) => x,
        openRun: () => ({ instanceRoot, root: virtualRoot }),
        readArgs: () => ({ runId }),
        safeEnv: (x) => x ?? {},
        writeJson() {
          events.push({ action: 'write-json' });
        },
      },
      './start-catalog-postgres.mjs': {
        async startCatalogPostgres() {
          events.push({ action: 'start-postgres' });
        },
      },
      './ensure-preview-workspace.mjs': {
        previewWorkspaceRefreshNeeded() {
          events.push({ action: 'check-refresh' });
          return { needed: scenario === 'source-changed' || scenario === 'controlled-stop-failed' };
        },
        ensurePreviewWorkspace() {
          events.push({ action: 'ensure-workspace', alive });
          return { workspace: marker.workspace, manifest: { sourceSnapshotHash: 'mock' } };
        },
      },
      './preview-process-ownership.mjs': {
        pidAlive: () => alive,
        readPreviewProcessCreatedAtIso: () => marker.processCreatedAt,
        verifyPreviewServerOwnership() {
          events.push({ action: 'verify-ownership' });
          return scenario === 'ownership-rejected'
            ? { ok: false, code: 'EXPECTED_REJECT', message: 'test' }
            : { ok: true };
        },
      },
      './apply-catalog-increments.mjs': {
        async applyCatalogIncrements() {
          events.push({ action: 'apply-increments' });
          if (scenario === 'increments-failed') throw new Error('CATALOG_SQL_INCREMENT_APPLY_FAILED');
        },
      },
    },
    markerExists: () => markerExists,
    setAlive: (value) => { alive = value; },
  };
}

async function runStartControlFlowScenarios(virtualRoot) {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'scripts/catalog/start-local-preview.mjs'), 'utf8');
  const results = [];
  for (const scenario of [
    'running-unchanged',
    'ownership-rejected',
    'source-changed',
    'unready-exit-timeout',
    'preview-mode-changed',
    'build-failed',
    'increments-failed',
    'controlled-stop-failed',
  ]) {
    const events = [];
    const runId = 'run-20261021T000000Z-aaaaaaaa';
    const instanceRoot = path.join(virtualRoot, `start-${scenario}`);
    const marker = {
      pid: 12345,
      runId,
      workspace: path.join(instanceRoot, 'next-workspace'),
      port: 3010,
      previewMode: scenario === 'preview-mode-changed' ? 'dev' : 'start',
      processCreatedAt: '2026-10-21T00:00:00.000Z',
      startedAt: '2026-10-21T00:00:01.000Z',
    };
    let exitCode = null;
    let thrown = null;
    let virtualNow = 0;
    class FakeDate extends Date {
      static now() {
        virtualNow += scenario === 'unready-exit-timeout' ? 16_000 : 1;
        return virtualNow;
      }
    }
    const { exportsByModule } = buildStartExports(scenario, events, marker, runId, instanceRoot, virtualRoot);
    const fakeProcess = {
      argv: ['node', 'start', '--run-id', runId],
      env: { CATALOG_PREVIEW_NEXT_MODE: 'start' },
      execPath: process.execPath,
      kill(pid) {
        events.push({ action: 'kill', pid });
      },
      exit(code) {
        exitCode = code;
        throw new Error('REVIEW_PROCESS_EXIT');
      },
    };
    const context = vm.createContext({
      process: fakeProcess,
      console: { log: (msg) => events.push({ action: 'log', msg }) },
      setTimeout: (cb) => {
        queueMicrotask(cb);
        return 0;
      },
      Date: FakeDate,
      fetch: async () => ({ status: scenario === 'unready-exit-timeout' ? 503 : 200 }),
    });
    const startModule = new vm.SourceTextModule(source, { context, identifier: 'actual-start-local-preview.mjs' });
    await startModule.link(async (spec) => {
      const ex = exportsByModule[spec];
      if (!ex) throw new Error(`Unexpected import ${spec}`);
      return new vm.SyntheticModule(Object.keys(ex), function link() {
        for (const [k, v] of Object.entries(ex)) this.setExport(k, v);
      }, { context });
    });
    try {
      await startModule.evaluate();
    } catch (e) {
      thrown = e instanceof Error ? e.message : String(e);
    }
    const expected = scenario === 'running-unchanged'
      ? events.some((e) => e.action === 'apply-increments')
        && !events.some((e) => ['kill', 'remove-marker', 'spawn-new', 'ensure-workspace', 'controlled-stop', 'next-build'].includes(e.action))
        && exitCode === 0
      : scenario === 'ownership-rejected'
        ? events.filter((e) => e.action === 'verify-ownership').length === 1
          && !events.some((e) => ['remove-marker', 'apply-increments'].includes(e.action))
          && thrown?.includes('EXPECTED_REJECT')
      : scenario === 'source-changed'
        ? events.findIndex((e) => e.action === 'controlled-stop') < events.findIndex((e) => e.action === 'ensure-workspace')
          && !events.find((e) => e.action === 'ensure-workspace')?.alive
      : scenario === 'preview-mode-changed'
        ? events.some((e) => e.action === 'controlled-stop') && events.some((e) => e.action === 'apply-increments')
      : scenario === 'build-failed'
        ? thrown?.includes('CATALOG_PREVIEW_BUILD_FAILED') && events.some((e) => e.action === 'next-build')
      : scenario === 'increments-failed'
        ? thrown?.includes('CATALOG_SQL_INCREMENT_APPLY_FAILED') && !events.some((e) => e.action === 'spawn-new')
      : scenario === 'controlled-stop-failed'
        ? thrown?.includes('CATALOG_PREVIEW_CONTROLLED_STOP_FAILED')
          && !events.some((e) => ['ensure-workspace', 'spawn-new'].includes(e.action))
      : thrown?.includes('CATALOG_PREVIEW_CONTROLLED_STOP_FAILED')
        && !events.some((e) => ['remove-marker', 'ensure-workspace', 'spawn-new'].includes(e.action));
    results.push({
      scenario,
      subsystem: 'start',
      method: 'actual start-local-preview.mjs with virtual process/filesystem/network',
      pass: expected,
      exitCode,
      thrown,
      events,
    });
  }
  return results;
}

async function runStopControlFlowScenarios() {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'scripts/catalog/stop-local-preview.mjs'), 'utf8');
  const results = [];
  for (const name of ['ownership-rejected', 'signal-failed', 'pid-exit-timeout', 'port-still-open', 'normal-stop']) {
    const events = [];
    let alive = true;
    let markerPresent = true;
    let exitCode = null;
    let clock = 0;
    class ReviewDate extends Date {
      static now() {
        clock += 1000;
        return clock;
      }
    }
    const marker = {
      pid: 12345,
      port: 3010,
      runId: 'run-20261021T000000Z-aaaaaaaa',
      workspace: 'virtual',
      processCreatedAt: '2026-10-21T00:00:00.000Z',
    };
    const ex = {
      'node:fs': {
        default: {
          existsSync: () => markerPresent,
          readFileSync: () => JSON.stringify(marker),
          unlinkSync() {
            events.push('unlink-marker');
            markerPresent = false;
          },
        },
      },
      'node:path': { default: path },
      'node:net': {
        default: {
          createConnection(_opts, cb) {
            const socket = {
              end() {},
              on(event, error) {
                if (event === 'error' && name !== 'port-still-open') queueMicrotask(error);
              },
            };
            if (name === 'port-still-open') queueMicrotask(cb);
            return socket;
          },
        },
      },
      './prepare.mjs': {
        openRun: () => ({ instanceRoot: 'virtual' }),
        readArgs: () => ({ runId: marker.runId }),
      },
      './preview-process-ownership.mjs': {
        pidAlive: () => alive,
        verifyPreviewServerOwnership: () => (name === 'ownership-rejected'
          ? { ok: false, code: 'EXPECTED_REJECT', message: 'test' }
          : { ok: true }),
      },
    };
    const proc = {
      argv: ['node', 'stop'],
      kill() {
        events.push('kill');
        if (name === 'signal-failed') throw new Error('simulated signal failure');
        if (name !== 'pid-exit-timeout') alive = false;
      },
      exit(code) {
        exitCode = code;
        throw new Error('REVIEW_EXIT');
      },
    };
    const context = vm.createContext({
      process: proc,
      console: {
        log: (m) => events.push({ log: m }),
        error: (m) => events.push({ error: m }),
      },
      Date: ReviewDate,
      setTimeout: (cb) => {
        queueMicrotask(cb);
      },
    });
    const stopModule = new vm.SourceTextModule(source, { context, identifier: 'actual-stop-local-preview.mjs' });
    await stopModule.link(async (spec) => {
      const entry = ex[spec];
      if (!entry) throw new Error(spec);
      return new vm.SyntheticModule(Object.keys(entry), function link() {
        for (const [k, v] of Object.entries(entry)) this.setExport(k, v);
      }, { context });
    });
    let error = null;
    try {
      await stopModule.evaluate();
    } catch (e) {
      if (e instanceof Error && e.message !== 'REVIEW_EXIT') error = e.message;
      else if (!(e instanceof Error)) error = String(e);
    }
    const pass = error === null
      && (name === 'normal-stop' ? exitCode === 0 && !markerPresent : exitCode === 1 && markerPresent)
      && (name !== 'ownership-rejected' || !events.includes('kill'));
    results.push({
      scenario: name,
      subsystem: 'stop',
      method: 'actual stop-local-preview.mjs with virtual OS/filesystem/network',
      pass,
      exitCode,
      markerPresent,
      events,
      error,
    });
  }
  return results;
}

const virtualRoot = path.join(REPO_ROOT, '.local', 'catalog', '_vm-control-flow-scratch');
fs.mkdirSync(virtualRoot, { recursive: true });

const startResults = await runStartControlFlowScenarios(virtualRoot);
const stopResults = await runStopControlFlowScenarios();
const results = [...startResults, ...stopResults];
const output = {
  testedAt: new Date().toISOString(),
  nodeExperimentalVmModules: true,
  results,
  pass: results.every((r) => r.pass),
};

const evidenceDir = process.env.CATALOG_PROBE_EVIDENCE_DIR;
if (evidenceDir) {
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, 'preview-control-flow-vm-probes.json'), `${JSON.stringify(output, null, 2)}\n`);
}

console.log(JSON.stringify(output, null, 2));
process.exitCode = output.pass ? 0 : 1;
