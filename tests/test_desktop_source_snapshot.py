from __future__ import annotations

import json
import re
import unittest
from pathlib import Path, PurePosixPath


ROOT = Path(__file__).resolve().parents[1]
DESKTOP = ROOT / "apps" / "desktop"
SNAPSHOT = DESKTOP / "SOURCE_SNAPSHOT.json"
HASH_MANIFEST = DESKTOP / "SOURCE_SNAPSHOT_FILES.sha256"
HASH_LINE = re.compile(r"^[0-9a-f]{64}  (.+)$")


class DesktopSourceSnapshotTests(unittest.TestCase):
    def test_snapshot_records_reversible_dirty_worktree_import(self) -> None:
        snapshot = json.loads(SNAPSHOT.read_text(encoding="utf-8"))

        self.assertEqual(snapshot["sourceProject"], "EasyEmailAM")
        self.assertEqual(snapshot["sourceBranch"], "foundation")
        self.assertEqual(snapshot["sourceCommit"], "34838bc")
        self.assertTrue(snapshot["sourceWorktreeDirty"])
        self.assertEqual(snapshot["destination"], "apps/desktop")
        self.assertEqual(snapshot["copiedFileCount"], 182)
        self.assertEqual(snapshot["baselineVerification"]["result"], "passed")

    def test_hash_manifest_is_safe_complete_and_deterministic(self) -> None:
        lines = HASH_MANIFEST.read_text(encoding="utf-8").splitlines()
        paths: list[str] = []

        for line in lines:
            matched = HASH_LINE.fullmatch(line)
            self.assertIsNotNone(matched, line)
            path = matched.group(1)
            pure_path = PurePosixPath(path)
            self.assertFalse(pure_path.is_absolute(), path)
            self.assertNotIn("..", pure_path.parts)
            self.assertNotIn("node_modules", pure_path.parts)
            self.assertNotIn("target", pure_path.parts)
            paths.append(path)

        self.assertEqual(len(paths), 182)
        self.assertEqual(len(paths), len(set(paths)))
        self.assertIn("src/App.tsx", paths)
        self.assertIn("src-tauri/src/lib.rs", paths)
        self.assertIn("docs/reviews/2026-08-15-code-review-and-optimization.md", paths)


if __name__ == "__main__":
    unittest.main()
