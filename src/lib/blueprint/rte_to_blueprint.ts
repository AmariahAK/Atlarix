/**
 * Convert RTE parse result (nodes + edges) to Blueprint (rooms + edges).
 * Groups nodes by first path segment (e.g. src/auth -> room "auth"); maps node types to BlueprintFunctionKind.
 */

import type { Blueprint, BlueprintRoom, BlueprintFunction, BlueprintEdge, BlueprintFunctionKind } from "@/shared/blueprint-types";
import { generateBlueprintId } from "@/shared/blueprint-types";
import type { BlueprintNode, RTEBlueprintEdge, RTEParseResult } from "./rte/parsers/types";

const RTE_KIND_TO_BLUEPRINT: Record<string, BlueprintFunctionKind> = {
  api: "api",
  webhook: "webhook",
  function: "function",
  feature: "feature",
  class: "function",
  cron: "function",
  ai: "function",
  db: "function",
  "3p": "function",
  stream: "function",
  conditional: "function",
};

function roomKeyFromFile(file: string): string {
  const first = file.split("/")[0];
  if (first === "src" || first === "lib" || first === "app" || first === "apps") {
    const parts = file.split("/");
    return parts.length > 1 ? parts[1] : first;
  }
  return first || "root";
}

/**
 * Convert RTE result to Blueprint. Groups nodes by directory (room), maps to rooms and edges.
 */
export function rteResultToBlueprint(result: RTEParseResult): Blueprint {
  const { nodes, edges } = result;
  if (nodes.length === 0) {
    return { rooms: [], edges: [], envRefs: [] };
  }

  const roomKeys = new Set<string>();
  for (const n of nodes) {
    roomKeys.add(roomKeyFromFile(n.file));
  }
  const keyToRoomId = new Map<string, string>();
  const roomIdToKey = new Map<string, string>();
  let idx = 0;
  for (const k of roomKeys) {
    const id = `room_${k.replace(/[^a-zA-Z0-9_-]/g, "_")}_${idx++}`;
    keyToRoomId.set(k, id);
    roomIdToKey.set(id, k);
  }

  const nodeToRoomId = new Map<string, string>();
  for (const n of nodes) {
    const key = roomKeyFromFile(n.file);
    nodeToRoomId.set(n.id, keyToRoomId.get(key)!);
  }

  const rooms: BlueprintRoom[] = [];
  for (const [key, roomId] of keyToRoomId) {
    const roomNodes = nodes.filter((n) => roomKeyFromFile(n.file) === key);
    const functions: BlueprintFunction[] = roomNodes.map((n) => ({
      id: n.id,
      name: n.name,
      kind: RTE_KIND_TO_BLUEPRINT[n.type] ?? "function",
      description: n.description ?? n.path ?? n.file,
    }));
    rooms.push({
      id: roomId,
      label: key.charAt(0).toUpperCase() + key.slice(1),
      path: key,
      functions,
      flowEdges: edges
        .filter((e) => nodeToRoomId.get(e.from) === roomId && nodeToRoomId.get(e.to) === roomId)
        .map((e) => ({ from: e.from, to: e.to, label: e.label })),
    });
  }

  const roomEdges: BlueprintEdge[] = [];
  const seen = new Set<string>();
  for (const e of edges) {
    const fromRoom = nodeToRoomId.get(e.from);
    const toRoom = nodeToRoomId.get(e.to);
    if (fromRoom && toRoom && fromRoom !== toRoom) {
      const key = `${fromRoom}->${toRoom}`;
      if (!seen.has(key)) {
        seen.add(key);
        roomEdges.push({ from: fromRoom, to: toRoom, label: e.label });
      }
    }
  }

  return { rooms, edges: roomEdges, envRefs: [] };
}
