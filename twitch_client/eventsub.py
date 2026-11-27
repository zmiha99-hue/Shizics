from __future__ import annotations

import asyncio
import json
from typing import Any, Callable

from twitch_client.audit_log import AuditLogger
from twitch_client.helix import TwitchAPIError, create_chat_message_subscription

EVENTSUB_WS_URL = "wss://eventsub.wss.twitch.tv/ws"


async def listen_chat_eventsub(
    client_id: str,
    access_token: str,
    broadcaster_user_id: str,
    user_id: str,
    audit: AuditLogger,
    duration_sec: float = 30.0,
    on_message: Callable[[dict[str, Any]], None] | None = None,
    ws_url: str = EVENTSUB_WS_URL,
) -> None:
    """Connect to Twitch EventSub WebSocket and listen for channel.chat.message."""
    try:
        import websockets
    except ImportError as exc:
        raise RuntimeError(
            "The 'websockets' package is required for EventSub listening. "
            "Install it with: pip install -r requirements.txt"
        ) from exc

    current_url = ws_url
    deadline = asyncio.get_running_loop().time() + duration_sec
    subscribed_session: str | None = None

    while asyncio.get_running_loop().time() < deadline:
        async with websockets.connect(current_url) as ws:
            reconnect_requested = False
            while asyncio.get_running_loop().time() < deadline:
                remaining = max(0.1, deadline - asyncio.get_running_loop().time())
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
                except asyncio.TimeoutError:
                    audit.log("eventsub_stopped", reason="duration_elapsed")
                    return

                msg = json.loads(raw)
                meta = msg.get("metadata", {})
                msg_type = meta.get("message_type")
                payload = msg.get("payload", {})

                if msg_type == "session_welcome":
                    session = payload.get("session", {})
                    session_id = str(session.get("id", ""))
                    audit.log("eventsub_connected", session_id=session_id)
                    if session_id != subscribed_session:
                        try:
                            sub_resp = create_chat_message_subscription(
                                client_id=client_id,
                                access_token=access_token,
                                session_id=session_id,
                                broadcaster_user_id=broadcaster_user_id,
                                user_id=user_id,
                            )
                            subscribed_session = session_id
                            sub_data = (sub_resp.get("data") or [{}])[0]
                            audit.log(
                                "eventsub_subscribed",
                                subscription_id=sub_data.get("id"),
                                status=sub_data.get("status"),
                                broadcaster_user_id=broadcaster_user_id,
                            )
                        except TwitchAPIError as exc:
                            audit.log(
                                "stopped_on_error",
                                stage="eventsub_subscribe",
                                status_code=exc.status_code,
                                error=str(exc),
                            )
                            raise

                elif msg_type == "notification":
                    event = payload.get("event", {})
                    record = audit.log(
                        "chat_message_received",
                        message_id=event.get("message_id"),
                        chatter_user_id=event.get("chatter_user_id"),
                        chatter_user_login=event.get("chatter_user_login"),
                        text=(event.get("message") or {}).get("text", ""),
                    )
                    if on_message is not None:
                        on_message(record)

                elif msg_type == "session_reconnect":
                    reconnect_url = (payload.get("session") or {}).get("reconnect_url")
                    if reconnect_url:
                        current_url = reconnect_url
                        audit.log("eventsub_reconnect_requested")
                        reconnect_requested = True
                        break

                elif msg_type == "revocation":
                    sub = payload.get("subscription", {})
                    audit.log(
                        "stopped_on_error",
                        stage="eventsub_revocation",
                        status=sub.get("status"),
                    )
                    return

            if not reconnect_requested:
                break
