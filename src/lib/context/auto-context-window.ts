/**
 * Atlarix Auto's context window — the smallest REAL window among the models that
 * could answer this account's next step.
 *
 * Auto has no single model, so borrowing one model's window is wrong in one
 * direction or the other: free Auto's first model (GPT-5.4-mini) has 400K, while
 * every paid Auto model has ~1M. Using 400K for a paying account made its ring
 * read 2.5x fuller than the same chat on GLM-5.3 and compacted it far too early
 * (reported 2026-09-23).
 *
 * Paid or free comes from the proxy itself: every Auto reply carries
 * `X-Atlarix-Billing`, recorded by `auto-status.ts`. Before the first reply of a
 * session it is unknown, and the FREE set applies — the smaller, safe window.
 */
import { getCoreAuto } from "@/ipc/shared/core-model-override-store";

let lastBilling: "free" | "paid" | null = null;

/** Called with each Auto reply's `X-Atlarix-Billing`. */
export function noteAutoBilling(billing: "free" | "paid" | null): void {
  if (billing) lastBilling = billing;
}

/** Test-only. */
export function __resetAutoBilling(): void {
  lastBilling = null;
}

export async function autoContextWindow(): Promise<number | null> {
  const auto = getCoreAuto();
  const models =
    lastBilling === "paid" ? auto?.paidModels : (auto?.freeModels ?? auto?.paidModels);
  if (!models?.length) return null;
  const { getModelsDevLimits } = await import("@/lib/models_dev");
  let min: number | null = null;
  for (const m of models) {
    const limits = await getModelsDevLimits(m.providerId, m.modelId).catch(() => null);
    const ctx = limits?.context;
    if (typeof ctx === "number" && ctx > 0) min = min == null ? ctx : Math.min(min, ctx);
  }
  return min;
}
