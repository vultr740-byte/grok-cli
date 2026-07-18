import assert from "node:assert/strict";
import test from "node:test";

import { loadConfigFromEnv } from "../src/util/env.js";

const ENV_KEYS = [
  "GROK_APP_SERVER_URL",
  "GROK_APP_SERVER_TOKEN",
  "APP_SERVER_TOKEN",
  "WEIXIN_BASE_URL",
  "WEIXIN_CDN_BASE_URL",
  "WEIXIN_TOKEN",
  "CONTROL_API_TOKEN",
  "GROK_WEIXIN_BRIDGE_CONTROL_API_TOKEN",
  "GROK_WEIXIN_STATE_DIR",
  "GROK_WEIXIN_UPLOAD_DIR",
  "GROK_THREAD_MODE",
  "GROK_DEFAULT_CWD",
  "GROK_TURN_TIMEOUT_MS",
] as const;

test("loadConfigFromEnv defaults turn timeout to 30 minutes and app-server to loopback", () => {
  withEnv(
    {
      GROK_APP_SERVER_TOKEN: "grok-token",
      WEIXIN_BASE_URL: "https://ilink.example",
    },
    () => {
      const config = loadConfigFromEnv();

      assert.equal(config.codexTurnTimeoutMs, 30 * 60 * 1000);
      assert.equal(config.appServerUrl, "http://127.0.0.1:8080");
    },
  );
});

test("loadConfigFromEnv accepts custom turn timeout and app-server url", () => {
  withEnv(
    {
      GROK_APP_SERVER_URL: "http://127.0.0.1:1234",
      GROK_APP_SERVER_TOKEN: "grok-token",
      WEIXIN_BASE_URL: "https://ilink.example",
      GROK_TURN_TIMEOUT_MS: "600000",
    },
    () => {
      const config = loadConfigFromEnv();

      assert.equal(config.codexTurnTimeoutMs, 600_000);
      assert.equal(config.appServerUrl, "http://127.0.0.1:1234");
    },
  );
});

test("loadConfigFromEnv rejects invalid turn timeout", () => {
  withEnv(
    {
      GROK_APP_SERVER_TOKEN: "grok-token",
      WEIXIN_BASE_URL: "https://ilink.example",
      GROK_TURN_TIMEOUT_MS: "0",
    },
    () => {
      assert.throws(() => loadConfigFromEnv(), /GROK_TURN_TIMEOUT_MS must be a positive integer/u);
    },
  );
});

test("loadConfigFromEnv falls back to APP_SERVER_TOKEN", () => {
  withEnv(
    {
      APP_SERVER_TOKEN: "shared-token",
      WEIXIN_BASE_URL: "https://ilink.example",
    },
    () => {
      const config = loadConfigFromEnv();

      assert.equal(config.appServerToken, "shared-token");
    },
  );
});

function withEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>, fn: () => void): void {
  const previous = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(values)) {
    process.env[key] = value;
  }

  try {
    fn();
  } finally {
    for (const key of ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}
