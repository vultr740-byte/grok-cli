import path from "node:path";

import type { InboundAttachment } from "../../types.js";

// grok's app-server consumes only the last user message (it has no system/
// developer channel), and the weixin bridge runs in the same container as the
// app-server, so downloaded attachments live on a shared filesystem. We surface
// inbound attachments to grok by appending their local paths to the user text —
// grok can then read them with its file tools.
function formatInboundAttachments(attachments: InboundAttachment[]): string {
  const lines = attachments.map((att) => {
    const name = att.fileName?.trim() || path.basename(att.localPath);
    let line = `- ${name} (${att.kind}) — path: ${att.localPath}`;
    if (att.transcriptText?.trim()) {
      line += `\n  transcript: ${att.transcriptText.trim()}`;
    }
    return line;
  });
  return `Weixin attachments:\n${lines.join("\n")}`;
}

// grok provider for the weixin bridge — a drop-in replacement for the codex
// app-server client. Same surface (ensureConnected / startThread / sendTurn /
// close) and result shape ({ assistantText, threadId, turnId }), but it drives
// grok's OpenAI-compatible HTTP app-server instead of codex's WebSocket
// app-server. A grok "thread" is just a session id the app-server persists, so
// there is no connection or thread protocol to speak.

export type GrokTurnResult = {
  assistantText: string;
  threadId: string;
  turnId: string | null;
};

export class GrokHttpClient {
  private readonly httpUrl: string;
  private readonly token: string;
  private readonly model?: string;
  private readonly turnTimeoutMs: number;

  constructor(params: { httpUrl: string; token: string; model?: string; turnTimeoutMs?: number }) {
    this.httpUrl = params.httpUrl.replace(/\/+$/, "");
    this.token = params.token;
    this.model = params.model;
    this.turnTimeoutMs = params.turnTimeoutMs ?? 30 * 60 * 1000;
  }

  async ensureConnected(): Promise<void> {
    // grok's HTTP API is stateless — nothing to keep open. Best-effort probe.
    try {
      const res = await fetch(`${this.httpUrl}/healthz`);
      if (!res.ok) {
        console.warn(`[grok] healthz not ok: ${res.status}`);
      }
    } catch (error) {
      console.warn(`[grok] healthz failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async startThread(): Promise<string> {
    // A grok session is an opaque id the app-server creates on first use.
    return `grok-${crypto.randomUUID()}`;
  }

  async sendTurn(params: {
    threadId: string;
    text: string;
    attachments?: InboundAttachment[];
    clientUserMessageId?: string | null;
    timeoutMs?: number;
  }): Promise<GrokTurnResult> {
    const content = params.attachments?.length
      ? [params.text, formatInboundAttachments(params.attachments)].filter((part) => part.trim()).join("\n\n")
      : params.text;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), params.timeoutMs ?? this.turnTimeoutMs);
    try {
      const res = await fetch(`${this.httpUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(this.model ? { model: this.model } : {}),
          messages: [{ role: "user", content }],
          session: params.threadId,
        }),
        signal: controller.signal,
      });
      const data = (await res.json()) as {
        id?: string;
        choices?: { message?: { content?: string } }[];
        error?: { message?: string };
      };
      if (!res.ok) {
        throw new Error(`grok app-server ${res.status}: ${data.error?.message ?? JSON.stringify(data)}`);
      }
      return {
        assistantText: data.choices?.[0]?.message?.content ?? "",
        threadId: params.threadId,
        turnId: data.id ?? null,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async close(): Promise<void> {
    // Stateless HTTP; nothing to tear down.
  }
}
