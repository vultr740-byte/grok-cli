import path from "node:path";

import type { BridgeConfig } from "../types.js";

const DEFAULT_WEIXIN_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const DEFAULT_GROK_TURN_TIMEOUT_MS = 30 * 60 * 1000;

function required(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${name} is required.`);
  }
  return trimmed;
}

function optional(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function optionalPositiveInteger(value: string | undefined, name: string): number | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

const DEFAULT_GROK_APP_SERVER_URL = "http://127.0.0.1:8080";

export function loadConfigFromEnv(): BridgeConfig {
  const stateDir = optional(process.env.GROK_WEIXIN_STATE_DIR) ?? path.join(process.cwd(), "state");
  const uploadDir = optional(process.env.GROK_WEIXIN_UPLOAD_DIR) ?? path.join(stateDir, "uploads");

  return {
    // The weixin bridge runs alongside grok's app-server, so this defaults to
    // loopback and is overridable.
    appServerUrl: optional(process.env.GROK_APP_SERVER_URL) ?? DEFAULT_GROK_APP_SERVER_URL,
    appServerToken: required(
      process.env.GROK_APP_SERVER_TOKEN ?? process.env.APP_SERVER_TOKEN,
      "GROK_APP_SERVER_TOKEN",
    ),
    weixinBaseUrl: required(process.env.WEIXIN_BASE_URL, "WEIXIN_BASE_URL"),
    weixinCdnBaseUrl: optional(process.env.WEIXIN_CDN_BASE_URL) ?? DEFAULT_WEIXIN_CDN_BASE_URL,
    weixinToken: optional(process.env.WEIXIN_TOKEN),
    controlApiToken:
      optional(process.env.CONTROL_API_TOKEN) ?? optional(process.env.GROK_WEIXIN_BRIDGE_CONTROL_API_TOKEN),
    stateDir,
    uploadDir,
    codexThreadMode: process.env.GROK_THREAD_MODE === "single_thread" ? "single_thread" : "per_user",
    defaultCwd: optional(process.env.GROK_DEFAULT_CWD),
    codexTurnTimeoutMs:
      optionalPositiveInteger(process.env.GROK_TURN_TIMEOUT_MS, "GROK_TURN_TIMEOUT_MS") ?? DEFAULT_GROK_TURN_TIMEOUT_MS,
  };
}
