/**
 * BlueprintEditor – Phase 7 Additive Blueprint
 * ============================================
 * Visual canvas (rooms = nodes, edges = connections) + optional list for editing details.
 * Blueprints are not persisted; they reflect current project state and user edits.
 */

import { useState, useCallback, useRef, useEffect } from "react";
import { useAtomValue } from "jotai";
import { useSettings } from "@/hooks/useSettings";
import { currentAppAtom } from "@/atoms/appAtoms";
import { agentPhaseFromActivityAtom } from "@/atoms/sourceAtoms";
import { IpcClient } from "@/ipc/ipc_client";
import { toast } from "sonner";
import {
  type Blueprint,
  type BlueprintRoom,
  type BlueprintFunction,
  type BlueprintEdge,
  type BlueprintFunctionKind,
  createEmptyBlueprint,
  generateBlueprintId,
  blueprintToMermaid,
} from "@/shared/blueprint-types";
import { MermaidRenderer } from "@/components/MermaidRenderer";
import { BlueprintCanvas } from "@/components/preview_panel/BlueprintCanvas";
import { cn } from "@/lib/utils";
import {
  Plus,
  Trash2,
  ArrowRight,
  ArrowLeft,
  Code2,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Layers,
  Settings2,
  X,
  Sparkles,
  Shield,
  History,
  Undo2,
  GitCompare,
  Ban,
} from "lucide-react";
import { GenerateBlueprintsModal } from "@/components/preview_panel/GenerateBlueprintsModal";
import { BlueprintFunctionListItem } from "@/components/preview_panel/BlueprintFunctionListItem";
import { FUNCTION_KIND_CONFIG } from "@/lib/blueprint/function-kind-config";
import type { BlueprintRoomFlowEdge } from "@/shared/blueprint-types";
import { BlueprintTree } from "@/components/preview_panel/BlueprintTree";
import { PivotAnalysisPanel } from "@/components/preview_panel/PivotAnalysisPanel";
import { LiveVsBlueprintCompare } from "@/components/preview_panel/LiveVsBlueprintCompare";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const FUNCTION_KINDS: BlueprintFunctionKind[] = ["api", "webhook", "function", "feature"];

interface BlueprintEditorProps {
  blueprint: Blueprint;
  onSave: (blueprint: Blueprint) => void;
  isSaving?: boolean;
  /** Switch right panel to Vault/Creds tab (Phase B) */
  onOpenCreds?: () => void;
}

const MAX_UNDO = 5;

export function BlueprintEditor({ blueprint, onSave, onOpenCreds }: BlueprintEditorProps) {
  const app = useAtomValue(currentAppAtom);
  const agentPhaseState = useAtomValue(agentPhaseFromActivityAtom);
  const [local, setLocal] = useState<Blueprint>(blueprint);
  const [showMermaidPreview, setShowMermaidPreview] = useState(true);
  const [undoStack, setUndoStack] = useState<Blueprint[]>([]);
  const mermaidCode = blueprintToMermaid(local);
  const [atlarixIgnoreOpen, setAtlarixIgnoreOpen] = useState(false);
  const [atlarixPatterns, setAtlarixPatterns] = useState<string[]>([]);
  const [atlarixSaving, setAtlarixSaving] = useState(false);

  useEffect(() => {
    if (!atlarixIgnoreOpen || app?.id == null) return;
    let cancelled = false;
    void (async () => {
      const res = await IpcClient.getInstance().getAtlarixIgnore(app.id!);
      if (cancelled || !res.success || res.content == null) return;
      setAtlarixPatterns(res.content.split("\n"));
    })();
    return () => {
      cancelled = true;
    };
  }, [atlarixIgnoreOpen, app?.id]);

  const pushUndo = useCallback(() => {
    setUndoStack((prev) => [...prev.slice(1 - MAX_UNDO), local]);
  }, [local]);

  const addRoom = useCallback((parentId?: string) => {
    pushUndo();
    const id = generateBlueprintId();
    setLocal((prev) => {
      const count = prev.rooms.length + 1;
      return {
        ...prev,
        rooms: [
          ...prev.rooms,
          {
            id,
            label: parentId ? `Packet ${count}` : `Container ${count}`,
            functions: [],
            ...(parentId && { parentId }),
          },
        ],
      };
    });
  }, [pushUndo]);

  const updateRoom = useCallback((roomId: string, updates: Partial<BlueprintRoom>) => {
    pushUndo();
    setLocal((prev) => ({
      ...prev,
      rooms: prev.rooms.map((r) =>
        r.id === roomId ? { ...r, ...updates } : r
      ),
    }));
  }, [pushUndo]);

  const removeRoom = useCallback((roomId: string) => {
    pushUndo();
    setLocal((prev) => ({
      ...prev,
      rooms: prev.rooms.filter((r) => r.id !== roomId),
      edges: prev.edges.filter((e) => e.from !== roomId && e.to !== roomId),
    }));
  }, [pushUndo]);

  const addFunction = useCallback((roomId: string, kind: BlueprintFunctionKind) => {
    pushUndo();
    const id = generateBlueprintId();
    const fn: BlueprintFunction = { id, name: "", kind };
    setLocal((prev) => ({
      ...prev,
      rooms: prev.rooms.map((r) =>
        r.id === roomId
          ? { ...r, functions: [...r.functions, fn] }
          : r
      ),
    }));
  }, [pushUndo]);

  const updateFunction = useCallback(
    (roomId: string, fnId: string, updates: Partial<BlueprintFunction>) => {
      pushUndo();
      setLocal((prev) => ({
        ...prev,
        rooms: prev.rooms.map((r) =>
          r.id === roomId
            ? {
                ...r,
                functions: r.functions.map((f) =>
                  f.id === fnId ? { ...f, ...updates } : f
                ),
              }
            : r
        ),
      }));
    },
    [pushUndo]
  );

  const removeFunction = useCallback((roomId: string, fnId: string) => {
    pushUndo();
    setLocal((prev) => ({
      ...prev,
      rooms: prev.rooms.map((r) =>
        r.id === roomId
          ? {
              ...r,
              functions: r.functions.filter((f) => f.id !== fnId),
              flowEdges: (r.flowEdges ?? []).filter((e) => e.from !== fnId && e.to !== fnId),
            }
          : r
      ),
    }));
  }, [pushUndo]);

  const addEdge = useCallback(() => {
    if (local.rooms.length < 2) return;
    pushUndo();
    setLocal((prev) => ({
      ...prev,
      edges: [
        ...prev.edges,
        { from: prev.rooms[0].id, to: prev.rooms[1].id },
      ],
    }));
  }, [local.rooms.length, pushUndo]);

  const updateEdge = useCallback((index: number, from: string, to: string) => {
    pushUndo();
    setLocal((prev) => {
      const next = [...prev.edges];
      next[index] = { ...next[index], from, to };
      return { ...prev, edges: next };
    });
  }, [pushUndo]);

  const removeEdge = useCallback((index: number) => {
    pushUndo();
    setLocal((prev) => ({
      ...prev,
      edges: prev.edges.filter((_, i) => i !== index),
    }));
  }, [pushUndo]);

  const handleSave = useCallback(() => {
    onSave(local);
  }, [local, onSave]);

  const [isGenerating, setIsGenerating] = useState(false);
  const handleGenerateCode = useCallback(async () => {
    if (!app?.id) return;
    if (local.rooms.length === 0) {
      toast.error("Add at least one container to generate code");
      return;
    }
    setIsGenerating(true);
    try {
      const { success, result, error } = await IpcClient.getInstance().blueprintCodegen({
        workspaceId: app.id,
        delta: {
          rooms: local.rooms,
          edges: local.edges,
          envRefs: local.envRefs ?? [],
        },
      });
      if (success && result) {
        const msg = [
          result.filesCreated.length && `${result.filesCreated.length} file(s) created`,
          result.envKeysAdded.length && `${result.envKeysAdded.length} env key(s) added`,
        ].filter(Boolean).join(", ") || "Nothing new to add (files already exist)";
        toast.success(msg);
      } else {
        toast.error(error ?? result?.errors?.join("; ") ?? "Generate failed");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Generate failed");
    } finally {
      setIsGenerating(false);
    }
  }, [app?.id, local]);

  const [showList, setShowList] = useState(false);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  /** When set, bottom panel shows beacon view (Edit Internals) for this room; when null, show Summary Card or hint */
  const [beaconViewForRoomId, setBeaconViewForRoomId] = useState<string | null>(null);
  const [selectedFunctionId, setSelectedFunctionId] = useState<string | null>(null);
  const selectedRoomRef = useRef<HTMLDivElement | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isClustering, setIsClustering] = useState(false);
  const [isRteRunning, setIsRteRunning] = useState(false);
  const [generateBlueprintsOpen, setGenerateBlueprintsOpen] = useState(false);
  const [analysisPanelOpen, setAnalysisPanelOpen] = useState(false);
  const [comparePanelOpen, setComparePanelOpen] = useState(false);
  const [snapshots, setSnapshots] = useState<Array<{ id: number; snapshotAt: Date; source: string }>>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [isSimplifyingRoom, setIsSimplifyingRoom] = useState(false);
  const [isSimplifyingArchitecture, setIsSimplifyingArchitecture] = useState(false);
  const { settings, updateSettings } = useSettings();

  const handleUndo = useCallback(() => {
    setUndoStack((prev) => {
      const next = prev.slice(0, -1);
      const last = prev[prev.length - 1];
      if (last) setLocal(last);
      return next;
    });
  }, []);

  const loadSnapshots = useCallback(async () => {
    if (!app?.id) return;
    const res = await IpcClient.getInstance().getBlueprintSnapshots({ workspaceId: app.id, limit: 20 });
    if (res.success && res.snapshots) setSnapshots(res.snapshots);
  }, [app?.id]);

  useEffect(() => {
    if (historyOpen && app?.id) loadSnapshots();
  }, [historyOpen, app?.id, loadSnapshots]);

  const handleRestoreSnapshot = useCallback(
    async (snapshotId: number) => {
      if (!app?.id) return;
      const res = await IpcClient.getInstance().restoreBlueprintSnapshot({ workspaceId: app.id, snapshotId });
      if (res.success && res.blueprint) {
        setLocal(res.blueprint);
        onSave(res.blueprint);
        setHistoryOpen(false);
        toast.success("Blueprint restored from history");
      } else {
        toast.error(res.error ?? "Restore failed");
      }
    },
    [app?.id, onSave]
  );

  const handleSimplifyRoom = useCallback(
    async (roomId: string) => {
      if (!app?.id) return;
      setIsSimplifyingRoom(true);
      try {
        const res = await IpcClient.getInstance().simplifyBlueprintRoom({ workspaceId: app.id, roomId });
        if (res.success && res.label) {
          const next = {
            ...local,
            rooms: local.rooms.map((r) =>
              r.id === roomId ? { ...r, label: res.label!, intent: res.intent ?? r.intent } : r
            ),
          };
          setLocal(next);
          onSave(next);
          toast.success("Container description updated");
        } else {
          toast.error(res.error ?? "Could not simplify");
        }
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Simplify failed");
      } finally {
        setIsSimplifyingRoom(false);
      }
    },
    [app?.id, local, onSave]
  );

  const handleSimplifyArchitecture = useCallback(async () => {
    if (!app?.id) return;
    setIsSimplifyingArchitecture(true);
    try {
      const res = await IpcClient.getInstance().simplifyBlueprintArchitecture({ workspaceId: app.id });
      if (res.success && res.summary) {
        toast.success(res.summary, { duration: 6000 });
      } else {
        toast.error(res.error ?? "Could not summarize architecture");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Summarize failed");
    } finally {
      setIsSimplifyingArchitecture(false);
    }
  }, [app?.id]);

  // Sync local state when blueprint prop changes (e.g. from refresh-from-code or AI update)
  useEffect(() => {
    setLocal(blueprint);
  }, [blueprint]);

  // Listen for RTE-running state (for legend and edge pulse)
  useEffect(() => {
    if (!app?.id) return;
    const unsubscribe = IpcClient.getInstance().onBlueprintRteRunning((payload: { workspaceId: number; running: boolean }) => {
      if (payload.workspaceId === app.id) setIsRteRunning(payload.running);
    });
    return unsubscribe;
  }, [app?.id]);

  const handleRoomSelect = useCallback((roomId: string) => {
    setSelectedRoomId(roomId);
    setShowList(true);
    if (settings?.blueprintAlwaysShowBeacons) {
      setBeaconViewForRoomId(roomId);
    } else {
      setBeaconViewForRoomId(null);
    }
  }, [settings?.blueprintAlwaysShowBeacons]);

  useEffect(() => {
    if (selectedRoomId && showList && selectedRoomRef.current) {
      selectedRoomRef.current.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [selectedRoomId, showList]);

  const handleFlowEdgesChange = useCallback(
    (roomId: string, edges: BlueprintRoomFlowEdge[]) => {
      updateRoom(roomId, { flowEdges: edges });
    },
    [updateRoom]
  );

  const handleRefreshFromCode = useCallback(async () => {
    if (!app?.id) return;
    setIsRefreshing(true);
    try {
      const res = await IpcClient.getInstance().refreshBlueprintFromCode({ workspaceId: app.id });
      if (res.success) {
        const count = (res as { newConnectionsCount?: number }).newConnectionsCount;
        if (count !== undefined && count > 0) {
          toast.success(`Connections updated from code — ${count} new connection${count !== 1 ? "s" : ""} found`);
        } else {
          toast.success("Blueprint synced from code");
        }
      } else {
        toast.error(res.error ?? "Refresh failed");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Refresh failed");
    } finally {
      setIsRefreshing(false);
    }
  }, [app?.id]);

  const handleRegenerateClustering = useCallback(async () => {
    if (!app?.id) return;
    setIsClustering(true);
    try {
      const res = await IpcClient.getInstance().clusterBlueprint({ workspaceId: app.id });
      if (res.success && res.blueprint) {
        setLocal(res.blueprint);
        onSave(res.blueprint);
        toast.success("Blueprint regenerated with AI clustering (5–8 containers)");
      } else {
        toast.error(res.error ?? "Clustering failed");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Clustering failed");
    } finally {
      setIsClustering(false);
    }
  }, [app?.id, onSave]);

  const selectedRoom = selectedRoomId ? local.rooms.find((r) => r.id === selectedRoomId) : null;

  return (
    <div className="flex flex-col h-full overflow-hidden flex-1 min-h-0">
      <div className="flex flex-1 min-h-0 min-w-0">
        {/* Sidebar: add/delete containers and beacons */}
        <div className="w-[160px] flex-shrink-0 border-r border-border flex flex-col bg-muted/10 overflow-hidden">
          <div className="px-2 py-1.5 border-b border-border">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Containers</span>
          </div>
          <div className="flex-1 overflow-auto min-h-0">
            <button
              type="button"
              onClick={() => addRoom()}
              className="w-full flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground rounded-md mt-1"
            >
              <Plus className="w-3.5 h-3.5" />
              Add container
            </button>
            {local.rooms.filter((r) => !r.hidden).map((room) => (
              <div
                key={room.id}
                className={cn(
                  "flex items-center gap-1 group rounded-md mt-0.5",
                  selectedRoomId === room.id && "bg-primary/10"
                )}
              >
                <button
                  type="button"
                  onClick={() => handleRoomSelect(room.id)}
                  className="flex-1 min-w-0 text-left px-2 py-1 text-xs truncate rounded-md hover:bg-muted/80"
                  title={room.label}
                >
                  {room.label || "Container"}
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeRoom(room.id);
                    if (selectedRoomId === room.id) {
                      setSelectedRoomId(null);
                      setBeaconViewForRoomId(null);
                    }
                  }}
                  className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 opacity-0 group-hover:opacity-100"
                  title="Delete container"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
          {selectedRoom && (
            <>
              <div className="px-2 py-1.5 border-t border-border">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Beacons</span>
              </div>
              <div className="px-2 pb-2 space-y-0.5">
                {FUNCTION_KINDS.map((kind) => {
                  const { label, Icon } = FUNCTION_KIND_CONFIG[kind];
                  return (
                    <button
                      key={kind}
                      type="button"
                      onClick={() => addFunction(selectedRoom.id, kind)}
                      className="w-full flex items-center gap-1.5 px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground rounded-md"
                    >
                      <Icon className="w-3 h-3" />
                      + {label}
                    </button>
                  );
                })}
                {selectedRoom.functions.map((fn) => (
                  <div key={fn.id} className="flex items-center gap-1 group rounded-md">
                    <span className="flex-1 min-w-0 truncate text-xs px-2 py-0.5" title={fn.name}>
                      {fn.name || "(unnamed)"}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeFunction(selectedRoom.id, fn.id)}
                      className="p-0.5 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 opacity-0 group-hover:opacity-100"
                      title="Delete beacon"
                    >
                      <Trash2 className="w-2.5 h-2.5" />
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Visual canvas + container details */}
        <div className="flex flex-col flex-1 min-h-0 min-w-0">
      {/* Visual canvas: rooms as nodes, drag to connect */}
      <div className="flex-1 min-h-[280px] p-3 flex flex-col">
        <div className="flex items-center justify-between gap-1.5 mb-2 flex-wrap">
          <span className="text-[10px] text-muted-foreground shrink-0" title="Click a container to see its summary and steps inside">
            Drag containers; connect from handles. Click a container for details.
          </span>
          <div className="flex items-center gap-1 flex-shrink-0">
            {selectedRoomId && (
              <button
                type="button"
                onClick={() => {
                  removeRoom(selectedRoomId);
                  setSelectedRoomId(null);
                  setBeaconViewForRoomId(null);
                }}
                className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded border border-destructive/40 text-destructive hover:bg-destructive/15"
                title="Delete selected container"
              >
                <Trash2 className="w-3 h-3" />
                Delete
              </button>
            )}
            <button
              type="button"
              onClick={() => setGenerateBlueprintsOpen(true)}
              className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded border border-border bg-muted/80 hover:bg-muted text-muted-foreground hover:text-foreground"
              title="Analyze workspace and generate blueprints"
            >
              <Layers className="w-3 h-3" />
              Blueprints
            </button>
            <button
              type="button"
              onClick={handleRefreshFromCode}
              disabled={isRefreshing}
              className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded border border-border bg-muted/80 hover:bg-muted text-muted-foreground hover:text-foreground disabled:opacity-50"
              title="Re-infer blueprint from current codebase"
            >
              <RefreshCw className={cn("w-3 h-3", isRefreshing && "animate-spin")} />
              Refresh
            </button>
            <button
              type="button"
              onClick={handleRegenerateClustering}
              disabled={isClustering}
              className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded border border-border bg-muted/80 hover:bg-muted text-muted-foreground hover:text-foreground disabled:opacity-50"
              title="Regenerate blueprint with AI clustering (5–8 containers)"
            >
              <Sparkles className={cn("w-3 h-3", isClustering && "animate-pulse")} />
              Cluster
            </button>
            <button
              type="button"
              onClick={handleSimplifyArchitecture}
              disabled={isSimplifyingArchitecture || local.rooms.length === 0}
              className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded border border-border bg-muted/80 hover:bg-muted text-muted-foreground hover:text-foreground disabled:opacity-50"
              title="Summarize high-level architecture with AI"
            >
              <Sparkles className={cn("w-3 h-3", isSimplifyingArchitecture && "animate-pulse")} />
              Summarize
            </button>
            <button
              type="button"
              onClick={() => setAnalysisPanelOpen(true)}
              className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded border border-border bg-muted/80 hover:bg-muted text-muted-foreground hover:text-foreground"
              title="Run PIVOT analysis (SonarQube, Semgrep)"
            >
              <Shield className="w-3 h-3" />
              Analysis
            </button>
            <button
              type="button"
              onClick={() => setComparePanelOpen(true)}
              className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded border border-border bg-muted/80 hover:bg-muted text-muted-foreground hover:text-foreground"
              title="Compare Live (code) vs Blueprint"
            >
              <GitCompare className="w-3 h-3" />
              Compare
            </button>
            <button
              type="button"
              onClick={handleUndo}
              disabled={undoStack.length === 0}
              className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded border border-border bg-muted/80 hover:bg-muted text-muted-foreground hover:text-foreground disabled:opacity-50"
              title="Undo last edit"
            >
              <Undo2 className="w-3 h-3" />
              Undo
            </button>
            <DropdownMenu open={historyOpen} onOpenChange={setHistoryOpen}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded border border-border bg-muted/80 hover:bg-muted text-muted-foreground hover:text-foreground"
                  title="Blueprint history"
                >
                  <History className="w-3 h-3" />
                  History
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-60 overflow-auto">
                {snapshots.length === 0 && (
                  <DropdownMenuItem disabled>No history yet</DropdownMenuItem>
                )}
                {snapshots.map((s) => (
                  <DropdownMenuItem
                    key={s.id}
                    onClick={() => handleRestoreSnapshot(s.id)}
                  >
                    {new Date(s.snapshotAt).toLocaleString()} ({s.source})
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <button
              type="button"
              onClick={handleSave}
              className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded border border-border bg-muted/80 hover:bg-muted text-muted-foreground hover:text-foreground"
              title="Save blueprint"
            >
              Update
            </button>
            <button
              type="button"
              onClick={handleGenerateCode}
              disabled={isGenerating || local.rooms.length === 0}
              className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded border border-amber-500/30 bg-amber-600/80 hover:bg-amber-600/90 text-amber-100 disabled:opacity-50"
              title="Generate stub files and env keys from this Blueprint"
            >
              <Code2 className="w-3 h-3" />
              {isGenerating ? "…" : "Generate"}
            </button>
          </div>
        </div>
        <BlueprintCanvas
            blueprint={local}
            onBlueprintChange={(b) => setLocal(b)}
            workspaceId={app?.id ?? null}
            onAddRoom={addRoom}
            onRoomSelect={handleRoomSelect}
            agentPhase={agentPhaseState.phase}
            agentPhaseActive={agentPhaseState.active}
            isRteRunning={isRteRunning}
            className="flex-1 min-h-0"
          />
        <GenerateBlueprintsModal
          open={generateBlueprintsOpen}
          onOpenChange={setGenerateBlueprintsOpen}
          workspaceId={app?.id ?? null}
          onGenerated={() => {}}
        />
        <PivotAnalysisPanel open={analysisPanelOpen} onOpenChange={setAnalysisPanelOpen} />
        <LiveVsBlueprintCompare
          open={comparePanelOpen}
          onOpenChange={setComparePanelOpen}
          currentBlueprint={local}
        />
      </div>

      {/* .atlarixignore — gitignore-style excludes for Blueprint / RTE */}
      <div className="border-t border-border flex-shrink-0">
        <button
          type="button"
          onClick={() => setAtlarixIgnoreOpen((v) => !v)}
          className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs font-medium text-muted-foreground hover:bg-muted/50"
        >
          {atlarixIgnoreOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          <Ban className="w-3.5 h-3.5 shrink-0 opacity-70" />
          Blueprint ignore (.atlarixignore)
        </button>
        {atlarixIgnoreOpen && app?.id != null && (
          <div className="px-3 pb-3 space-y-2 max-h-[220px] overflow-auto border-b border-border/60">
            <p className="text-[10px] text-muted-foreground leading-snug">
              Patterns use the same syntax as .gitignore. They apply when refreshing the Blueprint from code and when
              analyzing the workspace. Edit lines below; empty lines are kept.
            </p>
            <div className="space-y-1">
              {atlarixPatterns.map((line, idx) => (
                <div key={`ig-${idx}`} className="flex gap-1 items-center">
                  <input
                    type="text"
                    value={line}
                    onChange={(e) => {
                      const v = e.target.value;
                      setAtlarixPatterns((prev) => prev.map((p, i) => (i === idx ? v : p)));
                    }}
                    className="flex-1 min-w-0 px-2 py-1 text-[11px] font-mono rounded border border-border bg-background"
                    placeholder="e.g. node_modules/ or *.generated.ts"
                  />
                  <button
                    type="button"
                    onClick={() => setAtlarixPatterns((prev) => prev.filter((_, i) => i !== idx))}
                    className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-muted shrink-0"
                    title="Remove line"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap gap-2 pt-1">
              <button
                type="button"
                onClick={() => setAtlarixPatterns((p) => [...p, ""])}
                className="px-2 py-1 text-[10px] rounded border border-border bg-muted/50 hover:bg-muted"
              >
                Add pattern
              </button>
              <button
                type="button"
                disabled={atlarixSaving}
                onClick={async () => {
                  if (app?.id == null) return;
                  setAtlarixSaving(true);
                  try {
                    const content = atlarixPatterns.join("\n");
                    const res = await IpcClient.getInstance().setAtlarixIgnore(app.id, content);
                    if (res.success) toast.success("Saved .atlarixignore");
                    else toast.error(res.error ?? "Save failed");
                  } finally {
                    setAtlarixSaving(false);
                  }
                }}
                className="px-2 py-1 text-[10px] rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {atlarixSaving ? "Saving…" : "Save to disk"}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Container details: Summary Card or Edit Internals (beacon view) with Back */}
      <div className="border-t border-border flex-shrink-0">
        <button
          type="button"
          onClick={() => setShowList((v) => !v)}
          className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs font-medium text-muted-foreground hover:bg-muted/50"
        >
          {showList ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          Container details
        </button>
        {showList && (
          <div className="p-3 pt-0 space-y-4 max-h-[200px] overflow-auto">
            <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={!!settings?.blueprintAlwaysShowBeacons}
                onChange={(e) => updateSettings({ blueprintAlwaysShowBeacons: e.target.checked })}
                className="rounded border-border"
              />
              Always open Edit Internals when selecting a container
            </label>
            {!selectedRoomId ? (
              <BlueprintTree
                rooms={local.rooms}
                selectedRoomId={selectedRoomId}
                onSelectRoom={handleRoomSelect}
              />
            ) : beaconViewForRoomId === selectedRoomId ? (
              <>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setBeaconViewForRoomId(null)}
                    className="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground"
                    title="Back to summary"
                  >
                    <ArrowLeft className="w-3.5 h-3.5" />
                    Back
                  </button>
                </div>
                {(() => {
                  const room = local.rooms.find((r) => r.id === selectedRoomId);
                  if (!room) return null;
                  return (
                    <div
                      ref={selectedRoomRef}
                      className="rounded-lg border border-primary/30 ring-1 ring-primary/20 bg-primary/5 p-3 space-y-2"
                    >
                      <div className="flex items-center gap-2 flex-wrap">
                        <input
                          type="text"
                          value={room.label}
                          onChange={(e) => updateRoom(room.id, { label: e.target.value })}
                          placeholder="Container name"
                          className="flex-1 min-w-[120px] px-2 py-1 text-sm rounded border border-border bg-background"
                        />
                        <input
                          type="text"
                          value={room.intent ?? ""}
                          onChange={(e) => updateRoom(room.id, { intent: e.target.value || undefined })}
                          placeholder="Intent (optional)"
                          className="flex-1 min-w-[100px] px-2 py-1 text-xs rounded border border-border bg-background text-muted-foreground"
                        />
                        <button
                          type="button"
                          onClick={() => handleSimplifyRoom(room.id)}
                          disabled={isSimplifyingRoom}
                          className={cn(
                            "inline-flex items-center gap-1 px-2 py-1 text-xs rounded bg-primary/10 text-primary hover:bg-primary/20 border border-primary/20",
                            isSimplifyingRoom && "opacity-60"
                          )}
                          title="Simplify container/packet description with AI"
                        >
                          <Sparkles className="w-3 h-3" />
                          {isSimplifyingRoom ? "Simplifying…" : "Simplify with AI"}
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            removeRoom(room.id);
                            setSelectedRoomId(null);
                            setBeaconViewForRoomId(null);
                          }}
                          className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                          title="Remove container"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {FUNCTION_KINDS.map((kind) => {
                          const { label, Icon } = FUNCTION_KIND_CONFIG[kind];
                          return (
                            <button
                              key={kind}
                              type="button"
                              onClick={() => addFunction(room.id, kind)}
                              className="flex items-center gap-1 px-2 py-0.5 text-xs rounded bg-muted hover:bg-muted/80"
                            >
                              <Icon className="w-3 h-3" />
                              {label}
                            </button>
                          );
                        })}
                        <button
                          type="button"
                          onClick={() => addRoom(room.id)}
                          className="flex items-center gap-1 px-2 py-0.5 text-xs rounded bg-muted hover:bg-muted/80 text-muted-foreground"
                          title="Add packet"
                        >
                          <Layers className="w-3 h-3" />
                          Add packet
                        </button>
                      </div>
                      {room.functions.length > 0 && (
                        <div className="space-y-2">
                          <ul className="space-y-2 list-none pl-0">
                            {(room.functions ?? [])
                              .filter((f) => !f.parentId)
                              .map((fn) => (
                                <li key={fn.id}>
                                  <BlueprintFunctionListItem
                                    fn={fn}
                                    roomId={room.id}
                                    workspaceId={app?.id ?? null}
                                    onUpdate={(fnId, updates) => updateFunction(room.id, fnId, updates)}
                                    onRemove={(fnId) => removeFunction(room.id, fnId)}
                                    onOpenCreds={onOpenCreds}
                                    defaultExpanded={selectedFunctionId === fn.id}
                                    subBeacons={(room.functions ?? []).filter((f) => f.parentId === fn.id)}
                                    flowEdges={room.flowEdges ?? []}
                                    onFlowEdgesChange={(edges) => handleFlowEdgesChange(room.id, edges)}
                                    otherFunctions={room.functions ?? []}
                                  />
                                </li>
                              ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  );
                })()}
              </>
            ) : (
              (() => {
                const room = local.rooms.find((r) => r.id === selectedRoomId);
                if (!room) return null;
                return (
                  <div
                    ref={selectedRoomRef}
                    className="rounded-lg border border-primary/30 ring-1 ring-primary/20 bg-primary/5 p-3 space-y-3"
                  >
                    <div className="text-sm font-medium text-foreground">{room.label || "Unnamed container"}</div>
                    <p className="text-xs text-muted-foreground whitespace-pre-wrap">
                      {room.intent || "No description. Add intent above or click Edit Internals to add beacons."}
                    </p>
                    <div className="flex items-center gap-2 flex-wrap">
                      <input
                        type="text"
                        value={room.label}
                        onChange={(e) => updateRoom(room.id, { label: e.target.value })}
                        placeholder="Container name"
                        className="flex-1 min-w-[120px] px-2 py-1 text-sm rounded border border-border bg-background"
                      />
                      <input
                        type="text"
                        value={room.intent ?? ""}
                        onChange={(e) => updateRoom(room.id, { intent: e.target.value || undefined })}
                        placeholder="Describe for AI (e.g. Handles Stripe, Auth, Users)"
                        className="flex-1 min-w-[140px] px-2 py-1 text-xs rounded border border-border bg-background text-muted-foreground"
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => setBeaconViewForRoomId(selectedRoomId)}
                      className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90"
                    >
                      <Settings2 className="w-3.5 h-3.5" />
                      Edit Internals
                    </button>
                  </div>
                );
              })()
            )}
            {local.rooms.length >= 2 && (
              <div className="rounded-lg border border-border bg-card p-3 space-y-2">
                <h3 className="text-xs font-medium text-muted-foreground">Connections</h3>
                {local.edges.map((edge, i) => (
                  <div key={i} className="flex items-center gap-2 flex-wrap">
                    <select
                      value={edge.from}
                      onChange={(e) => updateEdge(i, e.target.value, edge.to)}
                      className="px-2 py-1 text-xs rounded border border-border bg-background"
                    >
                      {local.rooms.map((r) => (
                        <option key={r.id} value={r.id}>{r.label}</option>
                      ))}
                    </select>
                    <ArrowRight className="w-4 h-4 text-muted-foreground" />
                    <select
                      value={edge.to}
                      onChange={(e) => updateEdge(i, edge.from, e.target.value)}
                      className="px-2 py-1 text-xs rounded border border-border bg-background"
                    >
                      {local.rooms.map((r) => (
                        <option key={r.id} value={r.id}>{r.label}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => removeEdge(i)}
                      className="p-0.5 text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={addEdge}
                  className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-muted hover:bg-muted/80"
                >
                  <Plus className="w-3 h-3" />
                  Add connection
                </button>
              </div>
            )}
          </div>
        )}
      </div>
        </div>
      </div>
    </div>
  );
}
