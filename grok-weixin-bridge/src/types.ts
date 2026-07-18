export type BridgeConfig = {
  appServerUrl: string;
  appServerToken: string;
  weixinBaseUrl: string;
  weixinCdnBaseUrl: string;
  weixinToken: string | null;
  controlApiToken: string | null;
  stateDir: string;
  uploadDir: string;
  codexThreadMode: "per_user" | "single_thread";
  defaultCwd: string | null;
  codexTurnTimeoutMs: number;
};

export type WeixinInboundMessage = {
  messageId: string;
  fromUserId: string;
  toUserId: string | null;
  text: string;
  contextToken: string | null;
  createTimeMs: number | null;
};

export type ThreadBinding = {
  weixinUserId: string;
  codexThreadId: string;
  updatedAt: number;
};

export type InboundAttachmentKind = "image" | "voice" | "file" | "video";

export type InboundAttachment = {
  kind: InboundAttachmentKind;
  localPath: string;
  fileName?: string | null;
  mimeType?: string | null;
  transcriptText?: string | null;
  durationSeconds?: number | null;
};
