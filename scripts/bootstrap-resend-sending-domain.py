#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

import requests
import yaml


def load_config(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        data = yaml.safe_load(handle) or {}
    if not isinstance(data, dict):
        raise RuntimeError(f"Config root must be a mapping: {path}")
    return data


def get_mapping(obj: dict[str, Any], key: str) -> dict[str, Any]:
    value = obj.get(key)
    return value if isinstance(value, dict) else {}


def get_string_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    text = str(value).strip()
    if not text:
        return []
    return [item.strip() for item in text.replace("\r", "\n").replace(";", ",").split(",") if item.strip()]


def unique_strings(items: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for item in items:
        normalized = item.strip().lower()
        if normalized and normalized not in seen:
            seen.add(normalized)
            result.append(normalized)
    return result


def resend_request(method: str, path: str, token: str, payload: dict[str, Any] | None = None) -> requests.Response:
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    last_error: Exception | None = None
    for attempt in range(1, 6):
        try:
            return requests.request(
                method,
                f"https://api.resend.com{path}",
                headers=headers,
                json=payload,
                timeout=30,
            )
        except requests.RequestException as exc:
            last_error = exc
            if attempt >= 5:
                break
            time.sleep(min(2 * attempt, 10))
    raise RuntimeError(f"Resend API request failed after retries for {path}: {last_error}") from last_error


def cloudflare_request(
    method: str,
    path: str,
    *,
    auth_email: str,
    api_key: str,
    payload: dict[str, Any] | None = None,
) -> requests.Response:
    headers = {
        "X-Auth-Email": auth_email,
        "X-Auth-Key": api_key,
        "Content-Type": "application/json",
    }
    last_error: Exception | None = None
    for attempt in range(1, 6):
        try:
            return requests.request(
                method,
                f"https://api.cloudflare.com/client/v4{path}",
                headers=headers,
                json=payload,
                timeout=30,
            )
        except requests.RequestException as exc:
            last_error = exc
            if attempt >= 5:
                break
            time.sleep(min(2 * attempt, 10))
    raise RuntimeError(f"Cloudflare API request failed after retries for {path}: {last_error}") from last_error


def ensure_success(response: requests.Response, label: str) -> dict[str, Any]:
    try:
        data = response.json()
    except Exception as exc:  # pragma: no cover
        raise RuntimeError(f"{label} returned invalid JSON: {response.status_code} {response.text}") from exc

    if response.status_code >= 400:
        raise RuntimeError(f"{label} failed: {response.status_code} {json.dumps(data, ensure_ascii=False)}")

    if isinstance(data, dict) and data.get("success") is False:
        raise RuntimeError(f"{label} failed: {json.dumps(data, ensure_ascii=False)}")

    return data


def find_matching_zone(domain: str, zones: list[dict[str, Any]]) -> dict[str, Any]:
    candidates = [
        zone for zone in zones
        if isinstance(zone.get("name"), str)
        and (domain == zone["name"] or domain.endswith(f".{zone['name']}"))
    ]
    if not candidates:
        raise RuntimeError(f"No Cloudflare zone found that matches domain {domain}")
    return max(candidates, key=lambda zone: len(str(zone["name"])))


def compute_record_name(record_name: str, zone_name: str) -> str:
    normalized = record_name.strip().rstrip(".").lower()
    zone_name = zone_name.strip().rstrip(".").lower()
    if normalized in ("@", zone_name):
        return zone_name
    if normalized.endswith(zone_name):
        return normalized
    return f"{normalized}.{zone_name}"


def dns_payload(record: dict[str, Any], zone_name: str) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "type": str(record["type"]).upper(),
        "name": compute_record_name(str(record["name"]), zone_name),
        "content": str(record["value"]).strip().rstrip(".") if str(record["type"]).upper() != "TXT" else str(record["value"]),
        "ttl": 1,
    }
    if payload["type"] == "CNAME":
        payload["proxied"] = False
    if payload["type"] == "MX":
        payload["priority"] = int(record.get("priority", 10))
    return payload


def upsert_dns_record(
    zone_id: str,
    zone_name: str,
    record: dict[str, Any],
    *,
    auth_email: str,
    api_key: str,
    dry_run: bool,
) -> dict[str, Any]:
    payload = dns_payload(record, zone_name)
    if dry_run:
        return {"action": "planned", "record": payload}

    existing_resp = cloudflare_request(
        "GET",
        f"/zones/{zone_id}/dns_records?type={payload['type']}&name={payload['name']}",
        auth_email=auth_email,
        api_key=api_key,
    )
    existing_data = ensure_success(existing_resp, f"Cloudflare list DNS {payload['name']}")
    existing_records = existing_data.get("result", []) if isinstance(existing_data, dict) else []

    def matches(item: dict[str, Any]) -> bool:
        if str(item.get("content", "")).rstrip(".") != str(payload["content"]).rstrip("."):
            return False
        if payload["type"] == "MX" and int(item.get("priority", 0)) != int(payload.get("priority", 0)):
            return False
        return True

    exact = next((item for item in existing_records if matches(item)), None)
    if exact:
        return {"action": "noop", "record": payload, "id": exact.get("id")}

    if existing_records:
        record_id = existing_records[0].get("id")
        update_resp = cloudflare_request(
            "PUT",
            f"/zones/{zone_id}/dns_records/{record_id}",
            auth_email=auth_email,
            api_key=api_key,
            payload=payload,
        )
        ensure_success(update_resp, f"Cloudflare update DNS {payload['name']}")
        return {"action": "updated", "record": payload, "id": record_id}

    create_resp = cloudflare_request(
        "POST",
        f"/zones/{zone_id}/dns_records",
        auth_email=auth_email,
        api_key=api_key,
        payload=payload,
    )
    create_data = ensure_success(create_resp, f"Cloudflare create DNS {payload['name']}")
    return {"action": "created", "record": payload, "id": create_data.get("result", {}).get("id")}


def ensure_resend_domain(domain: str, token: str) -> dict[str, Any]:
    list_resp = resend_request("GET", "/domains", token)
    list_data = ensure_success(list_resp, "Resend list domains")
    domains = list_data.get("data", []) if isinstance(list_data, dict) else []
    existing = next((item for item in domains if str(item.get("name", "")).strip().lower() == domain.lower()), None)
    if existing:
        detail_resp = resend_request("GET", f"/domains/{existing['id']}", token)
        detail = ensure_success(detail_resp, f"Resend retrieve domain {domain}")
        result = detail.get("data") if isinstance(detail, dict) and "data" in detail else detail
        if not isinstance(result, dict):
            raise RuntimeError(f"Unexpected Resend domain response for {domain}: {detail}")
        return result

    create_resp = resend_request("POST", "/domains", token, {"name": domain})
    create_data = ensure_success(create_resp, f"Resend create domain {domain}")
    if not isinstance(create_data, dict):
        raise RuntimeError(f"Unexpected Resend create response for {domain}: {create_data}")
    return create_data


def verify_resend_domain(domain_id: str, token: str, timeout_seconds: int) -> dict[str, Any]:
    verify_resp = resend_request("POST", f"/domains/{domain_id}/verify", token)
    ensure_success(verify_resp, f"Resend verify domain {domain_id}")

    deadline = time.time() + timeout_seconds
    last_detail: dict[str, Any] | None = None
    while time.time() < deadline:
        detail_resp = resend_request("GET", f"/domains/{domain_id}", token)
        detail_data = ensure_success(detail_resp, f"Resend retrieve domain {domain_id}")
        detail = detail_data.get("data") if isinstance(detail_data, dict) and "data" in detail_data else detail_data
        if not isinstance(detail, dict):
            raise RuntimeError(f"Unexpected Resend retrieve response for {domain_id}: {detail_data}")
        last_detail = detail
        status = str(detail.get("status", "")).strip().lower()
        if status == "verified":
            return detail
        time.sleep(5)

    if last_detail is None:
        raise RuntimeError(f"Timed out waiting for Resend domain {domain_id} verification.")
    return last_detail


def main() -> int:
    parser = argparse.ArgumentParser(description="Bootstrap Resend sending domains into Resend + Cloudflare DNS.")
    parser.add_argument("--config", required=True)
    parser.add_argument("--domain", action="append", default=[])
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--verify-timeout-seconds", type=int, default=180)
    args = parser.parse_args()

    config = load_config(Path(args.config))
    cloudflare = get_mapping(config, "cloudflareMail")
    worker = get_mapping(cloudflare, "worker")
    worker_vars = get_mapping(worker, "vars")
    sending = get_mapping(cloudflare, "sending")
    routing = get_mapping(cloudflare, "routing")
    global_auth = get_mapping(routing, "cloudflareGlobalAuth")

    resend_token = str(worker_vars.get("RESEND_TOKEN", "")).strip()
    auth_email = str(global_auth.get("authEmail", "")).strip()
    global_api_key = str(global_auth.get("globalApiKey", "")).strip()
    sending_domains = unique_strings(get_string_list(sending.get("domains")))
    preferred_sender_domain = str(sending.get("preferredSenderDomain", "")).strip().lower()
    if preferred_sender_domain:
        sending_domains = unique_strings([preferred_sender_domain, *sending_domains])
    if args.domain:
        sending_domains = unique_strings([*sending_domains, *args.domain])

    if not resend_token:
        raise RuntimeError("cloudflareMail.worker.vars.RESEND_TOKEN is required to bootstrap Resend domains.")
    if not auth_email or not global_api_key:
        raise RuntimeError("cloudflareMail.routing.cloudflareGlobalAuth.authEmail/globalApiKey are required.")
    if not sending_domains:
        raise RuntimeError("No sending domains were configured.")

    zones_resp = cloudflare_request("GET", "/zones?per_page=200", auth_email=auth_email, api_key=global_api_key)
    zones_data = ensure_success(zones_resp, "Cloudflare list zones")
    zones = zones_data.get("result", []) if isinstance(zones_data, dict) else []

    summary: dict[str, Any] = {
        "dryRun": args.dry_run,
        "domains": [],
    }

    for domain in sending_domains:
        resend_domain = ensure_resend_domain(domain, resend_token)
        zone = find_matching_zone(domain, zones)
        record_results = []
        for record in resend_domain.get("records", []):
            if not isinstance(record, dict):
                continue
            record_results.append(
                upsert_dns_record(
                    str(zone["id"]),
                    str(zone["name"]),
                    record,
                    auth_email=auth_email,
                    api_key=global_api_key,
                    dry_run=args.dry_run,
                )
            )

        verified_state = None
        if not args.dry_run:
            verified_state = verify_resend_domain(str(resend_domain["id"]), resend_token, args.verify_timeout_seconds)

        summary["domains"].append({
            "name": domain,
            "zone": zone["name"],
            "resendDomainId": resend_domain["id"],
            "initialStatus": resend_domain.get("status"),
            "dns": record_results,
            "verifiedStatus": None if verified_state is None else verified_state.get("status"),
            "records": None if verified_state is None else verified_state.get("records"),
        })

    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
