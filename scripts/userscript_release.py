from __future__ import annotations

import re
from pathlib import Path

from release_tag import classify_tag


VERSION_LINE = re.compile(r"^// @version\s+\S+\s*$", re.MULTILINE)
LOCAL_SECRET_PLACEHOLDER = re.compile(r"__LOCAL_SECRET_[A-Z0-9_]+__")
EXPECTED_PLACEHOLDERS = {
    "__LOCAL_SECRET_CLOUDFLARE_ADMIN_AUTH__",
    "__LOCAL_SECRET_CLOUDFLARE_CUSTOM_AUTH__",
    "__LOCAL_SECRET_GPTMAIL_API_KEY__",
    "__LOCAL_SECRET_IM215_API_KEY__",
    "__LOCAL_SECRET_MAIL2925_ACCOUNT__",
    "__LOCAL_SECRET_MAIL2925_COOKIE_HEADER__",
    "__LOCAL_SECRET_MAIL2925_DEVICE_UID__",
    "__LOCAL_SECRET_MAIL2925_JWT_TOKEN__",
    "__LOCAL_SECRET_MOEMAIL_API_KEY__",
}
SENSITIVE_DEFAULTS = {
    "cloudflare_customAuth": "__LOCAL_SECRET_CLOUDFLARE_CUSTOM_AUTH__",
    "cloudflare_adminAuth": "__LOCAL_SECRET_CLOUDFLARE_ADMIN_AUTH__",
    "moemail_apiKey": "__LOCAL_SECRET_MOEMAIL_API_KEY__",
    "gptmail_apiKey": "__LOCAL_SECRET_GPTMAIL_API_KEY__",
    "im215_apiKey": "__LOCAL_SECRET_IM215_API_KEY__",
    "mail2925_account": "__LOCAL_SECRET_MAIL2925_ACCOUNT__",
    "mail2925_jwtToken": "__LOCAL_SECRET_MAIL2925_JWT_TOKEN__",
    "mail2925_deviceUid": "__LOCAL_SECRET_MAIL2925_DEVICE_UID__",
    "mail2925_cookieHeader": "__LOCAL_SECRET_MAIL2925_COOKIE_HEADER__",
}
HIGH_CONFIDENCE_SECRET_PATTERNS = {
    "private key": re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    "GitHub token": re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b"),
    "AWS access key": re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"),
    "JWT": re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b"),
}


def userscript_version(release_tag: str) -> str:
    tag = release_tag.strip()
    classification = classify_tag(tag)
    family = classification["family"]
    if family == "service-base-only":
        raise ValueError("service-base-only tags cannot publish a Userscript release.")
    if family == "public-semver":
        return tag.removeprefix("v")
    if family == "operational":
        return tag.removeprefix("release-").replace("-", ".")
    raise ValueError(f"Unsupported Userscript release family: {family}.")


def validate_template(text: str) -> None:
    matches = VERSION_LINE.findall(text)
    if len(matches) != 1:
        raise ValueError("Userscript template must contain exactly one @version line.")

    placeholders = set(LOCAL_SECRET_PLACEHOLDER.findall(text))
    if placeholders != EXPECTED_PLACEHOLDERS:
        missing = sorted(EXPECTED_PLACEHOLDERS - placeholders)
        unexpected = sorted(placeholders - EXPECTED_PLACEHOLDERS)
        raise ValueError(
            "Userscript local-secret placeholder contract changed: "
            f"missing={missing}, unexpected={unexpected}."
        )

    for key, expected_value in SENSITIVE_DEFAULTS.items():
        pattern = re.compile(rf"^\s+{re.escape(key)}:\s*'([^']*)',\s*$", re.MULTILINE)
        values = pattern.findall(text)
        if values != [expected_value]:
            raise ValueError(
                f"Userscript sensitive default '{key}' must appear exactly once and use its tracked placeholder."
            )

    for label, pattern in HIGH_CONFIDENCE_SECRET_PATTERNS.items():
        if pattern.search(text):
            raise ValueError(f"Userscript template contains a possible live {label}.")


def build_userscript(source: Path, output: Path, release_tag: str) -> str:
    source = source.resolve()
    output = output.resolve()
    if source == output:
        raise ValueError("Userscript release output must not overwrite the tracked template.")

    source_text = source.read_text(encoding="utf-8")
    validate_template(source_text)
    version = userscript_version(release_tag)
    release_text = VERSION_LINE.sub(f"// @version      {version}", source_text, count=1)

    normalized_source = VERSION_LINE.sub("// @version      <release-version>", source_text, count=1)
    normalized_release = VERSION_LINE.sub("// @version      <release-version>", release_text, count=1)
    if normalized_release != normalized_source:
        raise AssertionError("Userscript release generation changed content outside the metadata version.")
    validate_template(release_text)

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(release_text, encoding="utf-8", newline="\n")
    return version
