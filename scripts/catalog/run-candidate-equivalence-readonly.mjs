#!/usr/bin/env node
/**
 * Read-only serial candidate equivalence (126 items × 2 source systems).
 * Does not seed or mutate catalog data.
 *
 * File ownership boundary (progress8 R3 fix):
 *   attempts/<id>/candidate-equivalence.json  child-only report. The runner may
 *                                             only read it, never write it, and only
 *                                             after the child process has exited.
 *   attempts/<id>/runner-lifecycle.json       runner phase log (attemptId/runId/phase/status).
 *   attempts/<id>/runner-verdict.json         runner verdict (exitCode/status/acceptance/rejection).
 *
 * The previous implementation wrote a 'child-exited' phase into the report path
 * right after spawnSync, which downgraded a genuinely complete child report to
 * complete:false and made the runner exit 2. Runner bookkeeping now lives in the
 * separate lifecycle/verdict files so the child report stays byte-identical.
 *
 * Success requires all of: attemptId match, runId match, itemCount=126,
 * sourceGroupsChecked=252, differenceGroups=0, readOnly=true, complete=true and
 * child exit code 0. The latest pointer is published only after that validation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const entry = 'scripts/catalog/run-candidate-equivalence-readonly.mjs';
const runId = process.env.CATALOG_RUN_ID ?? 'run-20261021T100700Z-b3c4d5e6';
const envCatalogJson = JSON.parse(fs.readFileSync(path.join(repo, `.local/catalog/${runId}/instance/env.catalog.json`), 'utf8'));

// Defaults are the production paths; tests point these at an isolated sandbox so
// the historical attempts directory and latest pointer are never touched.
const attemptsRoot = process.env.CATALOG_EQUIVALENCE_ATTEMPTS_ROOT
  ? path.resolve(repo, process.env.CATALOG_EQUIVALENCE_ATTEMPTS_ROOT)
  : path.join(repo, '.local/catalog/ux-perf-u3-20261022/attempts');
const latestPointerPath = process.env.CATALOG_EQUIVALENCE_LATEST_PATH
  ? path.resolve(repo, process.env.CATALOG_EQUIVALENCE_LATEST_PATH)
  : path.join(repo, '.local/catalog/ux-perf-u3-20261022/candidate-equivalence-latest.json');

const EXPECTED_ITEM_COUNT = 126;
const EXPECTED_SOURCE_GROUPS_CHECKED = 252;

function sanitizeAttemptId(raw) {
  if (!raw || typeof raw !== 'string') return null;
  if (raw.includes('/') || raw.includes('\\') || raw.includes('..')) return null;
  if (!/^[a-zA-Z0-9._-]+$/.test(raw)) return null;
  const resolved = path.resolve(attemptsRoot, raw);
  if (!resolved.startsWith(`${path.resolve(attemptsRoot)}${path.sep}`)) return null;
  return raw;
}

const requestedAttemptId = process.env.CATALOG_EQUIVALENCE_ATTEMPT_ID;
// A generated id is only used when no attempt id was requested; an explicitly
// requested id that fails sanitisation is refused rather than silently replaced.
const attemptId = requestedAttemptId
  ? sanitizeAttemptId(requestedAttemptId)
  : `progress8-${new Date().toISOString().replace(/[:.]/g, '-')}`;

if (!attemptId) {
  console.error('invalid CATALOG_EQUIVALENCE_ATTEMPT_ID');
  process.exit(2);
}

const attemptDir = path.join(attemptsRoot, attemptId);
const outPath = path.join(attemptDir, 'candidate-equivalence.json');
const lifecyclePath = path.join(attemptDir, 'runner-lifecycle.json');
const verdictPath = path.join(attemptDir, 'runner-verdict.json');
const lockPath = path.join(attemptDir, '.attempt-lock');

const lifecycle = { attemptId, runId, entry, phases: [] };

function writeJson(filePath, payload) {
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function recordPhase(phase, status, detail = {}) {
  const record = { at: new Date().toISOString(), ...detail, attemptId, runId, phase, status };
  lifecycle.phases.push(record);
  fs.mkdirSync(attemptDir, { recursive: true });
  writeJson(lifecyclePath, lifecycle);
  return record;
}

function writeVerdict({ exitCode, status, phase, rejection, failures, childExitCode, childReportPresent }) {
  const body = {
    attemptId,
    runId,
    entry,
    at: new Date().toISOString(),
    ok: status === 'complete',
    complete: status === 'complete',
    status,
    phase,
    exitCode,
    childExitCode,
    childReportPresent,
    childReportPath: outPath,
    rejection: rejection ?? null,
    failures: failures ?? [],
    lifecyclePath,
    latestPointerPath,
  };
  fs.mkdirSync(attemptDir, { recursive: true });
  writeJson(verdictPath, body);
  return body;
}

function writeLatestPointer({ exitCode, complete, status, phase, rejection }) {
  fs.mkdirSync(path.dirname(latestPointerPath), { recursive: true });
  writeJson(latestPointerPath, {
    attemptId,
    runId,
    canonicalPath: outPath,
    childReportPath: outPath,
    exitCode,
    complete,
    status,
    phase,
    rejection: rejection ?? null,
    at: new Date().toISOString(),
    entry,
  });
}

function fail(message) {
  console.error(message);
  process.exit(2);
}

function acquireAttemptDirectory() {
  fs.mkdirSync(attemptsRoot, { recursive: true });
  if (fs.existsSync(outPath)) {
    let existing = null;
    try {
      existing = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    } catch {
      fail(`attempt ${attemptId} has unreadable report; refusing reuse`);
    }
    if (existing?.complete === true) {
      // Refuse before writing anything: the complete report must stay byte-identical.
      fail(`attempt ${attemptId} already complete; refusing reuse`);
    }
  } else if (fs.existsSync(attemptDir)) {
    fail(`attempt directory ${attemptId} exists without report; refusing reuse`);
  } else {
    fs.mkdirSync(attemptDir, { recursive: false });
  }
  try {
    fs.writeFileSync(lockPath, `${attemptId}\n`, { flag: 'wx' });
  } catch {
    fail(`attempt lock unavailable for ${attemptId}`);
  }
  recordPhase('acquired', 'started', { lockPath });
}

acquireAttemptDirectory();

// Test-only spawn boundary: run `process.execPath <script>` instead of vitest.
// The stub child is responsible for writing attempts/<id>/candidate-equivalence.json;
// a bare stub that exits without writing a report can never produce success.
const childScript = process.env.CATALOG_EQUIVALENCE_CHILD_SCRIPT
  ? path.resolve(repo, process.env.CATALOG_EQUIVALENCE_CHILD_SCRIPT)
  : null;
const childArgs = childScript
  ? [childScript]
  : [
    path.join(repo, 'node_modules/vitest/vitest.mjs'),
    'run',
    'tests/catalog/candidate-pool-equivalence.postgres.test.ts',
    '--config',
    'vitest.config.catalog.mts',
    '--testTimeout',
    '1800000',
  ];

recordPhase('spawn-child', 'started', {
  childScript: childScript ?? 'vitest:tests/catalog/candidate-pool-equivalence.postgres.test.ts',
  attemptDir,
});

const child = spawnSync(process.execPath, childArgs, {
  cwd: repo,
  env: {
    ...process.env,
    P0_02_APP_DATABASE_URL: envCatalogJson.P0_02_APP_DATABASE_URL,
    CATALOG_EQUIVALENCE_ATTEMPT_ID: attemptId,
    CATALOG_EQUIVALENCE_ATTEMPT_DIR: attemptDir,
    CATALOG_EQUIVALENCE_RUN_ID: runId,
    CATALOG_EQUIVALENCE_RUNNER_MANAGED: '1',
  },
  encoding: 'utf8',
  stdio: 'inherit',
});

const childExitCode = child.status ?? 1;
const childSignal = child.signal ?? null;
const childError = child.error?.message ?? null;
recordPhase('child-exited', childExitCode === 0 ? 'ok' : 'failed', { childExitCode, childSignal, childError });

const childReportPresent = fs.existsSync(outPath);
let childReport = null;
let childReportParseError = null;
let childReportRaw = null;
if (childReportPresent) {
  childReportRaw = fs.readFileSync(outPath, 'utf8');
  try {
    childReport = JSON.parse(childReportRaw);
  } catch (error) {
    childReportParseError = error instanceof Error ? error.message : String(error);
  }
}
recordPhase(childReportPresent ? 'child-report-read' : 'child-report-missing', 'ok', {
  childReportPresent,
  childReportBytes: childReportRaw === null ? null : Buffer.byteLength(childReportRaw),
  childReportParseError,
});

const failures = [];
if (childExitCode !== 0) failures.push('child-nonzero');
if (!childReportPresent) {
  failures.push('child-report-missing');
} else if (childReportParseError) {
  failures.push('child-report-unreadable');
} else if (childReport === null || typeof childReport !== 'object' || Array.isArray(childReport)) {
  failures.push('child-report-not-object');
} else {
  if (childReport.attemptId !== attemptId) failures.push('attemptId-mismatch');
  if (typeof childReport.runId !== 'string' || childReport.runId !== runId) failures.push('runId-mismatch');
  if (childReport.itemCount !== EXPECTED_ITEM_COUNT) failures.push('itemCount-mismatch');
  if (childReport.sourceGroupsChecked !== EXPECTED_SOURCE_GROUPS_CHECKED) failures.push('sourceGroupsChecked-mismatch');
  if (childReport.differenceGroups !== 0) failures.push('differenceGroups-nonzero');
  if (childReport.readOnly !== true) failures.push('readOnly-not-true');
  if (childReport.complete !== true) failures.push('incomplete-report');
  // Declared counts are not enough: the loop must actually have reached every item.
  if (childReport.completed !== EXPECTED_ITEM_COUNT) failures.push('completed-mismatch');
  if (childReport.completed !== childReport.itemCount) failures.push('completed-itemCount-inconsistent');
  // The read-only claim must be backed by the actual transaction evidence from the child session.
  const readOnlyEvidence = childReport.readOnlyEvidence;
  if (readOnlyEvidence === null || typeof readOnlyEvidence !== 'object' || Array.isArray(readOnlyEvidence)) {
    failures.push('readOnlyEvidence-missing');
  } else if (readOnlyEvidence.transactionReadOnly !== 'on') {
    failures.push('readOnlyEvidence-not-read-only');
  }
}

if (failures.length > 0) {
  const rejection = failures[0];
  const exitCode = childExitCode !== 0 ? childExitCode : 2;
  recordPhase('rejected', 'failed', { rejection, failures, childExitCode, childReportPresent });
  writeVerdict({
    exitCode,
    status: 'failed',
    phase: 'runner-rejected',
    rejection,
    failures,
    childExitCode,
    childReportPresent,
  });
  writeLatestPointer({ exitCode, complete: false, status: 'failed', phase: 'runner-rejected', rejection });
  console.error(`candidate equivalence attempt ${attemptId} rejected (${failures.join(', ')}); exit ${exitCode}`);
  process.exit(exitCode);
}

recordPhase('validated', 'ok', {
  childExitCode,
  childReportPresent,
  itemCount: childReport.itemCount,
  sourceGroupsChecked: childReport.sourceGroupsChecked,
  completed: childReport.completed,
  differenceGroups: childReport.differenceGroups,
  readOnlyEvidence: childReport.readOnlyEvidence,
});
// The child report is left byte-identical; the runner never rewrites it.
writeLatestPointer({ exitCode: 0, complete: true, status: 'complete', phase: 'runner-published', rejection: null });
recordPhase('published', 'complete', { childExitCode, childReportPresent, latestPointerPath });
writeVerdict({
  exitCode: 0,
  status: 'complete',
  phase: 'runner-published',
  rejection: null,
  failures: [],
  childExitCode,
  childReportPresent,
});
process.exit(0);
