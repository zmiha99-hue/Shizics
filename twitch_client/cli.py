from __future__ import annotations

import argparse
import asyncio
import getpass
import os
from pathlib import Path
from typing import Callable

from twitch_client.audit_log import AuditLogger
from twitch_client.eventsub import listen_chat_eventsub
from twitch_client.helix import (
    TwitchAPIError,
    get_user_by_login,
    send_chat_message,
)
from twitch_client.oauth import (
    OAuthConfig,
    TwitchAuthError,
    load_token_bundle,
    run_local_oauth_flow,
    save_token_bundle,
    validate_token,
)

DEFAULT_TOKEN_PATH = Path(".secrets/twitch_account.json")
DEFAULT_LOG_PATH = Path("logs/twitch_single_test.jsonl")


def _get_client_id(arg_val: str | None) -> str:
    val = arg_val or os.environ.get("TWITCH_CLIENT_ID", "").strip()
    if not val:
        val = input("Twitch Client ID: ").strip()
    if not val:
        raise SystemExit("TWITCH_CLIENT_ID is required.")
    return val


def _get_client_secret(arg_val: str | None) -> str:
    val = arg_val or os.environ.get("TWITCH_CLIENT_SECRET", "").strip()
    if not val:
        val = getpass.getpass("Twitch Client Secret (hidden): ").strip()
    if not val:
        raise SystemExit("TWITCH_CLIENT_SECRET is required.")
    return val


def cmd_auth(args: argparse.Namespace) -> int:
    audit = AuditLogger(args.log)
    client_id = _get_client_id(args.client_id)
    client_secret = _get_client_secret(args.client_secret)
    cfg = OAuthConfig(
        client_id=client_id,
        client_secret=client_secret,
        redirect_uri=args.redirect_uri,
    )
    try:
        bundle = run_local_oauth_flow(cfg, open_browser=not args.no_browser)
    except TwitchAuthError as exc:
        audit.log("stopped_on_error", stage="oauth", status_code=exc.status_code, error=str(exc))
        print(f"Authorization failed: {exc}")
        return 1

    saved_path = save_token_bundle(args.token_file, bundle)
    audit.log("oauth_authorized", **bundle.to_safe_summary(), token_file=str(saved_path))
    print(f"Authorized as '{bundle.login}' (user_id={bundle.user_id}).")
    print(f"Scopes: {', '.join(bundle.scope)}")
    print(f"Token saved to {saved_path} (gitignored; tokens are never logged).")
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    audit = AuditLogger(args.log)
    if not Path(args.token_file).exists():
        print(f"Token file not found: {args.token_file}. Run 'auth' first.")
        return 1
    bundle = load_token_bundle(args.token_file)
    try:
        info = validate_token(bundle.access_token)
    except TwitchAuthError as exc:
        audit.log("stopped_on_error", stage="validate_token", status_code=exc.status_code, error=str(exc))
        print(f"Token validation failed: {exc}")
        return 1

    audit.log(
        "oauth_validated",
        user_id=info.get("user_id"),
        login=info.get("login"),
        scopes=info.get("scopes"),
        expires_in=info.get("expires_in"),
    )
    print(
        f"Valid token for '{info.get('login')}' (user_id={info.get('user_id')}), "
        f"expires_in={info.get('expires_in')}s, scopes={info.get('scopes')}"
    )
    return 0


def cmd_listen(args: argparse.Namespace) -> int:
    audit = AuditLogger(args.log)
    client_id = _get_client_id(args.client_id)
    bundle = load_token_bundle(args.token_file)

    try:
        validate_token(bundle.access_token)
        broadcaster = get_user_by_login(client_id, bundle.access_token, args.channel)
    except (TwitchAuthError, TwitchAPIError) as exc:
        audit.log("stopped_on_error", stage="listen_setup", status_code=getattr(exc, "status_code", None), error=str(exc))
        print(f"Setup failed (stopped): {exc}")
        return 1

    broadcaster_id = str(broadcaster["id"])
    print(f"Listening to #{broadcaster['login']} (id={broadcaster_id}) for {args.duration}s...")

    def _print_msg(record: dict) -> None:
        print(f"[{record['timestamp']}] {record['chatter_user_login']}: {record['text']}")

    try:
        asyncio.run(
            listen_chat_eventsub(
                client_id=client_id,
                access_token=bundle.access_token,
                broadcaster_user_id=broadcaster_id,
                user_id=bundle.user_id,
                audit=audit,
                duration_sec=args.duration,
                on_message=_print_msg,
            )
        )
    except (TwitchAPIError, RuntimeError) as exc:
        print(f"Stopped: {exc}")
        return 1
    return 0


def cmd_send_once(
    args: argparse.Namespace,
    input_fn: Callable[[str], str] = input,
) -> int:
    audit = AuditLogger(args.log)
    client_id = _get_client_id(args.client_id)
    bundle = load_token_bundle(args.token_file)

    try:
        validate_token(bundle.access_token)
        broadcaster = get_user_by_login(client_id, bundle.access_token, args.channel)
    except (TwitchAuthError, TwitchAPIError) as exc:
        audit.log("stopped_on_error", stage="send_setup", status_code=getattr(exc, "status_code", None), error=str(exc))
        print(f"Setup failed (stopped): {exc}")
        return 1

    broadcaster_id = str(broadcaster["id"])
    print("--- Send Preview (1 message) ---")
    print(f"Channel: #{broadcaster['login']} (broadcaster_id={broadcaster_id})")
    print(f"Sender:  {bundle.login} (sender_id={bundle.user_id})")
    print(f"Message: {args.message}")

    if not args.yes:
        confirm = input_fn("Type 'SEND' to send this single test message: ").strip()
        if confirm != "SEND":
            audit.log("send_cancelled", channel=broadcaster["login"], sender_login=bundle.login)
            print("Cancelled. No message was sent.")
            return 0

    audit.log(
        "chat_message_send_attempt",
        broadcaster_id=broadcaster_id,
        channel=broadcaster["login"],
        sender_id=bundle.user_id,
        sender_login=bundle.login,
        message=args.message,
    )

    try:
        res = send_chat_message(
            client_id=client_id,
            access_token=bundle.access_token,
            broadcaster_id=broadcaster_id,
            sender_id=bundle.user_id,
            message=args.message,
        )
    except TwitchAPIError as exc:
        audit.log(
            "stopped_on_error",
            stage="send_chat_message",
            status_code=exc.status_code,
            is_auth_error=exc.is_auth_error,
            is_rate_limited=exc.is_rate_limited,
            rate_limit_remaining=exc.rate_limit_remaining,
            error=str(exc),
        )
        print(f"Stopped on API error: {exc}")
        return 1

    audit.log(
        "chat_message_send_result",
        message_id=res.message_id,
        is_sent=res.is_sent,
        drop_reason=res.drop_reason,
        status_code=res.status_code,
        rate_limit_limit=res.rate_limit_limit,
        rate_limit_remaining=res.rate_limit_remaining,
        rate_limit_reset=res.rate_limit_reset,
    )

    if not res.is_sent:
        audit.log("stopped_on_error", stage="message_dropped", drop_reason=res.drop_reason)
        print(f"Message was NOT delivered (drop_reason={res.drop_reason}). Stopped.")
        return 1

    if res.rate_limit_remaining == 0:
        audit.log("stopped_on_error", stage="rate_limit_exhausted", rate_limit_reset=res.rate_limit_reset)
        print("Message sent, but Ratelimit-Remaining reached 0. Stopping.")
        return 0

    print(
        f"Sent! message_id={res.message_id}, is_sent={res.is_sent}, "
        f"ratelimit_remaining={res.rate_limit_remaining}"
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Single-account official Twitch OAuth, EventSub, and Helix test CLI."
    )
    parser.add_argument("--token-file", type=Path, default=DEFAULT_TOKEN_PATH)
    parser.add_argument("--log", type=Path, default=DEFAULT_LOG_PATH)
    parser.add_argument("--client-id", default=None)

    sub = parser.add_subparsers(dest="command", required=True)

    p_auth = sub.add_parser("auth", help="Run OAuth2 Authorization Code flow.")
    p_auth.add_argument("--client-secret", default=None)
    p_auth.add_argument("--redirect-uri", default="http://localhost:3000/callback")
    p_auth.add_argument("--no-browser", action="store_true")
    p_auth.set_defaults(func=cmd_auth)

    p_status = sub.add_parser("status", help="Validate saved OAuth token.")
    p_status.set_defaults(func=cmd_status)

    p_listen = sub.add_parser("listen", help="Listen to channel.chat.message via EventSub.")
    p_listen.add_argument("--channel", required=True, help="Target channel login (yours).")
    p_listen.add_argument("--duration", type=float, default=30.0)
    p_listen.set_defaults(func=cmd_listen)

    p_send = sub.add_parser("send-once", help="Send ONE explicitly marked test message.")
    p_send.add_argument("--channel", required=True, help="Target channel login (yours).")
    p_send.add_argument(
        "--message",
        default="[TEST] Контрольное сообщение одного тестового аккаунта",
        help="Explicitly marked test message.",
    )
    p_send.add_argument("--yes", action="store_true", help="Skip interactive SEND prompt.")
    p_send.set_defaults(func=cmd_send_once)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
