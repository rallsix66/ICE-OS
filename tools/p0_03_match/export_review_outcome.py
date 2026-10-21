"""CSV projection of validated sample review records."""
from .review_exports import review_records, write_csv


def export_review_outcome_csv(outcome, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    write_csv(path, review_records(outcome))
