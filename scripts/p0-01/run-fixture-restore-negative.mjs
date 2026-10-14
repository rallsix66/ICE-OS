import { DEFAULT_RUN_ID } from './common.mjs';
import { captureBizFixture, restoreBizFixture } from './fixture-snapshot.mjs';
import { guardBeforeMutate } from './instance-guard.mjs';

const runId = DEFAULT_RUN_ID;
const { instance } = guardBeforeMutate(runId);
const snapshot = captureBizFixture(instance);
const tampered = structuredClone(snapshot);
tampered.tables.inventory.push({
  id: '99999999-9999-4999-8999-999999999999',
  product_variant_id: '99999999-9999-4999-8999-999999999998',
  warehouse_id: '99999999-9999-4999-8999-999999999997',
  available_quantity: 1,
});

let failedAsExpected = false;
try {
  restoreBizFixture(instance, tampered);
} catch {
  failedAsExpected = true;
}

try {
  restoreBizFixture(instance, snapshot);
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', phase: 'final-restore', error: String(error) }));
  process.exit(2);
}

if (!failedAsExpected) {
  console.error(JSON.stringify({ status: 'failed', reason: 'invalid-fixture-restore-should-fail' }));
  process.exit(1);
}

console.log(JSON.stringify({ status: 'ok', invalidFixtureRestoreRejected: true }));
