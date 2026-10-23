import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { previewOperatingEnv, readPreviewOperatingConfig } from './preview-operating-config.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function probeChildEnv(parentPort, parentMode) {
  const script = `
    import { readPreviewOperatingConfig, previewOperatingEnv } from './scripts/catalog/preview-operating-config.mjs';
    const parent = { CATALOG_PREVIEW_PORT: ${JSON.stringify(String(parentPort))}, CATALOG_PREVIEW_NEXT_MODE: ${JSON.stringify(parentMode)} };
    const cfg = readPreviewOperatingConfig(parent);
    const ensureChild = previewOperatingEnv(cfg);
    const out = {
      parentPort: parent.CATALOG_PREVIEW_PORT,
      ensureChildPort: ensureChild.CATALOG_PREVIEW_PORT ?? null,
      ensureChildMode: ensureChild.CATALOG_PREVIEW_NEXT_MODE ?? null,
      doubleStartInheritedPort: process.env.CATALOG_PREVIEW_PORT ?? null,
    };
    console.log(JSON.stringify(out));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: REPO_ROOT,
    env: previewOperatingEnv(readPreviewOperatingConfig({ CATALOG_PREVIEW_PORT: String(parentPort), CATALOG_PREVIEW_NEXT_MODE: parentMode })),
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || String(result.status));
  }
  return JSON.parse(result.stdout.trim());
}

const cfg3011 = readPreviewOperatingConfig({ CATALOG_PREVIEW_PORT: '3011', CATALOG_PREVIEW_NEXT_MODE: 'start' });
assert.equal(cfg3011.port, 3011);
assert.equal(cfg3011.mode, 'start');
assert.equal(cfg3011.catalogUrl, 'http://127.0.0.1:3011/dashboard/catalog');

const env3011 = previewOperatingEnv(cfg3011);
assert.equal(env3011.CATALOG_PREVIEW_PORT, '3011');
assert.equal(env3011.CATALOG_PREVIEW_NEXT_MODE, 'start');
assert.equal(env3011.P0_02_APP_DATABASE_URL, undefined);

const probe = probeChildEnv('3011', 'start');
assert.equal(probe.parentPort, '3011');
assert.equal(probe.ensureChildPort, '3011');
assert.equal(probe.ensureChildMode, 'start');
assert.equal(probe.doubleStartInheritedPort, '3011');

console.log(JSON.stringify({ at: new Date().toISOString(), probe, ok: true }, null, 2));
