/**
 * Atlaflow → App Map - Convert canvas workflow back to language-agnostic app map
 * Used for: Atlaflow → project (codegen), modify Atlaflow → project + diagram
 */

import type { AtlaflowWorkflow } from "./atlaflow_converter";
import type { AppMap, AppMapEntryPoint, AppMapDataSource, AppMapFlow, AppMapScreen, AppMapConditional, Runtime } from "./app_map_types";
import { ATLAFLOW_ENTRY, ATLAFLOW_DATA, ATLAFLOW_SCREEN, ATLAFLOW_BRANCH } from "./app_map_to_atlaflow";

/**
 * Convert AtlaflowWorkflow back to AppMap for codegen.
 * Detects runtime from node types (atlaflow.entryPoint, n8n-nodes-base.*, etc.) or defaults to node.
 */
export function atlaflowToAppMap(
  workflow: AtlaflowWorkflow,
  runtime: Runtime = "node"
): AppMap {
  const entryPoints: AppMapEntryPoint[] = [];
  const dataSources: AppMapDataSource[] = [];
  const flows: AppMapFlow[] = [];
  const screens: AppMapScreen[] = [];
  const conditionals: AppMapConditional[] = [];

  for (const node of workflow.nodes) {
    const params = node.parameters ?? {};
    const label = (params.label as string) ?? node.id;

    if (node.type === ATLAFLOW_ENTRY) {
      entryPoints.push({
        id: node.id,
        type: (params.type as AppMapEntryPoint["type"]) ?? "http",
        method: params.method as string | undefined,
        path: params.path as string | undefined,
        name: params.name as string | undefined,
        handlerFile: params.handlerFile as string | undefined,
        handlerSymbol: params.handlerSymbol as string | undefined,
        summary: params.summary as string | undefined,
        nodeId: node.id,
      });
    } else if (node.type === ATLAFLOW_DATA) {
      dataSources.push({
        id: node.id,
        type: (params.type as AppMapDataSource["type"]) ?? "database",
        name: (params.name as string) ?? label,
        usage: params.usage as string[] | undefined,
        nodeId: node.id,
      });
    } else if (node.type === ATLAFLOW_SCREEN) {
      screens.push({
        id: node.id,
        path: params.path as string | undefined,
        name: (params.name as string) ?? label,
        file: params.file as string | undefined,
        nodeId: node.id,
      });
    } else if (node.type === ATLAFLOW_BRANCH) {
      conditionals.push({
        id: node.id,
        label: params.label as string | undefined,
        condition: params.condition as string | undefined,
        thenNode: params.thenNode as string,
        elseNode: params.elseNode as string | undefined,
        nodeId: node.id,
      });
    } else {
      // n8n or other: treat as entry (e.g. webhook) or data (e.g. postgres) from type name
      const t = String(node.type).toLowerCase();
      if (t.includes("webhook") || t.includes("trigger") || t.includes("manual")) {
        entryPoints.push({
          id: node.id,
          type: "http",
          name: label,
          nodeId: node.id,
        });
      } else if (
        t.includes("postgres") ||
        t.includes("mysql") ||
        t.includes("mongo") ||
        t.includes("redis") ||
        t.includes("api")
      ) {
        dataSources.push({
          id: node.id,
          type: t.includes("redis") ? "cache" : "database",
          name: label,
          nodeId: node.id,
        });
      }
    }
  }

  for (const [sourceId, conn] of Object.entries(workflow.connections)) {
    const targets = conn?.main?.[0] ?? [];
    for (const t of targets) {
      if (t?.node) flows.push({ from: sourceId, to: t.node, kind: "calls" });
    }
  }

  return {
    runtime,
    entryPoints,
    dataSources,
    flows,
    ...(screens.length > 0 && { screens }),
    ...(conditionals.length > 0 && { conditionals }),
  };
}
