#!/usr/bin/env python3

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
from pathlib import Path
from typing import Any

from release_tag import MODE_FAMILIES, classify_tag
from userscript_release import VERSION_LINE, userscript_version, validate_template


ROOT = Path(__file__).resolve().parents[1]
CLIENT_DIR = ROOT / "clients" / "typescript"
USERSCRIPT_BUILDER = ROOT / "scripts" / "build-userscript-release.py"
MANIFEST_NAME = "easy-email-distribution-manifest.json"
CHECKSUM_NAME = "SHA256SUMS"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def run(command: list[str], *, cwd: Path) -> None:
    completed = subprocess.run(command, cwd=cwd, check=False)
    if completed.returncode != 0:
        raise RuntimeError(f"Command failed with exit code {completed.returncode}: {' '.join(command)}")


def resolve_command(*names: str) -> str:
    for name in names:
        resolved = shutil.which(name)
        if resolved:
            return resolved
    raise RuntimeError(f"Required command was not found: {', '.join(names)}")


def artifact_record(kind: str, path: Path) -> dict[str, object]:
    return {
        "kind": kind,
        "file": path.name,
        "size": path.stat().st_size,
        "sha256": sha256_file(path),
    }


def write_distribution_metadata(
    output_dir: Path,
    *,
    release_tag: str,
    client_asset: Path,
    client_package_name: str,
    client_package_version: str,
    userscript_asset: Path,
    userscript_version: str,
    source: dict[str, str] | None = None,
) -> dict[str, Any]:
    classification = classify_tag(release_tag)
    if classification["family"] not in MODE_FAMILIES["distribution"]:
        raise ValueError(f"Tag '{release_tag}' cannot publish Client/Userscript artifacts.")

    manifest: dict[str, Any] = {
        "schemaVersion": 1,
        "kind": "easyemail-client-userscript-distribution",
        "source": source or {},
        "release": {
            "tag": release_tag,
            "family": classification["family"],
            "channel": classification["channel"],
        },
        "client": {
            "packageName": client_package_name,
            "packageVersion": client_package_version,
            "serverCompatibility": "same-release",
        },
        "userscript": {
            "version": userscript_version,
            "runtimeMode": "standalone-provider-runtime",
            "configurationMode": "local-settings-or-encrypted-import-code",
        },
        "artifacts": [
            artifact_record("typescript-client", client_asset),
            artifact_record("userscript", userscript_asset),
        ],
        "validation": {
            "clientBuild": "passed",
            "clientPackage": "passed",
            "userscriptSyntax": "passed",
            "userscriptSecretBoundary": "tracked-template-placeholders-only",
        },
        "markdown": {
            "artifacts": "\n".join(
                f"- `{path.name}`"
                for path in (client_asset, userscript_asset, output_dir / MANIFEST_NAME, output_dir / CHECKSUM_NAME)
            )
        },
    }

    manifest_path = output_dir / MANIFEST_NAME
    manifest_path.write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
        newline="\n",
    )

    checksum_paths = sorted((client_asset, userscript_asset, manifest_path), key=lambda item: item.name)
    checksum_text = "".join(f"{sha256_file(path)}  {path.name}\n" for path in checksum_paths)
    (output_dir / CHECKSUM_NAME).write_text(checksum_text, encoding="utf-8", newline="\n")
    return manifest


def verify_client_archive(path: Path) -> dict[str, Any]:
    required = {
        "package/package.json",
        "package/README.md",
        "package/dist/index.js",
        "package/dist/index.d.ts",
    }
    with tarfile.open(path, mode="r:gz") as archive:
        file_members: dict[str, tarfile.TarInfo] = {}
        total_file_size = 0
        seen_names: set[str] = set()
        for member in archive.getmembers():
            raw_name = member.name
            if "\\" in raw_name:
                raise ValueError(f"Client package member uses a non-portable path: {raw_name!r}.")
            normalized_name = raw_name.rstrip("/")
            parts = normalized_name.split("/")
            if (
                not normalized_name
                or raw_name.startswith("/")
                or any(part in {"", ".", ".."} for part in parts)
                or ":" in parts[0]
                or parts[0] != "package"
            ):
                raise ValueError(f"Client package member escapes the package root: {raw_name!r}.")
            if normalized_name in seen_names:
                raise ValueError(f"Client package contains a duplicate member: {normalized_name!r}.")
            seen_names.add(normalized_name)
            if not member.isfile() and not member.isdir():
                raise ValueError(f"Client package contains a link or special member: {raw_name!r}.")
            if member.isfile():
                total_file_size += member.size
                file_members[normalized_name] = member

        if total_file_size > 50 * 1024 * 1024:
            raise ValueError("Client package exceeds the 50 MiB unpacked-size limit.")
        names = set(file_members)

        missing = sorted(required - names)
        if missing:
            raise ValueError(f"Client package is missing required files: {missing}.")

        package_file = archive.extractfile("package/package.json")
        if package_file is None:
            raise ValueError("Client package package.json could not be read.")
        package = json.loads(package_file.read().decode("utf-8"))

    forbidden = sorted(
        name for name in names
        if "/node_modules/" in name
        or Path(name).name in {".env", ".npmrc", ".yarnrc", "config.yaml", "config.yml"}
        or "/.env." in name
    )
    if forbidden:
        raise ValueError(f"Client package contains forbidden files: {forbidden}.")
    if not isinstance(package, dict):
        raise ValueError("Client package package.json must contain an object.")
    return package


def parse_checksums(path: Path) -> dict[str, str]:
    entries: dict[str, str] = {}
    for line_number, raw_line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not raw_line.strip():
            continue
        parts = raw_line.split("  ", maxsplit=1)
        if len(parts) != 2 or re.fullmatch(r"[0-9a-f]{64}", parts[0]) is None:
            raise ValueError(f"Invalid SHA256SUMS entry on line {line_number}.")
        digest, name = parts
        if name in entries:
            raise ValueError(f"Duplicate SHA256SUMS entry: {name}.")
        entries[name] = digest
    return entries


def verify_distribution(output_dir: Path) -> dict[str, Any]:
    manifest_path = output_dir / MANIFEST_NAME
    checksum_path = output_dir / CHECKSUM_NAME
    if not manifest_path.is_file() or not checksum_path.is_file():
        raise ValueError("Distribution manifest and SHA256SUMS are required.")

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("schemaVersion") != 1:
        raise ValueError("Unsupported distribution manifest schemaVersion.")
    if manifest.get("kind") != "easyemail-client-userscript-distribution":
        raise ValueError("Unexpected distribution manifest kind.")

    release = manifest.get("release")
    if not isinstance(release, dict) or not isinstance(release.get("tag"), str):
        raise ValueError("Distribution manifest must declare a release tag.")
    release_tag = release["tag"]
    classification = classify_tag(release_tag)
    if classification["family"] not in MODE_FAMILIES["distribution"]:
        raise ValueError(f"Tag '{release_tag}' cannot publish Client/Userscript artifacts.")
    if release.get("family") != classification["family"] or release.get("channel") != classification["channel"]:
        raise ValueError("Distribution release classification does not match its tag.")

    artifacts = manifest.get("artifacts")
    if not isinstance(artifacts, list) or len(artifacts) != 2:
        raise ValueError("Distribution manifest must declare exactly two primary artifacts.")

    declared_names: set[str] = set()
    kind_to_path: dict[str, Path] = {}
    for record in artifacts:
        if not isinstance(record, dict):
            raise ValueError("Distribution artifact records must be objects.")
        name = str(record.get("file") or "")
        kind = str(record.get("kind") or "")
        if not name or Path(name).name != name or name in declared_names:
            raise ValueError(f"Invalid or duplicate distribution artifact name: {name!r}.")
        declared_names.add(name)
        artifact_path = output_dir / name
        if not artifact_path.is_file():
            raise ValueError(f"Missing distribution artifact: {name}.")
        if artifact_path.stat().st_size != record.get("size"):
            raise ValueError(f"Distribution artifact size mismatch: {name}.")
        if sha256_file(artifact_path) != record.get("sha256"):
            raise ValueError(f"Distribution artifact checksum mismatch: {name}.")
        kind_to_path[kind] = artifact_path

    expected_files = declared_names | {MANIFEST_NAME, CHECKSUM_NAME}
    actual_entries = {path.name for path in output_dir.iterdir()}
    if actual_entries != expected_files:
        raise ValueError(
            "Distribution file set mismatch: "
            f"missing={sorted(expected_files - actual_entries)}, extra={sorted(actual_entries - expected_files)}."
        )

    checksums = parse_checksums(checksum_path)
    expected_checksum_names = declared_names | {MANIFEST_NAME}
    if set(checksums) != expected_checksum_names:
        raise ValueError("SHA256SUMS artifact set does not match the distribution contract.")
    for name, expected_digest in checksums.items():
        if sha256_file(output_dir / name) != expected_digest:
            raise ValueError(f"SHA256SUMS checksum mismatch: {name}.")

    client_path = kind_to_path.get("typescript-client")
    userscript_path = kind_to_path.get("userscript")
    if client_path is None or userscript_path is None:
        raise ValueError("Distribution must contain one TypeScript client and one Userscript.")
    if client_path.name != f"easy-email-client-{release_tag}.tgz":
        raise ValueError("TypeScript client artifact name does not match the release tag.")
    if userscript_path.name != f"easy-email-userscript-{release_tag}.user.js":
        raise ValueError("Userscript artifact name does not match the release tag.")

    package = verify_client_archive(client_path)
    client = manifest.get("client")
    if not isinstance(client, dict):
        raise ValueError("Distribution manifest must declare client metadata.")
    if client.get("packageName") != package.get("name") or client.get("packageVersion") != package.get("version"):
        raise ValueError("Distribution client metadata does not match package.json.")
    if client.get("serverCompatibility") != "same-release":
        raise ValueError("Unsupported TypeScript client server compatibility contract.")

    userscript_text = userscript_path.read_text(encoding="utf-8")
    if "// ==UserScript==" not in userscript_text:
        raise ValueError("Userscript artifact is missing its metadata block.")
    validate_template(userscript_text)
    version_match = VERSION_LINE.search(userscript_text)
    if version_match is None or version_match.group(0).split(maxsplit=2)[-1] != userscript_version(release_tag):
        raise ValueError("Userscript metadata version does not match the release tag.")
    userscript = manifest.get("userscript")
    if not isinstance(userscript, dict) or userscript.get("version") != userscript_version(release_tag):
        raise ValueError("Distribution Userscript metadata does not match the release artifact.")
    if userscript.get("runtimeMode") != "standalone-provider-runtime":
        raise ValueError("Unsupported Userscript runtime mode.")
    return manifest


def build_distribution(output_dir: Path, release_tag: str) -> dict[str, Any]:
    output_dir = output_dir.resolve()
    if output_dir.exists() and any(output_dir.iterdir()):
        raise ValueError(f"Distribution output directory must be empty: {output_dir}")
    output_dir.mkdir(parents=True, exist_ok=True)

    classification = classify_tag(release_tag)
    if classification["family"] not in MODE_FAMILIES["distribution"]:
        raise ValueError(f"Tag '{release_tag}' cannot publish Client/Userscript artifacts.")

    npm = resolve_command("npm.cmd", "npm")
    node = resolve_command("node.exe", "node")
    run([npm, "run", "build"], cwd=CLIENT_DIR)

    package = json.loads((CLIENT_DIR / "package.json").read_text(encoding="utf-8"))
    package_name = str(package["name"])
    package_version = str(package["version"])
    run([npm, "pack", "--pack-destination", str(output_dir)], cwd=CLIENT_DIR)
    packed_name = f"{package_name}-{package_version}.tgz"
    packed_path = output_dir / packed_name
    if not packed_path.is_file():
        raise RuntimeError(f"npm pack did not create the expected archive: {packed_path}")
    client_asset = output_dir / f"easy-email-client-{release_tag}.tgz"
    packed_path.replace(client_asset)

    userscript_asset = output_dir / f"easy-email-userscript-{release_tag}.user.js"
    run(
        [
            sys.executable,
            str(USERSCRIPT_BUILDER),
            "--release-tag",
            release_tag,
            "--output",
            str(userscript_asset),
        ],
        cwd=ROOT,
    )
    run([node, "--check", str(userscript_asset)], cwd=ROOT)

    userscript_text = userscript_asset.read_text(encoding="utf-8")
    version_line = next(
        line for line in userscript_text.splitlines() if line.startswith("// @version")
    )
    userscript_release_version = version_line.split(maxsplit=2)[-1]
    source = {
        "repository": os.environ.get("GITHUB_REPOSITORY", ""),
        "commit": os.environ.get("GITHUB_SHA", ""),
        "workflow": os.environ.get("GITHUB_WORKFLOW", ""),
        "runId": os.environ.get("GITHUB_RUN_ID", ""),
        "runNumber": os.environ.get("GITHUB_RUN_NUMBER", ""),
    }
    write_distribution_metadata(
        output_dir,
        release_tag=release_tag,
        client_asset=client_asset,
        client_package_name=package_name,
        client_package_version=package_version,
        userscript_asset=userscript_asset,
        userscript_version=userscript_release_version,
        source=source,
    )
    return verify_distribution(output_dir)


def main() -> int:
    parser = argparse.ArgumentParser(description="Build or verify EasyEmail Client/Userscript distribution assets.")
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--release-tag")
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()

    if args.verify_only:
        manifest = verify_distribution(args.output_dir.resolve())
    else:
        if not args.release_tag:
            parser.error("--release-tag is required unless --verify-only is used")
        manifest = build_distribution(args.output_dir, args.release_tag.strip())

    print(
        "distribution verified: "
        f"tag={manifest['release']['tag']} artifacts={len(manifest['artifacts'])}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
