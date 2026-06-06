/**
 * Convert RTE parse result (nodes + edges) to Blueprint (rooms + edges).
 * Groups nodes by directory (room) using getRoomKey when projectRoot is provided.
 */

import * as path from "path";
import type { Blueprint, BlueprintRoom, BlueprintFunction, BlueprintEdge, BlueprintFunctionKind } from "@/shared/blueprint-types";
import type { RTEBlueprintEdge, RTEParseResult } from "./rte/parsers/types";

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

const GENERIC_ROOTS = new Set([
  "src", "lib", "app", "pages", "components", "utils", "api", "core", "common", "shared", "modules", "apps",
]);

function getRoomKey(filePath: string, projectRoot: string): string {
  const normalizedRoot = projectRoot.replace(/\\/g, "/").replace(/\/$/, "");
  const rel = filePath.replace(/\\/g, "/").replace(normalizedRoot, "").replace(/^\//, "");
  const parts = rel.split("/").filter(Boolean);
  return roomKeyFromParts(parts);
}

function roomKeyFromFile(file: string): string {
  return roomKeyFromParts(file.split("/").filter(Boolean));
}

/**
 * v12 Tier 6 #2: when the first segment is a generic root (`src`/`api`/…),
 * descend past it. Take TWO levels only when the second is itself a directory
 * (i.e. there's a deeper file: `parts.length > 3`) so `src/api/v1/handlers/x`
 * → `api/v1` ≠ `src/api/v2/...` → `api/v2`. A shallow `src/auth/login.ts`
 * stays `auth` (one level) — we don't want per-file rooms. Non-generic roots
 * are unchanged (`parts[0]`).
 */
function roomKeyFromParts(parts: string[]): string {
  if (parts.length === 0) return "root";
  if (GENERIC_ROOTS.has(parts[0]) && parts.length > 1) {
    if (parts.length > 3) return `${parts[1]}/${parts[2]}`;
    return parts[1];
  }
  return parts[0];
}

/**
 * Convert RTE result to Blueprint. Groups nodes by directory (room), maps to rooms and edges.
 * When projectRoot is provided, uses getRoomKey for consistent room keys with file-tree source.
 */
export function rteResultToBlueprint(result: RTEParseResult, projectRoot?: string): Blueprint {
  const { nodes, edges } = result;
  if (nodes.length === 0) {
    return { rooms: [], edges: [], envRefs: [] };
  }

  const getKey = (n: { file: string }) =>
    projectRoot
      ? getRoomKey(path.join(projectRoot, n.file), projectRoot)
      : roomKeyFromFile(n.file);

  const roomKeys = new Set<string>();
  for (const n of nodes) {
    roomKeys.add(getKey(n));
  }
  const keyToRoomId = new Map<string, string>();
  let idx = 0;
  for (const k of roomKeys) {
    const id = `room_${k.replace(/[^a-zA-Z0-9_-]/g, "_")}_${idx++}`;
    keyToRoomId.set(k, id);
  }

  const nodeToRoomId = new Map<string, string>();
  for (const n of nodes) {
    const key = getKey(n);
    nodeToRoomId.set(n.id, keyToRoomId.get(key)!);
  }

  const rooms: BlueprintRoom[] = [];
  for (const [key, roomId] of keyToRoomId) {
    const roomNodes = nodes.filter((n) => getKey(n) === key);
    const functions: BlueprintFunction[] = roomNodes.map((n) => ({
      id: n.id,
      name: n.name,
      kind: RTE_KIND_TO_BLUEPRINT[n.type] ?? "function",
      description: n.description ?? n.path ?? n.file,
      simpleDescription: n.simpleDescription,
      descriptionSource: n.descriptionSource,
      file: n.file ? (projectRoot ? path.join(projectRoot, n.file) : n.file) : undefined,
    }));
    const intraRoomFlow = edges
      .filter((e) => nodeToRoomId.get(e.from) === roomId && nodeToRoomId.get(e.to) === roomId)
      .map((e) => mapRteEdge(e));
    const outboundFlow = edges
      .filter((e) => nodeToRoomId.get(e.from) === roomId && nodeToRoomId.get(e.to) !== roomId)
      .map((e) => mapRteEdge(e));
    const flowEdges = [...intraRoomFlow, ...outboundFlow];
    rooms.push({
      id: roomId,
      label: key.charAt(0).toUpperCase() + key.slice(1),
      path: key,
      functions,
      flowEdges,
    });
  }

  function mapRteEdge(e: RTEBlueprintEdge) {
    return {
      from: e.from,
      to: e.to,
      label: e.label,
      type: (e.type === "imports" ? "import" : e.type === "api_call" ? "api" : "call") as "import" | "call" | "api",
      weight: undefined,
      // v12 Tier 6 #3: an import is INFERRED connectivity (resolved a path, not
      // a confirmed use); a call/api_call is CONFIRMED. Ranking down-weights
      // inferred edges so confirmed calls count as stronger centrality.
      inferred: e.type === "imports",
    };
  }

  const roomEdges: BlueprintEdge[] = [];
  const edgeByKey = new Map<string, BlueprintEdge>();
  for (const e of edges) {
    const fromRoom = nodeToRoomId.get(e.from);
    const toRoom = nodeToRoomId.get(e.to);
    if (fromRoom && toRoom && fromRoom !== toRoom) {
      const key = `${fromRoom}->${toRoom}`;
      const existing = edgeByKey.get(key);
      const confirmed = e.type !== "imports"; // call / api_call
      if (!existing) {
        const edge: BlueprintEdge = {
          from: fromRoom,
          to: toRoom,
          label: e.label,
          type: e.type === "imports" ? "import" : e.type === "api_call" ? "api" : "call",
          weight: undefined,
          // v12 Tier 6 #3: import-inferred vs call-confirmed (see mapRteEdge).
          inferred: !confirmed,
        };
        edgeByKey.set(key, edge);
        roomEdges.push(edge);
      } else if (confirmed && existing.inferred) {
        // A confirmed call between this pair beats an earlier import.
        existing.inferred = false;
        if (existing.type === "import") {
          existing.type = e.type === "api_call" ? "api" : "call";
        }
      }
    }
  }

  return { rooms, edges: roomEdges, envRefs: [] };
}
