from __future__ import annotations

import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SERVER_CONTRACTS = ROOT / "service" / "base" / "src" / "http" / "contracts.ts"
CLIENT_SOURCE = ROOT / "clients" / "typescript" / "src" / "http-client.ts"

STATIC_ROUTE_NAMES = (
    "catalog",
    "snapshot",
    "queryObservedMessages",
    "planMailbox",
    "openMailbox",
    "sendMailboxMessage",
    "updateMailboxSession",
    "releaseMailbox",
    "recoverMailboxByEmail",
    "recoverMailboxCapacity",
    "reportMailboxOutcome",
    "observeMessage",
)


def extract_static_routes(text: str) -> dict[str, str]:
    return {
        name: value
        for name, value in re.findall(r'^\s{2}(\w+):\s+"([^"]+)",\s*$', text, re.MULTILINE)
    }


class ClientServerContractTests(unittest.TestCase):
    def test_client_static_routes_match_server_contract(self) -> None:
        server_routes = extract_static_routes(SERVER_CONTRACTS.read_text(encoding="utf-8"))
        client_routes = extract_static_routes(CLIENT_SOURCE.read_text(encoding="utf-8"))

        for name in STATIC_ROUTE_NAMES:
            self.assertIn(name, server_routes)
            self.assertIn(name, client_routes)
            self.assertEqual(client_routes[name], server_routes[name], name)

    def test_dynamic_route_templates_remain_aligned(self) -> None:
        server_text = SERVER_CONTRACTS.read_text(encoding="utf-8")
        client_text = CLIENT_SOURCE.read_text(encoding="utf-8")
        templates = (
            "/mail/mailboxes/${encodeURIComponent(sessionId)}/code",
            "/mail/mailboxes/${encodeURIComponent(sessionId)}/auth-link",
            "/mail/query/observed-messages/${encodeURIComponent(messageId)}",
        )
        for template in templates:
            self.assertIn(template, server_text)
            self.assertIn(template, client_text)


if __name__ == "__main__":
    unittest.main()
