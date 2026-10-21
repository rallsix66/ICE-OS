from dataclasses import dataclass, field, asdict
from typing import Any


@dataclass
class MasterRow:
    row_index: int
    ice_code: str
    barcode: str
    name_cn: str
    spec: str

    def to_public(self) -> dict[str, Any]:
        return {
            'row_index': self.row_index,
            'ice_code': self.ice_code,
            'barcode': self.barcode,
            'name_cn': self.name_cn,
            'spec': self.spec,
        }


@dataclass
class MasterQualityIssue:
    issue_type: str
    key: str
    row_indices: list[int]
    detail: str

    def to_public(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class SourceRow:
    source_system: str
    source_row_key: str
    scope: str
    warehouse: str | None
    external_sku_raw: str
    external_name: str
    sheet_name: str | None = None
    gtin_raw: str | None = None
    available_qty: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    def to_public(self) -> dict[str, Any]:
        return {
            'source_system': self.source_system,
            'source_row_key': self.source_row_key,
            'scope': self.scope,
            'warehouse': self.warehouse,
            'external_sku_raw': self.external_sku_raw,
            'external_name': self.external_name,
            'sheet_name': self.sheet_name,
            'gtin_raw': self.gtin_raw,
            'available_qty': self.available_qty,
            'extra': self.extra,
        }


@dataclass
class MatchCandidate:
    candidate_id: str
    source: SourceRow
    lifecycle: str
    match_methods: list[str]
    master_matches: list[MasterRow]
    flags: list[str]
    auto_confirm_forbidden: bool
    notes: str = ''

    def to_public(self) -> dict[str, Any]:
        return {
            'candidate_id': self.candidate_id,
            'source': self.source.to_public(),
            'lifecycle': self.lifecycle,
            'match_methods': self.match_methods,
            'master_matches': [m.to_public() for m in self.master_matches],
            'flags': sorted(set(self.flags)),
            'auto_confirm_forbidden': self.auto_confirm_forbidden,
            'notes': self.notes,
            'review_decision': None,
            'review_notes': None,
        }
