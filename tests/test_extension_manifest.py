from __future__ import annotations

import json
import unittest
from pathlib import Path

EXT_DIR = Path(__file__).resolve().parent.parent / "browser_extension"


class TestExtensionManifest(unittest.TestCase):
    def test_manifest_v3_minimal_permissions(self) -> None:
        manifest_path = EXT_DIR / "manifest.json"
        self.assertTrue(manifest_path.exists())
        data = json.loads(manifest_path.read_text(encoding="utf-8"))

        self.assertEqual(data["manifest_version"], 3)
        self.assertEqual(set(data["permissions"]), {"storage", "sidePanel"})
        self.assertEqual(
            set(data.get("host_permissions", [])),
            {
                "https://generativelanguage.googleapis.com/*",
                "http://localhost/*",
                "http://127.0.0.1/*",
            },
        )

        cs = data["content_scripts"][0]
        self.assertEqual(cs["matches"], ["https://www.twitch.tv/*"])

        for rel_path in [
            data["background"]["service_worker"],
            data["side_panel"]["default_path"],
            *cs["js"],
            "llm.js",
        ]:
            self.assertTrue((EXT_DIR / rel_path).exists(), f"Missing {rel_path}")

    def test_extension_scripts_avoid_unsafe_dom_and_cookies(self) -> None:
        for fname in ("content.js", "sidepanel.js", "background.js", "llm.js"):
            src = (EXT_DIR / fname).read_text(encoding="utf-8")
            self.assertNotIn("document.cookie", src)
            self.assertNotIn("innerHTML", src)
            self.assertNotIn("eval(", src)

    def test_content_script_never_reads_gemini_key(self) -> None:
        content_src = (EXT_DIR / "content.js").read_text(encoding="utf-8")
        self.assertNotIn("geminiApiKey", content_src)
        self.assertNotIn("generativelanguage.googleapis.com", content_src)

    def test_review_fixes_present_in_extension(self) -> None:
        content_src = (EXT_DIR / "content.js").read_text(encoding="utf-8")
        llm_src = (EXT_DIR / "llm.js").read_text(encoding="utf-8")
        bg_src = (EXT_DIR / "background.js").read_text(encoding="utf-8")
        html_src = (EXT_DIR / "sidepanel.html").read_text(encoding="utf-8")

        self.assertIn("extMsgId", content_src)
        self.assertIn("gemini-3.5-flash-lite", llm_src)
        self.assertIn("generateWithOllama", llm_src)
        self.assertIn("buildAlternatingTurns", llm_src)
        self.assertIn("parseControllerLogins", bg_src)
        self.assertIn("botLogin", bg_src)
        self.assertIn("recentSentTexts", bg_src)
        self.assertIn("CLEAR_CONTEXT_ONLY", bg_src)
        self.assertIn("ignoredIds", bg_src)
        self.assertIn("backdrop-filter", html_src)


if __name__ == "__main__":
    unittest.main()
