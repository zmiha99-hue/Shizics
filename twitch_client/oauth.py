from __future__ import annotations

import json
import secrets
import threading
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from dataclasses import asdict, dataclass
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any

TWITCH_AUTHORIZE_URL = "https://id.twitch.tv/oauth2/authorize"
TWITCH_TOKEN_URL = "https://id.twitch.tv/oauth2/token"
TWITCH_VALIDATE_URL = "https://id.twitch.tv/oauth2/validate"

DEFAULT_SCOPES: tuple[str, ...] = ("user:read:chat", "user:write:chat")


class TwitchAuthError(RuntimeError):
    """Raised when Twitch OAuth authorization or token validation fails."""

    def __init__(self, message: str, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


@dataclass(frozen=True)
class OAuthConfig:
    """Twitch OAuth application configuration."""

    client_id: str
    client_secret: str
    redirect_uri: str = "http://localhost:3000/callback"
    scopes: tuple[str, ...] = DEFAULT_SCOPES


@dataclass(frozen=True)
class TokenBundle:
    """Authorized user token bundle (never log or commit to Git)."""

    access_token: str
    refresh_token: str
    expires_in: int
    scope: list[str]
    token_type: str
    user_id: str
    login: str

    def to_safe_summary(self) -> dict[str, Any]:
        """Return metadata without secret token values."""
        return {
            "user_id": self.user_id,
            "login": self.login,
            "scope": list(self.scope),
            "expires_in": self.expires_in,
            "token_type": self.token_type,
        }


def build_authorize_url(config: OAuthConfig, state: str) -> str:
    """Build the official Twitch OAuth2 Authorization Code URL."""
    params = {
        "response_type": "code",
        "client_id": config.client_id,
        "redirect_uri": config.redirect_uri,
        "scope": " ".join(config.scopes),
        "state": state,
        "force_verify": "true",
    }
    return f"{TWITCH_AUTHORIZE_URL}?{urllib.parse.urlencode(params)}"


def _post_form(url: str, data: dict[str, str]) -> dict[str, Any]:
    encoded = urllib.parse.urlencode(data).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=encoded,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise TwitchAuthError(
            f"Token endpoint error HTTP {exc.code}: {body}",
            status_code=exc.code,
        ) from exc
    except urllib.error.URLError as exc:
        raise TwitchAuthError(f"Network error contacting Twitch OAuth: {exc.reason}") from exc


def validate_token(access_token: str) -> dict[str, Any]:
    """Validate an access token via GET /oauth2/validate."""
    req = urllib.request.Request(
        TWITCH_VALIDATE_URL,
        headers={"Authorization": f"OAuth {access_token}"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise TwitchAuthError(
            f"Token validation failed HTTP {exc.code}: {body}",
            status_code=exc.code,
        ) from exc
    except urllib.error.URLError as exc:
        raise TwitchAuthError(f"Network error validating token: {exc.reason}") from exc


def exchange_code_for_token(config: OAuthConfig, code: str) -> TokenBundle:
    """Exchange authorization code for an access/refresh token bundle."""
    payload = _post_form(
        TWITCH_TOKEN_URL,
        {
            "client_id": config.client_id,
            "client_secret": config.client_secret,
            "code": code,
            "grant_type": "authorization_code",
            "redirect_uri": config.redirect_uri,
        },
    )
    access_token = payload["access_token"]
    validated = validate_token(access_token)
    return TokenBundle(
        access_token=access_token,
        refresh_token=payload.get("refresh_token", ""),
        expires_in=int(payload.get("expires_in", 0)),
        scope=list(validated.get("scopes", payload.get("scope", []))),
        token_type=payload.get("token_type", "bearer"),
        user_id=str(validated["user_id"]),
        login=str(validated["login"]),
    )


def refresh_access_token(config: OAuthConfig, refresh_token: str) -> TokenBundle:
    """Refresh an expired user access token."""
    payload = _post_form(
        TWITCH_TOKEN_URL,
        {
            "client_id": config.client_id,
            "client_secret": config.client_secret,
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
        },
    )
    access_token = payload["access_token"]
    validated = validate_token(access_token)
    return TokenBundle(
        access_token=access_token,
        refresh_token=payload.get("refresh_token", refresh_token),
        expires_in=int(payload.get("expires_in", 0)),
        scope=list(validated.get("scopes", payload.get("scope", []))),
        token_type=payload.get("token_type", "bearer"),
        user_id=str(validated["user_id"]),
        login=str(validated["login"]),
    )


def save_token_bundle(path: str | Path, bundle: TokenBundle) -> Path:
    """Save token bundle to a gitignored local secrets file."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(asdict(bundle), indent=2), encoding="utf-8")
    return target


def load_token_bundle(path: str | Path) -> TokenBundle:
    """Load token bundle from a local secrets file."""
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    return TokenBundle(**raw)


def run_local_oauth_flow(
    config: OAuthConfig,
    timeout_sec: int = 180,
    open_browser: bool = True,
) -> TokenBundle:
    """Run interactive Authorization Code flow using a local callback server."""
    parsed = urllib.parse.urlparse(config.redirect_uri)
    host = parsed.hostname or "localhost"
    port = parsed.port or 3000
    expected_path = parsed.path or "/callback"
    state = secrets.token_urlsafe(24)

    result: dict[str, str] = {}
    done = threading.Event()

    class CallbackHandler(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: Any) -> None:
            return

        def do_GET(self) -> None:
            req_url = urllib.parse.urlparse(self.path)
            if req_url.path != expected_path:
                self.send_response(404)
                self.end_headers()
                return

            query = urllib.parse.parse_qs(req_url.query)
            if "error" in query:
                result["error"] = query["error"][0]
                result["error_description"] = query.get("error_description", [""])[0]
            elif "code" in query:
                result["code"] = query["code"][0]
                result["state"] = query.get("state", [""])[0]
            else:
                result["error"] = "missing_code"

            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(
                b"<html><body><h3>Authorization received. You may close this tab.</h3></body></html>"
            )
            done.set()

    server = HTTPServer((host, port), CallbackHandler)
    server.timeout = 1.0

    def serve() -> None:
        while not done.is_set():
            server.handle_request()

    thread = threading.Thread(target=serve, daemon=True)
    thread.start()

    auth_url = build_authorize_url(config, state)
    print("Open this URL in your browser to authorize your test account:")
    print(auth_url)
    if open_browser:
        webbrowser.open(auth_url)

    finished = done.wait(timeout=timeout_sec)
    server.server_close()

    if not finished:
        raise TwitchAuthError("Timed out waiting for OAuth callback.")
    if "error" in result:
        raise TwitchAuthError(
            f"OAuth authorization error: {result['error']} ({result.get('error_description', '')})"
        )
    if result.get("state") != state:
        raise TwitchAuthError("OAuth state mismatch; aborting.")

    return exchange_code_for_token(config, result["code"])
