# Project State

## Current Mode & Stage
- **Browser Extension ("Шизофрения", Chrome/Edge MV3)** — **Auto-experiment re-enabled + JSONL Experiment Log Export**:
  - **Auto-send**: Re-enabled (`AUTO_SEND_DISABLED_FOR_REVIEW = false` in `background.js`), presets include **100 messages / 15 min (`>= 20s`)**, `60/15m`, `45/15m`, `30/15m`, `10/15m`.
  - **Experiment Log**: `experimentLog` (up to 200 records without secrets) captures `auto_send`, `manual_send`, and `no_reply` events with trigger, reply, `memoryFact`, model, and `deliveryStatus`, exportable as `.jsonl` from the Side Panel.
  - **Review Fixes (Groups 1–3) + Character Memory**: All verified locally in Python + Chrome Headless V8.
- **Existing Python Modules**: `chat_sim/` and `chat_app/` intact; `twitch_client/` inactive.

## Verification Status
- **Verified locally (Python + Chrome V8 Headless JS)**: `20` test cases pass (`19` Python/manifest tests + `7` Chrome V8 JS tests in `test_extension_js_headless.py`).
- **Verified on real Twitch page in browser**: Ready for live 15-minute test with JSONL log export.
