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
const rows = read(delivery, 'effective-review-records.json');
const masters = read(delivery, 'master-overview.json');
const bundle = read(delivery, 'match-bundle.json');
const plan = read(delivery, 'final-decisions.frozen.json');
const questions = read(coverage, 'audit-questions.json');
const coverageRows = read(coverage, 'product-coverage.json');
const checked = [];
const errors = [];
const requests = [];
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1800, height: 1000 } });
page.on('pageerror', (error) => errors.push(error.message));
await page.route(/^https?:/, async (route) => { requests.push(route.request().url()); await route.abort(); });
const visit = (directory, file) => page.goto(pathToFileURL(path.join(directory, file)).href);
try {
  for (const file of ['match-review.html', 'bs-warehouse-overview.html']) {
    await visit(delivery, file);
    const expected = file === 'match-review.html' ? rows : rows.filter((r) => r.source_system === 'bigseller');
    assert.deepEqual(await page.locator('#review-data').evaluate((node) => JSON.parse(node.textContent).rows), expected);
    const actual = await page.locator('tbody tr').evaluateAll((trs) => trs.map((tr) => ({ id: tr.dataset.id, state: tr.dataset.state, cells: [...tr.cells].map((cell) => cell.textContent) })));
    assert.equal(actual.length, expected.length);
    for (let i = 0; i < expected.length; i += 1) {
      const r = expected[i];
      assert.equal(actual[i].id, r.candidate_id); assert.equal(actual[i].state, r.review_state);
      for (const [index, key] of [[0, 'source_system'], [1, 'warehouse'], [2, 'external_sku_raw'], [3, 'external_name'], [5, 'master_row_index'], [6, 'master_ice_code'], [7, 'manual_master_row'], [8, 'manual_master_ice'], [9, 'selected_jst_sku'], [10, 'review_decision'], [11, 'review_notes'], [12, 'review_reason'], [13, 'quality_flags'], [14, 'selected_master_quality_issues'], [15, 'candidate_targets'], [16, 'manual_jst_sku'], [17, 'historical_correction_reason'], [18, 'manual_jushuitan_conflict'], [19, 'batch_business_pending']]) {
        assert.equal(actual[i].cells[index], String(r[key]), `${file}:${r.candidate_id}:${key}`);
      }
    }
    for (const decision of plan.source_decisions.filter((x) => file === 'match-review.html' || x.source.source_system === 'bigseller')) {
      await page.locator('#search').fill(decision.source.external_sku_raw);
      const tr = page.locator(`tr[data-id="${decision.candidate_id}"]`);
      assert.equal(await tr.isVisible(), true, decision.candidate_id);
      assert.equal(await tr.getAttribute('data-state'), decision.decision === 'ignore' ? 'ignored' : 'manual_selected');
      assert.equal(await tr.locator('td').nth(10).textContent(), decision.decision);
      assert.equal(await tr.locator('td').nth(11).textContent(), decision.reason);
      assert.equal(await tr.locator('td').nth(6).textContent(), decision.decision === 'ignore' ? '' : decision.target_ice);
      if (decision.operation === 'version_reaffirmation') {
        assert.equal(await tr.locator('td').nth(19).textContent(), 'null');
        assert.ok(JSON.stringify(bundle.candidates.find((c) => c.candidate_id === decision.candidate_id).batch_version_confirmation).includes('升级普通版'));
      }
      await tr.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(logs, `${file}-${decision.candidate_id}.png`) });
      checked.push({ file, candidate_id: decision.candidate_id, visible: true, effective_decision: decision.decision });
    }
    await page.locator('#search').fill('');
    await page.locator('#state').selectOption('manual_selected');
    assert.equal(await page.locator('tbody tr:visible').count(), expected.filter((r) => r.review_state === 'manual_selected').length);
    checked.push({ file, all_dom_rows_compared: expected.length, active_filter_verified: true });
  }
  await visit(delivery, 'master-overview.html');
  assert.deepEqual(await page.locator('#master-data').evaluate((node) => JSON.parse(node.textContent)), masters);
  const masterRows = await page.locator('tbody tr').evaluateAll((trs) => trs.map((tr) => ({ row: Number(tr.dataset.masterRow), cells: [...tr.cells].map((cell) => cell.textContent) })));
  assert.equal(masterRows.length, 126);
  for (let i = 0; i < masters.length; i += 1) {
    assert.equal(masterRows[i].row, masters[i].row_index);
    assert.deepEqual(JSON.parse(masterRows[i].cells[4]), masters[i]);
  }
  for (const [row, code, selectedSpec] of [[25, 'WM0031', '20ml/支'], [83, 'WM0062', '20ml/支'], [92, 'WM0098', '120g/瓶'], [121, 'WM0130', '20ml/支']]) {
    const tr = page.locator(`tr[data-master-row="${row}"]`);
    const actual = JSON.parse(await tr.locator('td').nth(4).textContent());
    assert.equal(actual.ice_code, code); assert.equal(actual.spec, selectedSpec);
    assert.equal(actual.specification_resolution.status, 'closed_master_column_c');
    assert.equal(actual.specification_resolution.source_column, 'C');
    assert.equal(actual.specification_resolution.selected_spec, selectedSpec);
    await tr.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(logs, `master-${code}-column-C.png`) });
  }
  for (const [row, code] of [[62, 'WM0081'], [107, 'brush']]) {
    const tr = page.locator(`tr[data-master-row="${row}"]`);
    assert.equal(await tr.isVisible(), true);
    const actual = JSON.parse(await tr.locator('td').nth(4).textContent());
    assert.equal(actual.ice_code, code); assert.ok(actual.name_cn);
    assert.equal(actual.brush_preservation.status, 'pending_confirmation');
    assert.ok(actual.brush_preservation.future_requirement);
    await tr.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(logs, `master-brush-${code}-pending.png`) });
  }
  const price = JSON.parse(await page.locator('tr[data-master-row="66"] td').nth(4).textContent());
  assert.equal(price.data['成本价格'], '5.18'); assert.equal(price.data['运营价格'], '5.68');
  assert.equal(price.price_pending, false); assert.equal(price.current_price_selection.source_row, 216);
  assert.deepEqual(price.price_versions.map((x) => [x.cost, x.operating_price]), [['5', '5.5'], ['5.18', '5.68']]);
  for (const code of ['WM0070', 'WM0072']) {
    const actual = masters.find((x) => x.ice_code === code);
    assert.equal(actual.bs_creation_status.status, 'user_confirmed_not_created');
  }
  checked.push({ file: 'master-overview.html', all_dom_rows_compared: 126, four_column_C_resolutions_visible: true, two_distinct_brushes_pending_visible: true, wm72_price_history_and_bs_creation_notes_preserved: true });

  await visit(coverage, 'product-coverage.json');
  assert.deepEqual(JSON.parse(await page.locator('body').textContent()), coverageRows);
  for (const row of [62, 107]) assert.ok(coverageRows.find((x) => x.master_anchor_row === row));
  assert.equal(coverageRows.length, 126);
  checked.push({ file: 'product-coverage.json', actual_browser_records_compared: 126 });
  await visit(coverage, 'audit-questions.json');
  assert.deepEqual(JSON.parse(await page.locator('body').textContent()), questions);
  assert.equal(questions.length, 7); assert.ok(questions.every((q) => q.status.startsWith('closed')));
  checked.push({ file: 'audit-questions.json', historical_questions_retained: 7, currently_closed: 7 });
  await visit(coverage, 'coverage-report.zh.md');
  const text = await page.locator('body').textContent();
  assert.ok(text.includes('548') && text.includes('114'));
  const confirmedVersionExplanation = '菲越三条WM0012已由用户确认升级款：菲律宾新创启辰376行、PH彩妆仓380行、越南526行6974674957349均维持主库19行WM0012。本项已解除版本待决，仅确认已有目标的版本，不增加有效选择；此前待决及只读调查原结论保留在previous_audit_question和业务历史。';
  assert.ok(text.includes(confirmedVersionExplanation), 'report must state all three exact source rows, unchanged WM0012 target, resolved version issue, no added selection, and retained history');
  assert.match(text, /图片内容.*未核验|图片内容.*尚未核验/);
  assert.ok(text.includes('brush') && text.includes('WM0081'));
  assert.ok(text.includes('关闭'));
  await page.screenshot({ path: path.join(logs, 'coverage-closed-audits-brush-image-note.png') });
  checked.push({ file: 'coverage-report.zh.md', actual_text_read: true, explicit_decisions_and_deferrals_explained: true });
  assert.deepEqual(errors, []); assert.deepEqual(requests, []);
  const result = { status: 'verified', distinct_local_files_visited: 6, checked, pageErrors: errors, remoteRequests: requests, exit_code: 0 };
  fs.writeFileSync(path.join(logs, 'browser-report.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
} finally { await browser.close(); }
