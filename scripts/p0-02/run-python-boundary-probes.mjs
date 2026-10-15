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
import sync.name_backfill as nb
from sync.executor import _ensure_supabase_rest
from sync.p0_02_connection_boundary import independent_p0_02_enabled

errors = []

# Cold guards
for label, fn in [
    ('ensure_supabase_rest', _ensure_supabase_rest),
]:
    os.environ['P0_02_ENABLED'] = 'true'
    try:
        fn()
        errors.append(f'{label}: expected RuntimeError, got success')
    except RuntimeError as e:
        if 'P0-02' not in str(e) and '独立' not in str(e):
            errors.append(f'{label}: unexpected message: {e}')

# name_backfill: guard before cache; unified enabled parsing
nb._env_cache = {'NEXT_PUBLIC_SUPABASE_URL': 'https://fictional.invalid', 'SUPABASE_SERVICE_ROLE_KEY': 'x'}
for flag in ('true', '1', 'yes'):
    os.environ['P0_02_ENABLED'] = flag
    try:
        nb._get_env()
        errors.append(f'name_backfill cached env with P0_02_ENABLED={flag}: expected reject')
    except RuntimeError:
        pass
    except Exception as e:
        errors.append(f'name_backfill cached unexpected {type(e).__name__}: {e}')

nb._env_cache = None
open_attempts = {'count': 0}
real_open = open
def guarded_open(path, *args, **kwargs):
    text = str(path)
    if '.env.local' in text.replace('\\\\', '/'):
        open_attempts['count'] += 1
        raise OSError('CONTROLLED_ENV_READ')
    return real_open(path, *args, **kwargs)

import builtins
builtins.open = guarded_open
os.environ['P0_02_ENABLED'] = '1'
try:
    nb._get_env()
    errors.append('name_backfill with P0_02_ENABLED=1 attempted env read without reject')
except RuntimeError:
    pass
except OSError as e:
    if 'CONTROLLED_ENV_READ' not in str(e):
        errors.append(f'name_backfill unexpected OSError: {e}')
finally:
    builtins.open = real_open
    nb._env_cache = None

if open_attempts['count'] > 0:
    errors.append('name_backfill reached .env.local open while P0-02 enabled')

if not independent_p0_02_enabled():
    errors.append('independent_p0_02_enabled should accept 1/yes/true')

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
