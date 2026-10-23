#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const archiveRoot = path.join(repoRoot, 'archive/legacy-business-20261022');
const archiveSrc = path.join(archiveRoot, 'src');
const manifestPath = path.join(archiveRoot, 'manifest.json');

function sha256File(abs) {
  return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
}

function listFilesUnder(absDir, relPrefix = '') {
  const out = [];
  if (!fs.existsSync(absDir)) return out;
  for (const name of fs.readdirSync(absDir)) {
    const abs = path.join(absDir, name);
    const rel = relPrefix ? `${relPrefix}/${name}` : name;
    if (fs.statSync(abs).isDirectory()) out.push(...listFilesUnder(abs, rel));
    else out.push({ abs, relativePath: rel.replace(/\\/g, '/') });
  }
  return out;
}

if (!fs.existsSync(archiveSrc)) {
  console.error('archive src missing', archiveSrc);
  process.exit(1);
}

const files = listFilesUnder(archiveSrc).map(({ abs, relativePath }) => ({
  relativePath,
  sha256: sha256File(abs),
})).sort((a, b) => a.relativePath.localeCompare(b.relativePath));

const manifest = {
  archivedAt: new Date().toISOString(),
  archiveRoot: 'archive/legacy-business-20261022',
  fileCount: files.length,
  files,
};

fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Regenerated manifest with ${files.length} files`);
