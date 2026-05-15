/**
 * Blueprint tools: lazy `get_blueprint` (Markdown + optional raw/panel graph),
 * read-only `set_blueprint` / `clear_blueprint` to push a **UI-only** mind-map
 * into the Diagram tab (no repo writes), plus `commit_blueprint` (Workforce).
 * Structural search still uses `search` with `mode: "structural"`.
 */

import {
  ToolRegistry,
  ToolCategory,
  createParameters,
  stringParam,
  enumParam,
  numberParam,
} from "./registry";
import { ensureBlueprintParsed } from "@/lib/blueprint/lazy-parse";
import { blueprintToMarkdown } from "@/lib/blueprint/blueprint-markdown";
import { snapshotBlueprintToRepo } from "@/lib/blueprint/blueprint-snapshot";
import { getBlueprintForWorkspace } from "@/ipc/handlers/blueprint_handlers";
import { getAtlarixAppPath } from "@/paths/paths";
import { getCurrentCommitHash } from "@/ipc/utils/git_utils";
import { SubscriptionManager } from "@/lib/SubscriptionManager";
import { db } from "@/db";
import { apps } from "@/db/schema";
import { eq } from "drizzle-orm";
import { app as electronApp } from "electron";
import log from "electron-log";
import type { Blueprint, BlueprintRoom } from "@/shared/blueprint-types";

const logger = log.scope("blueprint-tools");

function normalizePath(p: string): string {
  return String(p || "").trim().replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
}

function roomMatchesScope(
  room: BlueprintRoom,
  scope: "file" | "folder" | "full",
  targetPath: string | undefined,
): boolean {
  if (scope === "full") return true;
  if (!targetPath) return false;
  const t = normalizePath(targetPath).toLowerCase();
  const rp = normalizePath(room.path ?? "").toLowerCase();
  const fnFile = (room.functions ?? []).some(
    (fn) => normalizePath(fn.file ?? "").toLowerCase() === t,
  );
  if (scope === "file") {
    return rp === t || fnFile;
  }
  return rp === t || rp.startsWith(`${t}/`) || fnFile;
}

interface SliceResult {
  scope: "file" | "folder" | "full";
  path?: string;
  depth: number;
  totalRoomsInWorkspace: number;
  nodes: Array<{
    id: string;
    label: string;
    type?: string;
    path?: string;
    intent?: string;
    functionCount: number;
    functions: Array<{ id: string; name: string; kind: string; file?: string }>;
  }>;
  edges: Array<{ from: string; to: string; label?: string; type?: string; inferred?: boolean }>;
}

function buildSlice(
  blueprint: Blueprint,
  scope: "file" | "folder" | "full",
  targetPath: string | undefined,
  depth: number,
): SliceResult {
  const total = blueprint.rooms.length;
  const matched = blueprint.rooms.filter((r) => roomMatchesScope(r, scope, targetPath));
  const keepIds = new Set(matched.map((r) => r.id));

  // Expand by `depth` hops following the edges in either direction.
  const allEdges = blueprint.edges ?? [];
  for (let hop = 0; hop < Math.max(0, depth); hop++) {
    let grew = false;
    for (const e of allEdges) {
      if (keepIds.has(e.from) && !keepIds.has(e.to)) {
        keepIds.add(e.to);
        grew = true;
      } else if (keepIds.has(e.to) && !keepIds.has(e.from)) {
        keepIds.add(e.from);
        grew = true;
      }
    }
    if (!grew) break;
  }

  const nodes = blueprint.rooms
    .filter((r) => keepIds.has(r.id))
    .map((r) => ({
      id: r.id,
      label: r.label,
      type: r.type,
      path: r.path,
      intent: r.intent,
      functionCount: r.functions?.length ?? 0,
      functions: (r.functions ?? []).slice(0, 50).map((fn) => ({
        id: fn.id,
        name: fn.name,
        kind: fn.kind,
        file: fn.file,
      })),
    }));

  const edges = allEdges
    .filter((e) => keepIds.has(e.from) && keepIds.has(e.to))
    .map((e) => ({
      from: e.from,
      to: e.to,
      label: e.label,
      type: e.type,
      inferred: e.inferred,
    }));

  return {
    scope,
    path: targetPath,
    depth,
    totalRoomsInWorkspace: total,
    nodes,
    edges,
  };
}

const MAX_PANEL_ROOMS = 40;
const MAX_PANEL_EDGES = 80;
const MAX_FUNCS_PER_ROOM = 25;

/** Minimal graph for the Diagram-tab blueprint panel (from a parsed slice). */
function sliceToPanelGraph(slice: SliceResult): {
  rooms: Array<{ id: string; name: string; files?: string[]; functions?: string[] }>;
  edges: Array<{ from: string; to: string; type?: string }>;
} {
  const rooms = slice.nodes.slice(0, MAX_PANEL_ROOMS).map((n) => ({
    id: n.id,
    name: n.label,
    files: n.path ? [n.path] : undefined,
    functions: n.functions
      .slice(0, MAX_FUNCS_PER_ROOM)
      .map((f) => f.name)
      .filter(Boolean),
  }));
  const edges = slice.edges.slice(0, MAX_PANEL_EDGES).map((e) => ({
    from: e.from,
    to: e.to,
    type: e.type,
  }));
  return { rooms, edges };
}

function normalizeSetBlueprintInput(raw: {
  title?: string;
  rooms?: unknown[];
  edges?: unknown[];
}): {
  title?: string;
  rooms: Array<{ id: string; name: string; files?: string[]; functions?: string[] }>;
  edges: Array<{ from: string; to: string; type?: string }>;
} | { error: string } {
  const roomsIn = Array.isArray(raw.rooms) ? raw.rooms : [];
  const edgesIn = Array.isArray(raw.edges) ? raw.edges : [];
  if (roomsIn.length === 0) {
    return { error: "set_blueprint requires at least one room in `rooms`." };
  }
  const rooms: Array<{ id: string; name: string; files?: string[]; functions?: string[] }> = [];
  for (let i = 0; i < Math.min(roomsIn.length, MAX_PANEL_ROOMS); i++) {
    const r = roomsIn[i] as Record<string, unknown>;
    const id = String(r?.id ?? `room-${i}`).trim() || `room-${i}`;
    const name = String(r?.name ?? r?.label ?? id).trim() || id;
    const files = Array.isArray(r?.files)
      ? (r.files as unknown[]).map((f) => String(f)).filter(Boolean).slice(0, 12)
      : undefined;
    const functions = Array.isArray(r?.functions)
      ? (r.functions as unknown[]).map((f) => String(f)).filter(Boolean).slice(0, MAX_FUNCS_PER_ROOM)
      : undefined;
    rooms.push({ id, name, files, functions });
  }
  const edges: Array<{ from: string; to: string; type?: string }> = [];
  for (let i = 0; i < Math.min(edgesIn.length, MAX_PANEL_EDGES); i++) {
    const e = edgesIn[i] as Record<string, unknown>;
    const from = String(e?.from ?? "").trim();
    const to = String(e?.to ?? "").trim();
    if (!from || !to) continue;
    edges.push({
      from,
      to,
      type: e?.type != null ? String(e.type) : undefined,
    });
  }
  const title = raw.title != null ? String(raw.title).trim().slice(0, 200) : undefined;
  return { title, rooms, edges };
}

ToolRegistry.register({
  name: "get_blueprint",
  category: ToolCategory.SEARCH_INTELLIGENCE,
  // PASS8 B1: Description trimmed to ≤ 2 sentences.
  description:
    "Lazy read-only architecture slice (Markdown tree of files, functions, imports, edges). " +
    "Pass focus_path for multi-repo workspaces; include_raw:true for raw nodes/edges; include_panel_graph:true to also sync the Diagram-tab mind map.",
  cost: 3,
  requiresWorkspace: true,
  isCore: false,
  isReadOnly: true,
  allowInAskMode: true,
  parameters: createParameters(
    {
      scope: enumParam(
        "file | folder | full",
        "folder",
        ["file", "folder", "full"],
      ),
      path: stringParam(
        "Workspace-relative path (required for file/folder scope).",
      ),
      // PASS8 B4: focus_path scopes the walk into a sub-repo (e.g. 'packages/api')
      // before slicing. Useful when the workspace is a polyrepo / monorepo root.
      focus_path: stringParam(
        "Optional sub-repo prefix to scope into (e.g. 'packages/api'). When set, slicing is clamped to this subtree.",
      ),
      depth: numberParam(
        "Edge hops to expand (default 2, max 5).",
        2,
        0,
        5,
      ),
      // PASS8 B4: raw graph slice is opt-in. Default is markdown-only.
      include_raw: {
        type: "boolean",
        description: "When true, include the raw nodes/edges slice in the response. Default false (markdown only).",
      },
      include_panel_graph: {
        type: "boolean",
        description:
          "When true, include a normalized `graph` plus `_showInPanel` / `_panelType` so the Diagram tab can render the same slice as a mind map (UI only).",
      },
      workspaceId: { type: "number", description: "Workspace ID (auto-provided)" },
    },
    [],
  ),
  handler: async (params: {
    scope?: "file" | "folder" | "full";
    path?: string;
    focus_path?: string;
    depth?: number;
    include_raw?: boolean;
    include_panel_graph?: boolean;
    workspaceId?: number;
    workspace?: string;
  }) => {
    const scope = params.scope ?? "folder";
    const depth = Math.max(0, Math.min(5, params.depth ?? 2));
    const workspaceId = params.workspaceId;
    const includeRaw = params.include_raw === true;
    const includePanelGraph = params.include_panel_graph === true;

    if (workspaceId == null) {
      return {
        success: false,
        error: "get_blueprint requires a workspaceId (auto-provided by the runner).",
      };
    }

    // Tiered Blueprint system-prompt injection (blueprintPromptTiers) was removed in v8.1.1.
    // Architecture context is tool-driven only — call get_blueprint when you need a graph slice.
    try {
      const blueprint = await ensureBlueprintParsed(workspaceId);

      // PASS8 B4: When focus_path is set, clamp the walk to that subtree by
      // pre-filtering the blueprint rooms before slicing. The slice and markdown
      // both see only nodes under that prefix.
      const focus = normalizePath(params.focus_path ?? "").toLowerCase();
      const focusedBlueprint: Blueprint = focus
        ? {
            ...blueprint,
            rooms: blueprint.rooms.filter((r) => {
              const rp = normalizePath(r.path ?? "").toLowerCase();
              return rp === focus || rp.startsWith(`${focus}/`);
            }),
          }
        : blueprint;

      const slice = buildSlice(focusedBlueprint, scope, params.path, depth);

      // Build a Blueprint-shaped view of the slice so we can hand it to
      // `blueprintToMarkdown` (the same renderer the canvas uses).
      const keepIds = new Set(slice.nodes.map((n) => n.id));
      const sliceBlueprint: Blueprint = {
        rooms: focusedBlueprint.rooms.filter((r) => keepIds.has(r.id)),
        edges: (focusedBlueprint.edges ?? []).filter(
          (e) => keepIds.has(e.from) && keepIds.has(e.to),
        ),
        envRefs: focusedBlueprint.envRefs,
      };
      // PASS8 B4: 300-line cap for the AI tool path (was 500). Snapshot writes via
      // `snapshotBlueprintToRepo` continue to use their own (larger) cap.
      const markdown = blueprintToMarkdown(sliceBlueprint, {
        maxLines: 300,
        includeImports: true,
        includeExports: true,
      });

      const out: {
        success: true;
        markdown: string;
        nodeCount: number;
        edgeCount: number;
        focusPath?: string;
        raw?: SliceResult;
        _showInPanel?: boolean;
        _panelType?: "blueprint";
        graph?: ReturnType<typeof sliceToPanelGraph>;
      } = {
        success: true,
        markdown,
        nodeCount: slice.nodes.length,
        edgeCount: slice.edges.length,
      };
      if (focus) out.focusPath = params.focus_path;
      if (includeRaw) out.raw = slice;
      if (includePanelGraph) {
        out._showInPanel = true;
        out._panelType = "blueprint";
        out.graph = sliceToPanelGraph(slice);
      }
      return out;
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  },
});

ToolRegistry.register({
  name: "set_blueprint",
  category: ToolCategory.SEARCH_INTELLIGENCE,
  description:
    "Push a read-only architecture mind-map to the Diagram tab (replaces any prior AI panel blueprint). " +
    "Use after get_blueprint or your own reasoning; does not write files.",
  cost: 0,
  requiresWorkspace: true,
  isCore: false,
  isReadOnly: true,
  allowInAskMode: true,
  parameters: createParameters(
    {
      title: {
        type: "string",
        description: "Optional short title for the panel.",
      },
      rooms: {
        type: "array",
        description: "Rooms/containers (id, name, optional files[], functions[]).",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            files: { type: "array", items: { type: "string" } },
            functions: { type: "array", items: { type: "string" } },
          },
          required: ["id", "name"],
        },
      },
      edges: {
        type: "array",
        description: "Edges between room ids (from, to, optional type).",
        items: {
          type: "object",
          properties: {
            from: { type: "string" },
            to: { type: "string" },
            type: { type: "string" },
          },
          required: ["from", "to"],
        },
      },
      workspaceId: { type: "number", description: "Workspace ID (auto-provided)" },
    },
    ["rooms"],
  ),
  handler: async (params: {
    title?: string;
    rooms?: unknown[];
    edges?: unknown[];
    workspaceId?: number;
  }) => {
    if (params.workspaceId == null) {
      return { success: false, error: "set_blueprint requires workspaceId." };
    }
    const normalized = normalizeSetBlueprintInput({
      title: params.title,
      rooms: params.rooms,
      edges: params.edges,
    });
    if ("error" in normalized) {
      return { success: false, error: normalized.error };
    }
    return {
      success: true,
      message: "Blueprint panel updated (UI only).",
      _showInPanel: true,
      _panelType: "blueprint" as const,
      _action: "set" as const,
      workspaceId: params.workspaceId,
      title: normalized.title,
      rooms: normalized.rooms,
      edges: normalized.edges,
      graph: {
        rooms: normalized.rooms,
        edges: normalized.edges,
      },
    };
  },
});

ToolRegistry.register({
  name: "clear_blueprint",
  category: ToolCategory.SEARCH_INTELLIGENCE,
  description: "Clear the AI-pushed blueprint mind-map from the Diagram tab (UI only).",
  cost: 0,
  requiresWorkspace: true,
  isCore: false,
  isReadOnly: true,
  allowInAskMode: true,
  parameters: createParameters(
    {
      workspaceId: { type: "number", description: "Workspace ID (auto-provided)" },
    },
    [],
  ),
  handler: async (params: { workspaceId?: number }) => {
    if (params.workspaceId == null) {
      return { success: false, error: "clear_blueprint requires workspaceId." };
    }
    return {
      success: true,
      message: "Blueprint panel cleared.",
      _showInPanel: true,
      _panelType: "blueprint" as const,
      _action: "clear" as const,
      workspaceId: params.workspaceId,
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Pass 7 — `commit_blueprint`
// ─────────────────────────────────────────────────────────────────────────────

ToolRegistry.register({
  name: "commit_blueprint",
  category: ToolCategory.SEARCH_INTELLIGENCE,
  // PASS8 B1: Description trimmed to ≤ 2 sentences.
  description:
    "Save a Blueprint snapshot to .atlarix/blueprint.json (Workforce only). " +
    "Ask the user first — it writes a file to the repo.",
  cost: 1,
  requiresWorkspace: true,
  isCore: false,
  isReadOnly: false,
  allowInAskMode: false,
  parameters: createParameters(
    {
      workspaceId: { type: "number", description: "Workspace ID (auto-provided)" },
    },
    [],
  ),
  handler: async (params: { workspaceId?: number; workspace?: string }) => {
    const workspaceId = params.workspaceId;
    if (workspaceId == null) {
      return {
        success: false,
        error: "commit_blueprint requires a workspaceId (auto-provided by the runner).",
      };
    }

    try {
      if (SubscriptionManager.getEffectiveTier() !== "workforce") {
        return {
          success: false,
          error: "Blueprint commits require Workforce tier. Upgrade in Settings to enable.",
        };
      }

      const [appRow] = await db.select().from(apps).where(eq(apps.id, workspaceId)).limit(1);
      if (!appRow) {
        return { success: false, error: `Workspace ${workspaceId} not found.` };
      }

      const workspacePath = getAtlarixAppPath(appRow.path);
      const blueprint = await getBlueprintForWorkspace(workspaceId);

      let lastCommitHash: string | undefined;
      try {
        lastCommitHash = await getCurrentCommitHash({ path: workspacePath });
      } catch (e) {
        logger.warn("[commit_blueprint] No git HEAD (continuing):", e);
      }

      const result = await snapshotBlueprintToRepo({
        workspacePath,
        blueprint,
        workspaceName: appRow.name,
        atlarixVersion: electronApp.getVersion(),
        lastCommitHash,
      });

      return {
        success: true,
        path: result.path,
        nodeCount: result.nodeCount,
        edgeCount: result.edgeCount,
        firstCommit: result.firstCommit,
        message: result.firstCommit
          ? `Blueprint snapshot written to ${result.path} (first commit — consider adding it to git so your team gets the Blueprint on clone, or to .gitignore to keep it local).`
          : `Blueprint snapshot updated at ${result.path}.`,
      };
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  },
});
