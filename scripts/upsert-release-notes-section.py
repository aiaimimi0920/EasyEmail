#!/usr/bin/env python3

from __future__ import annotations

import argparse
import re
from pathlib import Path


def build_wrapped_section(section_id: str, section_text: str) -> str:
    normalized = section_text.strip()
    start = f"<!-- EASYEMAIL:{section_id}:start -->"
    end = f"<!-- EASYEMAIL:{section_id}:end -->"
    return f"{start}\n{normalized}\n{end}\n"


def upsert_section(existing_text: str, section_id: str, section_text: str) -> str:
    wrapped = build_wrapped_section(section_id, section_text)
    pattern = re.compile(
        rf"<!-- EASYEMAIL:{re.escape(section_id)}:start -->.*?<!-- EASYEMAIL:{re.escape(section_id)}:end -->\n?",
        re.DOTALL,
    )

    if pattern.search(existing_text):
        updated = pattern.sub(wrapped, existing_text)
    else:
        trimmed = existing_text.rstrip()
        if trimmed:
            updated = f"{trimmed}\n\n{wrapped}"
        else:
            updated = wrapped

    return updated.rstrip() + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="Insert or replace a managed release-notes section.")
    parser.add_argument("--section-id", required=True, help="Stable section identifier, e.g. service-base-ghcr.")
    parser.add_argument("--section-file", required=True, help="Markdown file containing the rendered section body.")
    parser.add_argument("--output", required=True, help="Destination file for the merged release notes.")
    parser.add_argument("--existing", default="", help="Existing release notes file to merge into.")
    args = parser.parse_args()

    existing_text = ""
    if args.existing:
        existing_path = Path(args.existing)
        if existing_path.exists():
            existing_text = existing_path.read_text(encoding="utf-8-sig")

    section_text = Path(args.section_file).read_text(encoding="utf-8-sig")
    merged = upsert_section(existing_text, args.section_id, section_text)

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(merged, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
