#!/usr/bin/env python3

from __future__ import annotations

import argparse
import os
from pathlib import Path
from typing import Any

import yaml


def deep_merge(base: Any, overlay: Any) -> Any:
    if overlay is None:
        return base
    if isinstance(base, dict) and isinstance(overlay, dict):
        merged = dict(base)
        for key, value in overlay.items():
            if key in merged:
                merged[key] = deep_merge(merged[key], value)
            else:
                merged[key] = value
        return merged
    return overlay


def load_yaml_file(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise SystemExit(f"Base config not found: {path}")
    return yaml.safe_load(path.read_text(encoding="utf-8-sig")) or {}


def load_yaml_text(text: str, source_name: str) -> dict[str, Any]:
    try:
        return yaml.safe_load(text) or {}
    except yaml.YAMLError as exc:  # pragma: no cover - defensive parsing guard
        raise SystemExit(f"Failed to parse YAML from {source_name}: {exc}") from exc


def normalize_secret_overlay(secret_config: dict[str, Any]) -> dict[str, Any]:
    if "cloudflareMail" in secret_config:
        return secret_config
    return {"cloudflareMail": secret_config}


def main() -> int:
    parser = argparse.ArgumentParser(description="Materialize a deployable EasyEmail config from GitHub Actions secrets.")
    parser.add_argument("--base-config", required=True, help="Path to the base config YAML to merge onto.")
    parser.add_argument("--output", required=True, help="Path to the generated root config.yaml.")
    args = parser.parse_args()

    base_path = Path(args.base_config)
    output_path = Path(args.output)
    base_config = load_yaml_file(base_path)

    operator_config = os.environ.get("EASYEMAIL_OPERATOR_CONFIG", "").strip()
    cloudflare_config = os.environ.get("EASYEMAIL_CLOUDFLARE_MAIL_CONFIG", "").strip()

    if operator_config:
        merged_config = load_yaml_text(operator_config, "EASYEMAIL_OPERATOR_CONFIG")
    elif cloudflare_config:
        secret_config = load_yaml_text(cloudflare_config, "EASYEMAIL_CLOUDFLARE_MAIL_CONFIG")
        merged_config = deep_merge(base_config, normalize_secret_overlay(secret_config))
    else:
        raise SystemExit(
            "Missing GitHub Actions config secret. Set EASYEMAIL_OPERATOR_CONFIG or EASYEMAIL_CLOUDFLARE_MAIL_CONFIG."
        )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        yaml.safe_dump(merged_config, sort_keys=False, allow_unicode=True),
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
