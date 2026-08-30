from __future__ import annotations

import re


SEMVER_PATTERN = re.compile(r"^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$")
OPERATIONAL_PATTERN = re.compile(r"^release-\d{8}-\d{3}$")
SERVICE_BASE_PATTERN = re.compile(r"^service-base-\d{8}-\d{3}$")

MODE_FAMILIES = {
    "any": {"public-semver", "operational", "service-base-only"},
    "service-base": {"public-semver", "operational", "service-base-only"},
    "cloudflare": {"public-semver", "operational"},
    "distribution": {"public-semver", "operational"},
}


def classify_tag(tag: str) -> dict[str, object]:
    if SEMVER_PATTERN.fullmatch(tag):
        return {
            "family": "public-semver",
            "channel": "public-semver",
            "isSemver": True,
            "isOperational": False,
            "isServiceBaseOnly": False,
        }

    if OPERATIONAL_PATTERN.fullmatch(tag):
        return {
            "family": "operational",
            "channel": "operational",
            "isSemver": False,
            "isOperational": True,
            "isServiceBaseOnly": False,
        }

    if SERVICE_BASE_PATTERN.fullmatch(tag):
        return {
            "family": "service-base-only",
            "channel": "service-base-only",
            "isSemver": False,
            "isOperational": False,
            "isServiceBaseOnly": True,
        }

    raise ValueError(
        "Unsupported release tag format. Use vX.Y.Z, release-YYYYMMDD-NNN, or service-base-YYYYMMDD-NNN."
    )
