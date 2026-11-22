from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import time
import unittest

ENTRYPOINT = Path(__file__).resolve().parents[2] / "deploy/service/base/docker-entrypoint.sh"
FIXTURE = Path(__file__).parent / "fixtures/entrypoint-process.py"


@unittest.skipUnless(os.name == "posix", "requires real POSIX process signals")
class EntrypointSignalTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="easyemail-entrypoint-"))
        self.bin = self.root / "bin"
        self.bin.mkdir()
        for name in ("node", "python", "sleep", "id"):
            target = self.bin / name
            shutil.copyfile(FIXTURE, target)
            target.chmod(0o700)
        (self.root / "config.yaml").write_text("{}\n", encoding="utf-8")
        (self.root / "bootstrap.json").write_text("{}\n", encoding="utf-8")
        self.process = None

    def processes(self, kind=None):
        rows = [json.loads(path.read_text(encoding="utf-8")) for path in self.root.glob("process-*.json")]
        return [row["pid"] for row in rows if kind is None or row["kind"] == kind]

    def wait_for(self, predicate, timeout=5):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return
            time.sleep(0.02)
        self.fail("fixture condition did not become true before deadline")

    def start(self, wait_runtime=True, **extra):
        env = {
            **os.environ, "PATH": str(self.bin) + os.pathsep + os.environ["PATH"],
            "FIXTURE_ROOT": str(self.root),
            "EASY_EMAIL_CONFIG_PATH": str(self.root / "config.yaml"),
            "EASY_EMAIL_STATE_DIR": str(self.root / "state"),
            "EASY_EMAIL_RUNTIME_ENV_PATH": str(self.root / "runtime.env"),
            "EASY_EMAIL_BOOTSTRAP_PATH": str(self.root / "bootstrap.json"),
            "EASY_EMAIL_IMPORT_SYNC_FLAG_PATH": str(self.root / "restart.flag"),
            "EASY_EMAIL_RESET_STORE_ON_BOOT": "false", **extra,
        }
        self.process = subprocess.Popen(["/bin/sh", str(ENTRYPOINT)], env=env,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        if wait_runtime:
            self.wait_for(lambda: len(list(self.root.glob("ready-*"))) >= 1)

    @staticmethod
    def alive(pid):
        try:
            os.kill(pid, 0)
            return True
        except ProcessLookupError:
            return False

    def assert_drained(self):
        self.wait_for(lambda: all(not self.alive(pid) for pid in self.processes()))
        nodes = self.processes("node")
        self.assertTrue(nodes)
        for pid in nodes:
            self.assertTrue((self.root / f"closed-{pid}").exists())

    def stop(self, signum):
        self.process.send_signal(signum)
        output, errors = self.process.communicate(timeout=5)
        self.assertEqual(self.process.returncode, 0, (output, errors))
        self.assert_drained()

    def tearDown(self):
        # Only fixture-owned PIDs are eligible for cleanup inside the isolated container.
        if self.process and self.process.poll() is None:
            self.process.kill()
            self.process.communicate(timeout=5)
        for pid in reversed(self.processes()):
            if self.alive(pid):
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        shutil.rmtree(self.root)

    def test_term_drains_app_and_sleep_child(self):
        self.start()
        self.wait_for(lambda: bool(self.processes("sleep")))
        self.stop(signal.SIGTERM)
        for pid in self.processes("node"):
            self.assertEqual((self.root / f"signal-{pid}").read_text(), "SIGTERM")

    def test_term_during_bootstrap_reaps_the_startup_child_without_starting_app(self):
        (self.root / "config.yaml").unlink()
        self.start(wait_runtime=False)
        self.wait_for(lambda: (self.root / "sync-running").exists())
        self.process.send_signal(signal.SIGTERM)
        self.process.communicate(timeout=5)
        self.assertEqual(self.process.returncode, 0)
        self.assertFalse(self.processes("node"))
        self.wait_for(lambda: all(not self.alive(pid) for pid in self.processes()))

    def test_int_is_forwarded_to_app(self):
        self.start()
        self.stop(signal.SIGINT)
        for pid in self.processes("node"):
            self.assertEqual((self.root / f"signal-{pid}").read_text(), "SIGINT")

    def test_term_drains_inflight_sync_python(self):
        self.start(FIXTURE_SYNC_INTERVAL="0.05")
        self.wait_for(lambda: (self.root / "sync-running").exists())
        self.stop(signal.SIGTERM)

    def test_sync_flag_restarts_once_then_external_stop_wins(self):
        self.start(FIXTURE_SYNC_INTERVAL="0.05", FIXTURE_SYNC_MODE="restart")
        self.wait_for(lambda: len(list(self.root.glob("ready-*"))) == 2)
        (self.root / "restart.flag").touch()
        self.stop(signal.SIGTERM)
        self.assertEqual(len(self.processes("node")), 2)

    def test_stop_does_not_restart_when_a_sync_flag_already_exists(self):
        self.start()
        (self.root / "restart.flag").touch()
        self.stop(signal.SIGTERM)
        self.assertEqual(len(self.processes("node")), 1)

    def test_child_exit_preserves_status_and_cleans_sync_children(self):
        self.start(FIXTURE_APP_EXIT_CODE="7")
        self.process.communicate(timeout=5)
        self.assertEqual(self.process.returncode, 7)
        self.wait_for(lambda: all(not self.alive(pid) for pid in self.processes()))


if __name__ == "__main__":
    unittest.main()
