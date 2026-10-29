/**
 * The install record, `<atlarixHomeDir>/plugins.json`: one entry per installed
 * plugin, holding what the person approved.
 *
 * `files` is the sha256 of every file at install; each load recomputes it and a
 * difference turns the plugin off (`registry.ts`). `runnablesDigest` and
 * `approvedHooks` are what the second confirm showed; they are checked again at run
 * time, so a hook runs only if its command is one the person saw.
 *
 * Written with a temp file + rename so a crash never leaves half a record. An
 * unreadable record reads as "nothing installed" — every plugin off, which is the
 * safe direction — and is logged, never rewritten from a guess.
 */

import fs from "node:fs";
import path from "node:path";
import log from "electron-log";
import type { PluginFormat } from "./manifest";
import { pluginRecordsPath } from "./paths";
import type { TreeHashes } from "./tree-hash";

const logger = log.scope("plugins");

export type PluginSource =
  | {
      kind: "github";
      owner: string;
      repo: string;
      ref?: string;
      subdir?: string;
    }
  | { kind: "local"; path: string };

export interface PluginRecord {
  name: string;
  format: PluginFormat;
  version: string;
  source: PluginSource;
  /** The commit a GitHub install is pinned to. */
  sha?: string;
  installedAt: string;
  files: TreeHashes;
  runnablesDigest: string;
  approvedHooks: string[];
  enabled: boolean;
  /** Folders it is on for; null = every folder. */
  folders: string[] | null;
  /** The person's model for this plugin's agents; wins over the plugin's own. */
  model?: string;
}

interface RecordFile {
  version: 1;
  plugins: PluginRecord[];
}

export function readPluginRecords(): PluginRecord[] {
  const file = pluginRecordsPath();
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  try {
    const data = JSON.parse(raw) as Partial<RecordFile>;
    return Array.isArray(data.plugins) ? data.plugins.filter(isRecord) : [];
  } catch (err) {
    logger.warn(
      `plugins.json unreadable; every plugin stays off: ${String(err)}`,
    );
    return [];
  }
}

function isRecord(r: unknown): r is PluginRecord {
  if (!r || typeof r !== "object") return false;
  const p = r as Record<string, unknown>;
  return (
    typeof p.name === "string" &&
    !!p.files &&
    typeof p.files === "object" &&
    typeof p.runnablesDigest === "string" &&
    Array.isArray(p.approvedHooks)
  );
}

export function writePluginRecords(records: PluginRecord[]): void {
  const file = pluginRecordsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const body: RecordFile = {
    version: 1,
    plugins: [...records].sort((a, b) => a.name.localeCompare(b.name)),
  };
  fs.writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function updatePluginRecord(
  name: string,
  change: (r: PluginRecord) => PluginRecord | null,
): PluginRecord | null {
  const records = readPluginRecords();
  const i = records.findIndex((r) => r.name === name);
  if (i < 0) return null;
  const next = change(records[i]!);
  if (next) records[i] = next;
  else records.splice(i, 1);
  writePluginRecords(records);
  return next;
}
