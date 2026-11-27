from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any

HELIX_BASE_URL = "https://api.twitch.tv/helix"


class TwitchAPIError(RuntimeError):
    """Raised on Twitch Helix HTTP errors, auth failures, or rate limits."""

    def __init__(
        self,
        message: str,
        status_code: int | None = None,
        rate_limit_remaining: int | None = None,
        rate_limit_reset: int | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.rate_limit_remaining = rate_limit_remaining
        self.rate_limit_reset = rate_limit_reset

    @property
    def is_auth_error(self) -> bool:
        return self.status_code in (401, 403)

    @property
    def is_rate_limited(self) -> bool:
        return self.status_code == 429 or self.rate_limit_remaining == 0


@dataclass(frozen=True)
class SendMessageResult:
    """Result of POST /helix/chat/messages."""

    message_id: str
    is_sent: bool
    drop_reason: dict[str, Any] | None
    status_code: int
    rate_limit_limit: int | None
    rate_limit_remaining: int | None
    rate_limit_reset: int | None


def _parse_int_header(headers: Any, name: str) -> int | None:
    raw = headers.get(name)
    if raw is None:
        return None
    try:
        return int(raw)
    except ValueError:
        return None


def helix_request(
    method: str,
    path: str,
    client_id: str,
    access_token: str,
    query: dict[str, str] | None = None,
    body: dict[str, Any] | None = None,
    urlopen_fn: Any = urllib.request.urlopen,
) -> tuple[int, dict[str, Any], dict[str, int | None]]:
    """Execute a Twitch Helix request and return (status, json_body, rate_headers)."""
    url = f"{HELIX_BASE_URL}{path}"
    if query:
        url = f"{url}?{urllib.parse.urlencode(query)}"

    headers = {
        "Authorization": f"Bearer {access_token}",
        "Client-Id": client_id,
    }
    data_bytes: bytes | None = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data_bytes = json.dumps(body).encode("utf-8")

    req = urllib.request.Request(url, data=data_bytes, headers=headers, method=method)
    try:
        with urlopen_fn(req, timeout=20) as resp:
            status = getattr(resp, "status", 200)
            raw_text = resp.read().decode("utf-8")
            parsed = json.loads(raw_text) if raw_text else {}
            rate_info = {
                "limit": _parse_int_header(resp.headers, "Ratelimit-Limit"),
                "remaining": _parse_int_header(resp.headers, "Ratelimit-Remaining"),
                "reset": _parse_int_header(resp.headers, "Ratelimit-Reset"),
            }
            return status, parsed, rate_info
    except urllib.error.HTTPError as exc:
        err_body = exc.read().decode("utf-8", errors="replace")
        remaining = _parse_int_header(exc.headers, "Ratelimit-Remaining") if exc.headers else None
        reset = _parse_int_header(exc.headers, "Ratelimit-Reset") if exc.headers else None
        raise TwitchAPIError(
            f"Helix {method} {path} failed with HTTP {exc.code}: {err_body}",
            status_code=exc.code,
            rate_limit_remaining=remaining,
            rate_limit_reset=reset,
        ) from exc
    except urllib.error.URLError as exc:
        raise TwitchAPIError(f"Network error calling Helix {path}: {exc.reason}") from exc


def get_user_by_login(
    client_id: str,
    access_token: str,
    login: str,
    urlopen_fn: Any = urllib.request.urlopen,
) -> dict[str, Any]:
    """Resolve a Twitch channel/user login to its user object."""
    _, payload, _ = helix_request(
        method="GET",
        path="/users",
        client_id=client_id,
        access_token=access_token,
        query={"login": login.lstrip("#").lower()},
        urlopen_fn=urlopen_fn,
    )
    users = payload.get("data", [])
    if not users:
        raise TwitchAPIError(f"Twitch user '{login}' not found", status_code=404)
    return users[0]


def send_chat_message(
    client_id: str,
    access_token: str,
    broadcaster_id: str,
    sender_id: str,
    message: str,
    urlopen_fn: Any = urllib.request.urlopen,
) -> SendMessageResult:
    """Send a single chat message via POST /helix/chat/messages."""
    status, payload, rate_info = helix_request(
        method="POST",
        path="/chat/messages",
        client_id=client_id,
        access_token=access_token,
        body={
            "broadcaster_id": broadcaster_id,
            "sender_id": sender_id,
            "message": message,
        },
        urlopen_fn=urlopen_fn,
    )
    items = payload.get("data", [])
    if not items:
        raise TwitchAPIError("Helix send_chat_message returned empty data array", status_code=status)
    entry = items[0]
    return SendMessageResult(
        message_id=str(entry.get("message_id", "")),
        is_sent=bool(entry.get("is_sent", False)),
        drop_reason=entry.get("drop_reason"),
        status_code=status,
        rate_limit_limit=rate_info["limit"],
        rate_limit_remaining=rate_info["remaining"],
        rate_limit_reset=rate_info["reset"],
    )


def create_chat_message_subscription(
    client_id: str,
    access_token: str,
    session_id: str,
    broadcaster_user_id: str,
    user_id: str,
    urlopen_fn: Any = urllib.request.urlopen,
) -> dict[str, Any]:
    """Subscribe to EventSub channel.chat.message v1 over WebSocket."""
    _, payload, _ = helix_request(
        method="POST",
        path="/eventsub/subscriptions",
        client_id=client_id,
        access_token=access_token,
        body={
            "type": "channel.chat.message",
            "version": "1",
            "condition": {
                "broadcaster_user_id": broadcaster_user_id,
                "user_id": user_id,
            },
            "transport": {
                "method": "websocket",
                "session_id": session_id,
            },
        },
        urlopen_fn=urlopen_fn,
    )
    return payload
