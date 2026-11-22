import unittest

from tests.http_api_contract_support import (
    DOMAIN_MAIL_IMAP_SYNC,
    HTTP_MAIL_IMAP_SYNC_CONTRACTS,
    HttpApiContractTestCase,
    extract_interface_fields,
)


class HttpApiImapSyncContractTests(HttpApiContractTestCase):
    def test_m6_request_and_response_schemas_match_typescript_interfaces(self) -> None:
        interfaces = {
            "MailAccountSyncInput": (DOMAIN_MAIL_IMAP_SYNC, "MailAccountSyncInput"),
            "MailImapFolder": (DOMAIN_MAIL_IMAP_SYNC, "MailImapFolder"),
            "MailAccountSyncStatus": (DOMAIN_MAIL_IMAP_SYNC, "MailAccountSyncStatus"),
            "MailAccountFolderSyncSummary": (
                DOMAIN_MAIL_IMAP_SYNC,
                "MailAccountFolderSyncSummary",
            ),
            "MailAccountSyncResult": (DOMAIN_MAIL_IMAP_SYNC, "MailAccountSyncResult"),
            "ListMailAccountFoldersResponse": (
                HTTP_MAIL_IMAP_SYNC_CONTRACTS,
                "ListMailAccountFoldersHttpResponse",
            ),
            "GetMailAccountSyncStatusResponse": (
                HTTP_MAIL_IMAP_SYNC_CONTRACTS,
                "GetMailAccountSyncStatusHttpResponse",
            ),
            "SyncMailAccountResponse": (
                HTTP_MAIL_IMAP_SYNC_CONTRACTS,
                "SyncMailAccountHttpResponse",
            ),
        }

        for schema_name, (path, interface_name) in interfaces.items():
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
            self.assertFalse(schema.get("additionalProperties", True), schema_name)

    def test_m6_operations_use_typed_responses_and_reject_raw_secrets(self) -> None:
        expected_responses = {
            "listMailAccountFolders": "ListMailAccountFoldersResponse",
            "getMailAccountSyncStatus": "GetMailAccountSyncStatusResponse",
            "syncMailAccount": "SyncMailAccountResponse",
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

        sync_input = self.openapi["components"]["schemas"]["MailAccountSyncInput"]
        forbidden_fields = {"password", "token", "authorizationCode", "secret"}
        self.assertTrue(forbidden_fields.isdisjoint(sync_input["properties"]))


if __name__ == "__main__":
    unittest.main()
