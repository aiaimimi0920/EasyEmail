from __future__ import annotations

import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SERVER_CONTRACTS = ROOT / "service" / "base" / "src" / "http" / "contracts.ts"
DOMAIN_MODELS = ROOT / "service" / "base" / "src" / "domain" / "models.ts"
SHARED_CREDENTIALS = (
    ROOT / "service" / "base" / "src" / "shared" / "credentials.ts"
)
ROUTE_FILES = tuple(
    (ROOT / "service" / "base" / "src" / "http" / "routes").glob("*.ts")
)
OPENAPI_PATH = ROOT / "docs" / "easyemail-openapi.json"


def extract_static_routes(text: str) -> dict[str, str]:
    return {
        name: value
        for name, value in re.findall(
            r'^\s{2}(\w+):\s+"([^"]+)",\s*$', text, re.MULTILINE
        )
    }


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


class HttpApiContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.server_text = SERVER_CONTRACTS.read_text(encoding="utf-8")
        self.route_text = "\n".join(
            path.read_text(encoding="utf-8") for path in ROUTE_FILES
        )
        self.openapi = json.loads(OPENAPI_PATH.read_text(encoding="utf-8"))

    def test_openapi_covers_every_service_route(self) -> None:
        static_routes = set(extract_static_routes(self.server_text).values())
        documented_paths = set(self.openapi["paths"])
        documented_static_paths = {
            path for path in documented_paths if "{" not in path
        }

        self.assertEqual(documented_static_paths, static_routes)
        self.assertEqual(
            documented_paths - documented_static_paths,
            {
                "/mail/providers/{instanceId}/probe",
                "/mail/mailboxes/{sessionId}/code",
                "/mail/mailboxes/{sessionId}/auth-link",
                "/mail/query/observed-messages/{messageId}",
            },
        )

    def test_openapi_methods_match_service_route_implementations(self) -> None:
        routes = extract_static_routes(self.server_text)
        route_methods = {
            routes[name]: method.lower()
            for method, name in re.findall(
                r'method === "(GET|POST)" && path === '
                r"EASY_EMAIL_HTTP_ROUTES\.(\w+)",
                self.route_text,
            )
        }
        route_methods.update(
            {
                "/mail/providers/{instanceId}/probe": "get",
                "/mail/mailboxes/{sessionId}/code": "get",
                "/mail/mailboxes/{sessionId}/auth-link": "get",
                "/mail/query/observed-messages/{messageId}": "get",
            }
        )

        self.assertEqual(set(route_methods), set(self.openapi["paths"]))
        for path, method in route_methods.items():
            documented_methods = set(self.openapi["paths"][path]) & {
                "get",
                "post",
                "put",
                "patch",
                "delete",
            }
            self.assertEqual(documented_methods, {method}, path)

    def test_openapi_operations_and_local_references_are_well_formed(self) -> None:
        operation_ids: set[str] = set()

        def visit(value: object) -> None:
            if isinstance(value, list):
                for item in value:
                    visit(item)
                return
            if not isinstance(value, dict):
                return
            ref = value.get("$ref")
            if isinstance(ref, str):
                resolve_local_ref(self.openapi, ref)
            for item in value.values():
                visit(item)

        visit(self.openapi)

        for path, path_item in self.openapi["paths"].items():
            placeholders = set(re.findall(r"\{([^}]+)\}", path))
            for method, operation in path_item.items():
                if method not in {"get", "post", "put", "patch", "delete"}:
                    continue

                operation_id = operation.get("operationId")
                self.assertIsInstance(operation_id, str, f"{method} {path}")
                self.assertNotIn(
                    operation_id,
                    operation_ids,
                    f"duplicate operationId: {operation_id}",
                )
                operation_ids.add(operation_id)
                self.assertIn(
                    "200", operation.get("responses", {}), f"{method} {path}"
                )

                parameters = []
                for parameter in operation.get("parameters", []):
                    if "$ref" in parameter:
                        parameter = resolve_local_ref(self.openapi, parameter["$ref"])
                    parameters.append(parameter)
                documented_path_parameters = {
                    parameter["name"]
                    for parameter in parameters
                    if isinstance(parameter, dict)
                    and parameter.get("in") == "path"
                    and parameter.get("required") is True
                }
                self.assertEqual(
                    documented_path_parameters, placeholders, f"{method} {path}"
                )

    def test_openapi_is_the_authenticated_direct_http_contract(self) -> None:
        self.assertEqual(self.openapi["openapi"], "3.1.0")
        self.assertEqual(
            self.openapi["servers"][0]["url"], "http://127.0.0.1:18081"
        )
        self.assertEqual(self.openapi["security"], [{"bearerAuth": []}])
        bearer = self.openapi["components"]["securitySchemes"]["bearerAuth"]
        self.assertEqual(bearer["type"], "http")
        self.assertEqual(bearer["scheme"], "bearer")
        self.assertIn(
            "published client SDK is not required",
            self.openapi["info"]["description"],
        )

    def test_mailbox_open_schema_matches_required_server_request_fields(
        self,
    ) -> None:
        schema = self.openapi["components"]["schemas"]["VerificationMailboxRequest"]
        self.assertEqual(
            schema["required"], ["hostId", "provisionMode", "bindingMode"]
        )
        self.assertEqual(
            schema["properties"]["provisionMode"]["enum"],
            ["reuse-only", "auto-create-if-missing", "always-create-dedicated"],
        )
        self.assertEqual(
            schema["properties"]["bindingMode"]["enum"],
            ["shared-instance", "dedicated-instance", "instance-group"],
        )

    def test_named_request_schemas_match_typescript_interface_fields(self) -> None:
        request_interfaces = {
            "VerificationMailboxRequest": (
                DOMAIN_MODELS,
                "VerificationMailboxRequest",
            ),
            "RegisterCloudflareTempEmailRuntimeRequest": (
                DOMAIN_MODELS,
                "RegisterCloudflareTempEmailRuntimeRequest",
            ),
            "ApplyCredentialSetsRequest": (
                SERVER_CONTRACTS,
                "ApplyMailCredentialSetsHttpRequest",
            ),
            "CredentialSetDefinition": (
                SHARED_CREDENTIALS,
                "CredentialSetDefinition",
            ),
            "CredentialItemDefinition": (
                SHARED_CREDENTIALS,
                "CredentialItemDefinition",
            ),
            "UpdateMailboxSessionRequest": (
                DOMAIN_MODELS,
                "MailboxSessionUpdateRequest",
            ),
            "RecoverMailboxByEmailRequest": (
                SERVER_CONTRACTS,
                "RecoverMailboxByEmailHttpRequest",
            ),
            "RecoverMailboxCapacityRequest": (
                SERVER_CONTRACTS,
                "RecoverMailboxCapacityHttpRequest",
            ),
            "CleanupMoemailMailboxesRequest": (
                SERVER_CONTRACTS,
                "CleanupMoemailMailboxesHttpRequest",
            ),
            "MailboxOutcomeReport": (DOMAIN_MODELS, "MailboxOutcomeReport"),
            "MailboxSendRequest": (DOMAIN_MODELS, "MailboxSendRequest"),
            "ReleaseMailboxRequest": (
                SERVER_CONTRACTS,
                "ReleaseMailboxHttpRequest",
            ),
            "ObserveMessageInput": (DOMAIN_MODELS, "ObserveMessageInput"),
        }

        for schema_name, (path, interface_name) in request_interfaces.items():
            expected_properties, expected_required = extract_interface_fields(
                path, interface_name
            )
            schema = self.openapi["components"]["schemas"][schema_name]
            self.assertEqual(
                set(schema.get("properties", {})), expected_properties, schema_name
            )
            self.assertEqual(
                set(schema.get("required", [])), expected_required, schema_name
            )

    def test_core_response_schemas_match_typescript_interface_fields(self) -> None:
        response_interfaces = {
            "MailboxSession": (DOMAIN_MODELS, "MailboxSession"),
            "ProviderInstance": (DOMAIN_MODELS, "ProviderInstance"),
            "HostBinding": (DOMAIN_MODELS, "HostBinding"),
            "MailboxTemporaryAuthCredential": (
                DOMAIN_MODELS,
                "MailboxTemporaryAuthCredential",
            ),
            "MailboxRecoveryRequiredFields": (
                DOMAIN_MODELS,
                "MailboxRecoveryRequiredFields",
            ),
            "MailboxCreatedByProvider": (
                DOMAIN_MODELS,
                "MailboxCreatedByProvider",
            ),
            "VerificationMailboxOpenResult": (
                DOMAIN_MODELS,
                "VerificationMailboxOpenResult",
            ),
            "MailboxSendResult": (DOMAIN_MODELS, "MailboxSendResult"),
            "VerificationCodeResult": (DOMAIN_MODELS, "VerificationCodeResult"),
            "AuthenticationLinkResult": (DOMAIN_MODELS, "AuthenticationLinkResult"),
            "ActionLinkCandidate": (DOMAIN_MODELS, "ActionLinkCandidate"),
            "CatalogResponse": (SERVER_CONTRACTS, "GetMailCatalogHttpResponse"),
            "SnapshotResponse": (SERVER_CONTRACTS, "GetMailSnapshotHttpResponse"),
            "OpenMailboxResponse": (SERVER_CONTRACTS, "OpenMailboxHttpResponse"),
            "SendMailboxResponse": (
                SERVER_CONTRACTS,
                "SendMailboxMessageHttpResponse",
            ),
            "ReleaseMailboxResponse": (
                SERVER_CONTRACTS,
                "ReleaseMailboxHttpResponse",
            ),
            "VerificationCodeResponse": (
                SERVER_CONTRACTS,
                "ReadVerificationCodeHttpResponse",
            ),
            "AuthenticationLinkResponse": (
                SERVER_CONTRACTS,
                "ReadAuthenticationLinkHttpResponse",
            ),
        }

        for schema_name, (path, interface_name) in response_interfaces.items():
            expected_properties, expected_required = extract_interface_fields(
                path, interface_name
            )
            schema = self.openapi["components"]["schemas"][schema_name]
            self.assertEqual(
                set(schema.get("properties", {})), expected_properties, schema_name
            )
            self.assertEqual(
                set(schema.get("required", [])), expected_required, schema_name
            )

    def test_core_operations_use_typed_success_responses(self) -> None:
        expected_responses = {
            "getCatalog": "CatalogResponse",
            "getSnapshot": "SnapshotResponse",
            "openMailbox": "OpenMailboxResponse",
            "sendMailboxMessage": "SendMailboxResponse",
            "releaseMailbox": "ReleaseMailboxResponse",
            "readVerificationCode": "VerificationCodeResponse",
            "readAuthenticationLink": "AuthenticationLinkResponse",
        }
        actual_responses = {}
        for path_item in self.openapi["paths"].values():
            for method, operation in path_item.items():
                if method not in {"get", "post", "put", "patch", "delete"}:
                    continue
                operation_id = operation["operationId"]
                if operation_id in expected_responses:
                    actual_responses[operation_id] = operation["responses"]["200"][
                        "$ref"
                    ].rsplit("/", 1)[-1]

        self.assertEqual(actual_responses, expected_responses)


if __name__ == "__main__":
    unittest.main()
