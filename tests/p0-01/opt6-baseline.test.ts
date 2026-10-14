import { describe, expect, it } from 'vitest';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  KNOWN_FAILING_TEST,
  isKnownOpt6BaselineFailure,
  isOpt6UnexpectedFailure,
  loadApprovedOpt6Baseline,
  verifyOpt6ApprovedFileFingerprints,
} from '../../scripts/p0-01/opt6-baseline.mjs';

describe('opt6 baseline detector', () => {
  it('识别 canonical 单失败基线', () => {
    const record = {
      status: 1,
      stdout: `× ${KNOWN_FAILING_TEST} 3ms\nAssertionError: Target cannot be null or undefined.\nopt6-production-apply.test.ts:43:9\n Tests 1 failed | 5 passed (6)`,
      stderr: '',
    };
    expect(isKnownOpt6BaselineFailure(record)).toBe(true);
    expect(isOpt6UnexpectedFailure(record)).toBe(false);
  });

  it('同名用例 TypeError 判异常', () => {
    const record = {
      status: 1,
      stdout: `× ${KNOWN_FAILING_TEST} 3ms\nTypeError: Cannot read properties of undefined\n Tests 1 failed | 5 passed (6)`,
      stderr: '',
    };
    expect(isKnownOpt6BaselineFailure(record)).toBe(false);
  });

  it('同名用例不同 AssertionError 判异常', () => {
    const record = {
      status: 1,
      stdout: `× ${KNOWN_FAILING_TEST} 3ms\nAssertionError: expected 1 to be 2\nopt6-production-apply.test.ts:43:9\n Tests 1 failed | 5 passed (6)`,
      stderr: '',
    };
    expect(isKnownOpt6BaselineFailure(record)).toBe(false);
  });

  it('同一 canonical 用例出现多处断言失败时判异常', () => {
    const record = {
      status: 1,
      stdout: `× ${KNOWN_FAILING_TEST} 3ms\nAssertionError: first\nAssertionError: second\n Tests 1 failed | 5 passed (6)`,
      stderr: '',
    };
    expect(isKnownOpt6BaselineFailure(record)).toBe(false);
    expect(isOpt6UnexpectedFailure(record)).toBe(true);
  });

  it('canonical 基线后追加 Unhandled Rejection 仍判异常', () => {
    const record = {
      status: 1,
      stdout: `× ${KNOWN_FAILING_TEST} 3ms\nAssertionError: Target cannot be null or undefined.\nopt6-production-apply.test.ts:43:9\nUnhandled Rejection\nRangeError: boom\n Tests 1 failed | 5 passed (6)\nErrors 1 error`,
      stderr: '',
    };
    expect(isKnownOpt6BaselineFailure(record)).toBe(false);
  });

  it('批准文件指纹与仓库一致', () => {
    expect(verifyOpt6ApprovedFileFingerprints().ok).toBe(true);
  });

  it('仅保留 CREATE POLICY 的篡改 migration 指纹不匹配', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opt6-fp-'));
    const baseline = loadApprovedOpt6Baseline();
    for (const file of baseline.files) {
      const dest = path.join(tmpRoot, file.rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(process.cwd(), file.rel), dest);
    }
    fs.writeFileSync(
      path.join(tmpRoot, 'supabase/migrations/00051_optimize_role_rls_policy_overlap.sql'),
      'CREATE POLICY unrelated_broken_sql;\r\n',
    );
    const result = verifyOpt6ApprovedFileFingerprints({ repoRoot: tmpRoot });
    expect(result.ok).toBe(false);
    expect(isKnownOpt6BaselineFailure({
      status: 1,
      stdout: `× ${KNOWN_FAILING_TEST} 3ms\nAssertionError: Target cannot be null or undefined.\nopt6-production-apply.test.ts:43:9\n Tests 1 failed | 5 passed (6)`,
      stderr: '',
    }, { repoRoot: tmpRoot })).toBe(false);
  });

  it('canonical 通过、另一用例失败时判异常', () => {
    const record = {
      status: 1,
      stdout: `× keeps one transaction and locks history before the embedded migration body 2ms\n Tests 1 failed | 5 passed (6)`,
      stderr: '',
    };
    expect(isKnownOpt6BaselineFailure(record)).toBe(false);
    expect(isOpt6UnexpectedFailure(record)).toBe(true);
  });
});
