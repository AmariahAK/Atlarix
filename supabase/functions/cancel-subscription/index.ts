import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getAuthedUser, json, corsHeaders } from "../_shared/auth.ts";

// Cancels the CALLER'S own LemonSqueezy subscription server-side (A2). The API
// key stays here; the subscription id is looked up from the DB by the verified
// user id, so a caller can only ever cancel their own subscription.
//
// ONE SUBSCRIPTION, so the id comes unconditionally from `users.lemon_subscription_id`.
//
// Worth knowing why that is safe again: between 2026-08-26 and 2026-09-08 there were two
// products, and a Reviewer subscription's id lived in `reviewer_subscriptions` rather than
// on `users`. Reading `users` unconditionally in that window would have cancelled a
// customer's PRO subscription when they asked to cancel Reviewer — silently, with a
// success response. That hazard is gone with the second product, not merely mitigated.
//
// A `product` field from an older client is ignored rather than rejected: there is nothing
// left to disambiguate, and refusing the call would stop an un-updated app cancelling.

function envTrim(key: string): string | undefined {
  const v = Deno.env.get(key);
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS")
    return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const user = await getAuthedUser(req);
  if (!user) return json({ error: "unauthorized" }, 401);

  const apiKey = envTrim("LEMONSQUEEZY_API_KEY");
  if (!apiKey) return json({ error: "billing_not_configured" }, 500);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey);

  // Keyed on the VERIFIED user id, so it cannot reach another account's subscription.
  const { data: userRow } = await admin
    .from("users")
    .select("lemon_subscription_id")
    .eq("id", user.id)
    .maybeSingle();
  const subscriptionId: string | null = userRow?.lemon_subscription_id ?? null;

  if (!subscriptionId) return json({ error: "no_active_subscription" }, 404);

  // A COMPED SUBSCRIPTION HAS NOTHING TO CANCEL AT LEMONSQUEEZY. Entitlements
  // granted by hand carry a non-numeric id (e.g. "comp:owner"); sending that to
  // the API would 404 and surface as `cancel_failed`, which reads like an outage
  // rather than "there is no payment to stop". Say what is actually true.
  if (!/^\d+$/.test(subscriptionId)) {
    return json({ error: "not_billed_by_lemonsqueezy" }, 409);
  }

  try {
    const response = await fetch(
      `https://api.lemonsqueezy.com/v1/subscriptions/${subscriptionId}`,
      {
        method: "DELETE",
        headers: {
          Accept: "application/vnd.api+json",
          "Content-Type": "application/vnd.api+json",
          Authorization: `Bearer ${apiKey}`,
        },
      },
    );

    if (!response.ok) {
      console.error(
        `[cancel-subscription] LemonSqueezy error ${response.status}: ${await response.text()}`,
      );
      return json({ error: "cancel_failed" }, 502);
    }
    // The subscription_cancelled/updated webhook reconciles the entitlement and the
    // period end on `users`. Deliberately not written here: two writers for one fact is
    // how they come to disagree.
    const result = await response.json().catch(() => null);
    const endsAt = result?.data?.attributes?.ends_at ?? null;
    return json({ success: true, product: "pro", endsAt });
  } catch (e) {
    console.error("[cancel-subscription] exception:", e);
    return json({ error: "cancel_failed" }, 502);
  }
});
