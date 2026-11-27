from __future__ import annotations

import re
import subprocess
import unittest
from pathlib import Path

CHROME_PATH = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
JS_RUNNER = Path(__file__).resolve().parent / "js_test_runner.html"


@unittest.skipUnless(CHROME_PATH.exists(), "Google Chrome not installed for headless JS tests")
class TestExtensionJavaScriptHeadless(unittest.TestCase):
    def test_js_extension_unit_suite_in_chrome_v8(self) -> None:
        url = JS_RUNNER.as_uri()
        proc = subprocess.run(
            [
                str(CHROME_PATH),
                "--headless=new",
                "--disable-gpu",
                "--no-sandbox",
                "--virtual-time-budget=2000",
                "--dump-dom",
                url,
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=20,
        )
        self.assertEqual(proc.returncode, 0, f"Chrome failed: {proc.stderr}")
        match = re.search(r'<pre id="results">([\s\S]*?)</pre>', proc.stdout)
        self.assertIsNotNone(match, "Missing #results pre block in Chrome output")
        results_text = match.group(1)
        self.assertIn("PASS: Group1_RejectCommandsAndBrokenJson", results_text)
        self.assertIn("PASS: Group1_BlockDoubleSend", results_text)
        self.assertIn("PASS: Group1_PauseCancelsInFlightDraft", results_text)
        self.assertIn("PASS: Group2_NoStaleContextOverwrite", results_text)
        self.assertIn("PASS: Group3_ExplicitTriggerAndProviders", results_text)
        self.assertIn("PASS: Group3_NoRepeatProcessedTriggerIds", results_text)
        self.assertIn("PASS: Memory_LifecycleAndConfirmedCommit", results_text)
        self.assertIn("PASS: Auto_NaturalCooldownDefersAndAccumulatesContext", results_text)
        self.assertNotIn("FAIL:", results_text)


if __name__ == "__main__":
    unittest.main()
