import path from "node:path";
import os from "node:os";
import fs from "node:fs";

/**
 * Gets the full path for an app.
 * - If appPath is ABSOLUTE, returns it as-is (user-chosen project root; new workspaces use this).
 * - If appPath is RELATIVE (legacy), tries to resolve it to a real directory before falling back.
 *   Resolution order: ~/Documents/Atlarix/{name }, ~/atlarix-apps/{name} (legacy).
 *   If a real directory is found, returns the real absolute path so file operations target
 *   the actual workspace — not the legacy atlarix-apps folder.
 */
export function getAtlarixAppPath(appPath: string): string {
  if (path.isAbsolute(appPath)) {
    return appPath;
  }

  const appName = appPath;
  const legacyDefault = path.join(os.homedir(), "atlarix-apps", appName);

  const candidates = [
    path.join(os.homedir(), "Documents", "Atlarix", appName),
    path.join(os.homedir(), "atlarix-apps", appName),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return legacyDefault ?? path.join(os.homedir(), "atlarix-apps", appName);
}

/**
 * Resolves an app path from the database.
 * Handles both:
 * - ABSOLUTE paths (new imports after v0.7.0) - returns as-is
 * - RELATIVE paths (legacy imports) - resolves via getAtlarixAppPath
 *
 * This provides backward compatibility for existing imports.
 */
export function resolveAppPath(storedPath: string): string {
  if (path.isAbsolute(storedPath)) {
    return storedPath;
  }
  return getAtlarixAppPath(storedPath);
}

/** Canonical workspace path for installed-skills DB rows and lookups. */
export function normalizeSkillWorkspacePath(workspacePath: string): string {
  return resolveAppPath(workspacePath.trim());
}

export function getTypeScriptCachePath(): string {
  const electron = getElectron();
  return path.join(electron!.app.getPath("sessionData"), "typescript-cache");
}

export function getUserDataPath(): string {
  // Headless/automation override (the Electron-free agent CLI sets this to a
  // disposable per-run dir for its real sqlite DB + settings).
  if (process.env.ATLARIX_USER_DATA_DIR) {
    return process.env.ATLARIX_USER_DATA_DIR;
  }

  const electron = getElectron();

  if (process.env.NODE_ENV !== "development" && electron) {
    return electron!.app.getPath("userData");
  }

  return path.resolve("./userData");
}


/** True when the path is under legacy or default Atlarix clone roots (safe to offer disk delete). */
export function isAtlarixManagedWorkspacePath(absolutePath: string): boolean {
  if (!path.isAbsolute(absolutePath)) return false;
  const normalized = path.resolve(absolutePath);
  const roots = [
    path.join(os.homedir(), "atlarix-apps"),
    path.join(os.homedir(), "Documents", "Atlarix"),
  ];
  return roots.some(
    (root) => normalized === root || normalized.startsWith(`${root}${path.sep}`),
  );
}

export function getElectron(): typeof import("electron") | undefined {
  let electron: typeof import("electron") | undefined;
  try {
    if (process.versions.electron) {
      electron = require("electron");
    }
  } catch {
    // Not in Electron environment
  }
  return electron;
}
