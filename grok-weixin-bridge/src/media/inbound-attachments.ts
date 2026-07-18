import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type MessageItem, MessageItemType } from "../platforms/weixin/types.js";
import type { InboundAttachment } from "../types.js";
import { downloadAndDecryptBuffer, downloadPlainCdnBuffer } from "./cdn.js";
import { getExtensionFromMime, getMimeFromFilename } from "./mime.js";

const WEIXIN_MEDIA_MAX_BYTES = 100 * 1024 * 1024;

type DownloadedMedia = {
  decryptedPicPath?: string;
  decryptedVoicePath?: string;
  voiceMediaType?: string;
  decryptedFilePath?: string;
  fileMediaType?: string;
  decryptedVideoPath?: string;
};

export async function downloadInboundAttachments(params: {
  items: MessageItem[] | undefined;
  cdnBaseUrl: string;
  uploadDir: string;
  weixinUserId: string;
  messageId: string;
}): Promise<{ attachments: InboundAttachment[]; errors: string[] }> {
  const attachments: InboundAttachment[] = [];
  const errors: string[] = [];
  for (const item of params.items ?? []) {
    if (!isMediaItem(item)) {
      continue;
    }
    try {
      const media = await downloadMediaFromItem(item, {
        cdnBaseUrl: params.cdnBaseUrl,
        uploadDir: params.uploadDir,
        weixinUserId: params.weixinUserId,
      });
      attachments.push(...convertDownloadedMediaToAttachments(item, media));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(message);
      console.error(`Weixin attachment download failed for message ${params.messageId}: ${message}`);
    }
  }
  return { attachments, errors };
}

async function downloadMediaFromItem(
  item: MessageItem,
  params: {
    cdnBaseUrl: string;
    uploadDir: string;
    weixinUserId: string;
  },
): Promise<DownloadedMedia> {
  const result: DownloadedMedia = {};

  if (item.type === MessageItemType.IMAGE) {
    const image = item.image_item;
    if (!image?.media?.encrypt_query_param && !image?.media?.full_url) {
      return result;
    }
    const aesKeyBase64 = image.aeskey ? Buffer.from(image.aeskey, "hex").toString("base64") : image.media?.aes_key;
    const buffer = aesKeyBase64
      ? await downloadAndDecryptBuffer({
          encryptedQueryParam: image.media?.encrypt_query_param ?? "",
          aesKeyBase64,
          cdnBaseUrl: params.cdnBaseUrl,
          fullUrl: image.media?.full_url,
        })
      : await downloadPlainCdnBuffer({
          encryptedQueryParam: image.media?.encrypt_query_param ?? "",
          cdnBaseUrl: params.cdnBaseUrl,
          fullUrl: image.media?.full_url,
        });
    const saved = saveInboundMedia({
      buffer,
      contentType: "image/jpeg",
      uploadDir: params.uploadDir,
      weixinUserId: params.weixinUserId,
      originalFilename: "image.jpg",
    });
    result.decryptedPicPath = saved.path;
    return result;
  }

  if (item.type === MessageItemType.VOICE) {
    const voice = item.voice_item;
    if ((!voice?.media?.encrypt_query_param && !voice?.media?.full_url) || !voice?.media?.aes_key) {
      return result;
    }
    const buffer = await downloadAndDecryptBuffer({
      encryptedQueryParam: voice.media.encrypt_query_param ?? "",
      aesKeyBase64: voice.media.aes_key,
      cdnBaseUrl: params.cdnBaseUrl,
      fullUrl: voice.media.full_url,
    });
    const saved = saveInboundMedia({
      buffer,
      contentType: "audio/silk",
      uploadDir: params.uploadDir,
      weixinUserId: params.weixinUserId,
      originalFilename: "voice.silk",
    });
    result.decryptedVoicePath = saved.path;
    result.voiceMediaType = "audio/silk";
    return result;
  }

  if (item.type === MessageItemType.FILE) {
    const file = item.file_item;
    if ((!file?.media?.encrypt_query_param && !file?.media?.full_url) || !file?.media?.aes_key) {
      return result;
    }
    const buffer = await downloadAndDecryptBuffer({
      encryptedQueryParam: file.media.encrypt_query_param ?? "",
      aesKeyBase64: file.media.aes_key,
      cdnBaseUrl: params.cdnBaseUrl,
      fullUrl: file.media.full_url,
    });
    const fileName = file.file_name ?? "file.bin";
    const mimeType = getMimeFromFilename(fileName);
    const saved = saveInboundMedia({
      buffer,
      contentType: mimeType,
      uploadDir: params.uploadDir,
      weixinUserId: params.weixinUserId,
      originalFilename: fileName,
    });
    result.decryptedFilePath = saved.path;
    result.fileMediaType = mimeType;
    return result;
  }

  if (item.type === MessageItemType.VIDEO) {
    const video = item.video_item;
    if ((!video?.media?.encrypt_query_param && !video?.media?.full_url) || !video?.media?.aes_key) {
      return result;
    }
    const buffer = await downloadAndDecryptBuffer({
      encryptedQueryParam: video.media.encrypt_query_param ?? "",
      aesKeyBase64: video.media.aes_key,
      cdnBaseUrl: params.cdnBaseUrl,
      fullUrl: video.media.full_url,
    });
    const saved = saveInboundMedia({
      buffer,
      contentType: "video/mp4",
      uploadDir: params.uploadDir,
      weixinUserId: params.weixinUserId,
      originalFilename: "video.mp4",
    });
    result.decryptedVideoPath = saved.path;
  }

  return result;
}

function saveInboundMedia(params: {
  buffer: Buffer;
  contentType: string;
  uploadDir: string;
  weixinUserId: string;
  originalFilename?: string;
}): { path: string } {
  if (params.buffer.length > WEIXIN_MEDIA_MAX_BYTES) {
    throw new Error(`inbound media exceeds max size: ${params.buffer.length} > ${WEIXIN_MEDIA_MAX_BYTES}`);
  }
  const dir = path.join(params.uploadDir, sanitizeFilenameStem(params.weixinUserId));
  fs.mkdirSync(dir, { recursive: true });
  const originalBase = params.originalFilename ? path.basename(params.originalFilename).trim() : "";
  const originalExt = originalBase ? path.extname(originalBase) : "";
  const extension = originalExt || getExtensionFromMime(params.contentType) || ".bin";
  const originalStem = originalBase ? originalBase.slice(0, originalBase.length - originalExt.length) : "media";
  const filePath = path.join(dir, `${sanitizeFilenameStem(originalStem)}-${crypto.randomUUID()}${extension}`);
  fs.writeFileSync(filePath, params.buffer);
  return { path: filePath };
}

function convertDownloadedMediaToAttachments(item: MessageItem, media: DownloadedMedia): InboundAttachment[] {
  const attachments: InboundAttachment[] = [];
  if (media.decryptedPicPath) {
    attachments.push({
      kind: "image",
      localPath: media.decryptedPicPath,
      fileName: path.basename(media.decryptedPicPath),
      mimeType: getMimeFromFilename(media.decryptedPicPath),
    });
  }
  if (media.decryptedVoicePath) {
    attachments.push({
      kind: "voice",
      localPath: media.decryptedVoicePath,
      fileName: path.basename(media.decryptedVoicePath),
      mimeType: media.voiceMediaType ?? null,
      transcriptText: normalizeText(item.voice_item?.text),
      durationSeconds: typeof item.voice_item?.playtime === "number" ? item.voice_item.playtime : null,
    });
  }
  if (media.decryptedFilePath) {
    attachments.push({
      kind: "file",
      localPath: media.decryptedFilePath,
      fileName: normalizeText(item.file_item?.file_name) ?? path.basename(media.decryptedFilePath),
      mimeType: media.fileMediaType ?? null,
    });
  }
  if (media.decryptedVideoPath) {
    attachments.push({
      kind: "video",
      localPath: media.decryptedVideoPath,
      fileName: path.basename(media.decryptedVideoPath),
      mimeType: getMimeFromFilename(media.decryptedVideoPath),
      durationSeconds: typeof item.video_item?.play_length === "number" ? item.video_item.play_length : null,
    });
  }
  return attachments;
}

function isMediaItem(item: MessageItem): boolean {
  return (
    item.type === MessageItemType.IMAGE ||
    item.type === MessageItemType.VOICE ||
    item.type === MessageItemType.FILE ||
    item.type === MessageItemType.VIDEO
  );
}

function sanitizeFilenameStem(value: string): string {
  const normalized = value
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "")
    .trim();
  return normalized || "media";
}

function normalizeText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
