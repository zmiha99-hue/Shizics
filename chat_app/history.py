from __future__ import annotations

from collections import deque

from chat_app.models import AdapterMode, ChatMessage, ParticipantRole


class MessageHistory:
    """Bounded shared chat history with message_id deduplication and role classification."""

    def __init__(
        self,
        max_messages: int = 200,
        controller_logins: set[str] | None = None,
        app_bot_logins: set[str] | None = None,
    ) -> None:
        self._max_messages = max_messages
        self._messages: deque[ChatMessage] = deque(maxlen=max_messages)
        self._seen_ids: set[str] = set()
        self._seen_order: deque[str] = deque(maxlen=max(max_messages * 4, 1000))
        self.controller_logins: set[str] = {c.lower() for c in (controller_logins or {"owner"})}
        self.app_bot_logins: set[str] = {b.lower() for b in (app_bot_logins or {"local_ai_bot"})}

    def classify_role(self, sender_login: str) -> ParticipantRole:
        normalized = sender_login.strip().lower()
        if normalized in self.app_bot_logins:
            return "app_bot"
        if normalized in self.controller_logins:
            return "controller_human"
        return "other"

    def add_message(
        self,
        message_id: str,
        sender_id: str,
        sender_login: str,
        text: str,
        source: AdapterMode,
        timestamp: str | None = None,
    ) -> ChatMessage | None:
        """Add message if message_id has not been seen; returns None for duplicates."""
        if message_id in self._seen_ids:
            return None

        if len(self._seen_order) == self._seen_order.maxlen:
            oldest = self._seen_order[0]
            self._seen_ids.discard(oldest)

        self._seen_ids.add(message_id)
        self._seen_order.append(message_id)

        role = self.classify_role(sender_login)
        msg = ChatMessage(
            message_id=message_id,
            sender_id=sender_id,
            sender_login=sender_login,
            text=text,
            role=role,
            source=source,
            **({"timestamp": timestamp} if timestamp else {}),
        )
        self._messages.append(msg)
        return msg

    def recent(self, limit: int = 10) -> list[ChatMessage]:
        if limit <= 0:
            return []
        items = list(self._messages)
        return items[-limit:]

    def all_messages(self) -> list[ChatMessage]:
        return list(self._messages)
