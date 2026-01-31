/**
 * Models.dev Integration
 * ======================
 * Fetches model catalog from models.dev API (OpenCode-style).
 * Replaces hardcoded MODEL_OPTIONS with dynamic model lists.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import log from "electron-log";
import { getUserDataPath } from "@/paths/paths";
import type { LanguageModel } from "@/ipc/ipc_types";

const logger = log.scope("models_dev");

const MODELS_DEV_URL = process.env.ATLARIX_MODELS_URL ?? "https://models.dev";
const REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

interface ModelsDevModel {
  id?: string;
  name: string;
  family?: string;
  tool_call?: boolean;
  cost?: { input: number; output: number };
  limit?: { context?: number; output?: number };
  status?: string;
}

interface ModelsDevProvider {
  id: string;
  name: string;
  env?: string[];
  api?: string;
  npm?: string;
  models: Record<string, ModelsDevModel>;
}

type ModelsDevData = Record<string, ModelsDevProvider>;

/** Map Atlarix provider IDs to models.dev provider IDs (when they differ) */
const PROVIDER_ID_MAP: Record<string, string> = {
  together: "togetherai",
  togetherai: "togetherai",
};

let cachedData: ModelsDevData | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

function getCachePath(): string {
  return path.join(getUserDataPath(), "cache", "models.json");
}

async function loadFromCache(): Promise<ModelsDevData | null> {
  try {
    const cachePath = getCachePath();
    const content = await fs.readFile(cachePath, "utf-8");
    const parsed = JSON.parse(content) as ModelsDevData;
    if (parsed && typeof parsed === "object" && Object.keys(parsed).length > 0) {
      return parsed;
    }
  } catch {
    // Cache miss or invalid - will fetch
  }
  return null;
}

async function saveToCache(data: ModelsDevData): Promise<void> {
  try {
    const cachePath = getCachePath();
    const dir = path.dirname(cachePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(cachePath, JSON.stringify(data), "utf-8");
  } catch (e) {
    logger.warn("Failed to save models.dev cache", e);
  }
}

/**
 * Fetch models from models.dev API
 */
export async function refreshModelsDev(): Promise<ModelsDevData> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    const res = await fetch(`${MODELS_DEV_URL}/api.json`, {
      headers: { "User-Agent": "Atlarix/1.0" },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const data = (await res.json()) as ModelsDevData;
    if (data && typeof data === "object") {
      await saveToCache(data);
      cachedData = data;
      logger.info(`[models.dev] Fetched ${Object.keys(data).length} providers`);
      return data;
    }
  } catch (e) {
    logger.warn("[models.dev] Fetch failed, using cache", e);
  }

  // Fallback to cache
  const cached = await loadFromCache();
  if (cached) {
    cachedData = cached;
    return cached;
  }

  cachedData = {};
  return {};
}

/**
 * Get models.dev data (cached or fetch)
 */
export async function getModelsDevData(): Promise<ModelsDevData> {
  if (cachedData) {
    return cachedData;
  }

  const cached = await loadFromCache();
  if (cached) {
    cachedData = cached;
    return cached;
  }

  return refreshModelsDev();
}

/**
 * Resolve models.dev provider ID from Atlarix provider ID
 */
function resolveModelsDevProviderId(atlarixProviderId: string): string {
  return PROVIDER_ID_MAP[atlarixProviderId] ?? atlarixProviderId;
}

/**
 * Convert models.dev model to Atlarix LanguageModel format
 */
function toLanguageModel(
  modelId: string,
  m: ModelsDevModel,
  _providerId: string
): LanguageModel {
  return {
    apiName: modelId,
    displayName: m.name,
    description: m.family ?? "",
    maxOutputTokens: m.limit?.output,
    contextWindow: m.limit?.context ?? 0,
    type: "cloud",
  };
}

/**
 * Get models for a cloud provider from models.dev
 */
export async function getModelsFromModelsDev(
  atlarixProviderId: string
): Promise<LanguageModel[]> {
  const data = await getModelsDevData();
  const modelsDevProviderId = resolveModelsDevProviderId(atlarixProviderId);
  const provider = data[modelsDevProviderId];

  if (!provider?.models) {
    return [];
  }

  const models: LanguageModel[] = [];
  for (const [modelId, m] of Object.entries(provider.models)) {
    if (m.status === "deprecated") continue;
    // Atlarix uses native tool calling - only include models that support it
    if (m.tool_call !== true) continue;

    models.push(toLanguageModel(modelId, m, atlarixProviderId));
  }

  // Sort by context size (desc) then by name
  models.sort((a, b) => {
    const ctxA = a.contextWindow ?? 0;
    const ctxB = b.contextWindow ?? 0;
    if (ctxB !== ctxA) return ctxB - ctxA;
    return (a.displayName ?? "").localeCompare(b.displayName ?? "");
  });

  return models;
}

/**
 * Start background refresh (call from main process on app ready)
 */
export function startModelsDevRefresh(): void {
  if (refreshTimer) return;

  refreshModelsDev().catch(() => {});

  refreshTimer = setInterval(() => {
    refreshModelsDev().catch(() => {});
  }, REFRESH_INTERVAL_MS);
  refreshTimer.unref();
}

/**
 * Reset cache (for testing or manual refresh)
 */
export function resetModelsDevCache(): void {
  cachedData = null;
}
