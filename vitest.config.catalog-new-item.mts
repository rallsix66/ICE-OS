import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
const root = path.dirname(fileURLToPath(import.meta.url));
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: 'node', include: ['tests/catalog/new-item.test.ts', 'tests/catalog/new-item.postgres.test.ts'],
    fileParallelism: false, testTimeout: 120_000, hookTimeout: 120_000,
    alias: { 'server-only': path.join(root, 'src/features/sync/__mocks__/server-only.ts') },
  },
});
