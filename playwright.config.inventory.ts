import { defineConfig } from '@playwright/test';
import path from 'node:path';

const evidenceDirectory = process.env.INVENTORY_BROWSER_EVIDENCE_DIR;
if (!evidenceDirectory || !path.isAbsolute(evidenceDirectory)) {
  throw new Error('INVENTORY_BROWSER_EVIDENCE_DIRECTORY_REQUIRED');
}
const baseURL = process.env.INVENTORY_BASE_URL;
if (!baseURL) throw new Error('INVENTORY_BASE_URL_REQUIRED');

export default defineConfig({
  testDir: './tests/inventory-browser',
  testMatch: ['**/*.browser.pw.ts'],
  workers: 1,
  fullyParallel: false,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL,
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1440, height: 900 },
  },
  outputDir: path.join(evidenceDirectory, 'artifacts'),
  reporter: [['list'], ['json', { outputFile: path.join(evidenceDirectory, 'report.json') }]],
});
