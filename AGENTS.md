# Project Rules (AGENTS.md)

1. **Reuse existing code**: Build on `chat_sim` and `twitch_client`; do not rewrite working modules from scratch.
2. **Official Twitch APIs only**: Use official Twitch OAuth2, EventSub WebSocket (`channel.chat.message`), and Helix (`POST /helix/chat/messages`). Never bypass Twitch checks, rate limits, or create artificial stream views.
3. **Secrets & Git hygiene**: Never request passwords, Client Secret, or tokens in chat; never log secrets (use `AuditLogger` redaction); never commit `.secrets/`, `.env`, or tokens to Git.
4. **Safety & approval**:
   - Never send real Twitch messages without explicit user confirmation (auto-send stays off until enabled as a separate setting after manual verification).
   - Drafts are never added to message history as sent messages.
   - Always check `is_sent` and `drop_reason`; do not blindly retry on errors.
   - `Pause` stops new generations; `Stop` cancels pending tasks without altering already-sent messages.
5. **Honest reporting**: Distinguish clearly between local/mocked checks and real Twitch checks. Keep `PROJECT_STATE.md` updated after each stage.
