import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '../..');
export const DEFAULT_RUN_ID = process.env.P0_03_RUN_ID ?? 'run-20261015-r1';

export function runRoot(runId = DEFAULT_RUN_ID) {
  return path.join(REPO_ROOT, '.local', 'p0-03', runId);
}

export function newEvidenceSessionDir(runId, label) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(runRoot(runId), 'evidence', `${label}-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

export function collectP003SourceHashes() {
  const roots = ['tools/p0_03_match', 'scripts/p0-03', 'docs/p0-03', 'docs/tasks/p0-03'];
  const files = {};
  for (const relRoot of roots) {
    const absRoot = path.join(REPO_ROOT, relRoot);
    if (!fs.existsSync(absRoot)) continue;
    const stack = [absRoot];
    while (stack.length) {
      const current = stack.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (/\.(py|mjs|md|txt)$/i.test(entry.name)) {
          const rel = path.relative(REPO_ROOT, full).replace(/\\/g, '/');
          files[rel] = sha256File(full);
        }
      }
    }
  }
  return files;
}

export const DEFAULT_JUSHUITAN_EXTRA = (
  process.env.P0_03_JUSHUITAN_EXTRA ??
  'C:\\Users\\Administrator\\Desktop\\商品资料_20261016111727_201045638_1.xlsx'
)
  .split(';')
  .map((s) => s.trim())
  .filter(Boolean);

export const DEFAULT_INPUT_PATHS = {
  master: process.env.P0_03_MASTER_XLSX ?? 'C:\\Users\\Administrator\\Desktop\\Icelerskin 商品库1.xlsx',
  bigseller: process.env.P0_03_BIGSELLER_XLSX ?? 'C:\\Users\\Administrator\\Desktop\\库存清单20261015083723474.xlsx',
  jushuitan: process.env.P0_03_JUSHUITAN_XLSX ?? 'C:\\Users\\Administrator\\Desktop\\商品资料_20261015165159_200874071_1.xlsx',
};
