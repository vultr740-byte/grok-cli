import fs from "node:fs";
import path from "node:path";
import { extractOutboundAttachmentManifest } from "../media/attachment-manifest.js";
import { downloadInboundAttachments } from "../media/inbound-attachments.js";
import { sendWeixinMediaFile } from "../media/outbound-attachments.js";
import { getConfig, getUpdates, sendTextMessage, sendTyping } from "../platforms/weixin/api.js";
import type { MessageItem } from "../platforms/weixin/types.js";
import { GrokHttpClient } from "../providers/grok/http-client.js";
import { DedupStore } from "../store/dedup-store.js";
import { ThreadBindingStore } from "../store/thread-binding-store.js";
import { WeixinAccountStore } from "../store/weixin-account-store.js";
import type { BridgeConfig } from "../types.js";

const SESSION_EXPIRED_ERRCODE = -14;
const TYPING_KEEPALIVE_INTERVAL_MS = 5_000;
const OUTBOUND_ATTACHMENT_GAP_MS = 3_000;
const DEFAULT_RECHARGE_BASE_URL = "https://www.xialiao.app/recharge/";
const BILLING_ERROR_MESSAGE = "⚠️ 模型余额不足，请充值后重试。";

export class Bridge {
  private readonly config: BridgeConfig;
  private readonly grok: GrokHttpClient;
  private readonly threadBindings: ThreadBindingStore;
  private readonly dedup: DedupStore;
  private readonly accountStore: WeixinAccountStore;
  private readonly typingTickets = new TypingTicketCache();
  private readonly syncBufPath: string;
  private running = false;

  constructor(config: BridgeConfig) {
    this.config = config;
    this.grok = new GrokHttpClient({
      httpUrl: config.appServerUrl,
      token: config.appServerToken,
      turnTimeoutMs: config.codexTurnTimeoutMs,
    });
    this.threadBindings = new ThreadBindingStore(config.stateDir);
    this.dedup = new DedupStore(config.stateDir);
    this.accountStore = new WeixinAccountStore(config.stateDir);
    this.syncBufPath = path.join(config.stateDir, "weixin-sync-buf.json");
  }

  async start(): Promise<void> {
    this.running = true;
    let backoffMs = 1_000;
    while (this.running) {
      try {
        const account = this.accountStore.load();
        const token = account?.token ?? this.config.weixinToken;
        const baseUrl = account?.baseUrl ?? this.config.weixinBaseUrl;
        if (!token) {
          await sleep(5_000);
          continue;
        }

        const resp = await getUpdates({
          baseUrl,
          token,
          getUpdatesBuf: this.loadSyncBuf(),
        });
        if (isApiError(resp)) {
          if (resp.ret === SESSION_EXPIRED_ERRCODE || resp.errcode === SESSION_EXPIRED_ERRCODE) {
            this.accountStore.clear();
          }
          throw new Error(
            `Weixin getUpdates failed: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ""}`,
          );
        }
        if (resp.get_updates_buf) {
          this.saveSyncBuf(resp.get_updates_buf);
        }
        backoffMs = 1_000;

        const msgs = resp.msgs ?? [];
        for (const msg of msgs) {
          const messageId = String(msg.message_id ?? msg.seq ?? "");
          const fromUserId = msg.from_user_id?.trim();
          if (!messageId || !fromUserId) {
            continue;
          }
          if (this.dedup.has(messageId)) {
            continue;
          }
          this.dedup.add(messageId);

          const text = extractText(msg.item_list);
          if (isLoginCommand(text)) {
            await handleLoginCommand({
              baseUrl,
              token,
              fromUserId,
              operatorUserId: account?.userId ?? null,
              contextToken: msg.context_token ?? null,
            });
            continue;
          }
          const { attachments, errors: attachmentErrors } = await downloadInboundAttachments({
            items: msg.item_list,
            cdnBaseUrl: this.config.weixinCdnBaseUrl,
            uploadDir: this.config.uploadDir,
            weixinUserId: fromUserId,
            messageId,
          });
          if (!text && attachments.length === 0 && attachmentErrors.length === 0) {
            continue;
          }
          const turnText = appendAttachmentErrors(text, attachmentErrors);

          const typingTicket = await this.getTypingTicket({
            baseUrl,
            token,
            userId: fromUserId,
            contextToken: msg.context_token ?? null,
          });

          const binding = this.threadBindings.getByWeixinUserId(fromUserId);
          let threadId = binding?.codexThreadId ?? (await this.grok.startThread());
          if (!binding) {
            this.saveThreadBinding(fromUserId, threadId);
          }

          const typing = this.startTypingIndicator({
            baseUrl,
            token,
            toUserId: fromUserId,
            typingTicket,
          });
          let result: { assistantText: string } | null = null;
          let failure: unknown | null = null;
          try {
            result = await this.grok.sendTurn({
              threadId,
              text: turnText,
              attachments,
              clientUserMessageId: messageId,
            });
          } catch (error) {
            if (isThreadNotFound(error)) {
              console.warn(`Codex thread ${threadId} was not found; starting a fresh thread for ${fromUserId}.`);
              try {
                threadId = await this.grok.startThread();
                this.saveThreadBinding(fromUserId, threadId);
                result = await this.grok.sendTurn({
                  threadId,
                  text: turnText,
                  attachments,
                  clientUserMessageId: messageId,
                });
              } catch (retryError) {
                failure = retryError;
              }
            } else {
              failure = error;
            }
          } finally {
            await typing.stop();
          }

          if (failure) {
            console.error(failure);
            await sendTextMessage({
              baseUrl,
              token,
              toUserId: fromUserId,
              text: formatGrokFailureMessage(failure),
              contextToken: msg.context_token ?? null,
            });
          }

          this.threadBindings.updateWeixinUserId(fromUserId, { updatedAt: Date.now() });

          if (result?.assistantText) {
            const outbound = extractOutboundAttachmentManifest(result.assistantText);
            const replyText = outbound.text;
            if (replyText) {
              await sendTextMessage({
                baseUrl,
                token,
                toUserId: fromUserId,
                text: replyText,
                contextToken: msg.context_token ?? null,
              });
            }
            const outboundErrors = [...outbound.errors];
            for (const [index, attachment] of outbound.attachments.entries()) {
              try {
                console.log(
                  JSON.stringify({
                    event: "weixin_outbound_attachment_send_start",
                    index,
                    filePath: attachment.path,
                    captionPresent: Boolean(attachment.caption?.trim()),
                  }),
                );
                await sendWeixinMediaFile({
                  filePath: attachment.path,
                  toUserId: fromUserId,
                  text: attachment.caption ?? "",
                  options: {
                    baseUrl,
                    token,
                    contextToken: msg.context_token ?? null,
                  },
                  cdnBaseUrl: this.config.weixinCdnBaseUrl,
                });
                console.log(
                  JSON.stringify({
                    event: "weixin_outbound_attachment_send_complete",
                    index,
                    filePath: attachment.path,
                  }),
                );
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                console.error(
                  JSON.stringify({
                    event: "weixin_outbound_attachment_send_failed",
                    index,
                    filePath: attachment.path,
                    error: message,
                  }),
                );
                outboundErrors.push(`${path.basename(attachment.path)}: ${message}`);
              }
              if (index < outbound.attachments.length - 1) {
                await sleep(OUTBOUND_ATTACHMENT_GAP_MS);
              }
            }
            if (outboundErrors.length > 0) {
              await sendTextMessage({
                baseUrl,
                token,
                toUserId: fromUserId,
                text: `⚠️ 附件发送失败：\n${outboundErrors.map((error, index) => `${index + 1}. ${error}`).join("\n")}`,
                contextToken: msg.context_token ?? null,
              });
            }
          }
        }
      } catch (error) {
        if (!this.running) {
          break;
        }
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 30_000);
        console.error(error);
      }
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.grok.close();
  }

  private saveThreadBinding(weixinUserId: string, codexThreadId: string): void {
    this.threadBindings.save({
      weixinUserId,
      codexThreadId,
      updatedAt: Date.now(),
    });
  }

  private async getTypingTicket(params: {
    baseUrl: string;
    token: string;
    userId: string;
    contextToken: string | null;
  }): Promise<string | null> {
    const cached = this.typingTickets.get(params.userId);
    if (cached) {
      return cached;
    }

    try {
      const config = await getConfig({
        baseUrl: params.baseUrl,
        token: params.token,
        ilinkUserId: params.userId,
        contextToken: params.contextToken,
      });
      const ticket = config.typing_ticket?.trim();
      if (ticket) {
        this.typingTickets.set(params.userId, ticket);
        return ticket;
      }
    } catch (error) {
      console.error(`Weixin getconfig failed for ${params.userId}:`, error);
    }

    return null;
  }

  private startTypingIndicator(params: {
    baseUrl: string;
    token: string;
    toUserId: string;
    typingTicket: string | null;
  }): { stop: () => Promise<void> } {
    if (!params.typingTicket) {
      return { stop: async () => {} };
    }

    let stopped = false;
    let sendQueue = Promise.resolve();
    const send = async (status: 1 | 2) => {
      try {
        await sendTyping({
          baseUrl: params.baseUrl,
          token: params.token,
          toUserId: params.toUserId,
          typingTicket: params.typingTicket!,
          status,
        });
      } catch (error) {
        console.error(`Weixin sendtyping failed for ${params.toUserId}:`, error);
      }
    };

    const enqueue = (status: 1 | 2) => {
      sendQueue = sendQueue.then(() => send(status));
      return sendQueue;
    };

    void enqueue(1);
    const interval = setInterval(() => {
      if (!stopped) {
        void enqueue(1);
      }
    }, TYPING_KEEPALIVE_INTERVAL_MS);

    return {
      stop: async () => {
        if (stopped) {
          return;
        }
        stopped = true;
        clearInterval(interval);
        await enqueue(2);
      },
    };
  }

  private loadSyncBuf(): string {
    try {
      if (!fs.existsSync(this.syncBufPath)) {
        return "";
      }
      const raw = fs.readFileSync(this.syncBufPath, "utf8");
      const parsed = JSON.parse(raw) as { getUpdatesBuf?: string };
      return typeof parsed.getUpdatesBuf === "string" ? parsed.getUpdatesBuf : "";
    } catch {
      return "";
    }
  }

  private saveSyncBuf(getUpdatesBuf: string): void {
    try {
      fs.writeFileSync(this.syncBufPath, JSON.stringify({ getUpdatesBuf }, null, 2), "utf8");
    } catch (error) {
      console.error(error);
    }
  }
}

function extractText(items: Array<MessageItem | undefined> | undefined): string {
  for (const item of items ?? []) {
    if (item?.type === 1 && typeof item.text_item?.text === "string") {
      return item.text_item.text.trim();
    }
    if (item?.type === 3 && typeof item.voice_item?.text === "string") {
      return item.voice_item.text.trim();
    }
  }
  return "";
}

function appendAttachmentErrors(text: string, errors: string[]): string {
  if (errors.length === 0) {
    return text;
  }
  const lines = text.trim() ? [text.trim(), ""] : [];
  lines.push("Some Weixin attachments could not be downloaded:");
  errors.forEach((error, index) => {
    lines.push(`${index + 1}. ${error}`);
  });
  return lines.join("\n");
}

function isApiError(resp: { ret?: number; errcode?: number }): boolean {
  return (resp.ret !== undefined && resp.ret !== 0) || (resp.errcode !== undefined && resp.errcode !== 0);
}

function formatGrokFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (isNoCredentialFailure(message)) {
    // The cloud agent hasn't finished its xAI device login yet. Weixin refuses a
    // proactive push to a user who hasn't messaged the bot ("prepare failed"), so
    // answer this incoming message with the pending login link — a reply weixin
    // allows — instead of a raw error.
    const pending = readPendingLoginMessage();
    return pending ?? "⏳ 云端 Grok 正在登录中，请稍后再发一条消息获取授权链接。";
  }
  // Opt-in house billing notice: when GROK_BILLING_NOTICE is enabled, map billing
  // failures to a custom message + recharge link (for pooled-credit setups). Off
  // by default — grok operators log in with their own xAI account, so we surface
  // the provider's own error (e.g. "out of credits — add credits at grok.com").
  if (useHouseBillingNotice() && isBillingFailure(message)) {
    const rechargeUrl = resolveRechargeUrl();
    return rechargeUrl ? `${BILLING_ERROR_MESSAGE}\n${rechargeUrl}` : BILLING_ERROR_MESSAGE;
  }
  // Default: surface the upstream provider error directly; strip our
  // "grok app-server <status>:" transport prefix so only that message shows.
  return `⚠️ ${stripAppServerPrefix(message).slice(0, 500)}`;
}

function useHouseBillingNotice(): boolean {
  const value = (process.env.GROK_BILLING_NOTICE ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on" || value === "house";
}

function stripAppServerPrefix(message: string): string {
  return message.replace(/^grok app-server \d+:\s*/iu, "").trim() || message;
}

function isNoCredentialFailure(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("no xai credential") || (normalized.includes("503") && normalized.includes("credential"));
}

function grokHomeFile(name: string): string {
  return path.join(process.env.HOME ?? "", ".grok", name);
}

function pendingLoginPath(): string {
  return process.env.GROK_PENDING_LOGIN_FILE ?? grokHomeFile("pending-login.json");
}

function reloginMarkerPath(): string {
  return process.env.GROK_RELOGIN_MARKER ?? grokHomeFile("relogin-request");
}

// The oauth manager writes the pending device-login prompt here while it waits
// for approval; the bridge surfaces it to the first weixin message.
function readPendingLoginMessage(): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(pendingLoginPath(), "utf8")) as { message?: string };
    return parsed.message?.trim() ? parsed.message : null;
  } catch {
    return null;
  }
}

const LOGIN_COMMAND = "/login";
const RELOGIN_LINK_WAIT_MS = Number(process.env.GROK_RELOGIN_LINK_WAIT_MS ?? 25_000);

function isLoginCommand(text: string): boolean {
  return text.trim().toLowerCase() === LOGIN_COMMAND;
}

// /login: request a fresh device-login link and reply with it in the same turn.
// Non-destructive — oauth re-runs the device flow and overwrites the stored
// credential only on successful approval, so the current account keeps working
// until then. It must be a reply (not a later push, which weixin blocks) and,
// while the current token is valid, there is no no-credential 503 to piggyback
// on — so the link is delivered here, in response to the /login message.
async function handleLoginCommand(params: {
  baseUrl: string;
  token: string;
  fromUserId: string;
  operatorUserId: string | null;
  contextToken: string | null;
}): Promise<void> {
  // Only the linked operator may re-auth the shared xAI credential — otherwise a
  // stranger could approve with their own account and hijack the bot. When the
  // operator id is unknown (not captured at login) we can't gate, so we allow it.
  if (params.operatorUserId && params.fromUserId !== params.operatorUserId) {
    console.warn(`Ignoring /login from non-operator ${params.fromUserId}`);
    return;
  }
  const text = await requestReloginLink();
  await sendTextMessage({
    baseUrl: params.baseUrl,
    token: params.token,
    toUserId: params.fromUserId,
    text,
    contextToken: params.contextToken,
  });
}

async function requestReloginLink(): Promise<string> {
  // Drop any stale link, ask the oauth manager (via the marker the entrypoint
  // watches) for a fresh device code, then wait for it to publish the new prompt.
  try {
    fs.rmSync(pendingLoginPath(), { force: true });
  } catch {
    /* best effort */
  }
  try {
    const marker = reloginMarkerPath();
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, String(Date.now()));
  } catch {
    /* best effort */
  }
  const deadline = Date.now() + RELOGIN_LINK_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(1000);
    const message = readPendingLoginMessage();
    if (message) return message;
  }
  return "⏳ 正在生成登录链接，请稍后再发一次 /login。";
}

function isBillingFailure(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("402") ||
    normalized.includes("payment required") ||
    normalized.includes("insufficient balance") ||
    normalized.includes("insufficient funds") ||
    normalized.includes("credits") ||
    normalized.includes("billing") ||
    normalized.includes("quota")
  );
}

function isThreadNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes("thread not found");
}

function resolveRechargeUrl(): string | null {
  const target = process.env.RECHARGE_TARGET?.trim();
  if (!target) {
    return null;
  }
  const baseUrl = process.env.RECHARGE_BASE_URL?.trim() || DEFAULT_RECHARGE_BASE_URL;
  const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return `${normalizedBaseUrl}${encodeURIComponent(target)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class TypingTicketCache {
  private readonly tickets = new Map<string, string>();

  get(userId: string): string | null {
    return this.tickets.get(userId) ?? null;
  }

  set(userId: string, ticket: string): void {
    this.tickets.set(userId, ticket);
  }
}
