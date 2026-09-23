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
import fs from "node:fs";
import path from "node:path";
import { getCoreAuto } from "@/ipc/shared/core-model-override-store";
import { getUserDataPath } from "@/paths/paths";

let lastBilling: "free" | "paid" | null = null;
let loaded = false;

/**
 * REMEMBERED ACROSS LAUNCHES. Without it the first Auto message after every app
 * start assumed free (400K) — and that turn's window is what the chat keeps —
 * so a paying account's ring read 3% on a chat GLM-5.3 showed at 1% (seen live
 * 2026-09-23). A tiny file, written only when the answer changes.
 */
function billingFile(): string | null {
  // Only inside the real app: outside Electron the path helper falls back to a
  // repo-local ./userData, and a test run must not write files there.
  if (!process.versions.electron) return null;
  try {
    return path.join(getUserDataPath(), "atlarix-auto-billing.json");
  } catch {
    return null; // no Electron app (tests)
  }
}

function loadOnce(): void {
  if (loaded) return;
  loaded = true;
  const file = billingFile();
  if (!file) return;
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf-8")) as { billing?: unknown };
    if (v.billing === "free" || v.billing === "paid") lastBilling = v.billing;
  } catch {
    /* no file yet — unknown, the free window applies */
  }
}

/** Called with each Auto reply's `X-Atlarix-Billing`. */
export function noteAutoBilling(billing: "free" | "paid" | null): void {
  loadOnce();
  if (!billing || billing === lastBilling) return;
  lastBilling = billing;
  const file = billingFile();
  if (!file) return;
  try {
    fs.writeFileSync(file, JSON.stringify({ billing }));
  } catch {
    /* best effort — the next reply sets it again */
  }
}

/** Test-only. */
export function __resetAutoBilling(): void {
  lastBilling = null;
  loaded = true;
}

export async function autoContextWindow(): Promise<number | null> {
  loadOnce();
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
