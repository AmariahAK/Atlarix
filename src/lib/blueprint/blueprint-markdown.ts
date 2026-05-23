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
} from "@/shared/blueprint-types";

const logger = log.scope("blueprint-markdown");

// ─────────────────────────────────────────────────────────────────────────────
// Markdown tree
// ─────────────────────────────────────────────────────────────────────────────

export interface BlueprintMarkdownOptions {
  /** Cap on output lines (the tail is replaced with a truncation note). */
  maxLines?: number;
  /** Render `- imports:` lines beneath each room. */
  includeImports?: boolean;
  /** Render `- exports:` lines beneath each room (uses `room.functions`). */
  includeExports?: boolean;
  /** Workspace name used for the H1 title. */
  workspaceName?: string;
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
  } = options;

  const rooms = (blueprint.rooms ?? []).filter((r) => !r.hidden);
  const edges = blueprint.edges ?? [];
  const idLabels = labelByRoomId(rooms);
  const edgeMaps = buildEdgeMaps(edges);

  const lines: string[] = [];
  const push = (line: string): boolean => {
    if (lines.length >= maxLines) return false;
    lines.push(line);
    return true;
  };

  push(`# ${safeLabel(workspaceName ?? "Workspace")}`);

  if (rooms.length === 0) {
    push("");
    push("> Blueprint is empty — open a workspace and let the RTE parse it.");
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
        const fns = (room.functions ?? []).slice(0, 5).map((f) => f.name);
        if (fns.length > 0) {
          const more = (room.functions?.length ?? 0) > 5 ? "…" : "";
          if (!push(`- exports: ${fns.join(", ")}${more}`)) break;
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
