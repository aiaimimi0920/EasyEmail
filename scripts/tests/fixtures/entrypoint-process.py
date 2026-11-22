#!/usr/bin/python3
"""Linux child-process fixtures for the entrypoint supervisor contract."""
import json
import os
from pathlib import Path
import signal
import sys
import time

root = Path(os.environ["FIXTURE_ROOT"])
kind = Path(sys.argv[0]).name
record = root / f"process-{os.getpid()}.json"
temporary = record.with_suffix(".tmp")
temporary.write_text(json.dumps({"kind": kind, "pid": os.getpid()}), encoding="utf-8")
os.replace(temporary, record)

if kind == "id":
    print("10001")
elif kind == "sleep":
    time.sleep(float(sys.argv[1]))
elif kind == "python":
    if sys.argv[1] == "-":
        print(os.environ.get("FIXTURE_SYNC_ENABLED", "true"))
        print(os.environ.get("FIXTURE_SYNC_INTERVAL", "60"))
    else:
        (root / "sync-running").write_text(str(os.getpid()), encoding="utf-8")
        restarted = root / "restart-requested"
        if os.environ.get("FIXTURE_SYNC_MODE") == "restart" and not restarted.exists():
            restarted.touch()
            Path(os.environ["EASY_EMAIL_IMPORT_SYNC_FLAG_PATH"]).touch()
        else:
            time.sleep(60)
elif kind == "node":
    def close(signum, _frame):
        (root / f"signal-{os.getpid()}").write_text(signal.Signals(signum).name, encoding="utf-8")
        time.sleep(0.2)
        (root / f"closed-{os.getpid()}").touch()
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, close)
    signal.signal(signal.SIGINT, close)
    (root / f"ready-{os.getpid()}").touch()
    if os.environ.get("FIXTURE_APP_EXIT_CODE"):
        raise SystemExit(int(os.environ["FIXTURE_APP_EXIT_CODE"]))
    while True:
        time.sleep(1)
else:
    raise SystemExit("unknown fixture program")
