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

type Billing = "free" | "paid";

/** Paid/free per ACCOUNT (Supabase user id), remembered across launches. */
let byAccount: Record<string, Billing> = {};
let loaded = false;
/** Tests: bypass the session lookup. */
let accountOverride: string | null | undefined;

/**
 * REMEMBERED PER ACCOUNT, ACROSS LAUNCHES. Per chat was the original bug — a
 * chat's first turn guessed "free" (400K) and kept it, so a paying account's
 * ring read 3% where GLM-5.3 showed 1% (seen 2026-09-23). Per install would
 * carry "paid" over to a free account after switching. Per account is right from
 * the first message either way. A tiny file, written only when an answer changes.
 */
function billingFile(): string | null {
  // Only inside the real app: outside Electron the path helper falls back to a
  // repo-local ./userData, and a test run must not write files there.
  if (!process.versions.electron) return null;
  try {
    return path.join(getUserDataPath(), "atlarix-auto-billing.json");
  } catch {
    return null;
  }
}

function loadOnce(): void {
  if (loaded) return;
  loaded = true;
  const file = billingFile();
  if (!file) return;
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf-8")) as { byAccount?: unknown };
    if (v.byAccount && typeof v.byAccount === "object") {
      for (const [id, b] of Object.entries(v.byAccount as Record<string, unknown>)) {
        if (b === "free" || b === "paid") byAccount[id] = b;
      }
    }
  } catch {
    /* no file yet — unknown, the free window applies */
  }
}

async function currentAccount(): Promise<string | null> {
  if (accountOverride !== undefined) return accountOverride;
  try {
    const { getSession } = await import("@/lib/auth/supabase-client");
    return (await getSession())?.user?.id ?? null;
  } catch {
    return null;
  }
}

/** Called with each Auto reply's `X-Atlarix-Billing`. */
export async function noteAutoBilling(billing: Billing | null): Promise<void> {
  loadOnce();
  if (!billing) return;
  const account = await currentAccount();
  if (!account || byAccount[account] === billing) return;
  byAccount[account] = billing;
  const file = billingFile();
  if (!file) return;
  try {
    fs.writeFileSync(file, JSON.stringify({ byAccount }));
  } catch {
    /* best effort — the next reply sets it again */
  }
}

/** Test-only: switch the signed-in account without forgetting the others. */
export function __setAccountForTests(account: string | null): void {
  accountOverride = account;
}

/** Test-only. */
export function __resetAutoBilling(account: string | null = "test-account"): void {
  byAccount = {};
  loaded = true;
  accountOverride = account;
}

export async function autoContextWindow(): Promise<number | null> {
  loadOnce();
  const auto = getCoreAuto();
  const account = await currentAccount();
  const billing = account ? byAccount[account] : undefined;
  const models =
    billing === "paid" ? auto?.paidModels : (auto?.freeModels ?? auto?.paidModels);
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
