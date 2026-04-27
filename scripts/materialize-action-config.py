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
        "EASYEMAIL_CF_PUBLIC_ZONE",
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
        "EASYEMAIL_CF_BOOTSTRAP_ENABLED",
        "EASYEMAIL_CF_BOOTSTRAP_CREATE_ZONES",
        "EASYEMAIL_CF_BOOTSTRAP_ACCOUNT_ID",
        "EASYEMAIL_CF_BOOTSTRAP_ZONES",
        "EASYEMAIL_CF_D1_LOCATION_HINT",
        "EASYEMAIL_CF_D1_JURISDICTION",
        "EASYEMAIL_CF_BOOTSTRAP_ZONE_TYPE",
        "EASYEMAIL_CF_BOOTSTRAP_JUMP_START",
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
    bootstrap: dict[str, Any] = {}

    set_if_present(cloudflare_mail, "publicBaseUrl", get_secret_text("EASYEMAIL_CF_PUBLIC_BASE_URL"))
    set_if_present(cloudflare_mail, "publicDomain", get_secret_text("EASYEMAIL_CF_PUBLIC_DOMAIN"))
    set_if_present(cloudflare_mail, "publicZone", get_secret_text("EASYEMAIL_CF_PUBLIC_ZONE"))
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
    d1_database_name = get_secret_text("EASYEMAIL_CF_D1_DATABASE_NAME")
    d1_database_binding = get_secret_text("EASYEMAIL_CF_D1_DATABASE_BINDING")
    if d1_database_id or d1_database_name or d1_database_binding:
        d1_entry = {
            "binding": d1_database_binding or str(base_d1_first.get("binding", "DB")),
            "database_name": d1_database_name or str(base_d1_first.get("database_name", "cloudflare-temp-email")),
        }
        set_if_present(d1_entry, "database_id", d1_database_id)
        worker["d1_databases"] = [d1_entry]

    set_if_present(routing_plan, "domains", domains)
    set_if_present(routing_plan, "subdomainLabelPool", subdomain_label_pool)
    set_if_present(routing_plan, "randomSubdomainDomains", random_domains)

    set_if_present(cloudflare_mail, "syncRouting", parse_bool_secret("EASYEMAIL_CF_SYNC_ROUTING"))
    set_if_present(routing, "mode", get_secret_text("EASYEMAIL_CF_ROUTING_MODE"))
    set_if_present(routing, "controlCenterDnsToken", get_secret_text("EASYEMAIL_CF_CONTROL_CENTER_DNS_TOKEN"))
    set_if_present(global_auth, "authEmail", get_secret_text("EASYEMAIL_CF_AUTH_EMAIL"))
    set_if_present(global_auth, "globalApiKey", get_secret_text("EASYEMAIL_CF_GLOBAL_API_KEY"))
    set_if_present(bootstrap, "enabled", parse_bool_secret("EASYEMAIL_CF_BOOTSTRAP_ENABLED"))
    set_if_present(bootstrap, "createZones", parse_bool_secret("EASYEMAIL_CF_BOOTSTRAP_CREATE_ZONES"))
    set_if_present(bootstrap, "accountId", get_secret_text("EASYEMAIL_CF_BOOTSTRAP_ACCOUNT_ID"))
    set_if_present(bootstrap, "zones", parse_list_secret("EASYEMAIL_CF_BOOTSTRAP_ZONES"))
    set_if_present(bootstrap, "d1LocationHint", get_secret_text("EASYEMAIL_CF_D1_LOCATION_HINT"))
    set_if_present(bootstrap, "d1Jurisdiction", get_secret_text("EASYEMAIL_CF_D1_JURISDICTION"))
    set_if_present(bootstrap, "zoneType", get_secret_text("EASYEMAIL_CF_BOOTSTRAP_ZONE_TYPE"))
    set_if_present(bootstrap, "jumpStart", parse_bool_secret("EASYEMAIL_CF_BOOTSTRAP_JUMP_START"))

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
    if bootstrap:
        cloudflare_mail["bootstrap"] = bootstrap

    return overlay if cloudflare_mail else None


def build_granular_service_overlay(base_config: dict[str, Any]) -> dict[str, Any] | None:
    names = [
        "EASYEMAIL_SERVICE_RUNTIME_API_KEY",
        "EASYEMAIL_PROVIDER_CLOUDFLARE_API_KEY",
        "EASYEMAIL_PROVIDER_MOEMAIL_API_KEY",
        "EASYEMAIL_PROVIDER_MOEMAIL_WEB_SESSION_TOKEN",
        "EASYEMAIL_PROVIDER_MOEMAIL_WEB_CSRF_TOKEN",
        "EASYEMAIL_PROVIDER_IM215_API_KEY",
        "EASYEMAIL_PROVIDER_MAIL2925_ACCOUNT",
        "EASYEMAIL_PROVIDER_MAIL2925_PASSWORD",
        "EASYEMAIL_PROVIDER_GPTMAIL_API_KEY",
    ]
    if not any(has_secret_value(name) for name in names):
        return None

    overlay: dict[str, Any] = {"serviceBase": {"runtime": {}}}
    service_base = overlay["serviceBase"]
    runtime = service_base["runtime"]
    server: dict[str, Any] = {}
    providers: dict[str, Any] = {}

    set_if_present(server, "apiKey", get_secret_text("EASYEMAIL_SERVICE_RUNTIME_API_KEY"))
    if server:
        runtime["server"] = server

    cloudflare_temp_email: dict[str, Any] = {}
    cloudflare_public_base_url = get_secret_text("EASYEMAIL_CF_PUBLIC_BASE_URL")
    cloudflare_public_domain = get_secret_text("EASYEMAIL_CF_PUBLIC_DOMAIN")
    cloudflare_domains = (
        parse_list_secret("EASYEMAIL_CF_DEFAULT_DOMAINS")
        or parse_list_secret("EASYEMAIL_CF_DOMAINS")
    )
    cloudflare_random_domains = (
        parse_list_secret("EASYEMAIL_CF_RANDOM_SUBDOMAIN_DOMAINS")
        or cloudflare_domains
    )
    set_if_present(cloudflare_temp_email, "baseUrl", cloudflare_public_base_url)
    set_if_present(cloudflare_temp_email, "apiKey", get_secret_text("EASYEMAIL_PROVIDER_CLOUDFLARE_API_KEY"))
    set_if_present(cloudflare_temp_email, "domain", cloudflare_public_domain)
    set_if_present(cloudflare_temp_email, "domains", cloudflare_domains)
    set_if_present(cloudflare_temp_email, "randomSubdomainDomains", cloudflare_random_domains)
    if cloudflare_temp_email:
        providers["cloudflareTempEmail"] = cloudflare_temp_email

    moemail: dict[str, Any] = {}
    set_if_present(moemail, "apiKey", get_secret_text("EASYEMAIL_PROVIDER_MOEMAIL_API_KEY"))
    set_if_present(moemail, "webSessionToken", get_secret_text("EASYEMAIL_PROVIDER_MOEMAIL_WEB_SESSION_TOKEN"))
    set_if_present(moemail, "webCsrfToken", get_secret_text("EASYEMAIL_PROVIDER_MOEMAIL_WEB_CSRF_TOKEN"))
    if moemail:
        providers["moemail"] = moemail

    im215: dict[str, Any] = {}
    set_if_present(im215, "apiKey", get_secret_text("EASYEMAIL_PROVIDER_IM215_API_KEY"))
    if im215:
        providers["im215"] = im215

    mail2925: dict[str, Any] = {}
    set_if_present(mail2925, "account", get_secret_text("EASYEMAIL_PROVIDER_MAIL2925_ACCOUNT"))
    set_if_present(mail2925, "password", get_secret_text("EASYEMAIL_PROVIDER_MAIL2925_PASSWORD"))
    if mail2925:
        providers["mail2925"] = mail2925

    gptmail: dict[str, Any] = {}
    set_if_present(gptmail, "apiKey", get_secret_text("EASYEMAIL_PROVIDER_GPTMAIL_API_KEY"))
    if gptmail:
        providers["gptmail"] = gptmail

    if providers:
        runtime["providers"] = providers

    return overlay if runtime else None


def build_granular_userscript_overlay(base_config: dict[str, Any]) -> dict[str, Any] | None:
    del base_config  # currently unused but kept for a parallel builder signature
    names = [
        "EASYEMAIL_USERSCRIPT_CLOUDFLARE_CUSTOM_AUTH",
        "EASYEMAIL_USERSCRIPT_CLOUDFLARE_ADMIN_AUTH",
        "EASYEMAIL_USERSCRIPT_MOEMAIL_API_KEY",
        "EASYEMAIL_USERSCRIPT_GPTMAIL_API_KEY",
        "EASYEMAIL_USERSCRIPT_IM215_API_KEY",
    ]
    if not any(has_secret_value(name) for name in names):
        return None

    secrets: dict[str, Any] = {}
    set_if_present(secrets, "cloudflare_customAuth", get_secret_text("EASYEMAIL_USERSCRIPT_CLOUDFLARE_CUSTOM_AUTH"))
    set_if_present(secrets, "cloudflare_adminAuth", get_secret_text("EASYEMAIL_USERSCRIPT_CLOUDFLARE_ADMIN_AUTH"))
    set_if_present(secrets, "moemail_apiKey", get_secret_text("EASYEMAIL_USERSCRIPT_MOEMAIL_API_KEY"))
    set_if_present(secrets, "gptmail_apiKey", get_secret_text("EASYEMAIL_USERSCRIPT_GPTMAIL_API_KEY"))
    set_if_present(secrets, "im215_apiKey", get_secret_text("EASYEMAIL_USERSCRIPT_IM215_API_KEY"))
    if not secrets:
        return None

    return {
        "userscript": {
            "secrets": secrets
        }
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Materialize a deployable EasyEmail config from GitHub Actions secrets.")
    parser.add_argument("--base-config", required=True, help="Path to the base config YAML to merge onto.")
    parser.add_argument("--output", required=True, help="Path to the generated root config.yaml.")
    args = parser.parse_args()

    base_path = Path(args.base_config)
    output_path = Path(args.output)
    base_config = load_yaml_file(base_path)
    cloudflare_overlay = build_granular_cloudflare_overlay(base_config)
    service_overlay = build_granular_service_overlay(base_config)
    userscript_overlay = build_granular_userscript_overlay(base_config)

    if not cloudflare_overlay and not service_overlay and not userscript_overlay:
        raise SystemExit(
            "Missing GitHub Actions config secrets. Set the EASYEMAIL_CF_*, EASYEMAIL_SERVICE_*, and/or EASYEMAIL_USERSCRIPT_* granular secrets."
        )

    merged_config = base_config
    if cloudflare_overlay:
        merged_config = deep_merge(merged_config, cloudflare_overlay)
    if service_overlay:
        merged_config = deep_merge(merged_config, service_overlay)
    if userscript_overlay:
        merged_config = deep_merge(merged_config, userscript_overlay)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        yaml.safe_dump(merged_config, sort_keys=False, allow_unicode=True),
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
