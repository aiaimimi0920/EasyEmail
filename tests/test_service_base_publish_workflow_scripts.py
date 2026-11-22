from __future__ import annotations

import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "publish-service-base-ghcr.yml"
CHANGE_GATE_SCRIPT = ROOT / "scripts" / "resolve-service-base-change-gate.py"


def load_change_gate_module():
    spec = importlib.util.spec_from_file_location("service_base_change_gate", CHANGE_GATE_SCRIPT)
    if spec is None or spec.loader is None:
        raise AssertionError(f"unable to load {CHANGE_GATE_SCRIPT}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class ServiceBasePublishWorkflowScriptTests(unittest.TestCase):
    def test_workflow_invokes_extracted_change_gate(self) -> None:
        workflow = WORKFLOW.read_text(encoding="utf-8")

        self.assertIn("FORCE_PUBLISH: ${{ steps.release_meta.outputs.force_publish }}", workflow)
        self.assertIn("run: python scripts/resolve-service-base-change-gate.py", workflow)

    def test_change_gate_preserves_output_protocol(self) -> None:
        module = load_change_gate_module()

        forced = module.resolve_change_gate(True, [])
        detected = module.resolve_change_gate(False, ["service/base/src/index.ts"])
        skipped = module.resolve_change_gate(False, [])

        self.assertEqual(
            module.render_github_output(forced),
            "should_publish=true\nreason=force_publish\nmatched_files<<EOF\n(forced)\nEOF\n",
        )
        self.assertEqual(
            module.render_github_output(detected),
            "should_publish=true\nreason=relevant_changes_detected\nmatched_files<<EOF\n"
            "service/base/src/index.ts\nEOF\n",
        )
        self.assertEqual(
            module.render_github_output(skipped),
            "should_publish=false\nreason=no_relevant_changes\nmatched_files<<EOF\nEOF\n",
        )

    def test_change_gate_tracks_its_support_files(self) -> None:
        module = load_change_gate_module()

        self.assertIn("service/base", module.RELEVANT_PATHS)
        self.assertIn(".github/workflows/publish-service-base-ghcr.yml", module.RELEVANT_PATHS)
        self.assertIn("scripts/resolve-service-base-change-gate.py", module.RELEVANT_PATHS)

    def test_change_gate_filters_a_real_git_commit(self) -> None:
        module = load_change_gate_module()
        with tempfile.TemporaryDirectory() as temp_dir:
            repo = Path(temp_dir)
            subprocess.run(["git", "init", "--quiet"], cwd=repo, check=True)
            subprocess.run(["git", "config", "user.email", "test@example.test"], cwd=repo, check=True)
            subprocess.run(["git", "config", "user.name", "EasyEmail Test"], cwd=repo, check=True)
            (repo / "README.md").write_text("baseline\n", encoding="utf-8")
            subprocess.run(["git", "add", "README.md"], cwd=repo, check=True)
            subprocess.run(["git", "commit", "--quiet", "-m", "baseline"], cwd=repo, check=True)

            source = repo / "service" / "base" / "src" / "index.ts"
            source.parent.mkdir(parents=True)
            source.write_text("export {};\n", encoding="utf-8")
            (repo / "README.md").write_text("unrelated\n", encoding="utf-8")
            subprocess.run(["git", "add", "."], cwd=repo, check=True)
            subprocess.run(["git", "commit", "--quiet", "-m", "change"], cwd=repo, check=True)

            self.assertEqual(
                module.find_matched_files(repo, "HEAD"),
                ("service/base/src/index.ts",),
            )


if __name__ == "__main__":
    unittest.main()
