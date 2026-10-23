#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const archiveRoot = path.join(repoRoot, 'archive/legacy-business-20261022');
const archiveSrc = path.join(archiveRoot, 'src');
const manifestPath = path.join(archiveRoot, 'manifest.json');

if (process.argv.includes('--allow-resume')) {
  console.error('Resume mode is not implemented. Use regenerate-legacy-manifest.mjs on an existing archive.');
  process.exit(2);
}

if (fs.existsSync(manifestPath) || fs.existsSync(archiveSrc)) {
  console.error('Refusing to run: legacy archive already exists. Zero-write guard.');
  console.error('To refresh hashes only: node scripts/catalog/regenerate-legacy-manifest.mjs');
  process.exit(2);
}

const FEATURE_DIRS = [
  'sync',
  'shipments',
  'inventory',
  'products',
  'variants',
  'replenishment',
  'dashboard',
  'product-overview',
  'preferences',
  'in-transit',
  'warehouse',
  'warehouse-access',
  'users',
];

const DASHBOARD_DIRS = [
  'inventory',
  'shipments',
  'sync',
  'variants',
  'products',
  'replenishment',
  'users',
];

const DASHBOARD_FILES = [
  'app/dashboard/page.tsx',
  'app/dashboard/_components/sidebar-nav.tsx',
  'app/dashboard/_components/dashboard-kpi-cards.tsx',
  'app/dashboard/_components/low-stock-summary-section.tsx',
  'app/dashboard/_components/upcoming-arrivals.tsx',
  'app/dashboard/_components/warehouse-health-card.tsx',
  'app/dashboard/_components/stat-cards.tsx',
];

const API_FILES = [
  'app/api/products/route.ts',
  'app/api/inventory/route.ts',
  'app/api/shipments/route.ts',
  'app/api/users/route.ts',
  'app/api/cron/golucky/route.ts',
  'app/api/cron/dry-run/route.ts',
  'app/api/p0-02/dashboard/route.ts',
  'app/api/p0-02/inventory/route.ts',
];

const CATALOG_LEGACY_FILES = ['features/catalog/components/catalog-table.tsx'];

function sha256File(abs) {
  return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
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

function copyIntoArchive(from, relDir) {
  const to = path.join(archiveSrc, relDir);
  ensureDir(path.dirname(to));
  fs.cpSync(from, to, { recursive: true, force: true });
  fs.rmSync(from, { recursive: true, force: true });
  return listFilesUnder(to, relDir.replace(/\\/g, '/')).map(({ abs, relativePath }) => ({
    relativePath,
    sha256: sha256File(abs),
  }));
}

function moveWholeDir(relDir) {
  const from = path.join(repoRoot, 'src', relDir);
  if (!fs.existsSync(from)) {
    console.warn('skip missing dir', relDir);
    return [];
  }
  return copyIntoArchive(from, relDir);
}

function moveRel(relPath) {
  const from = path.join(repoRoot, 'src', relPath);
  if (!fs.existsSync(from)) {
    console.warn('skip missing', relPath);
    return null;
  }
  const to = path.join(archiveSrc, relPath);
  ensureDir(path.dirname(to));
  fs.cpSync(from, to, { force: true });
  fs.rmSync(from, { force: true });
  return { relativePath: relPath.replace(/\\/g, '/'), sha256: sha256File(to) };
}

ensureDir(archiveSrc);
const manifestEntries = [];

for (const dir of FEATURE_DIRS) manifestEntries.push(...moveWholeDir(path.join('features', dir)));
for (const dir of DASHBOARD_DIRS) manifestEntries.push(...moveWholeDir(path.join('app/dashboard', dir)));
for (const rel of [...DASHBOARD_FILES, ...API_FILES, ...CATALOG_LEGACY_FILES]) {
  const entry = moveRel(rel);
  if (entry) manifestEntries.push(entry);
}

const byPath = new Map();
for (const entry of manifestEntries) byPath.set(entry.relativePath, entry);

const manifest = {
  archivedAt: new Date().toISOString(),
  archiveRoot: 'archive/legacy-business-20261022',
  fileCount: byPath.size,
  files: [...byPath.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
};

fs.writeFileSync(path.join(archiveRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Archived ${byPath.size} files to ${archiveRoot}`);
