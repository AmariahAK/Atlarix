/**
 * OpenRouter model catalog cache (24h) for context-budget sizing.
 * No hardcoded model windows: real per-model limits come from the live
 * OpenRouter response and are read via `getCachedOpenRouterModelRow`. Also backs
 * reasoning-capability lookups (same refresh).
 */

import { OPENROUTER_APP_HEADERS } from "@/ipc/shared/openrouter_app_headers";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface OpenRouterModelRowExtended {
  id: string;
  context_length?: number;
  /** Present on some OpenRouter API responses; shape may vary. */
  supported_parameters?: unknown;
  architecture?: { modality?: string; tokenizer?: string };
  top_provider?: { name?: string; context_length?: number };
}

interface OpenRouterModelsResponse {
  data?: OpenRouterModelRowExtended[];
}

let cacheTimestamp = 0;
/** Populated on last successful models fetch; keyed by OpenRouter model id (e.g. anthropic/claude-3.5-sonnet). */
let openRouterModelsById: Map<string, OpenRouterModelRowExtended> | null = null;

function rebuildModelIndex(data: OpenRouterModelRowExtended[]): void {
  const m = new Map<string, OpenRouterModelRowExtended>();
  for (const row of data) {
    if (row?.id && typeof row.id === "string") {
      m.set(row.id, row);
    }
  }
  openRouterModelsById = m;
}

/** Sync lookup from the last successful OpenRouter models fetch (24h cache). */
export function getCachedOpenRouterModelRow(
  modelId: string,
): OpenRouterModelRowExtended | undefined {
  if (!modelId.trim() || !openRouterModelsById) return undefined;
  return openRouterModelsById.get(modelId.trim());
}

/**
 * Ensure the OpenRouter model catalog is loaded (24h TTL) so per-model context
 * windows and reasoning capability resolve via `getCachedOpenRouterModelRow`.
 * Fetches the full catalog regardless of which model is in use; never throws —
 * on failure the stale/empty index stands and callers fall back to heuristics.
 */
export async function warmOpenRouterModelCache(): Promise<void> {
  if (openRouterModelsById && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return;
  }
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models", {
      headers: {
        ...OPENROUTER_APP_HEADERS,
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) return;
    const json = (await res.json()) as OpenRouterModelsResponse;
    const data = Array.isArray(json.data) ? json.data : [];
    rebuildModelIndex(data);
    cacheTimestamp = Date.now();
  } catch {
    // Keep whatever index we have; resolveModelContextLimit falls back to heuristics.
  }
}
