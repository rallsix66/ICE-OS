import 'server-only';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ArtifactMetadata } from './types';

export const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export const payloadSha256 = (value: unknown) => sha256(JSON.stringify(value));

/** Only server environment selects the workspace; request input cannot select paths. */
export function catalogSourceRoot(): string {
  return path.resolve(process.env.CATALOG_SOURCE_ROOT || process.cwd());
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

/** No caller-controlled filesystem path: only the isolated run and opaque hash handle. */
export function privateEvidenceRoot(): string {
  const runId = process.env.CATALOG_RUN_ID;
  if (!runId || !/^run-\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(runId)) throw new Error('CATALOG_ISOLATED_RUN_REQUIRED');
  const runRoot = path.resolve(catalogSourceRoot(), '.local', 'catalog', runId);
  const evidenceRoot = path.join(runRoot, 'private-evidence');
  if ((process.env.CATALOG_RUN_ROOT && path.resolve(process.env.CATALOG_RUN_ROOT) !== runRoot)
    || (process.env.CATALOG_EVIDENCE_ROOT && path.resolve(process.env.CATALOG_EVIDENCE_ROOT) !== evidenceRoot)) throw new Error('CATALOG_EVIDENCE_ROOT_MISMATCH');
  return evidenceRoot;
}

async function rejectLinks(root: string, target: string): Promise<void> {
  if (!inside(root, target)) throw new Error('EVIDENCE_PATH_DENIED');
  let current = root;
  for (const segment of path.relative(root, target).split(path.sep)) {
    current = path.join(current, segment);
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('EVIDENCE_LINK_DENIED');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

export async function storePrivateArtifact(logicalName: string, bytes: Uint8Array): Promise<ArtifactMetadata> {
  const root = privateEvidenceRoot();
  const hash = sha256(bytes);
  const storageHandle = `${hash.slice(0, 2)}/${hash}`;
  const target = path.join(root, ...storageHandle.split('/'));
  await rejectLinks(catalogSourceRoot(), target);
  await fs.mkdir(path.dirname(target), { recursive: true });
  try { await fs.writeFile(target, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const stored = await fs.readFile(target);
  if (stored.byteLength !== bytes.byteLength || sha256(stored) !== hash) throw new Error('EVIDENCE_HASH_MISMATCH');
  return { logicalName, sha256: hash, size: bytes.byteLength,
    format: path.extname(logicalName).slice(1).toLowerCase(), sensitivity: 'restricted', storageHandle };
}

/** Caller must resolve artifact metadata after evidence+amount authorization. */
export async function readPrivateArtifact(artifact: Pick<ArtifactMetadata, 'sha256' | 'size' | 'storageHandle'> & Partial<ArtifactMetadata>): Promise<Buffer> {
  if (!/^[a-f0-9]{2}\/[a-f0-9]{64}$/.test(artifact.storageHandle) || artifact.storageHandle !== `${artifact.sha256.slice(0, 2)}/${artifact.sha256}`) {
    throw new Error('EVIDENCE_HANDLE_DENIED');
  }
  const root = privateEvidenceRoot();
  const target = path.join(root, ...artifact.storageHandle.split('/'));
  await rejectLinks(catalogSourceRoot(), target);
  const bytes = await fs.readFile(target);
  if (bytes.length !== artifact.size || sha256(bytes) !== artifact.sha256) throw new Error('EVIDENCE_HASH_MISMATCH');
  return bytes;
}
