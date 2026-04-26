#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import re
import sys


SEMVER_PATTERN = re.compile(r"^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$")
OPERATIONAL_PATTERN = re.compile(r"^release-\d{8}-\d{3}$")
SERVICE_BASE_PATTERN = re.compile(r"^service-base-\d{8}-\d{3}$")

MODE_FAMILIES = {
    "any": {"public-semver", "operational", "service-base-only"},
    "service-base": {"public-semver", "operational", "service-base-only"},
    "cloudflare": {"public-semver", "operational"},
}


def classify_tag(tag: str) -> dict[str, object]:
    if SEMVER_PATTERN.fullmatch(tag):
        return {
            "family": "public-semver",
            "channel": "public-semver",
            "isSemver": True,
            "isOperational": False,
            "isServiceBaseOnly": False,
        }

    if OPERATIONAL_PATTERN.fullmatch(tag):
        return {
            "family": "operational",
            "channel": "operational",
            "isSemver": False,
            "isOperational": True,
            "isServiceBaseOnly": False,
        }

    if SERVICE_BASE_PATTERN.fullmatch(tag):
        return {
            "family": "service-base-only",
            "channel": "service-base-only",
            "isSemver": False,
            "isOperational": False,
            "isServiceBaseOnly": True,
        }

    raise ValueError(
        "Unsupported release tag format. Use vX.Y.Z, release-YYYYMMDD-NNN, or service-base-YYYYMMDD-NNN."
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate EasyEmail release tag naming rules.")
    parser.add_argument("--tag", required=True, help="Release tag or version string to validate.")
    parser.add_argument(
        "--mode",
        choices=sorted(MODE_FAMILIES.keys()),
        default="any",
        help="Validation mode. service-base allows service-base-only tags; cloudflare does not.",
    )
    args = parser.parse_args()

    tag = args.tag.strip()
    if not tag:
        raise SystemExit("Release tag must not be empty.")

    try:
        classification = classify_tag(tag)
    except ValueError as exc:
        raise SystemExit(str(exc)) from exc

    if classification["family"] not in MODE_FAMILIES[args.mode]:
        allowed = ", ".join(sorted(MODE_FAMILIES[args.mode]))
        raise SystemExit(
            f"Tag '{tag}' is not allowed in mode '{args.mode}'. Allowed families: {allowed}."
        )

    payload = {
        "tag": tag,
        "mode": args.mode,
        **classification,
        "valid": True,
    }
    json.dump(payload, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
