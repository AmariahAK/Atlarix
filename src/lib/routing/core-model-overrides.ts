/**
 * Runtime Core-tier model overrides (main process only).
 * ======================================================
 * Fetches a small hosted JSON (in the public atlarix-releases repo) that maps
 * each Core tier to an OpenRouter model id, caches it on disk, and feeds it into
 * the pure renderer-safe store (`core-model-override-store.ts`). This lets the
 * Core models change WITHOUT repackaging the app — build-time env
 * (`ATLARIX_CORE_MODEL_1..4`) remains the safe fallback when the JSON is absent.
 *
 * Mirrors the fetch/cache pattern in `src/lib/models_dev.ts`.
 */

import * as fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import log from "electron-log";
import { BrowserWindow } from "electron";
import { getUserDataPath } from "@/paths/paths";
import {
  CORE_TIER_ORDER,
  emptySlotAware,
  normalizeCoreTierId,
} from "@/ipc/shared/compass_constants";
import {
  setCoreModelOverrides,
  setCoreModelWebSearch,
  setCoreModelRouting,
  type CoreTierRouting,
} from "@/ipc/shared/core-model-override-store";

const logger = log.scope("core-models");

const FETCH_TIMEOUT_MS = 15_000;
const REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour, parity with models.dev

const REMOTE_URL =
  process.env.ATLARIX_CORE_MODELS_URL ??
  "https://raw.githubusercontent.com/AmariahAK/atlarix-releases/main/core-models.json";

const CORE_TIER_IDS = new Set<string>(CORE_TIER_ORDER as readonly string[]);

interface CoreModelsPayload {
  version?: number;
  models?: Record<string, unknown>;
  /**
   * Optional per-tier web-search capability (`core-N` → boolean). Absent → every
   * tier defaults to enabled. Set a tier `false` to keep it on the client
   * `web_search` (SearxNG) tool instead of OpenRouter's metered server tool.
   */
  webSearch?: Record<string, unknown>;
  /**
   * Optional per-tier direct-provider routing (`core-N` → {provider, apiModelId}).
   * Absent → that tier resolves through OpenRouter (pre-migration shape, and the
   * per-tier rollback lever).
   */
  routing?: Record<string, unknown>;
}

let refreshTimer: ReturnType<typeof setInterval> | null = null;

/** Last applied override map (sorted-serialized) so we only broadcast on real changes. */
let lastAppliedSerialized: string | null = null;

function getCachePath(): string {
  return path.join(getUserDataPath(), "cache", "core-models.json");
}

/** Notify renderer windows that Core model ids changed, so model lists re-fetch. */
function broadcastCoreModelsChanged(): void {
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send("core-models:changed");
    }
  } catch (e) {
    logger.warn("core-models change broadcast failed", e);
  }
}

/**
 * Apply overrides from a raw `core-models.json` payload to the store. Sets both
 * the tier→model map and the per-tier web-search capability, and — when the
 * resolved model map actually changed since the last apply — broadcasts so the
 * renderer invalidates its cached model lists (Core display name updates live,
 * without an app restart). Web-search-only changes take effect on the next
 * dispatch and need no broadcast.
 */
function applyOverridesAndNotify(raw: unknown): void {
  const map = parseCoreModelsPayload(raw);
  setCoreModelOverrides(map);
  setCoreModelWebSearch(parseCoreWebSearchOverrides(raw));
  setCoreModelRouting(parseCoreRouting(raw));
  const serialized = map
    ? JSON.stringify(Object.entries(map).sort(([a], [b]) => a.localeCompare(b)))
    : null;
  if (serialized !== lastAppliedSerialized) {
    lastAppliedSerialized = serialized;
    broadcastCoreModelsChanged();
  }
}

/**
 * Validate a raw payload into a clean `core-N` → model-id map. Unknown keys and
 * empty/null values are dropped (those tiers fall back to env). Returns null when
 * nothing usable is present, so callers can leave the store untouched.
 */
function parseCoreModelsPayload(raw: unknown): Record<string, string> | null {
  if (!raw || typeof raw !== "object") return null;
  const models = (raw as CoreModelsPayload).models;
  if (!models || typeof models !== "object") return null;
  const map: Record<string, string> = {};
  for (const [key, value] of Object.entries(models)) {
    const norm = normalizeCoreTierId(key);
    if (!CORE_TIER_IDS.has(norm)) continue;
    // A slot parked as "TBA" reads as EMPTY, same as the env path — otherwise the
    // placeholder would be dispatched to the provider as a model id.
    const resolved = emptySlotAware(value);
    if (resolved) map[norm] = resolved;
  }
  return Object.keys(map).length > 0 ? map : null;
}

/**
 * Validate the optional `webSearch` block into a clean `core-N` → boolean map.
 * Only explicit booleans are kept; unknown tiers and non-boolean values are
 * dropped (those tiers default to enabled). Returns null when nothing usable.
 */
function parseCoreWebSearchOverrides(
  raw: unknown,
): Record<string, boolean> | null {
  if (!raw || typeof raw !== "object") return null;
  const web = (raw as CoreModelsPayload).webSearch;
  if (!web || typeof web !== "object") return null;
  const map: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(web)) {
    const norm = normalizeCoreTierId(key);
    if (!CORE_TIER_IDS.has(norm)) continue;
    if (typeof value !== "boolean") continue;
    map[norm] = value;
  }
  return Object.keys(map).length > 0 ? map : null;
}

/**
 * Validate the optional `routing` block into a clean `core-N` → {provider, apiModelId}
 * map. Both fields are required — a half-specified entry would resolve to a vendor we
 * can't name a model for, so it is dropped and that tier falls back to OpenRouter.
 */
function parseCoreRouting(
  raw: unknown,
): Record<string, CoreTierRouting> | null {
  if (!raw || typeof raw !== "object") return null;
  const routing = (raw as CoreModelsPayload).routing;
  if (!routing || typeof routing !== "object") return null;
  const map: Record<string, CoreTierRouting> = {};
  for (const [key, value] of Object.entries(routing)) {
    const norm = normalizeCoreTierId(key);
    if (!CORE_TIER_IDS.has(norm)) continue;
    if (!value || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    const provider =
      typeof entry.provider === "string" ? entry.provider.trim() : "";
    const apiModelId =
      typeof entry.apiModelId === "string" ? entry.apiModelId.trim() : "";
    if (!provider || !apiModelId) continue;
    map[norm] = { provider, apiModelId };
  }
  return Object.keys(map).length > 0 ? map : null;
}

/** Read + JSON-parse the cached raw payload, or null on miss/invalid. */
async function loadRawFromCache(): Promise<unknown | null> {
  try {
    const content = await fs.readFile(getCachePath(), "utf-8");
    return JSON.parse(content);
  } catch {
    return null; // cache miss / invalid — fall back to env
  }
}

async function saveToCache(raw: unknown): Promise<void> {
  try {
    const cachePath = getCachePath();
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, JSON.stringify(raw), "utf-8");
  } catch (e) {
    logger.warn("failed to save core-models cache", e);
  }
}

/**
 * Fetch the hosted core-models.json, validate it, persist the raw body, and apply
 * the overrides. On any failure, fall back to the on-disk cache; if that's also
 * missing, leave the store as-is (env fallback). Never throws.
 */
export async function refreshCoreModelOverrides(): Promise<void> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    // Cache-bust: the raw.githubusercontent CDN can serve a stale body for
    // minutes after a commit. A unique query param + no-store defeats it so a
    // `core-models.json` edit is picked up promptly.
    const url = `${REMOTE_URL}${REMOTE_URL.includes("?") ? "&" : "?"}t=${Date.now()}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Atlarix/1.0",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
      },
      cache: "no-store",
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const raw = await res.json();
    const map = parseCoreModelsPayload(raw);
    if (map) {
      await saveToCache(raw);
      applyOverridesAndNotify(raw);
      logger.info(
        `loaded ${Object.keys(map).length} Core model override(s)`,
        map,
      );
      return;
    }
    logger.warn("core-models.json had no usable overrides — keeping env fallback");
  } catch (e) {
    logger.warn("core-models fetch failed, trying cache", e);
    const cachedRaw = await loadRawFromCache();
    if (cachedRaw && parseCoreModelsPayload(cachedRaw)) {
      applyOverridesAndNotify(cachedRaw);
      logger.info("applied cached Core override(s)");
    }
  }
}

/**
 * Boot hook: synchronously preload the last-known-good overrides from the disk
 * cache (so the very first stream after launch sees them), then refresh from the
 * network in the background and start an hourly refresh. Safe before
 * `warmTierContextCache` in main `onReady`.
 */
export function warmCoreModelOverrides(): void {
  try {
    const raw = JSON.parse(readFileSync(getCachePath(), "utf-8"));
    if (parseCoreModelsPayload(raw)) applyOverridesAndNotify(raw);
  } catch {
    // no cache yet — env fallback until the network refresh below completes
  }
  void refreshCoreModelOverrides();
  if (!refreshTimer) {
    refreshTimer = setInterval(() => {
      void refreshCoreModelOverrides();
    }, REFRESH_INTERVAL_MS);
    refreshTimer.unref();
  }
}
