from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any, Literal

ParticipantRole = Literal["controller_human", "app_bot", "other"]
RunState = Literal["stopped", "running", "paused"]
DraftStatus = Literal["pending_approval", "approved", "sent", "failed", "cancelled"]
AdapterMode = Literal["local", "twitch"]


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass(frozen=True)
class ChatMessage:
    """Normalized incoming or sent chat message."""

    message_id: str
    sender_id: str
    sender_login: str
    text: str
    role: ParticipantRole
    source: AdapterMode
    timestamp: str = field(default_factory=utc_now_iso)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class BotProfile:
    """Configuration for an AI participant."""

    bot_id: str
    display_name: str
    persona_prompt: str = "Отвечай кратко, по делу и дружелюбно на русском языке."
    context_window: int = 10
    min_reply_interval_sec: float = 3.0
    max_reply_chars: int = 220
    enabled: bool = True

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class DeliveryResult:
    """Outcome of attempting to send an approved message."""

    message_id: str = ""
    is_sent: bool = False
    drop_reason: dict[str, Any] | str | None = None
    status_code: int | None = None
    error: str | None = None
    rate_limit_remaining: int | None = None
    timestamp: str = field(default_factory=utc_now_iso)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class DraftReply:
    """Prepared reply awaiting approval or queued for delivery."""

    draft_id: str
    bot_id: str
    bot_name: str
    trigger_message_id: str
    trigger_sender: str
    text: str
    status: DraftStatus = "pending_approval"
    created_at: str = field(default_factory=utc_now_iso)
    delivery: DeliveryResult | None = None

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        return data


@dataclass
class ConnectionState:
    """Current adapter connection and Twitch target metadata."""

    mode: AdapterMode = "local"
    status: str = "disconnected"
    target_channel: str = "local_test_channel"
    authorized_sender: str = "local_ai_bot"
    last_error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
