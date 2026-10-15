import fs from 'node:fs';
import path from 'node:path';

import { REPO_ROOT } from './common.mjs';

const configPath = path.join(REPO_ROOT, 'vitest.config.p0-02.mts');
const configText = fs.readFileSync(configPath, 'utf8');
const includeMatch = configText.match(/include:\s*\[([\s\S]*?)\]/);
if (!includeMatch) {
  console.error('无法解析 vitest.config.p0-02.mts include 列表');
  process.exit(1);
}

const included = [...includeMatch[1].matchAll(/'([^']+\.test\.ts)'/g)].map((m) => m[1]);
const required = [
  'tests/p0-02/sync-node-real-write-chain.postgres.test.ts',
  'tests/p0-02/sync-node-real-write-chain-cleanup.postgres.test.ts',
  'tests/p0-02/sync-publish-unknown.postgres.test.ts',
  'tests/p0-02/sync-expiry-authorization.postgres.test.ts',
  'tests/p0-02/sync-expiry-lock-concurrency.postgres.test.ts',
  'tests/p0-02/delivery-rework.postgres.test.ts',
];

for (const file of required) {
  if (!included.includes(file)) {
    console.error(`vitest include 遗漏必需文件: ${file}`);
    process.exit(1);
  }
  const abs = path.join(REPO_ROOT, file);
  if (!fs.existsSync(abs)) {
    console.error(`必需测试文件不存在: ${file}`);
    process.exit(1);
  }
  const text = fs.readFileSync(abs, 'utf8');
  const testCount = (text.match(/\bit\s*\(/g) ?? []).length;
  if (testCount < 1) {
    console.error(`必需测试文件零用例: ${file}`);
    process.exit(1);
  }
}

console.log(
  JSON.stringify({
    ok: true,
    includedCount: included.length,
    required,
  }),
);
