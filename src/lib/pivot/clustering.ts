/**
 * PIVOT AI clustering — group nodes into 5–8 containers with beacon descriptions.
 */

import { generateText } from "ai";
import { readSettings } from "@/main/settings";
import { getSummarizationModelAsync } from "@/lib/summarization_model";
import { getModelClient } from "@/ipc/utils/get_model_client";
import type { PivotNode, PivotEdge, Container, Beacon, PivotBlueprint } from "./types";
import type { Blueprint, BlueprintRoom, BlueprintFunction } from "@/shared/blueprint-types";
import { generateBlueprintId } from "@/shared/blueprint-types";
import log from "electron-log";

const logger = log.scope("pivot-clustering");

const SYSTEM = `You are an expert software architect. Given a list of code nodes (files, functions, classes) and optional framework, group them into 5–8 logical CONTAINERS (high-level modules like "API", "Database", "Auth", "UI Components"). For each container, list the node IDs that belong to it. For each node that is a function or class, provide a one-line BEACON description (what it does). Reply with valid JSON only, no markdown or preamble.

Output format:
{
  "containers": [ { "name": "string", "nodeIds": ["file::path", "file::path::function::name", ...] } ],
  "beacons": [ { "nodeId": "string", "containerName": "string", "label": "string", "description": "string", "kind": "function"|"api"|"feature" } ]
}
- container "name" must be a short label (1-3 words).
- nodeIds must be exact ids from the input list.
- beacons: one entry per function/class node; label = symbol name, description = one short sentence.`;

export interface ClusterResult {
  blueprint: Blueprint;
  pivotBlueprint: PivotBlueprint;
}

/**
 * Run AI clustering on nodes/edges and return a Blueprint (rooms + functions + edges).
 * workspaceId is applied to containers when saving (pass 0 if only using in-memory).
 */
export async function clusterIntoContainers(
  nodes: PivotNode[],
  edges: PivotEdge[],
  options: { framework?: string; workspaceId?: number } = {},
): Promise<ClusterResult> {
  const { framework, workspaceId = 0 } = options;
  const nodeList = nodes
    .map((n) => `- ${n.id} (${n.type}): ${n.label} [${n.filePath}]`)
    .join("\n");
  const edgeList =
    edges.length > 0
      ? edges.slice(0, 100).map((e) => `${e.fromId} --${e.type}--> ${e.toId}`).join("\n")
      : "(none)";
  const userPrompt = `Framework: ${framework ?? "unknown"}

Nodes:
${nodeList}

Edges (sample):
${edgeList}

Return JSON with 5–8 containers and beacons for each function/class node.`;

  const settings = readSettings();
  const modelConfig = await getSummarizationModelAsync(settings);
  const { modelClient } = await getModelClient(modelConfig, settings);
  const result = await generateText({
    model: modelClient.model,
    system: SYSTEM,
    messages: [{ role: "user", content: userPrompt }],
    maxTokens: 4000,
  } as Parameters<typeof generateText>[0]);

  let data: {
    containers?: Array<{ name: string; nodeIds: string[] }>;
    beacons?: Array<{
      nodeId: string;
      containerName: string;
      label: string;
      description?: string;
      kind?: string;
    }>;
  };
  try {
    const raw = result.text.trim().replace(/^```json?\s*|\s*```$/g, "");
    data = JSON.parse(raw) as typeof data;
  } catch (e) {
    logger.warn("Clustering AI response not valid JSON:", e);
    return fallbackCluster(nodes, edges, workspaceId);
  }

  const containersList = data.containers ?? [];
  const beaconsList = data.beacons ?? [];
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  const containers: Container[] = [];
  const beacons: Beacon[] = [];
  const roomIdByContainerName = new Map<string, string>();

  let cx = 0;
  let cy = 0;
  for (const c of containersList) {
    const id = `room_${c.name.replace(/\W/g, "_")}_${generateBlueprintId().slice(-6)}`;
    roomIdByContainerName.set(c.name, id);
    containers.push({
      id,
      workspaceId,
      label: c.name,
      position: { x: cx * 220, y: cy * 160 },
      createdAt: Date.now(),
    });
    cx++;
    if (cx >= 4) {
      cx = 0;
      cy++;
    }
  }

  for (const b of beaconsList) {
    const node = nodeById.get(b.nodeId);
    const kind = (b.kind === "api" || b.kind === "webhook" || b.kind === "feature" ? b.kind : "function") as Beacon["kind"];
    const containerId = roomIdByContainerName.get(b.containerName);
    if (!containerId) continue;
    const beaconId = generateBlueprintId();
    beacons.push({
      id: beaconId,
      containerId,
      label: b.label || node?.label || b.nodeId,
      kind,
      description: b.description ?? undefined,
      filePath: node?.filePath,
      position: undefined,
    });
  }

  const rooms: BlueprintRoom[] = containers.map((c) => ({
    id: c.id,
    label: c.label,
    intent: undefined,
    functions: beacons
      .filter((b) => b.containerId === c.id)
      .map((b) => ({
        id: b.id,
        name: b.label,
        kind: b.kind as BlueprintFunction["kind"],
        description: b.description,
        descriptionSource: "ai" as const,
        aiGenerated: true,
      })) as BlueprintFunction[],
  }));

  const nodeToContainerId = new Map<string, string>();
  for (const c of containersList) {
    const containerId = roomIdByContainerName.get(c.name);
    if (containerId) for (const nid of c.nodeIds) nodeToContainerId.set(nid, containerId);
  }
  const blueprintEdges: Array<{ from: string; to: string }> = [];
  const seen = new Set<string>();
  for (const e of edges) {
    const fromC = nodeToContainerId.get(e.fromId);
    const toC = nodeToContainerId.get(e.toId);
    if (fromC && toC && fromC !== toC) {
      const key = `${fromC}\t${toC}`;
      if (!seen.has(key)) {
        seen.add(key);
        blueprintEdges.push({ from: fromC, to: toC });
      }
    }
  }

  const blueprint: Blueprint = {
    rooms,
    edges: blueprintEdges.map((e) => ({ from: e.from, to: e.to, inferred: true as const })),
    envRefs: [],
  };

  const pivotBlueprint: PivotBlueprint = {
    containers,
    beacons,
    nodes,
    edges,
  };

  return { blueprint, pivotBlueprint };
}

function fallbackCluster(nodes: PivotNode[], edges: PivotEdge[], workspaceId = 0): ClusterResult {
  const fileNodes = nodes.filter((n) => n.type === "file");
  const byDir = new Map<string, PivotNode[]>();
  for (const n of fileNodes) {
    const rel = (n.metadata?.relativePath as string) ?? "";
    const dir = rel.split("/").slice(0, 2).join("/") || "root";
    const list = byDir.get(dir) ?? [];
    list.push(n);
    byDir.set(dir, list);
  }
  const containers: Container[] = [];
  const beacons: Beacon[] = [];
  let cx = 0;
  let cy = 0;
  for (const [dir, fileList] of byDir.entries()) {
    const id = `room_${dir.replace(/\W/g, "_")}`;
    containers.push({
      id,
      workspaceId,
      label: dir === "root" ? "Root" : dir,
      position: { x: cx * 220, y: cy * 160 },
      createdAt: Date.now(),
    });
    const fileIds = new Set(fileList.map((f) => f.id));
    const symNodes = nodes.filter((s) => s.type !== "file" && fileIds.has((s.metadata?.parentFileId as string) ?? ""));
    for (const s of symNodes.slice(0, 10)) {
      beacons.push({
        id: generateBlueprintId(),
        containerId: id,
        label: s.label,
        kind: s.type === "class" ? "feature" : "function",
        filePath: s.filePath,
      });
    }
    cx++;
    if (cx >= 4) {
      cx = 0;
      cy++;
    }
  }
  const rooms: BlueprintRoom[] = containers.map((c) => ({
    id: c.id,
    label: c.label,
    functions: beacons.filter((b) => b.containerId === c.id).map((b) => ({
      id: b.id,
      name: b.label,
      kind: b.kind as BlueprintFunction["kind"],
      aiGenerated: true,
    })) as BlueprintFunction[],
  }));
  const blueprint: Blueprint = { rooms, edges: [], envRefs: [] };
  const pivotBlueprint: PivotBlueprint = { containers, beacons, nodes, edges };
  return { blueprint, pivotBlueprint };
}
