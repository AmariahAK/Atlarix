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
import { getUserDataPath } from "@/paths/paths";
import {
  CORE_TIER_ORDER,
  normalizeCoreTierId,
} from "@/ipc/shared/compass_constants";
import { setCoreModelOverrides } from "@/ipc/shared/core-model-override-store";

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
}

let refreshTimer: ReturnType<typeof setInterval> | null = null;

function getCachePath(): string {
  return path.join(getUserDataPath(), "cache", "core-models.json");
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
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) map[norm] = trimmed;
  }
  return Object.keys(map).length > 0 ? map : null;
}

async function loadFromCache(): Promise<Record<string, string> | null> {
  try {
    const content = await fs.readFile(getCachePath(), "utf-8");
    return parseCoreModelsPayload(JSON.parse(content));
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
    const res = await fetch(REMOTE_URL, {
      headers: { "User-Agent": "Atlarix/1.0" },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const raw = await res.json();
    const map = parseCoreModelsPayload(raw);
    if (map) {
      await saveToCache(raw);
      setCoreModelOverrides(map);
      logger.info(
        `loaded ${Object.keys(map).length} Core model override(s)`,
        map,
      );
      return;
    }
    logger.warn("core-models.json had no usable overrides — keeping env fallback");
  } catch (e) {
    logger.warn("core-models fetch failed, trying cache", e);
    const cached = await loadFromCache();
    if (cached) {
      setCoreModelOverrides(cached);
      logger.info(`applied ${Object.keys(cached).length} cached Core override(s)`);
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
    const map = parseCoreModelsPayload(
      JSON.parse(readFileSync(getCachePath(), "utf-8")),
    );
    if (map) setCoreModelOverrides(map);
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
