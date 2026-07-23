import type { LanguageModel } from "@/ipc/ipc_types";

/**
 * THE CATALOG-AS-FLOOR INVARIANT.
 *
 * The models.dev catalog is the base list for every cloud provider; a provider's
 * own `/models` response is a best-effort OVERLAY that may only ADD models or
 * REFINE fields — never remove.
 *
 * This exists because the previous shape (native wins; catalog consulted only if
 * native *threw*) shipped the same bug four times. Anthropic's `/models`
 * paginates at 20, Google's at 50, Cohere's at 20 — each returned a truncated
 * list at HTTP 200, so nothing threw, the fallback never fired, and the picker
 * silently lost models while the correct answer sat in memory. Bedrock listed
 * zero for the mirror reason. Under a union, a truncated or empty native
 * response degrades to "a new model shows up an hour late" instead of "models
 * are invisible" — the failure mode is now the recoverable one.
 *
 * Native still wins per-FIELD, which is where it genuinely knows better: live
 * OpenRouter pricing and `top_provider` ceilings, and a deliberate
 * `supportsToolChoice: false` (Perplexity's Sonar family).
 *
 * Trade-off accepted deliberately: a provider whose `/models` is entitlement-
 * scoped (OpenAI gates some models by org tier) may list a model the key can't
 * call, which then 403s at call time. A visible error beats a silently missing
 * model, and it matches how the ~145 catalog-only providers already behave.
 */
export function mergeByApiName(
  catalog: LanguageModel[],
  native: LanguageModel[],
): LanguageModel[] {
  if (native.length === 0) return catalog;
  if (catalog.length === 0) return native;

  const merged = new Map<string, LanguageModel>();
  for (const m of catalog) merged.set(m.apiName, m);

  for (const n of native) {
    const base = merged.get(n.apiName);
    if (!base) {
      // Native-only id: newer than the hourly catalog. This is the freshness
      // win that justifies keeping native fetchers at all.
      merged.set(n.apiName, n);
      continue;
    }
    // Native's DEFINED fields win; catalog fills whatever native left out.
    // Object spread would let native's `undefined` clobber a real catalog value,
    // so drop undefined keys first.
    const overlay = Object.fromEntries(
      Object.entries(n).filter(([, v]) => v !== undefined),
    ) as Partial<LanguageModel>;
    merged.set(n.apiName, { ...base, ...overlay } as LanguageModel);
  }

  const out = [...merged.values()];
  out.sort((a, b) => {
    const ctxA = a.contextWindow ?? 0;
    const ctxB = b.contextWindow ?? 0;
    if (ctxB !== ctxA) return ctxB - ctxA;
    return (a.displayName ?? "").localeCompare(b.displayName ?? "");
  });
  return out;
}
