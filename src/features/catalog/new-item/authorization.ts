import 'server-only';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { requireActiveAdmin } from '@/lib/auth';
import { isIndependentPlatformRuntime } from '@/lib/database/runtime';
import type { DbIdentity } from '@/lib/database/app-db';
import { catalogSourceRoot, privateEvidenceRoot, sha256 } from '../evidence-store';
import { assertSourceIdentityFixtureRuntime } from '../source-identity/authorization';
import { PRODUCT_FIXTURE_PINS } from './fixture-adapter';

export function newItemEnabled(): boolean {
  return isIndependentPlatformRuntime() && process.env.CATALOG_NEW_ITEM_ENABLED === 'true'
    && Boolean(process.env.CATALOG_RUN_ID) && process.env.CATALOG_NEW_ITEM_FIXTURE_RUN_ID === process.env.CATALOG_RUN_ID;
}
/** Admission checks happen before a database query, including on read-only pages. */
export async function assertNewItemFixtureRuntime(): Promise<void> {
  if (!newItemEnabled()) throw new Error('NEW_ITEM_MODULE_DISABLED');
  await assertSourceIdentityFixtureRuntime();
  const instance = path.join(path.dirname(privateEvidenceRoot()), 'instance'), expected = path.join(instance, 'new-item-manifest.json');
  if (!process.env.CATALOG_NEW_ITEM_MANIFEST || path.resolve(process.env.CATALOG_NEW_ITEM_MANIFEST) !== expected) throw new Error('NEW_ITEM_FIXTURE_RUNTIME_DENIED');
  let checked = catalogSourceRoot();
  for (const part of path.relative(checked, expected).split(path.sep)) {
    checked = path.join(checked, part); if ((await fs.lstat(checked)).isSymbolicLink()) throw new Error('NEW_ITEM_FIXTURE_RUNTIME_DENIED');
  }
  const manifest = JSON.parse(await fs.readFile(expected, 'utf8')) as Record<string, unknown>;
  const markerBytes = await fs.readFile(path.join(instance, 'catalog-instance.json'));
  const marker = JSON.parse(markerBytes.toString('utf8')) as Record<string, unknown>;
  if (manifest.label !== 'catalog-new-item-fixture-v1' || manifest.fixtureMode !== 'fixture' || manifest.nonceConsumed !== true
    || typeof manifest.nonceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.nonceSha256)
    || manifest.runId !== process.env.CATALOG_RUN_ID || marker.runId !== manifest.runId || manifest.primaryMarkerSha256 !== sha256(markerBytes)
    || manifest.host !== marker.host || manifest.port !== marker.port || manifest.database !== marker.dbName
    || !['127.0.0.1', 'localhost', '::1'].includes(String(marker.host))
    || path.resolve(String(marker.dataDir)) !== path.join(instance, 'pgdata') || path.resolve(String(manifest.dataDir)) !== path.join(instance, 'pgdata')
    || manifest.baseEnvSha256 !== sha256(await fs.readFile(path.join(instance, 'env.catalog-source-identity.json')))
    || manifest.sourceIdentityManifestSha256 !== sha256(await fs.readFile(path.join(instance, 'source-identity-manifest.json')))) throw new Error('NEW_ITEM_FIXTURE_RUNTIME_DENIED');
  const pins = manifest.fixturePins as Record<string, string> | undefined;
  if (!pins || Object.keys(pins).sort().join('|') !== Object.keys(PRODUCT_FIXTURE_PINS).sort().join('|')
    || Object.entries(PRODUCT_FIXTURE_PINS).some(([key, pin]) => pins[key] !== pin)) throw new Error('NEW_ITEM_FIXTURE_RUNTIME_DENIED');
  for (const [key, required] of [['baseDdl', ['db/catalog/001_catalog.sql', 'db/catalog/002_catalog_security.sql', 'db/catalog/003_source_identity.sql', 'db/catalog/004_source_identity_security.sql']],
    ['sql', ['db/catalog/007_new_item_intake.sql', 'db/catalog/008_new_item_intake_security.sql']]] as const) {
    const entries = manifest[key];
    if (!Array.isArray(entries) || entries.length !== required.length || entries.map((entry) => entry?.path).sort().join('|') !== [...required].sort().join('|')) throw new Error('NEW_ITEM_FIXTURE_RUNTIME_DENIED');
    for (const entry of entries as { path: string; sha256: string }[]) {
      if (sha256(await fs.readFile(path.join(catalogSourceRoot(), entry.path))) !== entry.sha256) throw new Error('NEW_ITEM_FIXTURE_RUNTIME_DENIED');
    }
  }
}
export async function requireNewItemActor(): Promise<DbIdentity> {
  await assertNewItemFixtureRuntime();
  const actor = await requireActiveAdmin(); return { profileUserId: actor.id };
}
