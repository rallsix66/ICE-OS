import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const events = [];
const instance = path.join(repoRoot, '.local/catalog/fixture-instance-start-guard');

const fakeFs = {
  existsSync(p) {
    return !String(p).endsWith('preview-server.json');
  },
  readFileSync(p) {
    const s = String(p);
    if (s.endsWith('catalog-instance.json')) return JSON.stringify({ previewReady: true, port: 5432 });
    if (s.endsWith('preview-build-ready.json')) return JSON.stringify({ buildId: 'old-valid-build' });
    if (s.endsWith('env.catalog.json')) return '{}';
    throw new Error(`unexpected read ${p}`);
  },
  writeFileSync(p) {
    events.push({ action: 'write-file', path: String(p) });
  },
  rmSync() {
    events.push({ action: 'rm-sync' });
  },
  openSync() {
    throw new Error('unexpected open');
  },
};

const exportsMap = {
  'node:fs': { default: fakeFs },
  'node:path': { default: path },
  'node:net': {
    default: {
      createConnection(_opts, cb) {
        cb();
        return { on() {}, end() {} };
      },
    },
  },
  'node:child_process': {
    spawn() {
      throw new Error('unexpected spawn');
    },
    spawnSync() {
      throw new Error('unexpected stop');
    },
  },
  './prepare.mjs': {
    REPO_ROOT: repoRoot,
    detachedHiddenSpawnOptions: (x) => x,
    openRun: () => ({ instanceRoot: instance }),
    readArgs: () => ({ runId: 'run-fixture' }),
    safeEnv: (x) => x ?? {},
    writeJson: () => {},
  },
  './start-catalog-postgres.mjs': { startCatalogPostgres: async () => events.push({ action: 'start-pg' }) },
  './ensure-preview-workspace.mjs': {
    computePreviewSourceSnapshotHash: () => 'new-source',
    previewWorkspaceRefreshNeeded: () => ({ needed: true }),
    ensurePreviewWorkspace() {
      events.push({ action: 'ensure-workspace-before-reject' });
      return { workspace: path.join(instance, 'next-workspace'), manifest: { sourceSnapshotHash: 'new-source' } };
    },
  },
  './preview-process-ownership.mjs': {
    pidAlive: () => false,
    readPreviewProcessCreatedAtIso: () => null,
    verifyPreviewServerOwnership: () => ({ ok: true }),
  },
  './preview-start-prior-action.mjs': { priorPreviewAction: () => 'noop' },
  './apply-catalog-increments.mjs': { applyCatalogIncrements: async () => events.push({ action: 'apply-increments' }) },
  './merge-preview-node-options.mjs': { mergePreviewNodeOptions: () => '' },
  './preview-build-credential.mjs': {
    readBuildId: () => 'old-valid-build',
    verifyNextArtifacts: () => {},
    validateReadyRecord() {
      events.push({ action: 'reject-ready' });
      return { ok: false, code: 'COMPILE_ARTIFACT_INVALID' };
    },
  },
};

const source = fs.readFileSync(path.join(repoRoot, 'scripts/catalog/start-local-preview.mjs'), 'utf8');
const context = vm.createContext({
  process: {
    argv: ['node', 'start'],
    env: { CATALOG_PREVIEW_PORT: '3011', CATALOG_PREVIEW_NEXT_MODE: 'start' },
    execPath: process.execPath,
  },
  console: { log() {}, warn() {} },
  Date,
  setTimeout,
});
const mod = new vm.SourceTextModule(source, { context });
await mod.link((spec) => {
  const ex = exportsMap[spec];
  if (!ex) throw new Error(`unexpected import ${spec}`);
  return new vm.SyntheticModule(Object.keys(ex), function link() {
    for (const [k, v] of Object.entries(ex)) this.setExport(k, v);
  }, { context });
});
let thrown = null;
try {
  await mod.evaluate();
} catch (error) {
  thrown = error;
}
const result = {
  thrown: thrown ? String(thrown) : null,
  events,
  refusalPreservesWorkspace: !events.some((e) => e.action === 'ensure-workspace-before-reject'),
};
console.log(JSON.stringify(result, null, 2));
