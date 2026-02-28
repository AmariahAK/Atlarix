/**
 * Model capability registry: contextWindow, supportsToolCalling, supportsVision, tier.
 * Persisted to user data path (Electron main process); infer tier from model name when API unavailable.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  FAST_MODEL_KEYWORDS,
  THINKING_MODEL_KEYWORDS,
} from "./signal-sets";

export type ModelTier = "fast" | "balanced" | "thinking";

export interface ModelCapabilities {
  contextWindow: number;
  supportsToolCalling: boolean;
  supportsVision: boolean;
  tier: ModelTier;
  provider: string;
  /** Model name/id */
  modelId: string;
}

const CAPABILITIES_FILE = "model-capabilities.json";

function getCapabilitiesPath(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getUserDataPath } = require("../../paths/paths") as {
      getUserDataPath: () => string;
    };
    return path.join(getUserDataPath(), CAPABILITIES_FILE);
  } catch {
    return path.join(process.cwd(), "userData", CAPABILITIES_FILE);
  }
}

let cache: Record<string, ModelCapabilities> | null = null;

function cacheKey(provider: string, modelId: string): string {
  return `${provider}:${modelId}`;
}

/**
 * Infer tier from model name when API data not available.
 */
export function inferTierFromModelName(modelId: string): ModelTier {
  const lower = modelId.toLowerCase();
  if (FAST_MODEL_KEYWORDS.some((k) => lower.includes(k))) return "fast";
  if (THINKING_MODEL_KEYWORDS.some((k) => lower.includes(k))) return "thinking";
  return "balanced";
}

async function loadCache(): Promise<Record<string, ModelCapabilities>> {
  if (cache) return cache;
  try {
    const filePath = getCapabilitiesPath();
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    const raw = await fs.readFile(filePath, "utf-8");
    cache = JSON.parse(raw) as Record<string, ModelCapabilities>;
    return cache ?? {};
  } catch {
    cache = {};
    return cache;
  }
}

async function saveCache(): Promise<void> {
  if (!cache) return;
  try {
    const filePath = getCapabilitiesPath();
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(cache, null, 2), "utf-8");
  } catch (err) {
    console.warn("[capability-registry] Failed to save:", err);
  }
}

/**
 * Get capabilities for a provider+model. Returns undefined if not cached.
 */
export async function getCapabilities(
  provider: string,
  modelId: string
): Promise<ModelCapabilities | undefined> {
  const c = await loadCache();
  return c[cacheKey(provider, modelId)];
}

/**
 * Set capabilities for a provider+model (e.g. after fetching from API or inferring).
 */
export async function setCapabilities(
  provider: string,
  modelId: string,
  caps: Partial<Omit<ModelCapabilities, "provider" | "modelId">> & { provider: string; modelId: string }
): Promise<void> {
  const c = await loadCache();
  const key = cacheKey(provider, modelId);
  const existing = c[key];
  const tier =
    caps.tier ?? existing?.tier ?? inferTierFromModelName(modelId);
  c[key] = {
    contextWindow: caps.contextWindow ?? existing?.contextWindow ?? 128_000,
    supportsToolCalling: caps.supportsToolCalling ?? existing?.supportsToolCalling ?? true,
    supportsVision: caps.supportsVision ?? existing?.supportsVision ?? false,
    tier,
    provider: caps.provider ?? provider,
    modelId: caps.modelId ?? modelId,
  };
  cache = c;
  await saveCache();
}

/**
 * Get tier for a provider+model (from cache or infer from name).
 */
export async function getTier(provider: string, modelId: string): Promise<ModelTier> {
  const caps = await getCapabilities(provider, modelId);
  return caps?.tier ?? inferTierFromModelName(modelId);
}
