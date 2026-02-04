/**
 * Infer a Blueprint from workspace analysis (codebase as source of truth).
 * Blueprint becomes the visual representation of the actual code structure.
 */

import * as path from "path";
import type {
  Blueprint,
  BlueprintRoom,
  BlueprintEdge,
  BlueprintFunction,
} from "@/shared/blueprint-types";
import { generateBlueprintId } from "@/shared/blueprint-types";
import type { WorkspaceAnalysis, Cluster } from "@/lib/analysis";

function safeId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^_+|_+$/g, "") || "node";
}

/**
 * Build a Blueprint from workspace analysis.
 * - Rooms = logical clusters (top-level dirs / modules) with key files as functions
 * - Edges = dependencies between clusters (from import/call graph)
 */
export function inferBlueprintFromWorkspace(analysis: WorkspaceAnalysis): Blueprint {
  const { clusters, dependencies, entryPoints, files } = analysis;

  // Map file path (relative) → cluster that contains it
  const fileToCluster = new Map<string, Cluster>();
  for (const c of clusters) {
    for (const f of c.files) {
      fileToCluster.set(f, c);
    }
  }

  // If analyzer returned no clusters (e.g. flat or single-file), create one "Root" room
  const rooms: BlueprintRoom[] = [];
  const clusterIdToRoomId = new Map<string, string>();

  if (clusters.length === 0) {
    const roomId = "room_root";
    const rootFunctions: BlueprintFunction[] = entryPoints.slice(0, 8).map((relPath) => ({
      id: generateBlueprintId(),
      name: path.basename(relPath, path.extname(relPath)),
      kind: "feature",
      description: relPath,
    }));
    if (rootFunctions.length === 0 && files.length > 0) {
      rootFunctions.push({
        id: generateBlueprintId(),
        name: path.basename(files[0].relativePath, path.extname(files[0].relativePath)),
        kind: "function",
        description: files[0].relativePath,
      });
    }
    rooms.push({
      id: roomId,
      label: "Root",
      path: ".",
      intent: "Entry points and main code",
      functions: rootFunctions.length ? rootFunctions : [{ id: generateBlueprintId(), name: "(empty)", kind: "function" }],
    });
    return { rooms, edges: [], envRefs: [] };
  }

  const invalidNames = new Set([".", "..", ""]);
  for (const cluster of clusters) {
    const rawName = cluster.name?.trim() ?? "";
    if (invalidNames.has(rawName)) continue;
    const displayName = rawName === "root" ? "Root" : rawName;
    const roomId = `room_${safeId(displayName)}`;
    clusterIdToRoomId.set(cluster.id, roomId);

    const entryInCluster = cluster.files.filter((f) => entryPoints.includes(f));
    const others = cluster.files.filter((f) => !entryPoints.includes(f)).slice(0, 6);
    const functions: BlueprintFunction[] = [];

    for (const relPath of entryInCluster.slice(0, 4)) {
      functions.push({
        id: generateBlueprintId(),
        name: path.basename(relPath, path.extname(relPath)),
        kind: "feature",
        description: relPath,
      });
    }
    for (const relPath of others) {
      if (functions.length >= 8) break;
      const file = files.find((f) => f.relativePath === relPath);
      const kind = file?.type === "component" ? "feature" : file?.type === "controller" ? "api" : "function";
      functions.push({
        id: generateBlueprintId(),
        name: path.basename(relPath, path.extname(relPath)),
        kind,
        description: relPath,
      });
    }
    if (functions.length === 0) {
      functions.push({
        id: generateBlueprintId(),
        name: cluster.name,
        kind: "function",
        description: cluster.files[0],
      });
    }

    rooms.push({
      id: roomId,
      label: displayName,
      type: cluster.purpose,
      path: path.dirname(cluster.files[0] ?? ""),
      intent: cluster.purpose,
      functions,
    });
  }

  // Edges from dependencies: only between different clusters
  const edgeKeys = new Set<string>();
  const blueprintEdges: BlueprintEdge[] = [];

  for (const dep of dependencies) {
    const fromCluster = fileToCluster.get(dep.from);
    const toCluster = fileToCluster.get(dep.to);
    if (!fromCluster || !toCluster || fromCluster.id === toCluster.id) continue;

    const fromRoomId = clusterIdToRoomId.get(fromCluster.id);
    const toRoomId = clusterIdToRoomId.get(toCluster.id);
    if (!fromRoomId || !toRoomId) continue;

    const key = `${fromRoomId}\t${toRoomId}`;
    if (edgeKeys.has(key)) continue;
    edgeKeys.add(key);
    blueprintEdges.push({ from: fromRoomId, to: toRoomId, label: dep.type });
  }

  return { rooms, edges: blueprintEdges, envRefs: [] };
}
