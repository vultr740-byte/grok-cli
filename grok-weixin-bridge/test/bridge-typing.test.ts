import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Bridge } from "../src/core/bridge.js";

test("bridge sends and cancels Weixin typing while a Codex turn is running", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-bridge-"));
  const receivedWeixinRequests: Array<{ endpoint: string; body: Record<string, unknown> }> = [];
  let getUpdatesCount = 0;

  const weixinServer = http.createServer((req, res) => {
    const endpoint = new URL(req.url ?? "/", "http://localhost").pathname.replace(/^\/+/, "");
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk.toString("utf8");
    });
    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      receivedWeixinRequests.push({ endpoint, body });
      res.setHeader("content-type", "application/json");

      if (endpoint === "ilink/bot/getupdates") {
        getUpdatesCount += 1;
        if (getUpdatesCount === 1) {
          res.end(
            JSON.stringify({
              ret: 0,
              get_updates_buf: "buf-1",
              msgs: [
                {
                  message_id: "msg-1",
                  from_user_id: "user-1",
                  context_token: "ctx-1",
                  item_list: [{ type: 1, text_item: { text: "hello" } }],
                },
              ],
            }),
          );
          return;
        }
        res.end(JSON.stringify({ ret: 0, get_updates_buf: "buf-1", msgs: [] }));
        return;
      }

      if (endpoint === "ilink/bot/getconfig") {
        res.end(JSON.stringify({ ret: 0, typing_ticket: "ticket-1" }));
        return;
      }

      res.end(JSON.stringify({ ret: 0 }));
    });
  });

  const weixinBaseUrl = await listen(weixinServer);
  const appServer = await startGrokAppServerMock(() => ({ content: "hi" }));
  const appServerUrl = appServer.url;
  const bridge = new Bridge({
    appServerUrl,
    appServerToken: "codex-token",
    weixinBaseUrl,
    weixinCdnBaseUrl: weixinBaseUrl,
    weixinToken: "weixin-token",
    controlApiToken: null,
    stateDir,
    uploadDir: path.join(stateDir, "uploads"),
    codexThreadMode: "per_user",
    defaultCwd: null,
    codexTurnTimeoutMs: 180_000,
  });

  const bridgeTask = bridge.start();

  try {
    await waitFor(
      () =>
        receivedWeixinRequests.filter((request) => request.endpoint === "ilink/bot/sendtyping").length >= 2 &&
        receivedWeixinRequests.some((request) => request.endpoint === "ilink/bot/sendmessage"),
    );
  } finally {
    await bridge.stop();
    await appServer.close();
    weixinServer.close();
    await bridgeTask;
  }

  const typingStatuses = receivedWeixinRequests
    .filter((request) => request.endpoint === "ilink/bot/sendtyping")
    .map((request) => request.body.status);
  assert.deepEqual(typingStatuses, [1, 2]);

  const configRequest = receivedWeixinRequests.find((request) => request.endpoint === "ilink/bot/getconfig");
  assert.equal(configRequest?.body.ilink_user_id, "user-1");
  assert.equal(configRequest?.body.context_token, "ctx-1");

  const sendMessageRequest = receivedWeixinRequests.find((request) => request.endpoint === "ilink/bot/sendmessage");
  const sentMessage = sendMessageRequest?.body.msg as
    | { to_user_id?: string; item_list?: Array<{ text_item?: { text?: string } }> }
    | undefined;
  assert.equal(sentMessage?.to_user_id, "user-1");
  assert.equal(sentMessage?.item_list?.[0]?.text_item?.text, "hi");
});

test("bridge refreshes a stale Codex thread binding when the app-server no longer has the thread", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-bridge-"));
  fs.writeFileSync(
    path.join(stateDir, "thread-bindings.json"),
    JSON.stringify({
      bindings: [
        {
          weixinUserId: "user-1",
          codexThreadId: "old-thread",
          updatedAt: 1,
        },
      ],
    }),
    "utf8",
  );
  const receivedWeixinRequests: Array<{ endpoint: string; body: Record<string, unknown> }> = [];
  let getUpdatesCount = 0;

  const weixinServer = http.createServer((req, res) => {
    const endpoint = new URL(req.url ?? "/", "http://localhost").pathname.replace(/^\/+/, "");
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk.toString("utf8");
    });
    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      receivedWeixinRequests.push({ endpoint, body });
      res.setHeader("content-type", "application/json");

      if (endpoint === "ilink/bot/getupdates") {
        getUpdatesCount += 1;
        if (getUpdatesCount === 1) {
          res.end(
            JSON.stringify({
              ret: 0,
              get_updates_buf: "buf-1",
              msgs: [
                {
                  message_id: "msg-1",
                  from_user_id: "user-1",
                  context_token: "ctx-1",
                  item_list: [{ type: 1, text_item: { text: "hello" } }],
                },
              ],
            }),
          );
          return;
        }
        res.end(JSON.stringify({ ret: 0, get_updates_buf: "buf-1", msgs: [] }));
        return;
      }

      if (endpoint === "ilink/bot/getconfig") {
        res.end(JSON.stringify({ ret: 0, typing_ticket: "ticket-1" }));
        return;
      }

      res.end(JSON.stringify({ ret: 0 }));
    });
  });

  const weixinBaseUrl = await listen(weixinServer);
  // The first turn reuses the stale "old-thread" binding; the app-server reports
  // it as missing, the bridge starts a fresh grok session and retries.
  const appServer = await startGrokAppServerMock((request, callIndex) =>
    callIndex === 0 ? { status: 404, message: `thread not found: ${request.session}` } : { content: "fresh reply" },
  );
  const appServerUrl = appServer.url;
  const bridge = new Bridge({
    appServerUrl,
    appServerToken: "codex-token",
    weixinBaseUrl,
    weixinCdnBaseUrl: weixinBaseUrl,
    weixinToken: "weixin-token",
    controlApiToken: null,
    stateDir,
    uploadDir: path.join(stateDir, "uploads"),
    codexThreadMode: "per_user",
    defaultCwd: null,
    codexTurnTimeoutMs: 180_000,
  });

  const bridgeTask = bridge.start();

  try {
    await waitFor(() => receivedWeixinRequests.some((request) => request.endpoint === "ilink/bot/sendmessage"));
  } finally {
    await bridge.stop();
    await appServer.close();
    weixinServer.close();
    await bridgeTask;
  }

  const turnSessions = appServer.requests.map((request) => request.session);
  assert.equal(turnSessions.length, 2);
  assert.equal(turnSessions[0], "old-thread");
  assert.notEqual(turnSessions[1], "old-thread");
  assert.match(turnSessions[1] ?? "", /^grok-/);

  const sendMessageRequests = receivedWeixinRequests.filter((request) => request.endpoint === "ilink/bot/sendmessage");
  assert.equal(sendMessageRequests.length, 1);
  const sentMessage = sendMessageRequests[0]?.body.msg as
    | { to_user_id?: string; item_list?: Array<{ text_item?: { text?: string } }> }
    | undefined;
  const sentText = sentMessage?.item_list?.[0]?.text_item?.text ?? "";
  assert.equal(sentMessage?.to_user_id, "user-1");
  assert.equal(sentText, "fresh reply");
  assert.doesNotMatch(sentText, /thread not found/);

  const bindingFile = JSON.parse(fs.readFileSync(path.join(stateDir, "thread-bindings.json"), "utf8")) as {
    bindings: Array<{ weixinUserId: string; codexThreadId: string; updatedAt: number }>;
  };
  assert.equal(bindingFile.bindings.length, 1);
  assert.equal(bindingFile.bindings[0]?.weixinUserId, "user-1");
  assert.equal(bindingFile.bindings[0]?.codexThreadId, turnSessions[1]);
  assert.ok(bindingFile.bindings[0]?.updatedAt > 1);
});

test("bridge downloads Weixin file attachments and forwards local paths to Codex", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-bridge-"));
  const uploadDir = path.join(stateDir, "uploads");
  const plaintext = Buffer.from("hello from attachment", "utf8");
  const imageBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const aesKey = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  const encrypted = encryptAesEcb(plaintext, aesKey);
  const aesKeyBase64 = Buffer.from(aesKey.toString("hex"), "utf8").toString("base64");
  const receivedWeixinRequests: Array<{ endpoint: string; body: Record<string, unknown> }> = [];
  let getUpdatesCount = 0;

  const cdnServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/download" && url.searchParams.get("encrypted_query_param") === "file-param") {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(encrypted);
      return;
    }
    if (url.pathname === "/download" && url.searchParams.get("encrypted_query_param") === "image-param") {
      res.writeHead(200, { "content-type": "image/jpeg" });
      res.end(imageBytes);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  const cdnBaseUrl = await listen(cdnServer);

  const weixinServer = http.createServer((req, res) => {
    const endpoint = new URL(req.url ?? "/", "http://localhost").pathname.replace(/^\/+/, "");
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk.toString("utf8");
    });
    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      receivedWeixinRequests.push({ endpoint, body });
      res.setHeader("content-type", "application/json");

      if (endpoint === "ilink/bot/getupdates") {
        getUpdatesCount += 1;
        if (getUpdatesCount === 1) {
          res.end(
            JSON.stringify({
              ret: 0,
              get_updates_buf: "buf-1",
              msgs: [
                {
                  message_id: "msg-1",
                  from_user_id: "user-1",
                  context_token: "ctx-1",
                  item_list: [
                    { type: 1, text_item: { text: "please inspect this" } },
                    {
                      type: 2,
                      image_item: {
                        media: {
                          encrypt_query_param: "image-param",
                        },
                      },
                    },
                    {
                      type: 4,
                      file_item: {
                        file_name: "report.txt",
                        media: {
                          encrypt_query_param: "file-param",
                          aes_key: aesKeyBase64,
                        },
                      },
                    },
                  ],
                },
              ],
            }),
          );
          return;
        }
        res.end(JSON.stringify({ ret: 0, get_updates_buf: "buf-1", msgs: [] }));
        return;
      }

      if (endpoint === "ilink/bot/getconfig") {
        res.end(JSON.stringify({ ret: 0, typing_ticket: "ticket-1" }));
        return;
      }

      res.end(JSON.stringify({ ret: 0 }));
    });
  });

  const weixinBaseUrl = await listen(weixinServer);
  const appServer = await startGrokAppServerMock(() => ({ content: "read attachment" }));
  const appServerUrl = appServer.url;
  const bridge = new Bridge({
    appServerUrl,
    appServerToken: "codex-token",
    weixinBaseUrl,
    weixinCdnBaseUrl: cdnBaseUrl,
    weixinToken: "weixin-token",
    controlApiToken: null,
    stateDir,
    uploadDir,
    codexThreadMode: "per_user",
    defaultCwd: null,
    codexTurnTimeoutMs: 180_000,
  });

  const bridgeTask = bridge.start();

  try {
    await waitFor(() => receivedWeixinRequests.some((request) => request.endpoint === "ilink/bot/sendmessage"));
  } finally {
    await bridge.stop();
    await appServer.close();
    weixinServer.close();
    cdnServer.close();
    await bridgeTask;
  }

  assert.equal(appServer.requests.length, 1);
  const turnContent = appServer.requests[0]?.content ?? "";
  assert.match(turnContent, /please inspect this/);
  assert.match(turnContent, /Weixin attachments:/);
  assert.match(turnContent, /report\.txt/);
  const savedPath = turnContent.match(/path: (.+report-[^\n]+\.txt)/)?.[1];
  assert.ok(savedPath);
  assert.equal(fs.readFileSync(savedPath, "utf8"), "hello from attachment");
  const imagePath = turnContent.match(/path: (.+image-[^\n]+\.jpg)/)?.[1];
  assert.ok(imagePath);
  assert.equal(fs.readFileSync(imagePath).equals(imageBytes), true);
});

test("bridge sends Codex-declared output files as native Weixin attachments", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-bridge-"));
  const outputFile = path.join(stateDir, "answer.zip");
  fs.writeFileSync(outputFile, "zip bytes", "utf8");
  const receivedWeixinRequests: Array<{ endpoint: string; body: Record<string, unknown> }> = [];
  const uploadedCdnBodies: Buffer[] = [];
  let cdnUploadAttempts = 0;
  let getUpdatesCount = 0;

  const cdnServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "POST" && url.pathname === "/upload") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      req.on("end", () => {
        cdnUploadAttempts += 1;
        uploadedCdnBodies.push(Buffer.concat(chunks));
        if (cdnUploadAttempts === 1) {
          res.writeHead(500);
          res.end("temporary cdn error");
          return;
        }
        res.setHeader("x-encrypted-param", "uploaded-param");
        res.end("ok");
      });
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  const cdnBaseUrl = await listen(cdnServer);

  const weixinServer = http.createServer((req, res) => {
    const endpoint = new URL(req.url ?? "/", "http://localhost").pathname.replace(/^\/+/, "");
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk.toString("utf8");
    });
    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      receivedWeixinRequests.push({ endpoint, body });
      res.setHeader("content-type", "application/json");

      if (endpoint === "ilink/bot/getupdates") {
        getUpdatesCount += 1;
        if (getUpdatesCount === 1) {
          res.end(
            JSON.stringify({
              ret: 0,
              get_updates_buf: "buf-1",
              msgs: [
                {
                  message_id: "msg-1",
                  from_user_id: "user-1",
                  context_token: "ctx-1",
                  item_list: [{ type: 1, text_item: { text: "send me the zip" } }],
                },
              ],
            }),
          );
          return;
        }
        res.end(JSON.stringify({ ret: 0, get_updates_buf: "buf-1", msgs: [] }));
        return;
      }

      if (endpoint === "ilink/bot/getconfig") {
        res.end(JSON.stringify({ ret: 0, typing_ticket: "ticket-1" }));
        return;
      }

      if (endpoint === "ilink/bot/getuploadurl") {
        res.end(
          JSON.stringify({
            ret: 0,
            upload_param: "upload-param",
          }),
        );
        return;
      }

      res.end(JSON.stringify({ ret: 0 }));
    });
  });

  const weixinBaseUrl = await listen(weixinServer);
  const appServer = await startGrokAppServerMock(() => ({
    content: [
      "Here is the zip.",
      "",
      "```codex-weixin-attachments",
      JSON.stringify({ attachments: [{ path: outputFile, caption: "zip file" }] }),
      "```",
    ].join("\n"),
  }));
  const appServerUrl = appServer.url;
  const bridge = new Bridge({
    appServerUrl,
    appServerToken: "codex-token",
    weixinBaseUrl,
    weixinCdnBaseUrl: cdnBaseUrl,
    weixinToken: "weixin-token",
    controlApiToken: null,
    stateDir,
    uploadDir: path.join(stateDir, "uploads"),
    codexThreadMode: "per_user",
    defaultCwd: null,
    codexTurnTimeoutMs: 180_000,
  });

  const bridgeTask = bridge.start();

  try {
    await waitFor(
      () => receivedWeixinRequests.filter((request) => request.endpoint === "ilink/bot/sendmessage").length >= 3,
    );
  } finally {
    await bridge.stop();
    await appServer.close();
    weixinServer.close();
    cdnServer.close();
    await bridgeTask;
  }

  // The outbound-attachment protocol instruction lives in grok's app-server
  // system prompt (not the bridge), so there is nothing to assert on the request.
  assert.equal(uploadedCdnBodies.length, 2);

  const sendMessages = receivedWeixinRequests.filter((request) => request.endpoint === "ilink/bot/sendmessage");
  const textMessage = sendMessages[0]?.body.msg as { item_list?: Array<{ text_item?: { text?: string } }> } | undefined;
  assert.equal(textMessage?.item_list?.length, 1);
  assert.equal(textMessage?.item_list?.[0]?.text_item?.text, "Here is the zip.");
  assert.doesNotMatch(textMessage?.item_list?.[0]?.text_item?.text ?? "", /codex-weixin-attachments/);

  const captionMessage = sendMessages[1]?.body.msg as
    | { item_list?: Array<{ text_item?: { text?: string } }> }
    | undefined;
  assert.equal(captionMessage?.item_list?.length, 1);
  assert.equal(captionMessage?.item_list?.[0]?.text_item?.text, "zip file");

  const fileMessage = sendMessages[2]?.body.msg as
    | {
        item_list?: Array<{
          text_item?: { text?: string };
          file_item?: {
            file_name?: string;
            len?: string;
            media?: { encrypt_query_param?: string; aes_key?: string };
          };
        }>;
      }
    | undefined;
  assert.equal(fileMessage?.item_list?.length, 1);
  assert.equal(fileMessage?.item_list?.[0]?.file_item?.file_name, "answer.zip");
  assert.equal(fileMessage?.item_list?.[0]?.file_item?.len, String(Buffer.byteLength("zip bytes")));
  assert.equal(fileMessage?.item_list?.[0]?.file_item?.media?.encrypt_query_param, "uploaded-param");
  assert.ok(fileMessage?.item_list?.[0]?.file_item?.media?.aes_key);
});

test("bridge normalizes Codex-declared images before Weixin CDN upload", async (t) => {
  const hasFfmpeg = await commandExists("ffmpeg");
  const hasFfprobe = await commandExists("ffprobe");
  if (!hasFfmpeg || !hasFfprobe) {
    t.skip("ffmpeg/ffprobe are not available");
    return;
  }

  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-bridge-"));
  const imageFile = path.join(stateDir, "large.bmp");
  fs.writeFileSync(imageFile, makeBmpImage(1_024, 1_024));
  const originalSize = fs.statSync(imageFile).size;
  assert.ok(originalSize > 200 * 1024);

  const receivedWeixinRequests: Array<{ endpoint: string; body: Record<string, unknown> }> = [];
  const uploadedCdnBodies: Buffer[] = [];
  let getUpdatesCount = 0;

  const cdnServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "POST" && url.pathname === "/upload") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      req.on("end", () => {
        uploadedCdnBodies.push(Buffer.concat(chunks));
        res.setHeader("x-encrypted-param", "image-param");
        res.end("ok");
      });
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  const cdnBaseUrl = await listen(cdnServer);

  const weixinServer = http.createServer((req, res) => {
    const endpoint = new URL(req.url ?? "/", "http://localhost").pathname.replace(/^\/+/, "");
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk.toString("utf8");
    });
    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      receivedWeixinRequests.push({ endpoint, body });
      res.setHeader("content-type", "application/json");

      if (endpoint === "ilink/bot/getupdates") {
        getUpdatesCount += 1;
        if (getUpdatesCount === 1) {
          res.end(
            JSON.stringify({
              ret: 0,
              get_updates_buf: "buf-1",
              msgs: [
                {
                  message_id: "msg-1",
                  from_user_id: "user-1",
                  context_token: "ctx-1",
                  item_list: [{ type: 1, text_item: { text: "send me the image" } }],
                },
              ],
            }),
          );
          return;
        }
        res.end(JSON.stringify({ ret: 0, get_updates_buf: "buf-1", msgs: [] }));
        return;
      }

      if (endpoint === "ilink/bot/getconfig") {
        res.end(JSON.stringify({ ret: 0, typing_ticket: "ticket-1" }));
        return;
      }

      if (endpoint === "ilink/bot/getuploadurl") {
        res.end(
          JSON.stringify({
            ret: 0,
            upload_param: "upload-param",
          }),
        );
        return;
      }

      res.end(JSON.stringify({ ret: 0 }));
    });
  });

  const weixinBaseUrl = await listen(weixinServer);
  const appServer = await startGrokAppServerMock(() => ({
    content: [
      "Here is the image.",
      "",
      "```codex-weixin-attachments",
      JSON.stringify({ attachments: [{ path: imageFile }] }),
      "```",
    ].join("\n"),
  }));
  const appServerUrl = appServer.url;
  const bridge = new Bridge({
    appServerUrl,
    appServerToken: "codex-token",
    weixinBaseUrl,
    weixinCdnBaseUrl: cdnBaseUrl,
    weixinToken: "weixin-token",
    controlApiToken: null,
    stateDir,
    uploadDir: path.join(stateDir, "uploads"),
    codexThreadMode: "per_user",
    defaultCwd: null,
    codexTurnTimeoutMs: 180_000,
  });

  const bridgeTask = bridge.start();

  try {
    await waitFor(() =>
      receivedWeixinRequests.some(
        (request) =>
          request.endpoint === "ilink/bot/sendmessage" &&
          (request.body.msg as { item_list?: Array<{ image_item?: unknown }> } | undefined)?.item_list?.some(
            (item) => item.image_item,
          ),
      ),
    );
  } finally {
    await bridge.stop();
    await appServer.close();
    weixinServer.close();
    cdnServer.close();
    await bridgeTask;
  }

  assert.equal(uploadedCdnBodies.length, 1);
  assert.ok(uploadedCdnBodies[0].length < originalSize);

  const uploadRequest = receivedWeixinRequests.find((request) => request.endpoint === "ilink/bot/getuploadurl");
  assert.ok(uploadRequest);
  assert.ok(Number(uploadRequest.body.rawsize) < originalSize);
});

test("bridge uploads original image attachments when media tools are unavailable", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-bridge-"));
  const imageFile = path.join(stateDir, "large.bmp");
  fs.writeFileSync(imageFile, makeBmpImage(1_024, 1_024));
  const originalSize = fs.statSync(imageFile).size;
  const receivedWeixinRequests: Array<{ endpoint: string; body: Record<string, unknown> }> = [];
  const uploadedCdnBodies: Buffer[] = [];
  let getUpdatesCount = 0;

  const cdnServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "POST" && url.pathname === "/upload") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      req.on("end", () => {
        uploadedCdnBodies.push(Buffer.concat(chunks));
        res.setHeader("x-encrypted-param", "image-param");
        res.end("ok");
      });
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  const cdnBaseUrl = await listen(cdnServer);

  const weixinServer = http.createServer((req, res) => {
    const endpoint = new URL(req.url ?? "/", "http://localhost").pathname.replace(/^\/+/, "");
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk.toString("utf8");
    });
    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      receivedWeixinRequests.push({ endpoint, body });
      res.setHeader("content-type", "application/json");

      if (endpoint === "ilink/bot/getupdates") {
        getUpdatesCount += 1;
        if (getUpdatesCount === 1) {
          res.end(
            JSON.stringify({
              ret: 0,
              get_updates_buf: "buf-1",
              msgs: [
                {
                  message_id: "msg-1",
                  from_user_id: "user-1",
                  context_token: "ctx-1",
                  item_list: [{ type: 1, text_item: { text: "send me the image" } }],
                },
              ],
            }),
          );
          return;
        }
        res.end(JSON.stringify({ ret: 0, get_updates_buf: "buf-1", msgs: [] }));
        return;
      }

      if (endpoint === "ilink/bot/getconfig") {
        res.end(JSON.stringify({ ret: 0, typing_ticket: "ticket-1" }));
        return;
      }

      if (endpoint === "ilink/bot/getuploadurl") {
        res.end(
          JSON.stringify({
            ret: 0,
            upload_param: "upload-param",
          }),
        );
        return;
      }

      res.end(JSON.stringify({ ret: 0 }));
    });
  });

  const weixinBaseUrl = await listen(weixinServer);
  const appServer = await startGrokAppServerMock(() => ({
    content: ["```codex-weixin-attachments", JSON.stringify({ attachments: [{ path: imageFile }] }), "```"].join("\n"),
  }));

  const previousFfmpegPath = process.env.CODEX_WEIXIN_FFMPEG_PATH;
  const previousFfprobePath = process.env.CODEX_WEIXIN_FFPROBE_PATH;
  process.env.CODEX_WEIXIN_FFMPEG_PATH = path.join(stateDir, "missing-ffmpeg");
  process.env.CODEX_WEIXIN_FFPROBE_PATH = path.join(stateDir, "missing-ffprobe");

  const appServerUrl = appServer.url;
  const bridge = new Bridge({
    appServerUrl,
    appServerToken: "codex-token",
    weixinBaseUrl,
    weixinCdnBaseUrl: cdnBaseUrl,
    weixinToken: "weixin-token",
    controlApiToken: null,
    stateDir,
    uploadDir: path.join(stateDir, "uploads"),
    codexThreadMode: "per_user",
    defaultCwd: null,
    codexTurnTimeoutMs: 180_000,
  });

  const bridgeTask = bridge.start();

  try {
    await waitFor(() =>
      receivedWeixinRequests.some(
        (request) =>
          request.endpoint === "ilink/bot/sendmessage" &&
          (request.body.msg as { item_list?: Array<{ image_item?: unknown }> } | undefined)?.item_list?.some(
            (item) => item.image_item,
          ),
      ),
    );
  } finally {
    if (previousFfmpegPath === undefined) {
      delete process.env.CODEX_WEIXIN_FFMPEG_PATH;
    } else {
      process.env.CODEX_WEIXIN_FFMPEG_PATH = previousFfmpegPath;
    }
    if (previousFfprobePath === undefined) {
      delete process.env.CODEX_WEIXIN_FFPROBE_PATH;
    } else {
      process.env.CODEX_WEIXIN_FFPROBE_PATH = previousFfprobePath;
    }
    await bridge.stop();
    await appServer.close();
    weixinServer.close();
    cdnServer.close();
    await bridgeTask;
  }

  assert.equal(uploadedCdnBodies.length, 1);
  assert.ok(uploadedCdnBodies[0].length > originalSize);

  const uploadRequest = receivedWeixinRequests.find((request) => request.endpoint === "ilink/bot/getuploadurl");
  assert.ok(uploadRequest);
  assert.equal(uploadRequest.body.rawsize, originalSize);
  assert.equal(
    receivedWeixinRequests.some(
      (request) =>
        request.endpoint === "ilink/bot/sendmessage" &&
        /附件发送失败/u.test(
          (request.body.msg as { item_list?: Array<{ text_item?: { text?: string } }> } | undefined)?.item_list?.[0]
            ?.text_item?.text ?? "",
        ),
    ),
    false,
  );
});

test("bridge falls back from upload_full_url to upload_param when Weixin CDN rejects the full URL", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-bridge-"));
  const outputFile = path.join(stateDir, "answer.zip");
  fs.writeFileSync(outputFile, "zip bytes", "utf8");
  const receivedWeixinRequests: Array<{ endpoint: string; body: Record<string, unknown> }> = [];
  const uploadPaths: string[] = [];
  let getUpdatesCount = 0;

  const cdnServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "POST" && (url.pathname === "/full-upload" || url.pathname === "/upload")) {
      req.resume();
      req.on("end", () => {
        uploadPaths.push(url.pathname);
        if (url.pathname === "/full-upload") {
          res.writeHead(500);
          res.end("full url failed");
          return;
        }
        res.setHeader("x-encrypted-param", "fallback-param");
        res.end("ok");
      });
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  const cdnBaseUrl = await listen(cdnServer);

  const weixinServer = http.createServer((req, res) => {
    const endpoint = new URL(req.url ?? "/", "http://localhost").pathname.replace(/^\/+/, "");
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk.toString("utf8");
    });
    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      receivedWeixinRequests.push({ endpoint, body });
      res.setHeader("content-type", "application/json");

      if (endpoint === "ilink/bot/getupdates") {
        getUpdatesCount += 1;
        if (getUpdatesCount === 1) {
          res.end(
            JSON.stringify({
              ret: 0,
              get_updates_buf: "buf-1",
              msgs: [
                {
                  message_id: "msg-1",
                  from_user_id: "user-1",
                  context_token: "ctx-1",
                  item_list: [{ type: 1, text_item: { text: "send me the zip" } }],
                },
              ],
            }),
          );
          return;
        }
        res.end(JSON.stringify({ ret: 0, get_updates_buf: "buf-1", msgs: [] }));
        return;
      }

      if (endpoint === "ilink/bot/getconfig") {
        res.end(JSON.stringify({ ret: 0, typing_ticket: "ticket-1" }));
        return;
      }

      if (endpoint === "ilink/bot/getuploadurl") {
        res.end(
          JSON.stringify({
            ret: 0,
            upload_full_url: `${cdnBaseUrl}/full-upload`,
            upload_param: "upload-param",
          }),
        );
        return;
      }

      res.end(JSON.stringify({ ret: 0 }));
    });
  });

  const weixinBaseUrl = await listen(weixinServer);
  const appServer = await startGrokAppServerMock(() => ({
    content: ["```codex-weixin-attachments", JSON.stringify({ attachments: [{ path: outputFile }] }), "```"].join("\n"),
  }));
  const appServerUrl = appServer.url;
  const bridge = new Bridge({
    appServerUrl,
    appServerToken: "codex-token",
    weixinBaseUrl,
    weixinCdnBaseUrl: cdnBaseUrl,
    weixinToken: "weixin-token",
    controlApiToken: null,
    stateDir,
    uploadDir: path.join(stateDir, "uploads"),
    codexThreadMode: "per_user",
    defaultCwd: null,
    codexTurnTimeoutMs: 180_000,
  });

  const bridgeTask = bridge.start();

  try {
    await waitFor(() =>
      receivedWeixinRequests.some(
        (request) =>
          request.endpoint === "ilink/bot/sendmessage" &&
          (
            request.body.msg as
              | { item_list?: Array<{ file_item?: { media?: { encrypt_query_param?: string } } }> }
              | undefined
          )?.item_list?.some((item) => item.file_item?.media?.encrypt_query_param === "fallback-param"),
      ),
    );
  } finally {
    await bridge.stop();
    await appServer.close();
    weixinServer.close();
    cdnServer.close();
    await bridgeTask;
  }

  assert.deepEqual(uploadPaths, ["/full-upload", "/full-upload", "/full-upload", "/upload"]);
});

test("bridge shows the house billing notice for a billing failure when GROK_BILLING_NOTICE is on", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-bridge-"));
  const receivedWeixinRequests: Array<{ endpoint: string; body: Record<string, unknown> }> = [];
  let getUpdatesCount = 0;

  const weixinServer = http.createServer((req, res) => {
    const endpoint = new URL(req.url ?? "/", "http://localhost").pathname.replace(/^\/+/, "");
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk.toString("utf8");
    });
    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      receivedWeixinRequests.push({ endpoint, body });
      res.setHeader("content-type", "application/json");

      if (endpoint === "ilink/bot/getupdates") {
        getUpdatesCount += 1;
        if (getUpdatesCount === 1) {
          res.end(
            JSON.stringify({
              ret: 0,
              get_updates_buf: "buf-1",
              msgs: [
                {
                  message_id: "msg-1",
                  from_user_id: "user-1",
                  context_token: "ctx-1",
                  item_list: [{ type: 1, text_item: { text: "hello" } }],
                },
              ],
            }),
          );
          return;
        }
        res.end(JSON.stringify({ ret: 0, get_updates_buf: "buf-1", msgs: [] }));
        return;
      }

      if (endpoint === "ilink/bot/getconfig") {
        res.end(JSON.stringify({ ret: 0, typing_ticket: "ticket-1" }));
        return;
      }

      res.end(JSON.stringify({ ret: 0 }));
    });
  });

  const weixinBaseUrl = await listen(weixinServer);
  const appServer = await startGrokAppServerMock(() => ({
    status: 402,
    message: "unexpected status 402 Payment Required: insufficient balance",
  }));
  const appServerUrl = appServer.url;
  const previousRechargeTarget = process.env.RECHARGE_TARGET;
  const previousBillingNotice = process.env.GROK_BILLING_NOTICE;
  process.env.RECHARGE_TARGET = "clawfather";
  process.env.GROK_BILLING_NOTICE = "1";
  const bridge = new Bridge({
    appServerUrl,
    appServerToken: "codex-token",
    weixinBaseUrl,
    weixinCdnBaseUrl: weixinBaseUrl,
    weixinToken: "weixin-token",
    controlApiToken: null,
    stateDir,
    uploadDir: path.join(stateDir, "uploads"),
    codexThreadMode: "per_user",
    defaultCwd: null,
    codexTurnTimeoutMs: 180_000,
  });

  const bridgeTask = bridge.start();

  try {
    await waitFor(() => receivedWeixinRequests.some((request) => request.endpoint === "ilink/bot/sendmessage"));
  } finally {
    if (previousRechargeTarget === undefined) {
      delete process.env.RECHARGE_TARGET;
    } else {
      process.env.RECHARGE_TARGET = previousRechargeTarget;
    }
    if (previousBillingNotice === undefined) {
      delete process.env.GROK_BILLING_NOTICE;
    } else {
      process.env.GROK_BILLING_NOTICE = previousBillingNotice;
    }
    await bridge.stop();
    await appServer.close();
    weixinServer.close();
    await bridgeTask;
  }

  const sendMessageRequest = receivedWeixinRequests.find((request) => request.endpoint === "ilink/bot/sendmessage");
  const sentMessage = sendMessageRequest?.body.msg as
    | { to_user_id?: string; item_list?: Array<{ text_item?: { text?: string } }> }
    | undefined;
  assert.equal(sentMessage?.to_user_id, "user-1");
  assert.match(sentMessage?.item_list?.[0]?.text_item?.text ?? "", /模型余额不足/);
  assert.match(sentMessage?.item_list?.[0]?.text_item?.text ?? "", /https:\/\/www\.xialiao\.app\/recharge\/clawfather/);
});

test("bridge surfaces the upstream provider error directly when GROK_BILLING_NOTICE is off", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-weixin-bridge-"));
  const receivedWeixinRequests: Array<{ endpoint: string; body: Record<string, unknown> }> = [];
  let getUpdatesCount = 0;

  const weixinServer = http.createServer((req, res) => {
    const endpoint = new URL(req.url ?? "/", "http://localhost").pathname.replace(/^\/+/, "");
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk.toString("utf8");
    });
    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      receivedWeixinRequests.push({ endpoint, body });
      res.setHeader("content-type", "application/json");

      if (endpoint === "ilink/bot/getupdates") {
        getUpdatesCount += 1;
        if (getUpdatesCount === 1) {
          res.end(
            JSON.stringify({
              ret: 0,
              get_updates_buf: "buf-1",
              msgs: [
                {
                  message_id: "msg-1",
                  from_user_id: "user-1",
                  context_token: "ctx-1",
                  item_list: [{ type: 1, text_item: { text: "hello" } }],
                },
              ],
            }),
          );
          return;
        }
        res.end(JSON.stringify({ ret: 0, get_updates_buf: "buf-1", msgs: [] }));
        return;
      }

      if (endpoint === "ilink/bot/getconfig") {
        res.end(JSON.stringify({ ret: 0, typing_ticket: "ticket-1" }));
        return;
      }

      res.end(JSON.stringify({ ret: 0 }));
    });
  });

  const weixinBaseUrl = await listen(weixinServer);
  const appServer = await startGrokAppServerMock(() => ({
    status: 402,
    message: "You have run out of credits. Add credits at https://grok.com/?_s=usage",
  }));
  const appServerUrl = appServer.url;
  const previousBillingNotice = process.env.GROK_BILLING_NOTICE;
  delete process.env.GROK_BILLING_NOTICE;
  const bridge = new Bridge({
    appServerUrl,
    appServerToken: "grok-token",
    weixinBaseUrl,
    weixinCdnBaseUrl: weixinBaseUrl,
    weixinToken: "weixin-token",
    controlApiToken: null,
    stateDir,
    uploadDir: path.join(stateDir, "uploads"),
    codexThreadMode: "per_user",
    defaultCwd: null,
    codexTurnTimeoutMs: 180_000,
  });

  const bridgeTask = bridge.start();

  try {
    await waitFor(() => receivedWeixinRequests.some((request) => request.endpoint === "ilink/bot/sendmessage"));
  } finally {
    if (previousBillingNotice === undefined) {
      delete process.env.GROK_BILLING_NOTICE;
    } else {
      process.env.GROK_BILLING_NOTICE = previousBillingNotice;
    }
    await bridge.stop();
    await appServer.close();
    weixinServer.close();
    await bridgeTask;
  }

  const sendMessageRequest = receivedWeixinRequests.find((request) => request.endpoint === "ilink/bot/sendmessage");
  const sentText =
    (sendMessageRequest?.body.msg as { item_list?: Array<{ text_item?: { text?: string } }> } | undefined)
      ?.item_list?.[0]?.text_item?.text ?? "";
  assert.match(sentText, /run out of credits/);
  assert.match(sentText, /grok\.com/);
  assert.doesNotMatch(sentText, /模型余额不足/);
  assert.doesNotMatch(sentText, /xialiao\.app\/recharge/);
  assert.doesNotMatch(sentText, /grok app-server/);
});

test("bridge relays the pending login link when the app-server has no credential", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-weixin-bridge-"));
  const pendingFile = path.join(stateDir, "pending-login.json");
  const loginLink = "https://accounts.x.ai/oauth2/device?user_code=TEST-CODE";
  fs.writeFileSync(pendingFile, JSON.stringify({ message: `🔐 Grok 云端需要登录\n${loginLink}`, updatedAt: 1 }));
  const previousPendingFile = process.env.GROK_PENDING_LOGIN_FILE;
  process.env.GROK_PENDING_LOGIN_FILE = pendingFile;

  const receivedWeixinRequests: Array<{ endpoint: string; body: Record<string, unknown> }> = [];
  let getUpdatesCount = 0;

  const weixinServer = http.createServer((req, res) => {
    const endpoint = new URL(req.url ?? "/", "http://localhost").pathname.replace(/^\/+/, "");
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk.toString("utf8");
    });
    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      receivedWeixinRequests.push({ endpoint, body });
      res.setHeader("content-type", "application/json");

      if (endpoint === "ilink/bot/getupdates") {
        getUpdatesCount += 1;
        if (getUpdatesCount === 1) {
          res.end(
            JSON.stringify({
              ret: 0,
              get_updates_buf: "buf-1",
              msgs: [
                {
                  message_id: "msg-1",
                  from_user_id: "user-1",
                  context_token: "ctx-1",
                  item_list: [{ type: 1, text_item: { text: "hello" } }],
                },
              ],
            }),
          );
          return;
        }
        res.end(JSON.stringify({ ret: 0, get_updates_buf: "buf-1", msgs: [] }));
        return;
      }

      if (endpoint === "ilink/bot/getconfig") {
        res.end(JSON.stringify({ ret: 0, typing_ticket: "ticket-1" }));
        return;
      }

      res.end(JSON.stringify({ ret: 0 }));
    });
  });

  const weixinBaseUrl = await listen(weixinServer);
  const appServer = await startGrokAppServerMock(() => ({
    status: 503,
    message: "No xAI credential available",
  }));
  const appServerUrl = appServer.url;
  const bridge = new Bridge({
    appServerUrl,
    appServerToken: "grok-token",
    weixinBaseUrl,
    weixinCdnBaseUrl: weixinBaseUrl,
    weixinToken: "weixin-token",
    controlApiToken: null,
    stateDir,
    uploadDir: path.join(stateDir, "uploads"),
    codexThreadMode: "per_user",
    defaultCwd: null,
    codexTurnTimeoutMs: 180_000,
  });

  const bridgeTask = bridge.start();

  try {
    await waitFor(() => receivedWeixinRequests.some((request) => request.endpoint === "ilink/bot/sendmessage"));
  } finally {
    if (previousPendingFile === undefined) {
      delete process.env.GROK_PENDING_LOGIN_FILE;
    } else {
      process.env.GROK_PENDING_LOGIN_FILE = previousPendingFile;
    }
    await bridge.stop();
    await appServer.close();
    weixinServer.close();
    await bridgeTask;
  }

  const sendMessageRequest = receivedWeixinRequests.find((request) => request.endpoint === "ilink/bot/sendmessage");
  const sentMessage = sendMessageRequest?.body.msg as
    | { to_user_id?: string; item_list?: Array<{ text_item?: { text?: string } }> }
    | undefined;
  const sentText = sentMessage?.item_list?.[0]?.text_item?.text ?? "";
  assert.equal(sentMessage?.to_user_id, "user-1");
  assert.match(sentText, /accounts\.x\.ai\/oauth2\/device\?user_code=TEST-CODE/);
  assert.doesNotMatch(sentText, /Grok 对话失败/);
});

function listen(server: http.Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

type GrokMockReply = { content: string } | { status: number; message?: string };

type GrokTurnRequest = { session?: string; content: string };

type GrokAppServerMock = {
  url: string;
  requests: GrokTurnRequest[];
  close: () => Promise<void>;
};

// Stands in for grok's OpenAI-compatible app-server. Records the last user
// message of each POST /v1/chat/completions turn and lets a test decide the
// reply (assistant content, or a non-2xx error to exercise failure paths).
async function startGrokAppServerMock(
  handler: (request: GrokTurnRequest, callIndex: number) => GrokMockReply,
): Promise<GrokAppServerMock> {
  const requests: GrokTurnRequest[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk.toString("utf8");
      });
      req.on("end", () => {
        const parsed = raw
          ? (JSON.parse(raw) as { session?: string; messages?: Array<{ role?: string; content?: string }> })
          : {};
        const lastUser = [...(parsed.messages ?? [])].reverse().find((message) => message.role === "user");
        const request: GrokTurnRequest = { session: parsed.session, content: lastUser?.content ?? "" };
        const index = requests.length;
        requests.push(request);
        const reply = handler(request, index);
        res.setHeader("content-type", "application/json");
        if ("status" in reply) {
          res.writeHead(reply.status);
          res.end(JSON.stringify({ error: { message: reply.message ?? "error" } }));
          return;
        }
        res.writeHead(200);
        res.end(
          JSON.stringify({
            id: `chatcmpl-${index}`,
            object: "chat.completion",
            choices: [{ index: 0, message: { role: "assistant", content: reply.content }, finish_reason: "stop" }],
          }),
        );
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const url = await listen(server);
  return {
    url,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("Timed out waiting for bridge side effects.");
}

async function commandExists(command: string): Promise<boolean> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    const child = spawn(command, ["-version"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

function makeBmpImage(width: number, height: number): Buffer {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const pixelDataSize = rowSize * height;
  const fileSize = 54 + pixelDataSize;
  const header = Buffer.alloc(54);
  header.write("BM", 0, "ascii");
  header.writeUInt32LE(fileSize, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(width, 18);
  header.writeInt32LE(height, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(24, 28);
  header.writeUInt32LE(pixelDataSize, 34);

  const pixels = Buffer.alloc(pixelDataSize);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (height - 1 - y) * rowSize + x * 3;
      pixels[offset] = (x * 17 + y * 3) % 256;
      pixels[offset + 1] = (x * 5 + y * 11) % 256;
      pixels[offset + 2] = (x * 13 + y * 7) % 256;
    }
  }
  return Buffer.concat([header, pixels]);
}
