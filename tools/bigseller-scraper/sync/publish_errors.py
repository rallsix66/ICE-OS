"""Structured publish commit errors for bridge/Node propagation."""
from __future__ import annotations

from typing import Any


class PublishCommitUnknownError(RuntimeError):
    """Publish transaction outcome is unknown; carries executor result for bridge mapping."""

    def __init__(self, message: str, *, rpc_result: dict[str, Any]) -> None:
        super().__init__(message)
        self.rpc_result = dict(rpc_result)
