/**
 * Spawn-boundary tests for scripts/catalog/run-candidate-equivalence-readonly.mjs.
 *
 * Every scenario spawns the REAL runner, which spawns a REAL child process
 * (`process.execPath tests/catalog/fixtures/run-candidate-equivalence-stub-child.mjs`
 * via CATALOG_EQUIVALENCE_CHILD_SCRIPT). The child writes
 * attempts/<id>/candidate-equivalence.json itself and only then exits, so the
 * runner's post-spawn behaviour is exercised exactly as in production.
 *
 * All attempts roots / latest pointers live in an isolated OS temp sandbox
 * (CATALOG_EQUIVALENCE_ATTEMPTS_ROOT / CATALOG_EQUIVALENCE_LATEST_PATH); the real
 * .local/catalog/ux-perf-u3-20261022 attempts and latest pointer are never written.
 *
 * Run: node tests/catalog/run-candidate-equivalence-runner.test.mjs
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runnerPath = path.join(repo, 'scripts/catalog/run-candidate-equivalence-readonly.mjs');
const stubPath = path.join(repo, 'tests/catalog/fixtures/run-candidate-equivalence-stub-child.mjs');
const RUN_ID = 'run-20261021T100700Z-b3c4d5e6';
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-equivalence-runner-test-'));

const PROD_ATTEMPTS_ROOT = path.join(repo, '.local/catalog/ux-perf-u3-20261022/attempts');
const PROD_LATEST = path.join(repo, '.local/catalog/ux-perf-u3-20261022/candidate-equivalence-latest.json');

const INHERITED_OVERRIDES = [
  'CATALOG_EQUIVALENCE_ATTEMPT_ID',
  'CATALOG_EQUIVALENCE_ATTEMPT_DIR',
  'CATALOG_EQUIVALENCE_ATTEMPTS_ROOT',
  'CATALOG_EQUIVALENCE_LATEST_PATH',
  'CATALOG_EQUIVALENCE_CHILD_SCRIPT',
  'CATALOG_EQUIVALENCE_RUN_ID',
  'CATALOG_EQUIVALENCE_RUNNER_MANAGED',
  'CATALOG_EQUIVALENCE_PROBE_FAIL',
  'CATALOG_EQUIVALENCE_SPAWN_STUB',
  'CATALOG_EQUIVALENCE_TEST_REPORT',
  'CATALOG_EQUIVALENCE_STUB_EXIT',
  'CATALOG_EQUIVALENCE_STUB_WRITE_REPORT',
  'CATALOG_EQUIVALENCE_STUB_REPORT_OVERRIDES',
];
const baseEnv = { ...process.env };
for (const key of INHERITED_OVERRIDES) delete baseEnv[key];
baseEnv.CATALOG_RUN_ID = RUN_ID;

const runnerSource = fs.readFileSync(runnerPath, 'utf8');
const prodLatestBefore = fs.existsSync(PROD_LATEST) ? fs.readFileSync(PROD_LATEST, 'utf8') : null;
const prodAttemptsBefore = new Set(
  fs.existsSync(PROD_ATTEMPTS_ROOT) ? fs.readdirSync(PROD_ATTEMPTS_ROOT) : [],
);

const passed = [];
const usedAttemptIds = new Set();
let caseIndex = 0;

function pass(name) {
  passed.push(name);
  console.log(`ok ${passed.length} - ${name}`);
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function newCase(label) {
  caseIndex += 1;
  const root = path.join(SANDBOX, `${String(caseIndex).padStart(2, '0')}-${label}`);
  fs.mkdirSync(root, { recursive: true });
  return {
    root,
    attemptsRoot: path.join(root, 'attempts'),
    latestPath: path.join(root, 'candidate-equivalence-latest.json'),
  };
}

function attemptPaths(target, attemptId) {
  usedAttemptIds.add(attemptId);
  const dir = path.join(target.attemptsRoot, attemptId);
  return {
    dir,
    report: path.join(dir, 'candidate-equivalence.json'),
    lifecycle: path.join(dir, 'runner-lifecycle.json'),
    verdict: path.join(dir, 'runner-verdict.json'),
    lock: path.join(dir, '.attempt-lock'),
  };
}

function runRunner(target, env) {
  const result = spawnSync(process.execPath, [runnerPath], {
    cwd: repo,
    env: {
      ...baseEnv,
      CATALOG_EQUIVALENCE_ATTEMPTS_ROOT: target.attemptsRoot,
      CATALOG_EQUIVALENCE_LATEST_PATH: target.latestPath,
      CATALOG_EQUIVALENCE_CHILD_SCRIPT: stubPath,
      ...env,
    },
    encoding: 'utf8',
    timeout: 120_000,
  });
  assert.equal(result.error, undefined, `failed to spawn runner: ${result.error?.message ?? ''}`);
  return result;
}

function stubReportHash(result) {
  const match = /^stub-child:sha256=([0-9a-f]{64})$/m.exec(result.stdout ?? '');
  assert.ok(
    match,
    `stub child must announce the sha256 of the bytes it wrote; stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`,
  );
  return match[1];
}

function assertLatest(target, expected) {
  const latest = readJson(target.latestPath);
  assert.equal(latest.attemptId, expected.attemptId, 'latest.attemptId');
  assert.equal(latest.runId, RUN_ID, 'latest.runId');
  assert.equal(latest.exitCode, expected.exitCode, 'latest.exitCode');
  assert.equal(latest.complete, expected.complete, 'latest.complete');
  assert.equal(latest.status, expected.status, 'latest.status');
  assert.equal(latest.phase, expected.phase, 'latest.phase');
  return latest;
}

function assertLifecycle(paths, attemptId, expectedPhases) {
  const lifecycle = readJson(paths.lifecycle);
  assert.equal(lifecycle.attemptId, attemptId);
  assert.equal(lifecycle.runId, RUN_ID);
  assert.ok(Array.isArray(lifecycle.phases) && lifecycle.phases.length > 0, 'lifecycle must carry phase entries');
  for (const phase of lifecycle.phases) {
    assert.equal(phase.attemptId, attemptId, 'every lifecycle entry carries attemptId');
    assert.equal(phase.runId, RUN_ID, 'every lifecycle entry carries runId');
    assert.equal(typeof phase.phase, 'string');
    assert.equal(typeof phase.status, 'string');
  }
  const names = lifecycle.phases.map((phase) => phase.phase);
  for (const expected of expectedPhases) {
    assert.ok(names.includes(expected), `lifecycle must include phase ${expected}; got ${names.join(',')}`);
  }
  return names;
}

function assertChildReport(reportBytes, hash, expected) {
  assert.equal(sha256(reportBytes), hash, 'child report must be byte-identical to what the child wrote');
  const report = JSON.parse(reportBytes);
  assert.equal(report.attemptId, expected.attemptId, 'report.attemptId');
  assert.equal(report.runId, expected.runId, 'report.runId');
  assert.equal(report.itemCount, expected.itemCount, 'report.itemCount');
  assert.equal(report.sourceGroupsChecked, expected.sourceGroupsChecked, 'report.sourceGroupsChecked');
  assert.equal(report.differenceGroups, expected.differenceGroups, 'report.differenceGroups');
  assert.equal(report.readOnly, expected.readOnly, 'report.readOnly');
  assert.equal(report.complete, expected.complete, 'report.complete');
  return report;
}

let failed = false;
try {
  // Scenario 1: genuine complete child report + exit 0.
  {
    const name = 'real child writes complete 126/252/0 report and exits 0 => runner exit 0, latest published, child report byte-identical';
    const target = newCase('success-real-child');
    const attemptId = 'scenario-real-child-success';
    const paths = attemptPaths(target, attemptId);

    const result = runRunner(target, {
      CATALOG_EQUIVALENCE_ATTEMPT_ID: attemptId,
      CATALOG_EQUIVALENCE_STUB_EXIT: '0',
    });
    assert.equal(result.status, 0, `runner must exit 0; stderr=${result.stderr}`);
    const reportBytes = fs.readFileSync(paths.report, 'utf8');
    assertChildReport(reportBytes, stubReportHash(result), {
      attemptId,
      runId: RUN_ID,
      itemCount: 126,
      sourceGroupsChecked: 252,
      differenceGroups: 0,
      readOnly: true,
      complete: true,
    });

    const verdict = readJson(paths.verdict);
    assert.equal(verdict.ok, true, 'verdict.ok');
    assert.equal(verdict.complete, true, 'verdict.complete');
    assert.equal(verdict.status, 'complete', 'verdict.status');
    assert.equal(verdict.exitCode, 0, 'verdict.exitCode');
    assert.equal(verdict.childExitCode, 0, 'verdict.childExitCode');
    assert.equal(verdict.childReportPresent, true, 'verdict.childReportPresent');
    assert.equal(verdict.rejection, null, 'verdict.rejection');

    assertLatest(target, { attemptId, exitCode: 0, complete: true, status: 'complete', phase: 'runner-published' });
    assertLifecycle(paths, attemptId, ['acquired', 'spawn-child', 'child-exited', 'child-report-read', 'validated', 'published']);
    pass(name);
  }

  // Scenario 2: non-zero child exit with a complete-looking report.
  {
    const name = 'child exits non-zero with a complete-looking report => runner non-zero, child report preserved, verdict says child-nonzero';
    const target = newCase('child-nonzero-with-report');
    const attemptId = 'scenario-child-nonzero-report';
    const paths = attemptPaths(target, attemptId);

    const result = runRunner(target, {
      CATALOG_EQUIVALENCE_ATTEMPT_ID: attemptId,
      CATALOG_EQUIVALENCE_STUB_EXIT: '3',
    });
    assert.equal(result.status, 3, `runner must propagate the child failure; stderr=${result.stderr}`);
    const reportBytes = fs.readFileSync(paths.report, 'utf8');
    assertChildReport(reportBytes, stubReportHash(result), {
      attemptId,
      runId: RUN_ID,
      itemCount: 126,
      sourceGroupsChecked: 252,
      differenceGroups: 0,
      readOnly: true,
      complete: true,
    });

    const verdict = readJson(paths.verdict);
    assert.equal(verdict.ok, false, 'verdict.ok');
    assert.equal(verdict.complete, false, 'verdict.complete');
    assert.equal(verdict.status, 'failed', 'verdict.status');
    assert.equal(verdict.exitCode, 3, 'verdict.exitCode');
    assert.equal(verdict.childExitCode, 3, 'verdict.childExitCode');
    assert.equal(verdict.childReportPresent, true, 'verdict.childReportPresent');
    assert.equal(verdict.rejection, 'child-nonzero', 'verdict.rejection');
    assert.ok(verdict.failures.includes('child-nonzero'), 'verdict.failures must include child-nonzero');

    assertLatest(target, { attemptId, exitCode: 3, complete: false, status: 'failed', phase: 'runner-rejected' });
    assertLifecycle(paths, attemptId, ['child-exited', 'rejected']);
    pass(name);
  }

  // Scenario 3: non-zero child exit without a report.
  {
    const name = 'child exits non-zero without report => runner non-zero, no report fabricated';
    const target = newCase('child-nonzero-no-report');
    const attemptId = 'scenario-child-nonzero-no-report';
    const paths = attemptPaths(target, attemptId);

    const result = runRunner(target, {
      CATALOG_EQUIVALENCE_ATTEMPT_ID: attemptId,
      CATALOG_EQUIVALENCE_STUB_EXIT: '4',
      CATALOG_EQUIVALENCE_STUB_WRITE_REPORT: '0',
    });
    assert.equal(result.status, 4, `runner must propagate the child failure; stderr=${result.stderr}`);
    assert.equal(fs.existsSync(paths.report), false, 'runner must not fabricate a candidate-equivalence.json');

    const verdict = readJson(paths.verdict);
    assert.equal(verdict.ok, false, 'verdict.ok');
    assert.equal(verdict.complete, false, 'verdict.complete');
    assert.equal(verdict.status, 'failed', 'verdict.status');
    assert.equal(verdict.exitCode, 4, 'verdict.exitCode');
    assert.equal(verdict.childExitCode, 4, 'verdict.childExitCode');
    assert.equal(verdict.childReportPresent, false, 'verdict.childReportPresent');
    assert.equal(verdict.rejection, 'child-nonzero', 'verdict.rejection');
    assert.ok(verdict.failures.includes('child-report-missing'), 'verdict.failures must include child-report-missing');

    assertLatest(target, { attemptId, exitCode: 4, complete: false, status: 'failed', phase: 'runner-rejected' });
    assertLifecycle(paths, attemptId, ['child-exited', 'child-report-missing', 'rejected']);
    pass(name);
  }

  // Scenario 4: zero child exit without a report (retired TEST_REPORT injection must not fabricate success).
  {
    const name = 'child exits 0 without report => runner exit 2 and CATALOG_EQUIVALENCE_TEST_REPORT injection is inert';
    const target = newCase('child-zero-no-report');
    const attemptId = 'scenario-child-zero-no-report';
    const paths = attemptPaths(target, attemptId);
    const injectedReport = `${JSON.stringify({
      attemptId,
      runId: RUN_ID,
      readOnly: true,
      serial: true,
      itemCount: 126,
      sourceGroupsChecked: 252,
      differenceGroups: 0,
      complete: true,
    }, null, 2)}\n`;

    const result = runRunner(target, {
      CATALOG_EQUIVALENCE_ATTEMPT_ID: attemptId,
      CATALOG_EQUIVALENCE_STUB_EXIT: '0',
      CATALOG_EQUIVALENCE_STUB_WRITE_REPORT: '0',
      CATALOG_EQUIVALENCE_TEST_REPORT: injectedReport,
    });
    assert.equal(result.status, 2, `runner must exit 2 when a zero-exit child left no report; stderr=${result.stderr}`);
    assert.equal(fs.existsSync(paths.report), false, 'neither the runner nor the retired TEST_REPORT bypass may synthesize a report');
    assert.ok(
      !runnerSource.includes('CATALOG_EQUIVALENCE_TEST_REPORT'),
      'runner source must not contain the retired CATALOG_EQUIVALENCE_TEST_REPORT bypass',
    );

    const verdict = readJson(paths.verdict);
    assert.equal(verdict.ok, false, 'verdict.ok');
    assert.equal(verdict.complete, false, 'verdict.complete');
    assert.equal(verdict.status, 'failed', 'verdict.status');
    assert.equal(verdict.exitCode, 2, 'verdict.exitCode');
    assert.equal(verdict.childExitCode, 0, 'verdict.childExitCode');
    assert.equal(verdict.childReportPresent, false, 'verdict.childReportPresent');
    assert.equal(verdict.rejection, 'child-report-missing', 'verdict.rejection');

    assertLatest(target, { attemptId, exitCode: 2, complete: false, status: 'failed', phase: 'runner-rejected' });
    assertLifecycle(paths, attemptId, ['child-exited', 'child-report-missing', 'rejected']);
    pass(name);
  }

  // Scenario 5: identity mismatch (attemptId and runId).
  {
    const name = 'report attemptId/runId mismatch is rejected and the child report is preserved';
    const target = newCase('identity-mismatch');

    const attemptId = 'scenario-mismatch-attempt';
    const paths = attemptPaths(target, attemptId);
    const attemptResult = runRunner(target, {
      CATALOG_EQUIVALENCE_ATTEMPT_ID: attemptId,
      CATALOG_EQUIVALENCE_STUB_EXIT: '0',
      CATALOG_EQUIVALENCE_STUB_REPORT_OVERRIDES: JSON.stringify({ attemptId: 'some-other-attempt' }),
    });
    assert.equal(attemptResult.status, 2, `attemptId mismatch must exit 2; stderr=${attemptResult.stderr}`);
    const attemptReportBytes = fs.readFileSync(paths.report, 'utf8');
    assert.equal(sha256(attemptReportBytes), stubReportHash(attemptResult), 'mismatched report must be preserved byte-for-byte');
    assert.equal(JSON.parse(attemptReportBytes).attemptId, 'some-other-attempt');
    const attemptVerdict = readJson(paths.verdict);
    assert.equal(attemptVerdict.status, 'failed', 'verdict.status');
    assert.equal(attemptVerdict.exitCode, 2, 'verdict.exitCode');
    assert.equal(attemptVerdict.rejection, 'attemptId-mismatch', 'verdict.rejection');
    assert.ok(attemptVerdict.failures.includes('attemptId-mismatch'), 'verdict.failures');
    assert.equal(attemptVerdict.childReportPresent, true, 'verdict.childReportPresent');
    assertLatest(target, { attemptId, exitCode: 2, complete: false, status: 'failed', phase: 'runner-rejected' });

    const runAttemptId = 'scenario-mismatch-run';
    const runPaths = attemptPaths(target, runAttemptId);
    const runResult = runRunner(target, {
      CATALOG_EQUIVALENCE_ATTEMPT_ID: runAttemptId,
      CATALOG_EQUIVALENCE_STUB_EXIT: '0',
      CATALOG_EQUIVALENCE_STUB_REPORT_OVERRIDES: JSON.stringify({ runId: 'run-00000000T000000Z-deadbeef' }),
    });
    assert.equal(runResult.status, 2, `runId mismatch must exit 2; stderr=${runResult.stderr}`);
    const runReportBytes = fs.readFileSync(runPaths.report, 'utf8');
    assert.equal(sha256(runReportBytes), stubReportHash(runResult), 'mismatched report must be preserved byte-for-byte');
    const runVerdict = readJson(runPaths.verdict);
    assert.equal(runVerdict.status, 'failed', 'verdict.status');
    assert.equal(runVerdict.exitCode, 2, 'verdict.exitCode');
    assert.equal(runVerdict.rejection, 'runId-mismatch', 'verdict.rejection');
    assert.ok(runVerdict.failures.includes('runId-mismatch'), 'verdict.failures');
    assertLatest(target, { attemptId: runAttemptId, exitCode: 2, complete: false, status: 'failed', phase: 'runner-rejected' });
    pass(name);
  }

  // Scenario 6: an already-complete attempt is refused and never modified.
  {
    const name = 'pre-existing complete attempt is refused and its bytes stay unchanged';
    const target = newCase('existing-complete-refused');
    const attemptId = 'scenario-existing-complete';
    const paths = attemptPaths(target, attemptId);
    const existingBytes = `${JSON.stringify({
      attemptId,
      runId: RUN_ID,
      at: '2026-10-22T00:00:00.000Z',
      readOnly: true,
      itemCount: 126,
      sourceGroupsChecked: 252,
      completed: 126,
      differenceGroups: 0,
      complete: true,
    }, null, 2)}\n`;
    fs.mkdirSync(paths.dir, { recursive: true });
    fs.writeFileSync(paths.report, existingBytes);

    const result = runRunner(target, {
      CATALOG_EQUIVALENCE_ATTEMPT_ID: attemptId,
      CATALOG_EQUIVALENCE_STUB_EXIT: '0',
    });
    assert.equal(result.status, 2, `reusing a complete attempt must exit 2; stderr=${result.stderr}`);
    assert.equal(fs.readFileSync(paths.report, 'utf8'), existingBytes, 'complete report must stay byte-identical');
    assert.equal(fs.existsSync(paths.lock), false, 'refused attempt must not claim the lock');
    assert.equal(fs.existsSync(paths.lifecycle), false, 'refused attempt must not start a runner lifecycle');
    assert.equal(fs.existsSync(paths.verdict), false, 'refused attempt must not get a runner verdict');
    assert.equal(fs.existsSync(target.latestPath), false, 'refused attempt must not publish the latest pointer');
    assert.ok(!(result.stdout ?? '').includes('stub-child:'), 'child must not be spawned for a refused attempt');
    pass(name);
  }

  // Scenario 7: attemptId sanitisation rejects traversal before any spawn.
  {
    const name = 'attemptId sanitisation rejects path traversal before spawning a child';
    const target = newCase('attempt-id-sanitisation');
    const result = runRunner(target, {
      CATALOG_EQUIVALENCE_ATTEMPT_ID: '../escape-attempt',
      CATALOG_EQUIVALENCE_STUB_EXIT: '0',
    });
    assert.equal(result.status, 2, `invalid attemptId must exit 2; stderr=${result.stderr}`);
    assert.equal(fs.existsSync(target.attemptsRoot), false, 'invalid attemptId must not create the attempts root');
    assert.equal(fs.existsSync(path.join(target.root, 'escape-attempt')), false, 'invalid attemptId must not escape the attempts root');
    assert.ok(!(result.stdout ?? '').includes('stub-child:'), 'child must not be spawned for an invalid attemptId');
    pass(name);
  }

  // Scenario 8-10: declared counts / read-only evidence must be backed by the child session report.
  {
    const name = 'completed=4 is rejected even when itemCount=126 and sourceGroupsChecked=252';
    const target = newCase('completed-mismatch');
    const attemptId = 'scenario-completed-mismatch';
    const paths = attemptPaths(target, attemptId);
    const result = runRunner(target, {
      CATALOG_EQUIVALENCE_ATTEMPT_ID: attemptId,
      CATALOG_EQUIVALENCE_STUB_EXIT: '0',
      CATALOG_EQUIVALENCE_STUB_REPORT_OVERRIDES: JSON.stringify({ completed: 4 }),
    });
    assert.equal(result.status, 2, `completed mismatch must exit 2; stderr=${result.stderr}`);
    const reportBytes = fs.readFileSync(paths.report, 'utf8');
    assert.equal(sha256(reportBytes), stubReportHash(result), 'rejected child report must be preserved byte-for-byte');
    assert.equal(JSON.parse(reportBytes).completed, 4);
    assert.equal(JSON.parse(reportBytes).itemCount, 126);
    const verdict = readJson(paths.verdict);
    assert.equal(verdict.status, 'failed');
    assert.equal(verdict.exitCode, 2);
    assert.equal(verdict.rejection, 'completed-mismatch');
    assert.ok(verdict.failures.includes('completed-mismatch'));
    assert.ok(verdict.failures.includes('completed-itemCount-inconsistent'));
    assertLatest(target, { attemptId, exitCode: 2, complete: false, status: 'failed', phase: 'runner-rejected' });
    pass(name);
  }

  {
    const name = "readOnlyEvidence.transactionReadOnly='off' is rejected";
    const target = newCase('readonly-evidence-off');
    const attemptId = 'scenario-readonly-evidence-off';
    const paths = attemptPaths(target, attemptId);
    const result = runRunner(target, {
      CATALOG_EQUIVALENCE_ATTEMPT_ID: attemptId,
      CATALOG_EQUIVALENCE_STUB_EXIT: '0',
      CATALOG_EQUIVALENCE_STUB_REPORT_OVERRIDES: JSON.stringify({ readOnlyEvidence: { transactionReadOnly: 'off' } }),
    });
    assert.equal(result.status, 2, `transactionReadOnly=off must exit 2; stderr=${result.stderr}`);
    const reportBytes = fs.readFileSync(paths.report, 'utf8');
    assert.equal(sha256(reportBytes), stubReportHash(result), 'rejected child report must be preserved byte-for-byte');
    const verdict = readJson(paths.verdict);
    assert.equal(verdict.status, 'failed');
    assert.equal(verdict.exitCode, 2);
    assert.equal(verdict.rejection, 'readOnlyEvidence-not-read-only');
    assert.ok(verdict.failures.includes('readOnlyEvidence-not-read-only'));
    assertLatest(target, { attemptId, exitCode: 2, complete: false, status: 'failed', phase: 'runner-rejected' });
    pass(name);
  }

  {
    const name = 'missing readOnlyEvidence is rejected';
    const target = newCase('readonly-evidence-missing');
    const attemptId = 'scenario-readonly-evidence-missing';
    const paths = attemptPaths(target, attemptId);
    const result = runRunner(target, {
      CATALOG_EQUIVALENCE_ATTEMPT_ID: attemptId,
      CATALOG_EQUIVALENCE_STUB_EXIT: '0',
      CATALOG_EQUIVALENCE_STUB_REPORT_OVERRIDES: JSON.stringify({ readOnlyEvidence: null }),
    });
    assert.equal(result.status, 2, `missing readOnlyEvidence must exit 2; stderr=${result.stderr}`);
    const reportBytes = fs.readFileSync(paths.report, 'utf8');
    assert.equal(sha256(reportBytes), stubReportHash(result), 'rejected child report must be preserved byte-for-byte');
    const verdict = readJson(paths.verdict);
    assert.equal(verdict.status, 'failed');
    assert.equal(verdict.exitCode, 2);
    assert.equal(verdict.rejection, 'readOnlyEvidence-missing');
    assert.ok(verdict.failures.includes('readOnlyEvidence-missing'));
    assertLatest(target, { attemptId, exitCode: 2, complete: false, status: 'failed', phase: 'runner-rejected' });
    pass(name);
  }

  // Isolation guard: the real production paths must be untouched by this test.
  {
    const prodLatestAfter = fs.existsSync(PROD_LATEST) ? fs.readFileSync(PROD_LATEST, 'utf8') : null;
    assert.equal(prodLatestAfter, prodLatestBefore, 'production candidate-equivalence-latest.json must never be written by this test');
    for (const attemptId of usedAttemptIds) {
      assert.equal(
        fs.existsSync(path.join(PROD_ATTEMPTS_ROOT, attemptId)),
        false,
        `production attempts root must not contain test attempt ${attemptId}`,
      );
    }
    const prodAttemptsAfter = fs.existsSync(PROD_ATTEMPTS_ROOT) ? fs.readdirSync(PROD_ATTEMPTS_ROOT) : [];
    for (const attemptId of usedAttemptIds) {
      assert.ok(prodAttemptsBefore.size === 0 || !prodAttemptsAfter.includes(attemptId));
    }
    pass('production attempts root and latest pointer stay untouched (isolated sandbox)');
  }

  console.log(JSON.stringify({
    ok: true,
    command: 'node tests/catalog/run-candidate-equivalence-runner.test.mjs',
    scenarios: passed.length,
    names: passed,
  }, null, 2));
} catch (error) {
  failed = true;
  console.error(`FAIL: ${error instanceof Error ? error.stack : String(error)}`);
  console.error(`sandbox kept for inspection: ${SANDBOX}`);
  process.exitCode = 1;
} finally {
  if (!failed) fs.rmSync(SANDBOX, { recursive: true, force: true });
}
