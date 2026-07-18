#!/usr/bin/env bash
set -euo pipefail

GROK_DIR="${HOME}/.grok"
SETTINGS="${GROK_DIR}/user-settings.json"
WORKSPACE="${GROK_WORKSPACE:-/data/workspace}"
AUTH_MODE="${GROK_AUTH_MODE:-static}"   # static | oauth

mkdir -p "$GROK_DIR" "$WORKSPACE"

# --- Merge env-provided Telegram config into user-settings.json (merge, not
#     overwrite: approvedUserIds / sessionsByUserId are written at runtime). ---
[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
tmp="$(mktemp)"
jq \
  --arg botToken "${TELEGRAM_BOT_TOKEN:-}" \
  --arg approved "${TELEGRAM_APPROVED_USER_IDS:-}" \
  '
  ($approved | split(",") | map(select(length > 0) | tonumber)) as $newIds
  | .telegram = (.telegram // {})
  | (if $botToken != "" then .telegram.botToken = $botToken else . end)
  | .telegram.approvedUserIds = ((.telegram.approvedUserIds // []) + $newIds | unique)
  ' "$SETTINGS" > "$tmp" && mv "$tmp" "$SETTINGS"
chmod 600 "$SETTINGS"
echo "[entrypoint] settings ready at $SETTINGS"
echo "[entrypoint] approved users: $(jq -c '.telegram.approvedUserIds // []' "$SETTINGS")"

# --- Health server first, so Railway's healthcheck is green even while an
#     interactive device login is still pending. ---
bun run docker/health.ts &
HEALTH_PID=$!

BRIDGE_PID=""
start_bridge() {
  stop_bridge
  GROK_API_KEY="$1" bun run src/index.ts telegram-bridge \
    --no-sandbox \
    -d "$WORKSPACE" \
    --log-file "$GROK_DIR/telegram-remote-bridge.log" \
    --pair-code-file "$GROK_DIR/telegram-pair-code.txt" &
  BRIDGE_PID=$!
}
stop_bridge() {
  if [ -n "$BRIDGE_PID" ]; then
    kill "$BRIDGE_PID" 2>/dev/null || true
    wait "$BRIDGE_PID" 2>/dev/null || true
    BRIDGE_PID=""
  fi
}
cleanup() {
  trap - EXIT INT TERM
  stop_bridge
  kill "$HEALTH_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

if [ "$AUTH_MODE" = "oauth" ]; then
  # --- OAuth mode: no static key. Manage the xAI credential via device flow +
  #     refresh; deliver login links over Telegram. Restart the bridge whenever
  #     the access token rotates (the bridge reads the key at construction). ---
  echo "[entrypoint] OAuth mode — managing credential via device flow + refresh"
  prev=""
  refresh_at=0
  while true; do
    now="$(date +%s)"
    if [ -z "$prev" ] || [ "$now" -ge "$refresh_at" ]; then
      if line="$(bun docker/oauth.ts token)"; then
        access="${line%%$'\t'*}"
        exp="${line##*$'\t'}"
        refresh_at=$(( exp - 300 ))
        if [ "$access" != "$prev" ]; then
          echo "[entrypoint] (re)starting bridge with refreshed token (expires_at=$exp)"
          start_bridge "$access"
          prev="$access"
        fi
      else
        echo "[entrypoint] token acquisition failed; retrying in 30s"
        sleep 30
        continue
      fi
    fi
    # Restart the bridge if it exited on its own.
    if [ -n "$BRIDGE_PID" ] && ! kill -0 "$BRIDGE_PID" 2>/dev/null; then
      echo "[entrypoint] bridge exited; restarting"
      start_bridge "$prev"
    fi
    sleep 60
  done
else
  # --- Static mode: use GROK_API_KEY env / settings.apiKey (original behavior). ---
  if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && { [ -n "${GROK_API_KEY:-}" ] || jq -e '.apiKey' "$SETTINGS" >/dev/null 2>&1; }; then
    echo "[entrypoint] static mode — starting telegram bridge (workspace: $WORKSPACE)"
    start_bridge "${GROK_API_KEY:-}"
    wait -n "$HEALTH_PID" "$BRIDGE_PID"
  else
    echo "[entrypoint] TELEGRAM_BOT_TOKEN and/or GROK_API_KEY not set — health server only"
    wait "$HEALTH_PID"
  fi
fi
