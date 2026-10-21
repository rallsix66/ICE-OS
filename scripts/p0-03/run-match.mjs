import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  DEFAULT_INPUT_PATHS,
  DEFAULT_JUSHUITAN_EXTRA,
  DEFAULT_RUN_ID,
  REPO_ROOT,
  collectP003SourceHashes,
  newEvidenceSessionDir,
} from './common.mjs';

const runId = DEFAULT_RUN_ID;
const evidenceDir = newEvidenceSessionDir(runId, 'match');

for (const [key, filePath] of Object.entries(DEFAULT_INPUT_PATHS)) {
  if (!fs.existsSync(filePath)) {
    console.error(`缺少样表 ${key}: ${filePath}`);
    process.exit(1);
  }
}
for (const filePath of DEFAULT_JUSHUITAN_EXTRA) {
  if (!fs.existsSync(filePath)) {
    console.error(`缺少聚水潭补充样表: ${filePath}`);
    process.exit(1);
  }
}

const py = spawnSync(
  process.env.PYTHON ?? 'python',
  [
    '-m',
    'p0_03_match',
    'match',
    '--master',
    DEFAULT_INPUT_PATHS.master,
    '--bigseller',
    DEFAULT_INPUT_PATHS.bigseller,
    '--jushuitan',
    DEFAULT_INPUT_PATHS.jushuitan,
    ...DEFAULT_JUSHUITAN_EXTRA.flatMap((p) => ['--jushuitan-extra', p]),
    '--output',
    evidenceDir,
    ...(process.env.P0_03_REVIEW_CSV ? ['--review-csv', process.env.P0_03_REVIEW_CSV] : []),
  ],
  {
    cwd: path.join(REPO_ROOT, 'tools'),
    encoding: 'utf8',
    env: { ...process.env, PYTHONUTF8: '1' },
  },
);

if (py.stdout) process.stdout.write(py.stdout);
if (py.stderr) process.stderr.write(py.stderr);
if (py.status !== 0) process.exit(py.status ?? 1);
fs.writeFileSync(
  path.join(evidenceDir, 'source-hashes.json'),
  `${JSON.stringify(collectP003SourceHashes(), null, 2)}\n`,
);

console.log(`P0-03 match evidence: ${evidenceDir}`);
