/**
 * Tiered Blueprint text for system prompt injection (v5.0 SECTION 1).
 * Ask / Plan / Build / Debug — token-budgeted; Build adds RAG-selected code snippets.
 */

import * as path from "path";
import type { Blueprint, BlueprintFunction, BlueprintRoom } from "@/shared/blueprint-types";
import { estimateTokens } from "@/ipc/utils/token_utils";
import {
  blueprintToRagGraph,
  rankBlueprintNodeIds,
  getCodeSnippetForBuildNode,
  type BlueprintGraph,
} from "@/lib/blueprint/blueprint-rag";
import { loadNodesAndEdges } from "@/lib/pivot/pivot-service";
import { filterBlueprintByAtlarixIgnore } from "@/lib/atlarix/atlarix-ignore";

type RagGraphNode = BlueprintGraph["nodes"][number];

/** v5.0 injection tier; Plan/Debug wired when UI passes explicit mode (SECTION 3). */
export type BlueprintInjectionMode = "ask" | "plan" | "build" | "debug";

const TOKEN_BUDGET: Record<BlueprintInjectionMode, number> = {
  ask: 500,
  plan: 1500,
  build: 4500,
  debug: 3000,
};

export function resolveBlueprintInjectionMode(params: {
  chatMode: "ask" | "build";
  userPrompt?: string;
  /** SECTION 3+: from UI / router */
  explicitBlueprintMode?: BlueprintInjectionMode;
}): BlueprintInjectionMode {
  if (params.explicitBlueprintMode) return params.explicitBlueprintMode;
  const p = (params.userPrompt ?? "").toLowerCase();
  if (params.chatMode === "build") return "build";
  if (
    p.includes("atlarix_plan") ||
    p.includes("atlarix plan") ||
    p.includes("implementation plan") ||
    p.includes("write_implementation_plan") ||
    p.includes("phased implementation") ||
    p.includes("roadmap for implementation") ||
    p.includes("architecture plan")
  ) {
    return "plan";
  }
  if (
    /^\s*error\b/m.test(p) ||
    p.includes("stack trace") ||
    p.includes("typeerror") ||
    p.includes("referenceerror") ||
    p.includes("syntaxerror") ||
    /\bat\s+[\w.$]+\./m.test(p)
  ) {
    return "debug";
  }
  return "ask";
}

export function isBlueprintEffectivelyEmpty(blueprint: Blueprint): boolean {
  const rooms = blueprint.rooms ?? [];
  const edges = blueprint.edges ?? [];
  if (rooms.length === 0 && edges.length === 0) return true;
  const hasNodes = rooms.some((r: BlueprintRoom) => (r.functions?.length ?? 0) > 0);
  return !hasNodes && edges.length === 0;
}

function truncateToTokens(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    const slice = text.slice(0, mid);
    if (estimateTokens(slice) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, Math.max(0, lo))}\n\n…(truncated to token budget)`;
}

function relFileForFunction(f: BlueprintFunction, projectRoot: string): string {
  const normRoot = path.normalize(projectRoot).replace(/\\/g, "/");
  if (f.file) {
    const nf = path.normalize(f.file).replace(/\\/g, "/");
    if (path.isAbsolute(f.file) && nf.startsWith(normRoot)) {
      return path.relative(projectRoot, f.file).replace(/\\/g, "/");
    }
    if (!path.isAbsolute(f.file)) {
      return f.file.replace(/\\/g, "/");
    }
    return f.file.replace(/\\/g, "/");
  }
  const d = f.description?.trim();
  if (d && !d.includes("\n") && /\.[a-zA-Z0-9]+$/.test(d)) {
    const nd = path.normalize(d).replace(/\\/g, "/");
    if (path.isAbsolute(d) && nd.startsWith(normRoot)) {
      return path.relative(projectRoot, d).replace(/\\/g, "/");
    }
    return d.replace(/\\/g, "/");
  }
  return "";
}

/** Legacy / tools: Ask-tier text with an explicit token cap. */
export function formatBlueprintAskTierLegacy(
  blueprint: Blueprint,
  projectRoot: string,
  maxTokens: number,
): string {
  return formatAskTier(blueprint, projectRoot, maxTokens);
}

function formatAskTier(blueprint: Blueprint, projectRoot: string, maxTokens: number): string {
  const lines: string[] = [
    "Blueprint — node names, kinds, and file paths (no source code). Same graph as the Diagram tab.",
  ];
  for (const room of blueprint.rooms ?? []) {
    if (room.hidden) continue;
    for (const f of room.functions ?? []) {
      const rel = relFileForFunction(f, projectRoot);
      const filePart = rel || "(no file path)";
      lines.push(`- ${f.name} [${f.kind}] ${filePart} (id=${f.id}, room=${room.label})`);
    }
  }
  return truncateToTokens(lines.join("\n"), maxTokens);
}

function formatPlanTier(blueprint: Blueprint, projectRoot: string, maxTokens: number): string {
  const parts: string[] = [
    "Blueprint — rooms, beacons (nodes), cross-room edges, and intra-room flow edges. No source code.",
  ];
  for (const room of blueprint.rooms ?? []) {
    if (room.hidden) continue;
    const fnLines = (room.functions ?? []).map((f: BlueprintFunction) => {
      const rel = relFileForFunction(f, projectRoot) || "(no file)";
      return `    - ${f.name} (${f.kind}) id=${f.id} file=${rel}`;
    });
    parts.push(`- Room **${room.label}** id=${room.id}${room.path ? ` path=${room.path}` : ""}`);
    if (fnLines.length) parts.push(...fnLines);
    else parts.push("    (no beacons)");
    const flows = room.flowEdges ?? [];
    for (const e of flows) {
      parts.push(`    flow: ${e.from} → ${e.to}${e.label ? ` (${e.label})` : ""}`);
    }
  }
  parts.push("");
  parts.push("Cross-room edges:");
  for (const e of blueprint.edges ?? []) {
    parts.push(`  - ${e.from} → ${e.to}${e.label ? ` — ${e.label}` : ""}${e.type ? ` [${e.type}]` : ""}`);
  }
  if (blueprint.envRefs?.length) {
    parts.push("");
    parts.push(`Env keys (names only): ${blueprint.envRefs.slice(0, 30).join(", ")}`);
  }
  return truncateToTokens(parts.join("\n"), maxTokens);
}

function collectNeighborFunctionIds(blueprint: Blueprint, seedIds: Set<string>): Set<string> {
  const out = new Set(seedIds);
  for (const room of blueprint.rooms ?? []) {
    for (const e of room.flowEdges ?? []) {
      if (seedIds.has(e.from)) out.add(e.to);
      if (seedIds.has(e.to)) out.add(e.from);
    }
  }
  return out;
}

function findFunctionsInFile(blueprint: Blueprint, projectRoot: string, bugFileRel: string): Set<string> {
  const normBug = bugFileRel.replace(/\\/g, "/");
  const ids = new Set<string>();
  for (const room of blueprint.rooms ?? []) {
    for (const f of room.functions ?? []) {
      const rel = relFileForFunction(f, projectRoot).replace(/\\/g, "/");
      if (rel && (rel === normBug || rel.endsWith("/" + normBug))) ids.add(f.id);
    }
  }
  return ids;
}

/** Parse file:line from common stack / error formats */
export function parseBugLocationFromText(text: string): { file: string; line?: number } | null {
  const lines = text.split("\n").slice(0, 40);
  for (const line of lines) {
    const m =
      line.match(/([^\s()]+\.(?:tsx?|jsx?|py|go|rs|java)):(\d+)/i) ||
      line.match(/at\s+(?:.*?\()?\s*([^\s()]+\.(?:tsx?|jsx?|py))(?:[:,])\s*(\d+)/i);
    if (m) {
      const filePath = m[1].replace(/^\.\//, "");
      const lineNum = m[2] ? parseInt(m[2], 10) : undefined;
      return { file: filePath, line: Number.isFinite(lineNum) ? lineNum : undefined };
    }
  }
  return null;
}

async function formatDebugTier(
  blueprint: Blueprint,
  projectRoot: string,
  userPrompt: string,
  errorTrace: string | undefined,
  bugFilePath: string | undefined,
  maxTokens: number,
): Promise<string> {
  const parts: string[] = ["Blueprint — Debug context (focused; no unrelated code)."];
  const trace = (errorTrace ?? "").trim() || userPrompt;
  const loc = bugFilePath
    ? { file: bugFilePath, line: undefined as number | undefined }
    : parseBugLocationFromText(trace) ?? parseBugLocationFromText(userPrompt);

  if (trace) {
    parts.push("");
    parts.push("Error / trace (excerpt):");
    parts.push(truncateToTokens(trace, Math.min(800, maxTokens)));
  }

  let seedIds = new Set<string>();
  if (loc?.file) {
    const rel = path.isAbsolute(loc.file)
      ? path.relative(projectRoot, loc.file).replace(/\\/g, "/")
      : loc.file.replace(/\\/g, "/");
    seedIds = findFunctionsInFile(blueprint, projectRoot, rel);
  }

  const neighborIds = collectNeighborFunctionIds(blueprint, seedIds);
  const graph = blueprintToRagGraph(blueprint, projectRoot);
  const idToNode = new Map<string, RagGraphNode>(graph.nodes.map((n: RagGraphNode) => [n.id, n]));

  parts.push("");
  parts.push("Relevant Blueprint nodes (bug file + direct flow neighbors):");
  for (const id of neighborIds) {
    const n = idToNode.get(id);
    if (n) {
      parts.push(`- ${n.name} id=${n.id} file=${n.file}${n.description ? ` — ${n.description}` : ""}`);
    }
  }

  if (loc?.file) {
    const abs = path.isAbsolute(loc.file) ? loc.file : path.join(projectRoot, loc.file);
    try {
      const fs = await import("fs/promises");
      const content = await fs.readFile(abs, "utf-8");
      const lines = content.split("\n");
      const line = loc.line && loc.line > 0 ? loc.line : 1;
      const start = Math.max(0, line - 1 - 8);
      const end = Math.min(lines.length, line + 8);
      parts.push("");
      parts.push(`Bug file excerpt (${path.relative(projectRoot, abs)} around line ${line}):`);
      parts.push("```");
      parts.push(lines.slice(start, end).join("\n"));
      parts.push("```");
    } catch {
      parts.push("");
      parts.push(`(Could not read bug file: ${loc.file})`);
    }
  }

  return truncateToTokens(parts.join("\n"), maxTokens);
}

export interface BuildBlueprintInjectionOptions {
  mode: BlueprintInjectionMode;
  workspaceId: number;
  blueprint: Blueprint;
  workspacePath: string;
  userPrompt: string;
  /** Debug tier */
  errorTrace?: string;
  bugFilePath?: string;
}

/**
 * Full markdown section body for "## Blueprint ..." (no heading).
 */
export async function buildBlueprintSystemPromptInjection(
  options: BuildBlueprintInjectionOptions,
): Promise<{ body: string; isEmpty: boolean }> {
  const { mode, workspaceId, blueprint, workspacePath, userPrompt, errorTrace, bugFilePath } = options;
  const budget = TOKEN_BUDGET[mode];

  const blueprintFiltered = await filterBlueprintByAtlarixIgnore(blueprint, workspacePath);

  if (isBlueprintEffectivelyEmpty(blueprintFiltered)) {
    return {
      body: "",
      isEmpty: true,
    };
  }

  if (mode === "ask") {
    return { body: formatAskTier(blueprintFiltered, workspacePath, budget), isEmpty: false };
  }

  if (mode === "plan") {
    return { body: formatPlanTier(blueprintFiltered, workspacePath, budget), isEmpty: false };
  }

  if (mode === "debug") {
    const body = await formatDebugTier(
      blueprintFiltered,
      workspacePath,
      userPrompt,
      errorTrace,
      bugFilePath,
      budget,
    );
    return { body, isEmpty: false };
  }

  // build — strict token budget: ranked RAG nodes; omit snippets that would exceed budget (never silent overflow).
  const graph = blueprintToRagGraph(blueprintFiltered, workspacePath);
  const query = userPrompt.slice(0, 2000);
  const rankedIds = rankBlueprintNodeIds(graph, query);
  const maxCandidates = 48;
  const candidateIds = rankedIds.slice(0, maxCandidates);

  let pivotRanges = new Map<string, { rangeStart?: number; rangeEnd?: number }>();
  try {
    const { nodes: pivotNodeRows } = await loadNodesAndEdges(workspaceId);
    for (const n of pivotNodeRows) {
      pivotRanges.set(n.id, { rangeStart: n.rangeStart, rangeEnd: n.rangeEnd });
    }
  } catch {
    pivotRanges = new Map();
  }

  const summaryTokenCap = Math.min(1600, Math.floor(budget * 0.38));
  let summary = truncateToTokens(
    formatPlanTier(blueprintFiltered, workspacePath, summaryTokenCap),
    summaryTokenCap,
  );

  const ragHeader =
    "\n\nRAG-selected code (ranked by relevance; PIVOT line ranges when available):\n";
  let usedTokens = estimateTokens(summary) + estimateTokens(ragHeader);
  const snippetLines: string[] = [];
  let included = 0;
  let omitted = 0;

  for (const nodeId of candidateIds) {
    const sn = await getCodeSnippetForBuildNode(graph, nodeId, workspacePath, pivotRanges);
    if (!sn) {
      omitted += 1;
      continue;
    }
    const block =
      `### ${sn.nodeId} — ${sn.path}:${sn.line}\n` +
      `\`\`\`${sn.language}\n${sn.content}\n\`\`\`\n\n`;
    const addTokens = estimateTokens(block);
    if (usedTokens + addTokens > budget) {
      omitted += 1;
      continue;
    }
    snippetLines.push(block);
    usedTokens += addTokens;
    included += 1;
  }

  let footer = "";
  if (omitted > 0) {
    footer = `\n\n_(Omitted ${omitted} lower-priority or unreadable blueprint node(s) to stay within the ${budget}-token Build-tier budget; ${included} snippet(s) included.)_`;
    usedTokens += estimateTokens(footer);
  }

  let body = `${summary}${ragHeader}${snippetLines.join("")}${footer}`;
  if (estimateTokens(body) > budget) {
    body = truncateToTokens(body, budget);
  }
  return { body, isEmpty: false };
}

export function blueprintFirstBlockedMessage(): string {
  return [
    "## Blueprint required",
    "",
    "This workspace has **no Blueprint** (no rooms with nodes/beacons).",
    "Before planning or building, generate or refresh the Blueprint from the **Diagram** tab (Blueprint / RTE from code), then continue.",
    "",
    "Do not proceed with implementation until the user has a non-empty Blueprint.",
  ].join("\n");
}
