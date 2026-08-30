from __future__ import annotations

import importlib.util
import io
import json
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = ROOT / "scripts" / "build-distribution.py"


def load_script_module():
    spec = importlib.util.spec_from_file_location("build_distribution", SCRIPT_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load {SCRIPT_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(SCRIPT_PATH.parent))
    try:
        spec.loader.exec_module(module)
    finally:
        sys.path.pop(0)
    return module


def write_client_archive(
    path: Path,
    *,
    extra_file_name: str | None = None,
    link_name: str | None = None,
    duplicate_package_json: bool = False,
) -> None:
    files = {
        "package/package.json": b'{"name":"easy-email-client","version":"0.1.0"}\n',
        "package/README.md": b"# EasyEmail Client\n",
        "package/dist/index.js": b"export {};\n",
        "package/dist/index.d.ts": b"export {};\n",
    }
    with tarfile.open(path, mode="w:gz") as archive:
        for name, content in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(content)
            archive.addfile(info, io.BytesIO(content))
        if extra_file_name is not None:
            content = b"unexpected\n"
            info = tarfile.TarInfo(extra_file_name)
            info.size = len(content)
            archive.addfile(info, io.BytesIO(content))
        if link_name is not None:
            info = tarfile.TarInfo(link_name)
            info.type = tarfile.SYMTYPE
            info.linkname = "../../outside"
            archive.addfile(info)
        if duplicate_package_json:
            content = files["package/package.json"]
            info = tarfile.TarInfo("package/package.json")
            info.size = len(content)
            archive.addfile(info, io.BytesIO(content))


class DistributionContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.module = load_script_module()

    def create_distribution(self, root: Path) -> None:
        client = root / "easy-email-client-v1.2.3.tgz"
        userscript = root / "easy-email-userscript-v1.2.3.user.js"
        write_client_archive(client)
        sensitive_defaults = "\n".join(
            f"  {key}: '{value}',"
            for key, value in self.module.validate_template.__globals__["SENSITIVE_DEFAULTS"].items()
        )
        userscript.write_text(
            f"// ==UserScript==\n// @version      1.2.3\n// ==/UserScript==\n{sensitive_defaults}\n",
            encoding="utf-8",
        )
        self.module.write_distribution_metadata(
            root,
            release_tag="v1.2.3",
            client_asset=client,
            client_package_name="easy-email-client",
            client_package_version="0.1.0",
            userscript_asset=userscript,
            userscript_version="1.2.3",
        )

    def test_distribution_verifier_accepts_the_exact_artifact_set(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            self.create_distribution(root)
            manifest = self.module.verify_distribution(root)

        self.assertEqual(manifest["release"]["tag"], "v1.2.3")
        self.assertEqual(len(manifest["artifacts"]), 2)

    def test_distribution_verifier_rejects_tampering(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            self.create_distribution(root)
            (root / "easy-email-userscript-v1.2.3.user.js").write_text(
                "// tampered\n",
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "size mismatch|checksum mismatch"):
                self.module.verify_distribution(root)

    def test_distribution_verifier_rejects_extra_files(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            self.create_distribution(root)
            (root / "unexpected.txt").write_text("unexpected", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "file set mismatch"):
                self.module.verify_distribution(root)

    def test_distribution_verifier_rejects_extra_directories(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            self.create_distribution(root)
            (root / "unexpected").mkdir()
            with self.assertRaisesRegex(ValueError, "file set mismatch"):
                self.module.verify_distribution(root)

    def test_client_archive_rejects_path_traversal_and_links(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            traversal_archive = root / "traversal.tgz"
            link_archive = root / "link.tgz"
            write_client_archive(traversal_archive, extra_file_name="../outside.txt")
            write_client_archive(link_archive, link_name="package/dist/link.js")

            with self.assertRaisesRegex(ValueError, "escapes the package root"):
                self.module.verify_client_archive(traversal_archive)
            with self.assertRaisesRegex(ValueError, "link or special member"):
                self.module.verify_client_archive(link_archive)

    def test_client_archive_rejects_duplicate_members(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            archive = Path(temp_dir) / "duplicate.tgz"
            write_client_archive(archive, duplicate_package_json=True)
            with self.assertRaisesRegex(ValueError, "duplicate member"):
                self.module.verify_client_archive(archive)

    def test_manifest_contains_no_implicit_secret_fields(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            self.create_distribution(root)
            manifest_text = (root / self.module.MANIFEST_NAME).read_text(encoding="utf-8")
            payload = json.loads(manifest_text)

        self.assertNotIn("apiKey", manifest_text)
        self.assertNotIn("token", manifest_text.lower())
        self.assertEqual(
            payload["userscript"]["configurationMode"],
            "local-settings-or-encrypted-import-code",
        )


if __name__ == "__main__":
    unittest.main()
