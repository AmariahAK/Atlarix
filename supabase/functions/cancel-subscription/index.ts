import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getAuthedUser, json, corsHeaders } from "../_shared/auth.ts";

// Cancels the CALLER'S own LemonSqueezy subscription server-side (A2). The API
// key stays here; the subscription id is looked up from the DB by the verified
// user id, so a caller can only ever cancel their own subscription.
//
// TWO PRODUCTS NOW, AND THAT CHANGED THIS FILE'S CONTRACT. Until 2026-08-26 the
// subscription id came unconditionally from `users.lemon_subscription_id` —
// which only ever holds the PRO one. A Reviewer subscription's id lives in
// `reviewer_subscriptions`, written by a webhook path that never touches
// `users`. So a caller asking to cancel Reviewer would have got either a 404
// (Reviewer-only customer) or, far worse, a CANCELLED PRO SUBSCRIPTION for
// anyone holding both — silently, with a success response.
//
// Hence the explicit `product`. It defaults to "pro" so the desktop app, which
// sends `{}`, keeps working unchanged.

type Product = "pro" | "reviewer";

function envTrim(key: string): string | undefined {
  const v = Deno.env.get(key);
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const user = await getAuthedUser(req);
  if (!user) return json({ error: "unauthorized" }, 401);

  const apiKey = envTrim("LEMONSQUEEZY_API_KEY");
  if (!apiKey) return json({ error: "billing_not_configured" }, 500);

  // Default "pro" on purpose, including for a malformed body: an older client
  // that sends nothing must keep cancelling Pro exactly as it always did.
  let product: Product = "pro";
  try {
    const body = await req.json();
    if (body?.product === "reviewer") product = "reviewer";
  } catch {
    // no body — Pro
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey);

  // Each product's id from ITS OWN table. Both queries are keyed on the verified
  // user id, so neither can reach another account's subscription.
  let subscriptionId: string | null = null;
  if (product === "reviewer") {
    const { data } = await admin
      .from("reviewer_subscriptions")
      .select("lemon_subscription_id, status")
      .eq("user_id", user.id)
      .maybeSingle();
    // Already ended is not an error worth a 502 — it is the state they wanted.
    if (data?.status === "expired") return json({ success: true, endsAt: null });
    subscriptionId = data?.lemon_subscription_id ?? null;
  } else {
    const { data } = await admin
      .from("users")
      .select("lemon_subscription_id")
      .eq("id", user.id)
      .maybeSingle();
    subscriptionId = data?.lemon_subscription_id ?? null;
  }

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
    // The subscription_cancelled/updated webhook reconciles the entitlement and
    // the period end — for Pro on `users`, for Reviewer on
    // `reviewer_subscriptions`. Deliberately not written here: two writers for
    // one fact is how they come to disagree.
    const result = await response.json().catch(() => null);
    const endsAt = result?.data?.attributes?.ends_at ?? null;
    return json({ success: true, product, endsAt });
  } catch (e) {
    console.error("[cancel-subscription] exception:", e);
    return json({ error: "cancel_failed" }, 502);
  }
});
