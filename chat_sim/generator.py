from __future__ import annotations

import random
from datetime import datetime, timedelta, timezone

from chat_sim.models import ChatEvent, Participant, ScenarioConfig

ORGANIC_MESSAGES: tuple[str, ...] = (
    "Всем привет, как дела?",
    "Отличный стрим сегодня",
    "Какой план на этот раунд?",
    "Звук стал намного лучше",
    "Интересный разбор, спасибо",
    "А во сколько следующая тема?",
    "Хороший момент был только что",
    "Я только зашёл, что пропустил?",
    "Согласен с предыдущим комментарием",
    "Давайте посмотрим статистику",
    "Очень подробно объясняешь",
    "У кого тоже картинка плавная?",
    "Неожиданный поворот",
    "Круто получилось разобрать",
    "Жду продолжения эксперимента",
    "Понятно, теперь стало яснее",
    "Хороший темп сегодня",
    "Спасибо за ответ на вопрос",
    "Записал себе идею",
    "Будет ли итог в конце?",
)

SUPPORTED_SCENARIOS: tuple[str, ...] = (
    "baseline",
    "repeat_wave",
    "sync_burst",
    "mixed",
)


def build_participants(count: int = 20) -> list[Participant]:
    """Create a deterministic list of virtual chat participants."""
    if count <= 0:
        raise ValueError("participant_count must be positive")
    return [
        Participant(
            participant_id=f"sim_{idx:02d}",
            username=f"sim_user_{idx:02d}",
            role="regular",
        )
        for idx in range(1, count + 1)
    ]


def _make_event(
    start_time: datetime,
    offset_sec: float,
    scenario: str,
    participant: Participant,
    text: str,
    burst_id: str | None = None,
    pattern: str = "organic",
) -> ChatEvent:
    clamped_offset = round(max(0.0, offset_sec), 3)
    ts = (start_time + timedelta(seconds=clamped_offset)).isoformat()
    return ChatEvent(
        timestamp=ts,
        offset_sec=clamped_offset,
        scenario=scenario,
        participant_id=participant.participant_id,
        username=participant.username,
        text=text,
        burst_id=burst_id,
        metadata={"pattern": pattern},
    )


def _generate_baseline(
    rng: random.Random,
    participants: list[Participant],
    config: ScenarioConfig,
    start_time: datetime,
) -> list[ChatEvent]:
    total_messages = max(1, int(round((config.base_rate_per_min / 60.0) * config.duration_sec)))
    events: list[ChatEvent] = []
    for _ in range(total_messages):
        participant = rng.choice(participants)
        offset = rng.uniform(0.0, config.duration_sec)
        base_text = rng.choice(ORGANIC_MESSAGES)
        suffix = rng.randint(1, 99) if rng.random() < 0.25 else None
        text = f"{base_text} #{suffix}" if suffix is not None else base_text
        events.append(
            _make_event(
                start_time=start_time,
                offset_sec=offset,
                scenario=config.name,
                participant=participant,
                text=text,
                pattern="organic",
            )
        )
    return events


def _generate_repeat_wave(
    rng: random.Random,
    participants: list[Participant],
    config: ScenarioConfig,
    start_time: datetime,
    wave_count: int = 20,
) -> list[ChatEvent]:
    events: list[ChatEvent] = []
    phrases = config.repeat_phrases or ("GG!",)
    chosen_phrase = rng.choice(phrases)
    for idx in range(wave_count):
        participant = participants[idx % len(participants)]
        offset = rng.uniform(0.0, config.duration_sec)
        phrase = chosen_phrase if rng.random() < 0.8 else rng.choice(phrases)
        events.append(
            _make_event(
                start_time=start_time,
                offset_sec=offset,
                scenario=config.name,
                participant=participant,
                text=phrase,
                pattern="repeat",
            )
        )
    return events


def _generate_sync_bursts(
    rng: random.Random,
    participants: list[Participant],
    config: ScenarioConfig,
    start_time: datetime,
    burst_centers: list[float] | None = None,
) -> list[ChatEvent]:
    events: list[ChatEvent] = []
    centers = burst_centers or [config.duration_sec * 0.3, config.duration_sec * 0.7]
    burst_size = min(config.burst_size, len(participants))
    phrases = config.repeat_phrases or ("GG!",)

    for burst_idx, center in enumerate(centers, start=1):
        burst_id = f"burst_{burst_idx:02d}"
        selected = rng.sample(participants, k=burst_size)
        phrase = rng.choice(phrases)
        half_win = config.burst_window_sec / 2.0
        for participant in selected:
            offset = min(
                config.duration_sec,
                max(0.0, center + rng.uniform(-half_win, half_win)),
            )
            events.append(
                _make_event(
                    start_time=start_time,
                    offset_sec=offset,
                    scenario=config.name,
                    participant=participant,
                    text=phrase,
                    burst_id=burst_id,
                    pattern="sync_burst",
                )
            )
    return events


def generate_events(
    config: ScenarioConfig,
    start_time: datetime | None = None,
) -> list[ChatEvent]:
    """Generate a sorted list of simulated chat events for a scenario."""
    if config.name not in SUPPORTED_SCENARIOS:
        raise ValueError(
            f"Unsupported scenario '{config.name}'. Choose from: {', '.join(SUPPORTED_SCENARIOS)}"
        )
    if config.duration_sec <= 0:
        raise ValueError("duration_sec must be positive")

    base_time = start_time or datetime.now(timezone.utc).replace(microsecond=0)
    rng = random.Random(config.seed)
    participants = build_participants(config.participant_count)

    events: list[ChatEvent] = []
    if config.name == "baseline":
        events.extend(_generate_baseline(rng, participants, config, base_time))
    elif config.name == "repeat_wave":
        events.extend(_generate_baseline(rng, participants, config, base_time))
        events.extend(_generate_repeat_wave(rng, participants, config, base_time, wave_count=24))
    elif config.name == "sync_burst":
        events.extend(_generate_baseline(rng, participants, config, base_time))
        events.extend(_generate_sync_bursts(rng, participants, config, base_time))
    elif config.name == "mixed":
        events.extend(_generate_baseline(rng, participants, config, base_time))
        events.extend(_generate_repeat_wave(rng, participants, config, base_time, wave_count=16))
        events.extend(
            _generate_sync_bursts(
                rng,
                participants,
                config,
                base_time,
                burst_centers=[config.duration_sec * 0.5],
            )
        )

    events.sort(key=lambda e: (e.offset_sec, e.participant_id))
    return events
