/**
 * App version for prompts and UI — Electron when available, else package.json.
 */

import fs from "node:fs";
import path from "node:path";

let cachedVersion: string | null = null;

function readPackageVersion(): string | null {
  const candidates = [
    path.join(process.cwd(), "package.json"),
    path.join(__dirname, "../../package.json"),
    path.join(__dirname, "../../../package.json"),
  ];
  try {
    const { app } = require("electron") as {
      app?: { getAppPath?: () => string };
    };
    if (app?.getAppPath) {
      candidates.unshift(path.join(app.getAppPath(), "package.json"));
    }
  } catch {
    /* not in Electron */
  }
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = fs.readFileSync(p, "utf-8");
      const parsed = JSON.parse(raw) as { version?: string };
      if (typeof parsed.version === "string" && parsed.version.trim()) {
        return parsed.version.trim();
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

/** Semantic version string for Atlarix (never hard-coded in prompts). */
export function getAppVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const electron = require("electron") as {
      app?: { getVersion?: () => string };
    };
    const v = electron.app?.getVersion?.();
    if (v && v.trim()) {
      cachedVersion = v.trim();
      return cachedVersion;
    }
  } catch {
    /* not in Electron */
  }
  cachedVersion = readPackageVersion() ?? "unknown";
  return cachedVersion;
}
