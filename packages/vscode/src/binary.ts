/**
 * Which `atlarix` program to run. In order:
 *   1. the `atlarix.cliPath` setting (development, or a user's own build);
 *   2. the one shipped inside this extension (`bin/`, one per platform VSIX);
 *   3. `atlarix` on PATH (npm, Homebrew, winget).
 */
import fs from "node:fs";
import path from "node:path";

const EXE = process.platform === "win32" ? "atlarix.exe" : "atlarix";

function runnable(file: string): boolean {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return false;
    if (process.platform !== "win32" && (st.mode & 0o111) === 0) {
      // A VSIX is a zip: the executable bit can be lost on the way in.
      fs.chmodSync(file, st.mode | 0o755);
    }
    return true;
  } catch {
    return false;
  }
}

function onPath(): string | null {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    const f = path.join(d, EXE);
    if (runnable(f)) return f;
  }
  return null;
}

export function findAtlarix(extensionPath: string, setting: string | undefined): string | null {
  if (setting?.trim() && runnable(setting.trim())) return setting.trim();
  const bundled = path.join(extensionPath, "bin", EXE);
  if (runnable(bundled)) return bundled;
  return onPath();
}
