/**
 * Merge file-tree beacons into RTE/ctags blueprints when the graph is thin.
 */

import * as path from "path";
import type { Blueprint, BlueprintEdge, BlueprintRoom } from "@/shared/blueprint-types";
import { assessBlueprintRichness } from "@/lib/blueprint/blueprint-quality";

export const MAX_APPENDED_FILE_TREE_ROOMS = 40;

/** Normalize room label for matching (lowercase, trim, collapse spaces to underscore). */
export function normalizedRoomKey(room: { label: string; path?: string }): string {
  const s = (room.label ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_-]/g, "_");
  return s || "_";
}

function roomPathSuffix(roomPath: string | undefined): string {
  const p = (roomPath ?? "").replace(/\\/g, "/").toLowerCase();
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function inferredRoomMatchesBlueprint(
  inferred: BlueprintRoom,
  blueprint: BlueprintRoom,
): boolean {
  if (inferred.id === blueprint.id) return true;
  if (normalizedRoomKey(inferred) === normalizedRoomKey(blueprint)) return true;
  const infSuffix = roomPathSuffix(inferred.path);
  const bpSuffix = roomPathSuffix(blueprint.path);
  if (infSuffix && bpSuffix && infSuffix === bpSuffix) return true;
  const bpPath = (blueprint.path ?? "").toLowerCase();
  const infPath = (inferred.path ?? "").toLowerCase();
  if (infPath && bpPath && (infPath.endsWith(bpPath) || bpPath.endsWith(infPath))) return true;
  return false;
}

function blueprintRoomMatched(
  inferred: BlueprintRoom,
  blueprintRooms: BlueprintRoom[],
): boolean {
  return blueprintRooms.some((r) => inferredRoomMatchesBlueprint(inferred, r));
}

export type MergeFileTreeOptions = {
  /** When true, always run merge (ignore richness early exit). */
  force?: boolean;
  engine?: string;
};

/**
 * Merge file-tree rooms/functions/edges into an existing blueprint.
 * Appends unmatched file-tree rooms (capped) when the graph is thin.
 */
export function mergeBlueprintWithFileTree(
  blueprint: Blueprint,
  inferredRooms: BlueprintRoom[],
  inferredEdges: BlueprintEdge[],
  options: MergeFileTreeOptions = {},
): Blueprint {
  const richness = assessBlueprintRichness(blueprint);
  const hasFlowEdges = (blueprint.rooms ?? []).some((r) => (r.flowEdges?.length ?? 0) > 0);
  const hasCrossRoom = (blueprint.edges?.length ?? 0) > 0;
  const engine = options.engine ?? "";

  if (
    !options.force &&
    richness.quality === "rich" &&
    engine === "ast-grep+ctags" &&
    (hasFlowEdges || hasCrossRoom)
  ) {
    return blueprint;
  }

  const roomIds = new Set((blueprint.rooms ?? []).map((r) => r.id));
  const existingEdgeKeys = new Set((blueprint.edges ?? []).map((e) => `${e.from}\t${e.to}`));

  const inferredByRoomId = new Map(inferredRooms.map((r) => [r.id, r]));
  const inferredByKey = new Map(inferredRooms.map((r) => [normalizedRoomKey(r), r]));

  const inferredIdToBlueprintId = new Map<string, string>();
  for (const room of blueprint.rooms ?? []) {
    const byId = inferredByRoomId.get(room.id);
    if (byId) {
      inferredIdToBlueprintId.set(room.id, room.id);
      continue;
    }
    const key = normalizedRoomKey(room);
    const byKey = inferredByKey.get(key);
    if (byKey) inferredIdToBlueprintId.set(byKey.id, room.id);
    for (const inf of inferredRooms) {
      if (inferredRoomMatchesBlueprint(inf, room)) {
        inferredIdToBlueprintId.set(inf.id, room.id);
      }
    }
  }

  const newCrossRoom = (inferredEdges ?? [])
    .map((e) => {
      const fromId = inferredIdToBlueprintId.get(e.from) ?? e.from;
      const toId = inferredIdToBlueprintId.get(e.to) ?? e.to;
      return { ...e, from: fromId, to: toId };
    })
    .filter(
      (e) =>
        roomIds.has(e.from) &&
        roomIds.has(e.to) &&
        !existingEdgeKeys.has(`${e.from}\t${e.to}`) &&
        !(blueprint.removedInferredEdgeKeys ?? []).includes(`${e.from}\t${e.to}`),
    );

  let rooms = (blueprint.rooms ?? []).map((room) => {
    const inferredRoom =
      inferredByRoomId.get(room.id) ??
      inferredByKey.get(normalizedRoomKey(room)) ??
      inferredRooms.find((inf) => inferredRoomMatchesBlueprint(inf, room));

    const effectiveFunctions =
      (room.functions?.length ?? 0) > 0 ? room.functions : (inferredRoom?.functions ?? []);
    let nextRoom = { ...room, functions: effectiveFunctions };

    if (!inferredRoom?.flowEdges?.length) return nextRoom;

    const existingFlowKeys = new Set((nextRoom.flowEdges ?? []).map((e) => `${e.from}\t${e.to}`));
    const roomFnByName = new Map(nextRoom.functions.map((f) => [f.name, f]));
    const roomFnByFile = new Map(
      nextRoom.functions
        .filter((f) => f.file)
        .map((f) => [path.normalize(f.file!).replace(/\\/g, "/"), f]),
    );
    const roomFnByBasename = new Map(
      nextRoom.functions.map((f) => [f.name.toLowerCase(), f]),
    );
    const inferredToRoomFnId = new Map<string, string>();
    for (const inf of inferredRoom.functions) {
      const byFile = inf.file
        ? roomFnByFile.get(path.normalize(inf.file).replace(/\\/g, "/"))
        : undefined;
      const byName = roomFnByName.get(inf.name);
      const basenameFromId = inf.id.includes("::") ? inf.id.split("::").pop()! : inf.name;
      const byBasename = roomFnByBasename.get(basenameFromId.toLowerCase());
      const roomFn = byFile ?? byName ?? byBasename;
      if (roomFn) inferredToRoomFnId.set(inf.id, roomFn.id);
    }

    const added: typeof nextRoom.flowEdges = [];
    for (const e of inferredRoom.flowEdges) {
      const fromId = inferredToRoomFnId.get(e.from);
      const toId = inferredToRoomFnId.get(e.to);
      if (fromId && toId && !existingFlowKeys.has(`${fromId}\t${toId}`)) {
        added.push({ ...e, from: fromId, to: toId });
        existingFlowKeys.add(`${fromId}\t${toId}`);
      }
    }
    if (added.length === 0) return nextRoom;
    return { ...nextRoom, flowEdges: [...(nextRoom.flowEdges ?? []), ...added] };
  });

  if (richness.quality !== "rich") {
    const visibleCount = rooms.filter((r) => !r.hidden).length;
    let appended = 0;
    for (const inf of inferredRooms) {
      if (inf.hidden) continue;
      if (blueprintRoomMatched(inf, rooms)) continue;
      if (visibleCount + appended >= MAX_APPENDED_FILE_TREE_ROOMS) break;
      if ((inf.functions?.length ?? 0) === 0) continue;
      rooms = [...rooms, inf];
      roomIds.add(inf.id);
      inferredIdToBlueprintId.set(inf.id, inf.id);
      appended++;
    }

    for (const e of inferredEdges ?? []) {
      const fromId = inferredIdToBlueprintId.get(e.from) ?? e.from;
      const toId = inferredIdToBlueprintId.get(e.to) ?? e.to;
      if (
        roomIds.has(fromId) &&
        roomIds.has(toId) &&
        !existingEdgeKeys.has(`${fromId}\t${toId}`)
      ) {
        newCrossRoom.push({ ...e, from: fromId, to: toId });
        existingEdgeKeys.add(`${fromId}\t${toId}`);
      }
    }
  }

  const edges = [...(blueprint.edges ?? []), ...newCrossRoom];
  return { ...blueprint, rooms, edges };
}
