import unittest

from tests.http_api_contract_support import (
    DOMAIN_MAIL_AVATAR,
    HTTP_MAIL_M7C_CONTRACTS,
    HttpApiContractTestCase,
    extract_interface_fields,
)


class HttpApiAvatarContractTests(HttpApiContractTestCase):
    def test_m7c_avatar_request_and_response_schemas_match_typescript_interfaces(
        self,
    ) -> None:
        interfaces = {
            "MailAvatarSettings": (
                DOMAIN_MAIL_AVATAR,
                "MailAvatarSettings",
            ),
            "MailAvatarSettingsUpdateInput": (
                DOMAIN_MAIL_AVATAR,
                "MailAvatarSettingsUpdateInput",
            ),
            "MailAvatarAuthSignal": (
                DOMAIN_MAIL_AVATAR,
                "MailAvatarAuthSignal",
            ),
            "MailAvatarSenderAuth": (
                DOMAIN_MAIL_AVATAR,
                "MailAvatarSenderAuth",
            ),
            "MailSenderAvatar": (
                DOMAIN_MAIL_AVATAR,
                "MailSenderAvatar",
            ),
            "MailAvatarResolveInput": (
                DOMAIN_MAIL_AVATAR,
                "MailAvatarResolveInput",
            ),
            "MailContactAvatarSetInput": (
                DOMAIN_MAIL_AVATAR,
                "MailContactAvatarSetInput",
            ),
            "MailContactAvatarClearResult": (
                DOMAIN_MAIL_AVATAR,
                "MailContactAvatarClearResult",
            ),
            "MailAvatarClearCacheResult": (
                DOMAIN_MAIL_AVATAR,
                "MailAvatarClearCacheResult",
            ),
            "GetMailAvatarSettingsResponse": (
                HTTP_MAIL_M7C_CONTRACTS,
                "GetMailAvatarSettingsHttpResponse",
            ),
            "UpdateMailAvatarSettingsResponse": (
                HTTP_MAIL_M7C_CONTRACTS,
                "UpdateMailAvatarSettingsHttpResponse",
            ),
            "ResolveMailSenderAvatarsResponse": (
                HTTP_MAIL_M7C_CONTRACTS,
                "ResolveMailSenderAvatarsHttpResponse",
            ),
            "SetMailContactAvatarResponse": (
                HTTP_MAIL_M7C_CONTRACTS,
                "SetMailContactAvatarHttpResponse",
            ),
            "ClearMailContactAvatarResponse": (
                HTTP_MAIL_M7C_CONTRACTS,
                "ClearMailContactAvatarHttpResponse",
            ),
            "ClearMailAvatarCacheResponse": (
                HTTP_MAIL_M7C_CONTRACTS,
                "ClearMailAvatarCacheHttpResponse",
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

    def test_m7c_avatar_operations_use_typed_responses(self) -> None:
        expected_responses = {
            "getMailAvatarSettings": "GetMailAvatarSettingsResponse",
            "updateMailAvatarSettings": "UpdateMailAvatarSettingsResponse",
            "resolveMailSenderAvatars": "ResolveMailSenderAvatarsResponse",
            "setMailContactAvatar": "SetMailContactAvatarResponse",
            "clearMailContactAvatar": "ClearMailContactAvatarResponse",
            "clearMailAvatarCache": "ClearMailAvatarCacheResponse",
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
