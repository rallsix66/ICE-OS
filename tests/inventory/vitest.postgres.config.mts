import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Standalone PG acceptance config for this increment (the shared inventory config is owned by
// the package Lead). Root stays at the repository root so `tests/inventory` include paths and
// node_modules resolution behave exactly like the other postgres test configs.
export default defineConfig({
  test: {
    root: path.resolve(import.meta.dirname, '../..'),
    environment: 'node',
    include: ['tests/inventory/**/*.postgres.test.ts'],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 180_000,
    exclude: ['archive/**', 'node_modules/**'],
  },
});
