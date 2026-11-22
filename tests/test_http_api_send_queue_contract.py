import unittest

from tests.http_api_contract_support import (
    ACCOUNT_CONNECTIVITY,
    DOMAIN_ACCOUNT,
    DOMAIN_MAIL_SEND_QUEUE,
    HTTP_MAIL_SEND_QUEUE_CONTRACTS,
    HttpApiContractTestCase,
    extract_interface_fields,
    resolve_local_ref,
)


class HttpApiSendQueueContractTests(HttpApiContractTestCase):
    def test_m5_request_schemas_match_typescript_interface_fields(self) -> None:
        request_interfaces = {
            "MailAccountSmtpProfileInput": (
                DOMAIN_ACCOUNT,
                "MailAccountSmtpProfileInput",
            ),
            "MailAccountSmtpTestInput": (
                ACCOUNT_CONNECTIVITY,
                "MailAccountSmtpTestRequest",
            ),
            "MailSendEnqueueInput": (
                DOMAIN_MAIL_SEND_QUEUE,
                "MailSendEnqueueInput",
            ),
            "MailSendQueueRunBatchInput": (
                DOMAIN_MAIL_SEND_QUEUE,
                "MailSendQueueRunBatchInput",
            ),
            "MailSendQueueCancelInput": (
                DOMAIN_MAIL_SEND_QUEUE,
                "MailSendQueueCancelInput",
            ),
            "MailSendQueueRetryInput": (
                DOMAIN_MAIL_SEND_QUEUE,
                "MailSendQueueRetryInput",
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

    def test_m5_response_schemas_match_typescript_interface_fields(self) -> None:
        response_interfaces = {
            "MailAccountSmtpProfile": (
                DOMAIN_ACCOUNT,
                "MailAccountSmtpProfile",
            ),
            "MailSmtpConnectionTestResult": (
                ACCOUNT_CONNECTIVITY,
                "MailSmtpConnectionTestResult",
            ),
            "TestMailAccountSmtpResponse": (
                HTTP_MAIL_SEND_QUEUE_CONTRACTS,
                "TestMailAccountSmtpHttpResponse",
            ),
            "MailSendQueueItem": (
                DOMAIN_MAIL_SEND_QUEUE,
                "MailSendQueueItem",
            ),
            "MailSendEnqueueResult": (
                DOMAIN_MAIL_SEND_QUEUE,
                "MailSendEnqueueResult",
            ),
            "MailSendQueueWorkerRunResult": (
                DOMAIN_MAIL_SEND_QUEUE,
                "MailSendQueueWorkerRunResult",
            ),
            "MailSendQueueWorkerStatus": (
                DOMAIN_MAIL_SEND_QUEUE,
                "MailSendQueueWorkerStatus",
            ),
            "ListMailSendQueueResponse": (
                HTTP_MAIL_SEND_QUEUE_CONTRACTS,
                "ListMailSendQueueHttpResponse",
            ),
            "GetMailSendQueueItemResponse": (
                HTTP_MAIL_SEND_QUEUE_CONTRACTS,
                "GetMailSendQueueItemHttpResponse",
            ),
            "RunMailSendQueueItemResponse": (
                HTTP_MAIL_SEND_QUEUE_CONTRACTS,
                "RunMailSendQueueItemHttpResponse",
            ),
            "RunMailSendQueueWorkerResponse": (
                HTTP_MAIL_SEND_QUEUE_CONTRACTS,
                "RunMailSendQueueWorkerHttpResponse",
            ),
            "CancelMailSendQueueItemResponse": (
                HTTP_MAIL_SEND_QUEUE_CONTRACTS,
                "CancelMailSendQueueItemHttpResponse",
            ),
            "RetryMailSendQueueItemResponse": (
                HTTP_MAIL_SEND_QUEUE_CONTRACTS,
                "RetryMailSendQueueItemHttpResponse",
            ),
            "MailScheduledSendReopenResult": (
                DOMAIN_MAIL_SEND_QUEUE,
                "MailScheduledSendReopenResult",
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

    def test_m5_operations_use_typed_success_responses_and_reject_raw_secrets(
        self,
    ) -> None:
        expected_responses = {
            "testMailAccountSmtp": "TestMailAccountSmtpResponse",
            "listMailSendQueue": "ListMailSendQueueResponse",
            "enqueueMailSend": "EnqueueMailSendResponse",
            "getMailSendQueueItem": "GetMailSendQueueItemResponse",
            "runMailSendQueueItem": "RunMailSendQueueItemResponse",
            "cancelMailSendQueueItem": "CancelMailSendQueueItemResponse",
            "retryMailSendQueueItem": "RetryMailSendQueueItemResponse",
            "runMailSendQueueOnce": "RunMailSendQueueWorkerResponse",
            "runMailSendQueueDueBatch": "RunMailSendQueueWorkerResponse",
            "reopenScheduledSend": "ReopenScheduledSendResponse",
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

        enqueue_op = self.openapi["paths"]["/mail/send-queue"]["post"]
        header_params = [
            resolve_local_ref(self.openapi, param["$ref"])
            if "$ref" in param
            else param
            for param in enqueue_op.get("parameters", [])
        ]
        self.assertTrue(
            any(
                isinstance(param, dict)
                and param.get("in") == "header"
                and param.get("name") == "Idempotency-Key"
                for param in header_params
            )
        )

        forbidden_fields = {"password", "token", "authorizationCode", "secret"}
        for schema_name in (
            "MailAccountSmtpProfileInput",
            "MailAccountSmtpTestInput",
            "MailSendEnqueueInput",
        ):
            schema = self.openapi["components"]["schemas"][schema_name]
            self.assertTrue(
                forbidden_fields.isdisjoint(schema["properties"]), schema_name
            )
            self.assertFalse(schema.get("additionalProperties", True), schema_name)


if __name__ == "__main__":
    unittest.main()
