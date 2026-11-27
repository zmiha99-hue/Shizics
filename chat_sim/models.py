from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass(frozen=True)
class Participant:
    """Virtual chat participant."""

    participant_id: str
    username: str
    role: str = "regular"


@dataclass(frozen=True)
class ChatEvent:
    """Single simulated chat message event."""

    timestamp: str
    offset_sec: float
    scenario: str
    participant_id: str
    username: str
    text: str
    burst_id: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        """Serialize event to a JSON-compatible dictionary."""
        return asdict(self)


@dataclass(frozen=True)
class ScenarioConfig:
    """Configuration for generating a chat event stream."""

    name: str
    duration_sec: float = 60.0
    participant_count: int = 20
    seed: int = 42
    base_rate_per_min: float = 12.0
    repeat_phrases: tuple[str, ...] = (
        "GG!",
        "Привет всем!",
        "Топ контент",
        "Поддерживаю!",
    )
    burst_window_sec: float = 1.5
    burst_size: int = 10
