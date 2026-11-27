from __future__ import annotations

import argparse
from pathlib import Path

from chat_sim.generator import SUPPORTED_SCENARIOS, generate_events
from chat_sim.models import ScenarioConfig
from chat_sim.storage import save_events_jsonl


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Local chat event simulator (no external network connections)."
    )
    parser.add_argument(
        "--scenario",
        choices=SUPPORTED_SCENARIOS,
        default="baseline",
        help="Scenario to simulate.",
    )
    parser.add_argument(
        "--duration",
        type=float,
        default=60.0,
        help="Simulation duration in seconds (default: 60).",
    )
    parser.add_argument(
        "--participants",
        type=int,
        default=20,
        help="Number of virtual participants (default: 20).",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=42,
        help="Random seed for reproducibility (default: 42).",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help="Output JSONL path (default: logs/<scenario>.jsonl).",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    output_path = args.out or Path("logs") / f"{args.scenario}.jsonl"

    config = ScenarioConfig(
        name=args.scenario,
        duration_sec=args.duration,
        participant_count=args.participants,
        seed=args.seed,
    )
    events = generate_events(config)
    saved_path = save_events_jsonl(events, output_path)
    print(
        f"Generated {len(events)} events for scenario '{args.scenario}' "
        f"({args.participants} participants) -> {saved_path}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
