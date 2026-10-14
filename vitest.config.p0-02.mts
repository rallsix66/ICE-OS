import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: 'node',
    include: [
      'tests/p0-02/config-target.test.ts',
      'tests/p0-02/effective-acl.postgres.test.ts',
      'tests/p0-02/identity-chain.postgres.test.ts',
      'tests/p0-02/sync-overview.postgres.test.ts',
      'tests/p0-02/sync-runner-authorization.postgres.test.ts',
      'tests/p0-02/golucky-import-jsonb.postgres.test.ts',
      'tests/p0-02/golucky-sync-events.postgres.test.ts',
      'tests/p0-02/sync-run-lifecycle.postgres.test.ts',
      'tests/p0-02/sync-read-visibility.postgres.test.ts',
      'tests/p0-02/auth-directory-boundary.postgres.test.ts',
      'tests/p0-02/rpc-dependency.postgres.test.ts',
      'tests/p0-02/warehouse-replenishment-numeric.postgres.test.ts',
    ],
    fileParallelism: false,
    alias: {
      'server-only': path.join(__dirname, 'src', 'features', 'sync', '__mocks__', 'server-only.ts'),
    },
  },
});
