import { DEFAULT_RUN_ID } from './common.mjs';
import { captureLogisticsSkuBindings } from './fixture-integrity.mjs';
import { captureInventoryFixture, restoreInventoryFixture } from './fixture-snapshot.mjs';
import { guardBeforeMutate } from './instance-guard.mjs';

const runId = DEFAULT_RUN_ID;
const { instance } = guardBeforeMutate(runId);

const logisticsBefore = captureLogisticsSkuBindings(instance);
if (logisticsBefore.length < 1) {
  console.error(
    JSON.stringify({
      status: 'failed',
      reason: 'missing-logistics-sku-binding',
      detail: 'seed 应包含 matched_variant_id 非空的 shipment_external_item',
    }),
  );
  process.exit(3);
}

const snapshot = captureInventoryFixture(instance);
const tampered = structuredClone(snapshot);
tampered.inventory.push({
  id: '99999999-9999-4999-8999-999999999999',
  variant_id: '99999999-9999-4999-8999-999999999998',
  warehouse_id: '99999999-9999-4999-8999-999999999997',
  quantity: 1,
  last_sync_at: null,
  daily_sales: null,
  estimated_days: null,
});

let failedAsExpected = false;
try {
  restoreInventoryFixture(instance, tampered);
} catch {
  failedAsExpected = true;
}

const logisticsMid = captureLogisticsSkuBindings(instance);
if (JSON.stringify(logisticsMid) !== JSON.stringify(logisticsBefore)) {
  console.error(
    JSON.stringify({
      status: 'failed',
      phase: 'after-invalid-restore',
      reason: 'logistics-binding-mutated',
      before: logisticsBefore,
      mid: logisticsMid,
    }),
  );
  process.exit(4);
}

try {
  restoreInventoryFixture(instance, snapshot);
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', phase: 'final-restore', error: String(error) }));
  process.exit(2);
}

const logisticsAfter = captureLogisticsSkuBindings(instance);
if (JSON.stringify(logisticsAfter) !== JSON.stringify(logisticsBefore)) {
  console.error(
    JSON.stringify({
      status: 'failed',
      phase: 'after-valid-restore',
      reason: 'logistics-binding-mutated',
      before: logisticsBefore,
      after: logisticsAfter,
    }),
  );
  process.exit(5);
}

if (!failedAsExpected) {
  console.error(JSON.stringify({ status: 'failed', reason: 'invalid-fixture-restore-should-fail' }));
  process.exit(1);
}

console.log(
  JSON.stringify({
    status: 'ok',
    invalidFixtureRestoreRejected: true,
    logisticsSkuBindingPreserved: true,
    bindingSample: logisticsBefore[0],
  }),
);
