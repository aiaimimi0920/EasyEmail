#!/usr/bin/env python3

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
SBOM_FILENAME = "easy-email-desktop-sbom.cdx.json"
NOTICES_FILENAME = "THIRD_PARTY_NOTICES.txt"
FORBIDDEN_LICENSE_TOKENS = (
    "AGPL",
    "GPL",
    "LGPL-3",
    "SSPL",
    "BUSL",
    "BSL-1.1",
    "EUPL",
    "CPAL",
    "OSL",
    "SLEEPYCAT",
    "WATCOM",
    "CC-BY-NC",
    "CC-BY-ND",
    "PROPRIETARY",
    "UNLICENSED",
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_license_expression(component_id: str, raw_license: str | None) -> str:
    expression = (raw_license or "").strip()
    if not expression or expression.upper() in {"UNKNOWN", "NONE", "SEE LICENSE"}:
        raise ValueError(f"Missing or ambiguous license metadata for component: {component_id}")

    upper = expression.upper()
    # Allow dual/multi-licensed expressions such as 'MIT OR Apache-2.0' or '(MIT OR Apache-2.0) AND Unicode-3.0'
    # when at least one branch in an OR clause is free of forbidden copyleft/commercial-restricted tokens,
    # unless a forbidden token is unconditionally required via AND or sole license.
    clauses = [clause.strip(" ()") for clause in re.split(r"\s+AND\s+", upper)]
    for clause in clauses:
        alternatives = [alt.strip(" ()") for alt in re.split(r"\s+OR\s+|/", clause) if alt.strip(" ()")]
        if not alternatives:
            raise ValueError(f"Empty license clause in {component_id}: {expression!r}")
        if all(
            any(forbidden in alt for forbidden in FORBIDDEN_LICENSE_TOKENS)
            for alt in alternatives
        ):
            raise ValueError(
                f"Incompatible or restricted license for {component_id}: {expression!r}"
            )
    return expression


def collect_npm_runtime_components(lockfile_path: Path, scope_label: str) -> list[dict[str, Any]]:
    if not lockfile_path.is_file():
        raise ValueError(f"Missing npm lockfile: {lockfile_path}")
    lock_data = json.loads(lockfile_path.read_text(encoding="utf-8"))
    packages = lock_data.get("packages")
    if not isinstance(packages, dict):
        raise ValueError(f"Lockfile v2/v3 packages map missing in {lockfile_path}")

    seen: dict[tuple[str, str], dict[str, Any]] = {}
    package_root = lockfile_path.parent
    for pkg_key, meta in sorted(packages.items()):
        if not pkg_key or not isinstance(meta, dict):
            continue
        if meta.get("dev") is True or meta.get("devOptional") is True:
            continue
        if not pkg_key.startswith("node_modules/"):
            continue
        parts = pkg_key.split("node_modules/")
        name = parts[-1]
        version = str(meta.get("version") or "").strip()
        if not name or not version:
            raise ValueError(f"Incomplete npm package entry {pkg_key!r} in {lockfile_path}")

        raw_license = meta.get("license")
        if isinstance(raw_license, dict):
            raw_license = raw_license.get("type")
        if not raw_license:
            installed_pkg_json = package_root / pkg_key / "package.json"
            if installed_pkg_json.is_file():
                installed_meta = json.loads(installed_pkg_json.read_text(encoding="utf-8"))
                lic = installed_meta.get("license")
                if isinstance(lic, dict):
                    lic = lic.get("type")
                raw_license = lic

        validated_license = validate_license_expression(
            f"npm:{name}@{version} ({scope_label})",
            str(raw_license) if raw_license is not None else None,
        )
        dedup_key = (name, version)
        if dedup_key not in seen:
            seen[dedup_key] = {
                "type": "library",
                "ecosystem": "npm",
                "scope": scope_label,
                "name": name,
                "version": version,
                "purl": f"pkg:npm/{name.replace('@', '%40')}@{version}",
                "license": validated_license,
                "integrity": str(meta.get("integrity") or ""),
            }
    return [seen[key] for key in sorted(seen)]


def load_cargo_metadata(cargo_manifest: Path, metadata_override: Path | None) -> dict[str, Any]:
    if metadata_override is not None:
        return json.loads(metadata_override.read_text(encoding="utf-8"))
    completed = subprocess.run(
        [
            "cargo",
            "metadata",
            "--manifest-path",
            str(cargo_manifest),
            "--format-version",
            "1",
            "--locked",
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(f"cargo metadata failed: {completed.stderr.strip()}")
    return json.loads(completed.stdout)


def collect_cargo_components(
    cargo_manifest: Path,
    metadata_override: Path | None = None,
) -> list[dict[str, Any]]:
    metadata = load_cargo_metadata(cargo_manifest, metadata_override)
    packages = metadata.get("packages")
    workspace_members = set(metadata.get("workspace_members") or [])
    if not isinstance(packages, list):
        raise ValueError("Invalid cargo metadata: packages list missing")

    seen: dict[tuple[str, str], dict[str, Any]] = {}
    for pkg in packages:
        if not isinstance(pkg, dict):
            continue
        pkg_id = str(pkg.get("id") or "")
        name = str(pkg.get("name") or "").strip()
        version = str(pkg.get("version") or "").strip()
        if pkg_id in workspace_members or name == "easyemailam":
            continue
        if not name or not version:
            raise ValueError(f"Incomplete crate metadata entry: {pkg_id!r}")

        raw_license = pkg.get("license")
        if not raw_license and pkg.get("license_file"):
            raw_license = f"Custom-License-File({Path(str(pkg['license_file'])).name})"
        validated_license = validate_license_expression(
            f"crate:{name}@{version}",
            str(raw_license) if raw_license is not None else None,
        )
        dedup_key = (name, version)
        if dedup_key not in seen:
            seen[dedup_key] = {
                "type": "library",
                "ecosystem": "cargo",
                "scope": "desktop-tauri-host",
                "name": name,
                "version": version,
                "purl": f"pkg:cargo/{name}@{version}",
                "license": validated_license,
                "source": str(pkg.get("source") or ""),
            }
    return [seen[key] for key in sorted(seen)]


def collect_bundled_core_runtime(core_dir: Path) -> dict[str, Any]:
    manifest_path = core_dir / "runtime-manifest.json"
    if not manifest_path.is_file():
        raise ValueError(f"Bundled core runtime-manifest.json is missing: {manifest_path}")
    runtime_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    runtime_rel = str(runtime_manifest.get("runtime") or "")
    entry_rel = str(runtime_manifest.get("entry") or "")
    node_version = str(runtime_manifest.get("nodeVersion") or "").strip().lstrip("v")
    if not runtime_rel or not entry_rel or not node_version:
        raise ValueError("Bundled core runtime-manifest.json is incomplete.")

    runtime_bin = core_dir / runtime_rel
    entry_js = core_dir / entry_rel
    if not runtime_bin.is_file() or not entry_js.is_file():
        raise ValueError("Bundled core runtime binary or entrypoint is missing.")

    return {
        "type": "application",
        "ecosystem": "nodejs-runtime",
        "scope": "bundled-private-core-runtime",
        "name": "nodejs",
        "version": node_version,
        "purl": f"pkg:generic/nodejs@{node_version}?os={runtime_manifest.get('platform')}&arch={runtime_manifest.get('architecture')}",
        "license": validate_license_expression(f"nodejs@{node_version}", "MIT AND Apache-2.0 AND ISC AND BSD-3-Clause"),
        "runtimeSha256": sha256_file(runtime_bin),
        "entrySha256": sha256_file(entry_js),
        "sourceRevision": str(runtime_manifest.get("sourceRevision") or "unknown"),
    }


def collect_imported_source_lineage(desktop_dir: Path) -> dict[str, Any]:
    snapshot_path = desktop_dir / "SOURCE_SNAPSHOT.json"
    manifest_path = desktop_dir / "SOURCE_SNAPSHOT_FILES.sha256"
    if not snapshot_path.is_file() or not manifest_path.is_file():
        raise ValueError("Desktop SOURCE_SNAPSHOT.json or SOURCE_SNAPSHOT_FILES.sha256 is missing.")
    snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
    source_project = str(snapshot.get("sourceProject") or "").strip()
    source_commit = str(snapshot.get("sourceCommit") or "").strip()
    if not source_project or not source_commit:
        raise ValueError("Desktop SOURCE_SNAPSHOT.json must record sourceProject and sourceCommit.")

    return {
        "type": "application",
        "ecosystem": "first-party-import",
        "scope": "desktop-imported-ui-lineage",
        "name": source_project,
        "version": source_commit,
        "purl": f"pkg:generic/{source_project.lower()}@{source_commit}",
        "license": "First-Party-EasyEmail-Project",
        "fileManifestSha256": sha256_file(manifest_path),
        "copiedFileCount": int(snapshot.get("copiedFileCount") or 0),
    }


def collect_packaged_files(bundle_dir: Path | None) -> list[dict[str, Any]]:
    if bundle_dir is None or not bundle_dir.is_dir():
        return []
    records: list[dict[str, Any]] = []
    for path in sorted(bundle_dir.rglob("*")):
        if not path.is_file():
            continue
        if path.suffix.lower() not in {".msi", ".exe", ".zip"}:
            continue
        if ".portable-stage-" in path.as_posix():
            continue
        records.append(
            {
                "file": path.relative_to(bundle_dir).as_posix(),
                "size": path.stat().st_size,
                "sha256": sha256_file(path),
            }
        )
    return records


def build_sbom_and_notices(
    output_dir: Path,
    *,
    repo_root: Path = ROOT,
    core_dir: Path | None = None,
    bundle_dir: Path | None = None,
    cargo_metadata_json: Path | None = None,
    git_commit: str = "",
) -> tuple[Path, Path]:
    desktop_dir = repo_root / "apps" / "desktop"
    service_dir = repo_root / "service" / "base"
    resolved_core_dir = core_dir or (desktop_dir / "src-tauri" / "resources" / "core")
    desktop_pkg = json.loads((desktop_dir / "package.json").read_text(encoding="utf-8"))
    desktop_version = str(desktop_pkg.get("version") or "0.1.0")

    imported_lineage = collect_imported_source_lineage(desktop_dir)
    node_runtime = collect_bundled_core_runtime(resolved_core_dir)
    service_npm = collect_npm_runtime_components(
        service_dir / "package-lock.json",
        "service-base-runtime",
    )
    desktop_npm = collect_npm_runtime_components(
        desktop_dir / "package-lock.json",
        "desktop-frontend-runtime",
    )
    cargo_crates = collect_cargo_components(
        desktop_dir / "src-tauri" / "Cargo.toml",
        cargo_metadata_json,
    )
    packaged_files = collect_packaged_files(bundle_dir)

    all_components = [imported_lineage, node_runtime, *service_npm, *desktop_npm, *cargo_crates]
    cdx_components: list[dict[str, Any]] = []
    for item in all_components:
        comp: dict[str, Any] = {
            "type": item["type"],
            "name": item["name"],
            "version": item["version"],
            "purl": item["purl"],
            "licenses": [{"license": {"name": item["license"]}}],
            "properties": [
                {"name": "easyemail:ecosystem", "value": item["ecosystem"]},
                {"name": "easyemail:scope", "value": item["scope"]},
            ],
        }
        if item.get("runtimeSha256"):
            comp["hashes"] = [{"alg": "SHA-256", "content": item["runtimeSha256"]}]
        elif item.get("fileManifestSha256"):
            comp["hashes"] = [{"alg": "SHA-256", "content": item["fileManifestSha256"]}]
        cdx_components.append(comp)

    sbom: dict[str, Any] = {
        "bomFormat": "CycloneDX",
        "specVersion": "1.5",
        "version": 1,
        "metadata": {
            "component": {
                "type": "application",
                "name": "easyemail-desktop",
                "version": desktop_version,
                "licenses": [{"license": {"name": "First-Party-EasyEmail-Project"}}],
            },
            "properties": [
                {"name": "easyemail:gitCommit", "value": git_commit or "workspace"},
                {"name": "easyemail:coreSourceRevision", "value": node_runtime["sourceRevision"]},
                {"name": "easyemail:importedSourceProject", "value": imported_lineage["name"]},
                {"name": "easyemail:importedSourceCommit", "value": imported_lineage["version"]},
                {"name": "easyemail:componentCount", "value": str(len(cdx_components))},
            ],
        },
        "components": cdx_components,
        "packagedArtifacts": packaged_files,
    }

    output_dir.mkdir(parents=True, exist_ok=True)
    sbom_path = output_dir / SBOM_FILENAME
    notices_path = output_dir / NOTICES_FILENAME

    sbom_path.write_text(
        json.dumps(sbom, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
        newline="\n",
    )

    notice_lines = [
        "EasyEmail Desktop (NMail) - Third-Party Software Notices and Lineage",
        "====================================================================",
        "",
        f"Desktop Version: {desktop_version}",
        f"Repository Commit: {git_commit or 'workspace'}",
        f"Core Source Revision: {node_runtime['sourceRevision']}",
        f"Imported UI Lineage: {imported_lineage['name']} @ {imported_lineage['version']} "
        f"(manifest sha256: {imported_lineage['fileManifestSha256']})",
        "",
        "1. Bundled Private Node.js Runtime",
        "----------------------------------",
        f"- nodejs {node_runtime['version']} ({node_runtime['license']})",
        f"  runtime sha256: {node_runtime['runtimeSha256']}",
        "  Node.js includes components under MIT, Apache-2.0, ISC, BSD, and ICU/OpenSSL permissive terms.",
        "",
        f"2. Service Core Production npm Packages ({len(service_npm)})",
        "-------------------------------------------",
        *[f"- {c['name']}@{c['version']} — License: {c['license']}" for c in service_npm],
        "",
        f"3. Desktop Renderer Production npm Packages ({len(desktop_npm)})",
        "-----------------------------------------------",
        *[f"- {c['name']}@{c['version']} — License: {c['license']}" for c in desktop_npm],
        "",
        f"4. Tauri Host Rust Crates ({len(cargo_crates)})",
        "-----------------------------",
        *[f"- {c['name']}@{c['version']} — License: {c['license']}" for c in cargo_crates],
        "",
    ]
    notices_path.write_text("\n".join(notice_lines), encoding="utf-8", newline="\n")
    return sbom_path, notices_path


def verify_sbom_and_notices(output_dir: Path) -> dict[str, Any]:
    sbom_path = output_dir / SBOM_FILENAME
    notices_path = output_dir / NOTICES_FILENAME
    if not sbom_path.is_file() or not notices_path.is_file():
        raise ValueError("Desktop SBOM and THIRD_PARTY_NOTICES.txt are both required.")

    sbom = json.loads(sbom_path.read_text(encoding="utf-8"))
    if sbom.get("bomFormat") != "CycloneDX" or sbom.get("specVersion") != "1.5":
        raise ValueError("Invalid CycloneDX SBOM header.")
    components = sbom.get("components")
    if not isinstance(components, list) or len(components) < 5:
        raise ValueError("Desktop SBOM component inventory is incomplete.")

    ecosystems: set[str] = set()
    for comp in components:
        if not isinstance(comp, dict):
            raise ValueError("SBOM component must be an object.")
        name = str(comp.get("name") or "")
        version = str(comp.get("version") or "")
        licenses = comp.get("licenses") or []
        if not name or not version or not licenses:
            raise ValueError(f"SBOM component {name!r} is missing version or license.")
        lic_name = str(licenses[0].get("license", {}).get("name") or "")
        if lic_name != "First-Party-EasyEmail-Project":
            validate_license_expression(f"{name}@{version}", lic_name)
        for prop in comp.get("properties") or []:
            if prop.get("name") == "easyemail:ecosystem":
                ecosystems.add(str(prop.get("value") or ""))

    required_ecosystems = {"first-party-import", "nodejs-runtime", "npm", "cargo"}
    missing = required_ecosystems - ecosystems
    if missing:
        raise ValueError(f"SBOM is missing required lineage ecosystems: {sorted(missing)}")

    notices_text = notices_path.read_text(encoding="utf-8")
    for heading in (
        "1. Bundled Private Node.js Runtime",
        "2. Service Core Production npm Packages",
        "3. Desktop Renderer Production npm Packages",
        "4. Tauri Host Rust Crates",
    ):
        if heading not in notices_text:
            raise ValueError(f"THIRD_PARTY_NOTICES.txt missing section: {heading}")
    return sbom


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate or verify EasyEmail Desktop SBOM and NOTICE files.")
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--repo-root", type=Path, default=ROOT)
    parser.add_argument("--core-dir", type=Path)
    parser.add_argument("--bundle-dir", type=Path)
    parser.add_argument("--cargo-metadata-json", type=Path)
    parser.add_argument("--git-commit", default="")
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()

    if args.verify_only:
        sbom = verify_sbom_and_notices(args.output_dir.resolve())
    else:
        build_sbom_and_notices(
            args.output_dir.resolve(),
            repo_root=args.repo_root.resolve(),
            core_dir=args.core_dir.resolve() if args.core_dir else None,
            bundle_dir=args.bundle_dir.resolve() if args.bundle_dir else None,
            cargo_metadata_json=args.cargo_metadata_json.resolve() if args.cargo_metadata_json else None,
            git_commit=args.git_commit.strip(),
        )
        sbom = verify_sbom_and_notices(args.output_dir.resolve())

    print(f"desktop sbom verified: components={len(sbom['components'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
