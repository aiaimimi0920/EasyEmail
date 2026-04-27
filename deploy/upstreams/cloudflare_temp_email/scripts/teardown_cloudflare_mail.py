#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

import urllib.error
import urllib.parse
import urllib.request

import yaml


MAIL_MX_TEMPLATES = [
    {"type": "MX", "content": "route1.mx.cloudflare.net", "priority": 10, "ttl": 300},
    {"type": "MX", "content": "route2.mx.cloudflare.net", "priority": 20, "ttl": 300},
    {"type": "MX", "content": "route3.mx.cloudflare.net", "priority": 30, "ttl": 300},
    {"type": "TXT", "content": "v=spf1 include:_spf.mx.cloudflare.net ~all", "priority": None, "ttl": 300},
]


@dataclass(frozen=True)
class CloudflareAuth:
    headers: dict[str, str]
    env: dict[str, str]
    mode: str


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
    ordered: list[str] = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        ordered.append(value)
    return ordered


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


def build_target_hosts(config: dict[str, Any]) -> dict[str, list[str]]:
    cloudflare = as_dict(config.get("cloudflareMail"))
    routing = as_dict(cloudflare.get("routing"))
    plan = as_dict(routing.get("plan"))

    domains = normalize_string_list(plan.get("domains"))
    labels = normalize_string_list(plan.get("subdomainLabelPool"))
    public_domain = str(cloudflare.get("publicDomain") or "").strip().lower()
    public_zone = resolve_public_zone(config)

    wildcard_roots = [domain[2:] for domain in domains if domain.startswith("*.")]
    exact_domains = [domain for domain in domains if not domain.startswith("*.")]
    exact_pool_hosts: list[str] = []
    wildcard_hosts: list[str] = []

    for root in wildcard_roots:
        wildcard_hosts.append(f"*.{root}")
        for label in labels:
            exact_pool_hosts.append(f"{label}.{root}")

    all_hosts = exact_domains + exact_pool_hosts + wildcard_hosts
    if public_domain:
        all_hosts.append(public_domain)
    if public_zone:
        all_hosts.append(public_zone)
    all_hosts.extend(wildcard_roots)

    return {
        "labels": labels,
        "exactDomains": unique_preserve_order(exact_domains),
        "wildcardRoots": unique_preserve_order(wildcard_roots),
        "exactPoolHosts": unique_preserve_order(exact_pool_hosts),
        "wildcardHosts": unique_preserve_order(wildcard_hosts),
        "allHosts": unique_preserve_order(all_hosts),
    }


def get_auth_config(config: dict[str, Any]) -> CloudflareAuth:
    cloudflare = as_dict(config.get("cloudflareMail"))
    routing = as_dict(cloudflare.get("routing"))
    global_auth = as_dict(routing.get("cloudflareGlobalAuth"))

    auth_email = str(global_auth.get("authEmail") or "").strip()
    global_api_key = str(global_auth.get("globalApiKey") or "").strip()
    env = os.environ.copy()

    if auth_email and global_api_key:
        env["CLOUDFLARE_EMAIL"] = auth_email
        env["CLOUDFLARE_API_KEY"] = global_api_key
        env.pop("CLOUDFLARE_API_TOKEN", None)
        return CloudflareAuth(
            headers={
                "X-Auth-Email": auth_email,
                "X-Auth-Key": global_api_key,
                "Accept": "application/json",
                "User-Agent": "easyemail-teardown",
            },
            env=env,
            mode="global-api-key",
        )

    api_token = str(env.get("CLOUDFLARE_API_TOKEN") or "").strip()
    if api_token:
        env["CLOUDFLARE_API_TOKEN"] = api_token
        env.pop("CLOUDFLARE_EMAIL", None)
        env.pop("CLOUDFLARE_API_KEY", None)
        return CloudflareAuth(
            headers={
                "Authorization": f"Bearer {api_token}",
                "Accept": "application/json",
                "User-Agent": "easyemail-teardown",
            },
            env=env,
            mode="api-token",
        )

    raise SystemExit(
        "Teardown requires either cloudflareMail.routing.cloudflareGlobalAuth authEmail/globalApiKey in config.yaml or CLOUDFLARE_API_TOKEN in the environment."
    )


def cf_request(
    method: str,
    path: str,
    headers: dict[str, str],
    *,
    params: dict[str, Any] | None = None,
    json_body: Any = None,
    allow_statuses: set[int] | None = None,
) -> dict[str, Any] | None:
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
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    raw_body = b""
    last_error: Exception | None = None
    for attempt in range(5):
        try:
            with opener.open(request, timeout=60) as response:
                raw_body = response.read()
            last_error = None
            break
        except urllib.error.HTTPError as exc:
            if allow_statuses and exc.code in allow_statuses:
                return None
            error_body = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"Cloudflare API HTTP {exc.code} for {path}: {error_body}") from exc
        except (urllib.error.URLError, OSError) as exc:
            last_error = exc
            if attempt >= 4:
                break
            time.sleep(min(10, 2 * (attempt + 1)))

    if last_error is not None:
        raise RuntimeError(f"Cloudflare API transport failed for {path}: {last_error}") from last_error

    if not raw_body:
        return {"success": True, "result": {}}

    payload = json.loads(raw_body.decode("utf-8"))

    if not payload.get("success"):
        errors = "; ".join(f"[{error.get('code')}] {error.get('message')}" for error in payload.get("errors", []))
        raise RuntimeError(f"Cloudflare API failed for {path}: {errors or 'unknown error'}")
    return payload


def fetch_all_zones(headers: dict[str, str]) -> list[dict[str, Any]]:
    page = 1
    zones: list[dict[str, Any]] = []
    while True:
        payload = cf_request("GET", "zones", headers, params={"page": page, "per_page": 200})
        if payload is None:
            break
        zones.extend(payload["result"])
        result_info = payload.get("result_info") or {}
        total_pages = int(result_info.get("total_pages") or 1)
        if page >= total_pages:
            break
        page += 1
    return zones


def build_zone_lookup(zones: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {str(zone.get("name") or "").strip().lower(): zone for zone in zones if zone.get("name")}


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


def list_worker_domains(headers: dict[str, str], account_id: str) -> list[dict[str, Any]]:
    payload = cf_request("GET", f"accounts/{account_id}/workers/domains", headers)
    return [] if payload is None else list(payload["result"])


def get_zone_dns_records(zone_id: str, headers: dict[str, str]) -> list[dict[str, Any]]:
    page = 1
    records: list[dict[str, Any]] = []
    while True:
        payload = cf_request("GET", f"zones/{zone_id}/dns_records", headers, params={"page": page, "per_page": 5000})
        if payload is None:
            break
        records.extend(payload["result"])
        result_info = payload.get("result_info") or {}
        total_pages = int(result_info.get("total_pages") or 1)
        if page >= total_pages:
            break
        page += 1
    return records


def get_email_routing_settings(zone_id: str, headers: dict[str, str]) -> dict[str, Any] | None:
    payload = cf_request("GET", f"zones/{zone_id}/email/routing", headers, allow_statuses={404})
    return None if payload is None else payload["result"]


def get_email_routing_rules(zone_id: str, headers: dict[str, str]) -> list[dict[str, Any]]:
    payload = cf_request("GET", f"zones/{zone_id}/email/routing/rules", headers, allow_statuses={404})
    return [] if payload is None else list(payload["result"])


def get_email_routing_catch_all(zone_id: str, headers: dict[str, str]) -> dict[str, Any] | None:
    payload = cf_request("GET", f"zones/{zone_id}/email/routing/rules/catch_all", headers, allow_statuses={404})
    return None if payload is None else payload["result"]


def delete_email_routing_rule(zone_id: str, headers: dict[str, str], rule_id: str) -> bool:
    payload = cf_request("DELETE", f"zones/{zone_id}/email/routing/rules/{rule_id}", headers, allow_statuses={404, 409})
    return payload is not None


def delete_email_routing_catch_all(zone_id: str, headers: dict[str, str]) -> bool:
    payload = cf_request("DELETE", f"zones/{zone_id}/email/routing/rules/catch_all", headers, allow_statuses={400, 404, 409})
    return payload is not None


def disable_email_routing(zone_id: str, headers: dict[str, str]) -> bool:
    payload = cf_request("DELETE", f"zones/{zone_id}/email/routing/dns", headers, allow_statuses={404})
    return payload is not None


def normalize_record_identity(record_type: str, name: str, content: str, priority: int | None) -> str:
    normalized_content = content.strip('"').rstrip(".").lower()
    return "|".join([record_type.lower(), name.lower(), str(priority or ""), normalized_content])


def build_managed_dns_identity_set(target_hosts: list[str]) -> set[str]:
    identities: set[str] = set()
    for host in target_hosts:
        for template in MAIL_MX_TEMPLATES:
            identities.add(
                normalize_record_identity(
                    template["type"],
                    host,
                    template["content"],
                    template["priority"],
                )
            )
    return identities


def find_managed_dns_records(records: list[dict[str, Any]], target_hosts: list[str]) -> list[dict[str, Any]]:
    host_set = {host.lower() for host in target_hosts}
    identities = build_managed_dns_identity_set(target_hosts)
    managed: list[dict[str, Any]] = []
    for record in records:
        record_name = str(record.get("name") or "").strip().lower()
        if record_name not in host_set:
            continue
        record_type = str(record.get("type") or "")
        content = str(record.get("content") or "")
        priority_value = record.get("priority")
        priority = int(priority_value) if priority_value is not None else None
        identity = normalize_record_identity(record_type, record_name, content, priority)
        if identity in identities:
            managed.append(record)
    return managed


def delete_dns_records_batch(zone_id: str, headers: dict[str, str], record_ids: list[str]) -> int:
    if not record_ids:
        return 0
    try:
        payload = cf_request(
            "POST",
            f"zones/{zone_id}/dns_records/batch",
            headers,
            json_body={"deletes": [{"id": record_id} for record_id in record_ids]},
        )
        if payload is None:
            return 0
        return len((payload.get("result") or {}).get("deletes", []))
    except RuntimeError:
        deleted = 0
        for record_id in record_ids:
            payload = cf_request("DELETE", f"zones/{zone_id}/dns_records/{record_id}", headers, allow_statuses={404})
            if payload is not None:
                deleted += 1
        return deleted


def detach_worker_domain(headers: dict[str, str], account_id: str, domain_id: str) -> bool:
    payload = cf_request("DELETE", f"accounts/{account_id}/workers/domains/{domain_id}", headers, allow_statuses={404})
    return payload is not None


def run_wrangler_command(wrangler_command: str, worker_dir: Path, env: dict[str, str], args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [wrangler_command, *args],
        cwd=worker_dir,
        env=env,
        capture_output=True,
        text=True,
    )


def delete_worker(wrangler_command: str, worker_dir: Path, env: dict[str, str], worker_name: str, worker_env: str) -> dict[str, Any]:
    args = ["delete", worker_name, "--force"]
    if worker_env and worker_env != "production":
        args.extend(["--env", worker_env])
    completed = run_wrangler_command(wrangler_command, worker_dir, env, args)
    output = (completed.stdout or "") + (completed.stderr or "")
    if completed.returncode != 0:
        lowered = output.lower()
        if "not found" in lowered or "script does not exist" in lowered or "does not exist on this account" in lowered:
            return {"deleted": False, "missing": True, "output": output.strip()}
        raise RuntimeError(f"wrangler delete failed: {output.strip()}")
    return {"deleted": True, "missing": False, "output": output.strip()}


def list_d1_databases(wrangler_command: str, worker_dir: Path, env: dict[str, str]) -> list[dict[str, Any]]:
    completed = subprocess.run(
        [wrangler_command, "d1", "list", "--json"],
        cwd=worker_dir,
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(completed.stdout)


def get_d1_info(wrangler_command: str, worker_dir: Path, env: dict[str, str], database_name: str) -> dict[str, Any] | None:
    completed = run_wrangler_command(wrangler_command, worker_dir, env, ["d1", "info", database_name, "--json"])
    if completed.returncode != 0:
        output = ((completed.stdout or "") + (completed.stderr or "")).lower()
        if "not found" in output:
            return None
        return None
    return json.loads(completed.stdout)


def delete_d1_database(
    wrangler_command: str,
    worker_dir: Path,
    env: dict[str, str],
    headers: dict[str, str],
    account_id: str,
    database_name: str,
) -> dict[str, Any]:
    databases = list_d1_databases(wrangler_command, worker_dir, env)
    match = next((item for item in databases if str(item.get("name") or "") == database_name), None)
    if match is None:
        return {"deleted": False, "missing": True, "output": f"D1 database not found: {database_name}"}

    database_id = str(match.get("uuid") or match.get("id") or "").strip()
    if not database_id:
        raise RuntimeError(f"Unable to resolve D1 database id for {database_name}")

    payload = cf_request("DELETE", f"accounts/{account_id}/d1/database/{database_id}", headers, allow_statuses={404})
    if payload is None:
        return {"deleted": False, "missing": True, "output": f"D1 database already missing: {database_name} ({database_id})"}
    return {"deleted": True, "missing": False, "output": f"Deleted D1 database {database_name} ({database_id})"}


def write_backup_file(config_path: Path, backup_payload: dict[str, Any], backup_path: str | None) -> Path:
    if backup_path:
        destination = Path(backup_path).resolve()
    else:
        temp_root = config_path.parent / ".tmp"
        temp_root.mkdir(parents=True, exist_ok=True)
        destination = temp_root / f"cloudflare-mail-teardown-backup-{uuid4().hex}.json"
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(backup_payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return destination


def main() -> int:
    parser = argparse.ArgumentParser(description="Backup and tear down deployed Cloudflare mail resources.")
    parser.add_argument("--config", required=True, help="Root config.yaml path.")
    parser.add_argument("--worker-dir", required=True, help="Worker package directory containing local wrangler.")
    parser.add_argument("--wrangler-command", required=True, help="Absolute path to the local wrangler executable.")
    parser.add_argument("--backup-path", default="", help="Optional path for the backup JSON file.")
    parser.add_argument("--dry-run", action="store_true", help="Preview deletions without mutating Cloudflare resources.")
    args = parser.parse_args()

    config_path = Path(args.config).resolve()
    worker_dir = Path(args.worker_dir).resolve()
    wrangler_command = str(Path(args.wrangler_command).resolve())

    config = load_yaml_file(config_path)
    auth = get_auth_config(config)
    account_id = resolve_account_id(config, wrangler_command, worker_dir, auth.env)

    cloudflare = as_dict(config.get("cloudflareMail"))
    worker = as_dict(cloudflare.get("worker"))
    routing = as_dict(cloudflare.get("routing"))
    target_hosts = build_target_hosts(config)
    desired_zones = collect_desired_zones(config)
    public_domain = str(cloudflare.get("publicDomain") or "").strip().lower()
    public_zone = resolve_public_zone(config)
    worker_name = str(cloudflare.get("workerName") or "cloudflare_temp_email").strip() or "cloudflare_temp_email"
    worker_env = str(cloudflare.get("workerEnv") or "production").strip() or "production"
    d1_entries = [entry for entry in as_list(worker.get("d1_databases")) if isinstance(entry, dict)]
    d1_entry = d1_entries[0] if d1_entries else {}
    d1_database_name = str(d1_entry.get("database_name") or "").strip()

    zones = fetch_all_zones(auth.headers)
    zone_lookup = build_zone_lookup(zones)
    relevant_zone_names = unique_preserve_order([zone_name for zone_name in desired_zones if zone_name in zone_lookup])
    relevant_zones = [zone_lookup[name] for name in relevant_zone_names]
    target_host_set = target_hosts["allHosts"]

    zone_backups: list[dict[str, Any]] = []
    zone_delete_plan: list[dict[str, Any]] = []
    for zone in relevant_zones:
        zone_name = str(zone["name"])
        rules = get_email_routing_rules(str(zone["id"]), auth.headers)
        catch_all = get_email_routing_catch_all(str(zone["id"]), auth.headers)
        settings = get_email_routing_settings(str(zone["id"]), auth.headers)
        all_dns_records = get_zone_dns_records(str(zone["id"]), auth.headers)
        managed_dns_records = find_managed_dns_records(all_dns_records, target_host_set + [zone_name])
        zone_backups.append(
            {
                "zone": zone,
                "emailRoutingSettings": settings,
                "emailRoutingRules": rules,
                "catchAllRule": catch_all,
                "managedDnsRecords": managed_dns_records,
            }
        )
        zone_delete_plan.append(
            {
                "zoneName": zone_name,
                "zoneId": zone["id"],
                "ruleIds": [rule["id"] for rule in rules if rule.get("id")],
                "hasCatchAll": bool(catch_all),
                "managedDnsRecordIds": [record["id"] for record in managed_dns_records if record.get("id")],
            }
        )

    worker_domains = list_worker_domains(auth.headers, account_id)
    managed_worker_domains = [
        domain
        for domain in worker_domains
        if str(domain.get("service") or "") == worker_name
        or str(domain.get("hostname") or "").strip().lower() == public_domain
    ]

    d1_info = get_d1_info(wrangler_command, worker_dir, auth.env, d1_database_name) if d1_database_name else None

    backup_payload = {
        "generatedAtUtc": datetime.now(timezone.utc).isoformat(),
        "accountId": account_id,
        "authMode": auth.mode,
        "dryRun": bool(args.dry_run),
        "configSummary": {
            "publicBaseUrl": cloudflare.get("publicBaseUrl"),
            "publicDomain": public_domain,
            "publicZone": public_zone,
            "workerName": worker_name,
            "workerEnv": worker_env,
            "d1DatabaseName": d1_database_name,
            "routingMode": routing.get("mode"),
        },
        "targets": target_hosts,
        "zones": zone_backups,
        "workerDomains": managed_worker_domains,
        "d1": d1_info,
        "deletePlan": {
            "detachWorkerDomains": [domain["id"] for domain in managed_worker_domains if domain.get("id")],
            "deleteWorker": {"name": worker_name, "env": worker_env},
            "deleteD1Database": d1_database_name,
            "zones": zone_delete_plan,
        },
    }

    backup_file = write_backup_file(config_path, backup_payload, args.backup_path or None)

    results = {
        "backupPath": str(backup_file),
        "dryRun": bool(args.dry_run),
        "detachedWorkerDomains": 0,
        "deletedRoutingRules": 0,
        "deletedCatchAllRules": 0,
        "disabledRoutingZones": 0,
        "deletedManagedDnsRecords": 0,
        "deletedWorker": False,
        "deletedD1": False,
    }

    if args.dry_run:
        print(json.dumps(results, ensure_ascii=False))
        return 0

    for domain in managed_worker_domains:
        domain_id = str(domain.get("id") or "").strip()
        if not domain_id:
            continue
        if detach_worker_domain(auth.headers, account_id, domain_id):
            results["detachedWorkerDomains"] += 1

    for plan_entry in zone_delete_plan:
        zone_id = str(plan_entry["zoneId"])
        for rule_id in plan_entry["ruleIds"]:
            if delete_email_routing_rule(zone_id, auth.headers, str(rule_id)):
                results["deletedRoutingRules"] += 1
        if plan_entry["hasCatchAll"] and delete_email_routing_catch_all(zone_id, auth.headers):
            results["deletedCatchAllRules"] += 1
        if disable_email_routing(zone_id, auth.headers):
            results["disabledRoutingZones"] += 1
        record_ids = [str(record_id) for record_id in plan_entry["managedDnsRecordIds"]]
        results["deletedManagedDnsRecords"] += delete_dns_records_batch(zone_id, auth.headers, record_ids)

    worker_result = delete_worker(wrangler_command, worker_dir, auth.env, worker_name, worker_env)
    results["deletedWorker"] = bool(worker_result["deleted"])
    results["workerDelete"] = worker_result

    if d1_database_name:
        d1_result = delete_d1_database(wrangler_command, worker_dir, auth.env, auth.headers, account_id, d1_database_name)
        results["deletedD1"] = bool(d1_result["deleted"])
        results["d1Delete"] = d1_result

    print(json.dumps(results, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
