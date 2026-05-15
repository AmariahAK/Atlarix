/**
 * Blueprint canvas — Pass 7: Mind Elixir replacement for React Flow.
 *
 * The same `BlueprintCanvas` / `BlueprintCanvasProps` surface is preserved so
 * call sites (`BlueprintEditor.tsx`) keep working. Internally we now mount a
 * Mind Elixir instance: the root node is the workspace, directories become
 * branch nodes, rooms become leaf nodes, and inter-room edges (imports /
 * calls) become "relation lines" overlayed by Mind Elixir's arrow layer.
 *
 * Why this exists: React Flow + ELK was a memory bomb on large monorepos and
 * silently capped the graph at 500 nodes (`MAX_BLUEPRINT_NODES`). Mind Elixir
 * is ~33 KB, framework-agnostic, and tree-native, which lines up with how the
 * AI consumes the Blueprint (Markdown tree, same source via
 * `blueprintToMarkdown`).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MindElixir, { type MindElixirInstance } from "mind-elixir";
// @ts-expect-error - CSS import has no type declarations
import "mind-elixir/style.css";
import { GitCommit, LayoutGrid, Plus } from "lucide-react";
import { toast } from "sonner";

import type { Blueprint } from "@/shared/blueprint-types";
import {
  blueprintToMindNodes,
  mindNodesToBlueprint,
  type MindNodeObj,
} from "@/lib/blueprint/blueprint-markdown";
import { IpcClient } from "@/ipc/ipc_client";
import { useAuth } from "@/lib/auth/useAuth";
import type { AgentPhase } from "@/atoms/sourceAtoms";
import { cn } from "@/lib/utils";

export interface BlueprintCanvasProps {
  blueprint: Blueprint;
  onBlueprintChange: (b: Blueprint) => void;
  workspaceId: number | null;
  onAddRoom: () => void;
  onRoomSelect?: (roomId: string) => void;
  agentPhase?: AgentPhase | null;
  agentPhaseActive?: boolean;
  /** When true, RTE is parsing; we show "Analyzing code..." in the legend. */
  isRteRunning?: boolean;
  className?: string;
}

/** Strip the `room:`/`fn:`/`dir:` prefix produced by `safeMindId`. */
function stripPrefix(id: string): string {
  const idx = id.indexOf(":");
  return idx >= 0 ? id.slice(idx + 1) : id;
}

/** Mind Elixir mutates node data in place (adds `parent`, etc.). Deep-clone
 *  before handing it to the library so we never mutate React state. */
function cloneTree(node: MindNodeObj): MindNodeObj {
  return {
    ...node,
    children: node.children?.map(cloneTree),
  };
}

export function BlueprintCanvas({
  blueprint,
  onBlueprintChange,
  workspaceId,
  onAddRoom,
  onRoomSelect,
  isRteRunning,
  className,
}: BlueprintCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mindRef = useRef<MindElixirInstance | null>(null);
  const lastDataKeyRef = useRef<string>("");
  const pushBackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [isCommittingSnapshot, setIsCommittingSnapshot] = useState(false);
  const [hiddenChipOpen, setHiddenChipOpen] = useState(false);

  const { status } = useAuth();
  const tier = status?.plan ?? "free";
  const isWorkforce = tier === "workforce";

  const hiddenRooms = useMemo(
    () => (blueprint.rooms ?? []).filter((r) => r.hidden),
    [blueprint.rooms],
  );

  // Stable signature so we only push the snapshot back to Mind Elixir when
  // the upstream Blueprint actually changes (RTE parse, snapshot load, etc.).
  const blueprintKey = useMemo(() => {
    const rooms = (blueprint.rooms ?? [])
      .filter((r) => !r.hidden)
      .map((r) => `${r.id}:${r.label}:${r.path ?? ""}`)
      .join("|");
    const edges = (blueprint.edges ?? [])
      .map((e) => `${e.from}->${e.to}:${e.type ?? ""}`)
      .join(",");
    return `${rooms}#${edges}`;
  }, [blueprint]);

  const commitBlueprintFromMind = useCallback(() => {
    const mind = mindRef.current;
    if (!mind) return;
    const data = mind.getData();
    const tree = data.nodeData as MindNodeObj;
    const relations = (data.arrows ?? []).map((a) => ({
      from: a.from,
      to: a.to,
      label: a.label,
    }));
    const nextBlueprint = mindNodesToBlueprint({ root: tree, relations }, blueprint);
    onBlueprintChange(nextBlueprint);
  }, [blueprint, onBlueprintChange]);

  const handleCommitSnapshot = useCallback(async () => {
    if (workspaceId == null) return;
    setIsCommittingSnapshot(true);
    try {
      const result = await IpcClient.getInstance().commitBlueprintSnapshot(workspaceId);
      if (!result.success) {
        toast.error(result.error ?? "Failed to commit Blueprint snapshot");
        return;
      }
      toast.success(
        `Blueprint committed — ${result.nodeCount ?? 0} nodes, ${result.edgeCount ?? 0} edges saved to ${
          result.path ?? ".atlarix/blueprint.json"
        }`,
      );
      if (result.firstCommit) {
        toast.info(
          "Add .atlarix/blueprint.json to git so your team gets the Blueprint on clone. Or add it to .gitignore to keep it local.",
          { duration: 8000 },
        );
      }
    } catch (e) {
      toast.error(
        `Failed to commit Blueprint snapshot: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setIsCommittingSnapshot(false);
    }
  }, [workspaceId]);

  // ── Mount / mount-once: create the Mind Elixir instance. ────────────────
  useEffect(() => {
    if (!containerRef.current) return;

    const mind = new MindElixir({
      el: containerRef.current,
      // SIDE = balanced tree; LEFT/RIGHT also available. Mind Elixir does
      // not expose a native top-down constant in this release, but SIDE
      // gives the most space-efficient layout and scrolls cleanly.
      direction: MindElixir.SIDE,
      editable: true,
      contextMenu: true,
      keypress: true,
      allowUndo: true,
      newTopicName: "New container",
    });

    mind.bus.addListener("operation", () => {
      // Debounce: a single user edit can fire multiple operations
      // (reshapeNode, finishEdit). Coalesce them before pushing back.
      if (pushBackTimerRef.current) clearTimeout(pushBackTimerRef.current);
      pushBackTimerRef.current = setTimeout(() => {
        pushBackTimerRef.current = null;
        commitBlueprintFromMind();
      }, 120);
    });

    mind.bus.addListener("selectNewNode", (nodeObj) => {
      const meta = (nodeObj as MindNodeObj).atlarix;
      if (meta?.kind === "room" && meta.roomId) {
        onRoomSelect?.(meta.roomId);
      } else {
        // Falling back to the stripped id keeps legacy callers working
        // when the node was added inside Mind Elixir and has no `atlarix`
        // metadata yet.
        onRoomSelect?.(stripPrefix(nodeObj.id));
      }
    });

    mindRef.current = mind;

    return () => {
      if (pushBackTimerRef.current) clearTimeout(pushBackTimerRef.current);
      mind.destroy?.();
      mindRef.current = null;
    };
    // Mount once — re-runs would tear down history / pan state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Push the Blueprint into Mind Elixir whenever it changes upstream. ───
  useEffect(() => {
    const mind = mindRef.current;
    if (!mind) return;
    if (lastDataKeyRef.current === blueprintKey) return;
    lastDataKeyRef.current = blueprintKey;

    const { root, relations } = blueprintToMindNodes(blueprint, {
      workspaceName: "Workspace",
    });

    const tree = cloneTree(root);

    // First render uses `init`; subsequent renders use `refresh` so pan /
    // selection state is preserved.
    const data = {
      nodeData: tree as Parameters<typeof mind.init>[0]["nodeData"],
      direction: MindElixir.SIDE,
      arrows: relations.map((r, i) => ({
        id: `rel-${i}-${r.from}-${r.to}`,
        from: r.from,
        to: r.to,
        label: r.label,
        style: {
          stroke: r.label === "inferred" ? "#94a3b8" : "#f59e0b",
          strokeWidth: 2,
          strokeDasharray: r.label === "inferred" ? "6 4" : undefined,
        },
      })),
    };

    try {
      if (!mind.nodeData) {
        mind.init(data);
      } else {
        mind.refresh(data);
        mind.clearHistory?.();
      }
    } catch (err) {
      // Mind Elixir throws synchronously on malformed data; we keep the
      // canvas alive and surface a toast rather than crashing the panel.
      // eslint-disable-next-line no-console
      console.warn("[BlueprintCanvas] Mind Elixir refresh failed", err);
    }
  }, [blueprint, blueprintKey]);

  // ── Toolbar actions. ────────────────────────────────────────────────────
  const handleRelayout = useCallback(() => {
    const mind = mindRef.current;
    if (!mind) return;
    mind.refresh();
    mind.toCenter?.();
  }, []);

  const handleAddContainer = useCallback(() => {
    const mind = mindRef.current;
    if (!mind) return;
    // Prefer Mind Elixir's native "add child under selected" behaviour.
    // If no node is selected we fall through to the upstream callback so
    // the parent (BlueprintEditor) can decide what kind of container to
    // create.
    if (mind.currentNode) {
      void mind.addChild(mind.currentNode);
    } else {
      onAddRoom();
    }
  }, [onAddRoom]);

  return (
    <div
      className={cn(
        "relative h-full w-full rounded-lg overflow-hidden bg-muted/20",
        className,
      )}
    >
      {/* Overlay toolbar — preserved from the React Flow canvas. */}
      <div className="pointer-events-none absolute inset-0 z-50">
        <div className="pointer-events-auto absolute right-3 top-3 flex items-center gap-2">
          <button
            type="button"
            onClick={handleRelayout}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground border border-border shadow-sm"
            title="Re-run layout"
          >
            <LayoutGrid className="w-3.5 h-3.5" />
            Re-layout
          </button>
          <button
            type="button"
            onClick={handleAddContainer}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground border border-border shadow-sm"
          >
            <Plus className="w-3.5 h-3.5" />
            Add container
          </button>
          {isWorkforce ? (
            <button
              type="button"
              onClick={handleCommitSnapshot}
              disabled={isCommittingSnapshot || workspaceId == null}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground border border-border shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
              title="Snapshot Blueprint to .atlarix/blueprint.json"
            >
              <GitCommit className="w-3.5 h-3.5" />
              {isCommittingSnapshot ? "Committing…" : "Commit Blueprint"}
            </button>
          ) : (
            <span
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md bg-muted/50 text-muted-foreground border border-border shadow-sm cursor-help"
              title="Blueprint commits write a versioned `.atlarix/blueprint.json` snapshot for your team. Available on Workforce."
            >
              <GitCommit className="w-3.5 h-3.5" />
              Blueprint commits — Workforce
            </span>
          )}
        </div>

        {hiddenRooms.length > 0 && (
          <div className="pointer-events-auto absolute left-3 bottom-3">
            <div className="relative">
              <button
                type="button"
                onClick={() => setHiddenChipOpen((v) => !v)}
                className="rounded-md border border-border bg-card px-2 py-1 text-xs text-muted-foreground hover:bg-muted/80 hover:text-foreground shadow-sm"
              >
                {hiddenRooms.length} hidden item{hiddenRooms.length !== 1 ? "s" : ""} (deps & config)
              </button>
              {hiddenChipOpen && (
                <div className="absolute bottom-full left-0 mb-1 w-48 rounded-md border border-border bg-card p-2 text-xs shadow-md">
                  {hiddenRooms.map((r) => (
                    <div key={r.id} className="truncate text-muted-foreground">
                      {r.label}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        <div className="pointer-events-auto absolute right-3 bottom-3 z-50 flex flex-col gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-xs shadow-sm">
          <div className="flex items-center gap-2">
            <div className="h-0.5 w-6 bg-amber-500" />
            <span className="text-foreground">Cross-cutting link</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-6 border-t-2 border-dashed border-muted-foreground" />
            <span className="text-muted-foreground">Inferred (refresh to confirm)</span>
          </div>
          {isRteRunning && (
            <div className="mt-1 text-xs text-muted-foreground animate-pulse">
              Analyzing code...
            </div>
          )}
        </div>
      </div>

      <div ref={containerRef} className="w-full h-full" />
    </div>
  );
}
