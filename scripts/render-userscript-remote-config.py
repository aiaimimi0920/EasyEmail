#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import yaml


def load_yaml_file(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise SystemExit(f"Config file not found: {path}")
    return yaml.safe_load(path.read_text(encoding="utf-8-sig")) or {}


def get_in(mapping: Any, *keys: str, default: Any = None) -> Any:
    cursor = mapping
    for key in keys:
        if not isinstance(cursor, dict) or key not in cursor:
            return default
        cursor = cursor[key]
    return cursor


def str_value(value: Any, *, default: str = "") -> str:
    if value is None:
        return default
    text = str(value).strip()
    return text if text else default


def bool_string(value: Any, *, default: bool = False) -> str:
    if value is None:
        return "true" if default else "false"
    return "true" if bool(value) else "false"


def build_settings(config: dict[str, Any]) -> dict[str, str]:
    userscript = get_in(config, "userscript", default={}) or {}
    userscript_secrets = get_in(userscript, "secrets", default={}) or {}

    cloudflare_public_base_url = str_value(get_in(config, "cloudflareMail", "publicBaseUrl"), default="https://mail.example.com")
    cloudflare_public_domain = str_value(
        get_in(config, "serviceBase", "runtime", "providers", "cloudflareTempEmail", "domain"),
        default=str_value(get_in(config, "cloudflareMail", "publicDomain"), default="mail.example.com"),
    )

    moemail_base_url = str_value(
        get_in(config, "serviceBase", "runtime", "providers", "moemail", "baseUrl"),
        default="https://sall.cc",
    )
    moemail_expiry_time_ms = str_value(
        get_in(config, "serviceBase", "runtime", "providers", "moemail", "expiryTimeMs"),
        default="3600000",
    )
    gptmail_base_url = str_value(
        get_in(config, "serviceBase", "runtime", "providers", "gptmail", "baseUrl"),
        default="https://mail.chatgpt.org.uk",
    )
    im215_base_url = str_value(
        get_in(config, "serviceBase", "runtime", "providers", "im215", "baseUrl"),
        default="https://maliapi.215.im/v1",
    )

    cloudflare_custom_auth = str_value(get_in(userscript_secrets, "cloudflare_customAuth"))
    cloudflare_admin_auth = str_value(get_in(userscript_secrets, "cloudflare_adminAuth"))
    moemail_api_key = str_value(get_in(userscript_secrets, "moemail_apiKey"))
    gptmail_api_key = str_value(get_in(userscript_secrets, "gptmail_apiKey"))
    im215_api_key = str_value(get_in(userscript_secrets, "im215_apiKey"))

    return {
        "cloudflare_enabled": bool_string(bool(cloudflare_custom_auth), default=True),
        "cloudflare_baseUrl": cloudflare_public_base_url,
        "cloudflare_customAuth": cloudflare_custom_auth,
        "cloudflare_adminAuth": cloudflare_admin_auth,
        "cloudflare_preferredDomain": cloudflare_public_domain,
        "moemail_enabled": bool_string(bool(moemail_api_key), default=True),
        "moemail_baseUrl": moemail_base_url,
        "moemail_apiKey": moemail_api_key,
        "moemail_expiryTimeMs": moemail_expiry_time_ms,
        "gptmail_enabled": bool_string(bool(gptmail_api_key), default=False),
        "gptmail_baseUrl": gptmail_base_url,
        "gptmail_apiKey": gptmail_api_key,
        "im215_enabled": bool_string(bool(im215_api_key), default=False),
        "im215_baseUrl": im215_base_url,
        "im215_apiKey": im215_api_key,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Render EasyEmail userscript remote import settings from config.yaml.")
    parser.add_argument("--config", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    config = load_yaml_file(Path(args.config).resolve())
    payload = {
        "schemaVersion": 1,
        "kind": "easyemail-userscript-settings",
        "settings": build_settings(config),
    }

    output_path = Path(args.output).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
