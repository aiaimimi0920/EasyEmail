#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any


PLACEHOLDER_PATTERN = re.compile(r"{{\s*([a-zA-Z0-9_.-]+)\s*}}")


def resolve_placeholder(context: dict[str, Any], key: str) -> str:
    current: Any = context
    for segment in key.split("."):
        if isinstance(current, dict) and segment in current:
            current = current[segment]
            continue
        return ""

    if current is None:
        return ""
    if isinstance(current, bool):
        return "true" if current else "false"
    if isinstance(current, (dict, list)):
        return json.dumps(current, ensure_ascii=False)
    return str(current)


def render_template(template_text: str, context: dict[str, Any]) -> str:
    def replace(match: re.Match[str]) -> str:
        return resolve_placeholder(context, match.group(1))

    return PLACEHOLDER_PATTERN.sub(replace, template_text)


def main() -> int:
    parser = argparse.ArgumentParser(description="Render a markdown template from a JSON context.")
    parser.add_argument("--template", required=True, help="Path to the markdown template.")
    parser.add_argument("--context", required=True, help="Path to the JSON context file.")
    parser.add_argument("--output", required=True, help="Path to the rendered output file.")
    args = parser.parse_args()

    template_path = Path(args.template)
    context_path = Path(args.context)
    output_path = Path(args.output)

    template_text = template_path.read_text(encoding="utf-8")
    context = json.loads(context_path.read_text(encoding="utf-8-sig"))
    rendered = render_template(template_text, context)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(rendered, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
