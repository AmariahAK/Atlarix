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

