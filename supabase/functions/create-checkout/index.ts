import { getAuthedUser, json, corsHeaders } from "../_shared/auth.ts";

// Creates a LemonSqueezy checkout SERVER-SIDE (A2). The LEMONSQUEEZY_API_KEY
// lives only here, never in the client bundle. Critically, the checkout's
// custom_data.supabase_user_id is set from the VERIFIED JWT — so the webhook can
// trust it to resolve the account to entitle (this is the server half of SB-07).
//
// Two modes:
//   subscription (default) -> Atlarix Pro monthly (LEMONSQUEEZY_PRO_VARIANT_ID).
//   credit                 -> PAYG top-up: the single "Atlarix Core Credit" product
//                             (LEMONSQUEEZY_CREDIT_VARIANT_ID) with a per-checkout
//                             custom_price = the app-chosen amount (>= $10). One
//                             product covers every top-up amount.

const DEFAULT_STORE_ID = "236920";
const MIN_TOPUP_CENTS = 1000; // $10 minimum top-up

function envTrim(key: string): string | undefined {
  const v = Deno.env.get(key);
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function proVariantId(): string | null {
  return envTrim("LEMONSQUEEZY_PRO_VARIANT_ID") ?? envTrim("LEMONSQUEEZY_VARIANT_ID") ?? null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const user = await getAuthedUser(req);
  if (!user) return json({ error: "unauthorized" }, 401);
  if (!user.email) return json({ error: "no_email_on_account" }, 400);

  let mode = "subscription";
  let amountCents = 0;
  try {
    const body = await req.json();
    if (body?.mode === "credit") mode = "credit";
    if (typeof body?.amount_cents === "number") amountCents = Math.floor(body.amount_cents);
  } catch {
    // default to subscription
  }

  const apiKey = envTrim("LEMONSQUEEZY_API_KEY");
  if (!apiKey) return json({ error: "billing_not_configured" }, 500);
  const storeId = envTrim("LEMONSQUEEZY_STORE_ID") ?? DEFAULT_STORE_ID;

  const attributes: Record<string, unknown> = {
    checkout_data: {
      email: user.email,
      custom: {
        // TRUSTED — from the verified JWT, not the client body.
        supabase_user_id: user.id,
        source: "atlarix-app",
        kind: mode,
      },
    },
  };

  let variantId: string | null;
  if (mode === "credit") {
    variantId = envTrim("LEMONSQUEEZY_CREDIT_VARIANT_ID") ?? null;
    if (!variantId) return json({ error: "checkout_not_configured_for_credit" }, 500);
    if (!Number.isFinite(amountCents) || amountCents < MIN_TOPUP_CENTS) {
      return json({ error: "amount_below_minimum", min_cents: MIN_TOPUP_CENTS }, 400);
    }
    // Per-checkout price override — one credit product, app-chosen amount.
    attributes.custom_price = amountCents;
  } else {
    variantId = proVariantId();
    if (!variantId) return json({ error: "checkout_not_configured_for_pro" }, 500);
  }

  const checkoutData = {
    data: {
      type: "checkouts",
      attributes,
      relationships: {
        store: { data: { type: "stores", id: storeId } },
        variant: { data: { type: "variants", id: variantId } },
      },
    },
  };

  try {
    const response = await fetch("https://api.lemonsqueezy.com/v1/checkouts", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/vnd.api+json",
        "Content-Type": "application/vnd.api+json",
      },
      body: JSON.stringify(checkoutData),
    });

    if (response.status === 201) {
      const data = await response.json();
      const url = data?.data?.attributes?.url;
      if (url) return json({ url });
    }
    console.error(`[create-checkout] LemonSqueezy error ${response.status}: ${await response.text()}`);
    return json({ error: "checkout_failed" }, 502);
  } catch (e) {
    console.error("[create-checkout] exception:", e);
    return json({ error: "checkout_failed" }, 502);
  }
});
