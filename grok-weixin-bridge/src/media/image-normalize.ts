import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { hasMediaTools, resolveFfmpegPath, resolveFfprobePath } from "./media-tools.js";

const execFileAsync = promisify(execFile);
const MAX_WEIXIN_IMAGE_BYTES = 200 * 1024;
const TARGET_WEIXIN_IMAGE_BYTES = 190 * 1024;

type Cleanup = () => Promise<void>;

export async function prepareImageUploadInput(filePath: string): Promise<{
  filePath: string;
  originalSizeBytes: number;
  uploadSizeBytes: number;
  transcodedToJpeg: boolean;
  normalized: boolean;
  cleanup: Cleanup | null;
}> {
  const originalStat = await fs.stat(filePath);
  if (!hasMediaTools()) {
    console.warn(
      JSON.stringify({
        event: "weixin_image_prepare_fallback_original",
        filePath,
        reason: "media_tools_unavailable",
        originalSizeBytes: originalStat.size,
      }),
    );
    return {
      filePath,
      originalSizeBytes: originalStat.size,
      uploadSizeBytes: originalStat.size,
      transcodedToJpeg: false,
      normalized: false,
      cleanup: null,
    };
  }

  const transcoded = await transcodeStillImageJpeg(filePath);
  if (!transcoded) {
    console.warn(
      JSON.stringify({
        event: "weixin_image_prepare_fallback_original",
        filePath,
        reason: "transcode_failed",
        originalSizeBytes: originalStat.size,
      }),
    );
    return {
      filePath,
      originalSizeBytes: originalStat.size,
      uploadSizeBytes: originalStat.size,
      transcodedToJpeg: false,
      normalized: false,
      cleanup: null,
    };
  }

  try {
    const transcodedStat = await fs.stat(transcoded.filePath);
    if (transcodedStat.size <= MAX_WEIXIN_IMAGE_BYTES) {
      return {
        filePath: transcoded.filePath,
        originalSizeBytes: originalStat.size,
        uploadSizeBytes: transcodedStat.size,
        transcodedToJpeg: true,
        normalized: false,
        cleanup: transcoded.cleanup,
      };
    }

    const normalized = await normalizeStillImageForWeixin(transcoded.filePath, {
      maxBytes: MAX_WEIXIN_IMAGE_BYTES,
      targetBytes: TARGET_WEIXIN_IMAGE_BYTES,
    });
    if (!normalized) {
      await transcoded.cleanup().catch(() => {});
      console.warn(
        JSON.stringify({
          event: "weixin_image_prepare_fallback_original",
          filePath,
          reason: "normalize_failed",
          originalSizeBytes: originalStat.size,
        }),
      );
      return {
        filePath,
        originalSizeBytes: originalStat.size,
        uploadSizeBytes: originalStat.size,
        transcodedToJpeg: false,
        normalized: false,
        cleanup: null,
      };
    }

    const normalizedStat = await fs.stat(normalized.filePath);
    return {
      filePath: normalized.filePath,
      originalSizeBytes: originalStat.size,
      uploadSizeBytes: normalizedStat.size,
      transcodedToJpeg: true,
      normalized: true,
      cleanup: async () => {
        await normalized.cleanup();
        await transcoded.cleanup();
      },
    };
  } catch (error) {
    await transcoded.cleanup().catch(() => {});
    console.warn(
      JSON.stringify({
        event: "weixin_image_prepare_fallback_original",
        filePath,
        reason: "normalize_error",
        originalSizeBytes: originalStat.size,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return {
      filePath,
      originalSizeBytes: originalStat.size,
      uploadSizeBytes: originalStat.size,
      transcodedToJpeg: false,
      normalized: false,
      cleanup: null,
    };
  }
}

async function transcodeStillImageJpeg(filePath: string): Promise<{
  filePath: string;
  cleanup: Cleanup;
} | null> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-weixin-image-"));
  const outputPath = path.join(tempDir, "image.jpg");
  try {
    await execFileAsync(resolveFfmpegPath(), [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      filePath,
      "-frames:v",
      "1",
      "-pix_fmt",
      "yuvj420p",
      "-q:v",
      "2",
      outputPath,
    ]);
    return {
      filePath: outputPath,
      cleanup: async () => {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      },
    };
  } catch {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    return null;
  }
}

async function normalizeStillImageForWeixin(
  filePath: string,
  options: {
    maxBytes: number;
    targetBytes: number;
  },
): Promise<{
  filePath: string;
  cleanup: Cleanup;
} | null> {
  const mediaInfo = await probeMediaInfo(filePath);
  const widthCandidates = buildWidthCandidates(mediaInfo?.width ?? null);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-weixin-image-"));
  let bestCandidatePath: string | null = null;
  let bestCandidateSize = Number.POSITIVE_INFINITY;

  try {
    for (const width of widthCandidates) {
      const outputPath = path.join(tempDir, `image-${width}.jpg`);
      await execFileAsync(resolveFfmpegPath(), [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        filePath,
        "-vf",
        `scale=${width}:-2:flags=lanczos`,
        "-pix_fmt",
        "yuvj420p",
        outputPath,
      ]);
      const stat = await fs.stat(outputPath);
      if (stat.size < bestCandidateSize) {
        bestCandidateSize = stat.size;
        bestCandidatePath = outputPath;
      }
      if (stat.size <= options.targetBytes) {
        return {
          filePath: outputPath,
          cleanup: async () => {
            await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
          },
        };
      }
    }

    if (bestCandidatePath && bestCandidateSize <= options.maxBytes) {
      return {
        filePath: bestCandidatePath,
        cleanup: async () => {
          await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
        },
      };
    }
  } catch {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    return null;
  }

  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  return null;
}

async function probeMediaInfo(filePath: string): Promise<{ width: number | null } | null> {
  try {
    const { stdout } = await execFileAsync(resolveFfprobePath(), [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_streams",
      filePath,
    ]);
    const parsed = JSON.parse(stdout || "{}") as { streams?: Array<Record<string, unknown>> };
    const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
    const videoStream = streams.find((stream) => stream?.codec_type === "video") ?? null;
    const width = Number(videoStream?.width);
    return { width: Number.isFinite(width) ? width : null };
  } catch {
    return null;
  }
}

function buildWidthCandidates(originalWidth: number | null): number[] {
  const fallback = [960, 896, 832, 768, 704, 640, 576, 512, 448, 384, 352, 320, 288, 272, 264, 256, 224, 192, 160, 128];
  const widths = new Set<number>();
  const normalizedWidth =
    Number.isFinite(originalWidth) && originalWidth && originalWidth > 0 ? Math.floor(originalWidth) : null;

  if (normalizedWidth && normalizedWidth > 128) {
    let width = normalizedWidth;
    while (width > 128) {
      width = Math.floor((width * 9) / 10);
      width -= width % 8;
      if (width >= 128) {
        widths.add(width);
      }
    }
  }

  for (const candidate of fallback) {
    if (!normalizedWidth || candidate < normalizedWidth) {
      widths.add(candidate);
    }
  }

  return [...widths].sort((a, b) => b - a);
}
