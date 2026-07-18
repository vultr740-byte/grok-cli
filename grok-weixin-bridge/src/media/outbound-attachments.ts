import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  getUploadUrl,
  sendFileMessage,
  sendImageMessage,
  sendVideoMessage,
  type WeixinApiOptions,
} from "../platforms/weixin/api.js";
import { UploadMediaType } from "../platforms/weixin/types.js";
import { aesEcbPaddedSize, uploadBufferToCdn } from "./cdn.js";
import { prepareImageUploadInput } from "./image-normalize.js";
import { getMimeFromFilename } from "./mime.js";

export type OutboundAttachment = {
  path: string;
  caption?: string | null;
};

type UploadedFileInfo = {
  filekey: string;
  downloadEncryptedQueryParam: string;
  aeskey: string;
  fileSize: number;
  fileSizeCiphertext: number;
};

export async function sendWeixinMediaFile(params: {
  filePath: string;
  toUserId: string;
  text: string;
  options: WeixinApiOptions & { contextToken?: string | null };
  cdnBaseUrl: string;
}): Promise<void> {
  const mimeType = getMimeFromFilename(params.filePath);
  if (mimeType.startsWith("image/")) {
    const prepared = await prepareImageUploadInput(params.filePath);
    console.log(
      JSON.stringify({
        event: "weixin_outbound_image_prepared",
        filePath: params.filePath,
        uploadPath: prepared.filePath,
        originalSizeBytes: prepared.originalSizeBytes,
        uploadSizeBytes: prepared.uploadSizeBytes,
        transcodedToJpeg: prepared.transcodedToJpeg,
        normalized: prepared.normalized,
      }),
    );
    try {
      const uploaded = await uploadMediaToCdn({
        filePath: prepared.filePath,
        originalFilePath: params.filePath,
        toUserId: params.toUserId,
        options: params.options,
        cdnBaseUrl: params.cdnBaseUrl,
        mediaType: UploadMediaType.IMAGE,
      });
      await sendImageMessage({
        ...params.options,
        toUserId: params.toUserId,
        text: params.text,
        uploaded,
        contextToken: params.options.contextToken,
      });
    } finally {
      await prepared.cleanup?.();
    }
    return;
  }

  if (mimeType.startsWith("video/")) {
    const uploaded = await uploadMediaToCdn({
      filePath: params.filePath,
      originalFilePath: params.filePath,
      toUserId: params.toUserId,
      options: params.options,
      cdnBaseUrl: params.cdnBaseUrl,
      mediaType: UploadMediaType.VIDEO,
    });
    await sendVideoMessage({
      ...params.options,
      toUserId: params.toUserId,
      text: params.text,
      uploaded,
      contextToken: params.options.contextToken,
    });
    return;
  }

  const uploaded = await uploadMediaToCdn({
    filePath: params.filePath,
    originalFilePath: params.filePath,
    toUserId: params.toUserId,
    options: params.options,
    cdnBaseUrl: params.cdnBaseUrl,
    mediaType: UploadMediaType.FILE,
  });
  await sendFileMessage({
    ...params.options,
    toUserId: params.toUserId,
    text: params.text,
    fileName: path.basename(params.filePath),
    uploaded,
    contextToken: params.options.contextToken,
  });
}

async function uploadMediaToCdn(params: {
  filePath: string;
  originalFilePath: string;
  toUserId: string;
  options: WeixinApiOptions;
  cdnBaseUrl: string;
  mediaType: (typeof UploadMediaType)[keyof typeof UploadMediaType];
}): Promise<UploadedFileInfo> {
  const plaintext = await fs.readFile(params.filePath);
  const rawsize = plaintext.length;
  const rawfilemd5 = crypto.createHash("md5").update(plaintext).digest("hex");
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString("hex");
  const aeskey = crypto.randomBytes(16);
  const label = `${path.basename(params.originalFilePath)} mediaType=${params.mediaType} rawsize=${rawsize}`;

  console.log(
    JSON.stringify({
      event: "weixin_cdn_upload_prepare",
      label,
      filePath: params.filePath,
      originalFilePath: params.originalFilePath,
      mediaType: params.mediaType,
      rawsize,
      filesize,
      filekey,
    }),
  );

  const uploadUrl = await getUploadUrl({
    ...params.options,
    filekey,
    mediaType: params.mediaType,
    toUserId: params.toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    noNeedThumb: true,
    aeskey: aeskey.toString("hex"),
  });
  const uploadFullUrl = uploadUrl.upload_full_url?.trim();
  const uploadParam = uploadUrl.upload_param?.trim();
  console.log(
    JSON.stringify({
      event: "weixin_get_upload_url_response",
      label,
      filekey,
      uploadFullUrlPresent: Boolean(uploadFullUrl),
      uploadParamPresent: Boolean(uploadParam),
      thumbUploadParamPresent: Boolean(uploadUrl.thumb_upload_param?.trim()),
    }),
  );
  if (!uploadFullUrl && !uploadParam) {
    throw new Error("Weixin getuploadurl returned no upload URL.");
  }

  const uploaded = await uploadBufferToCdn({
    buffer: plaintext,
    uploadFullUrl,
    uploadParam,
    filekey,
    cdnBaseUrl: params.cdnBaseUrl,
    aeskey,
    label,
  });

  return {
    filekey,
    downloadEncryptedQueryParam: uploaded.downloadEncryptedQueryParam,
    aeskey: aeskey.toString("hex"),
    fileSize: rawsize,
    fileSizeCiphertext: filesize,
  };
}
