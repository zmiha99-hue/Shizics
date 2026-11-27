from __future__ import annotations

import uuid
from pathlib import Path

from chat_app.models import ConnectionState, DeliveryResult, DraftReply
from twitch_client.helix import TwitchAPIError, get_user_by_login, send_chat_message
from twitch_client.oauth import TokenBundle, load_token_bundle


class LocalChatAdapter:
    """In-memory local test adapter for Stage 2 without external network calls."""

    def __init__(self, channel: str = "local_test_channel", sender: str = "local_ai_bot") -> None:
        self.state = ConnectionState(
            mode="local",
            status="connected",
            target_channel=channel,
            authorized_sender=sender,
        )

    def send_message(self, draft: DraftReply) -> DeliveryResult:
        return DeliveryResult(
            message_id=f"local_msg_{uuid.uuid4().hex[:10]}",
            is_sent=True,
            drop_reason=None,
            status_code=200,
        )


class TwitchAdapter:
    """Adapter wrapping existing twitch_client modules for official Twitch API calls."""

    def __init__(
        self,
        token_path: str | Path = Path(".secrets/twitch_account.json"),
        target_channel: str = "",
        client_id: str = "",
    ) -> None:
        self.token_path = Path(token_path)
        self.client_id = client_id
        self.target_channel = target_channel.lstrip("#").lower()
        self.broadcaster_id: str = ""
        self.state = ConnectionState(
            mode="twitch",
            status="disconnected",
            target_channel=self.target_channel or "(not set)",
            authorized_sender="(not authorized)",
        )
        self._refresh_local_token_metadata()

    def _refresh_local_token_metadata(self) -> TokenBundle | None:
        if not self.token_path.exists():
            self.state.authorized_sender = "(not authorized)"
            return None
        bundle = load_token_bundle(self.token_path)
        self.state.authorized_sender = f"{bundle.login} ({bundle.user_id})"
        return bundle

    def send_message(self, draft: DraftReply) -> DeliveryResult:
        bundle = self._refresh_local_token_metadata()
        if bundle is None:
            return DeliveryResult(
                is_sent=False,
                error="No authorized Twitch token found. Run twitch_client.cli auth first.",
            )
        if not self.client_id or not self.target_channel:
            return DeliveryResult(
                is_sent=False,
                error="Twitch client_id and target_channel must be configured.",
            )
        try:
            if not self.broadcaster_id:
                user = get_user_by_login(self.client_id, bundle.access_token, self.target_channel)
                self.broadcaster_id = str(user["id"])
            res = send_chat_message(
                client_id=self.client_id,
                access_token=bundle.access_token,
                broadcaster_id=self.broadcaster_id,
                sender_id=bundle.user_id,
                message=draft.text,
            )
            return DeliveryResult(
                message_id=res.message_id,
                is_sent=res.is_sent,
                drop_reason=res.drop_reason,
                status_code=res.status_code,
                rate_limit_remaining=res.rate_limit_remaining,
            )
        except TwitchAPIError as exc:
            self.state.last_error = str(exc)
            return DeliveryResult(
                is_sent=False,
                status_code=exc.status_code,
                rate_limit_remaining=exc.rate_limit_remaining,
                error=str(exc),
            )
