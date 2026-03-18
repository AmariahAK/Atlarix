/**
 * Blueprint enrichment: balanced model, concurrent batches of 10, contentHash cache.
 * Produces description, inputs[], outputs[], dataFlows[] per node.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { generateText } from "ai";
import { readSettings } from "@/main/settings";
import { getModelClient } from "@/ipc/utils/get_model_client";
import { getBalancedModelForCurrentProvider } from "@/ipc/utils/get_model_client";
import type { BlueprintFunction, BlueprintRoom } from "@/shared/blueprint-types";

const ENRICHMENT_SYSTEM = `You are enriching a blueprint node for a developer tool.
Given RTE-parsed code data, write:
1. A 1-sentence specific description (not vague — name the actual data/operations)
2. inputs[] — what data this node receives (format, type, source)
3. outputs[] — what data this node produces or emits
4. dataFlows[] — which other nodes this connects to and what data moves
Reply as JSON only. No preamble. Use keys: description, inputs, outputs, dataFlows.`;

export interface EnrichmentResult {
  description: string;
  inputs: string[];
  outputs: string[];
  dataFlows: Array<{ to: string; label: string }>;
}

function getProjectHash(projectPath: string): string {
  return crypto.createHash("sha256").update(projectPath).digest("hex").slice(0, 16);
}

function getEnrichmentCachePath(projectPath: string): string {
  const projectHash = getProjectHash(projectPath);
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getUserDataPath } = require("../../paths/paths") as { getUserDataPath: () => string };
    return path.join(getUserDataPath(), "atlarix", "blueprints", projectHash, "enrichment-cache.json");
  } catch {
    return path.join(process.cwd(), "userData", "atlarix", "blueprints", projectHash, "enrichment-cache.json");
  }
}

let cache: Record<string, EnrichmentResult> | null = null;

async function loadCache(cachePath: string): Promise<Record<string, EnrichmentResult>> {
  if (cache) return cache;
  try {
    const dir = path.dirname(cachePath);
    await fs.mkdir(dir, { recursive: true });
    const raw = await fs.readFile(cachePath, "utf-8");
    cache = JSON.parse(raw) as Record<string, EnrichmentResult>;
    return cache ?? {};
  } catch {
    cache = {};
    return cache;
  }
}

async function saveCache(cachePath: string): Promise<void> {
  if (!cache) return;
  try {
    const dir = path.dirname(cachePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(cachePath, JSON.stringify(cache, null, 2), "utf-8");
  } catch (err) {
    console.warn("[enricher] Failed to save cache:", err);
  }
}

function contentHash(sourceCode: string): string {
  return crypto.createHash("sha256").update(sourceCode).digest("hex").slice(0, 24);
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

async function enrichNode(
  node: BlueprintFunction,
  sourceCode: string,
  settings: ReturnType<typeof readSettings>,
  cacheMap: Record<string, EnrichmentResult>
): Promise<EnrichmentResult | null> {
  const hash = contentHash(sourceCode);
  if (cacheMap[hash]) return cacheMap[hash];

  const balancedModel = getBalancedModelForCurrentProvider(settings);
  if (!balancedModel) return null;

  try {
    const { modelClient } = await getModelClient(balancedModel, settings);
    const result = await generateText({
      model: modelClient.model,
      system: ENRICHMENT_SYSTEM,
      messages: [
        {
          role: "user" as const,
          content: `Node: ${node.name}, kind: ${node.kind}. Path: ${node.file ?? node.description ?? ""}. Code snippet:\n${sourceCode.slice(0, 2000)}`,
        },
      ],
      maxTokens: 150,
    } as Parameters<typeof generateText>[0]);

    const text = result.text.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]) as EnrichmentResult;
    if (!parsed.description) parsed.description = "";
    if (!Array.isArray(parsed.inputs)) parsed.inputs = [];
    if (!Array.isArray(parsed.outputs)) parsed.outputs = [];
    if (!Array.isArray(parsed.dataFlows)) parsed.dataFlows = [];

    cacheMap[hash] = parsed;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Enrich all nodes in rooms: run in batches of 10, use contentHash cache.
 * Reads source from node.file when present.
 */
export async function enrichAll(
  projectPath: string,
  rooms: BlueprintRoom[],
  readFile: (filePath: string) => Promise<string>
): Promise<void> {
  const cachePath = getEnrichmentCachePath(projectPath);
  const cacheMap = await loadCache(cachePath);

  const nodesToEnrich: { node: BlueprintFunction; sourceCode: string }[] = [];

  for (const room of rooms) {
    for (const fn of room.functions) {
      const filePath = fn.file ?? fn.description;
      if (!filePath) continue;
      let sourceCode: string;
      try {
        sourceCode = await readFile(filePath);
      } catch {
        continue;
      }
      const hash = contentHash(sourceCode);
      if (cacheMap[hash]) {
        const en = cacheMap[hash];
        fn.simpleDescription = en.description;
        fn.enrichmentInputs = en.inputs;
        fn.enrichmentOutputs = en.outputs;
        fn.enrichmentDataFlows = en.dataFlows;
        continue;
      }
      nodesToEnrich.push({ node: fn, sourceCode });
    }
  }

  const settings = readSettings();
  for (const batch of chunk(nodesToEnrich, 10)) {
    await Promise.all(
      batch.map(async ({ node, sourceCode }) => {
        const en = await enrichNode(node, sourceCode, settings, cacheMap);
        if (en) {
          node.simpleDescription = en.description;
          node.enrichmentInputs = en.inputs;
          node.enrichmentOutputs = en.outputs;
          node.enrichmentDataFlows = en.dataFlows;
        }
      })
    );
  }

  cache = cacheMap;
  await saveCache(cachePath);
  cache = null; // allow fresh load next time
}
