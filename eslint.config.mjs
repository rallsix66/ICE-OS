import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Project scripts (plain .cjs, not TypeScript):
    ".claude/scripts/**",
    // Python caches (any level)
    "**/.pytest_cache/**",
    "**/__pycache__/**",
    ".local/**",
    // P0-02 acceptance tests run via vitest.config.p0-02.mts + scripts/p0-02/*
    "tests/p0-02/**",
  ]),
]);

export default eslintConfig;
