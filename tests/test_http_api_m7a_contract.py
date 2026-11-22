import unittest

from tests.http_api_contract_support import (
    DOMAIN_MAIL_EXTENSIONS,
    HTTP_MAIL_M7A_CONTRACTS,
    HttpApiContractTestCase,
    extract_interface_fields,
)


class HttpApiM7aContractTests(HttpApiContractTestCase):
    def test_m7a_request_and_response_schemas_match_typescript_interfaces(self) -> None:
        interfaces = {
            "PromoteMailboxSessionInput": (
                DOMAIN_MAIL_EXTENSIONS,
                "PromoteMailboxSessionInput",
            ),
            "PromoteMailboxSessionResult": (
                DOMAIN_MAIL_EXTENSIONS,
                "PromoteMailboxSessionResult",
            ),
            "MailNewsletterSubscription": (
                DOMAIN_MAIL_EXTENSIONS,
                "MailNewsletterSubscription",
            ),
            "MailNewsletterSubscriptionUpdateInput": (
                DOMAIN_MAIL_EXTENSIONS,
                "MailNewsletterSubscriptionUpdateInput",
            ),
            "MailNewsletterSubscriptionActionResult": (
                DOMAIN_MAIL_EXTENSIONS,
                "MailNewsletterSubscriptionActionResult",
            ),
            "EasyEmailClientSettings": (
                DOMAIN_MAIL_EXTENSIONS,
                "EasyEmailClientSettings",
            ),
            "EasyEmailClientSettingsUpdateInput": (
                DOMAIN_MAIL_EXTENSIONS,
                "EasyEmailClientSettingsUpdateInput",
            ),
            "EasyEmailConnectionTestInput": (
                DOMAIN_MAIL_EXTENSIONS,
                "EasyEmailConnectionTestInput",
            ),
            "EasyEmailConnectionHealth": (
                DOMAIN_MAIL_EXTENSIONS,
                "EasyEmailConnectionHealth",
            ),
            "ListNewsletterSubscriptionsResponse": (
                HTTP_MAIL_M7A_CONTRACTS,
                "ListNewsletterSubscriptionsHttpResponse",
            ),
            "UpdateNewsletterSubscriptionResponse": (
                HTTP_MAIL_M7A_CONTRACTS,
                "UpdateNewsletterSubscriptionHttpResponse",
            ),
            "GetEasyEmailSettingsResponse": (
                HTTP_MAIL_M7A_CONTRACTS,
                "GetEasyEmailSettingsHttpResponse",
            ),
            "UpdateEasyEmailSettingsResponse": (
                HTTP_MAIL_M7A_CONTRACTS,
                "UpdateEasyEmailSettingsHttpResponse",
            ),
            "TestEasyEmailConnectionResponse": (
                HTTP_MAIL_M7A_CONTRACTS,
                "TestEasyEmailConnectionHttpResponse",
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

    def test_m7a_operations_use_typed_responses_and_forbid_persisted_secrets(
        self,
    ) -> None:
        expected_responses = {
            "promoteMailboxSession": "PromoteMailboxResponse",
            "listNewsletterSubscriptions": "ListNewsletterSubscriptionsResponse",
            "setNewsletterSubscriptionHidden": "UpdateNewsletterSubscriptionResponse",
            "getEasyEmailSettings": "GetEasyEmailSettingsResponse",
            "updateEasyEmailSettings": "UpdateEasyEmailSettingsResponse",
            "testEasyEmailConnection": "TestEasyEmailConnectionResponse",
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

        settings_update = self.openapi["components"]["schemas"][
            "EasyEmailClientSettingsUpdateInput"
        ]
        forbidden_fields = {
            "password",
            "token",
            "apiToken",
            "authorizationCode",
            "secret",
        }
        self.assertTrue(forbidden_fields.isdisjoint(settings_update["properties"]))


if __name__ == "__main__":
    unittest.main()
