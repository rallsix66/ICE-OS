"""Compatibility entry points for the validated local sample-review page."""
from pathlib import Path

from .review_exports import export_effective_html
from .review_result import MANUAL_FIELDS, read_decisions


def _bigseller_warehouses(bundle):
    return sorted({c['source']['warehouse'] for c in bundle.get('candidates', [])
                   if c.get('source', {}).get('source_system') == 'bigseller'
                   and c['source'].get('warehouse')})


def _default_desktop_review_paths():
    return []


def _merge_review_csv_row(out, row):
    cid = (row.get('candidate_id') or '').strip()
    if cid:
        out[cid] = {'decision': (row.get('review_decision') or '').strip(),
                    'notes': row.get('review_notes') or '',
                    **{k: row.get(k) or '' for k in MANUAL_FIELDS}}


def load_embedded_reviews(*paths: Path):
    if len(paths) != 1:
        raise ValueError('Exactly one explicit decision CSV is required')
    out = {}
    for row in read_decisions(paths[0]).values():
        _merge_review_csv_row(out, row)
    return out


def export_review_html(bundle, path, title=None, manifest=None, evidence_dir=None):
    if not bundle.get('review_schema'):
        raise ValueError('Validate legacy results with rework first')
    export_effective_html(bundle, path)

