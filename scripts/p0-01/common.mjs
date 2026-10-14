import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '../..');
export const DEFAULT_RUN_ID = process.env.P0_01_RUN_ID ?? 'run-20261013-r1';

export function runRoot(runId = DEFAULT_RUN_ID) {
  return path.join(REPO_ROOT, '.local', 'p0-01', runId);
}

export function instancePath(runId = DEFAULT_RUN_ID) {
  return path.join(runRoot(runId), 'instance.json');
}

export function p0DatabaseName(runId) {
  return `iceos_p0_01_${runId.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`;
}

export function loadInstance(runId = DEFAULT_RUN_ID) {
  const file = instancePath(runId);
  if (!fs.existsSync(file)) {
    throw new Error(`缺少实例记录: ${file}`);
  }
  const instance = JSON.parse(fs.readFileSync(file, 'utf8'));
  const canonicalDbName = p0DatabaseName(runId);
  if (instance.dbName && instance.dbName !== canonicalDbName) {
    instance.dbName = canonicalDbName;
  }
  return instance;
}

export function saveInstance(runId, data) {
  const dir = runRoot(runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(instancePath(runId), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

export function randomSecret(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

export function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

export function newEvidenceSessionDir(runId, label) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(runRoot(runId), 'evidence', `${label}-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function collectP001SourceHashes() {
  const roots = [
    'src/lib/independent-platform',
    'src/features/p0-01-access',
    'src/app/api/p0-01',
    'db/p0-01',
    'scripts/p0-01',
  ];
  const files = {};
  for (const relRoot of roots) {
    const absRoot = path.join(REPO_ROOT, relRoot);
    if (!fs.existsSync(absRoot)) {
      continue;
    }
    const stack = [absRoot];
    while (stack.length > 0) {
      const current = stack.pop();
      const entries = fs.readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (/\.(ts|tsx|mjs|cjs|sql|mts)$/i.test(entry.name)) {
          const rel = path.relative(REPO_ROOT, full).replace(/\\/g, '/');
          files[rel] = sha256File(full);
        }
      }
    }
  }
  return files;
}

export function ensureEnvContract(instance, envPath) {
  const envJson = JSON.parse(fs.readFileSync(envPath, 'utf8').replace(/^\uFEFF/, ''));
  const expected = {
    P0_01_EXPECTED_HOST: instance.host,
    P0_01_EXPECTED_PORT: String(instance.port),
    P0_01_EXPECTED_DATABASE: instance.dbName,
    P0_01_EXPECTED_APP_USER: instance.appRunnerUser,
    P0_01_EXPECTED_AUTH_USER: instance.authRunnerUser,
  };
  let changed = false;
  for (const [key, value] of Object.entries(expected)) {
    if (envJson[key] !== value) {
      envJson[key] = value;
      changed = true;
    }
  }
  if (changed) {
    fs.writeFileSync(envPath, `${JSON.stringify(envJson, null, 2)}\n`, 'utf8');
  }
  return envJson;
}

export const PG_ZIP_URL =
  'https://get.enterprisedb.com/postgresql/postgresql-17.11-1-windows-x64-binaries.zip';

export function pgBinDir(runId = DEFAULT_RUN_ID) {
  return path.join(runRoot(runId), 'pg', 'pgsql', 'bin');
}

export function pgExe(name, runId = DEFAULT_RUN_ID) {
  return path.join(pgBinDir(runId), `${name}.exe`);
}

/**
 * Avoid flashing or persistent console windows when spawning CLI tools on Windows.
 * Uses Node's `windowsHide` so DETACHED_PROCESS and other platform flags stay correct.
 * @param {import('node:child_process').SpawnOptions | import('node:child_process').SpawnSyncOptions} [options]
 */
export function withHiddenWindowsSpawnOptions(options = {}) {
  if (process.platform !== 'win32') {
    return options;
  }
  return {
    ...options,
    windowsHide: true,
  };
}

/**
 * Detached background server process (e.g. postgres) without a console on Windows.
 * @param {import('node:child_process').SpawnOptions} [options]
 */
export function detachedHiddenServerOptions(options = {}) {
  return withHiddenWindowsSpawnOptions({
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
    ...options,
  });
}
