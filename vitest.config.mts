import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: 'node',
    include: [
      'src/**/*.test.ts',
      'tests/catalog/**/*.postgres.test.ts',
      'tests/catalog/product-source.test.ts',
      'tests/catalog/product-source-recovery.test.ts',
      'tests/catalog/product-source-panel-recovery.test.ts',
      'tests/p0-01/**/*.test.ts',
      'supabase/migrations/00013_extend_user_variant_preference_favorited.test.ts',
      'supabase/migrations/00014_dynamic_alert_fields.test.ts',
    ],
    exclude: ['tests/p0-02/**', 'archive/**'],
    alias: {
      'server-only': path.join(__dirname, 'src', 'test-utils', 'server-only-mock.ts'),
    },
  },
})
