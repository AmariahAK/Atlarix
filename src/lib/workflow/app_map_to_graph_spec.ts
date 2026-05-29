/**
 * AppMap → graph spec — generate nodes/edges JSON from workflow AppMap.
 */

import type { AppMap } from "./app_map_types";
import type { GraphSpec } from "@/lib/visual-artifacts/graph-spec";
import { serializeGraphSpec } from "@/lib/visual-artifacts/graph-spec";

function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/g, "_");
}

/**
 * Generate a graph JSON spec from AppMap: entry points, data sources, screens, and flows.
 */
export function appMapToGraphSpec(appMap: AppMap, title?: string): GraphSpec {
  const nodes: GraphSpec["nodes"] = [];
  const edges: GraphSpec["edges"] = [];
  const idMap = new Map<string, string>();

  for (const ep of appMap.entryPoints) {
    const id = safeId(ep.id);
    idMap.set(ep.id, id);
    const name =
      ep.method && ep.path ? `${ep.method} ${ep.path}` : (ep.name ?? ep.id);
    nodes.push({ id, name });
  }
  for (const ds of appMap.dataSources) {
    const id = safeId(ds.id);
    idMap.set(ds.id, id);
    nodes.push({ id, name: ds.name ?? ds.id });
  }
  for (const sc of appMap.screens ?? []) {
    const id = safeId(sc.id);
    idMap.set(sc.id, id);
    nodes.push({ id, name: sc.name ?? sc.path ?? sc.id });
  }

  for (const flow of appMap.flows ?? []) {
    const from = idMap.get(flow.from);
    const to = idMap.get(flow.to);
    if (from && to) {
      edges.push({ source: from, target: to });
    }
  }

  return {
    title: title ?? "App map",
    layout: "force",
    nodes,
    edges,
  };
}

export function appMapToGraphJson(appMap: AppMap, title?: string): string {
  return serializeGraphSpec(appMapToGraphSpec(appMap, title));
}
