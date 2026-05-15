/**
 * Pass 7 — Blueprint markdown generator.
 *
 * Two outputs:
 *   - `blueprintToMarkdown(bp, opts)`   — a top-down Markdown tree used by
 *     `get_blueprint` (AI context), the snapshot file, and any future
 *     diff-friendly view.
 *   - `blueprintToMindNodes(bp)`        — a Mind Elixir `NodeObj` tree + a
 *     list of cross-cutting `relations`. The renderer wraps this in
 *     `MindElixir.new()` and adds relation lines after init.
 *
 * Cross-cutting edges that do not fit the file-tree hierarchy (e.g. an API
 * route depending on a util in a different folder) are serialised in
 * markdown as a `[[<type>: <target>]]` line beneath the source node so the
 * AI sees them as plain text. The Mind Elixir tree carries the same edges
 * as relation arrows.
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

// ─────────────────────────────────────────────────────────────────────────────
// Mind Elixir tree
// ─────────────────────────────────────────────────────────────────────────────

/** A Mind Elixir-compatible node. Kept structural to avoid bundling the
 * library types in the shared layer; the renderer can cast to `NodeObj`. */
export interface MindNodeObj {
  id: string;
  topic: string;
  children?: MindNodeObj[];
  /** Stored on the node so the inverse mapping (`mindNodesToBlueprint`) can
   * recover the original Blueprint room/function metadata. */
  atlarix?: {
    kind: "workspace" | "directory" | "room" | "function";
    roomId?: string;
    functionId?: string;
    path?: string;
    type?: string;
  };
  style?: { background?: string; color?: string };
  tags?: string[];
}

export interface MindRelation {
  /** Source node id. */
  from: string;
  /** Target node id. */
  to: string;
  /** Label drawn on the relation line (e.g. "imports", "calls"). */
  label: string;
}

export interface MindElixirData {
  root: MindNodeObj;
  relations: MindRelation[];
}

function safeMindId(prefix: string, raw: string): string {
  // Mind Elixir tolerates arbitrary strings but we keep ids URL-safe so
  // the renderer can pass them through DOM attributes without escaping.
  const cleaned = raw.replace(/[^a-zA-Z0-9_.:#-]/g, "_");
  return `${prefix}:${cleaned}`;
}

/**
 * Build a Mind Elixir node tree from a Blueprint. Directories are inferred
 * from `room.path`; rooms become leaves under their directory; functions
 * become children of their room. Cross-cutting edges are returned as a
 * separate `relations` array — the renderer calls `mind.addLink(...)` for
 * each after `mind.init(...)`.
 */
export function blueprintToMindNodes(
  blueprint: Blueprint,
  options: { workspaceName?: string } = {},
): MindElixirData {
  const workspaceName = options.workspaceName ?? "Workspace";
  const rooms = (blueprint.rooms ?? []).filter((r) => !r.hidden);
  const edges = blueprint.edges ?? [];

  const root: MindNodeObj = {
    id: safeMindId("root", workspaceName),
    topic: safeLabel(workspaceName),
    children: [],
    atlarix: { kind: "workspace" },
  };

  if (rooms.length === 0) {
    return { root, relations: [] };
  }

  // Directory nodes keyed by full path ("src/components/Button.tsx"
  // sits under "src/components").
  const dirNodes = new Map<string, MindNodeObj>();
  function ensureDir(dirPath: string): MindNodeObj {
    if (dirPath === "" || dirPath === "root") return root;
    const existing = dirNodes.get(dirPath);
    if (existing) return existing;
    const parentPath = dirPath.includes("/")
      ? dirPath.slice(0, dirPath.lastIndexOf("/"))
      : "";
    const parent = ensureDir(parentPath);
    const node: MindNodeObj = {
      id: safeMindId("dir", dirPath),
      topic: safeLabel(dirPath.split("/").pop() ?? dirPath),
      children: [],
      atlarix: { kind: "directory", path: dirPath },
    };
    parent.children = parent.children ?? [];
    parent.children.push(node);
    dirNodes.set(dirPath, node);
    return node;
  }

  // Room nodes keyed by room id.
  const roomNodes = new Map<string, MindNodeObj>();
  for (const room of rooms) {
    const dir = pickRoomDirectory(room);
    const dirNode = ensureDir(dir === "root" ? "" : dir);
    const fileName =
      room.path?.split("/").pop()?.trim() || room.label || room.id;
    const node: MindNodeObj = {
      id: safeMindId("room", room.id),
      topic: safeLabel(fileName),
      atlarix: {
        kind: "room",
        roomId: room.id,
        path: room.path,
        type: room.type,
      },
    };

    if ((room.functions ?? []).length > 0) {
      node.children = room.functions!.map((fn) => ({
        id: safeMindId("fn", `${room.id}#${fn.id}`),
        topic: safeLabel(fn.name),
        atlarix: {
          kind: "function",
          roomId: room.id,
          functionId: fn.id,
          path: fn.file ?? room.path,
        },
      }));
    }

    dirNode.children = dirNode.children ?? [];
    dirNode.children.push(node);
    roomNodes.set(room.id, node);
  }

  // Cross-cutting relations: any edge whose source and target rooms are
  // both present becomes a relation line. We deliberately keep call/import
  // edges out of the tree so the layout stays as a clean file hierarchy.
  const relations: MindRelation[] = [];
  for (const e of edges) {
    const src = roomNodes.get(e.from);
    const dst = roomNodes.get(e.to);
    if (!src || !dst) continue;
    relations.push({
      from: src.id,
      to: dst.id,
      label: e.type ?? (e.inferred ? "inferred" : "import"),
    });
  }

  return { root, relations };
}

// ─────────────────────────────────────────────────────────────────────────────
// Inverse mapping (Mind Elixir → Blueprint)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert a Mind Elixir tree (after the user has edited it) back into a
 * `Blueprint` so the rest of the app — RTE, snapshots, `get_blueprint` —
 * keeps working. Rooms that originated from the Blueprint preserve their
 * original `roomId`; newly-added containers get a fresh id derived from
 * their topic.
 */
export function mindNodesToBlueprint(
  data: MindElixirData,
  previous: Blueprint,
): Blueprint {
  const prevRooms = new Map(previous.rooms.map((r) => [r.id, r]));
  const rooms: BlueprintRoom[] = [];
  const seen = new Set<string>();

  function walk(
    node: MindNodeObj,
    parentRoomId: string | undefined,
  ): void {
    const meta = node.atlarix;
    if (meta?.kind === "room") {
      const sourceRoomId = meta.roomId ?? node.id;
      const prev = prevRooms.get(sourceRoomId);
      const room: BlueprintRoom = {
        id: sourceRoomId,
        label: node.topic,
        type: prev?.type ?? meta.type,
        path: prev?.path ?? meta.path,
        intent: prev?.intent,
        functions: [],
        parentId: parentRoomId,
      };

      for (const child of node.children ?? []) {
        if (child.atlarix?.kind === "function") {
          const prevFn = prev?.functions.find(
            (f) => f.id === child.atlarix?.functionId,
          );
          room.functions.push({
            ...(prevFn ?? {
              id: child.atlarix?.functionId ?? child.id,
              kind: "function" as const,
              file: child.atlarix?.path,
            }),
            id: prevFn?.id ?? child.atlarix?.functionId ?? child.id,
            name: child.topic,
          });
        } else {
          walk(child, sourceRoomId);
        }
      }

      rooms.push(room);
      seen.add(sourceRoomId);
      return;
    }

    for (const child of node.children ?? []) walk(child, parentRoomId);
  }

  walk(data.root, undefined);

  // Carry over hidden / removedInferred metadata that the canvas does not
  // surface — losing it would silently re-introduce edges the user pruned.
  for (const prev of previous.rooms) {
    if (prev.hidden && !seen.has(prev.id)) rooms.push(prev);
  }

  // Rebuild edges from relations. Relation ids are `room:<originalId>` so
  // we strip the prefix to recover Blueprint room ids.
  const edges: BlueprintEdge[] = [];
  const stripPrefix = (id: string): string => {
    const idx = id.indexOf(":");
    return idx >= 0 ? id.slice(idx + 1) : id;
  };
  for (const rel of data.relations) {
    edges.push({
      from: stripPrefix(rel.from),
      to: stripPrefix(rel.to),
      type: (rel.label as BlueprintEdge["type"]) ?? "import",
    });
  }

  return {
    rooms,
    edges,
    envRefs: previous.envRefs,
    removedInferredEdgeKeys: previous.removedInferredEdgeKeys,
  };
}

