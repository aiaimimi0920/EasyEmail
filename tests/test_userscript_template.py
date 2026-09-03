from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
USERSCRIPT_ENTRY = ROOT / "runtimes" / "userscript" / "easy_email_proxy.user.js"
sys.path.insert(0, str(ROOT / "scripts"))
from userscript_template import IIFE_PREFIX, IIFE_SUFFIX, assemble_userscript  # noqa: E402


class UserscriptTemplateTests(unittest.TestCase):
    def write_template(
        self,
        root: Path,
        *,
        metadata: str = "src/metadata.user.js",
        runtime_parts: object = None,
    ) -> Path:
        entry = root / "entry.user.js"
        manifest = root / "template.json"
        entry.write_text(
            "// @easyemail-template-manifest template.json\n",
            encoding="utf-8",
        )
        manifest.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "metadata": metadata,
                    "runtimeParts": runtime_parts or ["src/first.js", "src/second.js"],
                }
            ),
            encoding="utf-8",
        )
        return entry

    def test_repository_entry_assembles_valid_standalone_runtime(self) -> None:
        assembled = assemble_userscript(USERSCRIPT_ENTRY)
        self.assertTrue(assembled.startswith("// ==UserScript==\n"))
        self.assertTrue(assembled.endswith(IIFE_SUFFIX))
        self.assertIn(IIFE_PREFIX, assembled)
        self.assertIn("  async function bootstrap() {", assembled)
        self.assertNotIn("@easyemail-template-manifest", assembled)

        with tempfile.TemporaryDirectory() as temp_dir:
            output = Path(temp_dir) / "assembled.user.js"
            output.write_text(assembled, encoding="utf-8", newline="\n")
            result = subprocess.run(
                ["node", "--check", str(output)],
                check=False,
                capture_output=True,
                text=True,
            )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_manifest_preserves_declared_runtime_order(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "src"
            source.mkdir()
            (source / "metadata.user.js").write_text(
                "// ==UserScript==\n// @version 1.0.0\n// ==/UserScript==\n",
                encoding="utf-8",
            )
            (source / "first.js").write_text("const first = 1;\n", encoding="utf-8")
            (source / "second.js").write_text("const second = first + 1;\n", encoding="utf-8")
            entry = self.write_template(root)

            assembled = assemble_userscript(entry)

        self.assertLess(assembled.index("const first"), assembled.index("const second"))
        self.assertEqual(
            assembled,
            "// ==UserScript==\n// @version 1.0.0\n// ==/UserScript=="
            + IIFE_PREFIX
            + "const first = 1;\nconst second = first + 1;\n"
            + IIFE_SUFFIX,
        )

    def test_manifest_rejects_component_path_escape(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "template"
            root.mkdir()
            entry = self.write_template(root, metadata="../outside.user.js")
            with self.assertRaisesRegex(ValueError, "escapes its directory"):
                assemble_userscript(entry)

    def test_manifest_rejects_duplicate_runtime_parts(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "src"
            source.mkdir()
            (source / "metadata.user.js").write_text(
                "// ==UserScript==\n// ==/UserScript==\n",
                encoding="utf-8",
            )
            entry = self.write_template(
                root,
                runtime_parts=["src/part.js", "src/part.js"],
            )
            with self.assertRaisesRegex(ValueError, "must not contain duplicates"):
                assemble_userscript(entry)

    def test_preassembled_custom_source_passes_through(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            source = Path(temp_dir) / "custom.user.js"
            expected = "// ==UserScript==\n// ==/UserScript==\n(() => {})();\n"
            source.write_text(expected, encoding="utf-8")
            self.assertEqual(assemble_userscript(source), expected)


if __name__ == "__main__":
    unittest.main()
