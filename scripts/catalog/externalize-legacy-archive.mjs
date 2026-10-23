#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourceArchive = path.join(repoRoot, 'archive/legacy-business-20261022');
const targetRoot = process.env.LEGACY_ARCHIVE_TARGET ?? 'D:/try one/ICEOS-legacy-archive/20261022';

function sha256File(abs) {
  return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
}

function listFiles(absDir, prefix = '') {
  const out = [];
  for (const name of fs.readdirSync(absDir)) {
    const abs = path.join(absDir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (fs.statSync(abs).isDirectory()) out.push(...listFiles(abs, rel));
    else out.push({ abs, rel: rel.replace(/\\/g, '/') });
  }
  return out;
}

if (!fs.existsSync(sourceArchive)) {
  console.error('Source archive missing', sourceArchive);
  process.exit(1);
}

if (fs.existsSync(targetRoot)) {
  const existing = listFiles(targetRoot);
  if (existing.length > 0) {
    console.error('Target already exists and is not empty:', targetRoot);
    process.exit(2);
  }
}

fs.mkdirSync(targetRoot, { recursive: true });
const files = listFiles(sourceArchive);
for (const { abs, rel } of files) {
  const dest = path.join(targetRoot, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(abs, dest);
}

const verify = [];
for (const { abs, rel } of files) {
  const dest = path.join(targetRoot, rel);
  const a = sha256File(abs);
  const b = sha256File(dest);
  if (a !== b) {
    console.error('Hash mismatch', rel);
    process.exit(3);
  }
  verify.push({ relativePath: rel, sha256: a });
}

const pointer = {
  externalizedAt: new Date().toISOString(),
  targetRoot,
  fileCount: verify.length,
  files: verify.sort((x, y) => x.relativePath.localeCompare(y.relativePath)),
};
fs.writeFileSync(path.join(repoRoot, 'archive/legacy-business-20261022/EXTERNAL-POINTER.json'), `${JSON.stringify(pointer, null, 2)}\n`);
console.log(`Externalized ${verify.length} files to ${targetRoot}`);
