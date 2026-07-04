/**
 * Models.dev Integration
 * ======================
 * Fetches model catalog from models.dev API (OpenCode-style).
 * Replaces hardcoded MODEL_OPTIONS with dynamic model lists.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import log from "electron-log";
import { BrowserWindow } from "electron";
import * as Sentry from "@sentry/electron/main";
import { getUserDataPath } from "@/paths/paths";
import type { LanguageModel } from "@/ipc/ipc_types";

const logger = log.scope("models_dev");

/** Fix: Finding 4 — notify renderer; do not block main chat. */
const MODELS_DEV_FETCH_TIMEOUT_MS = 30_000;

function broadcastModelsDevStatus(message: string, timedOut?: boolean): void {
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send("models-dev:status", { message, timedOut: !!timedOut });
      }
    }
  } catch (e) {
    logger.warn("models.dev status broadcast failed", e);
  }
}

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
  // Open-weight providers whose models.dev id differs from ours.
  qwen: "alibaba", // international DashScope catalog (dashscope-intl compatible-mode)
  moonshot: "moonshotai",
  // deepseek + minimax already match models.dev ids (identity).
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

export type RefreshModelsDevOptions = {
  /** When false, skip UI toast (e.g. hourly background refresh). Fix: Finding 4 */
  notify?: boolean;
};

/**
 * Fetch models from models.dev API
 */
export async function refreshModelsDev(opts?: RefreshModelsDevOptions): Promise<ModelsDevData> {
  const notify = opts?.notify !== false;
  if (notify) {
    broadcastModelsDevStatus("Updating model catalog in background…");
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MODELS_DEV_FETCH_TIMEOUT_MS);

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
      if (notify) broadcastModelsDevStatus("");
      return data;
    }
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    if (aborted) {
      logger.warn("[models.dev] Fetch timed out (30s), using cache");
      Sentry.captureMessage("models.dev refresh exceeded 30s timeout", {
        level: "warning",
        tags: { feature: "models_dev" },
      });
      if (notify) {
        broadcastModelsDevStatus("Model catalog update timed out; using cached list.", true);
      }
    } else {
      logger.warn("[models.dev] Fetch failed, using cache", e);
      if (notify) broadcastModelsDevStatus("");
    }
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

  return refreshModelsDev({ notify: false });
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
 * W12 (v14.8.11): real context/output limits for one model, straight from the
 * models.dev catalog (hourly-refreshed, disk-cached). Used by
 * `resolveModelContextLimit` as the step before the generic fallback, so
 * NO per-model limit is ever hardcoded. Returns null when the catalog has no
 * row for this provider/model.
 */
export async function getModelsDevLimits(
  atlarixProviderId: string,
  modelId: string,
): Promise<{ context?: number; output?: number } | null> {
  if (!atlarixProviderId || !modelId) return null;
  const data = await getModelsDevData();
  const provider = data[resolveModelsDevProviderId(atlarixProviderId)];
  if (!provider?.models) return null;
  const m =
    provider.models[modelId] ??
    // OpenRouter-style ids ("vendor/model") vs bare catalog ids.
    provider.models[modelId.includes("/") ? modelId.split("/").pop()! : modelId];
  return m?.limit ?? null;
}

/**
 * W12: fill missing contextWindow/maxOutputTokens on provider-fetched models
 * from models.dev. Many native `/models` endpoints (DeepSeek, generic
 * OpenAI-compatible) report no limits at all — without this, downstream
 * resolution used to fall back to hardcoded guesses. Values already present
 * (e.g. OpenRouter's live context_length) are never overwritten.
 */
export async function enrichModelsWithModelsDevLimits(
  atlarixProviderId: string,
  models: LanguageModel[],
): Promise<LanguageModel[]> {
  if (models.length === 0) return models;
  try {
    const data = await getModelsDevData();
    const provider = data[resolveModelsDevProviderId(atlarixProviderId)];
    if (!provider?.models) return models;
    return models.map((m) => {
      if (m.contextWindow && m.contextWindow > 0 && m.maxOutputTokens) return m;
      const row =
        provider.models[m.apiName] ??
        provider.models[
          m.apiName.includes("/") ? m.apiName.split("/").pop()! : m.apiName
        ];
      if (!row?.limit) return m;
      return {
        ...m,
        ...(m.contextWindow && m.contextWindow > 0
          ? {}
          : row.limit.context
            ? { contextWindow: row.limit.context }
            : {}),
        ...(m.maxOutputTokens
          ? {}
          : row.limit.output
            ? { maxOutputTokens: row.limit.output }
            : {}),
      };
    });
  } catch {
    return models;
  }
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

  refreshModelsDev({ notify: true }).catch(() => {});

  refreshTimer = setInterval(() => {
    refreshModelsDev({ notify: false }).catch(() => {});
  }, REFRESH_INTERVAL_MS);
  refreshTimer.unref();
}

/**
 * Reset cache (for testing or manual refresh)
 */
export function resetModelsDevCache(): void {
  cachedData = null;
}
