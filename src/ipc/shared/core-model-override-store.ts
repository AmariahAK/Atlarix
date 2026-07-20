/**
 * Runtime Core-tier → model overrides (pure, renderer-safe).
 *
 * Holds an optional map of `core-N` → OpenRouter model id, fetched at runtime
 * from a hosted JSON (see `src/lib/routing/core-model-overrides.ts`, main only).
 * This module is intentionally free of `fs`/`fetch` so `compass_constants.ts`
 * can read it without pulling Node-only code into the renderer bundle.
 *
 * Default `null` → no override; `getOpenRouterModelIdForCoreTier` falls back to
 * the build-time env (`ATLARIX_CORE_MODEL_1..4`).
 */

let CORE_MODEL_OVERRIDES: Record<string, string> | null = null;

/**
 * Per-tier web-search capability (normalized `core-N` → boolean), from the same
 * hosted `core-models.json`. Absent/`true` → the Core model may use OpenRouter's
 * agentic `web_search` server tool (metered through the wallet); `false` → that
 * tier keeps the client `web_search` (SearxNG → DDG) tool instead. Lets the owner
 * disable the server tool for a model that under-invokes it, without an app release.
 */
let CORE_MODEL_WEB_SEARCH: Record<string, boolean> | null = null;

/** Replace the active override map (validated, normalized `core-N` keys) or clear it. */
export function setCoreModelOverrides(
  map: Record<string, string> | null,
): void {
  CORE_MODEL_OVERRIDES =
    map && Object.keys(map).length > 0 ? { ...map } : null;
}

/** Resolved override for an already-normalized `core-N` tier id, or undefined. */
export function getCoreModelOverrideId(
  normalizedTierId: string,
): string | undefined {
  return CORE_MODEL_OVERRIDES?.[normalizedTierId];
}

/** Replace the per-tier web-search capability map (normalized `core-N` keys) or clear it. */
export function setCoreModelWebSearch(
  map: Record<string, boolean> | null,
): void {
  CORE_MODEL_WEB_SEARCH =
    map && Object.keys(map).length > 0 ? { ...map } : null;
}

/**
 * Whether an already-normalized `core-N` tier may use the OpenRouter web-search
 * server tool. Defaults to TRUE — a tier is only excluded when the catalog
 * explicitly sets it `false`.
 */
export function isCoreModelWebSearchEnabled(normalizedTierId: string): boolean {
  return CORE_MODEL_WEB_SEARCH?.[normalizedTierId] !== false;
}

/** Test-only: clear the store between cases. */
export function __resetCoreModelOverridesForTests(): void {
  CORE_MODEL_OVERRIDES = null;
  CORE_MODEL_WEB_SEARCH = null;
}
