#!/usr/bin/env node
/**
 * Test-only child stub for scripts/catalog/run-candidate-equivalence-readonly.mjs.
 *
 * The runner spawns `process.execPath <this file>` when
 * CATALOG_EQUIVALENCE_CHILD_SCRIPT is set. Like the real vitest child, this stub
 * owns attempts/<id>/candidate-equivalence.json: it writes the report itself and
 * only then exits with the code requested by the test. The runner must never
 * fabricate or rewrite this report.
 *
 * Env contract (set by the runner):
 *   CATALOG_EQUIVALENCE_ATTEMPT_ID    attempt id the report must carry
 *   CATALOG_EQUIVALENCE_ATTEMPT_DIR   directory to write candidate-equivalence.json into
 *   CATALOG_EQUIVALENCE_RUN_ID        runId the report must carry
 *
 * Test controls:
 *   CATALOG_EQUIVALENCE_STUB_EXIT              integer exit code (default 0)
 *   CATALOG_EQUIVALENCE_STUB_WRITE_REPORT      '0' to exit without writing a report
 *   CATALOG_EQUIVALENCE_STUB_REPORT_OVERRIDES  JSON object merged into the report last
 *                                              (e.g. {"attemptId":"other"} or {"runId":"x"})
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const attemptId = process.env.CATALOG_EQUIVALENCE_ATTEMPT_ID ?? null;
const runId = process.env.CATALOG_EQUIVALENCE_RUN_ID ?? 'stub-run';
const attemptDir = process.env.CATALOG_EQUIVALENCE_ATTEMPT_DIR
  ? path.resolve(process.env.CATALOG_EQUIVALENCE_ATTEMPT_DIR)
  : path.join(repo, '.local/catalog/ux-perf-u3-20261022/attempts', attemptId ?? 'stub');
const outPath = path.join(attemptDir, 'candidate-equivalence.json');

const parsedExit = Number.parseInt(process.env.CATALOG_EQUIVALENCE_STUB_EXIT ?? '0', 10);
const exitCode = Number.isInteger(parsedExit) && parsedExit >= 0 ? parsedExit : 0;
const writeReport = process.env.CATALOG_EQUIVALENCE_STUB_WRITE_REPORT !== '0';
const overrides = JSON.parse(process.env.CATALOG_EQUIVALENCE_STUB_REPORT_OVERRIDES ?? '{}');

if (writeReport) {
  const report = {
    attemptId,
    runId,
    at: new Date().toISOString(),
    readOnly: true,
    readOnlyEvidence: { transactionReadOnly: 'on' },
    serial: true,
    itemCount: 126,
    sourceGroupsChecked: 252,
    completed: 126,
    differenceGroups: 0,
    mismatches: [],
    complete: true,
    ...overrides,
  };
  fs.mkdirSync(attemptDir, { recursive: true });
  const body = `${JSON.stringify(report, null, 2)}\n`;
  fs.writeFileSync(outPath, body);
  console.log(`stub-child:wrote ${outPath}`);
  console.log(`stub-child:sha256=${crypto.createHash('sha256').update(body).digest('hex')}`);
}
console.log(`stub-child:exit ${exitCode}`);
process.exit(exitCode);
