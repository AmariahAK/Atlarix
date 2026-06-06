/**
 * Blueprint markdown generator — top-down Markdown tree for `get_blueprint`,
 * snapshot files, and diff-friendly views.
 *
 * Cross-cutting edges are serialised as `[[<type>: <target>]]` beneath the
 * source node so the model sees them as plain text.
 */

import log from "electron-log";

import type {
  Blueprint,
  BlueprintRoom,
  BlueprintEdge,
  BlueprintFunction,
} from "@/shared/blueprint-types";

const logger = log.scope("blueprint-markdown");

// ─────────────────────────────────────────────────────────────────────────────
// Markdown tree
// ─────────────────────────────────────────────────────────────────────────────

export type BlueprintMarkdownEmptyReason =
  | "unparsed"
  | "slice_empty"
  | "topic_filter";

export interface BlueprintMarkdownOptions {
  /** Cap on output lines (the tail is replaced with a truncation note). */
  maxLines?: number;
  /** Render `- imports:` lines beneath each room. */
  includeImports?: boolean;
  /** Render `- exports:` lines beneath each room (uses `room.functions`). */
  includeExports?: boolean;
  /** Workspace name used for the H1 title. */
  workspaceName?: string;
  /** Why the blueprint has no visible rooms (tool slice / topic filter). */
  emptyReason?: BlueprintMarkdownEmptyReason;
  /** Rooms in the parsed section before slicing (for slice_empty message). */
  parsedRoomCount?: number;
  /** Richer listing for `get_blueprint` tool responses. */
  toolMode?: boolean;
}

const DEFAULT_MAX_LINES = 500;

function safeLabel(label: string): string {
  return label.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
}

function clampHeading(depth: number): string {
  const level = Math.min(Math.max(depth, 1), 6);
  return "#".repeat(level);
}

function normaliseRoomPath(p?: string): string {
  return (p ?? "")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\//, "")
    .replace(/\/$/, "");
}

function pickRoomDirectory(room: BlueprintRoom): string {
  const p = normaliseRoomPath(room.path);
  if (!p) return "root";
  if (p.includes(".") && p.split("/").pop()?.includes(".")) {
    const parts = p.split("/");
    parts.pop();
    return parts.join("/") || "root";
  }
  return p;
}

function buildEdgeMaps(edges: BlueprintEdge[] | undefined) {
  const importsFrom = new Map<string, BlueprintEdge[]>();
  const importedBy = new Map<string, BlueprintEdge[]>();
  const callsFrom = new Map<string, BlueprintEdge[]>();
  const crossCuts = new Map<string, BlueprintEdge[]>();

  for (const e of edges ?? []) {
    const t = e.type ?? "import";
    if (t === "import") {
      const fwd = importsFrom.get(e.from) ?? [];
      fwd.push(e);
      importsFrom.set(e.from, fwd);
      const rev = importedBy.get(e.to) ?? [];
      rev.push(e);
      importedBy.set(e.to, rev);
    } else if (t === "call") {
      const list = callsFrom.get(e.from) ?? [];
      list.push(e);
      callsFrom.set(e.from, list);
    } else {
      const list = crossCuts.get(e.from) ?? [];
      list.push(e);
      crossCuts.set(e.from, list);
    }
  }

  return { importsFrom, importedBy, callsFrom, crossCuts };
}

function labelByRoomId(rooms: BlueprintRoom[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of rooms) m.set(r.id, r.label || r.path || r.id);
  return m;
}

function fnFileLabel(fn: BlueprintFunction): string | undefined {
  const raw = fn.file ?? fn.description;
  if (!raw) return undefined;
  return raw.replace(/\\/g, "/").replace(/^\//, "");
}

function countSymbols(rooms: BlueprintRoom[]): number {
  let n = 0;
  for (const r of rooms) {
    if (r.hidden) continue;
    n += r.functions?.length ?? 0;
  }
  return n;
}

/**
 * Convert a `Blueprint` (rooms + edges) to a top-down Markdown tree.
 * The same string is consumed by Mind Elixir's RTE pass, by
 * `.atlarix/blueprint.json`, and by the AI via `get_blueprint`.
 */
export function blueprintToMarkdown(
  blueprint: Blueprint,
  options: BlueprintMarkdownOptions = {},
): string {
  const {
    maxLines = DEFAULT_MAX_LINES,
    includeImports = true,
    includeExports = true,
    workspaceName,
    emptyReason = "unparsed",
    parsedRoomCount,
    toolMode = false,
  } = options;

  const rooms = (blueprint.rooms ?? []).filter((r) => !r.hidden);
  const edges = blueprint.edges ?? [];
  const symbolCount = countSymbols(rooms);
  const idLabels = labelByRoomId(rooms);
  const edgeMaps = buildEdgeMaps(edges);
  const exportCap = toolMode ? 12 : 5;

  const lines: string[] = [];
  const push = (line: string): boolean => {
    if (lines.length >= maxLines) return false;
    lines.push(line);
    return true;
  };

  push(`# ${safeLabel(workspaceName ?? "Workspace")}`);

  if (toolMode && rooms.length > 0) {
    push(
      `> ${rooms.length} room(s), ${symbolCount} symbol(s), ${edges.length} cross-room edge(s)`,
    );
  }

  if (rooms.length === 0) {
    push("");
    if (emptyReason === "topic_filter") {
      push(
        "> No rooms matched the topic filter. Try a broader topic or omit `topic`.",
      );
    } else if (emptyReason === "slice_empty") {
      const n = parsedRoomCount ?? 0;
      push(
        `> Parse found ${n} room(s) in this section, but the requested slice matched none. Use \`scope: "full"\` or omit \`path\`.`,
      );
    } else {
      push("> No blueprint data for this section yet.");
    }
    return lines.join("\n");
  }

  // Group rooms by directory, sort directories lexicographically.
  const byDir = new Map<string, BlueprintRoom[]>();
  for (const room of rooms) {
    const dir = pickRoomDirectory(room);
    const list = byDir.get(dir) ?? [];
    list.push(room);
    byDir.set(dir, list);
  }
  const sortedDirs = [...byDir.keys()].sort();

  for (const dir of sortedDirs) {
    if (lines.length >= maxLines) break;

    const segments = dir === "root" ? [] : dir.split("/");
    const depth = segments.length === 0 ? 1 : segments.length + 1;
    const headerLabel = dir === "root" ? "root" : segments[segments.length - 1];
    if (!push(`${clampHeading(depth + 1)} ${safeLabel(headerLabel)}`)) break;

    const roomsInDir = byDir.get(dir) ?? [];
    for (const room of roomsInDir) {
      if (lines.length >= maxLines) break;

      const fileName =
        room.path?.split("/").pop()?.trim() || room.label || room.id;
      if (!push(`${clampHeading(depth + 2)} ${safeLabel(fileName)}`)) break;

      if (room.intent) {
        if (!push(`- intent: ${safeLabel(room.intent)}`)) break;
      }

      if (includeExports) {
        const allFns = room.functions ?? [];
        if (toolMode && allFns.length > 0) {
          for (const fn of allFns.slice(0, exportCap)) {
            const file = fnFileLabel(fn);
            // v12 Tier 6 #3: prefer the ctags signature (`fn(a, b)`, carried
            // in simpleDescription with source "pattern"/"jsdoc") over the
            // bare name — ~same tokens, lets the model pick the right function
            // without an extra read_file. Skip AI-generated descriptions
            // (source "ai"/"ollama") which aren't signatures.
            const sig =
              fn.simpleDescription &&
              fn.descriptionSource !== "ai" &&
              fn.descriptionSource !== "ollama" &&
              fn.simpleDescription.includes("(")
                ? fn.simpleDescription
                : fn.name;
            const line = file
              ? `- \`${safeLabel(sig)}\` (file: ${safeLabel(file)})`
              : `- \`${safeLabel(sig)}\``;
            if (!push(line)) break;
          }
          if (allFns.length > exportCap) {
            if (!push(`- … ${allFns.length - exportCap} more`)) break;
          }
        } else {
          const fns = allFns.slice(0, exportCap).map((f) => f.name);
          if (fns.length > 0) {
            const more = allFns.length > exportCap ? "…" : "";
            if (!push(`- exports: ${fns.join(", ")}${more}`)) break;
          }
        }
      }

      if (includeImports) {
        const importEdges = edgeMaps.importsFrom.get(room.id) ?? [];
        const importLabels = importEdges
          .slice(0, 5)
          .map((e) => idLabels.get(e.to) ?? e.to);
        if (importLabels.length > 0) {
          const more = importEdges.length > 5 ? "…" : "";
          if (!push(`- imports: ${importLabels.join(", ")}${more}`)) break;
        }
      }

      const calls = edgeMaps.callsFrom.get(room.id) ?? [];
      if (calls.length > 0) {
        const callLabels = calls.slice(0, 3).map((e) => idLabels.get(e.to) ?? e.to);
        const more = calls.length > 3 ? "…" : "";
        if (!push(`- calls: ${callLabels.join(", ")}${more}`)) break;
      }

      const crossCuts = edgeMaps.crossCuts.get(room.id) ?? [];
      for (const xc of crossCuts.slice(0, 4)) {
        const target = idLabels.get(xc.to) ?? xc.to;
        const type = xc.type ?? "depends-on";
        if (!push(`- [[${type}: ${safeLabel(target)}]]`)) break;
      }
    }
  }

  if (lines.length >= maxLines) {
    lines.push(`> ... (truncated — ${rooms.length} rooms total)`);
  }

  const result = lines.join("\n");
  logger.info(
    `[blueprint-markdown] Generated ${lines.length} lines for ${rooms.length} rooms / ${edges.length} edges`,
  );
  return result;
}
