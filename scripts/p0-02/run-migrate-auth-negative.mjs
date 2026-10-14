import { DEFAULT_RUN_ID } from './common.mjs';
import { migrateAuthSchema } from './migrate-auth-schema.mjs';
import { guardBeforeMutate } from './instance-guard.mjs';
import { guardP001Entry } from './entry-guard.mjs';

const runId = DEFAULT_RUN_ID;
guardP001Entry(runId);
const { instance } = guardBeforeMutate(runId);

let rejected = false;
try {
  await migrateAuthSchema(instance, runId, {
    async runMigrations() {
      throw new Error('CONTROLLED_MIGRATION_FAILURE');
    },
  });
} catch (error) {
  if (error instanceof Error && error.message.includes('CONTROLLED_MIGRATION_FAILURE')) {
    rejected = true;
  } else {
    console.error(JSON.stringify({ status: 'failed', unexpected: String(error) }));
    process.exit(2);
  }
}

if (!rejected) {
  console.error(JSON.stringify({ status: 'failed', reason: 'migrateAuthSchema did not propagate failure' }));
  process.exit(1);
}

try {
  await migrateAuthSchema(instance, runId);
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', phase: 'normal-migrate', error: String(error) }));
  process.exit(3);
}

console.log(JSON.stringify({ status: 'ok', failureInjectedAndPropagated: true, normalMigrateOk: true }));
