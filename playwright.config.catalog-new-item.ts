import { defineConfig } from '@playwright/test';
import path from 'node:path';
const evidenceDirectory = process.env.CATALOG_TEST_EVIDENCE_DIR;
if (!evidenceDirectory || !path.isAbsolute(evidenceDirectory)) throw new Error('N1C_BROWSER_EVIDENCE_DIRECTORY_REQUIRED');
export default defineConfig({
  testDir: './tests/catalog', testMatch: '**/new-item.browser.pw.ts', workers: 1, fullyParallel: false,
  timeout: 120_000, expect: { timeout: 20_000 },
  use: { baseURL: process.env.CATALOG_BASE_URL, headless: true, trace: 'retain-on-failure', screenshot: 'only-on-failure', launchOptions: { args: [`--log-file=${path.join(evidenceDirectory, 'chromium-debug.log')}`] } },
  outputDir: process.env.CATALOG_BROWSER_OUTPUT,
  reporter: [['list'], ['json', { outputFile: process.env.CATALOG_BROWSER_REPORT }]],
});
