/**
 * Where a relic goes: hosted at atlarix.dev/r/<id> (paid Atlarix Core), or a
 * local folder in the workspace (your own API keys, or free Atlarix Auto) —
 * owner decision 2026-10-02. Hosting costs us storage and bandwidth, so it
 * comes with paying for Core; everyone else still gets the page, as a file.
 *
 * The `relics` edge function re-checks "paid" on publish; this is the
 * client's honest first guess, so a free user is never sent to a 402.
 */
import { isCoreAutoTier } from "@/ipc/shared/compass_constants";

export type RelicHosting = { hosted: true } | { hosted: false; reason: string };

export interface HostingInputs {
  /** The model this turn runs on. */
  model: { provider: string; name: string } | null | undefined;
  signedIn: boolean;
  isPro: boolean;
  /** Spendable balance in cents, or null when unknown. */
  balanceCents: number | null;
}

/** Pure: the rule itself (src/__tests__/relic-hosting.test.ts). */
export function decideRelicHosting(i: HostingInputs): RelicHosting {
  if (!i.model || i.model.provider !== "compass") {
    return { hosted: false, reason: "this turn runs on your own API key" };
  }
  if (isCoreAutoTier(i.model.name)) {
    return { hosted: false, reason: "this turn runs on Atlarix Auto" };
  }
  if (!i.signedIn) return { hosted: false, reason: "you are signed out" };
  if (i.isPro || (i.balanceCents ?? 0) > 0) return { hosted: true };
  return { hosted: false, reason: "your Atlarix account has no Pro plan or credit" };
}

/** The rule applied to this chat's turn. */
export async function relicHostingForChat(chatId: number | undefined): Promise<RelicHosting> {
  const { lastStreamRequest } = await import("@/ipc/handlers/chat_stream/stream-state");
  const { readSettings } = await import("@/main/settings");
  const req = chatId != null ? lastStreamRequest.get(chatId) : undefined;
  const model =
    (req as { modelOverride?: { provider: string; name: string } } | undefined)?.modelOverride ??
    (readSettings() as { selectedModel?: { provider: string; name: string } }).selectedModel;
  const { getSession, getSupabaseClient } = await import("@/lib/auth/supabase-client");
  const session = await getSession().catch(() => null);
  let isPro = false;
  let balanceCents: number | null = null;
  if (session) {
    const { SubscriptionManager } = await import("@/lib/SubscriptionManager");
    isPro = SubscriptionManager.isPro();
    if (!isPro) {
      const { data } = await getSupabaseClient().rpc("get_credit_balance");
      const cents = (data as { balance_cents?: number } | null)?.balance_cents;
      balanceCents = typeof cents === "number" ? cents : null;
    }
  }
  return decideRelicHosting({ model, signedIn: Boolean(session), isPro, balanceCents });
}
