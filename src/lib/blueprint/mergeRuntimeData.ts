/**
 * Merge runtime call graph (from OpenTelemetry/SQLite) with Blueprint for visualization.
 * Matches caller/callee names to beacons and adds flowEdges when they match.
 */

import type { Blueprint, BlueprintRoom, BlueprintRoomFlowEdge } from "@/shared/blueprint-types";

function normalizeName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, "_");
}

/** Build (caller, callee) edges from call graph (caller -> list of callees). */
function getRuntimeCallEdges(callGraph: Map<string, string[]>): { from: string; to: string }[] {
  const edges: { from: string; to: string }[] = [];
  const seen = new Set<string>();
  for (const [caller, callees] of callGraph) {
    for (const callee of callees) {
      const key = `${caller}\t${callee}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from: caller, to: callee });
    }
  }
  return edges;
}

/** If a function name matches the operation (by normalized name or includes), return true. */
function nameMatches(fnName: string | undefined, operation: string): boolean {
  if (!fnName) return false;
  const a = normalizeName(fnName);
  const b = normalizeName(operation);
  return a === b || a.includes(b) || b.includes(a);
}

/**
 * Merge runtime call edges into blueprint. For each room, adds flowEdges when both
 * endpoints match existing function names. Does not add new nodes; only adds edges.
 * Call graph can come from RuntimeAnalyzer.getCallGraph() (SQLite-backed).
 */
export function mergeRuntimeData(
  blueprint: Blueprint,
  callGraph: Map<string, string[]>
): Blueprint {
  const runtimeEdges = getRuntimeCallEdges(callGraph);
  if (runtimeEdges.length === 0) return blueprint;

  const rooms = blueprint.rooms.map((room: BlueprintRoom) => {
    const flowEdges = [...(room.flowEdges ?? [])];
    const flowKey = (from: string, to: string) => `${from}\t${to}`;
    const existing = new Set(flowEdges.map((e) => flowKey(e.from, e.to)));

    for (const { from: fromOp, to: toOp } of runtimeEdges) {
      const fromFn = room.functions.find((f) => nameMatches(f.name, fromOp));
      const toFn = room.functions.find((f) => nameMatches(f.name, toOp));
      if (fromFn && toFn && fromFn.id !== toFn.id && !existing.has(flowKey(fromFn.id, toFn.id))) {
        existing.add(flowKey(fromFn.id, toFn.id));
        flowEdges.push({
          from: fromFn.id,
          to: toFn.id,
          label: "runtime",
          type: "call",
        } as BlueprintRoomFlowEdge);
      }
    }

    return { ...room, flowEdges };
  });

  return { ...blueprint, rooms };
}
