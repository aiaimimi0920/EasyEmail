from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any


ENTRY_MARKER = re.compile(
    r"^// @easyemail-template-manifest\s+(\S+)\s*$",
    re.MULTILINE,
)
IIFE_PREFIX = "\n\n(function () {\n  'use strict';\n\n"
IIFE_SUFFIX = "})();\n"


def _read_utf8_lf(path: Path, label: str) -> str:
    try:
        raw = path.read_bytes()
    except OSError as error:
        raise ValueError(f"Unable to read Userscript {label}: {path}") from error
    if raw.startswith(b"\xef\xbb\xbf"):
        raise ValueError(f"Userscript {label} must be UTF-8 without BOM: {path}")
    try:
        return raw.decode("utf-8").replace("\r\n", "\n").replace("\r", "\n")
    except UnicodeDecodeError as error:
        raise ValueError(f"Userscript {label} must be valid UTF-8: {path}") from error


def _resolve_component(root: Path, relative: object, label: str) -> Path:
    if not isinstance(relative, str) or not relative.strip():
        raise ValueError(f"Userscript manifest {label} must be a non-empty relative path.")
    candidate = (root / relative).resolve()
    try:
        candidate.relative_to(root)
    except ValueError as error:
        raise ValueError(f"Userscript manifest {label} escapes its directory: {relative}") from error
    if not candidate.is_file():
        raise ValueError(f"Userscript manifest {label} does not exist: {candidate}")
    return candidate


def _read_manifest(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(_read_utf8_lf(path, "manifest"))
    except json.JSONDecodeError as error:
        raise ValueError(f"Userscript manifest is invalid JSON: {path}") from error
    if not isinstance(payload, dict) or payload.get("schemaVersion") != 1:
        raise ValueError("Userscript manifest must be an object with schemaVersion 1.")
    return payload


def assemble_userscript(source: Path) -> str:
    source = source.resolve()
    entry_text = _read_utf8_lf(source, "source")
    markers = ENTRY_MARKER.findall(entry_text)
    if not markers:
        return entry_text
    if len(markers) != 1:
        raise ValueError("Userscript source must contain at most one template manifest marker.")

    source_root = source.parent.resolve()
    manifest_path = _resolve_component(source_root, markers[0], "path")
    manifest = _read_manifest(manifest_path)
    metadata_path = _resolve_component(source_root, manifest.get("metadata"), "metadata")
    runtime_parts = manifest.get("runtimeParts")
    if not isinstance(runtime_parts, list) or not runtime_parts:
        raise ValueError("Userscript manifest runtimeParts must be a non-empty list.")
    if not all(isinstance(relative, str) and relative.strip() for relative in runtime_parts):
        raise ValueError("Userscript manifest runtimeParts must contain only non-empty paths.")
    if len(runtime_parts) != len(set(runtime_parts)):
        raise ValueError("Userscript manifest runtimeParts must not contain duplicates.")

    metadata = _read_utf8_lf(metadata_path, "metadata").rstrip("\n")
    if not metadata.startswith("// ==UserScript==\n") or not metadata.endswith("// ==/UserScript=="):
        raise ValueError("Userscript metadata must contain the complete metadata block.")

    parts: list[str] = []
    for index, relative in enumerate(runtime_parts):
        part_path = _resolve_component(source_root, relative, f"runtimeParts[{index}]")
        part = _read_utf8_lf(part_path, f"runtime part {relative}")
        if not part.endswith("\n"):
            raise ValueError(f"Userscript runtime part must end with LF: {part_path}")
        parts.append(part)
    return metadata + IIFE_PREFIX + "".join(parts) + IIFE_SUFFIX


def write_assembled_userscript(source: Path, output: Path) -> None:
    source = source.resolve()
    output = output.resolve()
    if source == output:
        raise ValueError("Assembled Userscript output must not overwrite its source entry.")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(assemble_userscript(source), encoding="utf-8", newline="\n")


def main() -> int:
    parser = argparse.ArgumentParser(description="Assemble the EasyEmail Userscript template.")
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    write_assembled_userscript(args.source, args.output)
    print(f"userscript template assembled: output={args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
