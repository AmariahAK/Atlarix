/**
 * AppMap → Mermaid - Generate a simple flowchart from AppMap (for diagram-from-AppMap).
 * Used when we want an architecture diagram derived from the workflow spec.
 */

import type { AppMap } from "./app_map_types";

function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9]/g, "_");
}

/**
 * Generate a Mermaid flowchart from AppMap: entry points, data sources, and flows.
 */
export function appMapToMermaid(appMap: AppMap): string {
  const lines: string[] = ["flowchart LR"];
  const idMap = new Map<string, string>();

  for (const ep of appMap.entryPoints) {
    const id = safeId(ep.id);
    idMap.set(ep.id, id);
    const label = (ep.method && ep.path ? `${ep.method} ${ep.path}` : ep.name ?? ep.id).replace(/"/g, "'");
    lines.push(`  ${id}["${label}"]`);
  }
  for (const ds of appMap.dataSources) {
    const id = safeId(ds.id);
    idMap.set(ds.id, id);
    const label = (ds.name ?? ds.id).replace(/"/g, "'");
    lines.push(`  ${id}(("${label}"))`);
  }
  for (const sc of appMap.screens ?? []) {
    const id = safeId(sc.id);
    idMap.set(sc.id, id);
    const label = (sc.name ?? sc.path ?? sc.id).replace(/"/g, "'");
    lines.push(`  ${id}[/"${label}"/]`);
  }

  for (const flow of appMap.flows ?? []) {
    const from = idMap.get(flow.from) ?? safeId(flow.from);
    const to = idMap.get(flow.to) ?? safeId(flow.to);
    if (idMap.has(flow.from) && idMap.has(flow.to)) {
      lines.push(`  ${from} --> ${to}`);
    }
  }

  return lines.join("\n");
}
