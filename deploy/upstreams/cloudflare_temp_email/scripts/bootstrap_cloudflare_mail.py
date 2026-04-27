#!/usr/bin/env python3

from __future__ import annotations

import argparse
import copy
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any
from uuid import uuid4

import yaml


ZERO_UUID = "00000000-0000-0000-0000-000000000000"


def load_yaml_file(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise SystemExit(f"Config not found: {path}")
    return yaml.safe_load(path.read_text(encoding="utf-8-sig")) or {}


def deep_copy(value: Any) -> Any:
    return copy.deepcopy(value)


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
    normalized = unique_preserve_order([candidate.strip().lower().rstrip(".") for candidate in candidates if candidate.strip()])
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


def resolve_public_zone(config: dict[str, Any]) -> str | None:
    cloudflare = as_dict(config.get("cloudflareMail"))
    bootstrap = get_bootstrap_config(config)
    public_domain = str(cloudflare.get("publicDomain") or "").strip().lower()
    if not public_domain:
        return None

    explicit = first_non_empty(cloudflare.get("publicZone"), bootstrap.get("publicZone"))
    if isinstance(explicit, str) and explicit.strip():
        return explicit.strip().lower().rstrip(".")

    routing = as_dict(cloudflare.get("routing"))
    plan = as_dict(routing.get("plan"))
    plan_domains = normalize_string_list(plan.get("domains"))
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

    matches = [candidate for candidate in unique_preserve_order(candidates) if is_subdomain_of(public_domain, candidate.lower().rstrip("."))]
    if not matches:
        return None
    matches.sort(key=lambda item: (item.count("."), len(item)))
    return matches[0].rstrip(".")


def collect_desired_zones(config: dict[str, Any]) -> list[str]:
    cloudflare = as_dict(config.get("cloudflareMail"))
    routing = as_dict(cloudflare.get("routing"))
    plan = as_dict(routing.get("plan"))
    bootstrap = get_bootstrap_config(config)

    plan_domains = normalize_string_list(plan.get("domains"))
    wildcard_roots = [domain[2:] for domain in plan_domains if domain.startswith("*.")]
    exact_domains = [domain for domain in plan_domains if not domain.startswith("*.")]
    manual_zones = normalize_string_list(bootstrap.get("zones"))
    public_zone = resolve_public_zone(config)

    candidates = manual_zones + wildcard_roots + exact_domains
    if public_zone:
        candidates.append(public_zone)

    return normalize_zone_candidates(candidates)


def get_auth_config(config: dict[str, Any]) -> tuple[dict[str, str], dict[str, str]]:
    cloudflare = as_dict(config.get("cloudflareMail"))
    routing = as_dict(cloudflare.get("routing"))
    global_auth = as_dict(routing.get("cloudflareGlobalAuth"))

    env = os.environ.copy()
    api_token = str(env.get("CLOUDFLARE_API_TOKEN") or "").strip()
    if api_token:
        return (
            {
                "Authorization": f"Bearer {api_token}",
                "Accept": "application/json",
                "User-Agent": "easyemail-bootstrap",
            },
            env,
        )

    auth_email = str(global_auth.get("authEmail") or "").strip()
    global_api_key = str(global_auth.get("globalApiKey") or "").strip()
    if not auth_email or not global_api_key:
        raise SystemExit(
            "Bootstrap requires either CLOUDFLARE_API_TOKEN or cloudflareMail.routing.cloudflareGlobalAuth authEmail/globalApiKey."
        )

    env.setdefault("CLOUDFLARE_EMAIL", auth_email)
    env.setdefault("CLOUDFLARE_API_KEY", global_api_key)
    return (
        {
            "X-Auth-Email": auth_email,
            "X-Auth-Key": global_api_key,
            "Accept": "application/json",
            "User-Agent": "easyemail-bootstrap",
        },
        env,
    )


def cf_request(method: str, path: str, headers: dict[str, str], *, params: dict[str, Any] | None = None, json_body: Any = None) -> dict[str, Any]:
    query = ""
    if params:
        query = "?" + urllib.parse.urlencode({key: value for key, value in params.items() if value is not None}, doseq=True)
    body = None
    request_headers = dict(headers)
    if json_body is not None:
        body = json.dumps(json_body).encode("utf-8")
        request_headers["Content-Type"] = "application/json"

    request = urllib.request.Request(
        f"https://api.cloudflare.com/client/v4/{path}{query}",
        data=body,
        headers=request_headers,
        method=method,
    )

    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            payload = json.load(response)
    except urllib.error.HTTPError as exc:
        error_body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Cloudflare API HTTP {exc.code} for {path}: {error_body}") from exc

    if not payload.get("success"):
        errors = "; ".join(f"[{error.get('code')}] {error.get('message')}" for error in payload.get("errors", []))
        raise RuntimeError(f"Cloudflare API failed for {path}: {errors or 'unknown error'}")
    return payload


def get_accounts_from_wrangler(wrangler_command: str, worker_dir: Path, env: dict[str, str]) -> list[dict[str, Any]]:
    completed = subprocess.run(
        [wrangler_command, "whoami", "--json"],
        cwd=worker_dir,
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )
    payload = json.loads(completed.stdout)
    return payload.get("accounts", [])


def resolve_account_id(config: dict[str, Any], wrangler_command: str, worker_dir: Path, env: dict[str, str]) -> str:
    bootstrap = get_bootstrap_config(config)
    configured = str(bootstrap.get("accountId") or "").strip()
    if configured:
        return configured

    accounts = get_accounts_from_wrangler(wrangler_command, worker_dir, env)
    if len(accounts) == 1:
        return str(accounts[0]["id"])

    if not accounts:
        raise SystemExit("Unable to resolve Cloudflare account id via wrangler whoami.")

    account_summaries = ", ".join(f"{account.get('name')} ({account.get('id')})" for account in accounts)
    raise SystemExit(
        "Multiple Cloudflare accounts are visible. Set cloudflareMail.bootstrap.accountId explicitly. "
        f"Available accounts: {account_summaries}"
    )


def fetch_all_zones(headers: dict[str, str]) -> list[dict[str, Any]]:
    page = 1
    zones: list[dict[str, Any]] = []
    while True:
        payload = cf_request("GET", "zones", headers, params={"page": page, "per_page": 200})
        zones.extend(payload["result"])
        result_info = payload.get("result_info") or {}
        total_pages = int(result_info.get("total_pages") or 1)
        if page >= total_pages:
            break
        page += 1
    return zones


def build_zone_lookup(zones: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {str(zone.get("name") or "").strip().lower(): zone for zone in zones if zone.get("name")}


def ensure_zones(
    config: dict[str, Any],
    headers: dict[str, str],
    account_id: str,
    *,
    create_missing: bool,
    dry_run: bool,
) -> dict[str, Any]:
    bootstrap = get_bootstrap_config(config)
    desired_zones = collect_desired_zones(config)
    zone_type = str(bootstrap.get("zoneType") or "full").strip() or "full"
    jump_start = bool(bootstrap.get("jumpStart") or False)

    zones = fetch_all_zones(headers)
    zone_lookup = build_zone_lookup(zones)

    created: list[str] = []
    missing: list[str] = []
    would_create: list[str] = []

    for zone_name in desired_zones:
        if zone_name in zone_lookup:
            continue
        if not create_missing:
            missing.append(zone_name)
            continue
        if dry_run:
            would_create.append(zone_name)
            continue
        cf_request(
            "POST",
            "zones",
            headers,
            json_body={
                "name": zone_name,
                "account": {"id": account_id},
                "type": zone_type,
                "jump_start": jump_start,
            },
        )
        created.append(zone_name)

    if created:
        zones = fetch_all_zones(headers)
        zone_lookup = build_zone_lookup(zones)

    pending: list[dict[str, Any]] = []
    unresolved: list[str] = []
    for zone_name in desired_zones:
        zone = zone_lookup.get(zone_name)
        if zone is None:
            unresolved.append(zone_name)
            continue
        if zone.get("status") != "active":
            pending.append(
                {
                    "name": zone_name,
                    "status": zone.get("status"),
                    "nameServers": zone.get("name_servers") or [],
                }
            )

    return {
        "desired": desired_zones,
        "created": created,
        "missing": missing,
        "wouldCreate": would_create,
        "pending": pending,
        "unresolved": unresolved,
    }


def is_placeholder_database_id(value: str | None) -> bool:
    if value is None:
        return True
    stripped = value.strip()
    if not stripped:
        return True
    return stripped == ZERO_UUID


def run_wrangler_json(wrangler_command: str, worker_dir: Path, env: dict[str, str], args: list[str]) -> Any:
    completed = subprocess.run(
        [wrangler_command, *args],
        cwd=worker_dir,
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(completed.stdout)


def run_wrangler_passthrough(wrangler_command: str, worker_dir: Path, env: dict[str, str], args: list[str]) -> None:
    subprocess.run(
        [wrangler_command, *args],
        cwd=worker_dir,
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )


def ensure_d1_database(
    config: dict[str, Any],
    wrangler_command: str,
    worker_dir: Path,
    env: dict[str, str],
    *,
    dry_run: bool,
) -> dict[str, Any]:
    cloudflare = as_dict(config.get("cloudflareMail"))
    worker = as_dict(cloudflare.get("worker"))
    d1_entries = [entry for entry in as_list(worker.get("d1_databases")) if isinstance(entry, dict)]
    if not d1_entries:
        raise SystemExit("cloudflareMail.worker.d1_databases must contain at least one D1 binding for bootstrap mode.")

    entry = d1_entries[0]
    database_name = str(entry.get("database_name") or "").strip()
    binding = str(entry.get("binding") or "DB").strip() or "DB"
    if not database_name:
        raise SystemExit("The first cloudflareMail.worker.d1_databases entry must define database_name.")

    configured_id = str(entry.get("database_id") or "").strip()
    bootstrap = get_bootstrap_config(config)
    location = str(bootstrap.get("d1LocationHint") or "").strip()
    jurisdiction = str(bootstrap.get("d1Jurisdiction") or "").strip()

    databases = run_wrangler_json(wrangler_command, worker_dir, env, ["d1", "list", "--json"])
    match = next((item for item in databases if str(item.get("name") or "") == database_name), None)

    created = False
    would_create = False
    if match is None:
        if dry_run:
            would_create = True
        else:
            args = ["d1", "create", database_name, "--binding", binding]
            if location:
                args.extend(["--location", location])
            if jurisdiction:
                args.extend(["--jurisdiction", jurisdiction])
            run_wrangler_passthrough(wrangler_command, worker_dir, env, args)
            databases = run_wrangler_json(wrangler_command, worker_dir, env, ["d1", "list", "--json"])
            match = next((item for item in databases if str(item.get("name") or "") == database_name), None)
            if match is None:
                raise SystemExit(f"Wrangler created D1 database '{database_name}', but it was not visible in d1 list afterwards.")
            created = True

    resolved_id = str(match.get("uuid") or "") if match else configured_id
    changed = False
    if match and resolved_id and (is_placeholder_database_id(configured_id) or configured_id != resolved_id):
        entry["database_id"] = resolved_id
        changed = True

    return {
        "databaseName": database_name,
        "binding": binding,
        "databaseId": resolved_id,
        "created": created,
        "wouldCreate": would_create,
        "changed": changed,
    }


def write_temp_config(config: dict[str, Any], config_path: Path) -> Path:
    temp_root = config_path.parent / ".tmp"
    temp_root.mkdir(parents=True, exist_ok=True)
    temp_path = temp_root / f"cloudflare-bootstrap-config-{uuid4().hex}.yaml"
    temp_path.write_text(yaml.safe_dump(config, sort_keys=False, allow_unicode=True), encoding="utf-8")
    return temp_path


def main() -> int:
    parser = argparse.ArgumentParser(description="Bootstrap missing Cloudflare Mail resources before deploy.")
    parser.add_argument("--config", required=True, help="Root config.yaml path.")
    parser.add_argument("--worker-dir", required=True, help="Worker package directory containing local wrangler.")
    parser.add_argument("--wrangler-command", required=True, help="Absolute path to the local wrangler executable.")
    parser.add_argument("--create-missing-zones", action="store_true", help="Create missing Cloudflare zones before deploy.")
    parser.add_argument("--dry-run", action="store_true", help="Validate bootstrap actions without mutating resources.")
    args = parser.parse_args()

    config_path = Path(args.config).resolve()
    worker_dir = Path(args.worker_dir).resolve()
    wrangler_command = str(Path(args.wrangler_command).resolve())

    config = load_yaml_file(config_path)
    cloudflare = as_dict(config.get("cloudflareMail"))
    public_domain = str(cloudflare.get("publicDomain") or "").strip().lower()
    if not public_domain:
        raise SystemExit("cloudflareMail.publicDomain is required for bootstrap mode.")

    headers, env = get_auth_config(config)
    account_id = resolve_account_id(config, wrangler_command, worker_dir, env)
    zone_result = ensure_zones(
        config,
        headers,
        account_id,
        create_missing=args.create_missing_zones,
        dry_run=args.dry_run,
    )

    if zone_result["missing"]:
        raise SystemExit(
            "Missing Cloudflare zones and bootstrap zone creation is disabled: "
            + ", ".join(zone_result["missing"])
        )

    if zone_result["unresolved"]:
        raise SystemExit(
            "Failed to resolve required Cloudflare zones after bootstrap: "
            + ", ".join(zone_result["unresolved"])
        )

    if zone_result["pending"]:
        pending_descriptions = []
        for item in zone_result["pending"]:
            nameservers = ", ".join(item.get("nameServers") or [])
            pending_descriptions.append(f"{item['name']} ({item['status']}) nameservers=[{nameservers}]")
        raise SystemExit(
            "Some Cloudflare zones exist but are not active yet. Complete nameserver activation first: "
            + "; ".join(pending_descriptions)
        )

    d1_result = ensure_d1_database(config, wrangler_command, worker_dir, env, dry_run=args.dry_run)

    effective_config_path = config_path
    if d1_result["changed"]:
        effective_config_path = write_temp_config(config, config_path)

    summary = {
        "accountId": account_id,
        "publicDomain": public_domain,
        "publicZone": resolve_public_zone(config),
        "configPath": str(effective_config_path),
        "zone": zone_result,
        "d1": d1_result,
    }
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
