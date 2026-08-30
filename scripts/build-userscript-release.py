#!/usr/bin/env python3

from __future__ import annotations

import argparse
from pathlib import Path

from userscript_release import (
    EXPECTED_PLACEHOLDERS,
    LOCAL_SECRET_PLACEHOLDER,
    VERSION_LINE,
    build_userscript,
    userscript_version,
    validate_template,
)


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = ROOT / "runtimes" / "userscript" / "easy_email_proxy.user.js"


def main() -> int:
    parser = argparse.ArgumentParser(description="Build a secret-free EasyEmail Userscript release artifact.")
    parser.add_argument("--release-tag", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    args = parser.parse_args()

    version = build_userscript(args.source, args.output, args.release_tag)
    print(f"userscript release built: version={version} output={args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
