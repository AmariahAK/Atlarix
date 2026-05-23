/**
 * Resolve Universal Ctags binary: packaged extraResource → dev assets → PATH.
 */

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

export function getCtagsPlatformKey(): string {
  const p = process.platform;
  const a = process.arch;
  if (p === "darwin") return a === "arm64" ? "darwin-arm64" : "darwin-x64";
  if (p === "win32") return "win32-x64";
  return a === "arm64" ? "linux-arm64" : "linux-x64";
}

function ctagsExecutableName(): string {
  return process.platform === "win32" ? "ctags.exe" : "ctags";
}

function isUniversalCtags(binaryPath: string): boolean {
  try {
    const out = execSync(`"${binaryPath}" --version`, {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return /Universal Ctags|universal.?ctags/i.test(out);
  } catch {
    return false;
  }
}

function tryPath(candidate: string): string | null {
  if (!candidate || !fs.existsSync(candidate)) return null;
  return isUniversalCtags(candidate) ? candidate : null;
}

/** Project root (Atlarix repo) for dev bundled binaries. */
function atlarixProjectRoot(): string {
  // src/lib/native → ../../../
  return path.resolve(__dirname, "../../..");
}

export function resolveCtagsPath(): string | null {
  const exe = ctagsExecutableName();

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require("electron") as typeof import("electron");
    if (app?.isPackaged) {
      const platformKey = getCtagsPlatformKey();
      const bundled = path.join(process.resourcesPath, platformKey, exe);
      const hit = tryPath(bundled);
      if (hit) return hit;
      // Legacy layout: Resources/ctags/ctags
      const legacy = path.join(process.resourcesPath, "ctags", exe);
      const legacyHit = tryPath(legacy);
      if (legacyHit) return legacyHit;
    }
  } catch {
    /* not in Electron */
  }

  const devBundled = path.join(
    atlarixProjectRoot(),
    "assets",
    "ctags",
    getCtagsPlatformKey(),
    exe,
  );
  const devHit = tryPath(devBundled);
  if (devHit) return devHit;

  const pathCandidates = [
    "/opt/homebrew/bin/ctags",
    "/usr/local/bin/ctags",
  ];
  for (const c of pathCandidates) {
    const hit = tryPath(c);
    if (hit) return hit;
  }

  // Last resort: PATH lookup — skip Apple Exuberant ctags at /usr/bin/ctags.
  try {
    const resolved = execSync(process.platform === "win32" ? "where ctags" : "which -a ctags", {
      encoding: "utf-8",
      timeout: 3000,
    })
      .trim()
      .split(/\r?\n/)
      .map((p) => p.trim())
      .filter(Boolean);
    for (const p of resolved) {
      if (p === "/usr/bin/ctags") continue;
      const hit = tryPath(p);
      if (hit) return hit;
    }
  } catch {
    /* continue */
  }

  return null;
}

export function getBundledCtagsResourceDir(): string {
  return path.join(atlarixProjectRoot(), "assets", "ctags", getCtagsPlatformKey());
}
