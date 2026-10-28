/**
 * Local snapshot reader (v1 default).
 *
 * Reads `<CATALOG_RUN_ROOT>/source-snapshots/*.json` (or an explicit root) and
 * validates contract + profileKey + content hash before returning a snapshot.
 * This is the only reader used while the Feishu API is not configured.
 */
import 'server-only';
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SOURCE_PROFILE_KEY, type SourceSnapshot } from './contract';
import {
  ProductSourceReaderError,
  assertSnapshotShape,
  verifySnapshotKey,
  type ProductSourceReader,
  type SourceSnapshotSummary,
} from './reader';

const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const SNAPSHOT_FILE = /^[^/\\]+\.json$/;

export interface LocalSnapshotReaderOptions {
  /** Directory that directly contains `*.json` snapshot files. */
  rootDir?: string;
}

export function defaultSourceSnapshotRoot(): string | null {
  const runRoot = process.env.CATALOG_RUN_ROOT;
  if (!runRoot) return null;
  // Preferred layout: <CATALOG_RUN_ROOT>/source-snapshots/*.json.
  // Also accept snapshots written directly under CATALOG_RUN_ROOT (the build
  // scripts default to a `${runRoot}/snapshots` directory, which is passed
  // explicitly as CATALOG_RUN_ROOT by the service).
  const nested = path.join(runRoot, 'source-snapshots');
  return existsSync(nested) ? nested : runRoot;
}

interface LoadedSnapshot {
  fileName: string;
  snapshot: SourceSnapshot;
}

export function createLocalSnapshotReader(options: LocalSnapshotReaderOptions = {}): ProductSourceReader {
  const configuredRoot = options.rootDir ?? defaultSourceSnapshotRoot();

  const resolveRoot = (): string => {
    if (!configuredRoot) {
      throw new ProductSourceReaderError(
        'SOURCE_READER_ROOT_NOT_CONFIGURED',
        '未配置 CATALOG_RUN_ROOT，也没有显式指定快照目录',
      );
    }
    return configuredRoot;
  };

  const loadAll = async (): Promise<LoadedSnapshot[]> => {
    const root = resolveRoot();
    let entries: string[];
    try {
      entries = await fs.readdir(root);
    } catch {
      throw new ProductSourceReaderError('SOURCE_SNAPSHOT_DIR_MISSING', `快照目录不存在：${root}`);
    }
    const loaded: LoadedSnapshot[] = [];
    for (const name of entries.sort()) {
      if (!SNAPSHOT_FILE.test(name) || name === 'manifest.json') continue;
      const file = path.join(root, name);
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      if (stat.size > MAX_SNAPSHOT_BYTES) continue;
      const text = await fs.readFile(file, 'utf8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        continue; // Not a snapshot JSON (e.g. an unrelated evidence file) — ignore.
      }
      if (typeof parsed !== 'object' || parsed === null || (parsed as { contract?: unknown }).contract !== 'ice-product-source-snapshot-v1') {
        continue;
      }
      const snapshot = assertSnapshotShape(parsed);
      if (snapshot.profileKey !== SOURCE_PROFILE_KEY) continue;
      if (!verifySnapshotKey(snapshot)) {
        throw new ProductSourceReaderError('SOURCE_SNAPSHOT_KEY_MISMATCH', `${name} 的 snapshotKey 与内容不一致`);
      }
      loaded.push({ fileName: name, snapshot });
    }
    loaded.sort((left, right) => {
      const byCapturedAt = left.snapshot.capturedAt.localeCompare(right.snapshot.capturedAt);
      return byCapturedAt !== 0 ? byCapturedAt : left.snapshot.snapshotKey.localeCompare(right.snapshot.snapshotKey);
    });
    return loaded;
  };

  return {
    profileKey: SOURCE_PROFILE_KEY,
    describe: () => ({
      mode: 'local_snapshot',
      label: '本地模拟读取（未开通飞书 API）',
      detail: '当前读取本地保存的来源快照，不会访问飞书；模拟变化来自本地副本。',
    }),
    async listSnapshots(): Promise<SourceSnapshotSummary[]> {
      const loaded = await loadAll();
      return loaded.map(({ fileName, snapshot }) => ({
        snapshotKey: snapshot.snapshotKey,
        capturedAt: snapshot.capturedAt,
        origin: snapshot.origin,
        complete: snapshot.collection.complete,
        fileName,
      }));
    },
    async readSnapshot(snapshotKey: string): Promise<SourceSnapshot> {
      if (!/^[a-f0-9]{64}$/.test(snapshotKey)) {
        throw new ProductSourceReaderError('SOURCE_SNAPSHOT_NOT_FOUND', '快照键格式非法');
      }
      const loaded = await loadAll();
      const found = loaded.find(({ snapshot }) => snapshot.snapshotKey === snapshotKey);
      if (!found) throw new ProductSourceReaderError('SOURCE_SNAPSHOT_NOT_FOUND', `快照不存在：${snapshotKey}`);
      return found.snapshot;
    },
  };
}
