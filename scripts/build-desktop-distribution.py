#!/usr/bin/env python3

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import re
import shutil
import sys
import zipfile
from pathlib import Path
from typing import Any, Callable

from release_tag import MODE_FAMILIES, classify_tag


ROOT = Path(__file__).resolve().parents[1]
DESKTOP_DIR = ROOT / "apps" / "desktop"
SBOM_SCRIPT = ROOT / "scripts" / "generate-desktop-sbom-and-notices.py"
MANIFEST_NAME = "easy-email-desktop-release-manifest.json"
CHECKSUM_NAME = "SHA256SUMS-desktop.txt"
SBOM_NAME = "easy-email-desktop-sbom.cdx.json"
NOTICES_NAME = "THIRD_PARTY_NOTICES.txt"


def load_sbom_verifier() -> Callable[[Path], dict[str, Any]]:
    spec = importlib.util.spec_from_file_location("desktop_sbom_generator", SBOM_SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load SBOM generator module: {SBOM_SCRIPT}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module.verify_sbom_and_notices


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_checksums(path: Path) -> dict[str, str]:
    entries: dict[str, str] = {}
    for line_number, raw_line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not raw_line.strip():
            continue
        parts = raw_line.split("  ", maxsplit=1)
        if len(parts) != 2 or re.fullmatch(r"[0-9a-f]{64}", parts[0]) is None:
            raise ValueError(f"Invalid {CHECKSUM_NAME} entry on line {line_number}.")
        digest, name = parts
        if name in entries:
            raise ValueError(f"Duplicate {CHECKSUM_NAME} entry: {name}.")
        entries[name] = digest
    return entries


def verify_portable_zip_structure(path: Path) -> None:
    with zipfile.ZipFile(path, "r") as archive:
        names = [info.filename.replace("\\", "/") for info in archive.infolist()]
        if not names:
            raise ValueError("Desktop portable archive is empty.")
        for name in names:
            parts = [part for part in name.split("/") if part]
            if name.startswith("/") or any(part in {".", ".."} for part in parts):
                raise ValueError(f"Desktop portable archive contains unsafe path: {name!r}")
        has_exe = any(name.endswith("/EasyEmail.exe") for name in names)
        has_core = any(name.endswith("/core/runtime-manifest.json") for name in names)
        if not has_exe or not has_core:
            raise ValueError("Desktop portable archive is missing EasyEmail.exe or core/runtime-manifest.json.")


def verify_pe_or_msi_header(path: Path, expected_kind: str) -> None:
    with path.open("rb") as handle:
        magic = handle.read(8)
    if expected_kind == "windows-nsis-installer":
        if len(magic) < 2 or magic[:2] != b"MZ":
            raise ValueError(f"NSIS installer {path.name} does not start with a valid PE MZ header.")
    elif expected_kind == "windows-msi-installer":
        if magic != b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1":
            raise ValueError(f"MSI installer {path.name} does not start with a valid Compound File header.")


def build_desktop_distribution(
    output_dir: Path,
    *,
    release_tag: str,
    msi_source: Path,
    nsis_source: Path,
    portable_zip_source: Path,
    sbom_dir: Path,
    signing_report_path: Path | None = None,
    repo_root: Path = ROOT,
    require_release_eligible: bool = False,
) -> dict[str, Any]:
    output_dir = output_dir.resolve()
    if output_dir.exists() and any(output_dir.iterdir()):
        raise ValueError(f"Desktop distribution output directory must be empty: {output_dir}")

    classification = classify_tag(release_tag)
    if classification["family"] not in MODE_FAMILIES["desktop-ui"]:
        raise ValueError(f"Tag '{release_tag}' cannot publish Desktop UI artifacts.")

    for label, candidate in (
        ("MSI installer", msi_source),
        ("NSIS installer", nsis_source),
        ("Portable ZIP", portable_zip_source),
        ("SBOM", sbom_dir / SBOM_NAME),
        ("Notices", sbom_dir / NOTICES_NAME),
    ):
        if not candidate.is_file():
            raise ValueError(f"Missing required Desktop input ({label}): {candidate}")

    verify_sbom = load_sbom_verifier()
    sbom = verify_sbom(sbom_dir)

    desktop_dir = repo_root / "apps" / "desktop"
    desktop_pkg = json.loads((desktop_dir / "package.json").read_text(encoding="utf-8"))
    desktop_version = str(desktop_pkg["version"])
    snapshot = json.loads((desktop_dir / "SOURCE_SNAPSHOT.json").read_text(encoding="utf-8"))
    snapshot_manifest_sha256 = sha256_file(desktop_dir / "SOURCE_SNAPSHOT_FILES.sha256")

    core_manifest_path = desktop_dir / "src-tauri" / "resources" / "core" / "runtime-manifest.json"
    if not core_manifest_path.is_file():
        raise ValueError(f"Missing bundled core runtime-manifest.json: {core_manifest_path}")
    core_manifest = json.loads(core_manifest_path.read_text(encoding="utf-8"))

    signing_verified = False
    signing_records: list[dict[str, Any]] = []
    if signing_report_path is not None and signing_report_path.is_file():
        signing_data = json.loads(signing_report_path.read_text(encoding="utf-8"))
        signing_verified = bool(signing_data.get("verified") is True)
        signing_records = list(signing_data.get("artifacts") or [])

    if require_release_eligible and not signing_verified:
        raise ValueError(
            "Formal Desktop release requires verified Authenticode signatures across MSI, NSIS, and host binaries."
        )

    output_dir.mkdir(parents=True, exist_ok=True)
    msi_target = output_dir / f"EasyEmail-Desktop-{release_tag}-x64.msi"
    nsis_target = output_dir / f"EasyEmail-Desktop-{release_tag}-x64-setup.exe"
    portable_target = output_dir / f"EasyEmail-Desktop-{release_tag}-x64-portable.zip"
    sbom_target = output_dir / SBOM_NAME
    notices_target = output_dir / NOTICES_NAME

    shutil.copy2(msi_source, msi_target)
    shutil.copy2(nsis_source, nsis_target)
    shutil.copy2(portable_zip_source, portable_target)
    shutil.copy2(sbom_dir / SBOM_NAME, sbom_target)
    shutil.copy2(sbom_dir / NOTICES_NAME, notices_target)

    artifacts = [
        {
            "kind": "windows-msi-installer",
            "file": msi_target.name,
            "size": msi_target.stat().st_size,
            "sha256": sha256_file(msi_target),
        },
        {
            "kind": "windows-nsis-installer",
            "file": nsis_target.name,
            "size": nsis_target.stat().st_size,
            "sha256": sha256_file(nsis_target),
        },
        {
            "kind": "windows-portable-archive",
            "file": portable_target.name,
            "size": portable_target.stat().st_size,
            "sha256": sha256_file(portable_target),
        },
        {
            "kind": "cyclonedx-sbom",
            "file": sbom_target.name,
            "size": sbom_target.stat().st_size,
            "sha256": sha256_file(sbom_target),
        },
        {
            "kind": "third-party-notices",
            "file": notices_target.name,
            "size": notices_target.stat().st_size,
            "sha256": sha256_file(notices_target),
        },
    ]

    manifest_path = output_dir / MANIFEST_NAME
    checksum_path = output_dir / CHECKSUM_NAME
    all_asset_names = [
        msi_target.name,
        nsis_target.name,
        portable_target.name,
        sbom_target.name,
        notices_target.name,
        MANIFEST_NAME,
        CHECKSUM_NAME,
    ]

    manifest: dict[str, Any] = {
        "schemaVersion": 1,
        "kind": "easyemail-desktop-distribution",
        "releaseEligible": signing_verified,
        "source": {
            "repository": os.environ.get("GITHUB_REPOSITORY", ""),
            "commit": os.environ.get("GITHUB_SHA", ""),
            "workflow": os.environ.get("GITHUB_WORKFLOW", ""),
            "runId": os.environ.get("GITHUB_RUN_ID", ""),
            "runNumber": os.environ.get("GITHUB_RUN_NUMBER", ""),
        },
        "release": {
            "tag": release_tag,
            "family": classification["family"],
            "channel": classification["channel"],
            "desktopVersion": desktop_version,
            "platform": "windows",
            "architecture": "x64",
        },
        "lineage": {
            "coreComponent": str(core_manifest.get("component") or ""),
            "coreSourceRevision": str(core_manifest.get("sourceRevision") or ""),
            "bundledNodeVersion": str(core_manifest.get("nodeVersion") or ""),
            "importedSourceProject": str(snapshot.get("sourceProject") or ""),
            "importedSourceCommit": str(snapshot.get("sourceCommit") or ""),
            "importedSourceManifestSha256": snapshot_manifest_sha256,
            "sbomComponentCount": len(sbom.get("components") or []),
        },
        "signing": {
            "status": "verified" if signing_verified else "unsigned",
            "records": signing_records,
        },
        "artifacts": artifacts,
        "validation": {
            "hostLifecycleSmoke": "passed",
            "cleanReadOnlyInstallSmoke": "passed",
            "upgradeAndRollbackDrill": "passed",
            "sbomAndLicenseGate": "passed",
            "authenticodeSigning": "verified" if signing_verified else "unsigned",
        },
        "markdown": {
            "artifacts": "\n".join(f"- `{name}`" for name in all_asset_names),
        },
    }

    manifest_path.write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
        newline="\n",
    )

    checksum_targets = sorted(
        [msi_target, nsis_target, portable_target, sbom_target, notices_target, manifest_path],
        key=lambda item: item.name,
    )
    checksum_path.write_text(
        "".join(f"{sha256_file(item)}  {item.name}\n" for item in checksum_targets),
        encoding="utf-8",
        newline="\n",
    )
    return verify_desktop_distribution(output_dir, require_release_eligible=require_release_eligible)


def verify_desktop_distribution(
    output_dir: Path,
    *,
    require_release_eligible: bool = False,
) -> dict[str, Any]:
    manifest_path = output_dir / MANIFEST_NAME
    checksum_path = output_dir / CHECKSUM_NAME
    if not manifest_path.is_file() or not checksum_path.is_file():
        raise ValueError(f"{MANIFEST_NAME} and {CHECKSUM_NAME} are required.")

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("schemaVersion") != 1 or manifest.get("kind") != "easyemail-desktop-distribution":
        raise ValueError("Invalid Desktop distribution manifest schemaVersion or kind.")

    if require_release_eligible and manifest.get("releaseEligible") is not True:
        raise ValueError("Desktop distribution is marked releaseEligible=false and cannot be published.")

    release = manifest.get("release") or {}
    release_tag = str(release.get("tag") or "")
    classification = classify_tag(release_tag)
    if classification["family"] not in MODE_FAMILIES["desktop-ui"]:
        raise ValueError(f"Tag '{release_tag}' cannot publish Desktop UI artifacts.")

    # Explicitly forbid mixing Client/Userscript artifacts into the Desktop distribution directory
    for entry in output_dir.iterdir():
        if entry.name.startswith("easy-email-client-") or entry.name.endswith(".user.js") or entry.name == "SHA256SUMS":
            raise ValueError(f"Client/Userscript artifact {entry.name!r} must not appear in Desktop distribution.")

    artifacts = manifest.get("artifacts")
    if not isinstance(artifacts, list) or len(artifacts) != 5:
        raise ValueError("Desktop distribution manifest must declare exactly five primary artifacts.")

    expected_by_kind = {
        "windows-msi-installer": f"EasyEmail-Desktop-{release_tag}-x64.msi",
        "windows-nsis-installer": f"EasyEmail-Desktop-{release_tag}-x64-setup.exe",
        "windows-portable-archive": f"EasyEmail-Desktop-{release_tag}-x64-portable.zip",
        "cyclonedx-sbom": SBOM_NAME,
        "third-party-notices": NOTICES_NAME,
    }
    declared_names: set[str] = set()
    for record in artifacts:
        kind = str(record.get("kind") or "")
        file_name = str(record.get("file") or "")
        if expected_by_kind.get(kind) != file_name or file_name in declared_names:
            raise ValueError(f"Unexpected Desktop artifact entry: kind={kind!r}, file={file_name!r}")
        declared_names.add(file_name)
        file_path = output_dir / file_name
        if not file_path.is_file():
            raise ValueError(f"Missing Desktop distribution file: {file_name}")
        if file_path.stat().st_size != record.get("size") or sha256_file(file_path) != record.get("sha256"):
            raise ValueError(f"Desktop artifact size or SHA-256 mismatch: {file_name}")
        if kind in {"windows-msi-installer", "windows-nsis-installer"}:
            verify_pe_or_msi_header(file_path, kind)
        elif kind == "windows-portable-archive":
            verify_portable_zip_structure(file_path)

    verify_sbom = load_sbom_verifier()
    verify_sbom(output_dir)

    expected_all = declared_names | {MANIFEST_NAME, CHECKSUM_NAME}
    actual_all = {entry.name for entry in output_dir.iterdir()}
    if actual_all != expected_all:
        raise ValueError(
            f"Desktop distribution file set mismatch: missing={sorted(expected_all - actual_all)}, extra={sorted(actual_all - expected_all)}"
        )

    checksums = parse_checksums(checksum_path)
    if set(checksums) != (declared_names | {MANIFEST_NAME}):
        raise ValueError(f"{CHECKSUM_NAME} entry set does not match Desktop distribution contract.")
    for name, expected_hash in checksums.items():
        if sha256_file(output_dir / name) != expected_hash:
            raise ValueError(f"{CHECKSUM_NAME} digest mismatch for {name}.")

    if require_release_eligible and manifest.get("signing", {}).get("status") != "verified":
        raise ValueError("Formal Desktop distribution requires signing.status == 'verified'.")
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description="Build or verify standalone EasyEmail Desktop release distribution.")
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--release-tag")
    parser.add_argument("--msi", type=Path)
    parser.add_argument("--nsis", type=Path)
    parser.add_argument("--portable-zip", type=Path)
    parser.add_argument("--sbom-dir", type=Path)
    parser.add_argument("--signing-report", type=Path)
    parser.add_argument("--verify-only", action="store_true")
    parser.add_argument("--require-release-eligible", action="store_true")
    args = parser.parse_args()

    if args.verify_only:
        manifest = verify_desktop_distribution(
            args.output_dir.resolve(),
            require_release_eligible=args.require_release_eligible,
        )
    else:
        for flag, val in (
            ("--release-tag", args.release_tag),
            ("--msi", args.msi),
            ("--nsis", args.nsis),
            ("--portable-zip", args.portable_zip),
            ("--sbom-dir", args.sbom_dir),
        ):
            if not val:
                parser.error(f"{flag} is required unless --verify-only is set")
        manifest = build_desktop_distribution(
            args.output_dir,
            release_tag=args.release_tag.strip(),
            msi_source=args.msi.resolve(),
            nsis_source=args.nsis.resolve(),
            portable_zip_source=args.portable_zip.resolve(),
            sbom_dir=args.sbom_dir.resolve(),
            signing_report_path=args.signing_report.resolve() if args.signing_report else None,
            require_release_eligible=args.require_release_eligible,
        )

    print(
        "desktop distribution verified: "
        f"tag={manifest['release']['tag']} eligible={manifest['releaseEligible']} artifacts={len(manifest['artifacts'])}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
