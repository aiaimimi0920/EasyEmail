#!/usr/bin/env python3

from __future__ import annotations

import argparse
import copy
import os
from pathlib import Path
from typing import Any

import yaml

try:
    import tomllib  # py3.11+
except ModuleNotFoundError:  # pragma: no cover - fallback for older python
    import tomli as tomllib


REPO_ROOT = Path(__file__).resolve().parent.parent
SERVICE_TEMPLATE_PATH = REPO_ROOT / "deploy" / "service" / "base" / "config.template.yaml"
WORKER_TEMPLATE_PATH = REPO_ROOT / "upstreams" / "cloudflare_temp_email" / "worker" / "wrangler.toml.template"


def deep_merge(base: Any, overlay: Any) -> Any:
    if overlay is None:
        return copy.deepcopy(base)
    if isinstance(base, dict) and isinstance(overlay, dict):
        merged = copy.deepcopy(base)
        for key, value in overlay.items():
            if key in merged:
                merged[key] = deep_merge(merged[key], value)
            else:
                merged[key] = copy.deepcopy(value)
        return merged
    return copy.deepcopy(overlay)


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


def has_meaningful_value(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, (list, dict)):
        return len(value) > 0
    return True


def ensure_nested(mapping: dict[str, Any], *path: str) -> dict[str, Any]:
    current = mapping
    for key in path:
        value = current.get(key)
        if not isinstance(value, dict):
            value = {}
            current[key] = value
        current = value
    return current


def normalize_string_list(value: Any) -> list[str]:
    items = []
    for item in as_list(value):
        if item is None:
            continue
        text = str(item).strip()
        if text:
            items.append(text)
    return items


def rebase_relative_path(path_text: Any, source_dir: Path, output_dir: Path) -> Any:
    if not isinstance(path_text, str):
        return path_text
    if not path_text.strip():
        return path_text
    candidate = Path(path_text)
    if candidate.is_absolute():
        return path_text
    absolute_target = (source_dir / candidate).resolve()
    return Path(os.path.relpath(str(absolute_target), str(output_dir))).as_posix()


def format_toml_string(value: str) -> str:
    escaped = (
        value.replace("\\", "\\\\")
        .replace('"', '\\"')
        .replace("\b", "\\b")
        .replace("\t", "\\t")
        .replace("\n", "\\n")
        .replace("\f", "\\f")
        .replace("\r", "\\r")
    )
    return f'"{escaped}"'


def format_toml_value(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return repr(value)
    if isinstance(value, str):
        return format_toml_string(value)
    if value is None:
        return '""'
    if isinstance(value, list):
        return "[" + ", ".join(format_toml_value(item) for item in value) + "]"
    raise TypeError(f"Unsupported TOML value type: {type(value)!r}")


def emit_toml_table(mapping: dict[str, Any], path: list[str] | None = None) -> list[str]:
    path = path or []
    lines: list[str] = []

    scalar_items: list[tuple[str, Any]] = []
    dict_items: list[tuple[str, dict[str, Any]]] = []
    array_table_items: list[tuple[str, list[dict[str, Any]]]] = []

    for key, value in mapping.items():
        if isinstance(value, dict):
            dict_items.append((key, value))
        elif isinstance(value, list) and value and all(isinstance(item, dict) for item in value):
            array_table_items.append((key, value))
        else:
            scalar_items.append((key, value))

    for key, value in scalar_items:
        lines.append(f"{key} = {format_toml_value(value)}")

    for key, table in dict_items:
        if lines:
            lines.append("")
        header = ".".join(path + [key])
        lines.append(f"[{header}]")
        child_lines = emit_toml_table(table, path + [key])
        lines.extend(child_lines)

    for key, items in array_table_items:
        for item in items:
            if lines:
                lines.append("")
            header = ".".join(path + [key])
            lines.append(f"[[{header}]]")
            child_lines = emit_toml_table(item, path + [key])
            lines.extend(child_lines)

    return lines


def render_service_config(root: dict[str, Any], output: Path) -> None:
    template = yaml.safe_load(SERVICE_TEMPLATE_PATH.read_text(encoding="utf-8")) or {}
    service_root = as_dict(root.get("serviceBase"))
    runtime_overlay = as_dict(service_root.get("runtime"))
    config = deep_merge(template, runtime_overlay)

    cloudflare = as_dict(root.get("cloudflareMail"))
    routing = as_dict(cloudflare.get("routing"))
    plan = as_dict(routing.get("plan"))
    worker = as_dict(cloudflare.get("worker"))
    worker_vars = as_dict(worker.get("vars"))
    runtime_providers_overlay = as_dict(runtime_overlay.get("providers"))
    cloudflare_provider_overlay = as_dict(runtime_providers_overlay.get("cloudflareTempEmail"))
    providers = ensure_nested(config, "providers")
    cloudflare_provider = ensure_nested(providers, "cloudflareTempEmail")

    derived_base_url = first_non_empty(
        cloudflare.get("publicBaseUrl"),
        cloudflare.get("baseUrl"),
    )
    if not derived_base_url:
        domain = first_non_empty(
            cloudflare.get("publicDomain"),
            normalize_string_list(plan.get("domains"))[:1] or None,
        )
        if isinstance(domain, list):
            domain = domain[0] if domain else None
        if domain:
            derived_base_url = f"https://{domain}"
    if not has_meaningful_value(cloudflare_provider_overlay.get("baseUrl")) and derived_base_url:
        cloudflare_provider["baseUrl"] = derived_base_url

    derived_api_key = first_non_empty(
        normalize_string_list(worker_vars.get("PASSWORDS"))[:1] or None,
        normalize_string_list(worker.get("passwords"))[:1] or None,
    )
    if isinstance(derived_api_key, list):
        derived_api_key = derived_api_key[0] if derived_api_key else None
    if not has_meaningful_value(cloudflare_provider_overlay.get("apiKey")) and derived_api_key:
        cloudflare_provider["apiKey"] = derived_api_key

    derived_domain = first_non_empty(
        cloudflare.get("publicDomain"),
        normalize_string_list(plan.get("domains"))[:1] or None,
    )
    if isinstance(derived_domain, list):
        derived_domain = derived_domain[0] if derived_domain else None
    if not has_meaningful_value(cloudflare_provider_overlay.get("domain")) and derived_domain:
        cloudflare_provider["domain"] = derived_domain

    if not has_meaningful_value(cloudflare_provider_overlay.get("domains")):
        domains = normalize_string_list(first_non_empty(plan.get("domains"), cloudflare_provider.get("domains")))
        if domains:
            cloudflare_provider["domains"] = domains

    if not has_meaningful_value(cloudflare_provider_overlay.get("randomSubdomainDomains")):
        random_domains = normalize_string_list(first_non_empty(plan.get("randomSubdomainDomains"), plan.get("domains")))
        if random_domains:
            cloudflare_provider["randomSubdomainDomains"] = random_domains

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        yaml.safe_dump(config, sort_keys=False, allow_unicode=True),
        encoding="utf-8",
    )


def normalize_env_value(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    return str(value)


def render_service_env(root: dict[str, Any], output: Path) -> None:
    service_root = as_dict(root.get("serviceBase"))
    env_map = as_dict(service_root.get("containerEnvironment"))

    lines: list[str] = []
    for key, value in env_map.items():
        key_text = str(key).strip()
        if not key_text:
            continue
        value_text = normalize_env_value(value)
        lines.append(f"{key_text}={value_text}")

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text("\n".join(lines).rstrip() + ("\n" if lines else ""), encoding="utf-8")


def render_worker_config(root: dict[str, Any], output: Path) -> None:
    template = tomllib.loads(WORKER_TEMPLATE_PATH.read_text(encoding="utf-8"))
    cloudflare = as_dict(root.get("cloudflareMail"))
    routing = as_dict(cloudflare.get("routing"))
    plan = as_dict(routing.get("plan"))
    worker_overlay = as_dict(cloudflare.get("worker"))
    overlay_vars = as_dict(worker_overlay.get("vars"))
    merged = deep_merge(template, worker_overlay)

    vars_section = ensure_nested(merged, "vars")
    derived_domains = normalize_string_list(plan.get("domains"))
    derived_labels = normalize_string_list(plan.get("subdomainLabelPool"))
    if derived_labels and not has_meaningful_value(overlay_vars.get("SUBDOMAIN_LABEL_POOL")):
        vars_section["SUBDOMAIN_LABEL_POOL"] = derived_labels
    if derived_domains and not has_meaningful_value(overlay_vars.get("DEFAULT_DOMAINS")):
        vars_section["DEFAULT_DOMAINS"] = derived_domains
    if derived_domains and not has_meaningful_value(overlay_vars.get("DOMAINS")):
        vars_section["DOMAINS"] = derived_domains
    if derived_domains and not has_meaningful_value(overlay_vars.get("RANDOM_SUBDOMAIN_DOMAINS")):
        vars_section["RANDOM_SUBDOMAIN_DOMAINS"] = derived_domains

    if "PASSWORDS" in vars_section:
        vars_section["PASSWORDS"] = normalize_string_list(vars_section.get("PASSWORDS"))
    if "ADMIN_PASSWORDS" in vars_section:
        vars_section["ADMIN_PASSWORDS"] = normalize_string_list(vars_section.get("ADMIN_PASSWORDS"))
    if "DEFAULT_DOMAINS" in vars_section:
        vars_section["DEFAULT_DOMAINS"] = normalize_string_list(vars_section.get("DEFAULT_DOMAINS"))
    if "DOMAINS" in vars_section:
        vars_section["DOMAINS"] = normalize_string_list(vars_section.get("DOMAINS"))
    if "RANDOM_SUBDOMAIN_DOMAINS" in vars_section:
        vars_section["RANDOM_SUBDOMAIN_DOMAINS"] = normalize_string_list(vars_section.get("RANDOM_SUBDOMAIN_DOMAINS"))
    if "SUBDOMAIN_LABEL_POOL" in vars_section:
        vars_section["SUBDOMAIN_LABEL_POOL"] = normalize_string_list(vars_section.get("SUBDOMAIN_LABEL_POOL"))

    if "compatibility_flags" in merged and isinstance(merged["compatibility_flags"], list):
        merged["compatibility_flags"] = [str(item) for item in merged["compatibility_flags"] if str(item).strip()]

    template_dir = WORKER_TEMPLATE_PATH.parent
    if "main" in merged:
        merged["main"] = rebase_relative_path(merged.get("main"), template_dir, output.parent)
    assets = as_dict(merged.get("assets"))
    if "directory" in assets:
        assets["directory"] = rebase_relative_path(assets.get("directory"), template_dir, output.parent)

    output.parent.mkdir(parents=True, exist_ok=True)
    lines = emit_toml_table(merged)
    output.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="Render derived EasyEmail config files from the root config.yaml.")
    parser.add_argument("--root-config", default=str(REPO_ROOT / "config.yaml"))
    parser.add_argument("--service-output", default="")
    parser.add_argument("--service-env-output", default="")
    parser.add_argument("--worker-output", default="")
    args = parser.parse_args()

    root_config_path = Path(args.root_config)
    if not root_config_path.exists():
        raise SystemExit(f"Root config not found: {root_config_path}")

    root = yaml.safe_load(root_config_path.read_text(encoding="utf-8")) or {}

    if args.service_output:
        render_service_config(root, Path(args.service_output))
        print(f"Rendered service config -> {args.service_output}")

    if args.service_env_output:
        render_service_env(root, Path(args.service_env_output))
        print(f"Rendered service env -> {args.service_env_output}")

    if args.worker_output:
        render_worker_config(root, Path(args.worker_output))
        print(f"Rendered worker config -> {args.worker_output}")

    if not args.service_output and not args.service_env_output and not args.worker_output:
        print("Nothing to render. Pass --service-output, --service-env-output and/or --worker-output.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
