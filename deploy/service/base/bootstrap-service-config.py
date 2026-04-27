#!/usr/bin/env python3

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
from typing import Any

import boto3


def load_bootstrap(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise SystemExit(f"Bootstrap file not found: {path}")
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError as exc:
        raise SystemExit(f"Failed to parse bootstrap file {path}: {exc}") from exc


def build_s3_client(bootstrap: dict[str, Any]):
    endpoint = str(bootstrap.get("endpoint") or "").strip()
    account_id = str(bootstrap.get("accountId") or "").strip()
    if not endpoint:
        if not account_id:
            raise SystemExit("Bootstrap file must provide either endpoint or accountId.")
        endpoint = f"https://{account_id}.r2.cloudflarestorage.com"

    access_key_id = str(bootstrap.get("accessKeyId") or "").strip()
    secret_access_key = str(bootstrap.get("secretAccessKey") or "").strip()
    if not access_key_id or not secret_access_key:
        raise SystemExit("Bootstrap file must provide accessKeyId and secretAccessKey.")

    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        region_name="auto",
        aws_access_key_id=access_key_id,
        aws_secret_access_key=secret_access_key,
    )


def sha256_hex(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def download_object(client: Any, *, bucket: str, object_key: str) -> bytes:
    response = client.get_object(Bucket=bucket, Key=object_key)
    return response["Body"].read()


def write_atomic(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_suffix(path.suffix + ".tmp")
    temp_path.write_bytes(content)
    os.replace(temp_path, path)


def main() -> int:
    parser = argparse.ArgumentParser(description="Fetch EasyEmail runtime config artifacts from Cloudflare R2 before container startup.")
    parser.add_argument("--bootstrap-path", required=True)
    parser.add_argument("--config-path", required=True)
    parser.add_argument("--runtime-env-path", required=True)
    args = parser.parse_args()

    bootstrap_path = Path(args.bootstrap_path).resolve()
    config_path = Path(args.config_path).resolve()
    runtime_env_path = Path(args.runtime_env_path).resolve()

    bootstrap = load_bootstrap(bootstrap_path)
    bucket = str(bootstrap.get("bucket") or "").strip()
    config_object_key = str(bootstrap.get("configObjectKey") or bootstrap.get("objectKey") or "").strip()
    runtime_env_object_key = str(bootstrap.get("runtimeEnvObjectKey") or "").strip()
    if not bucket or not config_object_key:
        raise SystemExit("Bootstrap file must provide bucket and configObjectKey.")

    client = build_s3_client(bootstrap)

    print(f"[easy-email] downloading runtime config from R2 bucket={bucket} key={config_object_key}")
    config_bytes = download_object(client, bucket=bucket, object_key=config_object_key)
    expected_config_sha256 = str(bootstrap.get("expectedConfigSha256") or "").strip()
    if expected_config_sha256 and sha256_hex(config_bytes) != expected_config_sha256:
        raise SystemExit(
            f"Downloaded config sha256 mismatch for {config_object_key}: "
            f"expected {expected_config_sha256}, got {sha256_hex(config_bytes)}"
        )
    write_atomic(config_path, config_bytes)

    if runtime_env_object_key:
        print(f"[easy-email] downloading runtime env from R2 bucket={bucket} key={runtime_env_object_key}")
        runtime_env_bytes = download_object(client, bucket=bucket, object_key=runtime_env_object_key)
        expected_runtime_env_sha256 = str(bootstrap.get("expectedRuntimeEnvSha256") or "").strip()
        if expected_runtime_env_sha256 and sha256_hex(runtime_env_bytes) != expected_runtime_env_sha256:
            raise SystemExit(
                f"Downloaded runtime env sha256 mismatch for {runtime_env_object_key}: "
                f"expected {expected_runtime_env_sha256}, got {sha256_hex(runtime_env_bytes)}"
            )
        write_atomic(runtime_env_path, runtime_env_bytes)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
