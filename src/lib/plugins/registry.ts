/**
 * The plugins that apply right now, VERIFIED ON EVERY LOAD.
 *
 * For each installed plugin that is on, and on for this folder:
 * 1. Re-hash every file and compare with the install record. Any difference —
 *    an edited, added or removed file — and the plugin does not load.
 * 2. Re-read it and compare its runnables (hooks, MCP servers, agents that run
 *    tools, mod capabilities) with the digest the person approved. A difference
 *    here with identical files means THIS VERSION OF ATLARIX now reads something
 *    the person was never shown (a hook event that used to be unsupported, say),
 *    so it waits for their OK again rather than starting to run it.
 *
 * Problems are returned, not thrown: one bad plugin never stops a turn, and each
 * surface shows the line once. Nothing here writes — a load never changes the
 * record, so a racing writer can never make a load turn something on.
 */

import fs from "node:fs";
import path from "node:path";
import log from "electron-log";
import { parseHooksJson, type PluginHook } from "./hooks-config";
import {
  describeRunnables,
  PluginManifestError,
  readPluginContents,
  runnablesDigest,
  type PluginContents,
} from "./manifest";
import { pluginDir, userHooksPath } from "./paths";
import { readPluginRecords, type PluginRecord } from "./store";
import { diffTrees, hashTree, PluginTreeError } from "./tree-hash";

const logger = log.scope("plugins");

export interface ActivePlugin {
  record: PluginRecord;
  dir: string;
  contents: PluginContents;
}

export interface PluginProblem {
  name: string;
  message: string;
}

export interface PluginLoad {
  plugins: ActivePlugin[];
  /** `<atlarixHomeDir>/hooks.json` — the person's own, not a plugin's. */
  userHooks: PluginHook[];
  problems: PluginProblem[];
}

export function appliesToFolder(
  record: PluginRecord,
  workspacePath?: string | null,
): boolean {
  if (!record.folders) return true;
  if (!workspacePath) return false;
  const ws = path.resolve(workspacePath);
  return record.folders.some((f) => ws === f || ws.startsWith(f + path.sep));
}

export function loadPlugins(workspacePath?: string | null): PluginLoad {
  const plugins: ActivePlugin[] = [];
  const problems: PluginProblem[] = [];

  for (const record of readPluginRecords()) {
    if (!record.enabled || !appliesToFolder(record, workspacePath)) continue;
    const verified = verifyInstalledPlugin(record);
    if ("problem" in verified)
      problems.push({ name: record.name, message: verified.problem });
    else plugins.push(verified);
  }

  const { hooks: userHooks, problems: hookProblems } = loadUserHooks();
  problems.push(...hookProblems);
  return { plugins, userHooks, problems };
}

/** Null when every file matches the install record; otherwise the one-line reason. */
export function verifyPluginFiles(record: PluginRecord): string | null {
  const dir = pluginDir(record.name);
  if (!fs.existsSync(dir)) return `${record.name} is missing; reinstall it`;
  let changed: string[];
  try {
    changed = diffTrees(record.files, hashTree(dir));
  } catch (err) {
    if (err instanceof PluginTreeError) return `${record.name}: ${err.message}`;
    throw err;
  }
  if (changed.length === 0) return null;
  logger.warn(
    `plugin ${record.name} changed on disk: ${changed.slice(0, 5).join(", ")}`,
  );
  const more = changed.length > 1 ? ` +${changed.length - 1}` : "";
  return `${record.name} changed on disk since you installed it (${changed[0]}${more}); reinstall or update to use it`;
}

export function verifyInstalledPlugin(
  record: PluginRecord,
): ActivePlugin | { problem: string } {
  const dir = pluginDir(record.name);
  const filesProblem = verifyPluginFiles(record);
  if (filesProblem) return { problem: filesProblem };

  let contents: PluginContents;
  try {
    contents = readPluginContents(dir, record.name);
  } catch (err) {
    if (err instanceof PluginManifestError)
      return { problem: `${record.name}: ${err.message}` };
    throw err;
  }
  if (runnablesDigest(describeRunnables(contents)) !== record.runnablesDigest) {
    return {
      problem: `${record.name} needs your OK again for what it runs: open /augments to review it`,
    };
  }
  return { record, dir, contents };
}

export function loadUserHooks(): {
  hooks: PluginHook[];
  problems: PluginProblem[];
} {
  let raw: string;
  try {
    raw = fs.readFileSync(userHooksPath(), "utf8");
  } catch {
    return { hooks: [], problems: [] };
  }
  const parsed = parseHooksJson(raw);
  return {
    hooks: parsed.hooks,
    problems: parsed.unsupported.map((message) => ({
      name: "hooks.json",
      message,
    })),
  };
}
