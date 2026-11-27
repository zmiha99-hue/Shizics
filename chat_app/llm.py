from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol

from chat_app.models import BotProfile, ChatMessage


@dataclass(frozen=True)
class LLMResponse:
    """Normalized LLM generation result with optional token usage."""

    text: str
    model: str
    usage: dict[str, int] = field(default_factory=dict)


class LLMClient(Protocol):
    """Pluggable LLM client interface."""

    def generate_reply(
        self,
        profile: BotProfile,
        context_messages: list[ChatMessage],
        trigger_message: ChatMessage,
    ) -> LLMResponse: ...


class StubLLMClient:
    """Deterministic local test LLM client for Stage 2 without external API calls."""

    def __init__(self, model_name: str = "stub-local-v1") -> None:
        self.model_name = model_name
        self.request_count = 0
        self.total_usage: dict[str, int] = {
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
        }

    def generate_reply(
        self,
        profile: BotProfile,
        context_messages: list[ChatMessage],
        trigger_message: ChatMessage,
    ) -> LLMResponse:
        self.request_count += 1
        text_clean = trigger_message.text.strip()
        ctx_count = len(context_messages)

        if "?" in text_clean:
            reply = (
                f"[{profile.display_name}] По контексту ({ctx_count} сообщ.): "
                f"отвечаю на вопрос «{text_clean[:80]}» — тестовый режим активен."
            )
        else:
            reply = (
                f"[{profile.display_name}] Принял от {trigger_message.sender_login}: "
                f"«{text_clean[:80]}» (контекст: {ctx_count} сообщ.)."
            )

        reply = reply[: profile.max_reply_chars]
        prompt_tokens = sum(len(m.text.split()) for m in context_messages) + 12
        completion_tokens = len(reply.split())
        usage = {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
        }
        for key, val in usage.items():
            self.total_usage[key] += val

        return LLMResponse(text=reply, model=self.model_name, usage=usage)

    def stats(self) -> dict[str, Any]:
        return {
            "model": self.model_name,
            "request_count": self.request_count,
            "usage": dict(self.total_usage),
        }
