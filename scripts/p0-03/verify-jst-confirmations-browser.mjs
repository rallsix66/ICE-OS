import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

const delivery = path.resolve(process.argv[2]);
const coverage = path.resolve(process.argv[3]);
const logs = path.resolve(process.argv[4]);
fs.mkdirSync(logs, { recursive: false });
process.chdir(logs);
const read = (directory, name) => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
const records = read(delivery, 'effective-review-records.json');
const masters = read(delivery, 'master-overview.json');
const bundle = read(delivery, 'match-bundle.json');
const plan = read(delivery, 'jst-decisions.frozen.json');
const questions = read(coverage, 'audit-questions.json');
const coverageRows = read(coverage, 'product-coverage.json');
const errors = [];
const remoteRequests = [];
const checked = [];
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1800, height: 1000 } });
page.on('pageerror', (error) => errors.push(error.message));
await page.route(/^https?:/, async (route) => { remoteRequests.push(route.request().url()); await route.abort(); });
const visit = (directory, name) => page.goto(pathToFileURL(path.join(directory, name)).href);
try {
  for (const name of ['match-review.html', 'bs-warehouse-overview.html']) {
    await visit(delivery, name);
    const expected = name === 'match-review.html' ? records : records.filter((r) => r.source_system === 'bigseller');
    assert.deepEqual(await page.locator('#review-data').evaluate((node) => JSON.parse(node.textContent).rows), expected);
    const rows = await page.locator('tbody tr').evaluateAll((trs) => trs.map((tr) => ({ id: tr.dataset.id, state: tr.dataset.state, cells: [...tr.cells].map((c) => c.textContent) })));
    assert.equal(rows.length, expected.length);
    for (let i = 0; i < expected.length; i += 1) {
      const r = expected[i];
      assert.equal(rows[i].id, r.candidate_id);
      assert.equal(rows[i].state, r.review_state);
      for (const [index, key] of [[0, 'source_system'], [1, 'warehouse'], [2, 'external_sku_raw'], [3, 'external_name'], [5, 'master_row_index'], [6, 'master_ice_code'], [7, 'manual_master_row'], [8, 'manual_master_ice'], [9, 'selected_jst_sku'], [10, 'review_decision'], [11, 'review_notes'], [12, 'review_reason'], [13, 'quality_flags'], [14, 'selected_master_quality_issues'], [15, 'candidate_targets'], [16, 'manual_jst_sku'], [17, 'historical_correction_reason'], [18, 'manual_jushuitan_conflict'], [19, 'batch_business_pending']]) {
        assert.equal(rows[i].cells[index], String(r[key]), `${name}:${r.candidate_id}:${key}`);
      }
    }
    await page.locator('#state').selectOption('manual_selected');
    assert.equal(await page.locator('tbody tr:visible').count(), expected.filter((r) => r.review_state === 'manual_selected').length);
    await page.locator('#state').selectOption('');
    if (name === 'match-review.html') {
      for (const decision of plan.source_decisions) {
        await page.locator('#search').fill(decision.target_ice);
        const row = page.locator(`tr[data-id="${decision.candidate_id}"]`);
        assert.equal(await row.isVisible(), true, decision.candidate_id);
        assert.equal(await row.getAttribute('data-state'), decision.decision === 'ignore' ? 'ignored' : 'manual_selected');
        assert.equal(await row.locator('td').nth(10).textContent(), decision.decision);
        assert.equal(await row.locator('td').nth(11).textContent(), decision.reason);
        assert.equal(await row.locator('td').nth(6).textContent(), decision.decision === 'ignore' ? '' : decision.target_ice);
        if (decision.decision === 'confirm') assert.equal(await row.locator('td').nth(5).textContent(), String(decision.target_row));
        await row.scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(logs, `review-${decision.target_ice}-${decision.decision}.png`) });
        checked.push({ file: name, candidate_id: decision.candidate_id, visible: true, decision: decision.decision, target: decision.decision === 'ignore' ? null : decision.target_ice });
      }
    }
    await page.locator('#search').fill('6974674957349');
    for (const cid of ['mc-e1b56fb81b0db46c', 'mc-73ac4812d7d8de64', 'mc-b7bd376e964738cd']) {
      const row = page.locator(`tr[data-id="${cid}"]`);
      assert.equal(await row.isVisible(), true);
      assert.equal(await row.locator('td').nth(6).textContent(), 'WM0012');
      assert.ok((await row.locator('td').nth(19).textContent()).includes('菲越普通洗面奶'));
    }
    await page.screenshot({ path: path.join(logs, `${name}-ph-vn-pending.png`) });
    checked.push({ file: name, compared_rows: rows.length, dom_all_rows_equal_saved_json: true, selected_filter: true, ph_vn_existing_selections_version_pending: true });
  }
  await visit(delivery, 'master-overview.html');
  assert.deepEqual(await page.locator('#master-data').evaluate((node) => JSON.parse(node.textContent)), masters);
  const masterRows = await page.locator('tbody tr').evaluateAll((trs) => trs.map((tr) => ({ row: Number(tr.dataset.masterRow), cells: [...tr.cells].map((cell) => cell.textContent) })));
  assert.equal(masterRows.length, 126);
  for (let i = 0; i < masters.length; i += 1) {
    assert.equal(masterRows[i].row, masters[i].row_index);
    assert.deepEqual(JSON.parse(masterRows[i].cells[4]), masters[i]);
  }
  for (const code of ['WM0070', 'WM0072']) {
    const m = masters.find((item) => item.ice_code === code);
    const row = page.locator(`tr[data-master-row="${m.row_index}"]`);
    assert.equal(await row.isVisible(), true);
    const actual = JSON.parse(await row.locator('td').nth(4).textContent());
    assert.equal(actual.bs_creation_status.status, 'user_confirmed_not_created');
    assert.match(actual.bs_creation_status.reason, /尚未.*创建|尚未.*建档|还没有创建/);
    assert.ok(actual.selected_source_ids.includes(plan.source_decisions.find((d) => d.target_ice === code).candidate_id));
    if (code === 'WM0072') {
      assert.equal(actual.data['成本价格'], '5.18'); assert.equal(actual.data['运营价格'], '5.68');
      assert.equal(actual.price_pending, false);
      assert.equal(actual.current_price_selection.source_row, 216);
      assert.deepEqual(actual.price_versions.map((x) => [x.cost, x.operating_price]), [['5', '5.5'], ['5.18', '5.68']]);
    }
    await row.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(logs, `master-${code}-bs-not-created.png`) });
  }
  assert.ok(masters.some((m) => m.ice_code === 'WM0007' && m.row_index === 15));
  checked.push({ file: 'master-overview.html', compared_rows: 126, bs_not_created: ['WM0070', 'WM0072'], wm72_price_and_history_preserved_jst_selected: true, wm7_master_preserved: true });

  // Audit output remains a read-only report, not a second review interface.
  // Chromium reads its actual local files; no new business page is introduced.
  await visit(coverage, 'product-coverage.json');
  assert.deepEqual(JSON.parse(await page.locator('body').textContent()), coverageRows);
  for (const code of ['WM0070', 'WM0072']) {
    const item = coverageRows.find((x) => x.ice_code === code);
    assert.equal(item.bigseller_creation_status.status, 'user_confirmed_not_created');
    assert.equal(item.coverage_class, 'jushuitan_only');
  }
  checked.push({ file: 'product-coverage.json', read_by_browser: true, compared_records: 126, bs_creation_reason_preserved: true });
  await visit(coverage, 'audit-questions.json');
  assert.deepEqual(JSON.parse(await page.locator('body').textContent()), questions);
  assert.equal(questions.length, 7);
  const questionText = JSON.stringify(questions);
  for (const code of ['WM0006', 'WM0008', 'WM0130', 'WM0031', 'WM0062', 'WM0098']) assert.ok(questionText.includes(code));
  checked.push({ file: 'audit-questions.json', read_by_browser: true, original_business_issue_and_six_spec_audits: true });
  await visit(coverage, 'coverage-report.zh.md');
  const reportText = await page.locator('body').textContent();
  assert.ok(reportText.includes('545') && reportText.includes('113') && reportText.includes('WM0070') && reportText.includes('WM0072'));
  assert.match(reportText, /图片内容.*未核验|图片内容.*尚未核验/);
  assert.ok(reportText.includes('6项') || reportText.includes('六项'));
  assert.ok(reportText.includes('菲越') && reportText.includes('待决'));
  await page.screenshot({ path: path.join(logs, 'coverage-report-six-spec-image-note.png') });
  checked.push({ file: 'coverage-report.zh.md', actual_text_read: true, six_specs_and_image_content_unverified: true });
  assert.equal(bundle.candidates.filter((c) => c.selected_master).length, 545);
  assert.deepEqual(errors, []); assert.deepEqual(remoteRequests, []);
  const report = { status: 'verified', distinct_local_files_visited: 6, checked, pageErrors: errors, remoteRequests, exit_code: 0 };
  fs.writeFileSync(path.join(logs, 'browser-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} finally { await browser.close(); }
