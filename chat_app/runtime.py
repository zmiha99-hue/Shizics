from __future__ import annotations

import threading
import uuid
from pathlib import Path
from typing import Any

from chat_app.adapters import LocalChatAdapter
from chat_app.coordinator import Coordinator
from chat_app.history import MessageHistory
from chat_app.llm import StubLLMClient
from chat_app.models import BotProfile, ChatMessage, DraftReply, RunState
from chat_app.queue_worker import OutboundQueue
from twitch_client.audit_log import AuditLogger


class ChatAppRuntime:
    """Thread-safe application state and orchestration for the local/Twitch chat panel."""

    def __init__(
        self,
        log_path: str | Path = Path("logs/chat_app.jsonl"),
        controller_login: str = "owner",
    ) -> None:
        self._lock = threading.RLock()
        self.audit = AuditLogger(log_path)
        self.run_state: RunState = "running"
        self.auto_send: bool = False  # Always disabled by default until manual verification
        self.adapter = LocalChatAdapter(channel="local_test_channel", sender="local_ai_bot")
        self.profile = BotProfile(
            bot_id="bot_01",
            display_name="LocalAI_01",
        )
        self.history = MessageHistory(
            max_messages=200,
            controller_logins={controller_login},
            app_bot_logins={"local_ai_bot", self.profile.display_name.lower()},
        )
        self.llm = StubLLMClient()
        self.coordinator = Coordinator(
            history=self.history,
            llm_client=self.llm,
            profiles=[self.profile],
        )
        self.queue = OutboundQueue(self.audit)

    def set_control(self, action: str) -> RunState:
        with self._lock:
            if action == "start":
                self.run_state = "running"
                self.audit.log("app_started")
            elif action == "pause":
                self.run_state = "paused"
                self.audit.log("app_paused")
            elif action == "stop":
                self.run_state = "stopped"
                cancelled = self.queue.cancel_pending()
                self.audit.log("app_stopped", cancelled_pending=cancelled)
            else:
                raise ValueError(f"Unknown control action: {action}")
            return self.run_state

    def update_profile(self, updates: dict[str, Any]) -> BotProfile:
        with self._lock:
            if "display_name" in updates and str(updates["display_name"]).strip():
                self.profile.display_name = str(updates["display_name"]).strip()
                self.history.app_bot_logins.add(self.profile.display_name.lower())
            if "persona_prompt" in updates:
                self.profile.persona_prompt = str(updates["persona_prompt"])
            if "context_window" in updates:
                self.profile.context_window = max(1, min(50, int(updates["context_window"])))
            if "min_reply_interval_sec" in updates:
                self.profile.min_reply_interval_sec = max(0.0, float(updates["min_reply_interval_sec"]))
            if "max_reply_chars" in updates:
                self.profile.max_reply_chars = max(20, min(500, int(updates["max_reply_chars"])))
            if "enabled" in updates:
                self.profile.enabled = bool(updates["enabled"])
            self.audit.log("profile_updated", **self.profile.to_dict())
            return self.profile

    def ingest_local_message(
        self,
        sender_login: str,
        text: str,
        message_id: str | None = None,
    ) -> dict[str, Any]:
        with self._lock:
            msg_id = message_id or f"local_in_{uuid.uuid4().hex[:10]}"
            msg = self.history.add_message(
                message_id=msg_id,
                sender_id=f"user_{sender_login.lower()}",
                sender_login=sender_login,
                text=text,
                source="local",
            )
            if msg is None:
                return {"duplicate": True, "message": None, "draft": None}

            self.audit.log(
                "message_received",
                message_id=msg.message_id,
                sender_login=msg.sender_login,
                role=msg.role,
                source=msg.source,
                text=msg.text,
            )

            draft = self.coordinator.maybe_prepare_draft(msg, self.run_state)
            if draft is not None:
                self.queue.enqueue_draft(draft)

            return {
                "duplicate": False,
                "message": msg.to_dict(),
                "draft": draft.to_dict() if draft else None,
            }

    def approve_draft(self, draft_id: str, edited_text: str | None = None) -> DraftReply:
        with self._lock:
            draft = self.queue.approve_and_send(
                draft_id=draft_id,
                send_fn=self.adapter.send_message,
                edited_text=edited_text,
            )
            if draft.status == "sent" and draft.delivery is not None:
                self.history.add_message(
                    message_id=draft.delivery.message_id,
                    sender_id=draft.bot_id,
                    sender_login=self.adapter.state.authorized_sender,
                    text=draft.text,
                    source=self.adapter.state.mode,
                )
            return draft

    def reject_draft(self, draft_id: str) -> DraftReply:
        with self._lock:
            return self.queue.reject_draft(draft_id)

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "run_state": self.run_state,
                "auto_send": self.auto_send,
                "connection": self.adapter.state.to_dict(),
                "profile": self.profile.to_dict(),
                "llm_stats": self.llm.stats(),
                "messages": [m.to_dict() for m in self.history.recent(50)],
                "drafts": [d.to_dict() for d in self.queue.list_drafts()[-20:]],
            }
