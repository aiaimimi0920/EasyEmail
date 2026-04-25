#!/usr/bin/env python3

import argparse
import json
import re
import tempfile
import time
from collections import OrderedDict, defaultdict
from pathlib import Path

import requests


MAIL_MX_TEMPLATES = [
    {"type": "MX", "content": "route1.mx.cloudflare.net", "priority": 10},
    {"type": "MX", "content": "route2.mx.cloudflare.net", "priority": 20},
    {"type": "MX", "content": "route3.mx.cloudflare.net", "priority": 30},
    {"type": "TXT", "content": "v=spf1 include:_spf.mx.cloudflare.net ~all", "priority": None},
]


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
        if not domain.startswith("*.") and domain not in seen_exact:
            seen_exact.add(domain)
            exact_domains.append(domain)
        if domain.startswith("*."):
            root = domain[2:]
            if root not in seen_roots:
                seen_roots.add(root)
                pool_roots.append(root)

    return {
        "labels": labels,
        "exact_domains": exact_domains,
        "pool_roots": pool_roots,
    }


def load_token(token_file: Path) -> str:
    obj = json.loads(token_file.read_text(encoding="utf-8"))
    token = obj.get("token")
    if not token:
        raise RuntimeError(f"No token field found in {token_file}")
    return token


def cf_request(method: str, path: str, token: str, *, params=None, files=None, data=None):
    url = f"https://api.cloudflare.com/client/v4/{path}"
    headers = {"Authorization": f"Bearer {token}"}
    response = requests.request(
        method=method,
        url=url,
        headers=headers,
        params=params,
        files=files,
        data=data,
        timeout=300,
    )
    response.raise_for_status()
    payload = response.json()
    if not payload.get("success"):
        errors = "; ".join(f"[{e.get('code')}] {e.get('message')}" for e in payload.get("errors", []))
        raise RuntimeError(f"Cloudflare API failed: {path} :: {errors}")
    return payload


def get_zones(token: str) -> list[dict]:
    page = 1
    zones: list[dict] = []
    while True:
        payload = cf_request("GET", "zones", token, params={"page": page, "per_page": 200, "status": "active"})
        zones.extend(payload["result"])
        if page >= payload["result_info"]["total_pages"]:
            break
        page += 1
    return zones


def resolve_zone_for_host(host: str, zones: list[dict]) -> dict:
    matches = [zone for zone in zones if host == zone["name"] or host.endswith(f".{zone['name']}")]
    if not matches:
        raise RuntimeError(f"No Cloudflare zone found for host: {host}")
    return max(matches, key=lambda zone: len(zone["name"]))


def build_target_hosts(plan: dict, mode: str) -> list[str]:
    targets = list(plan["exact_domains"])
    for root in plan["pool_roots"]:
        if mode == "wildcard":
            targets.append(f"*.{root}")
        else:
            for label in plan["labels"]:
                targets.append(f"{label}.{root}")
    return targets


def normalize_identity(record_type: str, name: str, content: str) -> str:
    normalized_content = content.strip('"') if record_type == "TXT" else content.rstrip(".")
    return f"{record_type.lower()}|{name.lower()}|{normalized_content.lower()}"


def get_zone_dns_records(zone_id: str, token: str) -> list[dict]:
    page = 1
    records: list[dict] = []
    while True:
        payload = cf_request(
            "GET",
            f"zones/{zone_id}/dns_records",
            token,
            params={"page": page, "per_page": 5000},
        )
        records.extend([record for record in payload["result"] if record["type"] in {"MX", "TXT"}])
        if page >= payload["result_info"]["total_pages"]:
            break
        page += 1
    return records


def build_desired_records(host: str) -> list[dict]:
    records = []
    for template in MAIL_MX_TEMPLATES:
        records.append(
            {
                "type": template["type"],
                "name": host,
                "content": template["content"],
                "priority": template["priority"],
            }
        )
    return records


def bind_line(record: dict) -> str:
    name = record["name"]
    if not name.endswith("."):
        name = f"{name}."
    if record["type"] == "MX":
        target = record["content"]
        if not target.endswith("."):
            target = f"{target}."
        return f"{name} 300 IN MX {record['priority']} {target}"
    if record["type"] == "TXT":
        return f'{name} 300 IN TXT "{record["content"]}"'
    raise RuntimeError(f"Unsupported record type for BIND export: {record['type']}")


def import_zone_records(zone: dict, records: list[dict], token: str) -> int:
    if not records:
        return 0

    with tempfile.NamedTemporaryFile("w", suffix=".zone", delete=False, encoding="utf-8") as tmp:
        tmp.write(f"$ORIGIN {zone['name']}.\n")
        tmp.write("$TTL 300\n")
        for record in records:
            tmp.write(f"{bind_line(record)}\n")
        zone_file_path = Path(tmp.name)

    try:
        with zone_file_path.open("rb") as fh:
            payload = cf_request(
                "POST",
                f"zones/{zone['id']}/dns_records/import",
                token,
                files={"file": (zone_file_path.name, fh, "text/plain")},
                data={"proxied": "false"},
            )
        return int(payload["result"]["recs_added"])
    finally:
        zone_file_path.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Sync Cloudflare email routing DNS records from the mailbox pool plan.")
    parser.add_argument(
        "--plan",
        required=True,
    )
    parser.add_argument(
        "--token-file",
        required=True,
    )
    parser.add_argument("--mode", choices=["exact", "wildcard"], default="exact")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--show-hosts", action="store_true")
    parser.add_argument("--sleep-seconds", type=int, default=22)
    args = parser.parse_args()

    plan = load_plan(Path(args.plan))
    token = load_token(Path(args.token_file))
    targets = build_target_hosts(plan, args.mode)
    zones = get_zones(token)

    print("\n==== Load Cloudflare zones ====")
    print(f"Loaded {len(zones)} active zones from Cloudflare.")
    print("\n==== Prepare DNS sync ({}) ====".format(args.mode))
    print(f"Target hosts: {len(targets)}")
    print(f"Planned records: {len(targets) * len(MAIL_MX_TEMPLATES)}")

    targets_by_zone: dict[str, dict] = OrderedDict()
    for host in targets:
        zone = resolve_zone_for_host(host, zones)
        if zone["id"] not in targets_by_zone:
            targets_by_zone[zone["id"]] = {"zone": zone, "hosts": []}
        targets_by_zone[zone["id"]]["hosts"].append(host)

    created = 0
    exists = 0
    dry_run_planned = 0

    zone_entries = list(targets_by_zone.values())
    for index, zone_entry in enumerate(zone_entries):
        zone = zone_entry["zone"]
        hosts = list(OrderedDict((host, True) for host in zone_entry["hosts"]).keys())

        if args.show_hosts:
            for host in hosts:
                print(f"[{zone['name']}] {host}")

        desired_records: list[dict] = []
        for host in hosts:
            desired_records.extend(build_desired_records(host))

        existing_records = get_zone_dns_records(zone["id"], token)
        existing_identities = {
            normalize_identity(record["type"], record["name"], record["content"]) for record in existing_records
        }

        missing_records: list[dict] = []
        for record in desired_records:
            identity = normalize_identity(record["type"], record["name"], record["content"])
            if identity in existing_identities:
                exists += 1
            else:
                missing_records.append(record)

        if args.dry_run:
            dry_run_planned += len(missing_records)
            continue

        if not missing_records:
            continue

        added = import_zone_records(zone, missing_records, token)
        created += added
        print(f"Imported zone {zone['name']}: records={len(missing_records)}, added={added}")

        if index < len(zone_entries) - 1 and args.sleep_seconds > 0:
            time.sleep(args.sleep_seconds)

    print("\n==== Summary ====")
    print(f"Mode: {args.mode}")
    print(f"Created: {created}")
    print(f"Already exists: {exists}")
    print(f"Dry-run planned: {dry_run_planned}")


if __name__ == "__main__":
    main()
