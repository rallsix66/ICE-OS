import csv
import io
import json
import re
import tempfile
import unittest
from pathlib import Path

import pandas as pd

from p0_03_match import config as cfg
from p0_03_match.cli import main
from p0_03_match.export_bs_warehouse_overview import build_bs_warehouse_detail_rows
from p0_03_match.export_html import _default_desktop_review_paths, load_embedded_reviews
from p0_03_match.loaders import load_master
from p0_03_match.match_engine import build_match_bundle
from p0_03_match.models import MasterRow, SourceRow
from p0_03_match.review_exports import export_effective_outputs, review_records
from p0_03_match.review_result import MANUAL_FIELDS, read_decisions, resolve_reviews


MASTERS = [MasterRow(2, 'WM0001', '6900000000001', '资料', '1g'), MasterRow(5, 'WM0002', '6900000000002', '另一资料', '2g')]


def candidate(cid='bs', *, system='bigseller', matches=None, warehouse='菲律宾仓', sku='WM0001'):
    return {'candidate_id': cid, 'lifecycle': 'pending_review', 'flags': [],
            'master_matches': [MASTERS[0].to_public()] if matches is None else matches,
            'source': SourceRow(system, cid, 'match_only', warehouse, sku, '资料',
                                sheet_name=cfg.BIGSELLER_SHEET_SINGLE,
                                available_qty='1', extra={'style_code': sku, 'product_code': sku}).to_public()}


def raw(cid='bs', decision='confirm', **kw):
    return {'candidate_id': cid, 'review_decision': decision, 'review_notes': '人工原备注', **kw}


class ReviewRegressionTests(unittest.TestCase):
    def resolve(self, candidates=None, decisions=None, masters=MASTERS, history=()):
        return resolve_reviews({'candidates': candidates or [candidate()]}, decisions or {}, masters, history=history)

    def test_manual_target_persisted_with_original_source(self):
        r = raw(manual_master_row='5', manual_master_ice='WM0002')
        c = self.resolve([candidate(matches=[])], {'bs': r})['candidates'][0]
        self.assertEqual(c['selected_master'], MASTERS[1].to_public())
        self.assertEqual(c['decision_records'], [r])
        self.assertEqual(c['source']['warehouse'], '菲律宾仓')
        self.assertEqual(c['review_notes'], '人工原备注')

    def test_invalid_master_row_pending(self):
        c = self.resolve(decisions={'bs': raw(manual_master_row='85', manual_master_ice='WM0001')})['candidates'][0]
        self.assertIsNone(c['selected_master'])
        self.assertEqual(c['review_state'], 'pending')
        self.assertIn('manual_master_row_missing_or_invalid', c['validation_errors'])

    def test_mismatched_ice_pending(self):
        c = self.resolve(decisions={'bs': raw(manual_master_row='2', manual_master_ice='WM0002')})['candidates'][0]
        self.assertIsNone(c['selected_master'])
        self.assertIn('manual_ice_does_not_match_excel_row', c['validation_errors'])

    def test_blank_and_clear_replace_old_confirm(self):
        for decision in ('', 'clear'):
            old = candidate()
            old.update(review_decision='confirm', manual_master_row='2', manual_master_ice='WM0001', selected_master=MASTERS[0].to_public())
            c = self.resolve([old], {'bs': raw(decision=decision)})['candidates'][0]
            self.assertIsNone(c['selected_master'])
            self.assertEqual(c['manual_master_row'], '')
            self.assertNotEqual(c['review_state'], 'manual_selected')
            self.assertEqual(c['previous_review']['review_decision'], 'confirm')

    def test_clear_with_target_fields_still_clears(self):
        c = self.resolve(decisions={'bs': raw(decision='clear', manual_master_row='2', manual_master_ice='WM0001')})['candidates'][0]
        self.assertIsNone(c['selected_master'])
        self.assertEqual(c['review_reason'], 'cleared')

    def test_reject_ignore_defer_never_active(self):
        for d, state in [('reject', 'rejected'), ('ignore', 'ignored'), ('defer', 'pending')]:
            c = self.resolve(decisions={'bs': raw(decision=d, manual_master_row='2', manual_master_ice='WM0001')})['candidates'][0]
            self.assertIsNone(c['selected_master'])
            self.assertEqual(c['review_state'], state)

    def test_multiple_candidates_never_first(self):
        c = candidate(matches=[m.to_public() for m in MASTERS])
        b = self.resolve([c], {'bs': raw()})
        self.assertIsNone(b['candidates'][0]['selected_master'])
        self.assertEqual(build_bs_warehouse_detail_rows(b)[0]['masterIce'], '')
        # Also guard the legacy overview path.
        self.assertEqual(build_bs_warehouse_detail_rows({'candidates': [c]})[0]['masterIce'], '')

    def test_explicit_row_resolves_multiple_without_hiding_conflict(self):
        c = candidate(matches=[m.to_public() for m in MASTERS])
        c['flags'] = ['ONE_TO_MANY', 'MASTER_SPEC_CONFLICT']
        out = self.resolve([c], {'bs': raw(manual_master_row='5', manual_master_ice='WM0002')})['candidates'][0]
        self.assertEqual(out['selected_master']['row_index'], 5)
        self.assertIn('MASTER_SPEC_CONFLICT', out['retained_quality_flags'])
        self.assertNotIn('formal_mapping_eligible', out)

    def test_unique_market_wrong_hit_removed(self):
        m = MasterRow(28, 'WM0093', 'ICEWM0039', '泰国特供版', '')
        s = SourceRow('bigseller', 's1', 'match_only', '菲律宾-新创启辰自建仓', 'ICEWM0039', '', sheet_name=cfg.BIGSELLER_SHEET_SINGLE)
        c = build_match_bundle([m], [s])['candidates'][0]
        self.assertEqual(c['master_matches'], [])
        self.assertIn('BATCH_MARKET_REJECTED', c['flags'])

    def test_alias_market_guard(self):
        m = MasterRow(2, 'WM0117', '', '泰文版', '')
        s = SourceRow('bigseller', 's1', 'match_only', '越南青林湾仓库', 'KP0001', '', sheet_name=cfg.BIGSELLER_SHEET_SINGLE)
        c = build_match_bundle([m], [s])['candidates'][0]
        self.assertEqual(c['master_matches'], [])

    def test_manual_market_guard(self):
        masters = [MasterRow(28, 'WM0093', 'ICEWM0039', '泰国特供版', '')]
        c = self.resolve(decisions={'bs': raw(manual_master_row='28', manual_master_ice='WM0093')}, masters=masters)['candidates'][0]
        self.assertIsNone(c['selected_master'])
        self.assertTrue(c['validation_errors'])

    def test_wrong_link_correction_audit_and_no_replacement(self):
        c = candidate(warehouse='菲律宾-新创启辰自建仓', sku='ICEWM0039')
        c['previous_master_matches'] = [MasterRow(28, 'WM0093', '', '泰国特供版', '').to_public()]
        b = self.resolve([c], {'bs': raw()})
        self.assertEqual(b['candidates'][0]['review_state'], 'pending')
        self.assertIsNone(b['candidates'][0]['selected_master'])
        self.assertEqual(b['correction_events'][0]['original_decision'][0]['review_decision'], 'confirm')
        self.assertIsNone(b['correction_events'][0]['replacement'])

    def test_stale_jst_id_exact_business_identity_only(self):
        old = candidate('old-jst', system='jushuitan', warehouse=None)
        now = candidate('now-jst', system='jushuitan', warehouse=None)
        r = raw(manual_master_row='2', manual_master_ice='WM0001', manual_jst_candidate_id='old-jst', manual_jst_sku='WM0001')
        b = self.resolve([candidate(), now], {'bs': r, 'now-jst': raw('now-jst', 'defer')}, history=[{'candidates': [old]}])
        self.assertEqual(b['candidates'][0]['selected_jushuitan']['candidate_id'], 'now-jst')
        self.assertEqual(b['candidates'][0]['manual_jst_candidate_id'], 'old-jst')
        self.assertEqual(b['candidates'][1]['review_reason'], 'deferred')
        self.assertIsNone(b['candidates'][1]['selected_master'])
        again = resolve_reviews(b, {'bs': r, 'now-jst': raw('now-jst', 'defer')}, MASTERS)
        self.assertEqual(again['candidates'][0]['selected_jushuitan']['candidate_id'], 'now-jst')
        self.assertEqual(again['candidates'][1]['review_reason'], 'deferred')

    def test_invalid_or_ambiguous_jst_not_completed(self):
        r = raw(manual_master_row='2', manual_master_ice='WM0001', manual_jst_candidate_id='gone', manual_jst_sku='WM0001')
        for sources, history in [([candidate()], []), ([candidate(), candidate('j1', system='jushuitan'), candidate('j2', system='jushuitan')], [{'candidates': [candidate('gone', system='jushuitan')]}])]:
            c = self.resolve(sources, {'bs': r}, history=history)['candidates'][0]
            self.assertEqual(c['review_state'], 'pending')
            self.assertIsNone(c['selected_master'])

    def test_no_implicit_desktop_merge_and_blank_overwrites(self):
        self.assertEqual(_default_desktop_review_paths(), [])
        with tempfile.TemporaryDirectory() as td:
            p = Path(td)/'d.csv'
            p.write_text('candidate_id,review_decision,manual_master_row\nbs,,\n', encoding='utf-8')
            self.assertEqual(load_embedded_reviews(p)['bs']['manual_master_row'], '')
            with self.assertRaises(ValueError):
                load_embedded_reviews(p, p)

    def test_duplicate_csv_and_illegal_decisions_fail(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td)/'d.csv'
            for data in ['bs,confirm\nbs,clear\n', 'bs,maybe\n']:
                p.write_text('candidate_id,review_decision\n'+data, encoding='utf-8')
                with self.assertRaises(ValueError):
                    read_decisions(p)

    def test_empty_master_rows_skipped_without_renumber(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td)/'master.xlsx'
            pd.DataFrame([{cfg.MASTER_COL_ICE: 'WM0001'}, {}, {cfg.MASTER_COL_ICE: 'WM0002'}]).to_excel(p, sheet_name='商品库', index=False)
            self.assertEqual([m.row_index for m in load_master(p)], [2, 4])

    def test_every_output_uses_same_effective_records(self):
        sources = [candidate(), candidate('amb', matches=[m.to_public() for m in MASTERS]), candidate('no', matches=[]), candidate('rej')]
        b = self.resolve(sources, {'bs': raw(), 'amb': raw('amb'), 'rej': raw('rej', 'reject')})
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            export_effective_outputs(b, root)
            expected = review_records(b)
            for filename in ('manual-review.csv', 'review-decisions-export.csv'):
                rows = list(csv.DictReader(io.StringIO((root/filename).read_text(encoding='utf-8-sig'))))
                self.assertEqual(rows, [{k: str(v) for k, v in r.items()} for r in expected])
            self.assertEqual(json.loads((root/'effective-review-records.json').read_text(encoding='utf-8')), expected)
            uni = json.loads((root/'unified-view.json').read_text(encoding='utf-8'))
            self.assertEqual(uni['review_records'], expected)
            self.assertEqual([x for row in uni['rows'] for x in row['candidateIds']], ['bs'])
            for filename in ('match-review.html', 'bs-warehouse-overview.html'):
                page = (root/filename).read_text(encoding='utf-8')
                payload = json.loads(re.search(r'<script id="review-data" type="application/json">(.*?)</script>', page, re.S)[1])
                self.assertEqual(payload['rows'], expected)
                self.assertNotIn('localStorage', page)
                self.assertEqual(re.findall(r'<tr data-id="([^"]+)"', page), [r['candidate_id'] for r in expected])
            detail = list(csv.DictReader(io.StringIO((root/'matched-total-detail.csv').read_text(encoding='utf-8-sig'))))
            self.assertEqual([r['candidate_id'] for r in detail], ['bs'])
            wh = list(csv.DictReader(io.StringIO((root/'bs-warehouse-overview.csv').read_text(encoding='utf-8-sig'))))[0]
            self.assertEqual(int(wh['source_rows']), len(expected))
            self.assertEqual(int(wh['manual_selected']), 1)

    def test_outside_rules_cannot_be_expanded_by_manual(self):
        c = candidate()
        c['lifecycle'] = 'outside_rules'
        out = self.resolve([c], {'bs': raw(manual_master_row='2', manual_master_ice='WM0001')})
        self.assertIsNone(out['candidates'][0]['selected_master'])
        self.assertEqual(out['candidates'][0]['review_state'], 'outside_rules')

    def test_existing_evidence_never_overwritten(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            original = root/'keep.txt'
            original.write_text('protected')
            with self.assertRaises(ValueError):
                main(['match', '--master', 'x', '--bigseller', 'x', '--jushuitan', 'x', '--output', str(root)])
            self.assertEqual(original.read_text(), 'protected')


if __name__ == '__main__':
    unittest.main()
