import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixturePath = path.join(repo, '.local/catalog/ux-perf-u3-20261022/perf-sample-fixture.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const items = fixture.items ?? [];
assert.equal(items.length, 20, 'fixture must contain 20 items');

const wm = items.find((x) => x.iceCode === 'WM0043');
assert.ok(wm, 'WM0043 required');
assert.equal(wm.inventoryRows.length, 4);
assert.equal(wm.confirmedOnHandTotal, '7355');
assert.equal(wm.unitCost, '¥2.94');
assert.equal(wm.estimatedValue, '¥21623.7');

assert.ok(fixture.basisDocumentSha256, 'basisDocumentSha256 required');
assert.ok(Array.isArray(fixture.listPages) && fixture.listPages.length >= 2, 'listPages required');
const wmParts = wm.partitionExpect;
assert.ok(wmParts?.candidates?.observationIds?.length, 'WM0043 candidate observationIds required');
assert.ok(wmParts?.history?.revisions?.length, 'WM0043 history revisions required');
assert.ok(wmParts?.auditJson?.differenceCount != null, 'WM0043 audit projection required');

for (const item of items) {
  assert.ok(item.itemId, `${item.iceCode} missing itemId`);
  assert.ok(item.revision >= 1, `${item.iceCode} missing revision`);
  if (item.valuationState === 'valued') {
    assert.ok(item.estimatedValue, `${item.iceCode} valued without estimatedValue`);
    assert.ok(item.inventoryRows?.length, `${item.iceCode} valued without inventory rows`);
    assert.ok(item.confirmedOnHandTotal != null, `${item.iceCode} valued without confirmedOnHandTotal`);
  }
}

console.log(JSON.stringify({ ok: true, fixturePath, wm0043Rows: wm.inventoryRows.length }, null, 2));
