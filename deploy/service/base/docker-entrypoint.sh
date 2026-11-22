#!/bin/sh
set -eu

APP_PID=""
SYNC_PID=""
RUN_PID=""
STOPPING="false"

terminate_child() {
  if [ -n "${1:-}" ]; then
    kill "-${2:-TERM}" "$1" 2>/dev/null || true
    wait "$1" 2>/dev/null || true
  fi
}

shutdown() {
  STOPPING="true"
  trap '' TERM INT
  if [ -n "$APP_PID" ]; then
    kill "-$1" "$APP_PID" 2>/dev/null || true
  fi
  terminate_child "$SYNC_PID" TERM
  terminate_child "$RUN_PID" TERM
  APP_STATUS=0
  if [ -n "$APP_PID" ]; then
    # A trapped signal interrupts wait; wait again until the app has really exited.
    wait "$APP_PID" 2>/dev/null || APP_STATUS=$?
  fi
  exit "$APP_STATUS"
}

trap 'shutdown TERM' TERM
trap 'shutdown INT' INT

run_child() {
  "$@" &
  RUN_PID=$!
  RUN_STATUS=0
  wait "$RUN_PID" || RUN_STATUS=$?
  RUN_PID=""
  return "$RUN_STATUS"
}

# Force Unix paths (Docker Desktop on Windows may inject Windows paths)
case "${EASY_EMAIL_CONFIG_PATH:-}" in
  *C:*|*\\*) EASY_EMAIL_CONFIG_PATH="/etc/easy-email/config.yaml" ;;
esac
case "${EASY_EMAIL_STATE_DIR:-}" in
  *C:*|*\\*) EASY_EMAIL_STATE_DIR="/var/lib/easy-email" ;;
esac

CONFIG_PATH="${EASY_EMAIL_CONFIG_PATH:-/etc/easy-email/config.yaml}"
STATE_DIR="${EASY_EMAIL_STATE_DIR:-/var/lib/easy-email}"
RUNTIME_ENV_PATH="${EASY_EMAIL_RUNTIME_ENV_PATH:-/etc/easy-email/runtime.env}"
BOOTSTRAP_PATH="${EASY_EMAIL_BOOTSTRAP_PATH:-/etc/easy-email/bootstrap/r2-bootstrap.json}"
IMPORT_CODE="${EASY_EMAIL_IMPORT_CODE:-}"
IMPORT_STATE_PATH="${EASY_EMAIL_IMPORT_STATE_PATH:-${STATE_DIR}/import-sync-state.json}"
SYNC_FLAG_PATH="${EASY_EMAIL_IMPORT_SYNC_FLAG_PATH:-${STATE_DIR}/import-sync.restart}"
export EASY_EMAIL_CONFIG_PATH="$CONFIG_PATH"
export EASY_EMAIL_STATE_DIR="$STATE_DIR"
RESET_STORE_ON_BOOT="${EASY_EMAIL_RESET_STORE_ON_BOOT:-false}"
STATE_LAYOUT_DIR="${STATE_DIR}/state"

mkdir -p "$(dirname "$CONFIG_PATH")" "$(dirname "$RUNTIME_ENV_PATH")" "$STATE_DIR" "$STATE_LAYOUT_DIR"

if [ ! -f "$BOOTSTRAP_PATH" ] && [ -n "$IMPORT_CODE" ]; then
  mkdir -p "$(dirname "$BOOTSTRAP_PATH")"
  echo "[easy-email] import code provided, generating bootstrap file at $BOOTSTRAP_PATH"
  run_child python /usr/local/bin/easyemail-import-code.py inspect \
    --import-code "$IMPORT_CODE" \
    --output "$BOOTSTRAP_PATH"
fi

if [ ! -f "$CONFIG_PATH" ]; then
  if [ -f "$BOOTSTRAP_PATH" ]; then
    echo "[easy-email] runtime config missing, attempting bootstrap via $BOOTSTRAP_PATH"
    run_child python /usr/local/bin/bootstrap-service-config.py \
      --bootstrap-path "$BOOTSTRAP_PATH" \
      --config-path "$CONFIG_PATH" \
      --runtime-env-path "$RUNTIME_ENV_PATH" \
      --state-path "$IMPORT_STATE_PATH"
  fi
fi

if [ ! -f "$CONFIG_PATH" ]; then
  echo "[easy-email] missing generated runtime config at $CONFIG_PATH" >&2
  echo "[easy-email] provide a rendered config.yaml or mount $BOOTSTRAP_PATH so the container can pull it from R2" >&2
  exit 1
fi

case "$(echo "$RESET_STORE_ON_BOOT" | tr '[:upper:]' '[:lower:]')" in
  1|true|yes|on)
    echo "[easy-email] EASY_EMAIL_RESET_STORE_ON_BOOT=true -> clearing $STATE_DIR"
    rm -rf "${STATE_DIR:?}"/*
    ;;
  *)
    ;;
esac

if [ -f "$RUNTIME_ENV_PATH" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$RUNTIME_ENV_PATH"
  set +a
fi

resolve_bootstrap_sync_setting() {
  python - "$BOOTSTRAP_PATH" <<'PY'
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
if not path.exists():
    print("false")
    print("7200")
    raise SystemExit(0)

payload = json.loads(path.read_text(encoding="utf-8-sig"))
print("true" if payload.get("syncEnabled", True) else "false")
print(int(payload.get("syncIntervalSeconds") or 7200))
PY
}

start_runtime() {
  if [ -f "$RUNTIME_ENV_PATH" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$RUNTIME_ENV_PATH"
    set +a
  fi

  if [ "$(id -u)" = "0" ]; then
    run_child chown -R easy:easy "$STATE_DIR" "$(dirname "$CONFIG_PATH")" /app
    gosu easy node dist/src/runtime/main.js &
  else
    node dist/src/runtime/main.js &
  fi

  APP_PID=$!
}

start_sync_loop() {
  SYNC_INTERVAL_SECONDS="$1"
  (
    SYNC_CHILD_PID=""
    sync_shutdown() {
      trap '' TERM INT
      terminate_child "$SYNC_CHILD_PID" TERM
      exit 0
    }
    trap 'sync_shutdown' TERM INT
    run_sync_child() {
      "$@" &
      SYNC_CHILD_PID=$!
      SYNC_CHILD_STATUS=0
      wait "$SYNC_CHILD_PID" || SYNC_CHILD_STATUS=$?
      SYNC_CHILD_PID=""
      return "$SYNC_CHILD_STATUS"
    }
    while true; do
      run_sync_child sleep "$SYNC_INTERVAL_SECONDS"
      run_sync_child python /usr/local/bin/bootstrap-service-config.py \
        --bootstrap-path "$BOOTSTRAP_PATH" \
        --config-path "$CONFIG_PATH" \
        --runtime-env-path "$RUNTIME_ENV_PATH" \
        --state-path "$IMPORT_STATE_PATH" \
        --mode sync \
        --updated-flag-path "$SYNC_FLAG_PATH"
      if [ -f "$SYNC_FLAG_PATH" ]; then
        echo "[easy-email] remote runtime config updated, restarting service"
        kill "$APP_PID" 2>/dev/null || true
        break
      fi
    done
  ) &
  SYNC_PID=$!
}

SYNC_ENABLED="false"
SYNC_INTERVAL_SECONDS="7200"
if [ -f "$BOOTSTRAP_PATH" ]; then
  SYNC_VALUES="$(resolve_bootstrap_sync_setting)"
  SYNC_ENABLED="$(printf '%s' "$SYNC_VALUES" | sed -n '1p')"
  SYNC_INTERVAL_SECONDS="$(printf '%s' "$SYNC_VALUES" | sed -n '2p')"
fi

while true; do
  rm -f "$SYNC_FLAG_PATH"
  start_runtime
  if [ "$SYNC_ENABLED" = "true" ] && [ -f "$BOOTSTRAP_PATH" ]; then
    start_sync_loop "$SYNC_INTERVAL_SECONDS"
  else
    SYNC_PID=""
  fi

  APP_STATUS=0
  wait "$APP_PID" || APP_STATUS=$?
  APP_PID=""

  terminate_child "$SYNC_PID" TERM
  SYNC_PID=""

  if [ "$STOPPING" != "true" ] && [ -f "$SYNC_FLAG_PATH" ]; then
    rm -f "$SYNC_FLAG_PATH"
    continue
  fi

  exit "$APP_STATUS"
done
