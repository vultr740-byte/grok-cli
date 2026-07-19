// Headless OIDC credential manager for the Railway deployment.
//
// Keeps a valid xAI access token available without any static API key:
//   - refreshes an existing refresh_token when possible (hands-off, ~every 6h);
//   - when there is no usable refresh_token, runs the OAuth 2.0 Device
//     Authorization flow and delivers the login link to the operator over the
//     active channel — Telegram, or Weixin once the account is linked (with a
//     log fallback) — then polls until approved.
//
// Usage (called by docker/entrypoint.sh):
//   bun docker/oauth.ts token
//     → ensures a valid token and prints "<access_token>\t<expires_at_epoch>"
//       to stdout. All human-facing progress goes to stderr; secrets are only
//       persisted to the store file, never logged.
//
// It touches no grok-dev source: the entrypoint exports the printed token as
// GROK_API_KEY for the bridge subprocess.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const CLIENT_ID = process.env.GROK_OIDC_CLIENT_ID ?? "b1a00492-073a-47ea-816f-4c329264a828";
const DEVICE_ENDPOINT = process.env.GROK_OIDC_DEVICE_ENDPOINT ?? "https://auth.x.ai/oauth2/device/code";
const TOKEN_ENDPOINT = process.env.GROK_OIDC_TOKEN_ENDPOINT ?? "https://auth.x.ai/oauth2/token";
const SCOPE = process.env.GROK_OIDC_SCOPE ?? "openid profile email offline_access grok-cli:access api:access";
const STORE = process.env.GROK_OAUTH_STORE ?? path.join(os.homedir(), ".grok", "oauth.json");
// While a device login is pending, mirror the login prompt here so the Weixin
// bridge can answer the operator's first message with the link (Weixin blocks a
// proactive push before the user has messaged the bot).
const PENDING_LOGIN_FILE = process.env.GROK_PENDING_LOGIN_FILE ?? path.join(path.dirname(STORE), "pending-login.json");
const SEED_REFRESH_TOKEN = process.env.GROK_OAUTH_REFRESH_TOKEN ?? "";

// Which channel delivers the login link: Telegram (approved chat ids known at
// deploy time) or Weixin (push to the connected operator once the account is
// linked). Anything else falls back to logs only.
const CHANNEL = process.env.GROK_ENABLED_CHANNEL ?? "telegram";
const WEIXIN_STATE_DIR = process.env.GROK_WEIXIN_STATE_DIR ?? "/data/weixin";

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const TG_APPROVED = (process.env.TELEGRAM_APPROVED_USER_IDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

interface Stored {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number; // epoch seconds
  obtained_at?: number;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

function log(msg: string): void {
  process.stderr.write(`[oauth] ${msg}\n`);
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function loadStore(): Stored {
  try {
    return JSON.parse(fs.readFileSync(STORE, "utf8")) as Stored;
  } catch {
    return {};
  }
}

function saveStore(s: Stored): void {
  fs.mkdirSync(path.dirname(STORE), { recursive: true });
  fs.writeFileSync(STORE, JSON.stringify(s, null, 2), { mode: 0o600 });
}

// Publish/clear the pending login prompt for the Weixin bridge to relay on the
// operator's next message (see PENDING_LOGIN_FILE).
function writePendingLogin(message: string): void {
  try {
    fs.mkdirSync(path.dirname(PENDING_LOGIN_FILE), { recursive: true });
    fs.writeFileSync(PENDING_LOGIN_FILE, JSON.stringify({ message, updatedAt: nowSec() }), {
      mode: 0o600,
    });
  } catch {
    /* best effort; the link still appears in the logs */
  }
}

function clearPendingLogin(): void {
  try {
    fs.rmSync(PENDING_LOGIN_FILE, { force: true });
  } catch {
    /* best effort */
  }
}

async function form(endpoint: string, body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  return (await res.json()) as TokenResponse;
}

// Returns true if the message was delivered to at least one approved user. A
// bot cannot message a user before they have started the chat, so a boot-time
// send often fails (ok:false) until the user hits /start.
async function notifyTelegram(text: string): Promise<boolean> {
  if (!TG_TOKEN || TG_APPROVED.length === 0) {
    log("no Telegram target configured; login link will only appear in logs");
    return false;
  }
  let delivered = false;
  for (const chatId of TG_APPROVED) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: false }),
      });
      const data = (await res.json()) as { ok?: boolean; description?: string };
      if (data.ok) {
        delivered = true;
      } else {
        log(`Telegram send to ${chatId} not delivered: ${data.description ?? "unknown"}`);
      }
    } catch (err) {
      log(`Telegram notify failed for ${chatId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return delivered;
}

interface WeixinAccount {
  token?: string;
  baseUrl?: string;
  userId?: string | null;
}

// The Weixin bridge writes the connected account (bot token + operator's ilink
// user id) here once login ① completes.
function loadWeixinAccount(): WeixinAccount | null {
  try {
    const file = path.join(WEIXIN_STATE_DIR, "weixin-account.json");
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as WeixinAccount;
    if (!parsed.token || !parsed.baseUrl) return null;
    return parsed;
  } catch {
    return null;
  }
}

// Deliver the login link over Weixin by pushing to the connected operator. This
// needs the Weixin account linked first (bot token + user id), so it returns
// false until that happens — the caller keeps the link in the logs and retries
// on the next poll, delivering as soon as the account appears. Reuses the
// bridge's exact send path (dynamic import) so the wire protocol never drifts.
async function notifyWeixin(text: string): Promise<boolean> {
  const account = loadWeixinAccount();
  if (!account) {
    log("Weixin account not linked yet; login link stays in logs until it is");
    return false;
  }
  if (!account.userId) {
    log("Weixin account linked but operator user id is unknown; login link stays in logs");
    return false;
  }
  try {
    const { sendTextMessage } = (await import(
      "../grok-weixin-bridge/src/platforms/weixin/api.js"
    )) as typeof import("../grok-weixin-bridge/src/platforms/weixin/api.js");
    await sendTextMessage({
      baseUrl: account.baseUrl!,
      token: account.token!,
      toUserId: account.userId,
      text,
    });
    return true;
  } catch (err) {
    log(`Weixin notify failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// Channel-agnostic delivery: Weixin push, Telegram send, or (unknown) logs only.
async function notify(text: string): Promise<boolean> {
  if (CHANNEL === "weixin") return notifyWeixin(text);
  return notifyTelegram(text);
}

interface TgUpdate {
  update_id: number;
  message?: { from?: { id?: number } };
}

// Read pending bot messages during the login wait. Short timeout so it never
// stalls the device-code polling cadence. Safe to consume here: the bridge
// isn't running yet and starts later with drop_pending_updates.
async function telegramGetUpdates(offset?: number): Promise<TgUpdate[]> {
  if (!TG_TOKEN) return [];
  const params = new URLSearchParams({ timeout: "0", allowed_updates: '["message"]' });
  if (offset !== undefined) params.set("offset", String(offset));
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getUpdates?${params.toString()}`);
    const data = (await res.json()) as { ok?: boolean; result?: TgUpdate[] };
    return data.ok && data.result ? data.result : [];
  } catch {
    return [];
  }
}

function isApprovedSender(update: TgUpdate): boolean {
  const id = update.message?.from?.id;
  return id !== undefined && TG_APPROVED.includes(String(id));
}

function persistFromResponse(resp: TokenResponse, prevRefresh?: string): Stored {
  const stored: Stored = {
    access_token: resp.access_token,
    // Providers may or may not rotate the refresh_token on each grant; keep the
    // newest one we were handed, else fall back to the one we already had.
    refresh_token: resp.refresh_token ?? prevRefresh,
    expires_at: nowSec() + (resp.expires_in ?? 3600),
    obtained_at: nowSec(),
  };
  saveStore(stored);
  return stored;
}

async function tryRefresh(refreshToken: string): Promise<Stored | "invalid" | "retry"> {
  const resp = await form(TOKEN_ENDPOINT, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  });
  if (resp.access_token) {
    log("refreshed access token");
    return persistFromResponse(resp, refreshToken);
  }
  if (resp.error === "invalid_grant" || resp.error === "invalid_request") {
    log(`refresh_token no longer valid (${resp.error}); re-authentication required`);
    return "invalid";
  }
  log(`refresh transient error: ${resp.error ?? "unknown"} ${resp.error_description ?? ""}`);
  return "retry";
}

// reactive: poll Telegram getUpdates to resend the link when an approved user
// messages during the wait. Enabled for the initial login (the bridge isn't
// running yet), but DISABLED for /login re-logins — the bridge is running then
// and would race us for the same getUpdates cursor. The initial push still fires.
async function deviceBootstrap(reactive: boolean): Promise<Stored> {
  // Telegram poll cursor, kept across device-code re-issues so we never
  // re-process the same message.
  let tgOffset: number | undefined;
  // Last time the login link was actually delivered (0 = never). A bot can't
  // message a user before they hit /start, so the boot push may not land and
  // the user's first message is what delivers the link — tracking delivery
  // avoids sending a second copy right after /start.
  let linkSentAt = 0;
  const RESEND_COOLDOWN = 60;
  const sendLink = async (text: string): Promise<void> => {
    if (await notify(text)) linkSentAt = nowSec();
  };

  // Up to a few device-code issuances in case the operator misses the window.
  for (let attempt = 1; attempt <= 5; attempt++) {
    const dev = (await form(DEVICE_ENDPOINT, { client_id: CLIENT_ID, scope: SCOPE })) as TokenResponse & {
      device_code?: string;
      user_code?: string;
      verification_uri?: string;
      verification_uri_complete?: string;
      interval?: number;
      expires_in?: number;
    };
    if (!dev.device_code || !dev.user_code) {
      throw new Error(`device authorization failed: ${dev.error ?? JSON.stringify(dev)}`);
    }
    const link = dev.verification_uri_complete ?? dev.verification_uri ?? "";
    const minutes = Math.round((dev.expires_in ?? 1800) / 60);
    const loginMessage = `🔐 Grok 云端需要登录\n点击链接登录并批准（验证码 ${dev.user_code}），${minutes} 分钟内有效：\n${link}`;
    log(`device code issued: ${dev.user_code} (attempt ${attempt}) — ${link}`);
    // Publish the prompt so the bridge can deliver it, and to record the current
    // pending link.
    writePendingLogin(loginMessage);
    // Weixin delivery is owned by the bridge: it replies to the operator's
    // message and relays on a no-credential 503. The oauth manager must NOT also
    // push, or the operator gets the link twice (e.g. on /login, where the bot is
    // already allowed to message them). Telegram is delivered here.
    if (CHANNEL !== "weixin") {
      await sendLink(loginMessage);
    }

    let interval = (dev.interval ?? 5) * 1000;
    const deadline = nowSec() + (dev.expires_in ?? 1800);
    while (nowSec() < deadline) {
      await new Promise((r) => setTimeout(r, interval));

      if (CHANNEL !== "weixin" && reactive) {
        // Reactive login link: if an approved telegram user messages the bot
        // while we wait for approval, resend the link (throttled).
        const updates = await telegramGetUpdates(tgOffset);
        if (updates.length > 0) {
          tgOffset = updates[updates.length - 1].update_id + 1;
          if (updates.some(isApprovedSender) && (linkSentAt === 0 || nowSec() - linkSentAt >= RESEND_COOLDOWN)) {
            log("approved user messaged during login wait; delivering link");
            await sendLink(loginMessage);
          }
        }
      }

      const resp = await form(TOKEN_ENDPOINT, {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: dev.device_code,
        client_id: CLIENT_ID,
      });
      if (resp.access_token) {
        log("device authorization approved");
        clearPendingLogin();
        await notify("✅ 登录成功，云端 Grok 已恢复。");
        return persistFromResponse(resp);
      }
      if (resp.error === "authorization_pending") continue;
      if (resp.error === "slow_down") {
        interval += 5000;
        continue;
      }
      if (resp.error === "expired_token") {
        log("device code expired before approval; reissuing");
        break; // reissue via outer loop
      }
      throw new Error(`device token exchange failed: ${resp.error ?? "unknown"} ${resp.error_description ?? ""}`);
    }
  }
  throw new Error("device authorization not completed after several attempts");
}

async function ensureToken(): Promise<Stored> {
  const store = loadStore();
  const refreshToken = store.refresh_token || SEED_REFRESH_TOKEN;

  // Still-valid access token with comfortable margin → use as-is.
  if (store.access_token && store.expires_at && store.expires_at - nowSec() > 300) {
    return store;
  }

  if (refreshToken) {
    const result = await tryRefresh(refreshToken);
    if (result === "retry") {
      // Transient: if we still hold a non-expired token, keep serving it.
      if (store.access_token && store.expires_at && store.expires_at > nowSec()) return store;
      throw new Error("token refresh failed transiently and no valid token cached");
    }
    if (result !== "invalid") return result;
    // else fall through to device bootstrap
  }

  return deviceBootstrap(true);
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "token";
  if (cmd === "relogin") {
    // On-demand re-login (operator sent /login). Run the device flow WITHOUT
    // touching the current token — deviceBootstrap only overwrites the store on
    // successful approval, so the current account keeps serving until then. It
    // publishes the link via pending-login.json for the bridge to relay.
    try {
      await deviceBootstrap(false);
      log("relogin: new account authorized (store overwritten)");
    } catch (err) {
      log(`relogin: not completed (${err instanceof Error ? err.message : String(err)}); current account unchanged`);
      clearPendingLogin();
    }
    return;
  }
  if (cmd !== "token") {
    log(`unknown command: ${cmd}`);
    process.exit(2);
  }
  const store = await ensureToken();
  if (!store.access_token || !store.expires_at) {
    log("failed to obtain access token");
    process.exit(1);
  }
  // Only the token line goes to stdout.
  process.stdout.write(`${store.access_token}\t${store.expires_at}\n`);
}

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
