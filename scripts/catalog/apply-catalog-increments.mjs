import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openRun, readArgs } from './prepare.mjs';
import { syncCatalogSqlIncrements } from './catalog-sql-increments.mjs';

export async function applyCatalogIncrements(argsOrRunId) {
  const run = typeof argsOrRunId === 'string'
    ? openRun(readArgs(['--run-id', argsOrRunId, '--host', '127.0.0.1']))
    : openRun(argsOrRunId);
  const instance = JSON.parse(fs.readFileSync(path.join(run.instanceRoot, 'catalog-instance.json'), 'utf8'));
  const ownerUrl = `postgres://${instance.bootstrapUser}:${instance.bootstrapPassword}@${instance.host}:${instance.port}/${instance.dbName}`;
  const { default: pg } = await import('pg');
  const owner = new pg.Client({ connectionString: ownerUrl });
  await owner.connect();
  try {
    return await syncCatalogSqlIncrements(owner, run.instanceRoot);
  } finally {
    await owner.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = readArgs(process.argv.slice(2));
  applyCatalogIncrements(args.runId).then((applied) => {
    console.log(`catalog increments synced: ${applied.length} recorded`);
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
