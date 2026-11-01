/**
 * How the Usage page names what it groups by. Renderer-safe: no database, no Node.
 */

import { formatModelApiNameForDisplay } from "@/lib/format-openrouter-model-label";
import { editStatsModelLabel } from "./edit-stats-label";

/**
 * A name a turn's tool call supplied (an MCP server, a skill file), safe to draw
 * anywhere: no control or bidi characters (a terminal would run an escape
 * sequence; a model can be steered into naming anything), capped in length.
 */
/* eslint-disable no-control-regex -- stripping them is the point */
const UNPRINTABLE =
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;
/* eslint-enable no-control-regex */

export function printableName(name: string, max = 80): string {
  return name.replace(UNPRINTABLE, "").trim().slice(0, max);
}

/** A rollup model as the user reads it; Auto and history's Core slots by product name. */
export function usageModelLabel(
  row: { provider: string; modelId: string },
  /** Your own providers' names by id, so "custom::qa-bedrock" reads as the name you gave it. */
  providerNames?: Readonly<Record<string, string>>,
): string {
  if (row.provider === "compass" && row.modelId === "atlarix/auto")
    return "Atlarix Auto";
  if (row.provider === "compass" && row.modelId === "atlarix/core")
    return "Atlarix Core";
  if (row.provider === "unknown") return "Unknown model";
  // A name you typed reads as you typed it (the shared label lower-cases a slug).
  const name = providerNames?.[row.provider];
  if (name) return `${formatModelApiNameForDisplay(row.modelId)} (${name})`;
  return editStatsModelLabel(row);
}

/** The surface filter's key: app, cli, or the editor's own name (editor when it gave none). */
export function usageSurfaceKey(row: {
  surface: string;
  editor: string;
}): string {
  return row.surface === "editor" ? row.editor || "editor" : row.surface;
}

const EDITOR_NAMES: Record<string, string> = {
  vscode: "VS Code",
  "visual studio code": "VS Code",
  zed: "Zed",
  cursor: "Cursor",
  windsurf: "Windsurf",
};

export function usageSurfaceLabel(key: string): string {
  if (key === "app") return "App";
  if (key === "cli") return "CLI";
  if (key === "editor") return "Editors";
  const known = EDITOR_NAMES[key.toLowerCase()];
  if (known) return known;
  return printableName(key, 40).replace(/\b\w/g, (c) => c.toUpperCase());
}

export function usageSourceLabel(source: string): string {
  const names: Record<string, string> = {
    chat: "Chats",
    automation: "Automations",
    subagent: "Sub-agents",
    compaction: "Compaction",
    other: "Titles, recaps, memory",
  };
  return names[source] ?? source;
}

/** $1.24, $0.03, under $0.01. */
export function usdLabel(usd: number): string {
  if (usd > 0 && usd < 0.01) return "under $0.01";
  return `$${usd.toFixed(2)}`;
}
