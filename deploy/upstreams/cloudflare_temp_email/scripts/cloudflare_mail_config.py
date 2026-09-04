from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml


PLACEHOLDER_DOMAINS = {
    "example.com",
    "mail.example.com",
    "*.example.com",
}


def load_yaml_file(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise SystemExit(f"Config not found: {path}")
    return yaml.safe_load(path.read_text(encoding="utf-8-sig")) or {}


def as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def as_list(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    return [value]


def first_non_empty(*values: Any) -> Any:
    for value in values:
        if value is None:
            continue
        if isinstance(value, str) and not value.strip():
            continue
        if isinstance(value, (list, dict)) and len(value) == 0:
            continue
        return value
    return None


def normalize_string_list(value: Any) -> list[str]:
    items: list[str] = []
    for item in as_list(value):
        if item is None:
            continue
        text = str(item).strip()
        if text:
            items.append(text)
    return items


def filter_placeholder_domains(values: list[str]) -> list[str]:
    return [value for value in values if value.strip().lower() not in PLACEHOLDER_DOMAINS]


def unique_preserve_order(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        result.append(value)
    return result


def is_subdomain_of(host: str, zone: str) -> bool:
    return host == zone or host.endswith("." + zone)


def normalize_zone_candidates(candidates: list[str]) -> list[str]:
    normalized = unique_preserve_order(
        [
            candidate.strip().lower().rstrip(".")
            for candidate in candidates
            if candidate.strip()
        ]
    )
    ordered = sorted(normalized, key=lambda item: (item.count("."), len(item)))
    selected: list[str] = []
    for candidate in ordered:
        if any(is_subdomain_of(candidate, existing) for existing in selected):
            continue
        selected.append(candidate)
    return selected


def get_bootstrap_config(config: dict[str, Any]) -> dict[str, Any]:
    cloudflare = as_dict(config.get("cloudflareMail"))
    return as_dict(cloudflare.get("bootstrap"))


def _resolve_public_zone(
    config: dict[str, Any], *, filter_plan_placeholders: bool
) -> str | None:
    cloudflare = as_dict(config.get("cloudflareMail"))
    bootstrap = get_bootstrap_config(config)
    public_domain = str(cloudflare.get("publicDomain") or "").strip().lower()
    if not public_domain:
        return None

    explicit = first_non_empty(
        cloudflare.get("publicZone"), bootstrap.get("publicZone")
    )
    if isinstance(explicit, str) and explicit.strip():
        return explicit.strip().lower().rstrip(".")

    routing = as_dict(cloudflare.get("routing"))
    plan = as_dict(routing.get("plan"))
    plan_domains = normalize_string_list(plan.get("domains"))
    if filter_plan_placeholders:
        plan_domains = filter_placeholder_domains(plan_domains)
    wildcard_roots = [domain[2:] for domain in plan_domains if domain.startswith("*.")]
    exact_domains = [domain for domain in plan_domains if not domain.startswith("*.")]

    service_base = as_dict(config.get("serviceBase"))
    runtime = as_dict(service_base.get("runtime"))
    providers = as_dict(runtime.get("providers"))
    cloudflare_provider = as_dict(providers.get("cloudflareTempEmail"))
    provider_domain = str(cloudflare_provider.get("domain") or "").strip().lower()

    candidates = wildcard_roots + exact_domains
    if provider_domain:
        candidates.append(provider_domain)

    matches = [
        candidate
        for candidate in unique_preserve_order(candidates)
        if is_subdomain_of(public_domain, candidate.lower().rstrip("."))
    ]
    if not matches:
        return None
    matches.sort(key=lambda item: (item.count("."), len(item)))
    return matches[0].rstrip(".")


def _collect_desired_zones(
    config: dict[str, Any], *, filter_plan_placeholders: bool
) -> list[str]:
    cloudflare = as_dict(config.get("cloudflareMail"))
    routing = as_dict(cloudflare.get("routing"))
    plan = as_dict(routing.get("plan"))
    bootstrap = get_bootstrap_config(config)

    plan_domains = normalize_string_list(plan.get("domains"))
    if filter_plan_placeholders:
        plan_domains = filter_placeholder_domains(plan_domains)
    wildcard_roots = [domain[2:] for domain in plan_domains if domain.startswith("*.")]
    exact_domains = [domain for domain in plan_domains if not domain.startswith("*.")]
    manual_zones = filter_placeholder_domains(
        normalize_string_list(bootstrap.get("zones"))
    )
    public_zone = _resolve_public_zone(
        config, filter_plan_placeholders=filter_plan_placeholders
    )

    candidates = manual_zones + wildcard_roots + exact_domains
    if public_zone:
        candidates.append(public_zone)
    return normalize_zone_candidates(candidates)


def resolve_bootstrap_public_zone(config: dict[str, Any]) -> str | None:
    return _resolve_public_zone(config, filter_plan_placeholders=True)


def collect_bootstrap_desired_zones(config: dict[str, Any]) -> list[str]:
    return _collect_desired_zones(config, filter_plan_placeholders=True)


def resolve_teardown_public_zone(config: dict[str, Any]) -> str | None:
    return _resolve_public_zone(config, filter_plan_placeholders=False)


def collect_teardown_desired_zones(config: dict[str, Any]) -> list[str]:
    return _collect_desired_zones(config, filter_plan_placeholders=False)
