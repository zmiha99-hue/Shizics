from __future__ import annotations

import io
import json
import tempfile
import unittest
import urllib.error
from email.message import Message
from pathlib import Path
from unittest.mock import patch

from twitch_client.audit_log import AuditLogger
from twitch_client.cli import cmd_send_once
from twitch_client.helix import TwitchAPIError, send_chat_message
from twitch_client.oauth import OAuthConfig, TokenBundle, build_authorize_url, save_token_bundle


class _FakeHTTPResponse:
    def __init__(self, body: dict, status: int = 200, headers: dict[str, str] | None = None) -> None:
        self._raw = json.dumps(body).encode("utf-8")
        self.status = status
        msg = Message()
        for k, v in (headers or {}).items():
            msg[k] = v
        self.headers = msg

    def read(self) -> bytes:
        return self._raw

    def __enter__(self) -> _FakeHTTPResponse:
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        return None


class TestTwitchClient(unittest.TestCase):
    def test_audit_logger_redacts_secrets(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            log_path = Path(tmpdir) / "audit.jsonl"
            logger = AuditLogger(log_path)
            logger.log(
                "oauth_debug",
                access_token="secret_access_123",
                refresh_token="secret_refresh_456",
                client_secret="secret_client_789",
                login="test_user",
            )
            content = log_path.read_text(encoding="utf-8")
            self.assertNotIn("secret_access_123", content)
            self.assertNotIn("secret_refresh_456", content)
            self.assertNotIn("secret_client_789", content)
            self.assertIn("[REDACTED]", content)
            self.assertIn("test_user", content)

    def test_build_authorize_url_has_required_params(self) -> None:
        cfg = OAuthConfig(client_id="cid_123", client_secret="sec_456")
        url = build_authorize_url(cfg, state="state_xyz")
        self.assertIn("response_type=code", url)
        self.assertIn("client_id=cid_123", url)
        self.assertIn("state=state_xyz", url)
        self.assertIn("user%3Aread%3Achat", url)
        self.assertIn("user%3Awrite%3Achat", url)

    def test_send_chat_message_success_and_rate_headers(self) -> None:
        def fake_urlopen(req, timeout=20):
            return _FakeHTTPResponse(
                {"data": [{"message_id": "msg_001", "is_sent": True, "drop_reason": None}]},
                status=200,
                headers={
                    "Ratelimit-Limit": "800",
                    "Ratelimit-Remaining": "799",
                    "Ratelimit-Reset": "1700000000",
                },
            )

        res = send_chat_message(
            client_id="cid",
            access_token="tok",
            broadcaster_id="100",
            sender_id="200",
            message="[TEST] hello",
            urlopen_fn=fake_urlopen,
        )
        self.assertTrue(res.is_sent)
        self.assertEqual(res.message_id, "msg_001")
        self.assertEqual(res.rate_limit_remaining, 799)

    def test_send_chat_message_401_and_429_flags(self) -> None:
        def fake_401(req, timeout=20):
            raise urllib.error.HTTPError(
                req.full_url,
                401,
                "Unauthorized",
                Message(),
                io.BytesIO(b'{"status":401,"message":"Invalid OAuth token"}'),
            )

        with self.assertRaises(TwitchAPIError) as ctx_401:
            send_chat_message("cid", "bad", "1", "2", "hi", urlopen_fn=fake_401)
        self.assertTrue(ctx_401.exception.is_auth_error)

        def fake_429(req, timeout=20):
            hdrs = Message()
            hdrs["Ratelimit-Remaining"] = "0"
            raise urllib.error.HTTPError(
                req.full_url,
                429,
                "Too Many Requests",
                hdrs,
                io.BytesIO(b'{"status":429,"message":"Rate limit"}'),
            )

        with self.assertRaises(TwitchAPIError) as ctx_429:
            send_chat_message("cid", "tok", "1", "2", "hi", urlopen_fn=fake_429)
        self.assertTrue(ctx_429.exception.is_rate_limited)

    def test_cli_send_once_requires_confirmation_and_logs_without_secrets(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            token_path = tmp / "token.json"
            log_path = tmp / "audit.jsonl"
            save_token_bundle(
                token_path,
                TokenBundle(
                    access_token="super_secret_tok",
                    refresh_token="super_secret_ref",
                    expires_in=3600,
                    scope=["user:read:chat", "user:write:chat"],
                    token_type="bearer",
                    user_id="200",
                    login="my_test_bot",
                ),
            )

            class Args:
                channel = "my_channel"
                message = "[TEST] single check"
                client_id = "cid_123"
                token_file = token_path
                log = log_path
                yes = False

            with (
                patch("twitch_client.cli.validate_token", return_value={"user_id": "200", "login": "my_test_bot"}),
                patch("twitch_client.cli.get_user_by_login", return_value={"id": "100", "login": "my_channel"}),
            ):
                rc = cmd_send_once(Args(), input_fn=lambda _: "NO")
            self.assertEqual(rc, 0)
            log_text = log_path.read_text(encoding="utf-8")
            self.assertIn("send_cancelled", log_text)
            self.assertNotIn("super_secret_tok", log_text)


if __name__ == "__main__":
    unittest.main()
