"""Totals of current sample selections, grouped by original Excel row."""
from collections import defaultdict

from .review_exports import review_records, write_csv


def export_matched_total(outcome, detail_csv, summary_csv):
    rows = [r for r in review_records(outcome) if r['review_state'] == 'manual_selected']
    groups = defaultdict(list)
    for r in rows:
        groups[r['master_row_index']].append(r)
    totals = [{'master_row_index': idx, 'master_ice_code': rs[0]['master_ice_code'],
               'selected_source_rows': len(rs), 'candidate_ids': ';'.join(r['candidate_id'] for r in rs)}
              for idx, rs in sorted(groups.items())]
    detail_csv.parent.mkdir(parents=True, exist_ok=True)
    summary_csv.parent.mkdir(parents=True, exist_ok=True)
    write_csv(detail_csv, rows)
    write_csv(summary_csv, totals)
    return {'manual_selected': len(rows), 'master_rows_with_selection': len(totals)}
