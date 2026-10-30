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

import { setHostedReplaySampleRate } from "@/lib/analytics/replay";
import { setConfiguredFallback, setProxyFailoverLog } from "@/shared/proxy-failover";
import * as fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import log from "electron-log";
import { BrowserWindow } from "electron";
import { getUserDataPath } from "@/paths/paths";
import { registerEffortOverrides } from "@/lib/routing/model-reasoning-profile";
import {
  CORE_TIER_ORDER,
  emptySlotAware,
  normalizeCoreTierId,
} from "@/ipc/shared/compass_constants";
import {
  setCoreAuto,
  setCoreZenith,
  setCoreModelOverrides,
  setCoreModelWebSearch,
  setCoreModelRouting,
  type CoreAutoConfig,
  type CoreTierRouting,
  type CoreZenithConfig,
} from "@/ipc/shared/core-model-override-store";

const logger = log.scope("core-models");
// The proxy's fallback says when it takes over (item 10).
setProxyFailoverLog((line) => log.scope("core-proxy").warn(line));

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
  /**
   * Optional Atlarix Auto block. The client needs only its wire `id` and
   * `label`; the chain and sizing are the proxy's business.
   */
  auto?: unknown;
  /**
   * Optional effort values PROVED per vendor model id where the catalog is
   * wrong (GLM-5.3 rejects `medium`). The proxy fits requests to them; the app
   * offers exactly these in /effort.
   */
  modelEfforts?: unknown;
  /** The Core proxy's fallback (item 10): `{ fallbackUrl: "https://….on.aws" }`. */
  proxy?: unknown;
  /** The app's session replay (item 12): `{ sampleRate: 0.25 }`. */
  replay?: unknown;
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
  const auto = parseCoreAuto(raw);
  setCoreAuto(auto);
  const zenith = parseCoreZenith(raw);
  setCoreZenith(zenith);
  const efforts = parseModelEfforts(raw);
  registerEffortOverrides(efforts);
  // The proxy's fallback (item 10): here first, so it changes without a release.
  setConfiguredFallback((raw as { proxy?: { fallbackUrl?: unknown } } | null)?.proxy?.fallbackUrl ?? null);
  // The app's session replay rate (item 12), read at the next launch.
  setHostedReplaySampleRate((raw as { replay?: { sampleRate?: unknown } } | null)?.replay?.sampleRate);
  // Auto and the effort lists are part of what the picker shows, so a change to
  // either must reach the renderer like a lineup change does.
  const serialized = map
    ? JSON.stringify([
        Object.entries(map).sort(([a], [b]) => a.localeCompare(b)),
        auto,
        zenith,
        efforts,
      ])
    : null;
  if (serialized !== lastAppliedSerialized) {
    lastAppliedSerialized = serialized;
    broadcastCoreModelsChanged();
  }
}

/** `modelEfforts`: vendor model id → its effort values, as listed. Bad rows are dropped. */
export function parseModelEfforts(raw: unknown): Record<string, string[]> {
  const block = raw && typeof raw === "object" ? (raw as CoreModelsPayload).modelEfforts : undefined;
  const out: Record<string, string[]> = {};
  if (!block || typeof block !== "object") return out;
  for (const [id, values] of Object.entries(block as Record<string, unknown>)) {
    if (!Array.isArray(values)) continue;
    const list = values.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim());
    if (list.length) out[id] = list;
  }
  return out;
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

/** The Atlarix Auto block's wire id and label, or null when not offered. */
export function parseCoreAuto(raw: unknown): CoreAutoConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const auto = (raw as CoreModelsPayload).auto;
  if (!auto || typeof auto !== "object") return null;
  const a = auto as Record<string, unknown>;
  const id = typeof a.id === "string" ? a.id.trim() : "";
  if (!id) return null;
  const label =
    typeof a.label === "string" && a.label.trim()
      ? a.label.trim()
      : "Atlarix Auto";
  const first = Array.isArray(a.chain) ? a.chain[0] : null;
  const provider =
    first && typeof first === "object"
      ? String((first as Record<string, unknown>).provider ?? "")
      : "";
  const modelId =
    first && typeof first === "object"
      ? String((first as Record<string, unknown>).apiModelId ?? "")
      : "";
  // `openai-shared` is the same vendor behind a different key.
  const providerId = provider.replace(/-shared$/, "");
  const ref = (r: unknown) => {
    if (!r || typeof r !== "object") return null;
    const o = r as Record<string, unknown>;
    const p = typeof o.provider === "string" ? o.provider.replace(/-shared$/, "") : "";
    const m = typeof o.apiModelId === "string" ? o.apiModelId : "";
    return p && m ? { providerId: p, modelId: m } : null;
  };
  // The $0 floor is left out on purpose: the proxy skips it for a request too
  // big for its window, so it must not shrink everyone's window.
  const freeModels = (Array.isArray(a.chain) ? a.chain : [])
    .filter((r) => !(r && typeof r === "object" && (r as Record<string, unknown>).pool === "floor"))
    .map(ref)
    .filter((x): x is { providerId: string; modelId: string } => x !== null);
  const paid = a.paid && typeof a.paid === "object" ? (a.paid as Record<string, unknown>) : null;
  const levels = paid?.levels && typeof paid.levels === "object" ? Object.values(paid.levels as Record<string, unknown>) : [];
  const paidModels = levels
    .flatMap((l) => (Array.isArray(l) ? l : []))
    .map(ref)
    .filter((x): x is { providerId: string; modelId: string } => x !== null);
  const zenith = a.zenith && typeof a.zenith === "object" ? (a.zenith as Record<string, unknown>) : null;
  const zenithLevels =
    zenith?.levels && typeof zenith.levels === "object" ? Object.values(zenith.levels as Record<string, unknown>) : [];
  const rungId = (r: unknown) => {
    if (!r || typeof r !== "object") return null;
    const o = r as Record<string, unknown>;
    if (o.pinServed === true || o.discover === true) return null;
    const m = typeof o.apiModelId === "string" ? o.apiModelId.trim() : "";
    // A versioned cloud id ("us.anthropic.…-v1:0") is a route, not a name.
    return m && !m.includes(":") ? m : null;
  };
  const slots = Object.values(parseCoreRouting(raw) ?? {}).map((r) => rungId(r));
  const nameableModels = [
    ...new Set(
      [
        ...(Array.isArray(a.chain) ? a.chain : []).map(rungId),
        ...[...levels, ...zenithLevels].flatMap((l) => (Array.isArray(l) ? l : [])).map(rungId),
        ...slots,
      ].filter((x): x is string => !!x),
    ),
  ];
  return {
    id,
    label,
    ...(providerId && modelId ? { capability: { providerId, modelId } } : {}),
    ...(freeModels.length ? { freeModels } : {}),
    ...(paidModels.length ? { paidModels } : {}),
    ...(nameableModels.length ? { nameableModels } : {}),
  };
}

/**
 * Atlarix Zenith (`auto.zenith`): paid Auto on the top lane. Its levels have the
 * same shape as `auto.paid`; the client needs the wire id, the name, and the
 * models a step can land on (for the context window).
 */
export function parseCoreZenith(raw: unknown): CoreZenithConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const auto = (raw as CoreModelsPayload).auto as Record<string, unknown> | undefined;
  const z = auto && typeof auto === "object" ? auto.zenith : null;
  if (!z || typeof z !== "object") return null;
  const o = z as Record<string, unknown>;
  const id = typeof o.id === "string" && o.id.trim() ? o.id.trim() : "atlarix/zenith";
  const label = typeof o.label === "string" && o.label.trim() ? o.label.trim() : "Atlarix Zenith";
  const levels = o.levels && typeof o.levels === "object" ? Object.values(o.levels as Record<string, unknown>) : [];
  const models = levels
    .flatMap((l) => (Array.isArray(l) ? l : []))
    .map((r) => {
      if (!r || typeof r !== "object") return null;
      const e = r as Record<string, unknown>;
      const p = typeof e.provider === "string" ? e.provider.replace(/-shared$/, "") : "";
      const m = typeof e.apiModelId === "string" ? e.apiModelId : "";
      return p && m ? { providerId: p, modelId: m } : null;
    })
    .filter((x): x is { providerId: string; modelId: string } => x !== null);
  return { id, label, ...(models.length ? { models } : {}) };
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
/**
 * One fetch attempt. Separated so the retry above it stays readable.
 *
 * Cache-bust: the raw.githubusercontent CDN can serve a stale body for minutes after
 * a commit. A unique query param + no-store defeats it so a `core-models.json` edit
 * is picked up promptly. (Measured 2026-09-09: the buster is NOT what makes the
 * origin 503 — 10/10 succeeded with it against 9/10 without.)
 */
async function fetchCoreModelsOnce(): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
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
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * How many times to try before falling back to the cache.
 *
 * WHY A RETRY EXISTS AT ALL. `raw.githubusercontent.com` returns intermittent
 * `503 Backend.max_conn reached` — measured at roughly 1 in 10 requests on
 * 2026-09-09, and it hit this app four times in one day (09:32, 10:14, 13:27, 13:45).
 * A single attempt therefore meant that on about one launch in ten the lineup silently
 * came from a cache up to an hour stale, which is precisely how a shipped
 * `core-models.json` change appeared not to have shipped: the app showed the PREVIOUS
 * tier-3 model and nothing said why.
 *
 * Three attempts takes that from ~10% to ~0.1%. Deliberately small and short: this
 * runs at startup, the cache fallback below is a correct answer rather than a failure,
 * and the hourly refresh will try again regardless.
 */
const FETCH_ATTEMPTS = 3;
const RETRY_DELAY_MS = 400;

export async function refreshCoreModelOverrides(): Promise<void> {
  try {
    let raw: unknown;
    let lastError: unknown;
    for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
      try {
        raw = await fetchCoreModelsOnce();
        lastError = undefined;
        break;
      } catch (e) {
        lastError = e;
        // Do not sleep after the final attempt — nobody is waiting on it.
        if (attempt < FETCH_ATTEMPTS) {
          logger.warn(
            `core-models fetch attempt ${attempt}/${FETCH_ATTEMPTS} failed, retrying`,
            e,
          );
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt));
        }
      }
    }
    if (lastError) throw lastError;

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
    logger.warn(
      "core-models.json had no usable overrides — keeping env fallback",
    );
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
