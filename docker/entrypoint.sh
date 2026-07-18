#!/usr/bin/env bash
set -euo pipefail

GROK_DIR="${HOME}/.grok"
SETTINGS="${GROK_DIR}/user-settings.json"
WORKSPACE="${GROK_WORKSPACE:-/data/workspace}"
AUTH_MODE="${GROK_AUTH_MODE:-static}"        # static | oauth
CHANNEL="${GROK_ENABLED_CHANNEL:-telegram}"  # telegram | weixin

mkdir -p "$GROK_DIR" "$WORKSPACE"

# ============================= Weixin channel =============================
# grok's app-server runs on a loopback port; the Weixin bridge owns the public
# $PORT (and serves Railway's /healthz). The bridge talks to the app-server over
# HTTP, and the app-server reads the rotating xAI OAuth token from its store, so
# a token refresh needs no process restarts. There is no Telegram here — in OAuth
# mode the device-login link is written to the container logs for the operator to
# approve (oauth.ts logs it and degrades gracefully with no Telegram target).
if [ "$CHANNEL" = "weixin" ]; then
  # The Weixin bridge owns the public $PORT; grok's app-server listens on a
  # distinct loopback port. $PORT is usually the same value as the app-server's
  # default (both 8080), so pin the app-server elsewhere and guard against a clash.
  PUBLIC_PORT="${PORT:-8080}"
  APP_SERVER_PORT="${GROK_APP_SERVER_PORT:-8090}"
  if [ "$APP_SERVER_PORT" = "$PUBLIC_PORT" ]; then
    APP_SERVER_PORT=$((PUBLIC_PORT + 1))
  fi
  echo "[entrypoint] Weixin mode — app-server on 127.0.0.1:${APP_SERVER_PORT}, bridge on ${PUBLIC_PORT}"

  PORT="$APP_SERVER_PORT" bun run docker/app-server.ts &
  APP_PID=$!

  OAUTH_PID=""
  BRIDGE_PID=""
  weixin_cleanup() {
    trap - EXIT INT TERM
    [ -n "$BRIDGE_PID" ] && kill "$BRIDGE_PID" 2>/dev/null || true
    [ -n "$OAUTH_PID" ] && kill "$OAUTH_PID" 2>/dev/null || true
    kill "$APP_PID" 2>/dev/null || true
  }
  trap weixin_cleanup EXIT INT TERM

  if [ "$AUTH_MODE" = "oauth" ]; then
    # Keep the OAuth store fresh in the background, and service on-demand /login
    # re-logins. The first refresh runs the device flow (blocking until the
    # operator approves the logged link); the app-server reads the store live, so
    # later refreshes never restart anything.
    RELOGIN_MARKER="${GROK_DIR}/relogin-request"
    (
      relogin_pid=""
      refresh_at=0
      while true; do
        # /login: the bridge drops this marker to request a fresh device login.
        # Run it non-destructively (it overwrites the store only on approval), one
        # at a time.
        if [ -f "$RELOGIN_MARKER" ]; then
          rm -f "$RELOGIN_MARKER"
          # Supersede any in-flight relogin (it polls for ~30 min awaiting
          # approval) with a fresh code, so a repeated /login always yields a new
          # link instead of stalling behind the previous one. Killing it before
          # approval is safe — the store is overwritten only on success.
          [ -n "$relogin_pid" ] && kill "$relogin_pid" 2>/dev/null || true
          echo "[entrypoint] /login requested — (re)starting a re-login device flow"
          bun docker/oauth.ts relogin &
          relogin_pid=$!
        fi
        now="$(date +%s)"
        if [ "$now" -ge "$refresh_at" ]; then
          if bun docker/oauth.ts token >/dev/null; then
            refresh_at=$(( now + 300 ))
          else
            echo "[entrypoint] token acquisition failed; retrying in 30s"
            refresh_at=$(( now + 30 ))
          fi
        fi
        sleep 3
      done
    ) &
    OAUTH_PID=$!
  fi

  # The bridge inherits WEIXIN_BASE_URL / CONTROL_API_TOKEN / GROK_THREAD_MODE /
  # GROK_WEIXIN_STATE_DIR / WEIXIN_TOKEN / GROK_DEFAULT_CWD from the environment.
  (
    cd /app/grok-weixin-bridge \
      && PORT="$PUBLIC_PORT" \
         GROK_APP_SERVER_URL="http://127.0.0.1:${APP_SERVER_PORT}" \
         GROK_APP_SERVER_TOKEN="${GROK_APP_SERVER_TOKEN:-${APP_SERVER_TOKEN:-}}" \
         bun run src/index.ts
  ) &
  BRIDGE_PID=$!

  wait -n "$APP_PID" "$BRIDGE_PID"
  exit $?
fi

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

# --- App-server first (serves /healthz + the OpenAI-compatible API on $PORT),
#     so Railway's healthcheck is green even while an interactive device login
#     is still pending. It reads the credential dynamically (from the OAuth
#     store), so it never needs restarting when the token rotates. ---
bun run docker/app-server.ts &
APP_PID=$!

BRIDGE_PID=""
start_bridge() {
  stop_bridge
  # GROK_MODEL (optional) selects the model for Telegram chats; the app-server
  # reads it from the env directly, so this only needs wiring for the bridge.
  local model_args=()
  [ -n "${GROK_MODEL:-}" ] && model_args=(--model "$GROK_MODEL")
  GROK_API_KEY="$1" bun run src/index.ts telegram-bridge \
    --no-sandbox \
    -d "$WORKSPACE" \
    ${model_args[@]+"${model_args[@]}"} \
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
  kill "$APP_PID" 2>/dev/null || true
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
    wait -n "$APP_PID" "$BRIDGE_PID"
  else
    echo "[entrypoint] TELEGRAM_BOT_TOKEN and/or GROK_API_KEY not set — health server only"
    wait "$APP_PID"
  fi
fi
