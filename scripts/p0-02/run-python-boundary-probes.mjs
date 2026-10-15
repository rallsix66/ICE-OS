/**
 * P0-02 DELIVERY-05：独立模式下 legacy Supabase 路径须在触达 .env.local 前拒绝。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { DEFAULT_RUN_ID, REPO_ROOT, ensureEnvContract, loadInstance, runRoot } from './common.mjs';
import { buildP001ProcessEnv } from './env-whitelist.mjs';
import { guardP001Entry } from './entry-guard.mjs';

const runId = DEFAULT_RUN_ID;
guardP001Entry(runId);
const instance = loadInstance(runId);
const envJson = ensureEnvContract(instance, path.join(runRoot(runId), 'env.p0-02.json'));
const env = buildP001ProcessEnv({ P0_02_ENABLED: 'true' }, envJson);

const py = `
import os
os.environ['P0_02_ENABLED'] = 'true'
os.environ.setdefault('P0_02_SYNC_DATABASE_URL', ${JSON.stringify(envJson.P0_02_SYNC_DATABASE_URL)})
os.environ.setdefault('P0_02_EXPECTED_SYNC_USER', ${JSON.stringify(envJson.P0_02_EXPECTED_SYNC_USER ?? 'ice_p0_02_sync_runner')})
os.environ.setdefault('P0_02_EXPECTED_HOST', ${JSON.stringify(envJson.P0_02_EXPECTED_HOST)})
os.environ.setdefault('P0_02_EXPECTED_PORT', ${JSON.stringify(String(envJson.P0_02_EXPECTED_PORT))})
os.environ.setdefault('P0_02_EXPECTED_DATABASE', ${JSON.stringify(envJson.P0_02_EXPECTED_DATABASE)})

from sync.executor import _ensure_supabase_rest
from sync.name_backfill import _get_env

errors = []
for label, fn in [
    ('ensure_supabase_rest', _ensure_supabase_rest),
    ('name_backfill_get_env', _get_env),
]:
    try:
        fn()
        errors.append(f'{label}: expected RuntimeError, got success')
    except RuntimeError as e:
        if 'P0-02' not in str(e) and '独立' not in str(e):
            errors.append(f'{label}: unexpected message: {e}')
    except Exception as e:
        errors.append(f'{label}: unexpected {type(e).__name__}: {e}')

if errors:
    print('FAIL')
    for e in errors:
        print(e)
    raise SystemExit(1)
print('python boundary probes passed')
`;

const result = spawnSync('python', ['-c', py], {
  cwd: path.join(REPO_ROOT, 'tools', 'bigseller-scraper'),
  env: { ...process.env, ...env, PYTHONPATH: path.join(REPO_ROOT, 'tools', 'bigseller-scraper') },
  encoding: 'utf8',
});

if (result.status !== 0) {
  console.error(result.stdout);
  console.error(result.stderr);
  process.exit(result.status ?? 1);
}
console.log(result.stdout.trim());
