from __future__ import annotations

import importlib.util
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
VALIDATOR = ROOT / "scripts" / "validate-release-contract.py"


def load_validator_module():
    spec = importlib.util.spec_from_file_location("release_contract_validator", VALIDATOR)
    if spec is None or spec.loader is None:
        raise AssertionError(f"unable to load {VALIDATOR}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class ReleaseContractTests(unittest.TestCase):
    def test_script_backed_workflow_outputs_are_validated(self) -> None:
        validator = load_validator_module()
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            workflow = root / ".github" / "workflows" / "release.yml"
            script = root / "scripts" / "resolve.py"
            workflow.parent.mkdir(parents=True)
            script.parent.mkdir(parents=True)
            workflow_text = "run: python scripts/resolve.py\n"
            workflow.write_text(workflow_text, encoding="utf-8")
            script.write_text(
                'metadata = {"release_tag": "v1"}\n'
                'output_path = Path(os.environ["GITHUB_OUTPUT"])\n'
                'with output_path.open("a", encoding="utf-8") as output:\n'
                '    output.write(f"release_tag={metadata[\'release_tag\']}\\n")\n',
                encoding="utf-8",
            )

            sources = validator.collect_workflow_sources(workflow, workflow_text, root)

            self.assertTrue(validator.sources_write_github_output(sources, "release_tag"))
            self.assertFalse(validator.sources_write_github_output(sources, "version"))

    def test_metadata_without_an_output_write_is_rejected(self) -> None:
        validator = load_validator_module()
        sources = [
            (Path("resolve.py"), 'metadata = {"release_tag": "v1"}\noutput = os.environ["GITHUB_OUTPUT"]\n')
        ]

        self.assertFalse(validator.sources_write_github_output(sources, "release_tag"))

    def test_missing_referenced_workflow_script_is_rejected(self) -> None:
        validator = load_validator_module()
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            workflow = root / "release.yml"
            workflow_text = "run: python scripts/missing.py\n"

            with self.assertRaisesRegex(AssertionError, "missing local script"):
                validator.collect_workflow_sources(workflow, workflow_text, root)

    def test_repository_release_contract_is_current(self) -> None:
        completed = subprocess.run(
            [sys.executable, "scripts/validate-release-contract.py"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)


if __name__ == "__main__":
    unittest.main()
