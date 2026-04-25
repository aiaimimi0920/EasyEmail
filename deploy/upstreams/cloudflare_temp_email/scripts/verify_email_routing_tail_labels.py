#!/usr/bin/env python3

import argparse
import json
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sync_email_routing_state as state  # noqa: E402


def checkpoint_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def load_checkpoint(checkpoint_path: Path) -> dict:
    if not checkpoint_path.exists():
        return {
            "version": 1,
            "created_at": checkpoint_now(),
            "updated_at": checkpoint_now(),
            "completed_roots": {},
            "failed_roots": {},
            "special_mail_aiaimimi": None,
        }
    return json.loads(checkpoint_path.read_text(encoding="utf-8"))


def save_checkpoint(checkpoint_path: Path, payload: dict) -> None:
    checkpoint_path.parent.mkdir(parents=True, exist_ok=True)
    payload["updated_at"] = checkpoint_now()
    checkpoint_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def mark_root_success(checkpoint_path: Path, payload: dict, root: str, result: dict) -> None:
    payload["completed_roots"][root] = {
        "verified_at": checkpoint_now(),
        "result": result,
    }
    payload["failed_roots"].pop(root, None)
    save_checkpoint(checkpoint_path, payload)


def mark_root_failure(checkpoint_path: Path, payload: dict, root: str, error: str) -> None:
    payload["failed_roots"][root] = {
        "failed_at": checkpoint_now(),
        "error": error,
    }
    save_checkpoint(checkpoint_path, payload)


def mark_special_success(checkpoint_path: Path, payload: dict, result: dict) -> None:
    payload["special_mail_aiaimimi"] = {
        "verified_at": checkpoint_now(),
        "result": result,
    }
    save_checkpoint(checkpoint_path, payload)


def parse_iso8601(value: str) -> datetime:
    normalized = value.replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(normalized).astimezone(timezone.utc)
    except ValueError:
        if "." not in normalized:
            raise
        if "+" in normalized[10:]:
            main, offset = normalized.rsplit("+", 1)
            sign = "+"
        elif "-" in normalized[10:]:
            main, offset = normalized.rsplit("-", 1)
            sign = "-"
        else:
            raise
        head, frac = main.split(".", 1)
        frac = (frac + "000000")[:6]
        fixed = f"{head}.{frac}{sign}{offset}"
        return datetime.fromisoformat(fixed).astimezone(timezone.utc)


def has_mail_routing_dns(records: list[dict], expected_name: str) -> bool:
    expected_mx = {
        f"mx|{expected_name.lower()}|route1.mx.cloudflare.net",
        f"mx|{expected_name.lower()}|route2.mx.cloudflare.net",
        f"mx|{expected_name.lower()}|route3.mx.cloudflare.net",
    }
    expected_txt = f'txt|{expected_name.lower()}|v=spf1 include:_spf.mx.cloudflare.net ~all'

    actual_mx = set()
    actual_txt = set()
    for record in records:
        if record["type"] == "MX":
            actual_mx.add(
                f"mx|{record['name'].lower()}|{str(record['content']).rstrip('.').lower()}"
            )
        elif record["type"] == "TXT":
            txt_content = str(record["content"]).strip('"').lower()
            actual_txt.add(
                f"txt|{record['name'].lower()}|{txt_content}"
            )
    return expected_mx.issubset(actual_mx) and expected_txt in actual_txt


def get_catch_all_rule(zone_id: str, auth: state.GlobalCloudflareAuth) -> dict:
    return state.cf_request("GET", f"zones/{zone_id}/email/routing/rules/catch_all", auth)["result"]


def ensure_root_dns(zone_id: str, auth: state.GlobalCloudflareAuth, root: str) -> int:
    existing_records = state.get_dns_records(zone_id, auth, name=root)
    actual = set()
    for record in existing_records:
        actual.add(
            "|".join(
                [
                    record["type"].lower(),
                    record["name"].lower(),
                    str(record["content"]).strip('"').rstrip(".").lower(),
                ]
            )
        )

    created = 0
    for template in state.MAIL_MX_TEMPLATES:
        identity = "|".join(
            [
                template["type"].lower(),
                root.lower(),
                template["content"].strip('"').rstrip(".").lower(),
            ]
        )
        if identity in actual:
            continue
        record = {
            "type": template["type"],
            "name": root,
            "content": template["content"].strip('"'),
            "priority": template["priority"],
            "ttl": template["ttl"],
        }
        if state.ensure_dns_record(zone_id, auth, record):
            created += 1
    return created


def validate_special_mail_subdomain(
    auth: state.GlobalCloudflareAuth,
    zones: dict[str, dict],
    run_started_at: datetime,
) -> dict:
    zone = zones["aiaimimi.com"]
    name = "mail.aiaimimi.com"
    settings = state.get_email_routing_settings(zone["id"], auth)
    mail_item = state.subdomain_map(settings).get(name)
    if not mail_item:
        raise RuntimeError("mail.aiaimimi.com missing from aiaimimi.com Email Routing subdomains")

    response = state.cf_request(
        "POST",
        f"zones/{zone['id']}/email/routing/dns",
        auth,
        json_body={"name": name},
    )["result"]
    created_at = parse_iso8601(response["created"])
    status = "preexisting" if created_at < (run_started_at - timedelta(minutes=5)) else "recreated-now"
    records = state.get_dns_records(zone["id"], auth, name=name)
    return {
        "status": status,
        "subdomain_status": response["status"],
        "dns_ok": has_mail_routing_dns(records, name),
    }


def verify_root(
    root: str,
    labels: list[str],
    auth: state.GlobalCloudflareAuth,
    zones: dict[str, dict],
    worker_name: str,
    run_started_at: datetime,
    batch_size: int,
    sleep_seconds: float,
) -> dict:
    zone = zones.get(root)
    if not zone:
        raise RuntimeError(f"Zone missing in Cloudflare: {root}")

    result = {
        "root": root,
        "root_repaired": 0,
        "wildcard_repaired": 0,
        "tail_preexisting": 0,
        "tail_repaired_now": 0,
        "tail_cleanup_deleted": 0,
    }

    state.ensure_zone_enabled(zone["id"], auth)
    state.ensure_catch_all_worker(zone["id"], auth, worker_name)
    result["root_repaired"] += ensure_root_dns(zone["id"], auth, root)
    result["wildcard_repaired"] += state.ensure_wildcard_dns(zone["id"], auth, root)

    catch_all = get_catch_all_rule(zone["id"], auth)
    if not (
        catch_all.get("enabled") is True
        and catch_all.get("matchers") == [{"type": "all"}]
        and catch_all.get("actions") == [{"type": "worker", "value": [worker_name]}]
    ):
        raise RuntimeError(f"Catch-all worker mismatch for {root}")

    root_records = state.get_dns_records(zone["id"], auth, name=root)
    wildcard_records = state.get_dns_records(zone["id"], auth, name=f"*.{root}")
    if not has_mail_routing_dns(root_records, root):
        raise RuntimeError(f"Root Email Routing DNS incomplete for {root}")
    if not has_mail_routing_dns(wildcard_records, f"*.{root}"):
        raise RuntimeError(f"Wildcard Email Routing DNS incomplete for {root}")

    pending_labels = []
    settings = state.get_email_routing_settings(zone["id"], auth)
    known = state.subdomain_map(settings)
    for label in labels:
        name = f"{label}.{root}"
        current = known.get(name)
        if current and current.get("status") == "unconfigured":
            pending_labels.append(name)
        else:
            pending_labels.append(name)

    for batch_start in range(0, len(pending_labels), batch_size):
        batch = pending_labels[batch_start: batch_start + batch_size]
        for name in batch:
            response = state.cf_request(
                "POST",
                f"zones/{zone['id']}/email/routing/dns",
                auth,
                json_body={"name": name},
            )["result"]
            created_at = parse_iso8601(response["created"])
            if created_at < (run_started_at - timedelta(minutes=5)):
                result["tail_preexisting"] += 1
            else:
                result["tail_repaired_now"] += 1
            time.sleep(sleep_seconds)

        for name in batch:
            state.unlock_subdomain(zone["id"], auth, name)
            time.sleep(sleep_seconds)

        refreshed = state.get_dns_records(zone["id"], auth)
        batch_names = set(batch)
        delete_ids = [record["id"] for record in refreshed if record["name"] in batch_names]
        result["tail_cleanup_deleted"] += state.batch_delete_dns_records(zone["id"], auth, delete_ids)
        time.sleep(sleep_seconds)

        processed = min(batch_start + len(batch), len(pending_labels))
        print(
            f"[{root}] validated {processed}/{len(pending_labels)} "
            f"preexisting={result['tail_preexisting']} "
            f"repaired_now={result['tail_repaired_now']} "
            f"cleanup_deleted={result['tail_cleanup_deleted']}"
        )

    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Verify Cloudflare Email Routing tail-label subdomains by repeated creation checks.")
    parser.add_argument(
        "--plan",
        required=True,
    )
    parser.add_argument(
        "--secret-file",
        required=True,
    )
    parser.add_argument("--worker-name", default="cloudflare_temp_email")
    parser.add_argument(
        "--checkpoint-file",
        default=str(Path(__file__).resolve().parent / "email_routing_tail_verify_checkpoint.json"),
    )
    parser.add_argument("--root-offset", type=int, default=0)
    parser.add_argument("--label-offset", type=int, default=50)
    parser.add_argument("--label-limit", type=int, default=0)
    parser.add_argument("--batch-size", type=int, default=10)
    parser.add_argument("--sleep-seconds", type=float, default=0.05)
    parser.add_argument("--only-root", default="")
    parser.add_argument("--root-retries", type=int, default=3)
    args = parser.parse_args()

    plan = state.load_plan(Path(args.plan))
    auth = state.load_global_auth(Path(args.secret_file))
    zones = state.zone_map_by_name(state.get_zones(auth))
    checkpoint_path = Path(args.checkpoint_file)
    checkpoint = load_checkpoint(checkpoint_path)
    labels = plan["labels"][args.label_offset:]
    if args.label_limit > 0:
        labels = labels[: args.label_limit]
    roots = plan["pool_roots"]
    if args.only_root:
        roots = [root for root in roots if root == args.only_root]
    if args.root_offset > 0:
        roots = roots[args.root_offset:]
    completed_roots = set(checkpoint.get("completed_roots", {}).keys())
    roots = [root for root in roots if root not in completed_roots]

    run_started_at = datetime.now(timezone.utc)
    print("==== Verify Tail Labels ====")
    print(f"roots={len(roots)} labels_per_root={len(labels)} worker={args.worker_name}")
    print(f"checkpoint={checkpoint_path}")

    summary = {
        "roots_checked": 0,
        "root_dns_repaired": 0,
        "wildcard_dns_repaired": 0,
        "tail_validated": 0,
        "tail_preexisting": 0,
        "tail_repaired_now": 0,
        "tail_cleanup_deleted": 0,
    }

    for index, root in enumerate(roots, start=1):
        print(f"[{index}/{len(roots)}] root={root}")
        last_error = None
        result = None
        for attempt in range(1, args.root_retries + 1):
            try:
                result = verify_root(
                    root=root,
                    labels=labels,
                    auth=auth,
                    zones=zones,
                    worker_name=args.worker_name,
                    run_started_at=run_started_at,
                    batch_size=args.batch_size,
                    sleep_seconds=args.sleep_seconds,
                )
                break
            except Exception as exc:  # noqa: BLE001
                last_error = str(exc)
                print(f"[{root}] attempt {attempt}/{args.root_retries} failed: {exc}")
                time.sleep(min(30, 3 * attempt))
        if result is None:
            mark_root_failure(checkpoint_path, checkpoint, root, last_error or "unknown error")
            raise SystemExit(1)

        summary["roots_checked"] += 1
        summary["root_dns_repaired"] += result["root_repaired"]
        summary["wildcard_dns_repaired"] += result["wildcard_repaired"]
        summary["tail_preexisting"] += result["tail_preexisting"]
        summary["tail_repaired_now"] += result["tail_repaired_now"]
        summary["tail_cleanup_deleted"] += result["tail_cleanup_deleted"]
        summary["tail_validated"] += result["tail_preexisting"] + result["tail_repaired_now"]
        mark_root_success(checkpoint_path, checkpoint, root, result)

    special = validate_special_mail_subdomain(auth, zones, run_started_at)
    mark_special_success(checkpoint_path, checkpoint, special)

    print("==== Summary ====")
    print(json.dumps({"summary": summary, "special_mail_aiaimimi": special}, ensure_ascii=False, indent=2))

    if summary["tail_validated"] != len(roots) * len(labels):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
