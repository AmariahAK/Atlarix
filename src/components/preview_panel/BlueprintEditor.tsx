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
  List,
  GitBranch,
  RefreshCw,
  Layers,
  Settings2,
  Maximize2,
  X,
} from "lucide-react";
import { GenerateBlueprintsModal } from "@/components/preview_panel/GenerateBlueprintsModal";
import { BlueprintFunctionListItem } from "@/components/preview_panel/BlueprintFunctionListItem";
import { BlueprintRoomFlowView } from "@/components/preview_panel/BlueprintRoomFlowView";
import { FUNCTION_KIND_CONFIG } from "@/lib/blueprint/function-kind-config";
import type { BlueprintRoomFlowEdge } from "@/shared/blueprint-types";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { BlueprintTree } from "@/components/preview_panel/BlueprintTree";

const FUNCTION_KINDS: BlueprintFunctionKind[] = ["api", "webhook", "function", "feature"];

interface BlueprintEditorProps {
  blueprint: Blueprint;
  onSave: (blueprint: Blueprint) => void;
  isSaving?: boolean;
  /** Switch right panel to Vault/Creds tab (Phase B) */
  onOpenCreds?: () => void;
}

export function BlueprintEditor({ blueprint, onSave, onOpenCreds }: BlueprintEditorProps) {
  const app = useAtomValue(currentAppAtom);
  const agentPhaseState = useAtomValue(agentPhaseFromActivityAtom);
  const [local, setLocal] = useState<Blueprint>(blueprint);
  const [showMermaidPreview, setShowMermaidPreview] = useState(true);
  const mermaidCode = blueprintToMermaid(local);

  const addRoom = useCallback((parentId?: string) => {
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
  }, []);

  const updateRoom = useCallback((roomId: string, updates: Partial<BlueprintRoom>) => {
    setLocal((prev) => ({
      ...prev,
      rooms: prev.rooms.map((r) =>
        r.id === roomId ? { ...r, ...updates } : r
      ),
    }));
  }, []);

  const removeRoom = useCallback((roomId: string) => {
    setLocal((prev) => ({
      ...prev,
      rooms: prev.rooms.filter((r) => r.id !== roomId),
      edges: prev.edges.filter((e) => e.from !== roomId && e.to !== roomId),
    }));
  }, []);

  const addFunction = useCallback((roomId: string, kind: BlueprintFunctionKind) => {
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
  }, []);

  const updateFunction = useCallback(
    (roomId: string, fnId: string, updates: Partial<BlueprintFunction>) => {
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
    []
  );

  const removeFunction = useCallback((roomId: string, fnId: string) => {
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
  }, []);

  const addEdge = useCallback(() => {
    if (local.rooms.length < 2) return;
    setLocal((prev) => ({
      ...prev,
      edges: [
        ...prev.edges,
        { from: prev.rooms[0].id, to: prev.rooms[1].id },
      ],
    }));
  }, [local.rooms.length]);

  const updateEdge = useCallback((index: number, from: string, to: string) => {
    setLocal((prev) => {
      const next = [...prev.edges];
      next[index] = { ...next[index], from, to };
      return { ...prev, edges: next };
    });
  }, []);

  const removeEdge = useCallback((index: number) => {
    setLocal((prev) => ({
      ...prev,
      edges: prev.edges.filter((_, i) => i !== index),
    }));
  }, []);

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
  const [roomDetailViewMode, setRoomDetailViewMode] = useState<Record<string, "list" | "flow">>({});
  const [flowExpandRoomId, setFlowExpandRoomId] = useState<string | null>(null);
  const selectedRoomRef = useRef<HTMLDivElement | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isRteRunning, setIsRteRunning] = useState(false);
  const [generateBlueprintsOpen, setGenerateBlueprintsOpen] = useState(false);
  const { settings, updateSettings } = useSettings();

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
        <Dialog open={flowExpandRoomId != null} onOpenChange={(open) => !open && setFlowExpandRoomId(null)}>
          <DialogContent className="max-w-[95vw] min-w-[85vw] w-full max-h-[85vh] flex flex-col gap-2" showCloseButton>
            <DialogHeader>
              <DialogTitle>
                {flowExpandRoomId ? local.rooms.find((r) => r.id === flowExpandRoomId)?.label ?? "Flow" : "Flow"}
              </DialogTitle>
            </DialogHeader>
            {flowExpandRoomId && (() => {
              const room = local.rooms.find((r) => r.id === flowExpandRoomId);
              if (!room) return null;
              const selectedInThisRoom = selectedFunctionId && (room.functions ?? []).some((f) => f.id === selectedFunctionId);
              return (
                <div className="flex gap-3 flex-1 min-h-[70vh] min-w-0">
                  <div className="flex-1 min-w-0 rounded-lg overflow-hidden border border-border bg-muted/10">
                    <BlueprintRoomFlowView
                      room={room}
                      onFlowEdgesChange={handleFlowEdgesChange}
                      onSelectFunction={setSelectedFunctionId}
                      className="h-[70vh] w-full"
                    />
                  </div>
                  {selectedInThisRoom && selectedFunctionId && (() => {
                    const fn = (room.functions ?? []).find((f) => f.id === selectedFunctionId);
                    if (!fn) return null;
                    return (
                      <div className="w-72 shrink-0 flex flex-col rounded-lg border border-border bg-card overflow-hidden">
                        <div className="flex items-center justify-between px-2 py-1.5 border-b border-border bg-muted/30">
                          <span className="text-xs font-medium text-foreground">Edit beacon</span>
                          <button
                            type="button"
                            onClick={() => setSelectedFunctionId(null)}
                            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted"
                            title="Close"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                        <div className="flex-1 overflow-auto p-2 min-h-0">
                          <BlueprintFunctionListItem
                            fn={fn}
                            roomId={room.id}
                            workspaceId={app?.id ?? null}
                            onUpdate={(fnId, updates) => updateFunction(room.id, fnId, updates)}
                            onRemove={(fnId) => {
                              removeFunction(room.id, fnId);
                              setSelectedFunctionId(null);
                            }}
                            onOpenCreds={onOpenCreds}
                            defaultExpanded={true}
                            subBeacons={(room.functions ?? []).filter((f) => f.parentId === fn.id)}
                            flowEdges={room.flowEdges ?? []}
                            onFlowEdgesChange={(edges) => handleFlowEdgesChange(room.id, edges)}
                            otherFunctions={room.functions ?? []}
                          />
                        </div>
                      </div>
                    );
                  })()}
                </div>
              );
            })()}
          </DialogContent>
        </Dialog>
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
                          <div className="flex items-center gap-1 text-xs text-muted-foreground flex-wrap">
                            <button
                              type="button"
                              onClick={() => setRoomDetailViewMode((m) => ({ ...m, [room.id]: "list" }))}
                              className={cn(
                                "flex items-center gap-1 rounded px-1.5 py-0.5",
                                roomDetailViewMode[room.id] !== "flow" ? "bg-muted text-foreground" : "opacity-70 hover:opacity-100"
                              )}
                              title="List view"
                            >
                              <List className="w-3.5 h-3.5" />
                              List
                            </button>
                            <span className="text-border">|</span>
                            <button
                              type="button"
                              onClick={() => setRoomDetailViewMode((m) => ({ ...m, [room.id]: "flow" }))}
                              className={cn(
                                "flex items-center gap-1 rounded px-1.5 py-0.5",
                                roomDetailViewMode[room.id] === "flow" ? "bg-muted text-foreground" : "opacity-70 hover:opacity-100"
                              )}
                              title="Flow view: connect functions"
                            >
                              <GitBranch className="w-3.5 h-3.5" />
                              Flow
                            </button>
                            {roomDetailViewMode[room.id] === "flow" && (
                              <button
                                type="button"
                                onClick={() => setFlowExpandRoomId(room.id)}
                                className="flex items-center gap-1 rounded px-1.5 py-0.5 opacity-70 hover:opacity-100"
                                title="Expand flow in full view"
                              >
                                <Maximize2 className="w-3.5 h-3.5" />
                                Expand
                              </button>
                            )}
                          </div>
                          {roomDetailViewMode[room.id] === "flow" ? (
                            <div className="flex gap-3 min-h-0">
                              <div className="flex-1 min-w-0 rounded-lg overflow-hidden border border-border bg-muted/10">
                                <BlueprintRoomFlowView
                                  room={room}
                                  onFlowEdgesChange={handleFlowEdgesChange}
                                  onSelectFunction={setSelectedFunctionId}
                                />
                              </div>
                              {selectedFunctionId && (() => {
                                const fn = (room.functions ?? []).find((f) => f.id === selectedFunctionId);
                                if (!fn) return null;
                                return (
                                  <div className="w-72 shrink-0 flex flex-col rounded-lg border border-border bg-card overflow-hidden">
                                    <div className="flex items-center justify-between px-2 py-1.5 border-b border-border bg-muted/30">
                                      <span className="text-xs font-medium text-foreground">Edit beacon</span>
                                      <button
                                        type="button"
                                        onClick={() => setSelectedFunctionId(null)}
                                        className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted"
                                        title="Close"
                                      >
                                        <X className="w-4 h-4" />
                                      </button>
                                    </div>
                                    <div className="flex-1 overflow-auto p-2">
                                      <BlueprintFunctionListItem
                                        fn={fn}
                                        roomId={room.id}
                                        workspaceId={app?.id ?? null}
                                        onUpdate={(fnId, updates) => updateFunction(room.id, fnId, updates)}
                                        onRemove={(fnId) => {
                                          removeFunction(room.id, fnId);
                                          setSelectedFunctionId(null);
                                        }}
                                        onOpenCreds={onOpenCreds}
                                        defaultExpanded={true}
                                        subBeacons={(room.functions ?? []).filter((f) => f.parentId === fn.id)}
                                        flowEdges={room.flowEdges ?? []}
                                        onFlowEdgesChange={(edges) => handleFlowEdgesChange(room.id, edges)}
                                        otherFunctions={room.functions ?? []}
                                      />
                                    </div>
                                  </div>
                                );
                              })()}
                            </div>
                          ) : (
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
                          )}
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
