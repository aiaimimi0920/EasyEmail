from __future__ import annotations

import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DESKTOP = ROOT / "apps" / "desktop"


class DesktopBundledCoreContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.package = json.loads((DESKTOP / "package.json").read_text(encoding="utf-8"))
        cls.tauri = json.loads(
            (DESKTOP / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8")
        )
        cls.host = (DESKTOP / "src-tauri" / "src" / "core_runtime.rs").read_text(
            encoding="utf-8"
        )
        cls.host_process = (
            DESKTOP / "src-tauri" / "src" / "core_runtime_process.rs"
        ).read_text(encoding="utf-8")
        cls.credential_broker = "\n".join(
            (DESKTOP / "src-tauri" / "src" / name).read_text(encoding="utf-8")
            for name in ("credential_broker.rs", "credential_broker_http.rs")
        )
        cls.desktop_credentials = (
            DESKTOP / "src-tauri" / "src" / "desktop_credentials.rs"
        ).read_text(encoding="utf-8")
        cls.app = (DESKTOP / "src" / "App.tsx").read_text(encoding="utf-8")
        cls.app_runtime = (DESKTOP / "src" / "app" / "appRuntime.ts").read_text(
            encoding="utf-8"
        )
        cls.initial_data_controller = (
            DESKTOP / "src" / "app" / "useInitialDataController.tsx"
        ).read_text(encoding="utf-8")
        cls.bundled_client = (
            DESKTOP / "src" / "api" / "bundledCoreClient.ts"
        ).read_text(encoding="utf-8")
        cls.core_verify_files = tuple(
            (DESKTOP / "scripts" / name).read_text(encoding="utf-8")
            for name in ("verify-core-bundle.mjs", "verify-core-bundle-domains.mjs")
        )
        cls.core_verify = "\n".join(cls.core_verify_files)
        cls.host_smoke = (
            DESKTOP / "scripts" / "verify-desktop-host-smoke.ps1"
        ).read_text(encoding="utf-8")
        cls.host_lifecycle_guard = (
            DESKTOP / "src-tauri" / "src" / "host_lifecycle_guard.rs"
        ).read_text(encoding="utf-8")
        cls.webview_security = (
            DESKTOP / "src-tauri" / "src" / "webview_security.rs"
        ).read_text(encoding="utf-8")
        cls.service_bundled_control = (
            ROOT / "service" / "base" / "src" / "runtime" / "bundled-child-control.ts"
        ).read_text(encoding="utf-8")

    def test_build_packages_the_same_service_base_core(self) -> None:
        scripts = self.package["scripts"]
        self.assertIn("../../service/base", scripts["core:build"])
        self.assertIn("bundle-core-runtime.mjs", scripts["core:bundle"])
        self.assertIn("verify-core-bundle.mjs", scripts["core:verify"])
        self.assertIn("npm run core:bundle", self.tauri["build"]["beforeBuildCommand"])
        self.assertEqual(self.tauri["bundle"]["resources"], {"resources/core/": "core/"})
        self.assertTrue(
            (DESKTOP / "src-tauri" / "resources" / "core" / ".gitkeep").is_file()
        )
        bundle_script = (
            DESKTOP / "scripts" / "bundle-core-runtime.mjs"
        ).read_text(encoding="utf-8")
        self.assertIn('writeFileSync(join(outputRoot, ".gitkeep")', bundle_script)
        self.assertIn('"ci", "--omit=dev", "--ignore-scripts"', bundle_script)
        self.assertIn('"node_modules", "imapflow"', bundle_script)

    def test_host_uses_authenticated_loopback_and_owns_exact_child(self) -> None:
        for expected in (
            'TcpListener::bind(("127.0.0.1", 0))',
            'format!("Bearer {api_token}")',
            'format!("{base_url}/mail/catalog")',
        ):
            self.assertIn(expected, self.host_process)
        self.assertIn('format!("http://127.0.0.1:{port}")', self.host)
        for expected in (
            "process.kill()",
            "process.wait()",
        ):
            self.assertIn(expected, self.host)
        self.assertNotIn("taskkill", (self.host + self.host_process).lower())

    def test_host_injects_a_separate_scoped_credential_broker(self) -> None:
        for expected in (
            "DesktopCredentialBroker::start(&base_url, &api_token)",
            "credential_broker: Mutex<Option<DesktopCredentialBroker>>",
            "self.stop_credential_broker()",
        ):
            self.assertIn(expected, self.host)
        for expected in (
            '"EASY_EMAIL_DESKTOP_CREDENTIAL_BROKER_URL"',
            '"EASY_EMAIL_DESKTOP_CREDENTIAL_BROKER_TOKEN"',
        ):
            self.assertIn(expected, self.host_process)
        for expected in (
            'TcpListener::bind(("127.0.0.1", 0))',
            'const RESOLVE_PATH: &str = "/v1/credentials/resolve"',
            '("imap-test" | "imap-sync" | "imap-action", "imap_password")',
            '("smtp-test" | "smtp-send", "smtp_password")',
            'credential.owner_account_id == request.account_id',
            "Cache-Control: no-store",
        ):
            self.assertIn(expected, self.credential_broker)
        self.assertIn('const DESKTOP_CREDENTIAL_REF_PREFIX: &str = "ref:v1:desktop/"', self.desktop_credentials)
        self.assertIn(
            '!matches!(credential_kind.as_str(), "imap_password" | "smtp_password")',
            self.desktop_credentials,
        )
        self.assertIn('auth_method != "password"', self.desktop_credentials)
        self.assertIn("-OwningProcess $process.Id", self.host_smoke)
        self.assertIn("/v1/credentials/resolve", self.host_smoke)
        self.assertIn("BROKER_UNAUTHENTICATED_STATUS=401", self.host_smoke)

    def test_host_smoke_restarts_the_same_isolated_runtime(self) -> None:
        for expected in (
            "function Start-IsolatedDesktopRuntime",
            "function Stop-IsolatedDesktopRuntime",
            "[int]$StartupTimeoutSeconds = 55",
            ".AddSeconds($StartupTimeoutSeconds)",
            "$restartedRuntime = Start-IsolatedDesktopRuntime -Executable $executable",
            "$restartedHostId -ne $firstHostId",
            "LEGACY_DESKTOP_DB_ABSENT=True",
            "CORE_RELATIONAL_DB_BYTES=",
            "RESTART_HOST_ID_STABLE=True",
            "RESTART_CORE_STATE_PERSISTED=True",
            "RESTART_AUTH_BOUNDARIES=True",
            "RESTART_NORMAL_CLOSE=True",
            "RESTART_CORE_EXITED_WITH_UI=True",
        ):
            self.assertIn(expected, self.host_smoke)

    def test_packaged_core_verify_opens_fake_provider_behind_auth(self) -> None:
        for expected in (
            'createHttpServer',
            'server.listen(0, "127.0.0.1"',
            'strictProviderMode: true',
            'providerTypeKey: "cloudflare_temp_email"',
            '/mail/mailboxes/open',
            'authorization: `Bearer ${apiToken}`',
            'unauthorizedOpen.status !== 401',
            'request.url === "/health_check"',
            'request.url === "/open_api/settings"',
            'fakeProvider.healthProbeCount() < 1',
            'fakeProvider.settingsProbeCount() < 1',
            'totalRequestsBeforeUnauthorizedOpen',
            'fakeProvider.totalRequestCount() !== totalRequestsBeforeUnauthorizedOpen',
            'acceptedRequestsBeforeAuthenticatedOpen !== 0',
            'fakeProvider.acceptedRequestCount() !== acceptedRequestsBeforeAuthenticatedOpen + 1',
            'stdio: ["ignore", "pipe", "pipe"]',
            'const sensitiveValues = [apiToken, fakeProviderAuth, fakeMailboxToken, fakeAccountSecret]',
            'credentialLeakDetected ||= sensitiveValues.some',
            'host: "imap.example.test"',
            '/mail/accounts/imap/test',
            'credentialRefId: imapCredentialRef.id',
            'imapTest.status !== 503',
            'imapTestPayload?.code !== "ACCOUNT_CREDENTIAL_UNAVAILABLE"',
            'initialSyncStatusPayload?.status?.syncState !== "never_synced"',
            'imapSyncWithoutBroker.status !== 503',
            'coreOutputTail = output.slice(-credentialScanTailLength)',
            'child.exitCode !== null || child.signalCode !== null',
            'childClosed = new Promise((resolveClose) => child.once("close", resolveClose))',
            'if (childClosed)',
            'if (credentialLeakDetected)',
            'server.closeAllConnections()',
            'manifest.platform !== process.platform',
            'manifest.architecture !== process.arch',
            '!statSync(runtime).isFile()',
            '!statSync(entry).isFile()',
        ):
            self.assertIn(expected, self.core_verify)
        for verify_source in self.core_verify_files:
            self.assertIsNone(
                re.search(
                    r"console\.log\([\s\S]*?(?:apiToken|fakeProviderAuth|fakeMailboxToken)",
                    verify_source,
                )
            )

    def test_react_startup_uses_canonical_http_not_legacy_health(self) -> None:
        self.assertIn("createBundledCoreClient(invoke)", self.app_runtime)
        self.assertIn("bundledCoreClient.getCatalog()", self.initial_data_controller)
        self.assertNotIn(
            "appClient.getHealth()",
            self.app + self.app_runtime + self.initial_data_controller,
        )
        self.assertIn("createDesktopCoreClient", self.bundled_client)
        self.assertIn("createEasyEmailHttpClient", self.bundled_client)
        self.assertIn("bearerToken: runtime.api_token", self.bundled_client)

    def test_m9_graceful_control_channel_listener_ownership_and_webview_hardening(self) -> None:
        for expected in (
            '"EASY_EMAIL_BUNDLED_CHILD_MODE"',
            '"EASY_EMAIL_BUNDLED_CONTROL_TOKEN"',
            '"EASY_EMAIL_BUNDLED_INSTANCE_NONCE"',
            '"x-easyemail-bundled-nonce"',
            "owning_pid_for_loopback_ipv4_port(port)",
            "Stdio::piped()",
            '"command": "shutdown"',
        ):
            self.assertIn(expected, self.host_process)
        for expected in (
            "EASY_EMAIL_BUNDLED_CHILD_MODE",
            "protocolVersion",
            'record.command !== "shutdown"',
            'triggerShutdown("parent_eof")',
        ):
            self.assertIn(expected, self.service_bundled_control)
        for expected in (
            "HostInstanceLock",
            "CrashLoopGuard",
            "sweep_stale_runtime_artifacts",
            "BundledCoreChildLease",
        ):
            self.assertIn(expected, self.host_lifecycle_guard)
        for expected in (
            "is_allowed_webview_navigation",
            '"tauri.localhost"',
            "about",
        ):
            self.assertIn(expected, self.webview_security)
        csp = self.tauri["app"]["security"]["csp"]
        self.assertIn("worker-src 'self'", csp)
        self.assertIn("media-src 'none'", csp)
        self.assertIn("manifest-src 'self'", csp)
        for expected in (
            "GRACEFUL_SHUTDOWN_VERIFIED=True",
            "SINGLE_INSTANCE_GUARD_VERIFIED=True",
            "UI_CRASH_EOF_CHILD_EXITED=True",
            "FORCED_TIMEOUT_EXACT_CHILD_REAPED=True",
            "STANDALONE_SERVER_SURVIVED=True",
            "OVERSIZED_PAYLOAD_STATUS=413",
        ):
            self.assertIn(expected, self.host_smoke)


if __name__ == "__main__":
    unittest.main()
