// OpenAI-compatible HTTP surface for the grok-dev agent, so any client can
// drive the cloud agent over an API (not only Telegram). Runs on $PORT next to
// the Telegram bridge and serves Railway's /healthz.
//
// This is an AGENTIC endpoint: each request runs the full tool-using agent in
// the container workspace, not a raw model proxy.
//
// Endpoints:
//   GET  /healthz               — always public
//   GET  /v1/models             — static list (bearer)
//   POST /v1/chat/completions   — bearer; streaming (SSE) or JSON
//
// Auth: Authorization: Bearer $APP_SERVER_TOKEN. If APP_SERVER_TOKEN is unset,
// the API is disabled (health stays up) so we never expose an unauthenticated
// agent by accident.

import * as fs from "node:fs";
import { Agent } from "../src/agent/agent";

const PORT = Number(process.env.PORT ?? 3000);
const APP_TOKEN = process.env.APP_SERVER_TOKEN ?? "";
const AUTH_MODE = process.env.GROK_AUTH_MODE ?? "static";
const OAUTH_STORE = process.env.GROK_OAUTH_STORE ?? `${process.env.HOME ?? ""}/.grok/oauth.json`;
const BASE_URL = process.env.GROK_BASE_URL ?? "https://api.x.ai/v1";
const MODEL = process.env.GROK_MODEL ?? "grok-4.3";
const MAX_TOOL_ROUNDS = Number(process.env.GROK_MAX_TOOL_ROUNDS ?? 400);
const WORKSPACE = process.env.GROK_WORKSPACE ?? "/data/workspace";

// The agent's shell/file tools operate on process.cwd().
try {
  fs.mkdirSync(WORKSPACE, { recursive: true });
  process.chdir(WORKSPACE);
} catch {
  /* fall back to the current directory */
}

/** Current xAI credential: the rotating OAuth access token, or a static key. */
function currentToken(): string | undefined {
  if (AUTH_MODE === "oauth") {
    try {
      return (JSON.parse(fs.readFileSync(OAUTH_STORE, "utf8")) as { access_token?: string }).access_token;
    } catch {
      return undefined;
    }
  }
  return process.env.GROK_API_KEY || undefined;
}

interface ChatMessage {
  role: string;
  content: string | { type: string; text?: string }[];
}

function messageText(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((p) => (p.type === "text" ? (p.text ?? "") : ""))
    .join("")
    .trim();
}

// One long-lived Agent per client session id, and a per-session queue so
// concurrent requests to the same session run one turn at a time (the agent
// keeps a single abort controller + history).
const agents = new Map<string, Agent>();
const tails = new Map<string, Promise<unknown>>();

// The Agent `session` option RESUMES an existing persisted session (and throws
// if it does not exist). Client session ids are arbitrary, so map each to a
// real grok session id on the volume: create fresh the first time, resume after
// (survives restarts).
const SESSION_MAP = `${process.env.HOME ?? ""}/.grok/app-sessions.json`;

function loadSessionMap(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(SESSION_MAP, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

function saveSessionMapping(clientId: string, grokSessionId: string): void {
  const map = loadSessionMap();
  if (map[clientId] === grokSessionId) return;
  map[clientId] = grokSessionId;
  try {
    fs.mkdirSync(SESSION_MAP.replace(/\/[^/]+$/, ""), { recursive: true });
    fs.writeFileSync(SESSION_MAP, JSON.stringify(map, null, 2), { mode: 0o600 });
  } catch {
    /* best effort; in-memory continuity still holds for this process */
  }
}

function newAgent(resumeSessionId?: string): Agent {
  return new Agent(currentToken(), BASE_URL, MODEL, MAX_TOOL_ROUNDS, {
    session: resumeSessionId,
    sandboxMode: "off",
  });
}

function getAgent(clientId: string): Agent {
  const existing = agents.get(clientId);
  if (existing) {
    const token = currentToken();
    if (token) existing.setApiKey(token, BASE_URL); // pick up a rotated OAuth token
    return existing;
  }

  const known = loadSessionMap()[clientId];
  let agent: Agent;
  try {
    agent = newAgent(known); // resume if we have a mapping, else create fresh
  } catch {
    agent = newAgent(); // mapped session vanished (e.g. volume reset) → start fresh
  }
  const grokSessionId = agent.getSessionId();
  if (grokSessionId) saveSessionMapping(clientId, grokSessionId);
  agents.set(clientId, agent);
  return agent;
}

function enqueue<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(sessionId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  tails.set(
    sessionId,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

function unauthorized(): Response {
  return Response.json({ error: { message: "Unauthorized", type: "invalid_request_error" } }, { status: 401 });
}

function isAuthorized(req: Request): boolean {
  if (!APP_TOKEN) return false;
  return req.headers.get("authorization") === `Bearer ${APP_TOKEN}`;
}

function chatId(): string {
  return `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

async function handleChat(req: Request): Promise<Response> {
  if (!isAuthorized(req)) return unauthorized();
  if (!currentToken()) {
    return Response.json({ error: { message: "No xAI credential available", type: "server_error" } }, { status: 503 });
  }

  let body: { messages?: ChatMessage[]; stream?: boolean; model?: string; user?: string; session?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }, { status: 400 });
  }

  const messages = body.messages ?? [];
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const prompt = lastUser ? messageText(lastUser.content) : "";
  if (!prompt) {
    return Response.json({ error: { message: "No user message", type: "invalid_request_error" } }, { status: 400 });
  }

  const sessionId = body.session ?? body.user ?? "default";
  const id = chatId();
  const created = Math.floor(Date.now() / 1000);
  const model = body.model ?? MODEL;

  if (body.stream) {
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        const send = (obj: unknown) => controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
        enqueue(sessionId, async () => {
          try {
            const agent = getAgent(sessionId);
            for await (const chunk of agent.processMessage(prompt)) {
              if (chunk.type === "content" && chunk.content) {
                send({
                  id,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  choices: [{ index: 0, delta: { content: chunk.content }, finish_reason: null }],
                });
              } else if (chunk.type === "error") {
                send({
                  id,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  choices: [
                    {
                      index: 0,
                      delta: { content: `\n[error] ${chunk.content ?? "agent error"}` },
                      finish_reason: null,
                    },
                  ],
                });
              }
            }
            send({
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            });
          } catch (err) {
            send({
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: { content: `\n[error] ${err instanceof Error ? err.message : String(err)}` },
                  finish_reason: "stop",
                },
              ],
            });
          } finally {
            controller.enqueue(enc.encode("data: [DONE]\n\n"));
            controller.close();
          }
        });
      },
    });
    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
    });
  }

  // Non-streaming: accumulate the assistant text, and capture any error the
  // agent emits (e.g. billing/quota) so callers get a real error instead of a
  // misleading "(no text output)".
  return enqueue(sessionId, async () => {
    let text = "";
    let errorText = "";
    try {
      const agent = getAgent(sessionId);
      for await (const chunk of agent.processMessage(prompt)) {
        if (chunk.type === "content" && chunk.content) text += chunk.content;
        else if (chunk.type === "error" && chunk.content) errorText += chunk.content;
      }
    } catch (err) {
      return Response.json(
        { error: { message: err instanceof Error ? err.message : String(err), type: "server_error" } },
        { status: 502 },
      );
    }
    // The agent failed with no usable text (e.g. out of credits) — surface the
    // error so the client can react (the bridge maps it to a billing notice)
    // rather than returning an empty "(no text output)" completion.
    if (!text && errorText) {
      return Response.json({ error: { message: errorText, type: "server_error" } }, { status: 502 });
    }
    return Response.json({
      id,
      object: "chat.completion",
      created,
      model,
      choices: [
        { index: 0, message: { role: "assistant", content: text || "(no text output)" }, finish_reason: "stop" },
      ],
    });
  });
}

Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  idleTimeout: 255, // agent turns can be slow
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/healthz" || pathname === "/") {
      return Response.json({
        ok: true,
        service: "grok-app-server",
        authMode: AUTH_MODE,
        apiEnabled: Boolean(APP_TOKEN),
        telegramBot: Boolean(process.env.TELEGRAM_BOT_TOKEN),
      });
    }
    if (pathname === "/v1/models") {
      if (!isAuthorized(req)) return unauthorized();
      return Response.json({
        object: "list",
        data: [{ id: MODEL, object: "model", created: 0, owned_by: "xai" }],
      });
    }
    if (pathname === "/v1/chat/completions" && req.method === "POST") {
      return handleChat(req);
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`[app-server] listening on :${PORT} (auth ${APP_TOKEN ? "on" : "OFF — API disabled"}, mode ${AUTH_MODE})`);
