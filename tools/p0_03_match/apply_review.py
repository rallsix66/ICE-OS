"""Apply one explicit CSV snapshot, with validated master targets."""
from __future__ import annotations

import json
from pathlib import Path

from .models import MasterRow
from .review_result import ALLOWED_DECISIONS, read_decisions, resolve_reviews


def apply_review_csv(candidates_path: Path, review_csv: Path, out_path: Path, *, master_rows=None, history=()) -> dict:
    bundle = json.loads(candidates_path.read_text(encoding='utf-8'))
    if master_rows is None:
        master_rows = [MasterRow(**m) for m in bundle.get('master_rows', [])]
    if not master_rows:
        raise ValueError('Explicit master_rows snapshot required for target validation')
    outcome = resolve_reviews(bundle, read_decisions(review_csv), master_rows, history=history)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(outcome, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return outcome
