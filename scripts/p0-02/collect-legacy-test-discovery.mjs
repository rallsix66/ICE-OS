import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { REPO_ROOT } from './common.mjs';

const suites = [
  { name: 'concurrency', targets: ['src/features/sync/concurrency.test.ts'] },
  {
    name: 'database-contract',
    targets: [
      'src/features/database/migrations-00001-00050-replay.postgres.test.ts',
      'src/features/database/migrations-00041-00047.postgres.test.ts',
      'src/features/database/opt5-least-privilege.postgres.test.ts',
      'src/features/database/opt6-auth-rls-initplan.postgres.test.ts',
      'src/features/database/opt6-role-policy-overlap.postgres.test.ts',
      'src/features/database/opt6-product-policy-overlap.postgres.test.ts',
      'src/features/database/opt6-00052-production-apply.postgres.test.ts',
    ],
  },
  { name: 'best-live', targets: ['src/lib/providers/best/__tests__/dry-run.live.test.ts'] },
];

const vitestBin = path.join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const results = [];

for (const suite of suites) {
  const proc = spawnSync(process.execPath, [vitestBin, 'list', '--filesOnly', ...suite.targets], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, P0_02_ENABLED: 'false' },
  });
  const files = (proc.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.test.ts'));
  results.push({ name: suite.name, exit: proc.status, fileCount: files.length, files });
}

console.log(JSON.stringify({ results, mode: 'vitest-list-filesOnly' }, null, 2));
const failed = results.filter((r) => r.fileCount === 0 || r.exit !== 0);
process.exit(failed.length > 0 ? 1 : 0);
