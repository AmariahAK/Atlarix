import path from "node:path";
import os from "node:os";
import { IS_TEST_BUILD } from "../ipc/utils/test_utils";

/**
 * Gets the full path for an app.
 * - If appPath is ABSOLUTE, returns it as-is (user-chosen project root; new workspaces use this).
 * - If appPath is RELATIVE (legacy), resolves via ~/atlarix-apps/{appPath}. atlarix-apps is legacy storage only; new workspaces should use absolute paths (user-chosen project root).
 */
export function getAtlarixAppPath(appPath: string): string {
  // NEW: If path is absolute, use it directly (no copying to atlarix-apps)
  if (path.isAbsolute(appPath)) {
    return appPath;
  }

  // LEGACY: Relative paths resolve to the atlarix-apps folder
  if (IS_TEST_BUILD) {
    const electron = getElectron();
    return path.join(electron!.app.getPath("userData"), "atlarix-apps", appPath);
  }
  return path.join(os.homedir(), "atlarix-apps", appPath);
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
  // If it's an absolute path, use it directly
  if (path.isAbsolute(storedPath)) {
    return storedPath;
  }
  // Otherwise, it's a legacy relative path - resolve via atlarix-apps folder
  return getAtlarixAppPath(storedPath);
}

export function getTypeScriptCachePath(): string {
  const electron = getElectron();
  return path.join(electron!.app.getPath("sessionData"), "typescript-cache");
}

/**
 * Gets the user data path, handling both Electron and non-Electron environments
 * In Electron: returns the app's userData directory
 * In non-Electron: returns "./userData" in the current directory
 */

export function getUserDataPath(): string {
  const electron = getElectron();

  // When running in Electron and app is ready
  if (process.env.NODE_ENV !== "development" && electron) {
    return electron!.app.getPath("userData");
  }

  // For development or when the Electron app object isn't available
  return path.resolve("./userData");
}

/**
 * Get a reference to electron in a way that won't break in non-electron environments
 */
export function getElectron(): typeof import("electron") | undefined {
  let electron: typeof import("electron") | undefined;
  try {
    // Check if we're in an Electron environment
    if (process.versions.electron) {
      electron = require("electron");
    }
  } catch {
    // Not in Electron environment
  }
  return electron;
}
