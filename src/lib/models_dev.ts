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
import { registerModelsDevVision } from "@/lib/routing/model-capability-profile";

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
  modalities?: { input?: string[]; output?: string[] };
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
  // Bedrock has NO native fetcher, so models.dev is its ONLY source — an
  // unmapped id meant the lookup missed and the provider listed zero models.
  bedrock: "amazon-bedrock",
  // NVIDIA NIM does have a native fetcher, so models still appeared, but the
  // limit/cost enrichment silently missed and every model fell back to the
  // generic 200K context guess with no price.
  nvidia_nim: "nvidia",
};

let cachedData: ModelsDevData | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

/** models.dev provider id → Atlarix provider id (reverse of PROVIDER_ID_MAP). */
const REVERSE_PROVIDER_ID_MAP: Record<string, string> = {
  togetherai: "together",
  alibaba: "qwen",
  moonshotai: "moonshot",
  // Keep in sync with PROVIDER_ID_MAP: without these the long-tail catalog
  // emits `amazon-bedrock`/`nvidia` as SEPARATE providers, which then fail to
  // de-dupe against the built-in `bedrock`/`nvidia_nim` entries and show up
  // twice in the picker (getLanguageModelProviders keys de-dup on this id).
  "amazon-bedrock": "bedrock",
  nvidia: "nvidia_nim",
};

/**
 * v14.8.11 (image-hallucination fix): push every model's IMAGE-input modality
 * into the capability profile's sync registry so the vision gate covers
 * native open-weight providers (DeepSeek v4 is multimodal on its own API but
 * never matched the old OpenRouter-row-or-hardcoded-3 gate — the model was
 * left image-blind and hallucinated attachment contents from filenames).
 */
function publishVisionModalities(data: ModelsDevData): void {
  try {
    const entries: Array<{ providerId: string; modelId: string; acceptsImages: boolean }> = [];
    for (const [providerId, provider] of Object.entries(data)) {
      if (!provider?.models) continue;
      const atlarixId = REVERSE_PROVIDER_ID_MAP[providerId];
      for (const [modelId, m] of Object.entries(provider.models)) {
        const acceptsImages = Array.isArray(m.modalities?.input)
          ? m.modalities.input.some((mod) => String(mod).toLowerCase() === "image")
          : false;
        entries.push({ providerId, modelId, acceptsImages });
        if (atlarixId) entries.push({ providerId: atlarixId, modelId, acceptsImages });
      }
    }
    registerModelsDevVision(entries);
  } catch (e) {
    logger.warn("[models.dev] vision-modality publish failed", e);
  }
}

/** Single assignment point for the in-memory catalog — keeps the vision
 * registry in lockstep with whatever data the process is actually using. */
function setCachedData(data: ModelsDevData): void {
  cachedData = data;
  publishVisionModalities(data);
}

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
      setCachedData(data);
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
    setCachedData(cached);
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
    setCachedData(cached);
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
 * Look up one catalog row by the provider's own api name. Falls back to the
 * bare id for OpenRouter-style "vendor/model" names. Single definition so the
 * limit, cost and tool-capability paths can never drift apart.
 */
function findModelsDevRow(
  providerModels: Record<string, ModelsDevModel>,
  apiName: string,
): ModelsDevModel | undefined {
  return (
    providerModels[apiName] ??
    providerModels[apiName.includes("/") ? apiName.split("/").pop()! : apiName]
  );
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
    cost: m.cost,
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
  return findModelsDevRow(provider.models, modelId)?.limit ?? null;
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
      const row = findModelsDevRow(provider.models, m.apiName);
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
 * Drop models that can't drive the tool loop, and mark the rest honestly.
 *
 * Atlarix is a native-tool-calling app, so a model without tool support is not
 * merely degraded — it can't run the agent at all. The models.dev path already
 * enforced this (`getModelsFromModelsDev` skips `tool_call !== true`), but the
 * provider-native fetchers didn't, so the "first-class" providers leaked
 * non-tool models (image/realtime/guard/transcribe) into the picker while the
 * long tail stayed clean. This is that same gate, applied to the native path —
 * one funnel for every provider instead of a bespoke filter each.
 *
 * A model the catalog does NOT know is KEPT. Native fetch exists precisely to
 * surface models newer than the hourly catalog, and these vendors ship weekly;
 * dropping unknown ids would trade an accuracy bug for a freshness bug. Only an
 * explicit `tool_call: false` removes a model — and every catalog row carries
 * the field, so `false` is a real signal rather than a missing one.
 *
 * Catalog unavailable or provider unknown → input returned untouched.
 */
export async function annotateToolCapability(
  atlarixProviderId: string,
  models: LanguageModel[],
): Promise<LanguageModel[]> {
  if (models.length === 0) return models;
  try {
    const data = await getModelsDevData();
    const provider = data[resolveModelsDevProviderId(atlarixProviderId)];
    if (!provider?.models) return models;

    const out: LanguageModel[] = [];
    for (const m of models) {
      if (m.type !== "cloud") {
        out.push(m);
        continue;
      }
      // A fetcher that explicitly declared `supportsToolChoice: false` has
      // already made this call deliberately (Perplexity's Sonar family is
      // non-tool-calling by design but still worth listing). Respect it rather
      // than dropping the model out from under the fetcher.
      if (m.supportsToolChoice === false) {
        out.push(m);
        continue;
      }
      const row = findModelsDevRow(provider.models, m.apiName);
      // Unknown to the catalog → keep (newer than the catalog).
      if (!row) {
        out.push(m);
        continue;
      }
      if (row.tool_call === false) continue;
      out.push(m.supportsToolChoice ? m : { ...m, supportsToolChoice: true });
    }
    return out;
  } catch {
    return models;
  }
}

/**
 * Non-deprecated catalog rows for a provider, WITHOUT the tool-calling gate.
 *
 * Almost every caller wants `getModelsFromModelsDev` instead. This exists for
 * providers whose whole family is legitimately non-tool-calling (Perplexity's
 * Sonar) and which we still want to list — marked honestly — rather than hide.
 */
export async function getModelsDevCatalogRows(
  atlarixProviderId: string,
  opts: { requireToolCall?: boolean } = {},
): Promise<LanguageModel[]> {
  const { requireToolCall = true } = opts;
  const data = await getModelsDevData();
  const provider = data[resolveModelsDevProviderId(atlarixProviderId)];

  if (!provider?.models) {
    return [];
  }

  const models: LanguageModel[] = [];
  for (const [modelId, m] of Object.entries(provider.models)) {
    if (m.status === "deprecated") continue;
    // Atlarix uses native tool calling - only include models that support it
    if (requireToolCall && m.tool_call !== true) continue;

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
 * Model ids for a provider that accept AUDIO input, newest-catalog-order first.
 *
 * Drives voice transcription so speech-to-text model ids aren't hardcoded (the
 * same rot the model pickers were just taken off — `gemini-2.0-flash` was still
 * pinned in the voice handler long after it aged out). 71 providers in the
 * catalog expose audio-input models. Empty array when unknown — callers fall
 * back rather than break.
 */
export async function getAudioInputModelIds(
  atlarixProviderId: string,
): Promise<string[]> {
  try {
    const data = await getModelsDevData();
    const provider = data[resolveModelsDevProviderId(atlarixProviderId)];
    if (!provider?.models) return [];
    return Object.entries(provider.models)
      .filter(
        ([, m]) =>
          m.status !== "deprecated" &&
          (m.modalities?.input ?? []).includes("audio"),
      )
      .map(([id]) => id);
  } catch {
    return [];
  }
}

/** A provider's API base URL from the catalog (for OpenAI-compatible calls). */
export async function getProviderApiBaseUrl(
  atlarixProviderId: string,
): Promise<string | undefined> {
  try {
    const data = await getModelsDevData();
    return data[resolveModelsDevProviderId(atlarixProviderId)]?.api;
  } catch {
    return undefined;
  }
}

/**
 * Get models for a cloud provider from models.dev (tool-capable models only).
 */
export async function getModelsFromModelsDev(
  atlarixProviderId: string
): Promise<LanguageModel[]> {
  return getModelsDevCatalogRows(atlarixProviderId);
}

/**
 * Full provider catalog from models.dev — every provider that carries an API
 * base URL (`api`) and at least one model. Drives opencode-style "all providers
 * off the bat": each becomes a connectable OpenAI-compatible provider (its base
 * URL + key env var), instantiated via the shared default path in
 * get_model_client. Providers Atlarix hardcodes (special auth / native wire
 * formats — anthropic, google, vertex, bedrock, compass, openrouter) override
 * these by id, so this only ADDS the long tail. Catalog is disk-cached and
 * hourly-refreshed with last-good fallback, so it never blocks or throws.
 */
export async function getModelsDevProviderCatalog(): Promise<
  Array<{ id: string; name: string; apiBaseUrl: string; envVarName?: string }>
> {
  const data = await getModelsDevData();
  const out: Array<{
    id: string;
    name: string;
    apiBaseUrl: string;
    envVarName?: string;
  }> = [];
  for (const [modelsDevId, provider] of Object.entries(data)) {
    // No base URL → can't instantiate via OpenAI-compatible; skip.
    if (!provider?.api) continue;
    if (!provider.models || Object.keys(provider.models).length === 0) continue;
    const atlarixId = REVERSE_PROVIDER_ID_MAP[modelsDevId] ?? modelsDevId;
    out.push({
      id: atlarixId,
      name: provider.name || atlarixId,
      apiBaseUrl: provider.api,
      envVarName: provider.env?.[0],
    });
  }
  return out;
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
