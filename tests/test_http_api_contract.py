from __future__ import annotations

import json
import re
import unittest
from collections import Counter
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
SHARED_CREDENTIALS = (
    ROOT / "service" / "base" / "src" / "shared" / "credentials.ts"
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


class HttpApiContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.server_text = SERVER_CONTRACTS.read_text(encoding="utf-8")
        self.route_text = "\n".join(
            path.read_text(encoding="utf-8") for path in ROUTE_FILES
        )
        self.http_source_text = "\n".join(
            path.read_text(encoding="utf-8") for path in HTTP_SOURCE_FILES
        )
        self.openapi = json.loads(OPENAPI_PATH.read_text(encoding="utf-8"))

    def test_openapi_covers_every_service_route(self) -> None:
        static_routes = set(extract_static_routes(self.server_text).values())
        dynamic_routes = set(extract_dynamic_routes(self.server_text).values())
        documented_paths = set(self.openapi["paths"])

        self.assertEqual(documented_paths, static_routes | dynamic_routes)

    def test_route_constants_are_unique_and_completely_dispatched(self) -> None:
        static_routes = extract_static_routes(self.server_text)
        dynamic_routes = extract_dynamic_routes(self.server_text)
        all_paths = [*static_routes.values(), *dynamic_routes.values()]

        duplicate_paths = sorted(
            path for path, count in Counter(all_paths).items() if count > 1
        )
        self.assertEqual(duplicate_paths, [])

        static_dispatches = STATIC_ROUTE_DISPATCH.findall(self.route_text)
        static_references = Counter(name for _, name in static_dispatches)
        self.assertEqual(set(static_references), set(static_routes))
        self.assertEqual(
            len(static_dispatches), len(set(static_dispatches)), "duplicate static dispatch"
        )

        self.assertEqual(set(dynamic_routes), set(DYNAMIC_ROUTE_METHODS))
        for name, methods in DYNAMIC_ROUTE_METHODS.items():
            for handler_name in methods.values():
                self.assertEqual(
                    self.route_text.count(f"handler.{handler_name}("),
                    1,
                    f"{name}: {handler_name}",
                )

    def test_openapi_methods_match_service_route_implementations(self) -> None:
        routes = extract_static_routes(self.server_text)
        dynamic_routes = extract_dynamic_routes(self.server_text)
        route_methods: dict[str, set[str]] = {}
        for method, name in STATIC_ROUTE_DISPATCH.findall(self.route_text):
            route_methods.setdefault(routes[name], set()).add(method.lower())
        for name, methods in DYNAMIC_ROUTE_METHODS.items():
            route_methods.setdefault(dynamic_routes[name], set()).update(methods)

        self.assertEqual(set(route_methods), set(self.openapi["paths"]))
        for path, methods in route_methods.items():
            documented_methods = set(self.openapi["paths"][path]) & {
                "get",
                "post",
                "put",
                "patch",
                "delete",
            }
            self.assertEqual(documented_methods, methods, path)

    def test_generic_commands_endpoint_is_not_exposed(self) -> None:
        for path in self.openapi["paths"]:
            self.assertNotIn("/commands", path)
        self.assertNotRegex(
            self.http_source_text,
            r'["`][^"`\n]*/commands(?:/|\{|["`])',
        )

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
            "RefreshAnonymousMailboxesRequest": (
                SERVER_CONTRACTS,
                "RefreshAnonymousMailboxesHttpRequest",
            ),
            "MailboxOutcomeReport": (DOMAIN_MODELS, "MailboxOutcomeReport"),
            "MailboxSendRequest": (DOMAIN_MODELS, "MailboxSendRequest"),
            "ReleaseMailboxRequest": (
                SERVER_CONTRACTS,
                "ReleaseMailboxHttpRequest",
            ),
            "ObserveMessageInput": (DOMAIN_MODELS, "ObserveMessageInput"),
            "ContactCreateInput": (DOMAIN_CONTACT, "ContactCreateInput"),
            "ContactUpdateInput": (DOMAIN_CONTACT, "ContactUpdateInput"),
            "MailCredentialRefInput": (
                DOMAIN_ACCOUNT,
                "MailCredentialRefInput",
            ),
            "MailAccountImapProfileInput": (
                DOMAIN_ACCOUNT,
                "MailAccountImapProfileInput",
            ),
            "MailAccountCreateInput": (
                DOMAIN_ACCOUNT,
                "MailAccountCreateInput",
            ),
            "MailAccountUpdateInput": (
                DOMAIN_ACCOUNT,
                "MailAccountUpdateInput",
            ),
            "MailAccountImapTestInput": (
                ACCOUNT_CONNECTIVITY,
                "MailAccountImapTestRequest",
            ),
            "MailTaxonomyUpsertInput": (
                DOMAIN_TAXONOMY,
                "MailTaxonomyUpsertRequest",
            ),
            "MailTaxonomyUpdateInput": (
                DOMAIN_TAXONOMY,
                "MailTaxonomyUpdateRequest",
            ),
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
            "MailboxRefreshResult": (
                SERVER_CONTRACTS,
                "MailboxRefreshResult",
            ),
            "MailboxRefreshFailure": (
                SERVER_CONTRACTS,
                "MailboxRefreshFailure",
            ),
            "RefreshMailboxResponse": (
                SERVER_CONTRACTS,
                "RefreshMailboxHttpResponse",
            ),
            "Contact": (DOMAIN_CONTACT, "Contact"),
            "ContactsResponse": (SERVER_CONTRACTS, "ListContactsHttpResponse"),
            "ContactResponse": (SERVER_CONTRACTS, "CreateContactHttpResponse"),
            "DeleteContactResponse": (
                SERVER_CONTRACTS,
                "DeleteContactHttpResponse",
            ),
            "MailCredentialRef": (DOMAIN_ACCOUNT, "MailCredentialRef"),
            "MailAccountImapProfile": (
                DOMAIN_ACCOUNT,
                "MailAccountImapProfile",
            ),
            "MailAccount": (DOMAIN_ACCOUNT, "MailAccount"),
            "AccountsResponse": (
                SERVER_CONTRACTS,
                "ListMailAccountsHttpResponse",
            ),
            "AccountResponse": (
                SERVER_CONTRACTS,
                "CreateMailAccountHttpResponse",
            ),
            "MailImapConnectionTestResult": (
                ACCOUNT_CONNECTIVITY,
                "MailImapConnectionTestResult",
            ),
            "TestMailAccountImapResponse": (
                SERVER_CONTRACTS,
                "TestMailAccountImapHttpResponse",
            ),
            "DeleteAccountResponse": (
                SERVER_CONTRACTS,
                "DeleteMailAccountHttpResponse",
            ),
            "MailTaxonomyItem": (DOMAIN_TAXONOMY, "MailTaxonomyItem"),
            "MailTaxonomyCapabilities": (
                DOMAIN_TAXONOMY,
                "MailTaxonomyCapabilities",
            ),
            "MailTaxonomyListResponse": (
                SERVER_CONTRACTS,
                "ListMailTaxonomyHttpResponse",
            ),
            "MailTaxonomyMutationResponse": (
                SERVER_CONTRACTS,
                "UpsertMailTaxonomyHttpResponse",
            ),
            "MailTaxonomyDeleteResponse": (
                SERVER_CONTRACTS,
                "DeleteMailTaxonomyHttpResponse",
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
            "refreshMailbox": "RefreshMailboxResponse",
            "refreshAnonymousMailboxes": "RefreshMailboxResponse",
            "listContacts": "ContactsResponse",
            "getContact": "ContactResponse",
            "createContact": "ContactResponse",
            "updateContact": "ContactResponse",
            "deleteContact": "DeleteContactResponse",
            "listMailAccounts": "AccountsResponse",
            "getMailAccount": "AccountResponse",
            "createMailAccount": "AccountResponse",
            "updateMailAccount": "AccountResponse",
            "disableMailAccount": "AccountResponse",
            "deleteMailAccount": "DeleteAccountResponse",
            "testMailAccountImap": "TestMailAccountImapResponse",
            "listMailTaxonomy": "MailTaxonomyListResponse",
            "getMailTaxonomy": "MailTaxonomyMutationResponse",
            "upsertMailTaxonomy": "MailTaxonomyMutationResponse",
            "updateMailTaxonomy": "MailTaxonomyMutationResponse",
            "deleteMailTaxonomy": "MailTaxonomyDeleteResponse",
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

    def test_resource_operations_document_not_found_responses(self) -> None:
        expected_operation_ids = {
            "sendMailboxMessage",
            "updateMailboxSession",
            "releaseMailbox",
            "reportMailboxOutcome",
            "observeMessage",
            "refreshMailbox",
            "getContact",
            "updateContact",
            "deleteContact",
            "getMailAccount",
            "updateMailAccount",
            "disableMailAccount",
            "deleteMailAccount",
            "testMailAccountImap",
            "getMailTaxonomy",
            "updateMailTaxonomy",
            "deleteMailTaxonomy",
        }
        documented_operation_ids = {
            operation["operationId"]
            for path_item in self.openapi["paths"].values()
            for method, operation in path_item.items()
            if method in {"get", "post", "put", "patch", "delete"}
            and operation.get("responses", {}).get("404")
            == {"$ref": "#/components/responses/NotFound"}
        }

        self.assertEqual(documented_operation_ids, expected_operation_ids)

    def test_account_contract_accepts_only_opaque_versioned_credential_refs(self) -> None:
        schemas = self.openapi["components"]["schemas"]
        account_create = schemas["MailAccountCreateInput"]
        credential_input = schemas["MailCredentialRefInput"]
        imap_test_input = schemas["MailAccountImapTestInput"]

        self.assertEqual(
            account_create["properties"]["kind"]["enum"],
            ["normal_long_lived", "agent_owned"],
        )
        self.assertEqual(
            credential_input["properties"]["secretKey"]["pattern"],
            "^ref:v1:[A-Za-z0-9._:/-]+$",
        )
        forbidden_fields = {"password", "token", "authorizationCode", "secret"}
        self.assertTrue(
            forbidden_fields.isdisjoint(credential_input["properties"])
        )
        self.assertFalse(credential_input.get("additionalProperties", True))
        self.assertEqual(
            set(imap_test_input["properties"]), {"accountId", "credentialRefId"}
        )
        self.assertEqual(
            set(imap_test_input["required"]), {"accountId", "credentialRefId"}
        )
        self.assertTrue(forbidden_fields.isdisjoint(imap_test_input["properties"]))
        self.assertFalse(imap_test_input.get("additionalProperties", True))


if __name__ == "__main__":
    unittest.main()
