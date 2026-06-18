/**
 * Scoped blueprint parse keys, topic filtering, and tool failure envelopes.
 */

import path from "node:path";
import type { Blueprint, BlueprintRoom } from "@/shared/blueprint-types";

export type BlueprintParseOptions = {
  /** Workspace-relative folder section (required for tool-driven parse). */
  focusPath: string;
  /** Workforce / explicit IPC only — allow scanning workspace root. */
  allowWorkspaceRoot?: boolean;
};

export const BLUEPRINT_PARSE_TIMEOUT_MS = 150_000;
export const BLUEPRINT_PROGRESS_LOG_MS = 20_000;

export function normalizeBlueprintFocusPath(p: string): string {
  return String(p ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

/** Tool-driven parses must not scan the whole workspace (use a top-level section folder). */
export function isWorkspaceRootFocusPath(focusPath: string): boolean {
  const fp = normalizeBlueprintFocusPath(focusPath);
  return !fp || fp === "." || fp === "..";
}

export function blueprintCacheKey(workspaceId: number, focusPath: string): string {
  const fp = normalizeBlueprintFocusPath(focusPath);
  return `${workspaceId}:${fp || "."}`;
}

export function resolveScanRoot(workspacePath: string, focusPath: string): string {
  const fp = normalizeBlueprintFocusPath(focusPath);
  if (!fp || fp === ".") return workspacePath;
  return path.join(workspacePath, fp);
}

/** Split topic on | for alternates (e.g. payment|stripe|billing). */
export function topicTerms(topic: string): string[] {
  return topic
    .split("|")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

function roomMatchesTopic(room: BlueprintRoom, terms: string[]): boolean {
  const hay = `${room.label} ${room.intent ?? ""} ${room.path ?? ""}`.toLowerCase();
  if (terms.some((t) => hay.includes(t))) return true;
  return (room.functions ?? []).some((fn) => {
    const fh = `${fn.name} ${fn.file ?? ""}`.toLowerCase();
    return terms.some((t) => fh.includes(t));
  });
}

const TOPIC_NODE_CAP = 80;

export function filterBlueprintByTopic(
  blueprint: Blueprint,
  topic: string | undefined,
): { blueprint: Blueprint; applied: boolean; before: number; after: number } {
  if (!topic?.trim()) {
    return {
      blueprint,
      applied: false,
      before: blueprint.rooms.length,
      after: blueprint.rooms.length,
    };
  }
  const terms = topicTerms(topic);
  if (!terms.length) {
    return {
      blueprint,
      applied: false,
      before: blueprint.rooms.length,
      after: blueprint.rooms.length,
    };
  }
  const before = blueprint.rooms.length;
  const rooms = blueprint.rooms.filter((r) => roomMatchesTopic(r, terms)).slice(0, TOPIC_NODE_CAP);
  const keep = new Set(rooms.map((r) => r.id));
  const edges = (blueprint.edges ?? []).filter((e) => keep.has(e.from) && keep.has(e.to));
  return {
    blueprint: { ...blueprint, rooms, edges, envRefs: blueprint.envRefs },
    applied: true,
    before,
    after: rooms.length,
  };
}
