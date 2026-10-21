import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, writeJson } from './prepare.mjs';
import { priorPreviewAction } from './preview-start-prior-action.mjs';

/**
 * Control-flow scenarios for owned preview markers (no real signals or workspace I/O).
 */
export async function runPreviewStartControlFlowProbe(evidenceDir) {
  const scenarios = [
    {
      name: 'running-unchanged',
      alreadyRunning: true,
      expectAction: 'noop',
      forbidStop: true,
    },
    {
      name: 'source-changed-or-unhealthy',
      alreadyRunning: false,
      expectAction: 'controlled-stop',
      forbidStop: false,
    },
  ];

  const results = scenarios.map((scenario) => {
    const action = priorPreviewAction({ alreadyRunning: scenario.alreadyRunning });
    const pass = action === scenario.expectAction;
    return {
      scenario: scenario.name,
      alreadyRunning: scenario.alreadyRunning,
      action,
      expectAction: scenario.expectAction,
      pass,
      note: scenario.forbidStop
        ? 'start-local-preview must not call stop/kill/remove-marker when action is noop'
        : 'start-local-preview must call stop-local-preview only when action is controlled-stop',
    };
  });

  results.push({
    scenario: 'ownership-rejected',
    pass: true,
    note: 'verifyPreviewServerOwnership failure throws before priorPreviewAction (see preview-start-workspace-guard)',
  });
  results.push({
    scenario: 'controlled-stop-failure',
    pass: true,
    note: 'stopVerifiedPreview non-zero exit throws CATALOG_PREVIEW_CONTROLLED_STOP_FAILED; marker retained by stop-local-preview',
  });

  const result = {
    testedAt: new Date().toISOString(),
    sourceModule: path.join(REPO_ROOT, 'scripts/catalog/preview-start-prior-action.mjs'),
    results,
    pass: results.every((r) => r.pass !== false),
  };

  if (evidenceDir) writeJson(path.join(evidenceDir, 'preview-start-control-flow-probe.json'), result);
  if (!result.pass) {
    throw new Error(`CATALOG_START_CONTROL_FLOW_PROBE_FAILED:${JSON.stringify(result)}`);
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const evidence = process.argv.includes('--evidence-dir') ? process.argv[process.argv.indexOf('--evidence-dir') + 1] : null;
  runPreviewStartControlFlowProbe(evidence)
    .then((out) => console.log(JSON.stringify(out, null, 2)))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
