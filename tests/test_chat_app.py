from __future__ import annotations

import io
import json
import tempfile
import unittest
from pathlib import Path

from chat_app.models import DeliveryResult
from chat_app.runtime import ChatAppRuntime
from chat_app.server import make_handler


class TestChatAppStage2(unittest.TestCase):
    def test_dedup_and_role_classification(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            rt = ChatAppRuntime(log_path=Path(tmpdir) / "app.jsonl", controller_login="owner")
            first = rt.ingest_local_message("owner", "Привет?", message_id="m_1")
            dup = rt.ingest_local_message("owner", "Привет?", message_id="m_1")
            other = rt.ingest_local_message("random_viewer", "Всем привет", message_id="m_2")
            bot = rt.ingest_local_message("local_ai_bot", "Тест", message_id="m_3")

            self.assertFalse(first["duplicate"])
            self.assertIsNotNone(first["draft"])
            self.assertTrue(dup["duplicate"])
            self.assertEqual(other["message"]["role"], "other")
            self.assertIsNone(other["draft"])
            self.assertEqual(bot["message"]["role"], "app_bot")
            self.assertIsNone(bot["draft"])

    def test_draft_not_in_history_until_approved_and_sent(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            rt = ChatAppRuntime(log_path=Path(tmpdir) / "app.jsonl", controller_login="owner")
            res = rt.ingest_local_message("owner", "Как дела?", message_id="m_10")
            draft_id = res["draft"]["draft_id"]

            # Before approval, history has only the incoming message
            self.assertEqual(len(rt.history.all_messages()), 1)

            sent_draft = rt.approve_draft(draft_id)
            self.assertEqual(sent_draft.status, "sent")
            self.assertTrue(sent_draft.delivery.is_sent)
            self.assertEqual(len(rt.history.all_messages()), 2)
            self.assertEqual(rt.history.all_messages()[-1].role, "app_bot")

    def test_pause_and_stop_do_not_cancel_sent_messages(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            rt = ChatAppRuntime(log_path=Path(tmpdir) / "app.jsonl", controller_login="owner")
            rt.update_profile({"min_reply_interval_sec": 0.0})

            d1 = rt.ingest_local_message("owner", "Первое", message_id="m_20")["draft"]
            rt.approve_draft(d1["draft_id"])

            d2 = rt.ingest_local_message("owner", "Второе", message_id="m_21")["draft"]
            self.assertIsNotNone(d2)

            rt.set_control("pause")
            paused_res = rt.ingest_local_message("owner", "На паузе", message_id="m_22")
            self.assertIsNone(paused_res["draft"])

            rt.set_control("stop")
            self.assertEqual(rt.queue.get_draft(d1["draft_id"]).status, "sent")
            self.assertEqual(rt.queue.get_draft(d2["draft_id"]).status, "cancelled")

    def test_failed_delivery_with_drop_reason_not_added_to_history(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            rt = ChatAppRuntime(log_path=Path(tmpdir) / "app.jsonl", controller_login="owner")
            d = rt.ingest_local_message("owner", "Проверка ошибки", message_id="m_30")["draft"]
            rt.adapter.send_message = lambda _draft: DeliveryResult(
                is_sent=False,
                drop_reason={"code": "msg_ratelimit", "message": "Too fast"},
                status_code=200,
            )
            failed = rt.approve_draft(d["draft_id"])
            self.assertEqual(failed.status, "failed")
            self.assertEqual(len(rt.history.all_messages()), 1)

    def test_local_http_handler_endpoints(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            rt = ChatAppRuntime(log_path=Path(tmpdir) / "app.jsonl", controller_login="owner")
            handler_cls = make_handler(rt)

            def invoke(method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
                raw_body = json.dumps(body).encode("utf-8") if body is not None else b""
                headers = f"Content-Length: {len(raw_body)}\r\nContent-Type: application/json\r\n"
                raw_req = f"{method} {path} HTTP/1.1\r\n{headers}\r\n".encode("utf-8") + raw_body
                wfile = io.BytesIO()

                class _FakeSocket:
                    def makefile(self, mode: str, *args, **kwargs):
                        return io.BytesIO(raw_req)

                    def sendall(self, data: bytes) -> None:
                        wfile.write(data)

                handler_cls(_FakeSocket(), ("127.0.0.1", 0), None)
                resp_text = wfile.getvalue().decode("utf-8")
                head, resp_body = resp_text.split("\r\n\r\n", 1)
                status_code = int(head.splitlines()[0].split()[1])
                return status_code, json.loads(resp_body)

            status_get, state = invoke("GET", "/api/state")
            self.assertEqual(status_get, 200)
            self.assertEqual(state["run_state"], "running")

            status_post, created = invoke(
                "POST",
                "/api/local-message",
                {"sender_login": "owner", "text": "Тест панели"},
            )
            self.assertEqual(status_post, 200)
            self.assertIsNotNone(created["draft"])


if __name__ == "__main__":
    unittest.main()
