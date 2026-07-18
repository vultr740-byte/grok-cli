import crypto from "node:crypto";
import type { WeixinAccountStore } from "../../store/weixin-account-store.js";
import { getQrCode, getQrCodeStatus } from "./api.js";

const DEFAULT_ILINK_BOT_TYPE = "3";
const LOGIN_TTL_MS = 5 * 60_000;
const MAX_QR_REFRESH_COUNT = 3;

type LoginStatus =
  | "idle"
  | "qr_ready"
  | "wait"
  | "scaned"
  | "need_verifycode"
  | "confirmed"
  | "already_connected"
  | "expired"
  | "error";

type ActiveLogin = {
  sessionKey: string;
  qrcode: string;
  qrUrl: string;
  startedAt: number;
  currentBaseUrl: string;
  botType: string;
  refreshCount: number;
  status: LoginStatus;
  pendingVerifyCode: string | null;
  message: string;
  account?: {
    accountId: string;
    token: string;
    baseUrl: string;
    userId: string | null;
  };
};

export type WeixinLoginState = {
  status: LoginStatus;
  sessionKey: string | null;
  qrUrl?: string;
  message: string;
  account?: {
    accountId: string;
    baseUrl: string;
    userId: string | null;
  };
};

export class WeixinLoginManager {
  private readonly accountStore: WeixinAccountStore;
  private current: ActiveLogin | null = null;

  constructor(params: { accountStore: WeixinAccountStore }) {
    this.accountStore = params.accountStore;
  }

  getState(): WeixinLoginState {
    if (!this.current) {
      const account = this.accountStore.load();
      return {
        status: "idle",
        sessionKey: null,
        message: account ? "Weixin account is connected." : "No active Weixin login.",
        ...(account
          ? {
              account: {
                accountId: account.accountId,
                baseUrl: account.baseUrl,
                userId: account.userId,
              },
            }
          : {}),
      };
    }
    if (this.isExpired(this.current)) {
      this.current.status = "expired";
      this.current.message = "QR code expired. Start a new login.";
    }
    return this.publicState(this.current);
  }

  async startLogin(params: { baseUrl: string; botType?: string | null; force?: boolean }): Promise<WeixinLoginState> {
    if (!params.force && this.current && !this.isExpired(this.current)) {
      return this.publicState(this.current);
    }

    const botType = params.botType?.trim() || DEFAULT_ILINK_BOT_TYPE;
    const qr = await getQrCode({
      baseUrl: params.baseUrl,
      botType,
      localTokenList: this.localTokenList(),
    });

    this.current = {
      sessionKey: crypto.randomUUID(),
      qrcode: qr.qrcode,
      qrUrl: qr.qrcode_img_content,
      startedAt: Date.now(),
      currentBaseUrl: params.baseUrl,
      botType,
      refreshCount: 1,
      status: "qr_ready",
      pendingVerifyCode: null,
      message: "Scan the QR code with Weixin.",
    };

    return this.publicState(this.current);
  }

  submitVerifyCode(params: { sessionKey: string; verifyCode: string }): WeixinLoginState {
    const login = this.requireLogin(params.sessionKey);
    const verifyCode = params.verifyCode.trim();
    if (!verifyCode) {
      throw new Error("verifyCode is required.");
    }
    login.pendingVerifyCode = verifyCode;
    login.status = "scaned";
    login.message = "Verify code submitted. Continue polling login status.";
    return this.publicState(login);
  }

  async pollLogin(params: { sessionKey: string }): Promise<WeixinLoginState> {
    const login = this.requireLogin(params.sessionKey);
    if (this.isExpired(login)) {
      this.current = null;
      return {
        status: "expired",
        sessionKey: params.sessionKey,
        message: "QR code expired. Start a new login.",
      };
    }

    let resp: Awaited<ReturnType<typeof getQrCodeStatus>>;
    try {
      resp = await getQrCodeStatus({
        baseUrl: login.currentBaseUrl,
        qrcode: login.qrcode,
        verifyCode: login.pendingVerifyCode,
        timeoutMs: 35_000,
      });
    } catch (error) {
      login.status = "wait";
      login.message = error instanceof Error ? error.message : "Waiting for scan.";
      return this.publicState(login);
    }

    switch (resp.status) {
      case "wait": {
        login.status = "wait";
        login.message = "Waiting for scan.";
        return this.publicState(login);
      }
      case "scaned": {
        login.pendingVerifyCode = null;
        login.status = "scaned";
        login.message = "QR code scanned. Confirm login in Weixin.";
        return this.publicState(login);
      }
      case "need_verifycode": {
        login.status = "need_verifycode";
        login.message = login.pendingVerifyCode
          ? "Verify code was rejected. Submit the new code shown in Weixin."
          : "Submit the verify code shown in Weixin.";
        return this.publicState(login);
      }
      case "scaned_but_redirect": {
        if (resp.redirect_host?.trim()) {
          login.currentBaseUrl = `https://${resp.redirect_host.trim()}`;
        }
        login.status = "scaned";
        login.message = "QR code scanned. Switched to redirected Weixin host.";
        return this.publicState(login);
      }
      case "binded_redirect": {
        this.current = null;
        return {
          status: "already_connected",
          sessionKey: params.sessionKey,
          message: "This Weixin bot is already connected.",
        };
      }
      case "expired": {
        return await this.refreshOrExpire(login, "QR code expired. A new QR code was generated.");
      }
      case "verify_code_blocked": {
        login.pendingVerifyCode = null;
        return await this.refreshOrExpire(login, "Verify code attempts were blocked. A new QR code was generated.");
      }
      case "confirmed": {
        if (!resp.ilink_bot_id || !resp.bot_token) {
          this.current = null;
          return {
            status: "error",
            sessionKey: params.sessionKey,
            message: "Weixin login confirmed but credentials were missing.",
          };
        }

        const account = this.accountStore.save({
          accountId: resp.ilink_bot_id,
          token: resp.bot_token,
          baseUrl: resp.baseurl?.trim() || login.currentBaseUrl,
          userId: resp.ilink_user_id ?? null,
        });

        login.status = "confirmed";
        login.account = {
          accountId: account.accountId,
          token: account.token,
          baseUrl: account.baseUrl,
          userId: account.userId,
        };
        login.message = "Weixin account connected.";
        this.current = null;
        return {
          status: "confirmed",
          sessionKey: params.sessionKey,
          message: login.message,
          account: {
            accountId: account.accountId,
            baseUrl: account.baseUrl,
            userId: account.userId,
          },
        };
      }
    }
  }

  private async refreshOrExpire(login: ActiveLogin, message: string): Promise<WeixinLoginState> {
    login.refreshCount += 1;
    if (login.refreshCount > MAX_QR_REFRESH_COUNT) {
      this.current = null;
      return {
        status: "expired",
        sessionKey: login.sessionKey,
        message: "QR code refreshed too many times. Start a new login.",
      };
    }

    const qr = await getQrCode({
      baseUrl: login.currentBaseUrl,
      botType: login.botType,
      localTokenList: this.localTokenList(),
    });
    login.qrcode = qr.qrcode;
    login.qrUrl = qr.qrcode_img_content;
    login.startedAt = Date.now();
    login.status = "qr_ready";
    login.pendingVerifyCode = null;
    login.message = message;
    return this.publicState(login);
  }

  getCurrentSessionKey(): string | null {
    return this.current?.sessionKey ?? null;
  }

  private requireLogin(sessionKey: string): ActiveLogin {
    if (!this.current || this.current.sessionKey !== sessionKey) {
      throw new Error("No active login for this sessionKey.");
    }
    return this.current;
  }

  private isExpired(login: ActiveLogin): boolean {
    return Date.now() - login.startedAt > LOGIN_TTL_MS;
  }

  private localTokenList(): string[] {
    const account = this.accountStore.load();
    return account?.token ? [account.token] : [];
  }

  private publicState(login: ActiveLogin): WeixinLoginState {
    return {
      status: login.status,
      sessionKey: login.sessionKey,
      qrUrl: login.qrUrl,
      message: login.message,
      ...(login.account
        ? {
            account: {
              accountId: login.account.accountId,
              baseUrl: login.account.baseUrl,
              userId: login.account.userId,
            },
          }
        : {}),
    };
  }
}
