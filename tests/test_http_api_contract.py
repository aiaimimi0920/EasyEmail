import unittest
from tests.http_api_contract_support import (
    ACCOUNT_CONNECTIVITY,
    DOMAIN_ACCOUNT,
    DOMAIN_CONTACT,
    DOMAIN_MODELS,
    DOMAIN_TAXONOMY,
    SERVER_CONTRACTS,
    SHARED_CREDENTIAL_MODELS,
    HttpApiContractTestCase,
    extract_interface_fields,
)


class HttpApiContractTests(HttpApiContractTestCase):

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
                SHARED_CREDENTIAL_MODELS,
                "CredentialSetDefinition",
            ),
            "CredentialItemDefinition": (
                SHARED_CREDENTIAL_MODELS,
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
