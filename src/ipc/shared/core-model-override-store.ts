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
 *
 * IMPORT THIS BY ITS `@/ipc/shared/...` ALIAS, ALWAYS. It holds module-level mutable
 * state, and a module reached by two different specifiers can be bundled TWICE — at
 * which point `setCoreModelRouting` writes one copy while `getCoreTierRouting` reads
 * the other, and every Core tier silently resolves to nothing. That exact
 * alias-vs-relative split duplicated a singleton once before (v14.13.2), and the two
 * importers here were on opposite styles until 2026-08-24: `compass_constants.ts`
 * reached it relatively, `core-model-overrides.ts` by alias.
 *
 * MAIN-PROCESS STATE. Only main ever writes it, so a renderer reading it gets an
 * empty map for every tier — which is how the Deep-thinking toggle came to be hidden
 * for the whole Core lineup. Resolve Core capability in main and ship the answer.
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

/**
 * Per-tier direct-provider routing from the same hosted `core-models.json`.
 *
 * `apiModelId` is the vendor's OWN model id, carried explicitly rather than derived
 * by splitting the wire id — the two differ in case (`minimax/minimax-m3` vs the
 * catalog's `MiniMax-M3`), and models.dev lookups are case-sensitive, so deriving it
 * would silently lose that model's price and context window.
 *
 * Absent → the tier has no direct routing and resolves through OpenRouter, which is
 * both the pre-migration shape and the per-tier rollback lever.
 */
export type CoreTierRouting = { provider: string; apiModelId: string };

let CORE_MODEL_ROUTING: Record<string, CoreTierRouting> | null = null;

/** Replace the active override map (validated, normalized `core-N` keys) or clear it. */
export function setCoreModelOverrides(
  map: Record<string, string> | null,
): void {
  CORE_MODEL_OVERRIDES = map && Object.keys(map).length > 0 ? { ...map } : null;
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

/** Replace the per-tier routing map (normalized `core-N` keys) or clear it. */
export function setCoreModelRouting(
  map: Record<string, CoreTierRouting> | null,
): void {
  CORE_MODEL_ROUTING = map && Object.keys(map).length > 0 ? { ...map } : null;
}

/**
 * Direct-provider routing for an already-normalized `core-N` tier, or undefined.
 *
 * Callers use this to reach models.dev for the tier's real context window, price and
 * capabilities — Core used to resolve those through the OpenRouter catalog, which
 * knows nothing about a vendor-native model id.
 */
export function getCoreTierRouting(
  normalizedTierId: string,
): CoreTierRouting | undefined {
  return CORE_MODEL_ROUTING?.[normalizedTierId];
}

/**
 * Atlarix Auto, from the hosted `auto` block: the wire id the proxy expects and
 * the name to show. Null when the lineup does not offer it — then no Auto row
 * appears and a saved Auto selection ERRORS ("isn't offered right now") rather
 * than falling forward: every other slot is paid, and moving someone who chose
 * Auto onto one is a charge they never agreed to (resolveConfiguredCoreTier).
 */
export type CoreAutoConfig = {
  id: string;
  label: string;
  /**
   * models.dev coordinates of the chain's FIRST rung — the model that answers
   * while the free share lasts. Used for capability detection (reasoning,
   * vision, audio); without it Auto read as "no reasoning" and never asked for
   * thoughts. Absent when the block names no usable first rung.
   */
  capability?: { providerId: string; modelId: string };
  /**
   * Every model a FREE Auto step can land on before the $0 floor, and every model
   * a PAID step can land on — models.dev coordinates. Auto's context window is the
   * smallest real window among the set that applies to the account, so the ring
   * and compaction never assume room one of those models does not have.
   */
  freeModels?: Array<{ providerId: string; modelId: string }>;
  paidModels?: Array<{ providerId: string; modelId: string }>;
};

let CORE_AUTO: CoreAutoConfig | null = null;

export function setCoreAuto(auto: CoreAutoConfig | null): void {
  CORE_AUTO = auto ? { ...auto } : null;
}

export function getCoreAuto(): CoreAutoConfig | null {
  return CORE_AUTO;
}

/** Test-only: clear the store between cases. */
export function __resetCoreModelOverridesForTests(): void {
  CORE_MODEL_OVERRIDES = null;
  CORE_MODEL_WEB_SEARCH = null;
  CORE_MODEL_ROUTING = null;
  CORE_AUTO = null;
}
