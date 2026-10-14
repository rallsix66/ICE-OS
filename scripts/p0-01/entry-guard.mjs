import path from 'node:path';

import { REPO_ROOT, runRoot } from './common.mjs';
import { assertRunId } from './instance-guard.mjs';

export function assertSafeRunRoot(runId) {
  assertRunId(runId);
  const p0Root = path.resolve(REPO_ROOT, '.local', 'p0-01');
  const root = path.resolve(runRoot(runId));
  if (path.basename(root) !== runId) {
    throw new Error(`run 根目录末段与 runId 不一致: ${path.basename(root)} !== ${runId}`);
  }
  if (root !== p0Root && !root.startsWith(`${p0Root}${path.sep}`)) {
    throw new Error(`run 根目录越界: ${root}`);
  }
}

export function guardP001Entry(runId) {
  assertSafeRunRoot(runId);
}
