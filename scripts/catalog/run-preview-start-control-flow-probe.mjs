import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, writeJson } from './prepare.mjs';

/**
 * Runs isolated VM probes against actual start/stop-local-preview.mjs (no real signals).
 */
export async function runPreviewStartControlFlowProbe(evidenceDir) {
  const probeScript = path.join(REPO_ROOT, 'scripts/catalog/preview-control-flow-vm-probes.mjs');
  const env = { ...process.env };
  if (evidenceDir) env.CATALOG_PROBE_EVIDENCE_DIR = evidenceDir;

  const run = spawnSync(
    process.execPath,
    ['--experimental-vm-modules', probeScript],
    {
      encoding: 'utf8',
      env,
      cwd: REPO_ROOT,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    },
  );

  let parsed;
  try {
    const stdout = run.stdout.trim();
    parsed = JSON.parse(stdout);
  } catch {
    parsed = {
      pass: false,
      parseError: true,
      exitCode: run.status,
      stdout: run.stdout,
      stderr: run.stderr,
    };
  }

  const result = {
    testedAt: new Date().toISOString(),
    probeScript,
    spawnExitCode: run.status,
    ...parsed,
    pass: run.status === 0 && parsed.pass === true,
  };

  if (evidenceDir) {
    writeJson(path.join(evidenceDir, 'preview-start-control-flow-probe.json'), result);
  }

  if (!result.pass) {
    throw new Error(`CATALOG_CONTROL_FLOW_PROBE_FAILED:${JSON.stringify(result)}`);
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
