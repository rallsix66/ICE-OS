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
      'tests/p0-01/access.postgres.test.ts',
      'tests/p0-01/pool.postgres.test.ts',
      'tests/p0-01/seed-idempotency.postgres.test.ts',
    ],
    fileParallelism: false,
    alias: {
      'server-only': path.join(__dirname, 'src', 'features', 'sync', '__mocks__', 'server-only.ts'),
    },
  },
});
