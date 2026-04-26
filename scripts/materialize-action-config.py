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


def load_yaml_value(text: str, source_name: str) -> Any:
    try:
        return yaml.safe_load(text)
    except yaml.YAMLError as exc:  # pragma: no cover - defensive parsing guard
        raise SystemExit(f"Failed to parse YAML from {source_name}: {exc}") from exc


def load_yaml_text(text: str, source_name: str) -> dict[str, Any]:
    value = load_yaml_value(text, source_name)
    return value if isinstance(value, dict) else {}


def normalize_secret_overlay(secret_config: dict[str, Any]) -> dict[str, Any]:
    if "cloudflareMail" in secret_config:
        return secret_config
    return {"cloudflareMail": secret_config}


def get_secret_text(name: str) -> str:
    return os.environ.get(name, "").strip()


def has_secret_value(name: str) -> bool:
    return bool(get_secret_text(name))


def normalize_string_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        items = value
    else:
        items = [value]
    normalized: list[str] = []
    for item in items:
        if item is None:
            continue
        text = str(item).strip()
        if text:
            normalized.append(text)
    return normalized


def parse_list_secret(name: str) -> list[str] | None:
    raw = get_secret_text(name)
    if not raw:
        return None

    parsed = load_yaml_value(raw, name)
    if isinstance(parsed, list):
        return normalize_string_list(parsed)
    if isinstance(parsed, str):
        lines = [line.strip() for line in parsed.splitlines() if line.strip()]
        if len(lines) > 1:
            return lines
        if "," in parsed:
            return [part.strip() for part in parsed.split(",") if part.strip()]
        return normalize_string_list(parsed)
    return normalize_string_list(parsed)


def parse_bool_secret(name: str) -> bool | None:
    raw = get_secret_text(name)
    if not raw:
        return None

    parsed = load_yaml_value(raw, name)
    if isinstance(parsed, bool):
        return parsed
    text = str(parsed).strip().lower()
    if text in {"1", "true", "yes", "on"}:
        return True
    if text in {"0", "false", "no", "off"}:
        return False
    raise SystemExit(f"Secret {name} must be a boolean value.")


def parse_int_secret(name: str) -> int | None:
    raw = get_secret_text(name)
    if not raw:
        return None

    parsed = load_yaml_value(raw, name)
    try:
        return int(parsed)
    except (TypeError, ValueError) as exc:
        raise SystemExit(f"Secret {name} must be an integer value.") from exc


def set_if_present(mapping: dict[str, Any], key: str, value: Any) -> None:
    if value is None:
        return
    if isinstance(value, str) and not value.strip():
        return
    if isinstance(value, list) and not value:
        return
    mapping[key] = value


def build_granular_cloudflare_overlay(base_config: dict[str, Any]) -> dict[str, Any] | None:
    names = [
        "EASYEMAIL_CF_PUBLIC_BASE_URL",
        "EASYEMAIL_CF_PUBLIC_DOMAIN",
        "EASYEMAIL_CF_WORKER_NAME",
        "EASYEMAIL_CF_WORKER_ENV",
        "EASYEMAIL_CF_PASSWORDS",
        "EASYEMAIL_CF_ADMIN_PASSWORDS",
        "EASYEMAIL_CF_JWT_SECRET",
        "EASYEMAIL_CF_PREFIX",
        "EASYEMAIL_CF_DOMAINS",
        "EASYEMAIL_CF_DEFAULT_DOMAINS",
        "EASYEMAIL_CF_RANDOM_SUBDOMAIN_DOMAINS",
        "EASYEMAIL_CF_SUBDOMAIN_LABEL_POOL",
        "EASYEMAIL_CF_ENABLE_CREATE_ADDRESS_SUBDOMAIN_MATCH",
        "EASYEMAIL_CF_RANDOM_SUBDOMAIN_LENGTH",
        "EASYEMAIL_CF_ENABLE_USER_CREATE_EMAIL",
        "EASYEMAIL_CF_ENABLE_USER_DELETE_EMAIL",
        "EASYEMAIL_CF_D1_DATABASE_ID",
        "EASYEMAIL_CF_D1_DATABASE_NAME",
        "EASYEMAIL_CF_D1_DATABASE_BINDING",
        "EASYEMAIL_CF_SYNC_ROUTING",
        "EASYEMAIL_CF_ROUTING_MODE",
        "EASYEMAIL_CF_CONTROL_CENTER_DNS_TOKEN",
        "EASYEMAIL_CF_AUTH_EMAIL",
        "EASYEMAIL_CF_GLOBAL_API_KEY",
    ]
    if not any(has_secret_value(name) for name in names):
        return None

    base_cloudflare = base_config.get("cloudflareMail", {}) if isinstance(base_config, dict) else {}
    base_worker = base_cloudflare.get("worker", {}) if isinstance(base_cloudflare, dict) else {}
    base_d1 = []
    if isinstance(base_worker, dict):
        candidate = base_worker.get("d1_databases")
        if isinstance(candidate, list):
            base_d1 = [item for item in candidate if isinstance(item, dict)]
    base_d1_first = base_d1[0] if base_d1 else {}

    domains = parse_list_secret("EASYEMAIL_CF_DOMAINS")
    default_domains = parse_list_secret("EASYEMAIL_CF_DEFAULT_DOMAINS") or domains
    random_domains = parse_list_secret("EASYEMAIL_CF_RANDOM_SUBDOMAIN_DOMAINS") or domains
    subdomain_label_pool = parse_list_secret("EASYEMAIL_CF_SUBDOMAIN_LABEL_POOL")

    overlay: dict[str, Any] = {"cloudflareMail": {}}
    cloudflare_mail = overlay["cloudflareMail"]
    worker: dict[str, Any] = {}
    worker_vars: dict[str, Any] = {}
    routing: dict[str, Any] = {}
    routing_plan: dict[str, Any] = {}
    global_auth: dict[str, Any] = {}

    set_if_present(cloudflare_mail, "publicBaseUrl", get_secret_text("EASYEMAIL_CF_PUBLIC_BASE_URL"))
    set_if_present(cloudflare_mail, "publicDomain", get_secret_text("EASYEMAIL_CF_PUBLIC_DOMAIN"))
    set_if_present(cloudflare_mail, "workerName", get_secret_text("EASYEMAIL_CF_WORKER_NAME"))
    set_if_present(cloudflare_mail, "workerEnv", get_secret_text("EASYEMAIL_CF_WORKER_ENV"))

    set_if_present(worker_vars, "PASSWORDS", parse_list_secret("EASYEMAIL_CF_PASSWORDS"))
    set_if_present(worker_vars, "ADMIN_PASSWORDS", parse_list_secret("EASYEMAIL_CF_ADMIN_PASSWORDS"))
    set_if_present(worker_vars, "JWT_SECRET", get_secret_text("EASYEMAIL_CF_JWT_SECRET"))
    set_if_present(worker_vars, "PREFIX", get_secret_text("EASYEMAIL_CF_PREFIX"))
    set_if_present(worker_vars, "DOMAINS", domains)
    set_if_present(worker_vars, "DEFAULT_DOMAINS", default_domains)
    set_if_present(worker_vars, "RANDOM_SUBDOMAIN_DOMAINS", random_domains)
    set_if_present(worker_vars, "SUBDOMAIN_LABEL_POOL", subdomain_label_pool)
    set_if_present(
        worker_vars,
        "ENABLE_CREATE_ADDRESS_SUBDOMAIN_MATCH",
        parse_bool_secret("EASYEMAIL_CF_ENABLE_CREATE_ADDRESS_SUBDOMAIN_MATCH"),
    )
    set_if_present(worker_vars, "RANDOM_SUBDOMAIN_LENGTH", parse_int_secret("EASYEMAIL_CF_RANDOM_SUBDOMAIN_LENGTH"))
    set_if_present(worker_vars, "ENABLE_USER_CREATE_EMAIL", parse_bool_secret("EASYEMAIL_CF_ENABLE_USER_CREATE_EMAIL"))
    set_if_present(worker_vars, "ENABLE_USER_DELETE_EMAIL", parse_bool_secret("EASYEMAIL_CF_ENABLE_USER_DELETE_EMAIL"))

    d1_database_id = get_secret_text("EASYEMAIL_CF_D1_DATABASE_ID")
    if d1_database_id:
        d1_entry = {
            "binding": get_secret_text("EASYEMAIL_CF_D1_DATABASE_BINDING")
            or str(base_d1_first.get("binding", "DB")),
            "database_name": get_secret_text("EASYEMAIL_CF_D1_DATABASE_NAME")
            or str(base_d1_first.get("database_name", "cloudflare-temp-email")),
            "database_id": d1_database_id,
        }
        worker["d1_databases"] = [d1_entry]

    set_if_present(routing_plan, "domains", domains)
    set_if_present(routing_plan, "subdomainLabelPool", subdomain_label_pool)
    set_if_present(routing_plan, "randomSubdomainDomains", random_domains)

    set_if_present(cloudflare_mail, "syncRouting", parse_bool_secret("EASYEMAIL_CF_SYNC_ROUTING"))
    set_if_present(routing, "mode", get_secret_text("EASYEMAIL_CF_ROUTING_MODE"))
    set_if_present(routing, "controlCenterDnsToken", get_secret_text("EASYEMAIL_CF_CONTROL_CENTER_DNS_TOKEN"))
    set_if_present(global_auth, "authEmail", get_secret_text("EASYEMAIL_CF_AUTH_EMAIL"))
    set_if_present(global_auth, "globalApiKey", get_secret_text("EASYEMAIL_CF_GLOBAL_API_KEY"))

    if worker_vars:
        worker["vars"] = worker_vars
    if worker:
        cloudflare_mail["worker"] = worker
    if routing_plan:
        routing["plan"] = routing_plan
    if global_auth:
        routing["cloudflareGlobalAuth"] = global_auth
    if routing:
        cloudflare_mail["routing"] = routing

    return overlay if cloudflare_mail else None


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
    granular_overlay = build_granular_cloudflare_overlay(base_config)

    if operator_config:
        merged_config = load_yaml_text(operator_config, "EASYEMAIL_OPERATOR_CONFIG")
    else:
        merged_config = base_config

    if cloudflare_config:
        secret_config = load_yaml_text(cloudflare_config, "EASYEMAIL_CLOUDFLARE_MAIL_CONFIG")
        merged_config = deep_merge(merged_config, normalize_secret_overlay(secret_config))

    if granular_overlay:
        merged_config = deep_merge(merged_config, granular_overlay)

    if not operator_config and not cloudflare_config and not granular_overlay:
        raise SystemExit(
            "Missing GitHub Actions config secret. Set EASYEMAIL_OPERATOR_CONFIG, "
            "EASYEMAIL_CLOUDFLARE_MAIL_CONFIG, or the EASYEMAIL_CF_* granular secrets."
        )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        yaml.safe_dump(merged_config, sort_keys=False, allow_unicode=True),
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
