/**
 * Free Atlarix Auto's daily limit, held on this side until it lifts.
 *
 * The proxy's 429 `free_usage_limit` says when the free share comes back. Until
 * then the same request is refused every time, so sending it again only adds a
 * refusal to the proxy's log and the user's screen (owner, 2026-10-28: "no retry
 * until reset"). This answers those sends here, with the same 429 the proxy
 * would give, so every surface (app, CLI, and the editors, which run the CLI's
 * agent) shows the same countdown and nothing reaches the network.
 *
 * Process-local on purpose: the app and the CLI each learn the limit from their
 * own first refusal, which costs one request, and never trust a stale time
 * written by another process.
 *
 * Only free Auto is held. Picking another model is never held, and an account
 * that has started paying (Pro or credit) is let through, because paid Auto
 * has no daily limit.
 */

import { resetsAtMs } from "@/shared/billing_copy";

let resetsAt: number | null = null;

/** When free Auto's limit lifts, from a 429 body: `resets_at`, else `retry_after_seconds` from now. */
export function freeAutoResetsAtFromBody(bodyStr: string, now: number = Date.now()): number | null {
  const iso = /"resets_at"\s*:\s*"([^"]+)"/.exec(bodyStr)?.[1];
  const at = resetsAtMs(iso);
  if (at != null) return at;
  const secs = /"retry_after_seconds"\s*:\s*(\d+)/.exec(bodyStr)?.[1];
  return secs ? now + Number(secs) * 1000 : null;
}

/** Record the limit from the proxy's 429 body; ignores anything else. */
export function noteFreeAutoLimit(at: number | null | undefined): void {
  if (typeof at === "number" && Number.isFinite(at) && at > Date.now()) resetsAt = at;
}

/** When the limit lifts (epoch ms), or null when nothing is held. */
export function freeAutoResetsAt(now: number = Date.now()): number | null {
  if (resetsAt != null && resetsAt <= now) resetsAt = null;
  return resetsAt;
}

export function clearFreeAutoLimit(): void {
  resetsAt = null;
}

/** Whether the account pays for Auto right now (Pro or credit), so no free limit applies. */
async function accountPaysNow(): Promise<boolean> {
  try {
    const { SubscriptionManager } = await import("@/lib/SubscriptionManager");
    if (SubscriptionManager.isPro()) return true;
    const { creditBalanceCents } = await import("@/lib/billing/credit-balance");
    return ((await creditBalanceCents()) ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * Wraps one free-Auto request: answers it here while the limit holds (and the
 * account still does not pay), otherwise sends it and learns the limit from a
 * 429. `send` is the real fetch.
 */
export async function throughFreeAutoGate(send: () => Promise<Response>): Promise<Response> {
  const held = freeAutoResetsAt();
  if (held != null) {
    if (!(await accountPaysNow())) return heldFreeAutoResponse(held);
    clearFreeAutoLimit();
  }
  const res = await send();
  if (res.status === 429) {
    const body = await res.clone().text().catch(() => "");
    if (/free_usage_limit/.test(body)) noteFreeAutoLimit(freeAutoResetsAtFromBody(body));
  }
  return res;
}

/**
 * The 429 the proxy would answer while the limit holds, for a fetch that must
 * not go out. Same body shape, so the classifier, the retry rules and every
 * surface treat it exactly as the real one.
 */
export function heldFreeAutoResponse(at: number, now: number = Date.now()): Response {
  const retry = Math.max(1, Math.ceil((at - now) / 1000));
  return new Response(
    JSON.stringify({
      error: "free_usage_limit",
      message: "Today's free Atlarix Auto is used up.",
      resets_at: new Date(at).toISOString(),
      retry_after_seconds: retry,
      held: true,
    }),
    { status: 429, headers: { "Content-Type": "application/json", "Retry-After": String(retry) } },
  );
}
