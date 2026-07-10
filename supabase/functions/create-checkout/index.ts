import { getAuthedUser, json, corsHeaders } from "../_shared/auth.ts";

// Creates a LemonSqueezy checkout SERVER-SIDE (A2). The LEMONSQUEEZY_API_KEY
// lives only here, never in the client bundle. Critically, the checkout's
// custom_data.supabase_user_id is set from the VERIFIED JWT — so the webhook can
// trust it to resolve the account to entitle (this is the server half of SB-07).

const DEFAULT_STORE_ID = "236920";

function envTrim(key: string): string | undefined {
  const v = Deno.env.get(key);
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function resolveVariantId(tier: string): string | null {
  if (tier === "workforce") {
    return envTrim("LEMONSQUEEZY_WORKFORCE_VARIANT_ID") ?? null;
  }
  // pro (default): explicit Pro variant, then legacy variant.
  return envTrim("LEMONSQUEEZY_PRO_VARIANT_ID") ?? envTrim("LEMONSQUEEZY_VARIANT_ID") ?? null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const user = await getAuthedUser(req);
  if (!user) return json({ error: "unauthorized" }, 401);
  if (!user.email) return json({ error: "no_email_on_account" }, 400);

  let tier = "pro";
  try {
    const body = await req.json();
    if (body?.tier === "workforce" || body?.tier === "pro") tier = body.tier;
  } catch {
    // default to pro
  }

  const apiKey = envTrim("LEMONSQUEEZY_API_KEY");
  if (!apiKey) return json({ error: "billing_not_configured" }, 500);

  const variantId = resolveVariantId(tier);
  if (!variantId) return json({ error: `checkout_not_configured_for_${tier}` }, 500);

  const storeId = envTrim("LEMONSQUEEZY_STORE_ID") ?? DEFAULT_STORE_ID;

  const checkoutData = {
    data: {
      type: "checkouts",
      attributes: {
        checkout_data: {
          email: user.email,
          custom: {
            // TRUSTED — from the verified JWT, not the client body.
            supabase_user_id: user.id,
            source: "atlarix-app",
            tier,
          },
        },
      },
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
