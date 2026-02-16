/**
 * Mini flow canvas inside a room: functions as nodes, flowEdges as connections (Phase C/D).
 * Uses ELK for connection-based layout when edges exist; grid fallback when none.
 */

import { useCallback, useEffect, useRef } from "react";
import {
  ReactFlow,
  useNodesState,
  useEdgesState,
  MarkerType,
  type NodeTypes,
  type Connection,
  type Node,
  type Edge,
  type EdgeChange,
  Controls,
  Background,
  BackgroundVariant,
  ReactFlowProvider,
} from "@xyflow/react";
// @ts-expect-error - CSS import has no type declarations
import "@xyflow/react/dist/style.css";
import type { BlueprintRoom, BlueprintRoomFlowEdge } from "@/shared/blueprint-types";
import { BlueprintFunctionNode, type FunctionNodeData } from "./BlueprintFunctionNode";
import { applyElkToReactFlowNodes } from "@/lib/blueprint/layouts/elkLayout";
import { cn } from "@/lib/utils";

const NODE_TYPE = "function";
const NODE_WIDTH = 120;
const NODE_HEIGHT = 48;
const GAP = 28;

function gridPosition(i: number): { x: number; y: number } {
  const col = i % 3;
  const row = Math.floor(i / 3);
  return { x: col * (NODE_WIDTH + GAP), y: row * (NODE_HEIGHT + GAP) };
}

function roomToNodesAndEdges(room: BlueprintRoom): { nodes: Node<FunctionNodeData>[]; edges: Edge[] } {
  const functions = room.functions ?? [];
  const flowEdges = room.flowEdges ?? [];
  const hasEdges = flowEdges.length > 0;
  const idToName = new Map(functions.map((f) => [f.id, f.name || f.id]));
  const nodes: Node<FunctionNodeData>[] = functions.map((fn, i) => {
    const connectedOut = flowEdges.filter((e) => e.from === fn.id).map((e) => idToName.get(e.to) ?? e.to);
    const connectedIn = flowEdges.filter((e) => e.to === fn.id).map((e) => idToName.get(e.from) ?? e.from);
    return {
      id: fn.id,
      type: NODE_TYPE,
      position: hasEdges ? { x: 0, y: 0 } : gridPosition(i),
      data: { fn, connectedOut, connectedIn },
    };
  });
  const seen = new Set<string>();
  const edges: Edge[] = flowEdges
    .filter((e) => {
      const key = `${e.from}\t${e.to}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((e) => ({
      id: `fe-${e.from}-${e.to}`,
      source: e.from,
      target: e.to,
      label: e.label ?? e.type ?? undefined,
      type: "smoothstep",
      markerEnd: { type: MarkerType.ArrowClosed },
      data: { edgeType: e.type },
      style: { stroke: "hsl(var(--primary))", strokeWidth: 2 },
    }));
  return { nodes, edges };
}

const nodeTypes: NodeTypes = { [NODE_TYPE]: BlueprintFunctionNode as NodeTypes[string] };

interface BlueprintRoomFlowViewProps {
  room: BlueprintRoom;
  onFlowEdgesChange: (roomId: string, edges: BlueprintRoomFlowEdge[]) => void;
  onSelectFunction?: (fnId: string) => void;
  onSwitchToList?: () => void;
  className?: string;
}

function BlueprintRoomFlowViewInner({
  room,
  onFlowEdgesChange,
  onSelectFunction,
  onSwitchToList,
  className,
}: BlueprintRoomFlowViewProps) {
  const { nodes: initialNodes, edges: initialEdges } = roomToNodesAndEdges(room);
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const layoutKeyRef = useRef<string>("");

  useEffect(() => {
    const { nodes: n, edges: e } = roomToNodesAndEdges(room);
    setEdges(e);
    const key = `${room.id}-${room.functions.length}-${(room.flowEdges ?? []).length}`;
    if (e.length > 0) {
      let cancelled = false;
      applyElkToReactFlowNodes(n, e, { nodeWidth: NODE_WIDTH, nodeHeight: NODE_HEIGHT })
        .then((positioned) => {
          if (!cancelled) {
            layoutKeyRef.current = key;
            setNodes(positioned);
          }
        })
        .catch(() => {
          if (!cancelled) setNodes(n);
        });
      return () => {
        cancelled = true;
      };
    }
    layoutKeyRef.current = key;
    setNodes(n);
  }, [room.id, room.functions, room.flowEdges, setNodes, setEdges]);

  const onConnect = useCallback(
    (conn: Connection) => {
      if (!conn.source || !conn.target) return;
      const flowEdges: BlueprintRoomFlowEdge[] = [...(room.flowEdges ?? []), { from: conn.source, to: conn.target }];
      onFlowEdgesChange(room.id, flowEdges);
    },
    [room.id, room.flowEdges, onFlowEdgesChange]
  );

  const onEdgesChangeCustom = useCallback(
    (changes: EdgeChange[]) => {
      const removed = changes.filter((c) => c.type === "remove").map((c) => (c as { id: string }).id);
      if (removed.length > 0) {
        const ids = new Set(removed);
        const next = (room.flowEdges ?? []).filter((e) => !ids.has(`fe-${e.from}-${e.to}`));
        onFlowEdgesChange(room.id, next);
      }
      onEdgesChange(changes);
    },
    [room.flowEdges, room.id, onFlowEdgesChange, onEdgesChange]
  );

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node<FunctionNodeData>) => {
      onSelectFunction?.(node.id);
      onSwitchToList?.();
    },
    [onSelectFunction, onSwitchToList]
  );

  if (room.functions.length === 0) {
    return (
      <div className={cn("flex items-center justify-center rounded-lg border border-dashed border-border bg-muted/20 py-6 text-xs text-muted-foreground", className)}>
        No functions. Add API, Webhook, Function, or Feature in List view.
      </div>
    );
  }

  return (
    <div className={cn("h-[320px] w-full rounded-lg overflow-hidden bg-muted/10 border border-border", className)}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChangeCustom}
        onConnect={onConnect}
        onNodeClick={handleNodeClick}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        defaultEdgeOptions={{ type: "smoothstep" }}
        deleteKeyCode={["Backspace", "Delete"]}
        proOptions={{ hideAttribution: true }}
        nodesConnectable
        elementsSelectable
        nodesDraggable
      >
        <Background variant={BackgroundVariant.Dots} gap={10} size={0.8} className="bg-background" />
        <Controls className="atlaflow-controls-theme !shadow-md !border !border-border !rounded-md !bg-card" showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

export function BlueprintRoomFlowView(props: BlueprintRoomFlowViewProps) {
  return (
    <ReactFlowProvider>
      <BlueprintRoomFlowViewInner {...props} />
    </ReactFlowProvider>
  );
}
