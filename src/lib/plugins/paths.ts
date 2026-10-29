/**
 * Where plugins live: `<atlarixHomeDir>/plugins/<name>/`, with the install record
 * beside them in `<atlarixHomeDir>/plugins.json` and the user's own hooks in
 * `<atlarixHomeDir>/hooks.json`.
 *
 * USER LEVEL ONLY, AND THAT IS THE WHOLE TRUST MODEL. Workspace hooks were deleted
 * in v14.26 after v14.25 showed the agent writing `.atlarix/hooks/hooks.json` and
 * granting itself shell, and v14.45 removed the repo override of mode prompts. A
 * repository is someone else's input; nothing here is ever read from one. A plugin
 * exists because the person installed it, and these paths are the only places it
 * can be.
 *
 * The record is NOT inside a plugin's folder: a plugin cannot vouch for itself.
 * Following `atlarixHomeDir()` means a scratch profile gets its own plugins, so a
 * QA run never loads (or installs into) the person's.
 */

import fs from "node:fs";
import path from "node:path";
import { atlarixHomeDir } from "@/paths/atlarix-home";

export function pluginsRootDir(): string {
  return path.join(atlarixHomeDir(), "plugins");
}

export function pluginDir(name: string): string {
  return path.join(pluginsRootDir(), name);
}

/** Downloads and copies land here first and are renamed into place on approval. */
export function pluginStagingDir(): string {
  return path.join(pluginsRootDir(), ".staging");
}

export function pluginRecordsPath(): string {
  return path.join(atlarixHomeDir(), "plugins.json");
}

export function userHooksPath(): string {
  return path.join(atlarixHomeDir(), "hooks.json");
}

/**
 * True when `absPath` is one of the files that decide what plugins and hooks run:
 * anything under the plugins folder, the record, or the user's hooks file. Every
 * agent write to one of these asks, and no saved rule can answer for it.
 */
export function isPluginControlPath(absPath: string): boolean {
  const target = normalizeForCompare(path.resolve(absPath));
  // The control paths as configured AND as they really are: `~/.atlarix` can
  // itself be a link (a dotfiles repo), and a resolved target must still match.
  return controlPathSpellings().some(({ root, files }) => {
    if (target === root || target.startsWith(root + path.sep)) return true;
    return files.includes(target);
  });
}

function controlPathSpellings(): Array<{ root: string; files: string[] }> {
  const configured = {
    root: pluginsRootDir(),
    files: [pluginRecordsPath(), userHooksPath()],
  };
  const real = (p: string) => {
    try {
      return path.join(fs.realpathSync(path.dirname(p)), path.basename(p));
    } catch {
      return p;
    }
  };
  return [
    configured,
    { root: real(configured.root), files: configured.files.map(real) },
  ].map((s) => ({
    root: normalizeForCompare(s.root),
    files: s.files.map(normalizeForCompare),
  }));
}

function normalizeForCompare(p: string): string {
  const resolved = path.resolve(p);
  // macOS and Windows file systems are case-insensitive by default.
  return process.platform === "linux" ? resolved : resolved.toLowerCase();
}

/** Plugin names are folder names: lowercase, no separators, no dot-leading. */
export const PLUGIN_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function isValidPluginName(name: string): boolean {
  return PLUGIN_NAME_RE.test(name) && !name.includes("..");
}

/**
 * `~/.agents/skills`, where `npx skills add` installs Agent Skills (Cloudflare's
 * security-audit among them). Read-only, listed in the skill index; Atlarix never
 * writes there. Beside `atlarixHomeDir()` so a scratch profile or a test run gets
 * its own (`<profile>/.agents/skills`) instead of the person's.
 */
export function userAgentSkillsParentDir(): string {
  return path.join(path.dirname(atlarixHomeDir()), ".agents");
}
