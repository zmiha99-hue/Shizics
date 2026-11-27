from __future__ import annotations

import tempfile
import unittest
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from chat_sim.cli import main as cli_main
from chat_sim.generator import build_participants, generate_events
from chat_sim.models import ScenarioConfig
from chat_sim.storage import load_events_jsonl, save_events_jsonl


class TestChatSimulator(unittest.TestCase):
    def test_build_20_participants(self) -> None:
        participants = build_participants(20)
        self.assertEqual(len(participants), 20)
        self.assertEqual(participants[0].participant_id, "sim_01")
        self.assertEqual(participants[-1].participant_id, "sim_20")

    def test_events_sorted_and_deterministic(self) -> None:
        start = datetime(2026, 11, 26, 12, 0, 0, tzinfo=timezone.utc)
        cfg = ScenarioConfig(name="baseline", duration_sec=60.0, participant_count=20, seed=7)
        events_a = generate_events(cfg, start_time=start)
        events_b = generate_events(cfg, start_time=start)
        self.assertEqual(events_a, events_b)
        offsets = [e.offset_sec for e in events_a]
        self.assertEqual(offsets, sorted(offsets))

    def test_repeat_wave_produces_repeated_texts(self) -> None:
        cfg = ScenarioConfig(name="repeat_wave", duration_sec=60.0, participant_count=20, seed=11)
        events = generate_events(cfg)
        counts = Counter(e.text for e in events)
        self.assertGreaterEqual(max(counts.values()), 5)

    def test_sync_burst_produces_tight_cluster(self) -> None:
        cfg = ScenarioConfig(
            name="sync_burst",
            duration_sec=60.0,
            participant_count=20,
            seed=19,
            burst_window_sec=1.5,
            burst_size=10,
        )
        events = generate_events(cfg)
        burst_one = [e for e in events if e.burst_id == "burst_01"]
        self.assertEqual(len(burst_one), 10)
        span = max(e.offset_sec for e in burst_one) - min(e.offset_sec for e in burst_one)
        self.assertLessEqual(span, 1.501)

    def test_jsonl_roundtrip_and_cli(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            out_file = Path(tmpdir) / "mixed.jsonl"
            exit_code = cli_main(
                [
                    "--scenario",
                    "mixed",
                    "--duration",
                    "40",
                    "--participants",
                    "20",
                    "--seed",
                    "5",
                    "--out",
                    str(out_file),
                ]
            )
            self.assertEqual(exit_code, 0)
            self.assertTrue(out_file.exists())
            loaded = load_events_jsonl(out_file)
            self.assertGreater(len(loaded), 0)
            # Re-save and compare
            copy_file = Path(tmpdir) / "copy.jsonl"
            save_events_jsonl(loaded, copy_file)
            self.assertEqual(load_events_jsonl(copy_file), loaded)


if __name__ == "__main__":
    unittest.main()
