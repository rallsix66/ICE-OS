import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

const root = path.resolve(process.argv[2]);
const logDir = path.resolve(process.argv[3]);
fs.mkdirSync(logDir, { recursive: false });
// Chromium's log/cache files belong to this new evidence directory.
process.chdir(logDir);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1800, height: 950 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
const cases = [{ name: 'authorized-delivery', result: path.join(root, 'delivery-final') },
  ...JSON.parse(fs.readFileSync(path.join(root, 'negative-final', 'negative-report.json'), 'utf8')).filter((x) => ['ph-clear', 'milk-clear', 'eye-defer', 'sun-clear'].includes(x.case))];
const checked = [];
try {
  for (const entry of cases) {
    const caseName = entry.name ?? entry.case;
    const records = JSON.parse(fs.readFileSync(path.join(entry.result, 'effective-review-records.json'), 'utf8'));
    for (const name of ['match-review.html', 'bs-warehouse-overview.html']) {
      await page.goto(pathToFileURL(path.join(entry.result, name)).href);
      const expected = name === 'match-review.html' ? records : records.filter((r) => r.source_system === 'bigseller');
      const actual = await page.locator('tbody tr').evaluateAll((trs) => trs.map((tr) => ({ id: tr.dataset.id, state: tr.dataset.state, cells: [...tr.cells].map((c) => c.textContent) })));
      assert.equal(actual.length, expected.length);
      for (let i = 0; i < expected.length; i += 1) {
        const r = expected[i];
        assert.equal(actual[i].id, r.candidate_id);
        assert.equal(actual[i].state, r.review_state);
        for (const [cell, key] of [[0, 'source_system'], [1, 'warehouse'], [2, 'external_sku_raw'], [3, 'external_name'], [5, 'master_row_index'], [6, 'master_ice_code'], [7, 'manual_master_row'], [8, 'manual_master_ice'], [9, 'selected_jst_sku'], [10, 'review_decision'], [11, 'review_notes'], [12, 'review_reason'], [13, 'quality_flags'], [14, 'selected_master_quality_issues'], [15, 'candidate_targets'], [16, 'manual_jst_sku'], [17, 'historical_correction_reason'], [18, 'manual_jushuitan_conflict'], [19, 'batch_business_pending']]) {
          assert.equal(actual[i].cells[cell], String(r[key]), `${caseName}:${r.candidate_id}:${key}`);
        }
      }
      await page.locator('#state').selectOption('manual_selected');
      assert.equal(await page.locator('tbody tr:visible').count(), expected.filter((r) => r.review_state === 'manual_selected').length);
      await page.locator('#state').selectOption('');
      if (caseName === 'authorized-delivery') {
        for (const [cid, sku, ice] of [['mc-59f065c77b77953a', '6974674957349', 'WM0012'], ['mc-5131dbfa1ad6207d', '757577407076', 'WM0039'], ['mc-0b2c37c654a967b1', 'WM10012', 'WM10012']]) {
          const r = expected.find((r) => r.candidate_id === cid);
          if (!r) continue; // Warehouse view intentionally excludes JST.
          await page.locator('#search').fill(sku);
          const tr = page.locator(`tr[data-id="${cid}"]`);
          assert.equal(await tr.isVisible(), true);
          assert.equal(await tr.getAttribute('data-state'), 'manual_selected');
          assert.equal(await tr.locator('td').nth(6).textContent(), ice);
          assert.equal(await tr.locator('td').nth(10).textContent(), 'confirm');
          assert.equal(await tr.locator('td').nth(19).textContent(), 'null');
          await page.screenshot({ path: path.join(logDir, `${caseName}-${name}-${ice}.png`) });
        }
        for (const cid of ['mc-e1b56fb81b0db46c', 'mc-73ac4812d7d8de64', 'mc-b7bd376e964738cd']) {
          const tr = page.locator(`tr[data-id="${cid}"]`);
          assert.equal(await tr.locator('td').nth(6).textContent(), 'WM0012');
          assert.ok((await tr.locator('td').nth(19).textContent()).includes('菲越普通洗面奶'));
        }
        if (name === 'match-review.html') {
          const priceJst = expected.find((r) => r.source_system === 'jushuitan' && r.external_sku_raw === 'WM0072');
          assert.equal(priceJst.review_state, 'candidate');
          assert.equal(priceJst.master_ice_code, '');
          assert.equal(priceJst.review_decision, '');
          assert.equal(priceJst.batch_business_pending, 'null');
        }
      }
      await page.locator('#search').fill('ICEWM0039');
      const ph = page.locator('tr[data-id="mc-994fa1007b50d5be"]');
      const expectedPh = expected.find((r) => r.candidate_id === 'mc-994fa1007b50d5be');
      assert.equal(await ph.isVisible(), true);
      assert.equal(await ph.locator('td').nth(6).textContent(), String(expectedPh.master_ice_code));
      assert.ok(await ph.locator('td').nth(17).textContent());
      await page.screenshot({ path: path.join(logDir, `${caseName}-${name}-ph.png`) });
      await page.locator('#search').fill('6974674957349');
      assert.equal(await page.locator('tbody tr:visible').count(), expected.filter((r) => Object.values(r).some((v) => String(v).includes('6974674957349'))).length);
      checked.push({ case: caseName, file: name, rows: actual.length, domCompared: true, filtersVerified: true });
    }
    const details = JSON.parse(fs.readFileSync(path.join(entry.result, 'master-overview.json'), 'utf8'));
    await page.goto(pathToFileURL(path.join(entry.result, 'master-overview.html')).href);
    const masterRows = await page.locator('tbody tr').evaluateAll((trs) => trs.map((tr) => ({ row: Number(tr.dataset.masterRow), cells: [...tr.cells].map((c) => c.textContent) })));
    assert.equal(masterRows.length, 126);
    for (let i = 0; i < details.length; i += 1) {
      assert.equal(masterRows[i].row, details[i].row_index);
      assert.equal(masterRows[i].cells[1], details[i].ice_code);
      assert.equal(masterRows[i].cells[2], details[i].barcode);
      assert.deepEqual(JSON.parse(masterRows[i].cells[4]), details[i]);
    }
    const price = masterRows.find((r) => r.row === 66);
    assert.equal(JSON.parse(price.cells[4]).data['成本价格'], '5.18');
    assert.equal(JSON.parse(price.cells[4]).data['运营价格'], '5.68');
    assert.equal(JSON.parse(price.cells[4]).price_pending, false);
    assert.equal(JSON.parse(price.cells[4]).current_price_selection.source_row, 216);
    assert.deepEqual(JSON.parse(price.cells[4]).price_versions.map((x) => [x.cost, x.operating_price]), [['5', '5.5'], ['5.18', '5.68']]);
    await page.locator('tr[data-master-row="66"]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(logDir, `${caseName}-master-price.png`) });
    checked.push({ case: caseName, file: 'master-overview.html', rows: 126, domCompared: true });
  }
  assert.deepEqual(pageErrors, []);
  const report = { status: 'verified', checked, pageErrors, exitCode: 0 };
  fs.writeFileSync(path.join(logDir, 'browser-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
}
