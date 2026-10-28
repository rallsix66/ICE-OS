import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));

/**
 * Inventory-sync-v1 focused test config.
 * - `tests/inventory/*.test.ts` : pure logic (web model, formatting, status mapping).
 * - `tests/inventory/*.postgres.test.ts` : real isolated PostgreSQL transaction/recovery tests;
 *   they locate the instance through INVENTORY_INSTANCE_DIR (or INVENTORY_* urls) and skip
 *   themselves when that is missing, so the pure suite can run anywhere.
 */
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: 'node',
    include: ['tests/inventory/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 180_000,
    exclude: ['archive/**'],
    alias: { 'server-only': path.join(root, 'src/test-utils/server-only-mock.ts') },
  },
});
