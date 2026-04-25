#!/usr/bin/env python3

import argparse
import json
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path

import requests
from requests import RequestException


MAIL_MX_TEMPLATES = [
    {"type": "MX", "content": "route1.mx.cloudflare.net", "priority": 10, "ttl": 300},
    {"type": "MX", "content": "route2.mx.cloudflare.net", "priority": 20, "ttl": 300},
    {"type": "MX", "content": "route3.mx.cloudflare.net", "priority": 30, "ttl": 300},
    {"type": "TXT", "content": '"v=spf1 include:_spf.mx.cloudflare.net ~all"', "priority": None, "ttl": 300},
]


@dataclass(frozen=True)
class GlobalCloudflareAuth:
    auth_email: str
    global_api_key: str


def read_toml_array(text: str, key: str) -> list[str]:
    match = re.search(rf"(?ms)^\s*{re.escape(key)}\s*=\s*\[(.*?)\]", text)
    if not match:
        raise RuntimeError(f"Failed to read TOML array: {key}")
    return re.findall(r'"([^"]*)"', match.group(1))


def load_plan(plan_path: Path) -> dict:
    text = plan_path.read_text(encoding="utf-8")
    labels = read_toml_array(text, "SUBDOMAIN_LABEL_POOL")
    domains = read_toml_array(text, "DOMAINS")

    exact_domains: list[str] = []
    pool_roots: list[str] = []
    seen_exact: set[str] = set()
    seen_roots: set[str] = set()

    for domain in domains:
        if domain.startswith("*."):
            root = domain[2:]
            if root not in seen_roots:
                seen_roots.add(root)
                pool_roots.append(root)
            continue
        if domain not in seen_exact:
            seen_exact.add(domain)
            exact_domains.append(domain)

    exact_subdomains = [domain for domain in exact_domains if domain not in pool_roots]
    exact_roots = [domain for domain in exact_domains if domain in pool_roots]

    return {
        "labels": labels,
        "exact_domains": exact_domains,
        "exact_roots": exact_roots,
        "exact_subdomains": exact_subdomains,
        "pool_roots": pool_roots,
    }


def load_global_auth(secret_file: Path) -> GlobalCloudflareAuth:
    payload = json.loads(secret_file.read_text(encoding="utf-8"))
    cf = payload.get("deployment_platform_auth", {}).get("cloudflare", {})
    auth_email = str(cf.get("auth_email") or "").strip()
    global_api_key = str(cf.get("global_api_key") or "").strip()
    if not auth_email or not global_api_key:
        raise RuntimeError(f"Missing Cloudflare global auth in {secret_file}")
    return GlobalCloudflareAuth(auth_email=auth_email, global_api_key=global_api_key)


def cf_request(
    method: str,
    path: str,
    auth: GlobalCloudflareAuth,
    *,
    params=None,
    json_body=None,
    data=None,
):
    url = f"https://api.cloudflare.com/client/v4/{path}"
    headers = {
        "X-Auth-Email": auth.auth_email,
        "X-Auth-Key": auth.global_api_key,
    }
    if json_body is not None:
        headers["Content-Type"] = "application/json"

    last_error: str | None = None
    for attempt in range(10):
        try:
            response = requests.request(
                method=method,
                url=url,
                headers=headers,
                params=params,
                json=json_body,
                data=data,
                timeout=300,
            )
        except RequestException as exc:
            last_error = str(exc)
            if attempt < 9:
                time.sleep(min(30, 3 * (attempt + 1)))
                continue
            raise
        retriable = response.status_code == 429 or 500 <= response.status_code < 600
        if retriable and attempt < 9:
            backoff = min(60, 5 * (attempt + 1)) if response.status_code == 429 else min(20, 2 * (attempt + 1))
            time.sleep(backoff)
            continue
        response.raise_for_status()
        payload = response.json()
        if payload.get("success"):
            return payload
        last_error = "; ".join(f"[{e.get('code')}] {e.get('message')}" for e in payload.get("errors", []))
        if attempt < 9:
            time.sleep(min(20, 2 * (attempt + 1)))
            continue
    raise RuntimeError(f"Cloudflare API failed: {path} :: {last_error or 'unknown error'}")


def get_zones(auth: GlobalCloudflareAuth) -> list[dict]:
    page = 1
    zones: list[dict] = []
    while True:
        payload = cf_request("GET", "zones", auth, params={"page": page, "per_page": 200, "status": "active"})
        zones.extend(payload["result"])
        if page >= payload["result_info"]["total_pages"]:
            break
        page += 1
    return zones


def zone_map_by_name(zones: list[dict]) -> dict[str, dict]:
    return {zone["name"]: zone for zone in zones}


def normalize_record_identity(record: dict) -> str:
    priority = record.get("priority")
    return "|".join(
        [
            record["type"].lower(),
            record["name"].lower(),
            str(priority if priority is not None else ""),
            str(record["content"]).strip('"').rstrip(".").lower(),
        ]
    )


def get_dns_records(zone_id: str, auth: GlobalCloudflareAuth, *, name: str | None = None) -> list[dict]:
    page = 1
    records: list[dict] = []
    while True:
        params = {"page": page, "per_page": 5000}
        if name:
            params["name"] = name
        payload = cf_request("GET", f"zones/{zone_id}/dns_records", auth, params=params)
        records.extend(payload["result"])
        if page >= payload["result_info"]["total_pages"]:
            break
        page += 1
    return records


def batch_delete_dns_records(zone_id: str, auth: GlobalCloudflareAuth, record_ids: list[str]) -> int:
    if not record_ids:
        return 0
    try:
        payload = cf_request(
            "POST",
            f"zones/{zone_id}/dns_records/batch",
            auth,
            json_body={"deletes": [{"id": record_id} for record_id in record_ids]},
        )
        return len(payload["result"].get("deletes", []))
    except Exception:  # noqa: BLE001
        deleted = 0
        for record_id in record_ids:
            cf_request("DELETE", f"zones/{zone_id}/dns_records/{record_id}", auth)
            deleted += 1
        return deleted


def ensure_dns_record(zone_id: str, auth: GlobalCloudflareAuth, record: dict) -> bool:
    existing_records = get_dns_records(zone_id, auth, name=record["name"])
    desired_identity = normalize_record_identity(record)
    for existing in existing_records:
        if normalize_record_identity(existing) == desired_identity:
            return False

    body = {
        "type": record["type"],
        "name": record["name"],
        "content": record["content"].strip('"') if record["type"] == "TXT" else record["content"],
        "ttl": record["ttl"],
    }
    if record["type"] == "MX":
        body["priority"] = record["priority"]

    cf_request("POST", f"zones/{zone_id}/dns_records", auth, json_body=body)
    return True


def ensure_wildcard_dns(zone_id: str, auth: GlobalCloudflareAuth, root: str) -> int:
    created = 0
    wildcard_name = f"*.{root}"
    for template in MAIL_MX_TEMPLATES:
        record = {
            "type": template["type"],
            "name": wildcard_name,
            "content": template["content"],
            "priority": template["priority"],
            "ttl": template["ttl"],
        }
        if ensure_dns_record(zone_id, auth, record):
            created += 1
    return created


def get_email_routing_settings(zone_id: str, auth: GlobalCloudflareAuth) -> dict:
    return cf_request("GET", f"zones/{zone_id}/email/routing", auth)["result"]


def ensure_zone_enabled(zone_id: str, auth: GlobalCloudflareAuth) -> str:
    settings = get_email_routing_settings(zone_id, auth)
    if settings.get("enabled") and settings.get("status") == "ready":
        return "already-enabled"
    cf_request("POST", f"zones/{zone_id}/email/routing/enable", auth)
    return "enabled"


def ensure_catch_all_worker(zone_id: str, auth: GlobalCloudflareAuth, worker_name: str) -> str:
    body = {
        "actions": [{"type": "worker", "value": [worker_name]}],
        "matchers": [{"type": "all"}],
        "enabled": True,
    }
    current = cf_request("GET", f"zones/{zone_id}/email/routing/rules/catch_all", auth)["result"]
    desired_actions = body["actions"]
    desired_matchers = body["matchers"]
    if (
        current.get("enabled") is True
        and current.get("actions") == desired_actions
        and current.get("matchers") == desired_matchers
    ):
        return "already-set"
    cf_request("PUT", f"zones/{zone_id}/email/routing/rules/catch_all", auth, json_body=body)
    return "updated"


def subdomain_map(settings: dict) -> dict[str, dict]:
    return {item["name"]: item for item in settings.get("subdomains", [])}


def ensure_exact_subdomain_registered(zone_id: str, auth: GlobalCloudflareAuth, name: str) -> str:
    settings = get_email_routing_settings(zone_id, auth)
    current = subdomain_map(settings).get(name)
    if current and current.get("enabled"):
        return current.get("status") or "present"
    cf_request("POST", f"zones/{zone_id}/email/routing/dns", auth, json_body={"name": name})
    return "created"


def unlock_subdomain(zone_id: str, auth: GlobalCloudflareAuth, name: str) -> str:
    cf_request("PATCH", f"zones/{zone_id}/email/routing/dns", auth, json_body={"name": name})
    return "unlocked"


def main() -> None:
    parser = argparse.ArgumentParser(description="Sync Cloudflare Email Routing state for mailbox root domains and subdomain pools.")
    parser.add_argument(
        "--plan",
        default=str(Path(__file__).resolve().parent.parent / "config" / "subdomain_pool_plan_20260402.toml"),
    )
    parser.add_argument(
        "--secret-file",
        default=str(Path(__file__).resolve().parent.parent / "config" / "cloudflare_global_auth.example.json"),
    )
    parser.add_argument("--worker-name", default="cloudflare_temp_email")
    parser.add_argument("--release-pool-exact-records", action="store_true", default=True)
    parser.add_argument("--keep-pool-exact-records", action="store_true")
    parser.add_argument("--root-limit", type=int, default=0, help="Only process the first N pool roots. 0 means all.")
    parser.add_argument("--only-root", default="", help="Only process a single pool root domain.")
    parser.add_argument("--label-limit", type=int, default=0, help="Only process the first N labels per pool root. 0 means all.")
    parser.add_argument("--label-offset", type=int, default=0, help="Skip the first N labels before processing.")
    parser.add_argument("--assumed-zone-record-quota", type=int, default=200)
    parser.add_argument("--record-safety-margin", type=int, default=20)
    parser.add_argument("--max-create-batch-size", type=int, default=20)
    parser.add_argument("--max-workers", type=int, default=6)
    parser.add_argument("--sleep-seconds", type=float, default=0.15)
    args = parser.parse_args()

    release_pool_exact_records = args.release_pool_exact_records and not args.keep_pool_exact_records

    plan = load_plan(Path(args.plan))
    auth = load_global_auth(Path(args.secret_file))
    zones = get_zones(auth)
    zone_by_name = zone_map_by_name(zones)

    pool_roots = plan["pool_roots"]
    labels = plan["labels"]
    if args.only_root:
        pool_roots = [root for root in pool_roots if root == args.only_root]
    if args.label_offset > 0:
        labels = labels[args.label_offset:]
    if args.root_limit > 0:
        pool_roots = pool_roots[: args.root_limit]
    if args.label_limit > 0:
        labels = labels[: args.label_limit]

    print("==== Load Plan ====")
    print(f"Pool roots: {len(pool_roots)}")
    print(f"Labels per root: {len(labels)}")
    print(f"Exact subdomains: {len(plan['exact_subdomains'])}")
    print(f"Release pool exact records: {release_pool_exact_records}")

    counters = {
        "roots_enabled": 0,
        "catch_all_updated": 0,
        "wildcard_dns_created": 0,
        "subdomains_created": 0,
        "subdomains_unlocked": 0,
        "exact_records_deleted": 0,
        "special_subdomains_created": 0,
    }

    def process_root(root: str, root_index: int) -> dict:
        zone = zone_by_name.get(root)
        if not zone:
            raise RuntimeError(f"Zone not found in Cloudflare account: {root}")

        local = {
            "roots_enabled": 0,
            "catch_all_updated": 0,
            "wildcard_dns_created": 0,
            "subdomains_created": 0,
            "subdomains_unlocked": 0,
            "exact_records_deleted": 0,
            "special_subdomains_created": 0,
        }

        print(f"[{root_index}/{len(pool_roots)}] root={root}")
        root_state = ensure_zone_enabled(zone["id"], auth)
        if root_state == "enabled":
            local["roots_enabled"] += 1
        catch_all_state = ensure_catch_all_worker(zone["id"], auth, args.worker_name)
        if catch_all_state == "updated":
            local["catch_all_updated"] += 1
        local["wildcard_dns_created"] += ensure_wildcard_dns(zone["id"], auth, root)

        settings = get_email_routing_settings(zone["id"], auth)
        known_subdomains = subdomain_map(settings)
        all_zone_records = get_dns_records(zone["id"], auth)
        current_record_count = len(all_zone_records)
        available_records = max(4, args.assumed_zone_record_quota - args.record_safety_margin - current_record_count)
        create_batch_size = max(1, min(args.max_create_batch_size, available_records // 4 or 1))
        print(f"[{root}] current_records={current_record_count} batch_size={create_batch_size}")

        pending_subdomains: list[str] = []
        for label in labels:
            subdomain = f"{label}.{root}"
            current = known_subdomains.get(subdomain)
            if release_pool_exact_records:
                if current is None or current.get("status") != "unconfigured":
                    pending_subdomains.append(subdomain)
            elif current is None:
                pending_subdomains.append(subdomain)

        for batch_start in range(0, len(pending_subdomains), create_batch_size):
            batch = pending_subdomains[batch_start: batch_start + create_batch_size]
            for subdomain in batch:
                current = known_subdomains.get(subdomain)
                if current is None:
                    ensure_exact_subdomain_registered(zone["id"], auth, subdomain)
                    local["subdomains_created"] += 1
                    known_subdomains[subdomain] = {"name": subdomain, "status": "ready"}
                    time.sleep(args.sleep_seconds)
                if release_pool_exact_records:
                    unlock_subdomain(zone["id"], auth, subdomain)
                    local["subdomains_unlocked"] += 1
                    known_subdomains[subdomain] = {"name": subdomain, "status": "unconfigured"}
                    time.sleep(args.sleep_seconds)

            if release_pool_exact_records and batch:
                refreshed_records = get_dns_records(zone["id"], auth)
                batch_names = set(batch)
                delete_ids = [record["id"] for record in refreshed_records if record["name"] in batch_names]
                local["exact_records_deleted"] += batch_delete_dns_records(zone["id"], auth, delete_ids)
                time.sleep(args.sleep_seconds)

            processed = min(batch_start + len(batch), len(pending_subdomains))
            print(
                f"[{root}] labels {processed}/{len(pending_subdomains)} "
                f"created={local['subdomains_created']} "
                f"unlocked={local['subdomains_unlocked']} "
                f"deleted={local['exact_records_deleted']}"
            )

        return local

    failed_roots: list[tuple[str, str]] = []

    with ThreadPoolExecutor(max_workers=max(1, args.max_workers)) as executor:
        future_map = {
            executor.submit(process_root, root, index): root
            for index, root in enumerate(pool_roots, start=1)
        }
        for future in as_completed(future_map):
            root = future_map[future]
            try:
                result = future.result()
            except Exception as exc:  # noqa: BLE001
                failed_roots.append((root, str(exc)))
                print(f"[failed] root={root} error={exc}")
                continue
            for key, value in result.items():
                counters[key] += value
            print(
                f"[done] root={root} "
                f"created={result['subdomains_created']} "
                f"unlocked={result['subdomains_unlocked']} "
                f"deleted={result['exact_records_deleted']}"
            )

    print("==== Ensure Exact Special Subdomains ====")
    for name in plan["exact_subdomains"]:
        zone_name = ".".join(name.split(".")[1:])
        zone = zone_by_name.get(zone_name)
        if not zone:
            raise RuntimeError(f"Zone not found for exact subdomain: {name}")
        ensure_zone_enabled(zone["id"], auth)
        ensure_catch_all_worker(zone["id"], auth, args.worker_name)
        result = ensure_exact_subdomain_registered(zone["id"], auth, name)
        if result == "created":
            counters["special_subdomains_created"] += 1
        print(f"  special={name} state={result}")

    print("==== Summary ====")
    for key, value in counters.items():
        print(f"{key}: {value}")
    if failed_roots:
        print("failed_roots:")
        for root, error in failed_roots:
            print(f"{root}: {error}")
        raise SystemExit(1)


if __name__ == "__main__":
    main()
