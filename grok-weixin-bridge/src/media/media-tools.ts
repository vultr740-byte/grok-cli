import { spawnSync } from "node:child_process";
import fs from "node:fs";

export function resolveFfmpegPath(): string {
  return process.env.CODEX_WEIXIN_FFMPEG_PATH?.trim() || process.env.FFMPEG_PATH?.trim() || "ffmpeg";
}

export function resolveFfprobePath(): string {
  return process.env.CODEX_WEIXIN_FFPROBE_PATH?.trim() || process.env.FFPROBE_PATH?.trim() || "ffprobe";
}

export function hasMediaTools(): boolean {
  return (
    isExecutableAvailable(resolveFfmpegPath(), ["-version"]) &&
    isExecutableAvailable(resolveFfprobePath(), ["-version"])
  );
}

function isExecutableAvailable(command: string, args: string[]): boolean {
  if (command.includes("/") && !fs.existsSync(command)) {
    return false;
  }
  const result = spawnSync(command, args, { stdio: "ignore" });
  return result.status === 0;
}
