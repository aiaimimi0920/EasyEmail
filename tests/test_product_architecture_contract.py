from __future__ import annotations

import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PRODUCT_CONTRACT = ROOT / "product-contract.json"
USERSCRIPT = ROOT / "runtimes" / "userscript" / "easy_email_proxy.user.js"
DESKTOP = ROOT / "apps" / "desktop"


class ProductArchitectureContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.contract = json.loads(PRODUCT_CONTRACT.read_text(encoding="utf-8"))

    def test_standalone_server_is_documented_http_not_sdk_contract(self) -> None:
        server = self.contract["products"]["standaloneServer"]
        client = self.contract["compatibility"]["typescriptClient"]

        self.assertEqual(self.contract["core"]["publicInterface"], "http")
        self.assertEqual(server["callers"], "any-http-client")
        self.assertFalse(server["requiresPublishedSdk"])
        self.assertFalse(client["required"])
        self.assertFalse(client["authoritativeApiContract"])

    def test_bundled_ui_owns_the_packaged_core_lifecycle(self) -> None:
        ui = self.contract["products"]["bundledUi"]

        self.assertEqual(ui["core"], "service-base")
        self.assertEqual(ui["path"], "apps/desktop")
        self.assertEqual(ui["framework"], "tauri-2-react-19")
        self.assertEqual(ui["implementationStatus"], "source-imported-migration-in-progress")
        self.assertEqual(
            ui["releaseStatus"],
            "blocked-until-http-ownership-and-sidecar-gates-pass",
        )
        self.assertTrue(ui["bundlesCore"])
        self.assertTrue(ui["startsCoreAutomatically"])
        self.assertEqual(ui["transport"], "loopback-http")
        self.assertEqual(ui["lifecycleOwner"], "ui-host")
        self.assertFalse(ui["requiresDocker"])
        self.assertFalse(ui["requiresExternalNode"])
        self.assertTrue((DESKTOP / "package.json").is_file())
        self.assertTrue((DESKTOP / "src-tauri" / "Cargo.toml").is_file())
        self.assertTrue((DESKTOP / "SOURCE_SNAPSHOT.json").is_file())

    def test_userscript_remains_an_independent_direct_provider_runtime(self) -> None:
        userscript = self.contract["products"]["userscript"]
        source = USERSCRIPT.read_text(encoding="utf-8")

        self.assertEqual(userscript["implementation"], "independent-direct-provider-runtime")
        self.assertFalse(userscript["dependsOnServiceBase"])
        self.assertFalse(userscript["usesServiceBaseHttpApi"])
        self.assertFalse(userscript["sharesBusinessImplementationWithServiceBase"])
        self.assertNotIn("/mail/mailboxes/open", source)
        self.assertNotIn("127.0.0.1:18081", source)


if __name__ == "__main__":
    unittest.main()
