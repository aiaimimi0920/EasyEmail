#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import sys

from release_tag import MODE_FAMILIES, classify_tag


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
