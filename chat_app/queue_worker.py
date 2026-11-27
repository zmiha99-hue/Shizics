from __future__ import annotations

from typing import Callable

from chat_app.models import DeliveryResult, DraftReply
from twitch_client.audit_log import AuditLogger


class OutboundQueue:
    """Manages prepared drafts, manual approval, delivery checks, and cancellation."""

    def __init__(self, audit: AuditLogger) -> None:
        self._audit = audit
        self._drafts: list[DraftReply] = []

    def enqueue_draft(self, draft: DraftReply) -> DraftReply:
        self._drafts.append(draft)
        self._audit.log(
            "draft_created",
            draft_id=draft.draft_id,
            bot_id=draft.bot_id,
            trigger_message_id=draft.trigger_message_id,
            text=draft.text,
        )
        return draft

    def get_draft(self, draft_id: str) -> DraftReply | None:
        for item in self._drafts:
            if item.draft_id == draft_id:
                return item
        return None

    def list_drafts(self) -> list[DraftReply]:
        return list(self._drafts)

    def approve_and_send(
        self,
        draft_id: str,
        send_fn: Callable[[DraftReply], DeliveryResult],
        edited_text: str | None = None,
    ) -> DraftReply:
        draft = self.get_draft(draft_id)
        if draft is None:
            raise KeyError(f"Draft '{draft_id}' not found")
        if draft.status != "pending_approval":
            raise ValueError(f"Draft '{draft_id}' cannot be sent from status '{draft.status}'")

        if edited_text is not None and edited_text.strip():
            draft.text = edited_text.strip()

        draft.status = "approved"
        self._audit.log(
            "outbound_send_attempt",
            draft_id=draft.draft_id,
            bot_id=draft.bot_id,
            text=draft.text,
        )

        result = send_fn(draft)
        draft.delivery = result

        if result.is_sent:
            draft.status = "sent"
            self._audit.log(
                "outbound_sent",
                draft_id=draft.draft_id,
                message_id=result.message_id,
                status_code=result.status_code,
                rate_limit_remaining=result.rate_limit_remaining,
            )
        else:
            draft.status = "failed"
            self._audit.log(
                "outbound_failed",
                draft_id=draft.draft_id,
                status_code=result.status_code,
                drop_reason=result.drop_reason,
                error=result.error,
            )
        return draft

    def reject_draft(self, draft_id: str) -> DraftReply:
        draft = self.get_draft(draft_id)
        if draft is None:
            raise KeyError(f"Draft '{draft_id}' not found")
        if draft.status in ("pending_approval", "approved"):
            draft.status = "cancelled"
            self._audit.log("draft_cancelled", draft_id=draft.draft_id)
        return draft

    def cancel_pending(self) -> int:
        """Cancel all pending/approved items; never alter already-sent or failed items."""
        cancelled_count = 0
        for draft in self._drafts:
            if draft.status in ("pending_approval", "approved"):
                draft.status = "cancelled"
                cancelled_count += 1
        if cancelled_count:
            self._audit.log("pending_drafts_cancelled", count=cancelled_count)
        return cancelled_count
