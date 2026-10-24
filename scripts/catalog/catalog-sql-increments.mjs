import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './prepare.mjs';

/** Post-prepare increments applied on preview start; must stay in sync with prepare LOCAL_SQL tail. */
export const CATALOG_SQL_INCREMENT_PATHS = [
  'db/catalog/013_baseline_amounts_batch.sql',
  'db/catalog/014_audit_observation_pool_indexes.sql',
];

const INCREMENT_RUNNER_ROLE = 'ice_p0_02_app_runner';

const DB_INSTALLED_CHECKS = {
  'db/catalog/013_baseline_amounts_batch.sql': verify013BaselineAmountsBatch,
  'db/catalog/014_audit_observation_pool_indexes.sql': verify014AuditObservationPoolIndexes,
};

export function incrementManifestPath(instanceRoot) {
  return path.join(instanceRoot, 'catalog-sql-increments.json');
}

export function sha256File(relativePath) {
  const file = path.join(REPO_ROOT, relativePath);
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function normalizeFunctionBody(text) {
  return String(text)
    .replace(/\r\n/g, '\n')
    .replace(/;\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function searchPathLockedEmpty(proconfig) {
  if (!Array.isArray(proconfig)) return false;
  return proconfig.some((entry) => {
    const normalized = String(entry).toLowerCase().replace(/\s/g, '');
    return normalized === 'search_path='
      || normalized === "search_path=''"
      || normalized === 'search_path=""';
  });
}

/** @returns {{ body: string }} */
export function expected013FunctionSpecFromIncrementSql(relativePath = 'db/catalog/013_baseline_amounts_batch.sql') {
  const text = fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
  const bodyMatch = text.match(/AS \$\$([\s\S]*?)\$\$/i);
  if (!bodyMatch) throw new Error(`CATALOG_SQL_INCREMENT_PARSE_FAILED:${relativePath}`);
  return { body: normalizeFunctionBody(bodyMatch[1]) };
}

/** @deprecated Diagnostic helper; verification uses pg_proc metadata, not pg_get_functiondef text. */
export function expectedFunctionDefFromIncrementSql(relativePath) {
  const spec = expected013FunctionSpecFromIncrementSql(relativePath);
  return normalizeFunctionBody(spec.body).toLowerCase();
}

const VERIFY_013_BASELINE_AMOUNTS_BATCH_SQL = `
  SELECT
    pg_get_function_identity_arguments(p.oid) AS identity_args,
    pg_get_function_result(p.oid) AS result_type,
    l.lanname AS language,
    p.prosecdef AS security_definer,
    p.proconfig,
    p.prosrc AS body,
    pg_catalog.has_function_privilege($1, p.oid, 'EXECUTE') AS runner_grant
  FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  JOIN pg_language l ON p.prolang = l.oid
  WHERE n.nspname = 'catalog'
    AND p.proname = 'read_baseline_item_amounts_map'
    AND p.pronargs = 0
  LIMIT 1`;

function evaluate013CatalogRow(row, expectedBody) {
  if (!row) {
    return { installed: false, verified: false, reason: 'missing' };
  }
  const bodyMatches = normalizeFunctionBody(row.body) === expectedBody;
  const signatureOk = row.identity_args === '' && row.result_type === 'jsonb' && row.language === 'plpgsql';
  const securityOk = row.security_definer === true && searchPathLockedEmpty(row.proconfig);
  const runnerGrant = row.runner_grant === true || row.runner_grant === 't';
  if (!bodyMatches || !signatureOk || !securityOk) {
    return {
      installed: true,
      verified: false,
      reason: 'definition_mismatch',
      runnerGrant,
    };
  }
  if (!runnerGrant) {
    return {
      installed: true,
      verified: false,
      reason: 'grant_missing',
      runnerGrant,
    };
  }
  return { installed: true, verified: true, reason: 'ok', runnerGrant };
}

/**
 * @returns {{ state: 'missing' | 'ok', applied: Array<Record<string, unknown>>, manifestPath: string }}
 */
export function readIncrementManifest(instanceRoot) {
  const manifestPath = incrementManifestPath(instanceRoot);
  if (!fs.existsSync(manifestPath)) {
    return { state: 'missing', applied: [], manifestPath };
  }
  const raw = fs.readFileSync(manifestPath, 'utf8');
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.applied)) {
      throw new Error('invalid applied array');
    }
    return { state: 'ok', applied: parsed.applied, manifestPath };
  } catch {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = `${manifestPath}.corrupt-${stamp}`;
    fs.copyFileSync(manifestPath, backup);
    throw new Error(
      `CATALOG_SQL_INCREMENT_MANIFEST_CORRUPT:${manifestPath}:backup=${backup}:`
      + 'repair the JSON manifest or remove it only after verifying catalog SQL objects in the database',
    );
  }
}

export function writeIncrementManifest(instanceRoot, applied) {
  fs.writeFileSync(incrementManifestPath(instanceRoot), `${JSON.stringify({ applied }, null, 2)}\n`);
}

async function verify013BaselineAmountsBatch(client) {
  const { body: expectedBody } = expected013FunctionSpecFromIncrementSql('db/catalog/013_baseline_amounts_batch.sql');
  const result = await client.query(VERIFY_013_BASELINE_AMOUNTS_BATCH_SQL, [INCREMENT_RUNNER_ROLE]);
  if (result.rowCount === 0) {
    return { installed: false, verified: false, reason: 'missing' };
  }
  return evaluate013CatalogRow(result.rows[0], expectedBody);
}

async function verify014AuditObservationPoolIndexes(client) {
  const result = await client.query(
    `SELECT indexname FROM pg_indexes
     WHERE schemaname = 'catalog'
       AND indexname IN (
         'decision_evidence_candidate_selected_item_idx',
         'decision_evidence_candidate_observation_idx'
       )`,
  );
  if (result.rowCount < 2) {
    return { installed: result.rowCount > 0, verified: false, reason: 'missing' };
  }
  return { installed: true, verified: true, reason: 'ok' };
}

export { VERIFY_013_BASELINE_AMOUNTS_BATCH_SQL, evaluate013CatalogRow, normalizeFunctionBody };

function assertIncrementObjectVerified(relativePath, checkResult, { afterApply = false, requireInstalled = false } = {}) {
  if (!checkResult.installed) {
    if (afterApply || requireInstalled) {
      throw new Error(
        `CATALOG_SQL_INCREMENT_VERIFY_FAILED:${relativePath}:object is not installed in the database`,
      );
    }
    return;
  }
  if (checkResult.verified) return;
  if (checkResult.reason === 'definition_mismatch') {
    throw new Error(
      `CATALOG_SQL_INCREMENT_DEFINITION_MISMATCH:${relativePath}:`
      + 'database function catalog.read_baseline_item_amounts_map does not match the increment SQL file; '
      + 'do not overwrite — re-apply db/catalog/013_baseline_amounts_batch.sql from owner role or restore from backup',
    );
  }
  if (checkResult.reason === 'grant_missing') {
    throw new Error(
      `CATALOG_SQL_INCREMENT_GRANT_MISMATCH:${relativePath}:`
      + `missing EXECUTE grant for ${INCREMENT_RUNNER_ROLE}; re-run GRANT from db/catalog/013_baseline_amounts_batch.sql`,
    );
  }
  throw new Error(`CATALOG_SQL_INCREMENT_VERIFY_FAILED:${relativePath}:${checkResult.reason ?? 'unknown'}`);
}

/**
 * @param {import('pg').Client} ownerClient bootstrap owner connection
 * @param {string} instanceRoot
 * @param {{ recordOnly?: Array<{ path: string, sha256: string }> }} [options]
 */
export async function syncCatalogSqlIncrements(ownerClient, instanceRoot, options = {}) {
  const manifest = readIncrementManifest(instanceRoot);
  let applied = manifest.applied;

  if (options.recordOnly?.length) {
    /* recordOnly 只能登记“数据库对象已实际安装且定义/授权核验通过”的条目；
       不能再凭 manifest 或文件存在生成成功凭证。 */
    for (const entry of options.recordOnly) {
      if (!CATALOG_SQL_INCREMENT_PATHS.includes(entry.path)) continue;
      const checkInstalled = DB_INSTALLED_CHECKS[entry.path];
      const checkResult = checkInstalled ? await checkInstalled(ownerClient) : { installed: false, verified: false, reason: 'no_check' };
      assertIncrementObjectVerified(entry.path, checkResult, { requireInstalled: true });
      const existing = applied.find((row) => row.path === entry.path);
      if (existing && existing.sha256 !== entry.sha256) {
        throw new Error(`CATALOG_SQL_INCREMENT_HASH_MISMATCH:${entry.path}:manifest=${existing.sha256}:file=${entry.sha256}`);
      }
      if (!existing) {
        applied.push({ path: entry.path, sha256: entry.sha256, appliedAt: new Date().toISOString(), source: 'record-only-verified' });
      }
    }
    writeIncrementManifest(instanceRoot, applied);
    return applied;
  }

  for (const relative of CATALOG_SQL_INCREMENT_PATHS) {
    const sha256 = sha256File(relative);
    const existing = applied.find((row) => row.path === relative);
    if (existing && existing.sha256 !== sha256) {
      throw new Error(`CATALOG_SQL_INCREMENT_HASH_MISMATCH:${relative}:manifest=${existing.sha256}:file=${sha256}`);
    }
    const checkInstalled = DB_INSTALLED_CHECKS[relative];
    if (!checkInstalled) throw new Error(`CATALOG_SQL_INCREMENT_NO_DB_CHECK:${relative}`);
    /* manifest 命中也要核数据库对象；只核文件/记录会把缺 014 的库误判为已安装。 */
    const checkResult = await checkInstalled(ownerClient);
    if (checkResult.installed) {
      assertIncrementObjectVerified(relative, checkResult);
      if (!existing) {
        applied.push({
          path: relative,
          sha256,
          appliedAt: new Date().toISOString(),
          source: 'reconciled-from-database',
        });
      }
      continue;
    }
    await ownerClient.query(fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8'));
    await ownerClient.query('RESET ROLE; RESET ALL');
    const afterApply = await checkInstalled(ownerClient);
    assertIncrementObjectVerified(relative, afterApply, { afterApply: true });
    const next = { path: relative, sha256, appliedAt: new Date().toISOString(), source: 'apply-catalog-increments' };
    if (existing) Object.assign(existing, next);
    else applied.push(next);
  }
  writeIncrementManifest(instanceRoot, applied);
  return applied;
}
