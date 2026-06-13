/**
 * Blueprint tools: lazy `get_blueprint` (Markdown + optional raw/panel graph),
 * `commit_blueprint` (Workforce). Panel-push blueprint tools removed — use inline markmap in chat.
 * Structural search still uses `search` with `mode: "structural"`.
 */

import {
  ToolRegistry,
  createParameters,
  stringParam,
  enumParam,
  numberParam,
} from "./registry";
import { ensureBlueprintParsed } from "@/lib/blueprint/lazy-parse";
import {
  blueprintFailureEnvelope,
  blueprintRequiresFocusPathError,
  blueprintWorkspaceRootFocusPathError,
  filterBlueprintByTopic,
  isWorkspaceRootFocusPath,
  normalizeBlueprintFocusPath,
} from "@/lib/blueprint/parse-scope";
import { listWorkspaceSectionCandidates } from "@/lib/blueprint/section-path";
import { blueprintToMarkdown, type BlueprintMarkdownEmptyReason } from "@/lib/blueprint/blueprint-markdown";
import {
  buildSliceWithResolve,
  countVisibleRooms,
  bm25HitsToRoomScores,
  type SliceResult,
} from "@/lib/blueprint/blueprint-slice";
import { searchBlueprintBm25 } from "@/lib/search/bm25_semantic_index";
import {
  sliceCacheKey,
  getCachedSlice,
  setCachedSlice,
} from "@/lib/blueprint/blueprint-slice-cache";

import {
  getBlueprintSectionMeta,
} from "@/ipc/handlers/blueprint_handlers";
import {
  assessBlueprintRichness,
  countBlueprintFunctions,
} from "@/lib/blueprint/blueprint-quality";
import { validateBlueprintFocusPath } from "@/lib/blueprint/section-path";
import { getAtlarixAppPath } from "@/paths/paths";


import { db } from "@/db";
import { apps } from "@/db/schema";
import { eq } from "drizzle-orm";

import log from "electron-log";
import type { Blueprint } from "@/shared/blueprint-types";

const logger = log.scope("blueprint-tools");

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

ToolRegistry.register({
  name: "get_blueprint",
  // PASS8 B1: Description trimmed to ≤ 2 sentences.
  description:
    "Section-scoped architecture slice (requires focus_path). Work sequentially: overview → pick section → get_blueprint. " +
    "Optional topic filters rooms; include_raw / include_panel_graph for graph payloads.",
  requiresWorkspace: true,
  isCore: false,
  isReadOnly: true,
  allowInAskMode: true,
  parameters: createParameters(
    {
      scope: enumParam(
        "file | folder | full",
        "full",
        ["file", "folder", "full"],
      ),
      path: stringParam(
        "Optional section-relative subfolder or file (e.g. src or src/index.ts). Omit for the whole section.",
      ),
      // PASS8 B4: focus_path scopes the walk into a sub-repo (e.g. 'packages/api')
      // before slicing. Useful when the workspace is a polyrepo / monorepo root.
      focus_path: stringParam(
        "Required top-level section folder (e.g. 'packages/api' or 'backend'). Not '.' or workspace root.",
      ),
      topic: stringParam(
        "Optional filter: room/function names matching this string (use | for alternates, e.g. payment|stripe).",
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
          "When true, include a normalized `graph` object for the architecture slice (markdown is always returned).",
      },
      workspaceId: { type: "number", description: "Workspace ID (auto-provided)" },
    },
    ["focus_path"],
  ),
  handler: async (params: {
    scope?: "file" | "folder" | "full";
    path?: string;
    focus_path?: string;
    topic?: string;
    depth?: number;
    include_raw?: boolean;
    include_panel_graph?: boolean;
    workspaceId?: number;
    workspace?: string;
  }) => {
    const scope = params.scope ?? "full";
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

    const focusPath = normalizeBlueprintFocusPath(params.focus_path ?? "");
    if (!focusPath) {
      return blueprintRequiresFocusPathError();
    }

    const [appRow] = await db.select().from(apps).where(eq(apps.id, workspaceId)).limit(1);
    if (!appRow) {
      return { success: false, error: `Workspace ${workspaceId} not found.` };
    }
    const workspacePath = getAtlarixAppPath(appRow.path);

    if (isWorkspaceRootFocusPath(focusPath)) {
      const suggestions = await listWorkspaceSectionCandidates(workspacePath);
      return blueprintWorkspaceRootFocusPathError(suggestions);
    }

    const pathValidation = await validateBlueprintFocusPath(workspacePath, focusPath);
    if (!pathValidation.valid) {
      return {
        success: false,
        error: pathValidation.error ?? `Section not found: "${focusPath}"`,
        hint:
          "Use explore_folder or get_repo_overview to pick an exact workspace-relative folder name.",
        suggestions: pathValidation.suggestions,
        scanRoot: pathValidation.scanRoot,
        sequential_workflow: true,
      };
    }

    try {
      const blueprint = await ensureBlueprintParsed(workspaceId, { focusPath });

      if (countVisibleRooms(blueprint) === 0) {
        return {
          success: false,
          error: "Blueprint parse produced no rooms for this section.",
          hint:
            "Check that the folder contains source files and is not fully ignored by .atlarix/.atlarixignore. For Python/Go/etc. ensure pyproject.toml, go.mod, or similar is present.",
          focusPath,
          scanRoot: pathValidation.scanRoot,
          parseQuality: "thin" as const,
        };
      }

      const { blueprint: topicFiltered, applied: topicApplied } = filterBlueprintByTopic(
        blueprint,
        params.topic,
      );
      const focusedBlueprint = topicFiltered;
      const parsedRoomCount = countVisibleRooms(blueprint);
      const topicVisibleCount = countVisibleRooms(focusedBlueprint);
      const richness = assessBlueprintRichness(blueprint);
      const functionCount = countBlueprintFunctions(blueprint.rooms ?? []);
      const sectionMeta = getBlueprintSectionMeta(workspaceId, focusPath);

      // v12 Tier 6 #5: serve a memoized slice when nothing changed. Cache is
      // dropped per-workspace on any blueprint reparse (markBlueprintSliceDirty).
      const cacheKey = sliceCacheKey({
        workspaceId,
        focusPath,
        topic: params.topic,
        scope,
        path: params.path,
        depth,
      });
      const cachedSlice = getCachedSlice(cacheKey, workspaceId);

      let slice: SliceResult;
      let sliceWidened: boolean;
      if (cachedSlice) {
        ({ slice, sliceWidened } = cachedSlice);
      } else {
        // v12 Tier 6 #1: fuse BM25 text relevance into slice ranking. The topic
        // (also the name-filter above) doubles as the BM25 query; the resulting
        // per-room relevance map biases the slice toward the topic-relevant
        // module, not just structural hubs. Best-effort — a null/empty result
        // leaves ranking at centrality-only.
        let bm25ScoreByRoom: Map<string, number> | undefined;
        const topicQuery = params.topic?.trim();
        if (topicQuery) {
          try {
            const bm25 = await searchBlueprintBm25(
              workspaceId,
              workspacePath,
              topicQuery,
              200,
            );
            if (bm25 && bm25.hits.length > 0) {
              bm25ScoreByRoom = bm25HitsToRoomScores(
                focusedBlueprint.rooms,
                bm25.hits,
              );
            }
          } catch (e) {
            logger.warn("get_blueprint: BM25 fusion skipped", { error: String(e) });
          }
        }

        const built = buildSliceWithResolve(
          focusedBlueprint,
          scope,
          params.path,
          focusPath,
          depth,
          bm25ScoreByRoom,
        );
        slice = built.slice;
        sliceWidened = built.sliceWidened;
        setCachedSlice(cacheKey, workspaceId, slice, sliceWidened);
      }

      if (sliceWidened) {
        logger.info("get_blueprint: slice empty, widened to full section", {
          focusPath,
          scope,
          path: params.path,
          parsedRoomCount: topicVisibleCount,
        });
      }

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

      let emptyReason: BlueprintMarkdownEmptyReason | undefined;
      if (sliceBlueprint.rooms.filter((r) => !r.hidden).length === 0) {
        if (params.topic?.trim() && topicApplied && topicVisibleCount === 0) {
          emptyReason = "topic_filter";
        } else if (parsedRoomCount > 0) {
          emptyReason = "slice_empty";
        } else {
          emptyReason = "unparsed";
        }
      }

      if (
        emptyReason === "slice_empty" &&
        slice.nodes.length === 0 &&
        topicVisibleCount > 0
      ) {
        return {
          success: false,
          error: `Blueprint slice matched no rooms (${topicVisibleCount} parsed in section).`,
          hint: 'Use scope: "full" or omit path. Section paths are relative to focus_path (e.g. "src", not ".")',
          focusPath,
          parsedRoomCount,
          sliceRoomCount: 0,
        };
      }

      // PASS8 B4: 300-line cap for the AI tool path (was 500). Snapshot writes via
      // `snapshotBlueprintToRepo` continue to use their own (larger) cap.
      const MAX_BLUEPRINT_MARKDOWN_CHARS = 48_000;
      let markdown = blueprintToMarkdown(sliceBlueprint, {
        maxLines: 300,
        includeImports: true,
        includeExports: true,
        emptyReason,
        parsedRoomCount: topicVisibleCount || parsedRoomCount,
        toolMode: true,
      });
      // v12 Tier 6 #2: summarize the centrality-capped tail rather than
      // truncating it silently — the model sees what was dropped.
      if (slice.omittedRooms && slice.omittedRooms.count > 0) {
        markdown += `\n\n+${slice.omittedRooms.count} more rooms (lower centrality): ${slice.omittedRooms.labels.join(", ")}${
          slice.omittedRooms.count > slice.omittedRooms.labels.length ? ", …" : ""
        }`;
      }
      // v12 S20: scan honesty — dynamic/member call sites produce no edge, so
      // tell the model the call graph is a floor, not the whole truth.
      if (sectionMeta.dynamicCallCount && sectionMeta.dynamicCallCount > 0) {
        markdown += `\n\nNote: ~${sectionMeta.dynamicCallCount} call sites use member/computed callees (e.g. obj.method(), obj[fn]()) and are not in the edge graph — connectivity is under-reported; treat missing edges as "unknown", not "no relationship".`;
      }
      if (markdown.length > MAX_BLUEPRINT_MARKDOWN_CHARS) {
        markdown =
          markdown.slice(0, MAX_BLUEPRINT_MARKDOWN_CHARS) +
          "\n\n… [blueprint markdown truncated for context size]";
      }

      const autoGraph =
        richness.quality === "thin" || functionCount < 15;

      const out: {
        success: true;
        markdown: string;
        nodeCount: number;
        edgeCount: number;
        parsedRoomCount: number;
        sliceRoomCount: number;
        functionCount: number;
        parseQuality: typeof richness.quality;
        parseEngine?: string;
        dynamicCallCount?: number;
        sliceWidened?: boolean;
        graphAutoIncluded?: boolean;
        focusPath?: string;
        raw?: SliceResult;
        graph?: ReturnType<typeof sliceToPanelGraph>;
      } = {
        success: true,
        markdown,
        nodeCount: slice.nodes.length,
        edgeCount: slice.edges.length,
        parsedRoomCount,
        sliceRoomCount: slice.nodes.length,
        functionCount,
        parseQuality: richness.quality,
      };
      out.focusPath = focusPath;
      if (sectionMeta.engine) out.parseEngine = sectionMeta.engine;
      if (sectionMeta.dynamicCallCount) {
        out.dynamicCallCount = sectionMeta.dynamicCallCount; // v12 S20
      }
      if (sliceWidened) out.sliceWidened = true;
      if (params.topic?.trim()) {
        (out as { topic?: string; topicFilterApplied?: boolean }).topic = params.topic;
        (out as { topicFilterApplied?: boolean }).topicFilterApplied = topicApplied;
      }
      if (includeRaw) out.raw = slice;
      if (includePanelGraph || autoGraph) {
        out.graph = sliceToPanelGraph(slice);
        if (autoGraph && !includePanelGraph) out.graphAutoIncluded = true;
      }
      return out;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const timedOut = /timed out/i.test(msg);
      return blueprintFailureEnvelope(msg, { focusPath, timedOut });
    }
  },
});

// DEAD? set_blueprint / clear_blueprint removed — architecture viz is inline via ```markmap``` in chat.

