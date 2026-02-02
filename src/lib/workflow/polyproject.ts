/**
 * Polyproject - detect multi-root workspaces (frontend + backend, monorepo)
 * and merge workflows into one canvas with grouped layout.
 */

import * as fs from "fs/promises";
import * as path from "path";
import type { InferredWorkflow } from "./project_to_workflow";

const PROJECT_INDICATORS = ["package.json", "pyproject.toml", "requirements.txt", "go.mod", "Cargo.toml"];

export interface ProjectRoot {
  path: string;
  label: string;
}

/**
 * Detect if workspace has multiple project roots (e.g. frontend + backend, or packages/*).
 */
export async function detectPolyproject(workspacePath: string): Promise<ProjectRoot[] | null> {
  let entries: { name: string }[];
  try {
    entries = await fs.readdir(workspacePath, { withFileTypes: true });
  } catch {
    return null;
  }

  const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules");
  const hasIndicator = (dir: string) =>
    Promise.all(
      PROJECT_INDICATORS.map((ind) => fs.stat(path.join(dir, ind)).then(() => true).catch(() => false))
    ).then((r) => r.some(Boolean));

  const roots: ProjectRoot[] = [];

  // Pattern 1: frontend / backend (or api, server, client)
  const knownPairs = [
    ["frontend", "backend"],
    ["frontend", "api"],
    ["client", "server"],
    ["web", "api"],
    ["app", "api"],
  ];
  for (const [a, b] of knownPairs) {
    const dirA = path.join(workspacePath, a);
    const dirB = path.join(workspacePath, b);
    try {
      const [hasA, hasB] = await Promise.all([
        fs.stat(dirA).then(() => true).catch(() => false),
        fs.stat(dirB).then(() => true).catch(() => false),
      ]);
      if (hasA && hasB) {
        const [projA, projB] = await Promise.all([hasIndicator(dirA), hasIndicator(dirB)]);
        if (projA) roots.push({ path: dirA, label: a });
        if (projB) roots.push({ path: dirB, label: b });
        if (roots.length >= 2) return roots;
      }
    } catch {
      //
    }
  }

  // Pattern 2: packages/* or apps/* (monorepo)
  const multiDirs = ["packages", "apps", "services"];
  for (const multi of multiDirs) {
    const multiPath = path.join(workspacePath, multi);
    try {
      const sub = await fs.readdir(multiPath, { withFileTypes: true });
      const subDirs = sub.filter((e) => e.isDirectory() && !e.name.startsWith("."));
      for (const d of subDirs) {
        const subPath = path.join(multiPath, d.name);
        if (await hasIndicator(subPath)) {
          roots.push({ path: subPath, label: `${multi}/${d.name}` });
        }
      }
      if (roots.length >= 2) return roots;
    } catch {
      //
    }
  }

  return roots.length >= 2 ? roots : null;
}

const OFFSET_X = 700;
const OFFSET_Y = 80;

/**
 * Merge multiple workflows into one with x-offset per group; node ids prefixed to avoid collisions.
 */
export function mergeWorkflows(
  items: Array<{ label: string; workflow: InferredWorkflow }>
): InferredWorkflow {
  const nodes: InferredWorkflow["nodes"] = [];
  const connections: InferredWorkflow["connections"] = {};

  items.forEach((item, groupIndex) => {
    const prefix = `g${groupIndex}-`;
    const offsetX = groupIndex * OFFSET_X;
    const offsetY = groupIndex * OFFSET_Y;

    for (const node of item.workflow.nodes) {
      const newId = prefix + node.id;
      nodes.push({
        id: newId,
        type: node.type,
        parameters: {
          ...(node.parameters ?? {}),
          _group: item.label,
        },
        position: [node.position[0] + offsetX, node.position[1] + offsetY],
      });
    }

    for (const [sourceId, conn] of Object.entries(item.workflow.connections)) {
      const newSourceId = prefix + sourceId;
      const targets = conn?.main?.[0] ?? [];
      if (!connections[newSourceId]) connections[newSourceId] = { main: [[]] };
      for (const t of targets) {
        if (t?.node) {
          const newTargetId = prefix + t.node;
          if (!connections[newSourceId].main[0].some((x) => x.node === newTargetId)) {
            connections[newSourceId].main[0].push({ node: newTargetId });
          }
        }
      }
    }
  });

  return { nodes, connections };
}
