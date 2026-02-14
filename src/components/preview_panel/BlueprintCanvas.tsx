/**
 * Visual Blueprint canvas (React Flow): rooms as nodes, edges as connections.
 * Similar to n8n/Mermaid but card-based; no persistence (blueprint = current state).
 */

import { useCallback, useEffect, useRef } from "react";
import {
  ReactFlow,
  useNodesState,
  useEdgesState,
  addEdge,
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
import type { Blueprint, BlueprintRoom, BlueprintEdge } from "@/shared/blueprint-types";
import { generateBlueprintId } from "@/shared/blueprint-types";
import { BlueprintRoomNode, type RoomNodeData } from "./BlueprintRoomNode";
import { Plus } from "lucide-react";
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
  agentPhaseActive?: boolean
): { nodes: Node<RoomNodeData>[]; edges: Edge[] } {
  const rooms = blueprint.rooms ?? [];
  const nodes: Node<RoomNodeData>[] = rooms.map((room, i) => {
    const col = i % GRID_COLS;
    const row = Math.floor(i / GRID_COLS);
    return {
      id: room.id,
      type: NODE_TYPE,
      position: { x: col * (NODE_WIDTH + GAP), y: row * (NODE_HEIGHT + GAP) },
      data: { room, agentPhase: agentPhase ?? undefined, agentPhaseActive: agentPhaseActive ?? false },
    };
  });
  const edgeClassName =
    agentPhase === "reviewer" && agentPhaseActive
      ? "atlarix-edge-reviewer-pulse"
      : undefined;
  const edges: Edge[] = (blueprint.edges ?? []).map((e, i) => ({
    id: `e-${e.from}-${e.to}-${i}`,
    source: e.from,
    target: e.to,
    label: e.label,
    type: "smoothstep",
    className: edgeClassName,
  }));
  return { nodes, edges };
}

function flowToBlueprint(nodes: Node<RoomNodeData>[], edges: Edge[]): Blueprint {
  const rooms: BlueprintRoom[] = nodes.map((n) => n.data.room);
  const blueprintEdges: BlueprintEdge[] = edges.map((e) => ({
    from: e.source,
    to: e.target,
    label: typeof e.label === "string" ? e.label : undefined,
  }));
  return { rooms, edges: blueprintEdges, envRefs: [] };
}

const nodeTypes: NodeTypes = { [NODE_TYPE]: BlueprintRoomNode as NodeTypes[string] };

interface BlueprintCanvasInnerProps {
  blueprint: Blueprint;
  onBlueprintChange: (b: Blueprint) => void;
  workspaceId: number | null;
  onAddRoom: () => void;
  onRoomSelect?: (roomId: string) => void;
  agentPhase?: AgentPhase | null;
  agentPhaseActive?: boolean;
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
  className,
}: BlueprintCanvasInnerProps) {
  const { nodes: initialNodes, edges: initialEdges } = blueprintToNodesAndEdges(
    blueprint,
    agentPhase,
    agentPhaseActive
  );
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const workspaceIdRef = useRef(workspaceId);

  // Reset canvas when workspace changes
  useEffect(() => {
    if (workspaceIdRef.current !== workspaceId) {
      workspaceIdRef.current = workspaceId;
      const { nodes: n, edges: e } = blueprintToNodesAndEdges(blueprint, agentPhase, agentPhaseActive);
      setNodes(n);
      setEdges(e);
    }
  }, [workspaceId, blueprint, agentPhase, agentPhaseActive, setNodes, setEdges]);

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

  // Sync flow state to parent when nodes or edges change
  const prevSync = useRef<string>("");
  useEffect(() => {
    const key = `${nodes.length}-${edges.length}-${nodes.map((n) => n.id).join(",")}`;
    if (prevSync.current === key) return;
    prevSync.current = key;
    onBlueprintChange(flowToBlueprint(nodes, edges));
  }, [nodes, edges, onBlueprintChange]);

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
    <div className={cn("h-full w-full rounded-lg overflow-hidden bg-muted/20", className)}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={(_e, node) => onRoomSelect?.(node.id)}
        nodeTypes={nodeTypes}
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
        <Panel position="top-right" className="flex gap-1">
          <button
            type="button"
            onClick={handleAddRoom}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground border border-border shadow-sm"
          >
            <Plus className="w-3.5 h-3.5" />
            Add container
          </button>
        </Panel>
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
  className?: string;
}

export function BlueprintCanvas(props: BlueprintCanvasProps) {
  return (
    <ReactFlowProvider>
      <BlueprintCanvasInner {...props} />
    </ReactFlowProvider>
  );
}
