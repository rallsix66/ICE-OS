"""P0-02 PostgreSQL 读网关 DTO：JSON/CLI 兼容的自有快照类型。"""
from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Any


def to_gateway_scalar(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Decimal):
        if value == value.to_integral_value():
            return int(value)
        return float(value)
    if isinstance(value, bytes):
        return value.decode('utf-8', errors='replace')
    return value


def row_to_gateway_dto(row: dict[str, Any]) -> dict[str, Any]:
    return {key: to_gateway_scalar(val) for key, val in row.items()}


def rows_to_gateway_dtos(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [row_to_gateway_dto(row) for row in rows]
