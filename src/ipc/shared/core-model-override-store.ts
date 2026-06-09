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

/** Test-only: clear the store between cases. */
export function __resetCoreModelOverridesForTests(): void {
  CORE_MODEL_OVERRIDES = null;
}
