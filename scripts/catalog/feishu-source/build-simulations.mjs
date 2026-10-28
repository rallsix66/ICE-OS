#!/usr/bin/env node
/**
 * Build the two simulated snapshots from the redacted real snapshot and write a
 * human/machine readable change log.
 *
 * Outputs:
 *   <outDir>/snapshot-002-simulated.json   business changes (newest content)
 *   <outDir>/snapshot-003-simulated.json   identical content, rows+columns reordered
 *   <outDir>/simulation-changes.json       machine readable change list
 *   <outDir>/simulation-changes.md         human readable change list
 *
 * Simulated snapshots are always origin='local_simulation' with
 * simulation.baseSnapshotKey set; the real snapshot is never rewritten.
 *
 * Usage:
 *   node scripts/catalog/feishu-source/build-simulations.mjs [--snapshot <redacted snapshot>] [--out <dir>]
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTsLoader } from './ts-loader.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const DEFAULT_OUT_DIR = path.join(
  REPO_ROOT,
  '.local/catalog/fs-catalog-sim-20261025/snapshots',
);

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

function changeLogMarkdown(entries) {
  const lines = ['# 本地模拟变化清单（fallback markdown；详见 simulation-changes.json）', ''];
  for (const entry of entries) {
    lines.push(`## ${entry.file}`);
    lines.push('');
    lines.push(`- snapshotKey：\`${entry.snapshotKey}\``);
    lines.push(`- capturedAt：${entry.capturedAt}`);
    lines.push(`- origin：${entry.origin}（本地模拟变化，非飞书真实修改）`);
    lines.push(`- baseSnapshotKey：\`${entry.baseSnapshotKey}\``);
    lines.push('');
    lines.push('| # | 变化类型 | 来源行键 | 说明 |');
    lines.push('|---|---|---|---|');
    entry.changes.forEach((change, index) => {
      lines.push(`| ${index + 1} | ${change.kind} | ${change.sourceKey} | ${change.detail.replace(/\|/g, '\\|')} |`);
    });
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(args.out ?? DEFAULT_OUT_DIR);
  const snapshotPath = path.resolve(args.snapshot ?? path.join(outDir, 'fixture-snapshot-001-redacted.json'));

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-source-sim-'));
  const loader = createTsLoader({ tempDir });
  const sourceDir = path.join(REPO_ROOT, 'src/features/catalog/product-source');
  const readerModule = await loader.load(path.join(sourceDir, 'reader.ts'));
  const simulateModule = await loader.load(path.join(sourceDir, 'simulate.ts'));

  const headersModule = await loader.load(path.join(sourceDir, 'headers.ts'));
  const base = readerModule.assertSnapshotShape(JSON.parse(await fs.readFile(snapshotPath, 'utf8')));
  if (base.origin !== 'real_capture') throw new Error(`SIMULATION_BASE_NOT_REAL_CAPTURE:${base.origin}`);
  if (!readerModule.verifySnapshotKey(base)) throw new Error('SIMULATION_BASE_SNAPSHOT_KEY_MISMATCH');

  const snapshots = simulateModule.buildSimulatedSnapshots(base);
  const names = ['snapshot-002-simulated.json', 'snapshot-003-simulated.json'];
  if (snapshots.length !== names.length) throw new Error(`SIMULATION_COUNT_INVALID:${snapshots.length}`);

  await fs.mkdir(outDir, { recursive: true });
  const entries = [];
  for (let index = 0; index < snapshots.length; index += 1) {
    const snapshot = snapshots[index];
    if (snapshot.origin !== 'local_simulation') throw new Error('SIMULATION_ORIGIN_INVALID');
    if (snapshot.simulation?.baseSnapshotKey !== base.snapshotKey) throw new Error('SIMULATION_BASE_KEY_INVALID');
    if (!readerModule.verifySnapshotKey(snapshot)) throw new Error('SIMULATION_SNAPSHOT_KEY_INVALID');
    // Restricted columns are resolved by header label (letters change on column reorder).
    const restrictedColumns = Object.values(
      headersModule.resolveHeaderMapping(snapshot.collection.headers).restrictedColumns,
    );
    for (const row of snapshot.rows) {
      for (const column of restrictedColumns) {
        if ((row.cells[column] ?? '') !== '') throw new Error(`SIMULATION_RESTRICTED_VALUE_LEAK:${column}`);
      }
    }
    await fs.writeFile(path.join(outDir, names[index]), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    entries.push({
      file: names[index],
      snapshotKey: snapshot.snapshotKey,
      capturedAt: snapshot.capturedAt,
      origin: snapshot.origin,
      baseSnapshotKey: snapshot.simulation.baseSnapshotKey,
      note: snapshot.simulation.note,
      businessRowCount: snapshot.collection.businessRowCount,
      changes: snapshot.simulation.changes,
    });
  }

  const changeLog = {
    contract: 'feishu-product-source-simulations-v1',
    baseSnapshot: {
      file: path.relative(REPO_ROOT, snapshotPath).replace(/\\/g, '/'),
      snapshotKey: base.snapshotKey,
      capturedAt: base.capturedAt,
    },
    note: '所有模拟快照均为本地副本变化（本地模拟变化，非飞书真实修改），不写回真实快照。',
    simulations: entries,
  };
  await fs.writeFile(path.join(outDir, 'simulation-changes.json'), `${JSON.stringify(changeLog, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(outDir, 'simulation-changes.md'), changeLogMarkdown(entries), 'utf8');

  process.stdout.write(
    `${JSON.stringify(
      {
        outDir,
        baseSnapshot: changeLog.baseSnapshot,
        simulations: entries.map((entry) => ({
          file: entry.file,
          snapshotKey: entry.snapshotKey,
          capturedAt: entry.capturedAt,
          businessRowCount: entry.businessRowCount,
          changes: entry.changes.length,
        })),
      },
      null,
      2,
    )}\n`,
  );
  await fs.rm(tempDir, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
