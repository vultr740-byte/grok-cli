import fs from "node:fs";

import { resolveStateFile } from "./state-dir.js";

type DedupFile = {
  messageIds: string[];
};

const DEFAULT_MAX_IDS = 10_000;

export class DedupStore {
  private readonly filePath: string;
  private readonly maxIds: number;
  private cache: string[] | null = null;

  constructor(stateDir: string, maxIds = DEFAULT_MAX_IDS) {
    this.filePath = resolveStateFile(stateDir, "processed-message-ids.json");
    this.maxIds = maxIds;
  }

  has(messageId: string): boolean {
    return this.readIds().includes(messageId);
  }

  add(messageId: string): void {
    const next = [...this.readIds().filter((id) => id !== messageId), messageId];
    const trimmed = next.slice(Math.max(0, next.length - this.maxIds));
    this.cache = trimmed;
    fs.writeFileSync(this.filePath, JSON.stringify({ messageIds: trimmed }, null, 2), "utf8");
  }

  private readIds(): string[] {
    if (this.cache) {
      return this.cache;
    }
    try {
      if (!fs.existsSync(this.filePath)) {
        this.cache = [];
        return this.cache;
      }
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as DedupFile;
      this.cache = Array.isArray(parsed.messageIds)
        ? parsed.messageIds.filter((id): id is string => typeof id === "string" && id.length > 0)
        : [];
      return this.cache;
    } catch {
      this.cache = [];
      return this.cache;
    }
  }
}
