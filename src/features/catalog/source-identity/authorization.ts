import 'server-only';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { requireActiveAdmin } from '@/lib/auth';
import { isIndependentPlatformRuntime } from '@/lib/database/runtime';
import type { DbIdentity } from '@/lib/database/app-db';
import { catalogSourceRoot, privateEvidenceRoot, sha256 } from '../evidence-store';
import { SOURCE_FIXTURE_PINS } from './fixture-adapter';

export function sourceIdentityEnabled(): boolean {
  return isIndependentPlatformRuntime() && process.env.CATALOG_SOURCE_IDENTITY_ENABLED === 'true'
    && Boolean(process.env.CATALOG_RUN_ID) && process.env.CATALOG_SOURCE_IDENTITY_FIXTURE_RUN_ID === process.env.CATALOG_RUN_ID;
}

/** Checks the separate fixture installation before touching any N1 table. */
export async function assertSourceIdentityFixtureRuntime(): Promise<void> {
  if (!sourceIdentityEnabled()) throw new Error('IDENTITY_MODULE_DISABLED');
  const runRoot = path.dirname(privateEvidenceRoot()), instanceRoot = path.join(runRoot, 'instance');
  const expectedManifest = path.join(instanceRoot, 'source-identity-manifest.json');
  if (!process.env.CATALOG_SOURCE_IDENTITY_MANIFEST || path.resolve(process.env.CATALOG_SOURCE_IDENTITY_MANIFEST) !== expectedManifest) throw new Error('IDENTITY_FIXTURE_RUNTIME_DENIED');
  let current = catalogSourceRoot();
  for (const part of path.relative(current, expectedManifest).split(path.sep)) {
    current = path.join(current, part); if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('IDENTITY_FIXTURE_RUNTIME_DENIED');
  }
  const manifest = JSON.parse(await fs.readFile(expectedManifest, 'utf8')) as Record<string, unknown>;
  const markerBytes = await fs.readFile(path.join(instanceRoot, 'catalog-instance.json'));
  const marker = JSON.parse(markerBytes.toString('utf8')) as Record<string, unknown>;
  if (manifest.label !== 'catalog-source-identity-fixture-v1' || manifest.fixtureMode !== 'fixture' || manifest.nonceConsumed !== true
    || typeof manifest.nonceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.nonceSha256)
    || manifest.runId !== process.env.CATALOG_RUN_ID || marker.runId !== manifest.runId || manifest.primaryMarkerSha256 !== sha256(markerBytes)
    || manifest.host !== marker.host || manifest.port !== marker.port || manifest.database !== marker.dbName
    || path.resolve(String(manifest.dataDir)) !== path.join(instanceRoot, 'pgdata') || path.resolve(String(marker.dataDir)) !== path.join(instanceRoot, 'pgdata')
    || !['127.0.0.1', 'localhost', '::1'].includes(String(marker.host))) throw new Error('IDENTITY_FIXTURE_RUNTIME_DENIED');
  if (manifest.baseEnvSha256 !== sha256(await fs.readFile(path.join(instanceRoot, 'env.catalog.json')))) throw new Error('IDENTITY_FIXTURE_RUNTIME_DENIED');
  const fixturePins = manifest.fixturePins as Record<string, string> | undefined;
  if (!fixturePins || Object.entries(SOURCE_FIXTURE_PINS).some(([key, value]) => fixturePins[key] !== value)) throw new Error('IDENTITY_FIXTURE_RUNTIME_DENIED');
  for (const name of ['baseDdl', 'sql']) {
    const entries = manifest[name];
    const expected = name === 'baseDdl' ? ['db/catalog/001_catalog.sql', 'db/catalog/002_catalog_security.sql']
      : ['db/catalog/003_source_identity.sql', 'db/catalog/004_source_identity_security.sql'];
    if (!Array.isArray(entries) || entries.length !== 2 || canonicalPaths(entries) !== expected.sort().join('|')) throw new Error('IDENTITY_FIXTURE_RUNTIME_DENIED');
    for (const entry of entries as { path: string; sha256: string }[]) {
      if (!/^db\/(?:p0-02|catalog)\/[a-zA-Z0-9_.-]+\.sql$/.test(entry.path)) throw new Error('IDENTITY_FIXTURE_RUNTIME_DENIED');
      if (sha256(await fs.readFile(path.join(catalogSourceRoot(), entry.path))) !== entry.sha256) throw new Error('IDENTITY_FIXTURE_RUNTIME_DENIED');
    }
  }
}

function canonicalPaths(entries: unknown[]): string {
  return entries.map((entry) => entry && typeof entry === 'object' && 'path' in entry ? String(entry.path) : '').sort().join('|');
}

export async function requireSourceIdentityActor(): Promise<DbIdentity> {
  await assertSourceIdentityFixtureRuntime();
  const actor = await requireActiveAdmin();
  return { profileUserId: actor.id };
}
