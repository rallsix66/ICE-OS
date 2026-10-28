/**
 * Freeze the inventory worker source into the run instance.
 *
 * The preview web is built from a frozen workspace snapshot; the background worker must not keep
 * loading `tools/inventory-sync` from the moving repository after delivery. `prepare-instance.mjs`
 * copies the exact candidate Python source into `<instance>/inventory-worker-src` and records its
 * sha256 manifest; `start-worker.mjs` only launches that frozen copy.
 *
 * Refresh is explicit (`--refresh-worker-source`) so an accidental working-tree edit cannot silently
 * change what the running instance executes; the manifest hash is printed in `status.mjs`.
 *
 * Safety (repair v3 F5.1): an existing frozen copy is never silently rebuilt. `first-only` (the default)
 * freezes a completely uninitialized instance once and otherwise only verifies; a corrupt/drifted copy
 * throws and is preserved. `refresh` replaces it but refuses while this instance's worker is alive.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT } from '../catalog/prepare.mjs';
import { pidAlive } from './worker-process-ownership.mjs';

const SOURCE_RELATIVE = 'tools/inventory-sync';
const DEST_NAME = 'inventory-worker-src';
const MANIFEST_NAME = 'inventory-worker-source.json';
const MODES = new Set(['first-only', 'refresh']);

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** @returns {Record<string,string>} repository-relative path -> sha256 */
export function collectWorkerSource() {
  const root = path.join(REPO_ROOT, SOURCE_RELATIVE);
  const files = {};
  function walk(dir, relative) {
    for (const child of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = path.posix.join(relative, child.name);
      const full = path.join(dir, child.name);
      if (child.isSymbolicLink()) throw new Error('INVENTORY_WORKER_SOURCE_LINK_DENIED');
      if (child.isDirectory()) {
        if (child.name === '__pycache__') continue;
        walk(full, rel);
        continue;
      }
      if (!child.name.endsWith('.py') && child.name !== '__init__.py') continue;
      files[rel] = sha256File(full);
    }
  }
  walk(root, SOURCE_RELATIVE);
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}

function snapshotHash(files) {
  return crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex');
}

export function workerSourcePaths(instanceRoot) {
  return {
    destDir: path.join(instanceRoot, DEST_NAME),
    manifestPath: path.join(instanceRoot, MANIFEST_NAME),
    workerScript: path.join(instanceRoot, DEST_NAME, 'worker.py'),
  };
}

/** Verify the frozen copy on disk matches its manifest (detects edits after freeze). */
export function verifyFrozenWorkerSource(instanceRoot) {
  const { destDir, manifestPath, workerScript } = workerSourcePaths(instanceRoot);
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, code: 'INVENTORY_WORKER_SOURCE_MISSING', message: 'frozen worker source manifest missing' };
  }
  if (!fs.existsSync(workerScript)) {
    return { ok: false, code: 'INVENTORY_WORKER_SOURCE_MISSING', message: `frozen worker script missing: ${workerScript}` };
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return { ok: false, code: 'INVENTORY_WORKER_SOURCE_MANIFEST_INVALID', message: 'frozen worker source manifest is not valid JSON' };
  }
  if (!manifest?.files || typeof manifest.files !== 'object' || !manifest.snapshotHash) {
    return { ok: false, code: 'INVENTORY_WORKER_SOURCE_MANIFEST_INVALID', message: 'frozen worker source manifest is incomplete' };
  }
  for (const [rel, expected] of Object.entries(manifest.files)) {
    const file = path.join(REPO_ROOT, rel);
    const dest = path.join(destDir, path.basename(rel));
    if (!fs.existsSync(dest)) {
      return { ok: false, code: 'INVENTORY_WORKER_SOURCE_DRIFT', message: `frozen file missing: ${dest}` };
    }
    if (sha256File(dest) !== expected) {
      return { ok: false, code: 'INVENTORY_WORKER_SOURCE_DRIFT', message: `frozen file changed after freeze: ${dest}` };
    }
    void file;
  }
  if (snapshotHash(manifest.files) !== manifest.snapshotHash) {
    return { ok: false, code: 'INVENTORY_WORKER_SOURCE_MANIFEST_INVALID', message: 'frozen worker manifest hash does not match its file list' };
  }
  return { ok: true, manifest, workerScript, destDir };
}

/** Freeze (or explicitly refresh) the worker source into the instance.
 *
 * Modes:
 *   - `first-only` (default): a completely uninitialized instance (no manifest and no frozen directory)
 *     may be frozen once. An existing frozen copy/manifest is only verified: a failing verification is
 *     thrown and the files are left untouched (no silent rebuild of edited/corrupt code).
 *   - `refresh`: explicitly replace the frozen copy. Refused while this instance's worker is alive
 *     (`INVENTORY_WORKER_RUNNING_REFUSE_REFRESH`) so a running process never has its loaded files swapped.
 */
export function freezeWorkerSource(instanceRoot, { refresh = false, mode } = {}) {
  const effectiveMode = refresh === true ? 'refresh' : (mode ?? 'first-only');
  if (!MODES.has(effectiveMode)) {
    throw new Error(`INVENTORY_WORKER_FREEZE_MODE_INVALID:${effectiveMode}`);
  }
  const { destDir, manifestPath } = workerSourcePaths(instanceRoot);

  if (effectiveMode === 'first-only') {
    const existing = verifyFrozenWorkerSource(instanceRoot);
    if (existing.ok) {
      return { state: 'already_frozen', source: existing.manifest };
    }
    const manifestExists = fs.existsSync(manifestPath);
    const frozenDirExists = fs.existsSync(destDir) && fs.readdirSync(destDir).length > 0;
    if (manifestExists || frozenDirExists) {
      throw new Error(
        `${existing.code}:${existing.message}; refusing to rebuild an existing frozen worker source `
        + '(explicit --refresh-worker-source required)',
      );
    }
    // Completely uninitialized instance: the single allowed automatic first freeze.
  } else if (workerIsRunning(instanceRoot)) {
    throw new Error(
      'INVENTORY_WORKER_RUNNING_REFUSE_REFRESH:this instance worker is alive; stop it before replacing '
      + 'the frozen source files it loaded',
    );
  }

  const files = collectWorkerSource();
  fs.mkdirSync(destDir, { recursive: true });
  const keep = new Set(Object.keys(files).map((rel) => path.basename(rel)));
  for (const name of fs.readdirSync(destDir)) {
    if (!keep.has(name)) fs.rmSync(path.join(destDir, name), { force: true, recursive: true });
  }
  for (const [rel, expected] of Object.entries(files)) {
    const file = path.join(REPO_ROOT, rel);
    const dest = path.join(destDir, path.basename(rel));
    fs.copyFileSync(file, dest);
    if (sha256File(dest) !== expected) throw new Error(`INVENTORY_WORKER_SOURCE_COPY_MISMATCH:${rel}`);
  }
  const manifest = {
    package: 'inventory-sync-v1',
    sourceRoot: REPO_ROOT,
    sourceRelative: SOURCE_RELATIVE,
    frozenAt: new Date().toISOString(),
    files,
    snapshotHash: snapshotHash(files),
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { state: effectiveMode === 'refresh' ? 'refreshed' : 'frozen', source: manifest };
}

/** True when this instance's recorded worker pid is alive (a live pid alone is enough to refuse refresh). */
export function workerIsRunning(instanceRoot) {
  const markerPath = path.join(instanceRoot, 'inventory-worker.pid.json');
  if (!fs.existsSync(markerPath)) return false;
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    return pidAlive(marker?.pid);
  } catch {
    return false;
  }
}

/** Compare the frozen instance copy with the current working tree (drift is reported, not fatal). */
export function workerSourceDrift(instanceRoot) {
  try {
    const frozen = verifyFrozenWorkerSource(instanceRoot);
    const current = collectWorkerSource();
    const currentHash = snapshotHash(current);
    if (!frozen.ok) {
      return { verified: false, code: frozen.code, message: frozen.message, currentSnapshotHash: currentHash };
    }
    const repoMatchesFrozen = currentHash === frozen.manifest.snapshotHash;
    return {
      verified: true,
      frozenSnapshotHash: frozen.manifest.snapshotHash,
      currentSnapshotHash: currentHash,
      repoDrift: !repoMatchesFrozen,
      frozenAt: frozen.manifest.frozenAt,
      files: Object.keys(frozen.manifest.files).length,
    };
  } catch (error) {
    return { verified: false, code: 'INVENTORY_WORKER_SOURCE_CHECK_FAILED', message: String(error?.message ?? error) };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const runId = process.argv[process.argv.indexOf('--run-id') + 1];
  const refresh = process.argv.includes('--refresh-worker-source');
  const firstOnly = process.argv.includes('--first-only');
  if (!runId) {
    console.error('usage: node scripts/inventory/freeze-worker-source.mjs --run-id <run> [--first-only|--refresh-worker-source]');
    process.exit(2);
  }
  try {
    const instanceRoot = path.join(REPO_ROOT, '.local', 'catalog', runId, 'instance');
    const result = freezeWorkerSource(instanceRoot, { refresh, mode: refresh ? 'refresh' : 'first-only' });
    console.log(`${result.state}: ${result.source.snapshotHash} (${Object.keys(result.source.files).length} py files)`);
    if (firstOnly && !refresh) console.log('first-only: existing frozen source verified or uninitialized instance frozen; nothing replaced');
  } catch (error) {
    console.error(String(error?.message ?? error));
    process.exitCode = 1;
  }
}
