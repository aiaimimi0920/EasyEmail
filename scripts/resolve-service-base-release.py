from __future__ import annotations

from datetime import datetime, timezone
import os
from pathlib import Path
import subprocess


def resolve_release_metadata(environment: dict[str, str]) -> dict[str, str | list[str]]:
    owner = environment["GITHUB_REPOSITORY_OWNER"].lower()
    short_sha = subprocess.run(
        ["git", "rev-parse", "--short", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()

    if environment["GITHUB_EVENT_NAME"] == "push" and environment.get("COORDINATED_RELEASE") != "true":
        version = environment["GITHUB_REF_NAME"]
        push_latest = "true"
        run_smoke = "true"
        platform = "linux/amd64"
        force_publish = "false"
    else:
        version = environment.get("RELEASE_TAG_INPUT") or environment.get("VERSION_INPUT")
        if not version:
            date = datetime.now(timezone.utc).strftime("%Y%m%d")
            version = f"release-{date}-{int(environment['GITHUB_RUN_NUMBER']):03d}"
        push_latest = environment.get("PUSH_LATEST_INPUT", "")
        run_smoke = environment.get("RUN_SMOKE_INPUT", "")
        platform = environment.get("PLATFORM_INPUT", "")
        force_publish = environment.get("FORCE_PUBLISH_INPUT", "")

    image_ref = f"{environment['REGISTRY']}/{owner}/{environment['IMAGE_NAME']}"
    tags = [f"{image_ref}:{version}", f"{image_ref}:sha-{short_sha}"]
    if push_latest == "true":
        tags.append(f"{image_ref}:latest")

    return {
        "owner": owner,
        "version": version,
        "release_tag": version,
        "short_sha": short_sha,
        "platform": platform,
        "image_ref": image_ref,
        "smoke_image": f"{image_ref}:smoke-{environment['GITHUB_RUN_ID']}",
        "push_latest": push_latest,
        "run_smoke": run_smoke,
        "force_publish": force_publish,
        "tags": tags,
    }


def write_github_outputs(path: Path, metadata: dict[str, str | list[str]]) -> None:
    lines: list[str] = []
    for name, value in metadata.items():
        if isinstance(value, list):
            lines.extend((f"{name}<<EOF", *value, "EOF"))
        else:
            lines.append(f"{name}={value}")
    with path.open("a", encoding="utf-8", newline="\n") as output:
        output.write("\n".join(lines) + "\n")


def main() -> None:
    output_path = Path(os.environ["GITHUB_OUTPUT"])
    write_github_outputs(output_path, resolve_release_metadata(dict(os.environ)))


if __name__ == "__main__":
    main()
