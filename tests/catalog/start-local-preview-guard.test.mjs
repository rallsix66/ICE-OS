import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const probe = path.join(repoRoot, 'tests/catalog/fixtures/start-local-preview-guard-probe.mjs');

const run = spawnSync(process.execPath, ['--experimental-vm-modules', probe], {
  encoding: 'utf8',
  cwd: repoRoot,
});
if (run.status !== 0) {
  console.error(run.stderr || run.stdout);
  process.exit(run.status ?? 1);
}
const result = JSON.parse(run.stdout.trim());
assert.equal(result.refusalPreservesWorkspace, true);
assert.match(String(result.thrown), /CATALOG_PREVIEW_BUILD_NOT_PROMOTED/);
console.log(JSON.stringify({ ok: true, result }, null, 2));
