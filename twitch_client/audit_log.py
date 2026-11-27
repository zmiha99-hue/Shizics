from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

REDACTED_KEYS = frozenset(
    {
        "access_token",
        "refresh_token",
        "client_secret",
        "authorization",
        "token",
        "secret",
    }
)


def redact_dict(data: dict[str, Any]) -> dict[str, Any]:
    """Return a shallow/recursive copy of data with sensitive keys redacted."""
    cleaned: dict[str, Any] = {}
    for key, value in data.items():
        if key.lower() in REDACTED_KEYS:
            cleaned[key] = "[REDACTED]"
        elif isinstance(value, dict):
            cleaned[key] = redact_dict(value)
        else:
            cleaned[key] = value
    return cleaned


class AuditLogger:
    """Append-only JSONL logger that redacts secrets before writing."""

    def __init__(self, log_path: str | Path) -> None:
        self.log_path = Path(log_path)
        self.log_path.parent.mkdir(parents=True, exist_ok=True)

    def log(self, event_type: str, **fields: Any) -> dict[str, Any]:
        record = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "event_type": event_type,
            **redact_dict(fields),
        }
        with self.log_path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=False) + "\n")
        return record
