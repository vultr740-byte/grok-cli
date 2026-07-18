import fs from "node:fs";

import { resolveStateFile } from "./state-dir.js";

export type WeixinAccount = {
  accountId: string;
  token: string;
  baseUrl: string;
  userId: string | null;
  savedAt: string;
};

export class WeixinAccountStore {
  private readonly filePath: string;

  constructor(stateDir: string) {
    this.filePath = resolveStateFile(stateDir, "weixin-account.json");
  }

  load(): WeixinAccount | null {
    try {
      if (!fs.existsSync(this.filePath)) {
        return null;
      }
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as WeixinAccount;
      if (!parsed.token || !parsed.accountId || !parsed.baseUrl) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  save(account: Omit<WeixinAccount, "savedAt">): WeixinAccount {
    const next: WeixinAccount = {
      ...account,
      savedAt: new Date().toISOString(),
    };
    fs.writeFileSync(this.filePath, JSON.stringify(next, null, 2), "utf8");
    try {
      fs.chmodSync(this.filePath, 0o600);
    } catch {
      // best effort
    }
    return next;
  }

  clear(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        fs.unlinkSync(this.filePath);
      }
    } catch {
      // best effort
    }
  }
}
