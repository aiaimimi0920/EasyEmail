import unittest

from tests.http_api_contract_support import (
    DOMAIN_MAIL_AGENT,
    HTTP_MAIL_M7B_CONTRACTS,
    HttpApiContractTestCase,
    extract_interface_fields,
)


class HttpApiAgentMailContractTests(HttpApiContractTestCase):
    def test_m7b_request_and_response_schemas_match_typescript_interfaces(self) -> None:
        interfaces = {
            "MailAgentAccountCreateInput": (
                DOMAIN_MAIL_AGENT,
                "MailAgentAccountCreateInput",
            ),
            "MailAgentServiceRecord": (
                DOMAIN_MAIL_AGENT,
                "MailAgentServiceRecord",
            ),
            "MailAgentServiceCreateInput": (
                DOMAIN_MAIL_AGENT,
                "MailAgentServiceCreateInput",
            ),
            "MailAgentThread": (
                DOMAIN_MAIL_AGENT,
                "MailAgentThread",
            ),
            "MailAgentMessage": (
                DOMAIN_MAIL_AGENT,
                "MailAgentMessage",
            ),
            "MailAgentThreadDetail": (
                DOMAIN_MAIL_AGENT,
                "MailAgentThreadDetail",
            ),
            "MailAgentTaskSendInput": (
                DOMAIN_MAIL_AGENT,
                "MailAgentTaskSendInput",
            ),
            "MailAgentTaskSendResult": (
                DOMAIN_MAIL_AGENT,
                "MailAgentTaskSendResult",
            ),
            "CreateAgentMailAccountResponse": (
                HTTP_MAIL_M7B_CONTRACTS,
                "CreateAgentMailAccountHttpResponse",
            ),
            "ListAgentMailAccountsResponse": (
                HTTP_MAIL_M7B_CONTRACTS,
                "ListAgentMailAccountsHttpResponse",
            ),
            "CreateAgentMailServiceResponse": (
                HTTP_MAIL_M7B_CONTRACTS,
                "CreateAgentMailServiceHttpResponse",
            ),
            "ListAgentMailServicesResponse": (
                HTTP_MAIL_M7B_CONTRACTS,
                "ListAgentMailServicesHttpResponse",
            ),
            "ListAgentMailThreadsResponse": (
                HTTP_MAIL_M7B_CONTRACTS,
                "ListAgentMailThreadsHttpResponse",
            ),
            "GetAgentMailThreadDetailResponse": (
                HTTP_MAIL_M7B_CONTRACTS,
                "GetAgentMailThreadDetailHttpResponse",
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

    def test_m7b_operations_use_typed_responses_and_forbid_cleartext_secrets(
        self,
    ) -> None:
        expected_responses = {
            "listAgentMailAccounts": "ListAgentMailAccountsResponse",
            "createAgentMailAccount": "CreateAgentMailAccountResponse",
            "listAgentMailServices": "ListAgentMailServicesResponse",
            "createAgentMailService": "CreateAgentMailServiceResponse",
            "sendAgentMailTask": "SendAgentMailTaskResponse",
            "listAgentMailThreads": "ListAgentMailThreadsResponse",
            "getAgentMailThreadDetail": "GetAgentMailThreadDetailResponse",
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

        agent_account_create = self.openapi["components"]["schemas"][
            "MailAgentAccountCreateInput"
        ]
        forbidden_fields = {
            "password",
            "token",
            "apiToken",
            "authorizationCode",
            "secret",
        }
        self.assertTrue(
            forbidden_fields.isdisjoint(agent_account_create["properties"])
        )


if __name__ == "__main__":
    unittest.main()
