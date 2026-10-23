import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  collectCompileArtifactHashes,
  validateReadyRecord,
  verifyCompileArtifactHashes,
} from '../../scripts/catalog/preview-build-credential.mjs';

function sha(content) {
  return createHash('sha256').update(content).digest('hex');
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ice-preview-cred-'));
const active = path.join(tmp, 'next-workspace');
const manifestPath = path.join(tmp, 'next-workspace-manifest.json');

try {
  fs.mkdirSync(path.join(active, '.next/server'), { recursive: true });
  fs.mkdirSync(path.join(active, 'src'), { recursive: true });
  fs.writeFileSync(path.join(active, 'src/sample.ts'), 'source-v1');
  fs.writeFileSync(path.join(active, '.next/BUILD_ID'), 'fixture-build');
  for (const f of ['required-server-files.json', 'build-manifest.json']) {
    fs.writeFileSync(path.join(active, '.next', f), '{}');
  }
  fs.writeFileSync(path.join(active, '.next/server/page.js'), 'compiled-v1');

  const sourceDeclared = { 'src/sample.ts': sha('source-v1') };
  const compileDeclared = collectCompileArtifactHashes(active);
  assert.ok(Object.keys(compileDeclared).some((p) => p.includes('.next/server/page.js')));

  fs.writeFileSync(manifestPath, JSON.stringify({
    compileSourceSnapshotHash: 'fixture-sha',
    buildId: 'fixture-build',
    files: sourceDeclared,
    compileArtifactHashes: compileDeclared,
  }));

  const ready = {
    compileSourceSnapshotHash: 'fixture-sha',
    buildId: 'fixture-build',
    stagingManifestFileHashes: sourceDeclared,
    compileArtifactHashes: compileDeclared,
  };
  assert.equal(validateReadyRecord(tmp, ready).ok, true);

  fs.writeFileSync(path.join(active, '.next/server/page.js'), 'compiled-v2');
  assert.equal(validateReadyRecord(tmp, ready).ok, false);

  fs.writeFileSync(path.join(active, '.next/server/page.js'), 'compiled-v1');
  verifyCompileArtifactHashes(active, compileDeclared);

  fs.rmSync(path.join(active, '.next/server/page.js'));
  assert.throws(() => verifyCompileArtifactHashes(active, compileDeclared));

  fs.writeFileSync(path.join(active, '.next/server/page.js'), 'compiled-v1');
  fs.writeFileSync(path.join(active, '.next/server/old-chunk.js'), 'stale-extra');
  assert.throws(() => verifyCompileArtifactHashes(active, compileDeclared));

  console.log(JSON.stringify({ ok: true, tmp }, null, 2));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
