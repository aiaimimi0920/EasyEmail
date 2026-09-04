from __future__ import annotations

import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SERVER_CONTRACTS = ROOT / "service" / "base" / "src" / "http" / "contracts.ts"
DOMAIN_MODELS = ROOT / "service" / "base" / "src" / "domain" / "models.ts"
DOMAIN_CONTACT = ROOT / "service" / "base" / "src" / "domain" / "contact.ts"
DOMAIN_ACCOUNT = ROOT / "service" / "base" / "src" / "domain" / "account.ts"
ACCOUNT_CONNECTIVITY = (
    ROOT / "service" / "base" / "src" / "service" / "account-connectivity.ts"
)
DOMAIN_TAXONOMY = (
    ROOT / "service" / "base" / "src" / "domain" / "mail-taxonomy.ts"
)
SHARED_CREDENTIAL_MODELS = (
    ROOT / "service" / "base" / "src" / "shared" / "credential-models.ts"
)
ROUTE_FILES = tuple(
    (ROOT / "service" / "base" / "src" / "http" / "routes").glob("*.ts")
)
HTTP_SERVER = ROOT / "service" / "base" / "src" / "http" / "server.ts"
HTTP_SOURCE_FILES = (SERVER_CONTRACTS, HTTP_SERVER, *ROUTE_FILES)
OPENAPI_PATH = ROOT / "docs" / "easyemail-openapi.json"

DYNAMIC_ROUTE_METHODS = {
    "probeProviderInstance": {"get": "probeProviderInstance"},
    "readVerificationCode": {"get": "readVerificationCode"},
    "readAuthenticationLink": {"get": "readAuthenticationLink"},
    "refreshMailbox": {"post": "refreshMailbox"},
    "getObservedMessage": {"get": "getObservedMessage"},
    "contact": {
        "get": "getContact",
        "patch": "updateContact",
        "delete": "deleteContact",
    },
    "account": {
        "get": "getMailAccount",
        "patch": "updateMailAccount",
        "delete": "deleteMailAccount",
    },
    "disableAccount": {"post": "disableMailAccount"},
    "taxonomyItem": {
        "get": "getMailTaxonomy",
        "patch": "updateMailTaxonomy",
        "delete": "deleteMailTaxonomy",
    },
    "taxonomyUpsert": {"put": "upsertMailTaxonomy"},
}

STATIC_ROUTE_DISPATCH = re.compile(
    r'method === "(GET|POST|PUT|PATCH|DELETE)" && path === '
    r"EASY_EMAIL_HTTP_ROUTES\.(\w+)"
)


def extract_static_routes(text: str) -> dict[str, str]:
    return {
        name: value
        for name, value in re.findall(
            r'^\s{2}(\w+):\s+"([^"]+)",\s*$', text, re.MULTILINE
        )
    }


def extract_dynamic_routes(text: str) -> dict[str, str]:
    routes: dict[str, str] = {}
    for name, parameters, template in re.findall(
        r"^\s{2}(\w+)\(([^)]*)\): string \{\s+"
        r"return `([^`]+)`;\s+\},$",
        text,
        re.MULTILINE,
    ):
        path = template
        for parameter in re.findall(r"(\w+)\s*:", parameters):
            expression = "${encodeURIComponent(" + parameter + ")}"
            path = path.replace(expression, "{" + parameter + "}")
        if "${" in path:
            raise AssertionError(f"unsupported dynamic route template: {name}: {template}")
        routes[name] = path
    return routes


def resolve_local_ref(document: dict[str, object], ref: str) -> object:
    if not ref.startswith("#/"):
        raise AssertionError(
            f"OpenAPI contract must not depend on an external reference: {ref}"
        )

    value: object = document
    for encoded_part in ref[2:].split("/"):
        part = encoded_part.replace("~1", "/").replace("~0", "~")
        if not isinstance(value, dict) or part not in value:
            raise AssertionError(f"unresolved OpenAPI reference: {ref}")
        value = value[part]
    return value


def extract_interface_fields(
    path: Path, interface_name: str
) -> tuple[set[str], set[str]]:
    source = path.read_text(encoding="utf-8")
    matched = re.search(
        rf"^export interface {re.escape(interface_name)}"
        rf"(?:\s+extends\s+[^{{]+)?\s*\{{\n(.*?)^\}}",
        source,
        re.MULTILINE | re.DOTALL,
    )
    if not matched:
        raise AssertionError(f"missing TypeScript interface: {interface_name}")

    fields = re.findall(r"^  (\w+)(\?)?:", matched.group(1), re.MULTILINE)
    return (
        {name for name, _ in fields},
        {name for name, optional in fields if not optional},
    )


class HttpApiContractTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.server_text = SERVER_CONTRACTS.read_text(encoding="utf-8")
        self.route_text = "\n".join(
            path.read_text(encoding="utf-8") for path in ROUTE_FILES
        )
        self.http_source_text = "\n".join(
            path.read_text(encoding="utf-8") for path in HTTP_SOURCE_FILES
        )
        self.openapi = json.loads(OPENAPI_PATH.read_text(encoding="utf-8"))
