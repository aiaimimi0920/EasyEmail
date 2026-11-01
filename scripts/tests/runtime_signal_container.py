"""Verify real Linux signals and final file persistence in owned local containers."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import time
import uuid

REPO = Path(__file__).resolve().parents[2]
TEMP_ROOT = Path("C:/Users/Public/nas_home/AI/GameEditor/linshi").resolve()


def docker(*args, timeout=70):
    result = subprocess.run(["docker", *map(str, args)], capture_output=True, encoding="utf-8", timeout=timeout)
    if result.returncode:
        raise RuntimeError(f"docker_{args[0]}_failed: {result.stderr[-2000:]}")
    return result.stdout.strip()


def request(container, path, body=None):
    code = """
const [path, input] = process.argv.slice(1);
const response = await fetch('http://127.0.0.1:8080' + path, {
  method: input ? 'POST' : 'GET', signal: AbortSignal.timeout(2000),
  headers: {authorization: 'Bearer local-signal-test', 'content-type': 'application/json'},
  ...(input ? {body: input} : {}),
});
const payload = await response.json();
if (response.status !== 200) throw new Error('fixture_http_' + response.status);
console.log(JSON.stringify(payload));
"""
    return json.loads(docker("exec", container, "node", "--input-type=module", "-e", code,
                             path, json.dumps(body) if body is not None else "", timeout=8))


def wait_ready(container):
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        try:
            request(container, "/mail/catalog")
            return
        except (RuntimeError, subprocess.TimeoutExpired):
            time.sleep(0.2)
    raise RuntimeError("fixture_readiness_timeout: " + docker("logs", container)[-2000:])


def seed_case(directory, driver):
    state_dir = directory / "state"
    state_dir.mkdir(parents=True)
    snapshot = {name: [] for name in (
        "providerTypes", "runtimeTemplates", "instances", "bindings", "strategies",
        "credentialSets", "credentialBindings", "sessions", "messages",
    )}
    snapshot["sessions"] = [{
        "id": "signal-test-session", "hostId": "local-test", "providerTypeKey": "duckmail",
        "providerInstanceId": "local-synthetic-provider", "emailAddress": "test@example.invalid",
        "mailboxRef": "synthetic", "status": "open", "createdAt": "2026-10-25T00:00:00Z",
        "expiresAt": "2999-01-01T00:00:00Z", "metadata": {},
    }]
    (state_dir / "snapshot.json").write_text(json.dumps(snapshot), encoding="utf-8")
    config = {
        "server": {"host": "127.0.0.1", "port": 8080, "apiKey": "local-signal-test"},
        "maintenance": {"enabled": False}, "providers": {"enabledProviders": []},
        "persistence": {"enabled": True, "driver": driver, "intervalMs": 3_600_000,
                        "filePath": "/test/state/snapshot.json", "databasePath": "/test/state/snapshot.sqlite"},
    }
    (directory / "config.json").write_text(json.dumps(config), encoding="utf-8")


def run_case(args, mode, sig, driver, result):
    run_id = uuid.uuid4().hex
    directory = args.output.parent / f"signal-{driver}-{mode}-{sig}-{run_id[:8]}"
    seed_case(directory, driver)
    name = f"easyemail-signal-{run_id[:16]}"
    command = ["create", "--name", name, "--network", "none", "--label",
               f"io.easyemail.test.run={run_id}", "--stop-timeout", "60",
               "--env", "EASY_EMAIL_CONFIG_PATH=/test/config.json",
               "--env", "EASY_EMAIL_RUNTIME_ENV_PATH=/test/runtime.env",
               "--env", "EASY_EMAIL_BOOTSTRAP_PATH=/test/no-bootstrap.json",
               "--env", "EASY_EMAIL_STATE_DIR=/test/state",
               "--env", "EASY_EMAIL_RESET_STORE_ON_BOOT=false"]
    if not args.image_code:
        command += ["--mount", f"type=bind,source={args.build_root.as_posix()},target=/app/dist,readonly",
                    "--mount", f"type=bind,source={(REPO / 'service/base/node_modules').as_posix()},target=/app/node_modules,readonly",
                    "--mount", f"type=bind,source={(REPO / 'deploy/service/base/docker-entrypoint.sh').as_posix()},target=/usr/local/bin/docker-entrypoint.sh,readonly"]
    program = ["node", "dist/src/runtime/main.js"] if mode == "direct" else ["/bin/sh", "/usr/local/bin/docker-entrypoint.sh"]
    if driver == "sqlite":
        bootstrap = ("if [ ! -f /test/state/snapshot.sqlite ]; then "
                     "python /app/ops/scripts/sqlite_state_store.py save /test/state/snapshot.sqlite "
                     "</test/state/snapshot.json >/dev/null; fi; exec " + shlex.join(program))
        command += ["--entrypoint", "/bin/sh", args.image, "-eu", "-c", bootstrap]
    else:
        command += ["--entrypoint", program[0], args.image, *program[1:]]
    container = None
    row = {"mode": mode, "signal": sig, "driver": driver, "rootSupervisor": args.image_code and mode == "supervisor"}
    result["cases"].append(row)
    try:
        container = docker(*command)
        # SQLite locks must stay on native Linux storage, not a Windows/SMB bind mount.
        docker("cp", str(directory) + "/.", container + ":/test")
        docker("start", container)
        wait_ready(container)
        message = request(container, "/mail/messages/observe", {
            "sessionId": "signal-test-session", "subject": f"shutdown-{sig}",
            "textBody": "仅用于本地信号测试", "sender": "fixture@example.invalid",
        })["message"]
        if driver == "sqlite":
            before = json.loads(docker("exec", container, "python", "/app/ops/scripts/sqlite_state_store.py",
                                       "load", "/test/state/snapshot.sqlite"))
        else:
            before = json.loads(docker("exec", container, "node", "-e",
                                       "console.log(require('node:fs').readFileSync('/test/state/snapshot.json','utf8'))"))
        if before["messages"]:
            raise RuntimeError("fixture_was_flushed_before_signal")
        row["notFlushedBeforeSignal"] = True
        started = time.monotonic()
        docker("kill", "--signal", sig, container)
        row["exitCode"] = int(docker("wait", container, timeout=55))
        row["stopSeconds"] = round(time.monotonic() - started, 3)
        if driver == "sqlite":
            path = directory / "after-signal.sqlite"
            docker("cp", container + ":/test/state/snapshot.sqlite", path)
            loaded = subprocess.run([sys.executable, "-B", str(REPO / "service/base/src/persistence/helpers/sqlite_state_store.py"),
                                     "load", str(path)], capture_output=True, encoding="utf-8", check=True,
                                    env={**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"})
            after = json.loads(loaded.stdout)
        else:
            path = directory / "after-signal.json"
            docker("cp", container + ":/test/state/snapshot.json", path)
            after = json.loads(path.read_text(encoding="utf-8"))
        row["lastWritePersisted"] = any(item["id"] == message["id"] for item in after["messages"])
        if row["exitCode"] != 0 or not row["lastWritePersisted"]:
            raise RuntimeError("signal_did_not_gracefully_persist_last_write")
        docker("start", container)
        wait_ready(container)
        restored = request(container, "/mail/query/observed-messages?sessionId=signal-test-session")["messages"]
        row["restartRestored"] = any(item["id"] == message["id"] and item.get("textBody") == "仅用于本地信号测试" for item in restored)
        if not row["restartRestored"]:
            raise RuntimeError("restart_did_not_restore_last_write")
        docker("stop", "--time", "60", container)
        row["dockerStopExitCode"] = int(docker("inspect", container, "--format", "{{.State.ExitCode}}"))
        if row["dockerStopExitCode"] != 0:
            raise RuntimeError("docker_stop_was_not_graceful")
        row["passed"] = True
    except Exception as error:
        row["passed"] = False
        row["error"] = str(error)
        raise
    finally:
        if container:
            owner = docker("inspect", container, "--format", '{{index .Config.Labels "io.easyemail.test.run"}}')
            if owner != run_id:
                raise RuntimeError("refusing_to_remove_unowned_container")
            docker("rm", "--force", container)
        args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", default="easyemail/easy-email-service:nas-20260907-002")
    parser.add_argument("--build-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--modes", nargs="+", choices=("direct", "supervisor"), default=["direct", "supervisor"])
    parser.add_argument("--signals", nargs="+", choices=("TERM", "INT"), default=["TERM", "INT"])
    parser.add_argument("--drivers", nargs="+", choices=("file", "sqlite"), default=["file"])
    parser.add_argument("--image-code", action="store_true")
    args = parser.parse_args()
    args.output = args.output.resolve()
    args.build_root = args.build_root.resolve()
    if not args.output.is_relative_to(TEMP_ROOT) or not args.build_root.is_relative_to(TEMP_ROOT):
        raise RuntimeError("test_paths_must_be_under_linshi")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    if "sqlite" in args.drivers and not args.image_code:
        raise RuntimeError("sqlite_signal_tests_require_a_packaged_image")
    if docker("context", "show") != "desktop-linux":
        raise RuntimeError("requires_local_docker_desktop_context")
    if docker("info", "--format", "{{.Name}}") != "docker-desktop":
        raise RuntimeError("requires_local_docker_desktop_engine")
    result = {"localDockerDesktop": True, "network": "none", "image": args.image,
              "dataStorage": "owned-container-overlay", "cases": []}
    for mode in args.modes:
        for sig in args.signals:
            for driver in args.drivers:
                run_case(args, mode, sig, driver, result)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
