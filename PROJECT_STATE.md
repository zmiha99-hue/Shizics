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

## Stage 6: Peer-Bot Loop Prevention, Streamer Vocative Guard & Content Filters (2026-11-27)
- Added `peerBotLogin` (`peer_bot` role) in `sidepanel.html`/`sidepanel.js`/`background.js` with `countTrailingBotTurns` cap (<3 consecutive bot turns) to prevent infinite bot-to-bot ping-pong.
- Fixed trigger deduplication by marking `processedTriggerIds` at `runDraftGeneration` start and storing `pendingTriggerId` for deferred cooldown flushes.
- Extended `isExplicitlyAddressedToOther` to detect `@other` anywhere in text and streamer vocatives (`Миш`, `Миша`, etc.), and stripped accidental `@botLogin` self-mentions.
- Added `factMatchesReply` grounding + meta-fact rejection in `sanitizeMemoryFact`, `wordOverlapRatio` (>=0.60) paraphrase filter, and `hasUnsafeChatContent` (URLs, inventory phishing, profanity/drug stems) in `llm.js`.
- Verified locally with `python -m unittest discover -s tests -v` (`20/20` OK, including Chrome V8 JS test `PeerBot_Safety_And_Filters`). Real 2-bot live Twitch verification pending user's next run.
