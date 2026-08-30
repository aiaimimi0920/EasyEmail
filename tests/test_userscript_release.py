from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = ROOT / "scripts" / "build-userscript-release.py"
TEMPLATE_PATH = ROOT / "runtimes" / "userscript" / "easy_email_proxy.user.js"


def load_script_module():
    spec = importlib.util.spec_from_file_location("build_userscript_release", SCRIPT_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load {SCRIPT_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(SCRIPT_PATH.parent))
    try:
        spec.loader.exec_module(module)
    finally:
        sys.path.pop(0)
    return module


class UserscriptReleaseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.module = load_script_module()

    def test_release_versions_follow_supported_tag_families(self) -> None:
        self.assertEqual(self.module.userscript_version("v1.2.3"), "1.2.3")
        self.assertEqual(self.module.userscript_version("v1.2.3-rc.1"), "1.2.3-rc.1")
        self.assertEqual(
            self.module.userscript_version("release-20260830-001"),
            "20260830.001",
        )
        with self.assertRaisesRegex(ValueError, "service-base-only"):
            self.module.userscript_version("service-base-20260830-001")

    def test_build_changes_only_the_metadata_version(self) -> None:
        source_text = TEMPLATE_PATH.read_text(encoding="utf-8")
        with tempfile.TemporaryDirectory() as temp_dir:
            output = Path(temp_dir) / "easy-email.user.js"
            version = self.module.build_userscript(
                TEMPLATE_PATH,
                output,
                "release-20260830-001",
            )
            output_text = output.read_text(encoding="utf-8")

        self.assertEqual(version, "20260830.001")
        expected = self.module.VERSION_LINE.sub(
            "// @version      20260830.001",
            source_text,
            count=1,
        )
        self.assertEqual(output_text, expected)
        self.assertEqual(
            set(self.module.LOCAL_SECRET_PLACEHOLDER.findall(output_text)),
            self.module.EXPECTED_PLACEHOLDERS,
        )

    def test_unknown_secret_placeholder_fails_closed(self) -> None:
        source_text = TEMPLATE_PATH.read_text(encoding="utf-8")
        with tempfile.TemporaryDirectory() as temp_dir:
            source = Path(temp_dir) / "template.user.js"
            output = Path(temp_dir) / "release.user.js"
            source.write_text(
                source_text.replace(
                    "__LOCAL_SECRET_MOEMAIL_API_KEY__",
                    "__LOCAL_SECRET_UNKNOWN_PROVIDER_KEY__",
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "placeholder contract changed"):
                self.module.build_userscript(source, output, "v1.2.3")

    def test_sensitive_defaults_must_remain_placeholders(self) -> None:
        source_text = TEMPLATE_PATH.read_text(encoding="utf-8")
        modified = source_text.replace(
            "gptmail_apiKey: '__LOCAL_SECRET_GPTMAIL_API_KEY__',",
            "gptmail_apiKey: 'accidental-live-value',\n    // __LOCAL_SECRET_GPTMAIL_API_KEY__",
        )
        with self.assertRaisesRegex(ValueError, "sensitive default 'gptmail_apiKey'"):
            self.module.validate_template(modified)

    def test_high_confidence_live_secret_patterns_fail_closed(self) -> None:
        source_text = TEMPLATE_PATH.read_text(encoding="utf-8")
        modified = source_text + "\n// ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456\n"
        with self.assertRaisesRegex(ValueError, "possible live GitHub token"):
            self.module.validate_template(modified)


if __name__ == "__main__":
    unittest.main()
