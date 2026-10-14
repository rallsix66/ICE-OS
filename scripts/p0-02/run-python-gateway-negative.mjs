import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { DEFAULT_RUN_ID, REPO_ROOT, newEvidenceSessionDir } from './common.mjs';
import { guardP001Entry } from './entry-guard.mjs';

const runId = DEFAULT_RUN_ID;
guardP001Entry(runId);
const evidenceDir = newEvidenceSessionDir(runId, 'python-gateway-negative');
const scraperRoot = path.join(REPO_ROOT, 'tools', 'bigseller-scraper');

const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
const result = spawnSync(
  pythonCmd,
  ['-m', 'unittest', 'sync.test_p0_02_connection_boundary'],
  {
    cwd: scraperRoot,
    env: {
      ...process.env,
      PYTHONPATH: scraperRoot,
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  },
);

const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
fs.writeFileSync(path.join(evidenceDir, 'unittest.log'), output);

if (result.status !== 0) {
  console.error('python gateway negative tests failed', { status: result.status });
  console.error(output);
  process.exit(result.status ?? 1);
}

console.log(`python gateway negative tests passed (evidence: ${evidenceDir})`);
