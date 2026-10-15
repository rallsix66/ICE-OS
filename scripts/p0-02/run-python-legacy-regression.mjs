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
// Legacy __main__ suites target Supabase/mock paths; P0-02 PG paths are covered by dedicated modules.
const env = buildP001ProcessEnv({ P0_02_ENABLED: 'false' }, envJson);

const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
const scripts = [
  { file: 'sync/test_executor.py', note: 'executor isolated regression (__main__)', required: true },
  { file: 'sync/test_name_backfill.py', note: 'name backfill isolated regression (__main__)', required: true },
  {
    file: 'sync/test_cli_integration.py',
    note: 'cli integration (__main__); fixture-country scenarios are informational under p0-02 env',
    required: false,
  },
];

let combinedOutput = '';
let exitCode = 0;
const scriptResults = [];
function envForLegacyScript(scriptFile) {
  const base = {
    ...env,
    PYTHONPATH: scraperRoot,
    P0_02_ENABLED: 'false',
  };
  if (scriptFile.includes('cli')) {
    delete base.BS_WAREHOUSE_COUNTRY;
    delete base.BS_TARGET_WAREHOUSE_NAME;
    delete base.BS_OLD_WAREHOUSE_NAME;
    delete base.BS_NEW_VARIANT_COUNTRY;
  }
  return base;
}

for (const script of scripts) {
  const abs = path.join(scraperRoot, script.file);
  if (!fs.existsSync(abs)) {
    combinedOutput += `\n=== ${script.file} ===\nSKIP missing\n`;
    continue;
  }
  const result = spawnSync(
    pythonCmd,
    [abs],
    withHiddenWindowsSpawnOptions({
      cwd: scraperRoot,
      env: envForLegacyScript(script.file),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    }),
  );
  combinedOutput += `\n=== ${script.file} (${script.note}) ===\n${result.stdout ?? ''}${result.stderr ?? ''}`;
  scriptResults.push({
    file: script.file,
    required: script.required,
    status: result.status ?? 1,
  });
  if (result.status !== 0 && script.required) {
    exitCode = result.status ?? 1;
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
