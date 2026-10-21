"""主商品库内部质量：重复货号、重复条码、规格冲突。"""
from __future__ import annotations

from collections import defaultdict

from .models import MasterQualityIssue, MasterRow


def analyze_master_quality(master_rows: list[MasterRow]) -> list[MasterQualityIssue]:
    issues: list[MasterQualityIssue] = []

    by_ice: dict[str, list[int]] = defaultdict(list)
    by_barcode: dict[str, list[int]] = defaultdict(list)
    specs_by_ice: dict[str, set[str]] = defaultdict(set)

    for row in master_rows:
        if row.ice_code:
            by_ice[row.ice_code].append(row.row_index)
            if row.spec:
                specs_by_ice[row.ice_code].add(row.spec)
        if row.barcode:
            by_barcode[row.barcode].append(row.row_index)

    for ice, indices in sorted(by_ice.items()):
        if len(indices) > 1:
            issues.append(
                MasterQualityIssue(
                    issue_type='DUPLICATE_ICE_CODE',
                    key=ice,
                    row_indices=sorted(indices),
                    detail='主资料聚水潭内部货号重复',
                )
            )
        specs = specs_by_ice.get(ice, set())
        if len(specs) > 1:
            issues.append(
                MasterQualityIssue(
                    issue_type='SPEC_CONFLICT',
                    key=ice,
                    row_indices=sorted(indices),
                    detail=f'同一货号规格不一致: {sorted(specs)!r}',
                )
            )

    for barcode, indices in sorted(by_barcode.items()):
        if len(indices) > 1:
            issues.append(
                MasterQualityIssue(
                    issue_type='DUPLICATE_BARCODE',
                    key=barcode,
                    row_indices=sorted(indices),
                    detail='主资料匹配条码重复',
                )
            )

    return issues
