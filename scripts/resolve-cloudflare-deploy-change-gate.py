#!/usr/bin/env python3

from __future__ import annotations

import argparse
from dataclasses import dataclass
import os
from pathlib import Path
import subprocess
from typing import Sequence


RELEVANT_PATHS = (
    "upstreams/cloudflare_temp_email",
    "deploy/upstreams/cloudflare_temp_email",
    "scripts/deploy-cloudflare-email.ps1",
    "scripts/quick-deploy-cloudflare-mail.ps1",
    "scripts/render-derived-configs.ps1",
    "scripts/render-derived-configs.py",
    "scripts/materialize-action-config.py",
    "scripts/prepare-cloudflare-operator-config.ps1",
    "scripts/resolve-cloudflare-deploy-change-gate.py",
    "scripts/deploy-easyemail-release.ps1",
    "deploy/upstreams/cloudflare_temp_email/scripts/bootstrap_cloudflare_mail.py",
    ".github/workflows/deploy-cloudflare-email.yml",
)


@dataclass(frozen=True)
class ChangeGateResult:
    should_deploy: bool
    reason: str
    matched_files: tuple[str, ...] | None = None


def resolve_change_gate(
    event_name: str,
    coordinated_release: str,
    force_deploy: str,
    matched_files: Sequence[str],
) -> ChangeGateResult:
    if event_name == "workflow_dispatch" or coordinated_release == "true" or force_deploy == "true":
        return ChangeGateResult(True, "manual_or_forced")
    normalized_matches = tuple(path for path in matched_files if path)
    if normalized_matches:
        return ChangeGateResult(True, "relevant_changes_detected", normalized_matches)
    return ChangeGateResult(False, "no_relevant_changes", ())


def render_github_output(result: ChangeGateResult) -> str:
    lines = [
        f"should_deploy={'true' if result.should_deploy else 'false'}",
        f"reason={result.reason}",
    ]
    if result.matched_files is not None:
        lines.append("matched_files<<EOF")
        lines.extend(result.matched_files)
        lines.append("EOF")
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
    parser = argparse.ArgumentParser(description="Resolve the Cloudflare deploy change gate.")
    parser.add_argument("--event-name", default=os.environ.get("GITHUB_EVENT_NAME", ""))
    parser.add_argument("--coordinated-release", default=os.environ.get("COORDINATED_RELEASE", ""))
    parser.add_argument("--force-deploy", default=os.environ.get("FORCE_DEPLOY", ""))
    parser.add_argument("--commit", default=os.environ.get("GITHUB_SHA", ""))
    parser.add_argument("--output", default=os.environ.get("GITHUB_OUTPUT", ""))
    parser.add_argument("--repo-root", type=Path, default=Path.cwd())
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    forced = (
        args.event_name == "workflow_dispatch"
        or args.coordinated_release == "true"
        or args.force_deploy == "true"
    )
    if not forced and not args.commit:
        raise ValueError("GITHUB_SHA or --commit is required for change detection")
    if not args.output:
        raise ValueError("GITHUB_OUTPUT or --output is required")

    matched_files = () if forced else find_matched_files(args.repo_root, args.commit)
    result = resolve_change_gate(
        args.event_name,
        args.coordinated_release,
        args.force_deploy,
        matched_files,
    )
    with Path(args.output).open("a", encoding="utf-8", newline="\n") as output:
        output.write(render_github_output(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
