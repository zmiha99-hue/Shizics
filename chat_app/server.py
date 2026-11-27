from __future__ import annotations

import argparse
import json
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from chat_app.runtime import ChatAppRuntime

STATIC_INDEX = Path(__file__).parent / "static" / "index.html"


def make_handler(runtime: ChatAppRuntime) -> type[BaseHTTPRequestHandler]:
    class AppHandler(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: Any) -> None:
            return

        def _send_json(self, status: int, payload: dict[str, Any]) -> None:
            raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def _read_json(self) -> dict[str, Any]:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0:
                return {}
            body = self.rfile.read(length).decode("utf-8")
            return json.loads(body) if body.strip() else {}

        def do_GET(self) -> None:
            if self.path in ("/", "/index.html"):
                html = STATIC_INDEX.read_bytes()
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(html)))
                self.end_headers()
                self.wfile.write(html)
                return

            if self.path == "/api/state":
                self._send_json(HTTPStatus.OK, runtime.snapshot())
                return

            self._send_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})

        def do_POST(self) -> None:
            try:
                data = self._read_json()
                if self.path == "/api/control":
                    state = runtime.set_control(str(data.get("action", "")))
                    self._send_json(HTTPStatus.OK, {"run_state": state})
                    return

                if self.path == "/api/profile":
                    profile = runtime.update_profile(data)
                    self._send_json(HTTPStatus.OK, {"profile": profile.to_dict()})
                    return

                if self.path == "/api/local-message":
                    sender = str(data.get("sender_login", "owner")).strip() or "owner"
                    text = str(data.get("text", "")).strip()
                    if not text:
                        self._send_json(HTTPStatus.BAD_REQUEST, {"error": "text is required"})
                        return
                    res = runtime.ingest_local_message(
                        sender_login=sender,
                        text=text,
                        message_id=data.get("message_id"),
                    )
                    self._send_json(HTTPStatus.OK, res)
                    return

                if self.path == "/api/approve":
                    draft_id = str(data.get("draft_id", ""))
                    edited_text = data.get("edited_text")
                    draft = runtime.approve_draft(draft_id, edited_text=edited_text)
                    self._send_json(HTTPStatus.OK, {"draft": draft.to_dict()})
                    return

                if self.path == "/api/reject":
                    draft_id = str(data.get("draft_id", ""))
                    draft = runtime.reject_draft(draft_id)
                    self._send_json(HTTPStatus.OK, {"draft": draft.to_dict()})
                    return

                self._send_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})
            except (KeyError, ValueError, json.JSONDecodeError) as exc:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})

    return AppHandler


def create_server(
    host: str = "127.0.0.1",
    port: int = 8765,
    runtime: ChatAppRuntime | None = None,
) -> tuple[ThreadingHTTPServer, ChatAppRuntime]:
    rt = runtime or ChatAppRuntime()
    server = ThreadingHTTPServer((host, port), make_handler(rt))
    return server, rt


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Local context-aware chat web panel.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--controller", default="owner", help="Controller human login.")
    args = parser.parse_args(argv)

    rt = ChatAppRuntime(controller_login=args.controller)
    server, _ = create_server(host=args.host, port=args.port, runtime=rt)
    print(f"Local chat panel running at http://{args.host}:{args.port}/ (Ctrl+C to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
