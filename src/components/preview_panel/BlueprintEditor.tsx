/**
 * BlueprintEditor – Phase 7 Additive Blueprint
 * ============================================
 * Visual canvas (rooms = nodes, edges = connections) + optional list for editing details.
 * Blueprints are not persisted; they reflect current project state and user edits.
 */

import { useState, useCallback, useRef, useEffect } from "react";
import { useAtomValue } from "jotai";
import { currentAppAtom } from "@/atoms/appAtoms";
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
  Code2,
  ChevronDown,
  ChevronRight,
  List,
  GitBranch,
} from "lucide-react";
import { BlueprintFunctionListItem } from "@/components/preview_panel/BlueprintFunctionListItem";
import { BlueprintRoomFlowView } from "@/components/preview_panel/BlueprintRoomFlowView";
import { FUNCTION_KIND_CONFIG } from "@/lib/blueprint/function-kind-config";
import type { BlueprintRoomFlowEdge } from "@/shared/blueprint-types";

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
  const [local, setLocal] = useState<Blueprint>(blueprint);
  const [showMermaidPreview, setShowMermaidPreview] = useState(true);
  const mermaidCode = blueprintToMermaid(local);

  const addRoom = useCallback(() => {
    const id = generateBlueprintId();
    setLocal((prev) => ({
      ...prev,
      rooms: [
        ...prev.rooms,
        { id, label: `Room ${prev.rooms.length + 1}`, functions: [] },
      ],
    }));
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
    toast.success("Blueprint updated (current state; not persisted)");
  }, [local, onSave]);

  const [isGenerating, setIsGenerating] = useState(false);
  const handleGenerateCode = useCallback(async () => {
    if (!app?.id) return;
    if (local.rooms.length === 0) {
      toast.error("Add at least one room to generate code");
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
  const [selectedFunctionId, setSelectedFunctionId] = useState<string | null>(null);
  const [roomDetailViewMode, setRoomDetailViewMode] = useState<Record<string, "list" | "flow">>({});
  const selectedRoomRef = useRef<HTMLDivElement | null>(null);

  const handleRoomSelect = useCallback((roomId: string) => {
    setSelectedRoomId(roomId);
    setShowList(true);
  }, []);

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

  return (
    <div className="flex flex-col h-full overflow-hidden flex-1 min-h-0">
      {/* Visual canvas: rooms as nodes, drag to connect */}
      <div className="flex-1 min-h-[280px] p-3 flex flex-col">
        <div className="flex items-center justify-between gap-2 mb-2">
          <span className="text-xs text-muted-foreground">Drag rooms; connect with edges from handles.</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleSave}
              className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded-md bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground border border-border"
            >
              Update
            </button>
            <button
              type="button"
              onClick={handleGenerateCode}
              disabled={isGenerating || local.rooms.length === 0}
              className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded-md bg-amber-600/80 text-amber-100 hover:bg-amber-600/90 border border-amber-500/30 disabled:opacity-50"
              title="Generate stub files and env keys from this Blueprint"
            >
              <Code2 className="w-3.5 h-3.5" />
              {isGenerating ? "Generating..." : "Generate code"}
            </button>
          </div>
        </div>
        <BlueprintCanvas
            blueprint={local}
            onBlueprintChange={(b) => setLocal(b)}
            workspaceId={app?.id ?? null}
            onAddRoom={addRoom}
            onRoomSelect={handleRoomSelect}
            className="flex-1 min-h-0"
          />
      </div>

      {/* Collapsible list for editing room labels and functions */}
      <div className="border-t border-border">
        <button
          type="button"
          onClick={() => setShowList((v) => !v)}
          className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs font-medium text-muted-foreground hover:bg-muted/50"
        >
          {showList ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          Edit room details (labels, functions)
        </button>
        {showList && (
          <div className="p-3 pt-0 space-y-4 max-h-[240px] overflow-auto">
            {local.rooms.map((room) => (
        <div
          key={room.id}
          ref={selectedRoomId === room.id ? selectedRoomRef : undefined}
          className={cn(
            "rounded-lg border p-3 space-y-2 transition-colors",
            selectedRoomId === room.id ? "border-primary ring-1 ring-primary/30 bg-primary/5" : "border-border bg-card"
          )}
        >
          <div className="flex items-center gap-2 flex-wrap">
            <input
              type="text"
              value={room.label}
              onChange={(e) => updateRoom(room.id, { label: e.target.value })}
              placeholder="Room name"
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
              onClick={() => removeRoom(room.id)}
              className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10"
              title="Remove room"
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
          </div>
          {room.functions.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
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
              </div>
              {roomDetailViewMode[room.id] === "flow" ? (
                <BlueprintRoomFlowView
                  room={room}
                  onFlowEdgesChange={handleFlowEdgesChange}
                  onSelectFunction={setSelectedFunctionId}
                  onSwitchToList={() => {
                    setRoomDetailViewMode((m) => ({ ...m, [room.id]: "list" }));
                  }}
                />
              ) : (
                <ul className="space-y-2 list-none pl-0">
                  {room.functions.map((fn) => (
                    <li key={fn.id}>
                      <BlueprintFunctionListItem
                        fn={fn}
                        roomId={room.id}
                        onUpdate={(fnId, updates) => updateFunction(room.id, fnId, updates)}
                        onRemove={(fnId) => removeFunction(room.id, fnId)}
                        onOpenCreds={onOpenCreds}
                        defaultExpanded={selectedFunctionId === fn.id}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      ))}
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
  );
}
