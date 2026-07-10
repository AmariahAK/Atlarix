import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getAuthedUser, json, corsHeaders } from "../_shared/auth.ts";

// Cancels the CALLER'S own LemonSqueezy subscription server-side (A2). The API
// key stays here; the subscription id is looked up from the DB by the verified
// user id, so a caller can only ever cancel their own subscription.

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

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey);

  const { data: row, error } = await admin
    .from("users")
    .select("lemon_subscription_id")
    .eq("id", user.id)
    .maybeSingle();

  if (error || !row?.lemon_subscription_id) {
    return json({ error: "no_active_subscription" }, 404);
  }

  try {
    const response = await fetch(
      `https://api.lemonsqueezy.com/v1/subscriptions/${row.lemon_subscription_id}`,
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
      console.error(`[cancel-subscription] LemonSqueezy error ${response.status}: ${await response.text()}`);
      return json({ error: "cancel_failed" }, 502);
    }
    // The subscription_cancelled/updated webhook will reconcile plan + period end.
    const result = await response.json().catch(() => null);
    const endsAt = result?.data?.attributes?.ends_at ?? null;
    return json({ success: true, endsAt });
  } catch (e) {
    console.error("[cancel-subscription] exception:", e);
    return json({ error: "cancel_failed" }, 502);
  }
});
