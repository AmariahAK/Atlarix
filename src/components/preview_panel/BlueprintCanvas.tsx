/**
 * Visual Blueprint canvas (React Flow): rooms as nodes, edges as connections.
 * Similar to n8n/Mermaid but card-based; no persistence (blueprint = current state).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ReactFlow,
  useNodesState,
  useEdgesState,
  addEdge,
  MarkerType,
  type Connection,
  type Node,
  type Edge,
  type NodeTypes,
  Controls,
  Background,
  BackgroundVariant,
  ReactFlowProvider,
  Panel,
} from "@xyflow/react";
// @ts-expect-error - CSS import has no type declarations
import "@xyflow/react/dist/style.css";
import type { Blueprint, BlueprintRoom, BlueprintEdge as BlueprintEdgeType } from "@/shared/blueprint-types";
import { generateBlueprintId } from "@/shared/blueprint-types";
import { BlueprintRoomNode, type RoomNodeData } from "./BlueprintRoomNode";
import { BlueprintEdge } from "@/components/blueprint/BlueprintEdge";
import { IpcClient } from "@/ipc/ipc_client";
import { Plus, LayoutGrid } from "lucide-react";
import type { EdgeTypes } from "@xyflow/react";
import { cn } from "@/lib/utils";
import type { AgentPhase } from "@/atoms/sourceAtoms";

const NODE_TYPE = "room";
const GRID_COLS = 4;
const NODE_WIDTH = 160;
const NODE_HEIGHT = 80;
const GAP = 24;

function blueprintToNodesAndEdges(
  blueprint: Blueprint,
  agentPhase?: AgentPhase | null,
  agentPhaseActive?: boolean,
  isRteRunning?: boolean
): { nodes: Node<RoomNodeData>[]; edges: Edge[]; hiddenRooms: BlueprintRoom[] } {
  const allRooms = blueprint.rooms ?? [];
  const visibleRooms = allRooms.filter((r) => !r.hidden);
  const hiddenRooms = allRooms.filter((r) => r.hidden);
  const useGrid = (blueprint.edges ?? []).length === 0;
  const nodes: Node<RoomNodeData>[] = visibleRooms.map((room, i) => {
    const col = i % GRID_COLS;
    const row = Math.floor(i / GRID_COLS);
    return {
      id: room.id,
      type: NODE_TYPE,
      position: useGrid
        ? { x: col * (NODE_WIDTH + GAP), y: row * (NODE_HEIGHT + GAP) }
        : { x: 0, y: 0 },
      data: { room, agentPhase: agentPhase ?? undefined, agentPhaseActive: agentPhaseActive ?? false },
    };
  });
  const nodeIds = new Set(nodes.map((n) => n.id));
  const blueprintEdges = blueprint.edges ?? [];
  const validEdges = blueprintEdges.filter((e) => {
    const valid = nodeIds.has(e.from) && nodeIds.has(e.to);
    if (!valid) {
      console.warn("[BlueprintCanvas] Dropping edge with unmatched node ids:", e);
    }
    return valid;
  });
  const edgeClassName =
    agentPhase === "reviewer" && agentPhaseActive
      ? "atlarix-edge-reviewer-pulse"
      : undefined;
  const DIRECTION_COLORS: Record<"to" | "from" | "both", string> = {
    to: "hsl(0, 70%, 52%)",
    from: "hsl(220, 70%, 55%)",
    both: "hsl(270, 60%, 55%)",
  };
  const edges: Edge[] = validEdges.map((e, i) => {
    const direction = e.direction ?? "to";
    const strokeColor = e.inferred ? "hsl(var(--muted-foreground))" : DIRECTION_COLORS[direction];
    return {
      id: e.id ?? `edge-${e.from}-${e.to}-${i}`,
      source: e.from,
      target: e.to,
      label: e.label ?? e.type ?? undefined,
      type: "smoothstep",
      className: edgeClassName,
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: strokeColor,
        width: 18,
        height: 18,
      },
      data: {
        edgeType: e.type,
        inferred: e.inferred ?? false,
        isRteRunning: isRteRunning ?? false,
        direction,
      },
      style: {
        stroke: strokeColor,
        strokeWidth: 2,
        strokeDasharray: e.inferred ? "6 4" : undefined,
        opacity: 1,
      },
      zIndex: 1000,
    };
  });
  return { nodes, edges, hiddenRooms };
}

function flowToBlueprint(nodes: Node<RoomNodeData>[], edges: Edge[]): Blueprint {
  const rooms: BlueprintRoom[] = nodes.map((n) => n.data.room);
  const blueprintEdges: BlueprintEdgeType[] = edges.map((e) => ({
    from: e.source,
    to: e.target,
    label: typeof e.label === "string" ? e.label : undefined,
    type: (e.data as { edgeType?: "import" | "call" | "api" })?.edgeType,
    direction: (e.data as { direction?: "to" | "from" | "both" })?.direction,
  }));
  return { rooms, edges: blueprintEdges, envRefs: [] };
}

const nodeTypes: NodeTypes = { [NODE_TYPE]: BlueprintRoomNode as NodeTypes[string] };
const edgeTypes: EdgeTypes = { smoothstep: BlueprintEdge };

interface BlueprintCanvasInnerProps {
  blueprint: Blueprint;
  onBlueprintChange: (b: Blueprint) => void;
  workspaceId: number | null;
  onAddRoom: () => void;
  onRoomSelect?: (roomId: string) => void;
  agentPhase?: AgentPhase | null;
  agentPhaseActive?: boolean;
  isRteRunning?: boolean;
  className?: string;
}

function BlueprintCanvasInner({
  blueprint,
  onBlueprintChange,
  workspaceId,
  onAddRoom,
  onRoomSelect,
  agentPhase,
  agentPhaseActive,
  isRteRunning,
  className,
}: BlueprintCanvasInnerProps) {
  const [hiddenChipOpen, setHiddenChipOpen] = useState(false);
  const [relayoutCounter, setRelayoutCounter] = useState(0);
  const { nodes: initialNodes, edges: initialEdges, hiddenRooms } = blueprintToNodesAndEdges(
    blueprint,
    agentPhase,
    agentPhaseActive,
    isRteRunning
  );
  const hiddenCount = hiddenRooms.length;
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const workspaceIdRef = useRef(workspaceId);
  const layoutKeyRef = useRef<string>("");
  /** Set only after ELK IPC applies positions — avoids Strict Mode / failed IPC skipping layout forever. */
  const elkCompletedForKeyRef = useRef<string>("");
  const blueprintLayoutKey = `${blueprint.rooms?.length ?? 0}-${(blueprint.rooms ?? []).filter((r) => !r.hidden).map((r) => r.id).join(",")}-${(blueprint.edges ?? []).length}`;

  // Reset canvas when workspace or blueprint structure changes (not when only isRteRunning changes).
  // Merge current flow edges so user-drawn edges are not lost when reset runs before parent re-renders.
  useEffect(() => {
    if (workspaceIdRef.current !== workspaceId) workspaceIdRef.current = workspaceId;
    const key = `${workspaceId}-${blueprintLayoutKey}`;
    const prevKey = layoutKeyRef.current;
    if (prevKey !== key) {
      const { nodes: nextNodes, edges: nextEdgesFromBlueprint } = blueprintToNodesAndEdges(
        blueprint,
        agentPhase,
        agentPhaseActive,
        isRteRunning
      );
      setNodes(nextNodes);
      setEdges((currentEdges) => {
        const fromBlueprintKeys = new Set(
          nextEdgesFromBlueprint.map((e) => `${e.source}-${e.target}`)
        );
        const merged = [...nextEdgesFromBlueprint];
        for (const e of currentEdges) {
          const edgeKey = `${e.source}-${e.target}`;
          if (!fromBlueprintKeys.has(edgeKey)) {
            fromBlueprintKeys.add(edgeKey);
            merged.push(e);
          }
        }
        return merged;
      });
      layoutKeyRef.current = key;
      elkCompletedForKeyRef.current = "";
    }
  }, [workspaceId, blueprintLayoutKey, blueprint, agentPhase, agentPhaseActive, isRteRunning, setNodes, setEdges]);

  // When RTE running state changes, only update edge data (preserve positions)
  useEffect(() => {
    setEdges((prev) =>
      prev.map((e) => ({
        ...e,
        data: { ...e.data, isRteRunning: isRteRunning ?? false },
      }))
    );
  }, [isRteRunning, setEdges]);

  // When nodes have 0,0 positions (ELK needed), run layout via IPC
  useEffect(() => {
    if (initialNodes.length === 0) return;
    const needsLayout = initialNodes.every((n) => n.position.x === 0 && n.position.y === 0);
    if (!needsLayout) return;
    const layoutFullKey = `${workspaceId ?? "null"}-${blueprintLayoutKey}`;
    if (elkCompletedForKeyRef.current === layoutFullKey) return;
    const visibleRooms = (blueprint.rooms ?? []).filter((r) => !r.hidden);
    const roomPayload = visibleRooms.map((r) => ({ id: r.id }));
    const edgePayload = (blueprint.edges ?? []).map((e) => ({
      id: e.id ?? `edge-${e.from}-${e.to}`,
      from: e.from,
      to: e.to,
    }));
    let cancelled = false;
    IpcClient.getInstance()
      .layoutContainerCanvas(roomPayload, edgePayload)
      .then((positions) => {
        if (cancelled) return;
        const posMap = new Map(positions.map((p) => [p.id, p]));
        setNodes((prev) =>
          prev.map((n) => ({
            ...n,
            position: posMap.get(n.id) ?? n.position,
          }))
        );
        elkCompletedForKeyRef.current = layoutFullKey;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [
    workspaceId,
    blueprintLayoutKey,
    initialNodes,
    blueprint.rooms,
    blueprint.edges,
    setNodes,
    relayoutCounter,
  ]);

  // When blueprint.rooms or agent phase change, update node data (keep positions)
  useEffect(() => {
    const rooms = blueprint.rooms ?? [];
    setNodes((prev) =>
      prev.map((node) => {
        const room = rooms.find((r) => r.id === node.id);
        const nextData: RoomNodeData = {
          room: room ?? node.data.room,
          agentPhase: agentPhase ?? undefined,
          agentPhaseActive: agentPhaseActive ?? false,
        };
        return node.data.room !== nextData.room || node.data.agentPhase !== nextData.agentPhase || node.data.agentPhaseActive !== nextData.agentPhaseActive
          ? { ...node, data: nextData }
          : node;
      })
    );
  }, [blueprint.rooms, agentPhase, agentPhaseActive, setNodes]);

  // When reviewer phase is active, add pulse class to edges
  useEffect(() => {
    const edgeClassName =
      agentPhase === "reviewer" && agentPhaseActive ? "atlarix-edge-reviewer-pulse" : undefined;
    setEdges((prev) =>
      prev.map((e) => (e.className !== edgeClassName ? { ...e, className: edgeClassName } : e))
    );
  }, [agentPhase, agentPhaseActive, setEdges]);

  const onConnect = useCallback(
    (conn: Connection) => {
      setEdges((prev) => addEdge(conn, prev));
    },
    [setEdges]
  );

  // Sync flow state to parent when nodes or edges change (preserve hidden rooms)
  const prevSync = useRef<string>("");
  useEffect(() => {
    const key = `${nodes.length}-${edges.length}-${nodes.map((n) => n.id).join(",")}`;
    if (prevSync.current === key) return;
    prevSync.current = key;
    const fromFlow = flowToBlueprint(nodes, edges);
    const hiddenFromBlueprint = (blueprint.rooms ?? []).filter((r) => r.hidden);
    onBlueprintChange({
      ...fromFlow,
      rooms: [...fromFlow.rooms, ...hiddenFromBlueprint],
    });
  }, [nodes, edges, blueprint.rooms, onBlueprintChange]);

  const handleAddRoom = useCallback(() => {
    const id = generateBlueprintId();
    const room: BlueprintRoom = { id, label: "New container", functions: [] };
    const col = nodes.length % GRID_COLS;
    const row = Math.floor(nodes.length / GRID_COLS);
    setNodes((prev) => [
      ...prev,
      {
        id,
        type: NODE_TYPE,
        position: { x: col * (NODE_WIDTH + GAP), y: row * (NODE_HEIGHT + GAP) },
        data: { room },
      },
    ]);
  }, [nodes.length, setNodes]);

  return (
    <div className={cn("relative h-full w-full rounded-lg overflow-hidden bg-muted/20", className)}>
      {/* Fix: Blueprint panel hitboxes — avoid ReactFlow Panel overlays (transform hit-testing issues on some platforms) */}
      <div className="pointer-events-none absolute inset-0 z-50">
        <div className="pointer-events-auto absolute right-3 top-3 flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setNodes((prev) => prev.map((n) => ({ ...n, position: { x: 0, y: 0 } })));
              layoutKeyRef.current = "";
              elkCompletedForKeyRef.current = "";
              setRelayoutCounter((c) => c + 1);
            }}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground border border-border shadow-sm"
            title="Re-run ELK layout"
          >
            <LayoutGrid className="w-3.5 h-3.5" />
            Re-layout
          </button>
          <button
            type="button"
            onClick={handleAddRoom}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground border border-border shadow-sm"
          >
            <Plus className="w-3.5 h-3.5" />
            Add container
          </button>
        </div>

        {hiddenCount > 0 && (
          <div className="pointer-events-auto absolute left-3 bottom-3">
            <div className="relative">
              <button
                type="button"
                onClick={() => setHiddenChipOpen((v) => !v)}
                className="rounded-md border border-border bg-card px-2 py-1 text-xs text-muted-foreground hover:bg-muted/80 hover:text-foreground shadow-sm"
              >
                {hiddenCount} hidden item{hiddenCount !== 1 ? "s" : ""} (deps & config)
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
            <div className="h-0.5 w-6 bg-primary" />
            <span className="text-foreground">Confirmed connection</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-6 border-t-2 border-dashed border-muted-foreground" />
            <span className="text-muted-foreground">Inferred (refresh to confirm)</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-primary atlarix-edge-particle" />
            <span className="text-muted-foreground">Live flow</span>
          </div>
          {isRteRunning && (
            <div className="mt-1 text-xs text-muted-foreground animate-pulse">Analyzing code...</div>
          )}
        </div>
      </div>

      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={(_e, node) => onRoomSelect?.(node.id)}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        defaultEdgeOptions={{ type: "smoothstep" }}
        deleteKeyCode={["Backspace", "Delete"]}
        proOptions={{ hideAttribution: true }}
        nodesDraggable
        nodesConnectable
        elementsSelectable
      >
        <Background variant={BackgroundVariant.Dots} gap={12} size={1} className="bg-background" />
        <Controls className="atlaflow-controls-theme !shadow-md !border !border-border !rounded-md !bg-card" showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

export interface BlueprintCanvasProps {
  blueprint: Blueprint;
  onBlueprintChange: (b: Blueprint) => void;
  workspaceId: number | null;
  onAddRoom: () => void;
  onRoomSelect?: (roomId: string) => void;
  /** v2.5: Agent phase for canvas animations (architect/builder/reviewer) */
  agentPhase?: AgentPhase | null;
  agentPhaseActive?: boolean;
  /** When true, RTE is running (show "Analyzing code..." and pulse inferred edges) */
  isRteRunning?: boolean;
  className?: string;
}

export function BlueprintCanvas(props: BlueprintCanvasProps) {
  return (
    <ReactFlowProvider>
      <BlueprintCanvasInner {...props} />
    </ReactFlowProvider>
  );
}
