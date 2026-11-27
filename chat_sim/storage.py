from __future__ import annotations

import json
from pathlib import Path

from chat_sim.models import ChatEvent


def save_events_jsonl(events: list[ChatEvent], output_path: str | Path) -> Path:
    """Write chat events to a JSONL file, one JSON object per line."""
    path = Path(output_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        for event in events:
            fh.write(json.dumps(event.to_dict(), ensure_ascii=False) + "\n")
    return path


def load_events_jsonl(input_path: str | Path) -> list[ChatEvent]:
    """Read chat events from a JSONL file."""
    path = Path(input_path)
    events: list[ChatEvent] = []
    with path.open("r", encoding="utf-8") as fh:
        for line in fh:
            stripped = line.strip()
            if not stripped:
                continue
            raw = json.loads(stripped)
            events.append(
                ChatEvent(
                    timestamp=raw["timestamp"],
                    offset_sec=raw["offset_sec"],
                    scenario=raw["scenario"],
                    participant_id=raw["participant_id"],
                    username=raw["username"],
                    text=raw["text"],
                    burst_id=raw.get("burst_id"),
                    metadata=raw.get("metadata", {}),
                )
            )
    return events
