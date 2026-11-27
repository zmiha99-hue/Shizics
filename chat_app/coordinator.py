from __future__ import annotations

import time
import uuid
from typing import Callable

from chat_app.history import MessageHistory
from chat_app.llm import LLMClient
from chat_app.models import BotProfile, ChatMessage, DraftReply, RunState


class Coordinator:
    """Decides whether to generate a contextual draft reply and which bot owns it."""

    def __init__(
        self,
        history: MessageHistory,
        llm_client: LLMClient,
        profiles: list[BotProfile],
        clock_fn: Callable[[], float] = time.monotonic,
    ) -> None:
        self.history = history
        self.llm_client = llm_client
        self.profiles = profiles
        self._clock_fn = clock_fn
        self._last_reply_at: dict[str, float] = {}

    def maybe_prepare_draft(
        self,
        message: ChatMessage,
        run_state: RunState,
    ) -> DraftReply | None:
        """Evaluate an incoming message and optionally create a DraftReply."""
        if run_state != "running":
            return None

        # Prevent infinite loops and restrict initial reactions to the controller human.
        if message.role != "controller_human":
            return None

        if not message.text.strip():
            return None

        active_profiles = [p for p in self.profiles if p.enabled]
        if not active_profiles:
            return None

        profile = active_profiles[0]
        now = self._clock_fn()
        last_ts = self._last_reply_at.get(profile.bot_id)
        if last_ts is not None and (now - last_ts) < profile.min_reply_interval_sec:
            return None

        context = self.history.recent(profile.context_window)
        llm_resp = self.llm_client.generate_reply(
            profile=profile,
            context_messages=context,
            trigger_message=message,
        )
        self._last_reply_at[profile.bot_id] = now

        return DraftReply(
            draft_id=f"draft_{uuid.uuid4().hex[:10]}",
            bot_id=profile.bot_id,
            bot_name=profile.display_name,
            trigger_message_id=message.message_id,
            trigger_sender=message.sender_login,
            text=llm_resp.text[: profile.max_reply_chars],
            status="pending_approval",
        )
