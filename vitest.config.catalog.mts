import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: 'node',
    include: [
      'tests/catalog/baseline-and-domain.test.ts',
      'tests/catalog/catalog.postgres.test.ts',
      'tests/catalog/local-preview-seed.postgres.test.ts',
      'tests/catalog/local-preview-display.postgres.test.ts',
      'tests/catalog/local-preview-workspace.test.ts',
      'tests/catalog/local-preview-snapshot.postgres.test.ts',
      'tests/catalog/baseline-amounts-map.postgres.test.ts',
      'tests/catalog/client-scope-warehouse.postgres.test.ts',
      'tests/catalog/warehouse-valuation.test.ts',
      'tests/catalog/candidate-pool-equivalence.postgres.test.ts',
      'tests/catalog/perf-fixture-enrichment.postgres.test.ts',
      'tests/catalog/product-source-db.postgres.test.ts',
    ],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    exclude: ['archive/**'],
    alias: { 'server-only': path.join(root, 'src/test-utils/server-only-mock.ts') },
  },
});
