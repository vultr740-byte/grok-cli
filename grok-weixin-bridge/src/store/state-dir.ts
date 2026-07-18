import fs from "node:fs";
import path from "node:path";

export function ensureStateDir(stateDir: string): string {
  fs.mkdirSync(stateDir, { recursive: true });
  return stateDir;
}

export function resolveStateFile(stateDir: string, fileName: string): string {
  return path.join(ensureStateDir(stateDir), fileName);
}
