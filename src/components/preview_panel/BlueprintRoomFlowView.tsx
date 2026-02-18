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
  type EdgeTypes,
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
import { BlueprintEdge } from "@/components/blueprint/BlueprintEdge";
import { IpcClient } from "@/ipc/ipc_client";
import { cn } from "@/lib/utils";

const NODE_TYPE = "function";
const NODE_WIDTH = 120;
const NODE_HEIGHT = 48;
const GAP = 28;

/** Vertical stack (one column) for rooms with no edges so it looks like a list/tree, not a flat grid. */
function gridPositionNoEdges(i: number): { x: number; y: number } {
  return { x: 0, y: i * (NODE_HEIGHT + GAP) };
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
      position: hasEdges ? { x: 0, y: 0 } : gridPositionNoEdges(i),
      data: { fn, connectedOut, connectedIn },
    };
  });
  const nodeIds = new Set(functions.map((f) => f.id));
  const reverseKeys = new Set(flowEdges.map((e) => `${e.to}\t${e.from}`));
  const seen = new Set<string>();
  const edges: Edge[] = flowEdges
    .filter((e) => {
      const valid = nodeIds.has(e.from) && nodeIds.has(e.to);
      if (!valid) return false;
      const key = `${e.from}\t${e.to}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((e) => {
      const hasReverse = reverseKeys.has(`${e.to}\t${e.from}`);
      const direction = e.direction ?? (hasReverse ? "both" : "to");
      const strokeByDirection =
        direction === "from"
          ? "hsl(220, 70%, 55%)"
          : direction === "both"
            ? "hsl(270, 60%, 55%)"
            : "hsl(0, 70%, 52%)";
      return {
        id: e.id ?? `fe-${e.from}-${e.to}`,
        source: e.from,
        target: e.to,
        label: e.label ?? e.type ?? undefined,
        type: "smoothstep",
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: strokeByDirection,
          width: 18,
          height: 18,
        },
        data: { edgeType: e.type, inferred: e.inferred ?? false, direction },
        style: {
          stroke: strokeByDirection,
          strokeWidth: 2,
          strokeDasharray: e.inferred ? "6 4" : undefined,
          opacity: 1,
        },
        zIndex: 1000,
      };
    });
  return { nodes, edges };
}

const nodeTypes: NodeTypes = { [NODE_TYPE]: BlueprintFunctionNode as NodeTypes[string] };
const edgeTypes: EdgeTypes = { smoothstep: BlueprintEdge };

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
    setNodes(n);
    const key = `${room.id}-${room.functions.length}-${(room.flowEdges ?? []).length}`;
    if (e.length > 0) {
      let cancelled = false;
      const beacons = room.functions.map((f) => ({ id: f.id }));
      const flowEdges = (room.flowEdges ?? []).map((fe) => ({
        id: fe.id ?? `fe-${fe.from}-${fe.to}`,
        from: fe.from,
        to: fe.to,
      }));
      IpcClient.getInstance()
        .layoutBeaconFlow(beacons, flowEdges)
        .then((positions) => {
          if (!cancelled) {
            layoutKeyRef.current = key;
            const posMap = new Map(positions.map((p) => [p.id, p]));
            setNodes((prev) =>
              prev.map((node) => ({
                ...node,
                position: posMap.get(node.id) ?? node.position,
              }))
            );
          }
        })
        .catch(() => {});
      return () => {
        cancelled = true;
      };
    }
    layoutKeyRef.current = key;
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
        const next = (room.flowEdges ?? []).filter(
          (e) => !ids.has(`fe-${e.from}-${e.to}`) && !ids.has(e.id ?? "")
        );
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
    <div className={cn("relative h-[320px] w-full rounded-lg overflow-visible bg-muted/10 border border-border", className)}>
      <div className="absolute left-2 top-1.5 z-10 max-w-[320px] space-y-0.5 text-[10px] text-muted-foreground">
        <div><strong>What connects the tree:</strong> These lines = flowEdges (beacon↔beacon, beacon↔node, node↔node).</div>
        <div>Container↔container, container↔packet, packet↔packet = main Blueprint diagram (rooms).</div>
        <div>Top row has no lines between nodes until you add them: drag from one node handle to another to connect.</div>
      </div>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChangeCustom}
        onConnect={onConnect}
        onNodeClick={handleNodeClick}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
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
