#!/bin/sh
set -eu

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
export EASY_EMAIL_CONFIG_PATH="$CONFIG_PATH"
export EASY_EMAIL_STATE_DIR="$STATE_DIR"
RESET_STORE_ON_BOOT="${EASY_EMAIL_RESET_STORE_ON_BOOT:-false}"
STATE_LAYOUT_DIR="${STATE_DIR}/state"

mkdir -p "$(dirname "$CONFIG_PATH")" "$(dirname "$RUNTIME_ENV_PATH")" "$STATE_DIR" "$STATE_LAYOUT_DIR"

if [ ! -f "$CONFIG_PATH" ]; then
  if [ -f "$BOOTSTRAP_PATH" ]; then
    echo "[easy-email] runtime config missing, attempting bootstrap via $BOOTSTRAP_PATH"
    python /usr/local/bin/bootstrap-service-config.py \
      --bootstrap-path "$BOOTSTRAP_PATH" \
      --config-path "$CONFIG_PATH" \
      --runtime-env-path "$RUNTIME_ENV_PATH"
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

if [ "$(id -u)" = "0" ]; then
  chown -R easy:easy "$STATE_DIR" "$(dirname "$CONFIG_PATH")" /app
  exec gosu easy node dist/src/runtime/main.js
fi

exec node dist/src/runtime/main.js
