import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  DEFAULT_RUN_ID,
  REPO_ROOT,
  ensureEnvContract,
  loadInstance,
  newEvidenceSessionDir,
  runRoot,
  withHiddenWindowsSpawnOptions,
} from './common.mjs';
import { buildP001ProcessEnv } from './env-whitelist.mjs';
import { guardP001Entry } from './entry-guard.mjs';

const runId = DEFAULT_RUN_ID;
guardP001Entry(runId);
const evidenceDir = newEvidenceSessionDir(runId, 'python-legacy-regression');
const scraperRoot = path.join(REPO_ROOT, 'tools', 'bigseller-scraper');
const instance = loadInstance(runId);
const envJson = ensureEnvContract(instance, path.join(runRoot(runId), 'env.p0-02.json'));
const env = buildP001ProcessEnv({}, envJson);

const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
const runner = path.join(scraperRoot, 'sync', 'run_legacy_test_module.py');

const scripts = [
  { file: 'sync/test_executor.py', note: 'executor isolated regression (__main__)', required: true },
  { file: 'sync/test_name_backfill.py', note: 'name backfill isolated regression (__main__)', required: true },
  {
    file: 'sync/test_cli_integration.py',
    note: 'cli integration (__main__) under legacy isolation',
    required: true,
  },
];

function legacyEnv(scriptFile) {
  const base = {
    ...env,
    PYTHONPATH: scraperRoot,
    SYNC_LEGACY_TEST_ISOLATED: '1',
    P0_02_ENABLED: 'false',
  };
  for (const key of Object.keys(base)) {
    if (key.startsWith('P0_02') && key !== 'P0_02_RUN_ID') {
      delete base[key];
    }
  }
  delete base.DATABASE_URL;
  delete base.PGHOST;
  delete base.PGPORT;
  delete base.PGUSER;
  delete base.PGPASSWORD;
  delete base.PGDATABASE;
  if (scriptFile.includes('cli')) {
    delete base.BS_WAREHOUSE_COUNTRY;
    delete base.BS_TARGET_WAREHOUSE_NAME;
    delete base.BS_OLD_WAREHOUSE_NAME;
    delete base.BS_NEW_VARIANT_COUNTRY;
  }
  return base;
}

let combinedOutput = '';
let exitCode = 0;
const scriptResults = [];

for (const script of scripts) {
  const abs = path.join(scraperRoot, script.file);
  if (!fs.existsSync(abs)) {
    combinedOutput += `\n=== ${script.file} ===\nMISSING required script\n`;
    scriptResults.push({ file: script.file, required: script.required, status: 'missing' });
    if (script.required) {
      exitCode = 1;
    }
    continue;
  }
  const result = spawnSync(
    pythonCmd,
    [runner, abs],
    withHiddenWindowsSpawnOptions({
      cwd: scraperRoot,
      env: legacyEnv(script.file),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    }),
  );
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  combinedOutput += `\n=== ${script.file} (${script.note}) ===\n${out}`;
  const passMatches = (out.match(/\bPASS:/g) ?? []).length;
  const failMatches = (out.match(/\bFAIL:/g) ?? []).length;
  const status = result.status ?? 1;
  scriptResults.push({
    file: script.file,
    required: script.required,
    status,
    passCount: passMatches,
    failCount: failMatches,
  });
  if (script.required && (status !== 0 || passMatches === 0 || failMatches > 0)) {
    exitCode = status !== 0 ? status : 1;
    break;
  }
}

fs.writeFileSync(path.join(evidenceDir, 'legacy.log'), combinedOutput);
fs.writeFileSync(
  path.join(evidenceDir, 'result.json'),
  `${JSON.stringify({ scriptResults, requiredGateExit: exitCode }, null, 2)}\n`,
);

if (exitCode !== 0) {
  console.error('python legacy regression failed', { status: exitCode });
  console.error(combinedOutput);
  process.exit(exitCode);
}

console.log(`python legacy regression passed (evidence: ${evidenceDir})`);
