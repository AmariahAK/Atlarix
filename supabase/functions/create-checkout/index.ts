import { getAuthedUser, json, corsHeaders } from "../_shared/auth.ts";

// Creates a LemonSqueezy checkout SERVER-SIDE (A2). The LEMONSQUEEZY_API_KEY
// lives only here, never in the client bundle. Critically, the checkout's
// custom_data.supabase_user_id is set from the VERIFIED JWT — so the webhook can
// trust it to resolve the account to entitle (this is the server half of SB-07).
//
// Three modes:
//   subscription (default) -> Atlarix Pro monthly (LEMONSQUEEZY_PRO_VARIANT_ID).
//   credit                 -> PAYG top-up: the single "Atlarix Core Credit" product
//                             (LEMONSQUEEZY_CREDIT_VARIANT_ID) with a per-checkout
//                             custom_price = the app-chosen amount (>= $10). One
//                             product covers every top-up amount.
// (A third mode, `reviewer`, existed until 2026-09-08. Atlarix Reviewer no longer has its
//  own subscription — Pro entitles it — so there is nothing separate to buy.)
//
// NOTE for callers: this is a THREE-value enum now, but the parse below still
// defaults anything unrecognised to "subscription". That is deliberate — an older
// client that sends no mode must keep buying Pro — and it is also why a typo in
// `mode` silently sells the wrong product. Send an exact value.

const DEFAULT_STORE_ID = "236920";
const MIN_TOPUP_CENTS = 1000; // $10 minimum top-up

function envTrim(key: string): string | undefined {
  const v = Deno.env.get(key);
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function proVariantId(): string | null {
  return envTrim("LEMONSQUEEZY_PRO_VARIANT_ID") ?? envTrim("LEMONSQUEEZY_VARIANT_ID") ?? null;
}

/** Where a finished checkout should send the buyer back to. */
const DEFAULT_RETURN_ORIGIN = "https://www.atlarix.dev";

/**
 * Post-purchase destination, per mode.
 *
 * WHY THIS IS SET PER CHECKOUT RATHER THAN ON THE VARIANT. Setting
 * `redirect_url` on a LemonSqueezy variant applies it to every purchase of that
 * product and REPLACES the confirmation modal for all of them. Setting it here
 * leaves the variants at `redirect_url: null`, so any other route to a purchase
 * — a direct store link, a future pricing-page button — still gets the modal
 * configured in LemonSqueezy. We only override the checkouts we created and
 * therefore know how to follow up on.
 *
 * Note /reviewer/setup is still the page that binds a GitHub installation to an account —
 * it is simply no longer reached from a checkout, because there is no Reviewer checkout.
 */
function returnUrlFor(mode: string): string {
  const origin = (envTrim("ACCOUNT_RETURN_ORIGIN") ?? DEFAULT_RETURN_ORIGIN).replace(/\/+$/, "");
  if (mode === "credit") return `${origin}/account?purchase=credit`;
  return `${origin}/account?purchase=pro`;
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
    if (body?.mode === "credit") mode = body.mode;
    if (typeof body?.amount_cents === "number") amountCents = Math.floor(body.amount_cents);
  } catch {
    // default to subscription
  }

  const apiKey = envTrim("LEMONSQUEEZY_API_KEY");
  if (!apiKey) return json({ error: "billing_not_configured" }, 500);
  const storeId = envTrim("LEMONSQUEEZY_STORE_ID") ?? DEFAULT_STORE_ID;

  const returnUrl = returnUrlFor(mode);

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
    product_options: {
      // Send the buyer back to us instead of leaving them on LemonSqueezy with
      // no way home. This matters far more in a browser than in the desktop app,
      // where checkout opens in an external tab the app never sees.
      redirect_url: returnUrl,
      // The same destination on the emailed receipt — a second route back for
      // anyone who closed the tab before the redirect landed.
      receipt_button_text: "Go to your account",
      receipt_link_url: returnUrl,
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
    // NOT set for the subscription mode: a subscription's price is the product's
    // price, and overriding it per checkout would let the caller choose what to
    // pay every month.
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
