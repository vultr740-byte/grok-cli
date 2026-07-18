import fs from "node:fs";

import type { ThreadBinding } from "../types.js";
import { resolveStateFile } from "./state-dir.js";

type BindingFile = {
  bindings: ThreadBinding[];
};

export class ThreadBindingStore {
  private readonly filePath: string;

  constructor(stateDir: string) {
    this.filePath = resolveStateFile(stateDir, "thread-bindings.json");
  }

  list(): ThreadBinding[] {
    try {
      if (!fs.existsSync(this.filePath)) {
        return [];
      }
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as BindingFile;
      return Array.isArray(parsed.bindings) ? parsed.bindings : [];
    } catch {
      return [];
    }
  }

  getByWeixinUserId(weixinUserId: string): ThreadBinding | null {
    return this.list().find((binding) => binding.weixinUserId === weixinUserId) ?? null;
  }

  save(binding: ThreadBinding): ThreadBinding {
    const bindings = this.list().filter((item) => item.weixinUserId !== binding.weixinUserId);
    bindings.push(binding);
    fs.writeFileSync(this.filePath, JSON.stringify({ bindings }, null, 2), "utf8");
    return binding;
  }

  updateWeixinUserId(weixinUserId: string, patch: Partial<ThreadBinding>): ThreadBinding | null {
    const bindings = this.list();
    const index = bindings.findIndex((binding) => binding.weixinUserId === weixinUserId);
    if (index < 0) {
      return null;
    }
    const current = bindings[index];
    const updated: ThreadBinding = {
      ...current,
      ...patch,
      updatedAt: patch.updatedAt ?? Date.now(),
    };
    bindings[index] = updated;
    fs.writeFileSync(this.filePath, JSON.stringify({ bindings }, null, 2), "utf8");
    return updated;
  }
}
