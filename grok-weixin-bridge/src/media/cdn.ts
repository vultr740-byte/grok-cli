import { createCipheriv, createDecipheriv } from "node:crypto";

const UPLOAD_MAX_RETRIES = 3;
const UPLOAD_RETRY_BASE_DELAY_MS = 1_000;

function buildCdnDownloadUrl(encryptedQueryParam: string, cdnBaseUrl: string): string {
  return `${ensureTrailingSlash(cdnBaseUrl)}download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}

function buildCdnUploadUrl(params: { cdnBaseUrl: string; uploadParam: string; filekey: string }): string {
  return `${ensureTrailingSlash(params.cdnBaseUrl)}upload?encrypted_query_param=${encodeURIComponent(params.uploadParam)}&filekey=${encodeURIComponent(params.filekey)}`;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function parseAesKey(aesKeyBase64: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, "base64");
  if (decoded.length === 16) {
    return decoded;
  }
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  throw new Error(`invalid aes_key: expected 16 raw bytes or 32-char hex string, got ${decoded.length} bytes`);
}

async function fetchCdnBytes(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text().catch(() => "(unreadable)");
    throw new Error(`CDN download ${response.status} ${response.statusText}: ${body.slice(0, 500)}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

export function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

export async function downloadAndDecryptBuffer(params: {
  encryptedQueryParam: string;
  aesKeyBase64: string;
  cdnBaseUrl: string;
  fullUrl?: string | null;
}): Promise<Buffer> {
  const key = parseAesKey(params.aesKeyBase64);
  const url = params.fullUrl?.trim() || buildCdnDownloadUrl(params.encryptedQueryParam, params.cdnBaseUrl);
  const encrypted = await fetchCdnBytes(url);
  return decryptAesEcb(encrypted, key);
}

export async function downloadPlainCdnBuffer(params: {
  encryptedQueryParam: string;
  cdnBaseUrl: string;
  fullUrl?: string | null;
}): Promise<Buffer> {
  const url = params.fullUrl?.trim() || buildCdnDownloadUrl(params.encryptedQueryParam, params.cdnBaseUrl);
  return fetchCdnBytes(url);
}

export async function uploadBufferToCdn(params: {
  buffer: Buffer;
  uploadFullUrl?: string | null;
  uploadParam?: string | null;
  filekey: string;
  cdnBaseUrl: string;
  aeskey: Buffer;
  label?: string;
}): Promise<{ downloadEncryptedQueryParam: string }> {
  const trimmedFullUrl = params.uploadFullUrl?.trim();
  const trimmedUploadParam = params.uploadParam?.trim();
  const candidates = [
    ...(trimmedFullUrl ? [{ mode: "upload_full_url", url: trimmedFullUrl }] : []),
    ...(trimmedUploadParam
      ? [
          {
            mode: "upload_param",
            url: buildCdnUploadUrl({
              cdnBaseUrl: params.cdnBaseUrl,
              uploadParam: trimmedUploadParam,
              filekey: params.filekey,
            }),
          },
        ]
      : []),
  ].filter((candidate, index, all) => all.findIndex((other) => other.url === candidate.url) === index);
  if (candidates.length === 0) {
    throw new Error("CDN upload URL missing.");
  }

  const ciphertext = encryptAesEcb(params.buffer, params.aeskey);
  const errors: string[] = [];

  for (const candidate of candidates) {
    for (let attempt = 1; attempt <= UPLOAD_MAX_RETRIES; attempt += 1) {
      try {
        const response = await fetch(candidate.url, {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: new Uint8Array(ciphertext),
        });
        if (response.status === 200) {
          const downloadEncryptedQueryParam = response.headers.get("x-encrypted-param")?.trim();
          if (!downloadEncryptedQueryParam) {
            throw new Error("CDN upload response missing x-encrypted-param header.");
          }
          console.log(
            JSON.stringify({
              event: "weixin_cdn_upload_success",
              label: params.label ?? null,
              filekey: params.filekey,
              mode: candidate.mode,
              attempt,
              ciphertextSize: ciphertext.length,
            }),
          );
          return { downloadEncryptedQueryParam };
        }

        const body =
          response.headers.get("x-error-message") ??
          (await response.text().catch(() => response.statusText || "(unreadable)"));
        const message =
          response.status >= 400 && response.status < 500
            ? `CDN upload client error ${response.status}: ${body.slice(0, 500)}`
            : `CDN upload server error ${response.status}: ${body.slice(0, 500)}`;
        errors.push(`${candidate.mode} attempt ${attempt}: ${message}`);
        console.error(
          JSON.stringify({
            event: "weixin_cdn_upload_failed",
            label: params.label ?? null,
            filekey: params.filekey,
            mode: candidate.mode,
            attempt,
            status: response.status,
            error: message,
            ciphertextSize: ciphertext.length,
          }),
        );
        if (response.status >= 400 && response.status < 500) {
          break;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${candidate.mode} attempt ${attempt}: ${message}`);
        console.error(
          JSON.stringify({
            event: "weixin_cdn_upload_failed",
            label: params.label ?? null,
            filekey: params.filekey,
            mode: candidate.mode,
            attempt,
            error: message,
            ciphertextSize: ciphertext.length,
          }),
        );
      }
      if (attempt < UPLOAD_MAX_RETRIES) {
        await sleep(UPLOAD_RETRY_BASE_DELAY_MS * attempt);
      }
    }
  }

  throw new Error(`CDN upload failed: ${errors.slice(-3).join("; ")}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
