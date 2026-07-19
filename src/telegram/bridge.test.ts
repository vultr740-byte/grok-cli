import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Bot } from "grammy";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTelegramBridge } from "./bridge";
import type { TurnCoordinator } from "./turn-coordinator";

let mockSendMessage: ReturnType<typeof vi.fn>;

vi.mock("grammy", () => ({
  Bot: vi.fn().mockImplementation(function BotMock() {
    return {
      api: { sendMessage: mockSendMessage },
      start: vi.fn(),
      stop: vi.fn(),
      catch: vi.fn(),
      command: vi.fn(),
      on: vi.fn(),
    };
  }),
}));

const MockedBot = vi.mocked(Bot);

function mockCoordinator(): TurnCoordinator {
  return { run: vi.fn((fn) => fn()) } as unknown as TurnCoordinator;
}

describe("createTelegramBridge", () => {
  describe("sendDm", () => {
    beforeEach(() => {
      mockSendMessage = vi.fn().mockResolvedValue(undefined);
      MockedBot.mockImplementation(function BotMock() {
        return {
          api: { sendMessage: mockSendMessage },
          start: vi.fn(),
          stop: vi.fn(),
          catch: vi.fn(),
          command: vi.fn(),
          on: vi.fn(),
        } as never;
      } as never);
    });

    it("sends short messages without splitting", async () => {
      const bridge = createTelegramBridge({
        token: "test-token",
        getApprovedUserIds: () => [],
        coordinator: mockCoordinator(),
        getTelegramAgent: vi.fn(),
      });

      await bridge.sendDm(123, "Hello, world!");

      expect(mockSendMessage).toHaveBeenCalledTimes(1);
      expect(mockSendMessage).toHaveBeenCalledWith(123, "Hello, world!");
    });

    it("splits long messages and sends each part", async () => {
      const bridge = createTelegramBridge({
        token: "test-token",
        getApprovedUserIds: () => [],
        coordinator: mockCoordinator(),
        getTelegramAgent: vi.fn(),
      });

      const longMessage = "a".repeat(5000);
      await bridge.sendDm(123, longMessage);

      expect(mockSendMessage).toHaveBeenCalledTimes(2);
      expect(mockSendMessage).toHaveBeenNthCalledWith(1, 123, "a".repeat(4096));
      expect(mockSendMessage).toHaveBeenNthCalledWith(2, 123, "a".repeat(904));
    });

    it("handles empty messages", async () => {
      const bridge = createTelegramBridge({
        token: "test-token",
        getApprovedUserIds: () => [],
        coordinator: mockCoordinator(),
        getTelegramAgent: vi.fn(),
      });

      await bridge.sendDm(123, "");

      expect(mockSendMessage).toHaveBeenCalledTimes(0);
    });

    it("sends multiple parts for message exactly at limit", async () => {
      const bridge = createTelegramBridge({
        token: "test-token",
        getApprovedUserIds: () => [],
        coordinator: mockCoordinator(),
        getTelegramAgent: vi.fn(),
      });

      const exactLimitMessage = "a".repeat(4096);
      await bridge.sendDm(123, exactLimitMessage);

      expect(mockSendMessage).toHaveBeenCalledTimes(1);
      expect(mockSendMessage).toHaveBeenCalledWith(123, "a".repeat(4096));
    });
  });

  describe("/login command", () => {
    let mockCommand: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      mockCommand = vi.fn();
      MockedBot.mockImplementation(function BotMock() {
        return {
          api: { sendMessage: vi.fn() },
          start: vi.fn(),
          stop: vi.fn(),
          catch: vi.fn(),
          command: mockCommand,
          on: vi.fn(),
        } as never;
      } as never);
    });

    function getLoginHandler(): (ctx: unknown) => Promise<void> {
      const call = mockCommand.mock.calls.find((c) => c[0] === "login");
      return call?.[1] as (ctx: unknown) => Promise<void>;
    }

    function withMarker(fn: (marker: string) => Promise<void>): Promise<void> {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-tg-login-"));
      const marker = path.join(dir, "relogin-request");
      const previous = process.env.GROK_RELOGIN_MARKER;
      process.env.GROK_RELOGIN_MARKER = marker;
      return fn(marker).finally(() => {
        if (previous === undefined) delete process.env.GROK_RELOGIN_MARKER;
        else process.env.GROK_RELOGIN_MARKER = previous;
      });
    }

    it("drops the relogin marker for an approved user", async () => {
      await withMarker(async (marker) => {
        createTelegramBridge({
          token: "test-token",
          getApprovedUserIds: () => [123],
          coordinator: mockCoordinator(),
          getTelegramAgent: vi.fn(),
        });
        const reply = vi.fn().mockResolvedValue(undefined);
        await getLoginHandler()({ from: { id: 123 }, reply });
        expect(fs.existsSync(marker)).toBe(true);
        expect(reply).toHaveBeenCalledTimes(1);
      });
    });

    it("ignores /login from a non-approved user", async () => {
      await withMarker(async (marker) => {
        createTelegramBridge({
          token: "test-token",
          getApprovedUserIds: () => [123],
          coordinator: mockCoordinator(),
          getTelegramAgent: vi.fn(),
        });
        const reply = vi.fn().mockResolvedValue(undefined);
        await getLoginHandler()({ from: { id: 999 }, reply });
        expect(fs.existsSync(marker)).toBe(false);
      });
    });
  });
});
