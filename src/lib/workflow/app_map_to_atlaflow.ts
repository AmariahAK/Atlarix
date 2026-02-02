/**
 * App Map → Atlaflow - Convert language-agnostic app map to canvas workflow
 * Used for: project → Atlaflow (after extractors produce AppMap)
 */

import type { AtlaflowWorkflow } from "./atlaflow_converter";
import type { AppMap, AppMapEntryPoint, AppMapDataSource, AppMapScreen, AppMapConditional } from "./app_map_types";

const STEP_X = 260;
const STEP_Y = 120;

/** Node type for app-map–derived nodes (so we can round-trip Atlaflow → AppMap) */
export const ATLAFLOW_ENTRY = "atlaflow.entryPoint";
export const ATLAFLOW_DATA = "atlaflow.dataSource";
export const ATLAFLOW_SCREEN = "atlaflow.screen";
export const ATLAFLOW_BRANCH = "atlaflow.branch";

/**
 * Convert AppMap to AtlaflowWorkflow so existing projects can populate the canvas.
 */
export function appMapToAtlaflow(appMap: AppMap): AtlaflowWorkflow {
  const nodes: AtlaflowWorkflow["nodes"] = [];
  const connections: AtlaflowWorkflow["connections"] = {};
  let x = 100;
  let y = 80;
  let row = 0;

  const idToNodeId = new Map<string, string>();

  // Entry points → nodes
  for (const ep of appMap.entryPoints) {
    const nodeId = `ep-${ep.id}`;
    idToNodeId.set(ep.id, nodeId);
    const label =
      ep.type === "http" && ep.method && ep.path
        ? `${ep.method} ${ep.path}`
        : ep.name || ep.handlerSymbol || ep.id;
    nodes.push({
      id: nodeId,
      type: ATLAFLOW_ENTRY,
      parameters: {
        label,
        ...ep,
      },
      position: [x, y + row * STEP_Y],
    });
    row++;
    if (row >= 6) {
      row = 0;
      x += STEP_X;
    }
  }

  // Data sources → nodes
  x = 100 + STEP_X;
  row = 0;
  for (const ds of appMap.dataSources) {
    const nodeId = `ds-${ds.id}`;
    idToNodeId.set(ds.id, nodeId);
    nodes.push({
      id: nodeId,
      type: ATLAFLOW_DATA,
      parameters: {
        label: ds.name || ds.id,
        ...ds,
      },
      position: [x, y + row * STEP_Y],
    });
    row++;
    if (row >= 6) {
      row = 0;
      x += STEP_X;
    }
  }

  // Screens (optional)
  if (appMap.screens && appMap.screens.length > 0) {
    x = 100 + STEP_X * 2;
    row = 0;
    for (const sc of appMap.screens) {
      const nodeId = `screen-${sc.id}`;
      idToNodeId.set(sc.id, nodeId);
      nodes.push({
        id: nodeId,
        type: ATLAFLOW_SCREEN,
        parameters: {
          label: sc.name || sc.path || sc.id,
          ...sc,
        },
        position: [x, y + row * STEP_Y],
      });
      row++;
    }
  }

  // Conditionals → branch nodes
  if (appMap.conditionals && appMap.conditionals.length > 0) {
    let branchX = 100 + STEP_X * 2;
    let branchRow = 0;
    for (const cond of appMap.conditionals) {
      const nodeId = `branch-${cond.id}`;
      idToNodeId.set(cond.id, nodeId);
      nodes.push({
        id: nodeId,
        type: ATLAFLOW_BRANCH,
        parameters: { label: cond.label ?? cond.condition ?? "branch", ...cond },
        position: [branchX, y + branchRow * STEP_Y],
      });
      branchRow++;
      if (branchRow >= 4) {
        branchRow = 0;
        branchX += STEP_X;
      }
    }
    for (const cond of appMap.conditionals) {
      const fromId = idToNodeId.get(cond.id) ?? `branch-${cond.id}`;
      const thenId = idToNodeId.get(cond.thenNode) ?? cond.thenNode;
      if (nodes.some((n) => n.id === fromId) && nodes.some((n) => n.id === thenId)) {
        if (!connections[fromId]) connections[fromId] = { main: [[]] };
        if (!connections[fromId].main[0].some((t) => t.node === thenId)) {
          connections[fromId].main[0].push({ node: thenId });
        }
      }
      if (cond.elseNode) {
        const elseId = idToNodeId.get(cond.elseNode) ?? cond.elseNode;
        if (nodes.some((n) => n.id === elseId)) {
          if (!connections[fromId]) connections[fromId] = { main: [[]] };
          if (!connections[fromId].main[0].some((t) => t.node === elseId)) {
            connections[fromId].main[0].push({ node: elseId });
          }
        }
      }
    }
  }

  // Flows → connections
  for (const flow of appMap.flows ?? []) {
    const fromId = idToNodeId.get(flow.from) ?? `ep-${flow.from}`;
    const toId = idToNodeId.get(flow.to) ?? `ds-${flow.to}`;
    if (!nodes.some((n) => n.id === fromId) || !nodes.some((n) => n.id === toId)) continue;
    if (!connections[fromId]) connections[fromId] = { main: [[]] };
    if (!connections[fromId].main[0].some((t) => t.node === toId)) {
      connections[fromId].main[0].push({ node: toId });
    }
  }

  return { nodes, connections };
}
