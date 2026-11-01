#!/usr/bin/env python3

from __future__ import annotations

import argparse
from dataclasses import dataclass
import os
from pathlib import Path
import subprocess
from typing import Sequence


RELEVANT_PATHS = (
    "service/base",
    "deploy/service/base",
    "config.example.yaml",
    "scripts/compile-service-base-image.ps1",
    "scripts/deploy-service-base.ps1",
    "scripts/deploy-easyemail-release.ps1",
    "scripts/materialize-action-config.py",
    "scripts/render-derived-configs.py",
    "scripts/render-derived-configs.ps1",
    "scripts/resolve-service-base-change-gate.py",
    "scripts/upload-service-base-r2-config.ps1",
    "scripts/upload-service-base-r2-config.py",
    "scripts/write-service-base-r2-bootstrap.ps1",
    "deploy/service/base/bootstrap-service-config.py",
    ".github/workflows/publish-service-base-ghcr.yml",
)


@dataclass(frozen=True)
class ChangeGateResult:
    should_publish: bool
    reason: str
    matched_files: tuple[str, ...]


def resolve_change_gate(force_publish: bool, matched_files: Sequence[str]) -> ChangeGateResult:
    if force_publish:
        return ChangeGateResult(True, "force_publish", ("(forced)",))
    normalized_matches = tuple(path for path in matched_files if path)
    if normalized_matches:
        return ChangeGateResult(True, "relevant_changes_detected", normalized_matches)
    return ChangeGateResult(False, "no_relevant_changes", ())


def render_github_output(result: ChangeGateResult) -> str:
    lines = [
        f"should_publish={'true' if result.should_publish else 'false'}",
        f"reason={result.reason}",
        "matched_files<<EOF",
        *result.matched_files,
        "EOF",
    ]
    return "\n".join(lines) + "\n"


def find_matched_files(repo_root: Path, commit: str) -> tuple[str, ...]:
    completed = subprocess.run(
        [
            "git",
            "diff-tree",
            "--no-commit-id",
            "--name-only",
            "-r",
            commit,
            "--",
            *RELEVANT_PATHS,
        ],
        cwd=repo_root,
        check=True,
        capture_output=True,
        text=True,
    )
    return tuple(completed.stdout.splitlines())


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Resolve the service-base publish change gate.")
    parser.add_argument("--force-publish", default=os.environ.get("FORCE_PUBLISH", ""))
    parser.add_argument("--commit", default=os.environ.get("GITHUB_SHA", ""))
    parser.add_argument("--output", default=os.environ.get("GITHUB_OUTPUT", ""))
    parser.add_argument("--repo-root", type=Path, default=Path.cwd())
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    force_publish = str(args.force_publish).strip().lower() == "true"
    if not force_publish and not args.commit:
        raise ValueError("GITHUB_SHA or --commit is required for change detection")
    if not args.output:
        raise ValueError("GITHUB_OUTPUT or --output is required")

    matched_files = () if force_publish else find_matched_files(args.repo_root, args.commit)
    result = resolve_change_gate(force_publish, matched_files)
    with Path(args.output).open("a", encoding="utf-8", newline="\n") as output:
        output.write(render_github_output(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
