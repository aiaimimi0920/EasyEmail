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
export EASY_EMAIL_CONFIG_PATH="$CONFIG_PATH"
export EASY_EMAIL_STATE_DIR="$STATE_DIR"
RESET_STORE_ON_BOOT="${EASY_EMAIL_RESET_STORE_ON_BOOT:-false}"
STATE_LAYOUT_DIR="${STATE_DIR}/state"

mkdir -p "$(dirname "$CONFIG_PATH")" "$STATE_DIR" "$STATE_LAYOUT_DIR"

if [ ! -f "$CONFIG_PATH" ]; then
  cp /opt/easy-email/config.template.yaml "$CONFIG_PATH"
  echo "[easy-email] generated default config at $CONFIG_PATH"
fi

case "$(echo "$RESET_STORE_ON_BOOT" | tr '[:upper:]' '[:lower:]')" in
  1|true|yes|on)
    echo "[easy-email] EASY_EMAIL_RESET_STORE_ON_BOOT=true -> clearing $STATE_DIR"
    rm -rf "${STATE_DIR:?}"/*
    ;;
  *)
    ;;
esac

if [ "$(id -u)" = "0" ]; then
  chown -R easy:easy "$STATE_DIR" "$(dirname "$CONFIG_PATH")" /opt/easy-email
  exec gosu easy node dist/src/runtime/main.js
fi

exec node dist/src/runtime/main.js
