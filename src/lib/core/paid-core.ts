/**
 * Paid Atlarix Core: whether this turn is paid for by an Atlarix account, and a
 * request to the Core proxy as that account.
 *
 * Paid search and transcription (owner, 2026-10-06) run on our keys through
 * the proxy and are billed to the account's balance with the usual markup. They are offered when the turn itself runs on an Atlarix model (Auto
 * or a Core tier) AND the account can pay: Pro, credit, or a cloud run's
 * job-scoped token (the proxy bills that job). Your own key, local models and
 * free Auto keep today's paths — free Auto's allowance covers tokens, not the
 * per-call price of a search.
 *
 * The proxy re-checks everything; this is the client's first guess, so a turn
 * that cannot pay is never sent to a 402.
 */
import {
  ATLARIX_SURFACE,
  getCoreProxyBaseUrl,
  getPinnedCoreToken,
} from "@/ipc/shared/core_proxy";

export interface PaidCoreInputs {
  model: { provider: string; name: string } | null | undefined;
  hasCloudToken: boolean;
  signedIn: boolean;
  isPro: boolean;
  balanceCents: number | null;
}

/** Pure: the rule (src/__tests__/paid-core.test.ts). */
export function decidePaidCore(i: PaidCoreInputs): boolean {
  if (i.hasCloudToken) return true;
  if (!i.model || i.model.provider !== "compass") return false;
  if (!i.signedIn) return false;
  return i.isPro || (i.balanceCents ?? 0) > 0;
}

/** The rule applied to a chat's current turn. */
export async function paidCoreForChat(
  chatId: number | undefined,
): Promise<boolean> {
  if (getPinnedCoreToken()) return true;
  const { lastStreamRequest } = await import(
    "@/ipc/handlers/chat_stream/stream-state"
  );
  const { readSettings } = await import("@/main/settings");
  const req = chatId != null ? lastStreamRequest.get(chatId) : undefined;
  const model =
    (req as { modelOverride?: { provider: string; name: string } } | undefined)
      ?.modelOverride ??
    (readSettings() as { selectedModel?: { provider: string; name: string } })
      .selectedModel;
  if (!model || model.provider !== "compass") return false;
  const { getSession } = await import("@/lib/auth/supabase-client");
  const session = await getSession().catch(() => null);
  if (!session || session.access_token === "atlarix-headless") return false;
  const { SubscriptionManager } = await import("@/lib/SubscriptionManager");
  const isPro = SubscriptionManager.isPro();
  let balanceCents: number | null = null;
  if (!isPro) {
    const { creditBalanceCents } = await import("@/lib/billing/credit-balance");
    balanceCents = await creditBalanceCents();
  }
  return decidePaidCore({
    model,
    hasCloudToken: false,
    signedIn: true,
    isPro,
    balanceCents,
  });
}

/**
 * POST to the Core proxy as this account: a cloud run's pinned token first,
 * else the signed-in session. Null when there is no proxy or no credential —
 * the caller then uses its non-Core path.
 */
export async function coreProxyPost(
  path: string,
  body: { json: unknown } | { form: FormData },
  opts: { signal?: AbortSignal } = {},
): Promise<Response | null> {
  const base = getCoreProxyBaseUrl();
  if (!base) return null;
  let token = getPinnedCoreToken();
  if (!token) {
    const { getSession } = await import("@/lib/auth/supabase-client");
    const session = await getSession().catch(() => null);
    token = session?.access_token ?? null;
  }
  if (!token || token === "atlarix-headless") return null;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "X-Atlarix-Surface": ATLARIX_SURFACE,
  };
  let payload: BodyInit;
  if ("json" in body) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body.json);
  } else {
    payload = body.form;
  }
  return fetch(`${base}${path}`, {
    method: "POST",
    headers,
    body: payload,
    signal: opts.signal,
  });
}
