import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

const evidence = path.resolve(process.argv[2]);
const logDir = path.resolve(process.argv[3]);
const records = JSON.parse(fs.readFileSync(path.join(evidence, 'effective-review-records.json'), 'utf8'));
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1800, height: 950 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const checked = [];
try {
  for (const name of ['match-review.html', 'bs-warehouse-overview.html']) {
    await page.goto(pathToFileURL(path.join(evidence, name)).href);
    await page.evaluate(() => localStorage.setItem('p0-03-stale-review', JSON.stringify({ fake: 'confirm' })));
    await page.reload();
    const expected = name === 'match-review.html' ? records : records.filter((r) => r.source_system === 'bigseller');
    const actual = await page.locator('tbody tr').evaluateAll((trs) => trs.map((tr) => ({
      id: tr.dataset.id, state: tr.dataset.state,
      fields: [...tr.cells].map((c) => c.textContent),
    })));
    assert.equal(actual.length, expected.length);
    for (let i = 0; i < expected.length; i += 1) {
      const r = expected[i];
      assert.equal(actual[i].id, r.candidate_id);
      assert.equal(actual[i].state, r.review_state);
      for (const [cell, key] of [[0, 'source_system'], [1, 'warehouse'], [2, 'external_sku_raw'], [5, 'master_row_index'], [6, 'master_ice_code'], [7, 'manual_master_row'], [8, 'manual_master_ice'], [9, 'selected_jst_sku'], [10, 'review_decision'], [11, 'review_notes'], [12, 'review_reason'], [14, 'selected_master_quality_issues'], [16, 'manual_jst_sku'], [17, 'historical_correction_reason'], [18, 'manual_jushuitan_conflict']]) {
        assert.equal(actual[i].fields[cell], String(r[key]), `${r.candidate_id}:${key}`);
      }
    }
    await page.locator('#state').selectOption('manual_selected');
    assert.equal(await page.locator('tbody tr:visible').count(), expected.filter((r) => r.review_state === 'manual_selected').length);
    await page.locator('#state').selectOption('');
    const chosen = expected.find((r) => r.manual_master_row && r.review_state === 'manual_selected');
    assert.ok(chosen);
    await page.locator('#search').fill(chosen.external_sku_raw);
    const restored = page.locator(`tr[data-id="${chosen.candidate_id}"]`);
    assert.equal(await restored.isVisible(), true);
    assert.equal(await restored.locator('td').nth(5).textContent(), String(chosen.master_row_index));
    assert.equal(await restored.locator('td').nth(6).textContent(), chosen.master_ice_code);
    await page.screenshot({ path: path.join(logDir, `${name}-restored.png`) });
    await page.locator('#search').fill('ICEWM0039');
    const wrong = page.locator('tr[data-id="mc-994fa1007b50d5be"]');
    assert.equal(await wrong.isVisible(), true);
    const wrongRecord = expected.find((r) => r.candidate_id === 'mc-994fa1007b50d5be');
    assert.equal(await wrong.getAttribute('data-state'), wrongRecord.review_state);
    assert.equal(await wrong.locator('td').nth(5).textContent(), '');
    assert.equal(await wrong.locator('td').nth(6).textContent(), '');
    assert.equal(await wrong.locator('td').nth(10).textContent(), wrongRecord.review_decision);
    assert.ok(await wrong.locator('td').nth(17).textContent());
    await page.screenshot({ path: path.join(logDir, `${name}-revoked.png`) });
    const conflictRecord = expected.find((r) => r.manual_jushuitan_conflict !== 'null');
    if (conflictRecord) {
      await page.locator('#search').fill(conflictRecord.external_sku_raw);
      const conflicted = page.locator(`tr[data-id="${conflictRecord.candidate_id}"]`);
      assert.equal(await conflicted.isVisible(), true);
      assert.equal(await conflicted.getAttribute('data-state'), 'pending');
      assert.equal(await conflicted.locator('td').nth(6).textContent(), '');
      assert.equal(await conflicted.locator('td').nth(16).textContent(), conflictRecord.manual_jst_sku);
      assert.equal(await conflicted.locator('td').nth(18).textContent(), conflictRecord.manual_jushuitan_conflict);
      await page.screenshot({ path: path.join(logDir, `${name}-jst-conflict.png`) });
    }
    checked.push({ file: name, rows: expected.length, domCompared: true, filtersVerified: true });
  }
  assert.deepEqual(errors, []);
  const report = { status: 'verified', checked, pageErrors: errors, exitCode: 0 };
  fs.writeFileSync(path.join(logDir, 'browser-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
}
