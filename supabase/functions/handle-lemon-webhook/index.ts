import {
  createClient,
  type SupabaseClient,
} from "https://esm.sh/@supabase/supabase-js@2";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  creditClawbackCents,
  grantClawbackCents,
  incrementalClawbackCents,
  invoiceIds,
  refundFraction,
} from "../_shared/refund-math.ts";

/**
 * LemonSqueezy Webhook Handler
 * ============================
 * Responsibilities:
 *   1. subscription_* events -> entitlement on public.users, plus the monthly
 *      Core allowance in public.credit_grants.
 *   2. order_created / order_refunded for the "Atlarix Core Credit" product ->
 *      credit / claw back the PAYG wallet (public.credit_wallet).
 *   3. subscription_payment_refunded -> drop the entitlement immediately and
 *      claw back that period's allowance, proportionally on a partial refund.
 *
 * ONE SUBSCRIPTION (2026-09-08). Atlarix Pro entitles the account to the desktop app,
 * Atlarix Reviewer and the Chrome extension over a single allowance. There used to be a
 * second Reviewer subscription written to its own table and classified by variant id on
 * this same endpoint; it is gone, along with the classification. Reviewer now gates on
 * wallet balance, so there is nothing product-specific left to write.
 *
 * REFUNDS ARE TWO DIFFERENT OPERATIONS SHARING A WORD. A credit top-up refund
 * returns money the customer spent ON CREDIT, so the clawback is the credit
 * itself and it may drive the wallet negative. A subscription refund returns a
 * FEE — which bought entitlement plus an allowance, not $19 of credit — so it
 * claws back the GRANT, floored at zero, and never touches purchased credit.
 * Getting that backwards would either let buy-burn-refund run free or take money
 * the customer actually paid for.
 *
 * ENTITLEMENT AND ALLOWANCE ARE TWO WRITES, and both are needed. The
 * subscription row says a customer MAY be served; the allowance is what PAYS for
 * the inference. Writing only the first is how a subscriber who has just paid
 * $19 gets told to top up their wallet.
 *
 * IMPORTANT: publicly accessible (LemonSqueezy sends no Supabase auth token); we
 * verify the HMAC signature instead. The account to mutate is always resolved
 * from the TRUSTED supabase_user_id our create-checkout edge function embeds in
 * the checkout custom_data (server-set from the caller's JWT), never the
 * attacker-controlled payload email (SB-07).
 *
 * THERE IS ONE SUBSCRIPTION PRODUCT, and that is what removed a whole class of bug from
 * this file. Between 2026-08-26 and 2026-09-08 two products arrived on this same endpoint
 * looking alike, and every case had to classify by variant id before doing anything —
 * before that, every path hardcoded 'pro' while reading `variant_id` and never comparing
 * it, so a Reviewer payment would have granted Pro. If a second product is ever added,
 * the classification step has to come back FIRST in every case, not be bolted on later.
 *
 * AND NOTE the `default:` case: an unhandled event is logged and 200-ACKed. That
 * is correct for LemonSqueezy (a 4xx makes it retry forever) but it means a
 * MISSING branch is completely silent. That is exactly how the absence of
 * `subscription_payment_success` went unnoticed — the event was subscribed on the
 * LS side and the monthly grant simply never renewed, with nothing logged as
 * wrong. If a new paid behaviour does not fire, check for a missing case first.
 */

const WEBHOOK_SECRET = Deno.env.get("LEMONSQUEEZY_WEBHOOK_SECRET");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
// New API-key system: prefer the secret key; fall back to the auto-injected legacy service_role.
const SUPABASE_SERVICE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("NEXT_PUBLIC_SUPABASE_SECRET_KEY");

/**
 * Cents of Core credit included per paid month.
 *
 * ONE subscription, ONE allowance (2026-09-08). Atlarix Pro entitles the account to the
 * desktop app, Atlarix Reviewer and the Chrome extension, and this is the single pool all
 * three spend from. There used to be a second $19/mo Reviewer subscription with its own
 * $10 — which asked a customer who had already paid $19 to pay $19 again.
 *
 * $19 buys $19. Externally that is an ordinary monthly subscription; the fact that the
 * allowance equals the fee is an internal detail and MUST NOT be published — denominating
 * it in dollars publishes the cost structure. At the +40% metered rate $19 of allowance
 * costs ~$13.57 of real inference against ~$17.58 net of LemonSqueezy's fee, so roughly
 * 23% margin at full consumption and more in practice, because most subscribers do not
 * spend every cent and the allowance expires monthly.
 *
 * Still a Record keyed by product rather than a bare number: `credit_grants` is keyed by
 * (user_id, product) and the RPCs take a product argument, so flattening this would only
 * move the literal somewhere less obvious.
 */
const MONTHLY_GRANT_CENTS: Record<"pro", number> = {
  pro: 1900,
};

/**
 * The service-role client, typed loosely ON PURPOSE.
 *
 * This was `ReturnType<typeof createClient>`, which reads like the obvious thing
 * and is not: with no Database generic supplied, the schema parameter resolves to
 * `never`, so `supabase.rpc(name, args)` is typed to accept `undefined` args and
 * EVERY call in this file was a type error. Twenty-one of them, plus two on
 * `.from()` rows — which is why nothing here was ever type-checked: the noise
 * floor was so high that a real error could not be seen.
 *
 * The honest fix is generated Database types (`supabase gen types`), which would
 * check the RPC names and argument shapes for real. Until this project generates
 * them for the functions directory, a permissive alias is better than a broken
 * one: it makes `deno check` meaningful again, so the NEXT mistake is visible.
 */
// deno-lint-ignore no-explicit-any
type ServiceClient = SupabaseClient<any, any, any>;

/**
 * Apply one paid month's Core allowance.
 *
 * `ref` must be stable per BILLING PERIOD and unique across periods — it is what
 * makes a redelivered webhook a no-op rather than a second month of free credit.
 * The allowance is SET rather than added, so a wrong ref is not a rounding error:
 * too-unique double-grants, too-stable never renews.
 *
 * Per-product because a customer can hold both subscriptions, and a shared
 * allowance would mean whichever renewed second wiped the other's.
 */
async function grantMonth(
  supabase: ServiceClient,
  userId: string | null,
  product: "pro",
  ref: string,
): Promise<void> {
  if (!userId) {
    console.error(
      `[Webhook] cannot grant ${product} credit without a resolved user id`,
    );
    return;
  }
  const { data, error } = await supabase.rpc("grant_monthly_credit_service", {
    p_user_id: userId,
    p_product: product,
    p_cents: MONTHLY_GRANT_CENTS[product],
    p_ref: ref,
  });
  const row = data as {
    ok?: boolean;
    error?: string;
    duplicate?: boolean;
  } | null;
  if (error || row?.ok === false) {
    // Logged, not fatal: the subscription state is already correct, and a
    // 4xx/5xx here would make LemonSqueezy retry the WHOLE event. The grant
    // is idempotent, so a redelivery repairs it.
    console.error(
      `[Webhook] ${product} grant failed for ${userId}: ${error?.message ?? row?.error}`,
    );
    return;
  }
  console.log(
    `[Webhook] ${product} grant ${row?.duplicate ? "already applied" : "applied"} ref=${ref}`,
  );
}

/** Drop a product's allowance when its subscription ends. The other product's is untouched. */
async function clearGrant(
  supabase: ServiceClient,
  userId: string,
  product: "pro",
  ref: string,
): Promise<void> {
  const { data, error } = await supabase.rpc("clear_monthly_grant_service", {
    p_user_id: userId,
    p_product: product,
    p_ref: ref,
  });
  const row = data as { ok?: boolean; error?: string } | null;
  if (error || row?.ok === false) {
    console.error(
      `[Webhook] clearing ${product} allowance failed for ${userId}: ${error?.message ?? row?.error}`,
    );
  }
}

/**
 * Claw back allowance on a REFUNDED subscription period.
 *
 * Distinct from `clearGrant` because a refund can be partial and a cancellation
 * cannot: `clear_monthly_grant_service` always zeroes and files the row as an
 * expiry, which would erase the only ledger signal that separates churn from a
 * refund. This takes an amount, floors at what is left, and files `grant_refund`.
 *
 * NEVER touches purchased credit. The $19 bought entitlement plus an allowance;
 * it did not buy $19 of credit, so the user's own topped-up money is not ours to
 * take back on a subscription refund.
 */
async function refundGrant(
  supabase: ServiceClient,
  userId: string,
  product: "pro",
  cents: number,
  ref: string,
): Promise<void> {
  if (cents <= 0) return;

  // `cents` is the CUMULATIVE clawback for this invoice — `refundFraction`
  // divides LemonSqueezy's running `refunded_amount` by the total — so it must
  // not be handed straight to a primitive whose replay protection is
  // `ON CONFLICT (kind, ref) DO NOTHING`. That dedupe is right for a delta and
  // wrong for a running total: it made every partial refund after the first a
  // no-op. Same defect as the credit path; see `incrementalClawbackCents`.
  const { data: priorRows, error: priorErr } = await supabase
    .from("credit_transactions")
    .select("delta_cents, ref")
    .eq("user_id", userId)
    .eq("kind", "grant_refund");
  if (priorErr) {
    console.error(
      `[Webhook] could not read prior ${product} clawbacks: ${priorErr.message}`,
    );
    return;
  }
  // `refund_grant_service` stores the ref as `<product>:<ref>`, so the product is part
  // of the match. With one product that is currently always `pro:` — kept because the
  // RPC's storage format is what it is, and because a second product would otherwise
  // silently share a clawback ledger with the first.
  const prefix = `${product}:${ref}`;
  const alreadyTaken = (priorRows ?? [])
    .filter((r) => {
      const rowRef = String((r as { ref?: unknown }).ref ?? "");
      return rowRef === prefix || rowRef.startsWith(`${prefix}:`);
    })
    .reduce(
      (sum, r) =>
        sum +
        Math.abs(Number((r as { delta_cents?: unknown }).delta_cents) || 0),
      0,
    );

  const increment = incrementalClawbackCents(cents, alreadyTaken);
  if (increment <= 0) {
    console.log(
      `[Webhook] ${product} clawback for ${ref}: ${cents}c cumulative, ${alreadyTaken}c already taken — nothing to do`,
    );
    return;
  }

  const { data, error } = await supabase.rpc("refund_grant_service", {
    p_user_id: userId,
    p_product: product,
    p_cents: increment,
    // The cumulative total rides in the ref, so replaying this exact event
    // still collides while a genuine further refund carries a new total.
    p_ref: `${ref}:${cents}`,
  });
  const row = data as {
    ok?: boolean;
    error?: string;
    taken_cents?: number;
    shortfall_cents?: number;
  } | null;
  if (error || row?.ok === false) {
    // Logged, not fatal — same reasoning as grantMonth. A 4xx/5xx makes
    // LemonSqueezy retry the WHOLE event, and the entitlement half of a
    // refund matters more than the allowance half.
    console.error(
      `[Webhook] ${product} allowance clawback failed for ${userId}: ${error?.message ?? row?.error}`,
    );
    return;
  }
  // A shortfall is an ordinary outcome, not an error: the month's allowance was
  // already spent. It is worth a line, because "we refunded a month whose
  // credit was consumed" is a real business fact and silence would hide it.
  const shortfall = row?.shortfall_cents ?? 0;
  console.log(
    `[Webhook] ${product} allowance clawback took ${row?.taken_cents ?? 0}c of ${increment}c` +
      (shortfall > 0 ? ` (${shortfall}c had already been spent)` : ""),
  );
}

/**
 * End a Pro subscription on public.users, and hand back the account id.
 *
 * Extracted because `subscription_expired` and a refunded Pro month do the same
 * two-step dance — read the id BEFORE the update, because afterwards the row no
 * longer carries a way back from this subscription to the account, and the
 * allowance still has to be dealt with. Two copies of that ordering is how the
 * second one eventually forgets it.
 *
 * `status` differs on purpose: 'expired' is a subscription that ran its course,
 * 'refunded' is one that was undone. Both drop the tier; only the ledger and the
 * support conversation can tell them apart later.
 */
async function endProSubscription(
  supabase: ServiceClient,
  subscriptionId: string,
  status: "expired" | "refunded",
): Promise<{ userId: string | null; failed: boolean }> {
  const { data: row } = await supabase
    .from("users")
    .select("id")
    .eq("lemon_subscription_id", subscriptionId)
    .maybeSingle();

  const { error } = await supabase
    .from("users")
    .update({
      plan: "free",
      effective_tier: "free",
      subscription_status: status,
      subscription_ends_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("lemon_subscription_id", subscriptionId);

  if (error) {
    console.error("[Webhook] update error:", error);
    return { userId: (row?.id as string | undefined) ?? null, failed: true };
  }
  return { userId: (row?.id as string | undefined) ?? null, failed: false };
}

// HMAC-SHA256 signature verification
async function verifySignature(
  payload: string,
  signature: string | null,
): Promise<boolean> {
  if (!signature || !WEBHOOK_SECRET) {
    console.error("[Webhook] Missing signature or secret");
    return false;
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signatureBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payload),
  );

  const expectedSignature = Array.from(new Uint8Array(signatureBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // SB-10: constant-time compare so total time never depends on where the first
  // mismatch occurs (a plain `===` short-circuits and leaks position via timing).
  return timingSafeEqualHex(signature, expectedSignature);
}

/** Constant-time comparison of two equal-length hex digests. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, X-Signature",
      },
    });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const body = await req.text();
    const signature = req.headers.get("X-Signature");

    const isValid = await verifySignature(body, signature);
    if (!isValid) {
      console.error("[Webhook] Invalid signature");
      return jsonResponse({ error: "Invalid signature" }, 401);
    }

    const event = JSON.parse(body);
    const eventName = event.meta?.event_name;
    const data = event.data?.attributes;
    const subscriptionId = String(event.data?.id ?? "");

    console.log(`[Webhook] Event type: ${eventName}`);

    // Email is INFORMATIONAL ONLY (attacker-controlled). Never the mutation key.
    const customerEmail = data?.user_email ?? null;

    // SB-07: the account to mutate is resolved from the TRUSTED supabase_user_id
    // our create-checkout edge function embeds in the checkout custom_data
    // (server-set from the caller's JWT), echoed back on every webhook.
    const customData = event.meta?.custom_data ?? {};
    const customUserId = String(
      customData.supabase_user_id ?? customData.user_id ?? "",
    ).trim();
    const kind = String(customData.kind ?? "").trim();

    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      console.error("[Webhook] Missing Supabase credentials");
      return jsonResponse({ error: "Server configuration error" }, 500);
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    switch (eventName) {
      // -----------------------------------------------------------------
      // PAYG credit top-up. Only the "Atlarix Core Credit" product carries
      // custom_data.kind === 'credit'. Subscription first-orders also fire
      // order_created but are handled by the subscription_* events, so we
      // skip anything that isn't a credit order.
      // -----------------------------------------------------------------
      case "order_created": {
        if (kind !== "credit") {
          console.log(
            "[Webhook] order_created is not a credit top-up; skipping",
          );
          break;
        }
        const orderId = String(event.data?.id ?? "");
        // LS money fields are integer cents. Credit the pre-tax subtotal —
        // the amount the buyer chose; MoR tax is added on top and is not credit.
        const subtotalCents = Number(data?.subtotal ?? 0);
        if (!customUserId) {
          console.error(
            "[Webhook] credit order missing trusted supabase_user_id",
          );
          return jsonResponse(
            { error: "Missing supabase_user_id in custom_data" },
            400,
          );
        }
        if (!orderId || !Number.isFinite(subtotalCents) || subtotalCents <= 0) {
          console.error("[Webhook] credit order missing order_id/amount");
          return jsonResponse({ error: "Invalid credit order" }, 400);
        }
        const { error: creditErr } = await supabase.rpc(
          "credit_wallet_service",
          {
            p_user_id: customUserId,
            p_cents: Math.round(subtotalCents),
            p_kind: "topup",
            p_ref: orderId,
          },
        );
        if (creditErr) {
          console.error("[Webhook] credit_wallet_service failed:", creditErr);
          return jsonResponse({ error: "Wallet credit failed" }, 500);
        }
        console.log(
          `[Webhook] credited ${subtotalCents}c to ${customUserId} (order ${orderId})`,
        );
        break;
      }

      // Refund of a credit top-up -> claw back the credited amount. Idempotent
      // on ('refund', order_id), distinct from the ('topup', order_id) row.
      //
      // READ `refunded_amount`, NOT `subtotal`. LemonSqueezy supports partial
      // refunds, and `subtotal` is what the order was WORTH, not what was
      // given back — so a $10 refund on a $50 order would have clawed back
      // the whole $50. `subtotal` stays as the fallback because it is the
      // right answer for a full refund and an older payload may not carry
      // the newer field; failing closed here would leave a refunded order
      // still spendable, which is the worse direction.
      //
      // The clawback is ALLOWED to drive the wallet negative. That is not an
      // oversight: `credit_wallet_service` has no floor and never has, and
      // flooring at zero would make buy -> burn -> refund free. A negative
      // balance simply means they must top back up past zero before Core
      // serves them again, which the proxy's pre-flight gate enforces.
      case "order_refunded": {
        if (kind !== "credit") {
          console.log(
            "[Webhook] order_refunded is not a credit order; skipping",
          );
          break;
        }
        const orderId = String(event.data?.id ?? "");
        // CUMULATIVE, not this refund's own amount — see incrementalClawbackCents.
        const refundedCents = creditClawbackCents(data ?? {});
        if (!customUserId || !orderId || refundedCents <= 0) {
          console.log("[Webhook] refund missing user/order/amount; skipping");
          break;
        }

        // WHAT HAVE WE ALREADY TAKEN FOR THIS ORDER? Filtered in memory
        // rather than with a `like` prefix, because order ids are bare
        // numbers: `ref LIKE '12%'` also matches order 1234, and a
        // clawback that reads another order's history is worse than the
        // bug being fixed. A user's refund rows are few.
        const { data: priorRows, error: priorErr } = await supabase
          .from("credit_transactions")
          .select("delta_cents, ref")
          .eq("user_id", customUserId)
          .eq("kind", "refund");
        if (priorErr) {
          console.error("[Webhook] could not read prior clawbacks:", priorErr);
          return jsonResponse({ error: "Wallet refund failed" }, 500);
        }
        const alreadyTaken = (priorRows ?? [])
          .filter((r) => {
            const ref = String((r as { ref?: unknown }).ref ?? "");
            // Legacy rows are the bare order id; new ones carry the
            // cumulative total they applied.
            return ref === orderId || ref.startsWith(`${orderId}:`);
          })
          .reduce(
            (sum, r) =>
              sum +
              Math.abs(
                Number((r as { delta_cents?: unknown }).delta_cents) || 0,
              ),
            0,
          );

        const clawback = incrementalClawbackCents(refundedCents, alreadyTaken);
        if (clawback <= 0) {
          console.log(
            `[Webhook] order ${orderId}: ${refundedCents}c refunded, ${alreadyTaken}c already taken — nothing to do`,
          );
          break;
        }

        const { error: refundErr } = await supabase.rpc(
          "credit_wallet_service",
          {
            p_user_id: customUserId,
            p_cents: -clawback,
            p_kind: "refund",
            // The cumulative total is IN the ref, so a replay of this exact
            // event still collides and does nothing, while a genuine second
            // partial refund carries a new total and gets through.
            p_ref: `${orderId}:${Math.round(refundedCents)}`,
          },
        );
        if (refundErr) {
          console.error("[Webhook] refund clawback failed:", refundErr);
          return jsonResponse({ error: "Wallet refund failed" }, 500);
        }
        console.log(
          `[Webhook] clawed back ${clawback}c from ${customUserId} (order ${orderId}, ${refundedCents}c refunded in total)`,
        );
        break;
      }

      // -----------------------------------------------------------------
      // Subscription lifecycle — entitlement on public.users, allowance in
      // public.credit_grants. One product, so no classification step.
      // -----------------------------------------------------------------
      case "subscription_created":
      case "subscription_updated": {
        const status = data?.status ?? "";
        const renewsAt = data?.renews_at || null;
        const endsAt = data?.ends_at || null;
        const variantId = data?.variant_id?.toString() ?? "";
        const isActive = ["active", "on_trial"].includes(status);

        // Resolve target by trusted id, else by existing subscription link.
        let existingUser: { id: string } | null = null;
        if (customUserId) {
          const { data: u } = await supabase
            .from("users")
            .select("id")
            .eq("id", customUserId)
            .maybeSingle();
          existingUser = u;
        }
        if (!existingUser && subscriptionId) {
          const { data: u } = await supabase
            .from("users")
            .select("id")
            .eq("lemon_subscription_id", subscriptionId)
            .maybeSingle();
          existingUser = u;
        }

        // Cancelled but still in paid period: keep Pro until period end.
        if (status === "cancelled") {
          if (!existingUser) {
            console.log("[Webhook] cancelled but no user row; skipping");
            break;
          }
          const periodEnd = endsAt || renewsAt;
          const { error } = await supabase
            .from("users")
            .update({
              plan: "pro",
              effective_tier: "pro",
              lemon_variant_id: variantId || null,
              subscription_status: "cancelled",
              subscription_ends_at: periodEnd,
              lemon_subscription_id: subscriptionId,
              lemon_customer_id: String(data?.customer_id),
              customer_portal_url: data?.urls?.customer_portal || null,
              updated_at: new Date().toISOString(),
            })
            .eq("id", existingUser.id);
          if (error) {
            console.error("[Webhook] cancelled update error:", error);
            return jsonResponse({ error: "Database update error" }, 500);
          }
          break;
        }

        // Definitive expiry: downgrade to free immediately.
        if (status === "expired") {
          const { error } = await supabase
            .from("users")
            .update({
              plan: "free",
              effective_tier: "free",
              subscription_status: "expired",
              subscription_ends_at: null,
              updated_at: new Date().toISOString(),
            })
            .eq("lemon_subscription_id", subscriptionId);
          if (error) console.error("[Webhook] expired update error:", error);
          // Same reasoning as the subscription_expired case: Pro ended,
          // so the allowance ends. `existingUser` was resolved above,
          // before the update wiped the link.
          if (existingUser?.id) {
            await clearGrant(
              supabase,
              existingUser.id,
              "pro",
              `${subscriptionId}:expired`,
            );
          }
          break;
        }

        if (!existingUser) {
          if (!customUserId) {
            console.error(
              "[Webhook] no trusted supabase_user_id and no subscription link; refusing to provision by email",
            );
            return jsonResponse(
              { error: "Missing supabase_user_id in checkout custom_data" },
              400,
            );
          }
          const { error: insertError } = await supabase.from("users").insert({
            id: customUserId,
            email: customerEmail,
            plan: isActive ? "pro" : "free",
            effective_tier: isActive ? "pro" : "free",
            lemon_variant_id: variantId || null,
            lemon_subscription_id: subscriptionId,
            lemon_customer_id: String(data?.customer_id),
            subscription_status: status,
            subscription_ends_at: renewsAt || endsAt,
            customer_portal_url: data?.urls?.customer_portal || null,
          });
          if (insertError) {
            console.error("[Webhook] insert error:", insertError);
            return jsonResponse({ error: "Database insert error" }, 500);
          }
        } else {
          // Active/trial -> Pro. Other non-terminal states (past_due, paused):
          // update status/period hints but do NOT downgrade to free.
          const updateRow: Record<string, unknown> = {
            lemon_variant_id: variantId || null,
            lemon_subscription_id: subscriptionId,
            lemon_customer_id: String(data?.customer_id),
            subscription_status: status,
            subscription_ends_at: isActive ? renewsAt : endsAt || renewsAt,
            customer_portal_url: data?.urls?.customer_portal || null,
            updated_at: new Date().toISOString(),
          };
          if (isActive) {
            updateRow.plan = "pro";
            updateRow.effective_tier = "pro";
          }
          const { error: updateError } = await supabase
            .from("users")
            .update(updateRow)
            .eq("id", existingUser.id);
          if (updateError) {
            console.error("[Webhook] update error:", updateError);
            return jsonResponse({ error: "Database update error" }, 500);
          }
        }

        // The FIRST period's grant. Renewals come through
        // subscription_payment_success; without this the first month
        // would be the only one a subscriber did not get credit for.
        if (isActive) {
          const targetId = existingUser?.id ?? customUserId;
          await grantMonth(
            supabase,
            targetId || null,
            "pro",
            `${subscriptionId}:${renewsAt ?? endsAt ?? "initial"}`,
          );
        }
        console.log(`[Webhook] processed ${eventName} for ${customerEmail}`);
        break;
      }

      // -----------------------------------------------------------------
      // The monthly heartbeat. THIS is what renews the Core allowance; without it a
      // subscriber is credited once at signup and never again.
      //
      // PAYLOAD SHAPE DIFFERS FROM EVERY OTHER CASE. This event's object is
      // a subscription INVOICE, so `event.data.id` is the invoice id, not
      // the subscription id — the `subscriptionId` computed at the top of
      // this handler is the wrong value here and must not be used. The
      // subscription comes from `attributes.subscription_id`, and the
      // invoice id is exactly the stable per-period grant reference we
      // need.
      // -----------------------------------------------------------------
      case "subscription_payment_success": {
        const { invoiceId, subscriptionId: subId } = invoiceIds(event);
        const variantId = data?.variant_id?.toString() ?? "";
        if (!subId) {
          console.error(
            "[Webhook] payment_success without subscription_id; ignoring",
          );
          break;
        }

        const { data: u } = await supabase
          .from("users")
          .select("id")
          .eq("lemon_subscription_id", subId)
          .maybeSingle();
        const targetId = u?.id ?? customUserId;
        if (!targetId) {
          console.error(
            `[Webhook] payment_success for unknown Pro sub ${subId}`,
          );
          break;
        }
        // Invoice id as the ref: one invoice per billing period, stable
        // across redeliveries of that invoice, distinct across periods.
        await grantMonth(
          supabase,
          targetId,
          "pro",
          invoiceId || `${subId}:unknown-invoice`,
        );
        break;
      }

      // -----------------------------------------------------------------
      // A subscription month given back.
      //
      // SAME PAYLOAD TRAP AS payment_success: the object is a subscription
      // INVOICE, so `event.data.id` is the invoice id and the subscription
      // is `attributes.subscription_id`. The `subscriptionId` computed at
      // the top of this handler is the WRONG value here.
      //
      // WHAT A REFUND ACTUALLY RETURNS. A fee, not credit. $19 bought
      // entitlement plus an allowance; it did not buy $19 of credit. So the
      // clawback comes out of the GRANT, proportionally to how much of the
      // invoice was refunded, and purchased credit is never touched — that
      // is the user's own money from an unrelated transaction.
      //
      // AND THE TIER DROPS IMMEDIATELY, unlike a cancellation. A
      // cancellation rightly runs to period end because the customer paid
      // for the rest of the period; a refund is the statement that this
      // month did not happen. Leaving Pro active for a month we were paid
      // nothing for is the strictly worse error.
      //
      // Prorated forward only: inference already delivered cannot be un-delivered,
      // so nothing already spent is clawed back — the grant is floored at what
      // remains.
      // -----------------------------------------------------------------
      case "subscription_payment_refunded": {
        const { invoiceId, subscriptionId: subId } = invoiceIds(event);
        const variantId = data?.variant_id?.toString() ?? "";
        if (!subId) {
          console.error(
            "[Webhook] payment_refunded without subscription_id; ignoring",
          );
          break;
        }

        // How much of the period was given back. A refund event carries no
        // custom_data, so this rides on the invoice's own fields.
        const { fraction, assumedFull } = refundFraction(data ?? {});
        if (assumedFull) {
          console.warn(
            `[Webhook] refund amounts unreadable on invoice ${invoiceId}; treating as full`,
          );
        }
        const clawbackCents = grantClawbackCents(
          MONTHLY_GRANT_CENTS.pro,
          fraction,
        );
        const refundRef = `${invoiceId || subId}:refund`;

        // RESOLVE FROM THE SUBSCRIPTION ROW ONLY — no custom_data fallback,
        // unlike payment_success. A refund event carries no custom_data in
        // practice, and the asymmetry is deliberate: granting to the wrong
        // account on a bad guess costs us a month's allowance, while TAKING
        // from the wrong account costs a customer theirs. If we cannot name
        // the subscriber with certainty, we take nothing and say so.
        const ended = await endProSubscription(supabase, subId, "refunded");
        if (ended.failed) {
          return jsonResponse({ error: "Database error" }, 500);
        }
        if (!ended.userId) {
          // The tier update matched no row, so nothing was downgraded and
          // there is no account to take an allowance from. Taking from the
          // wrong account costs a customer their allowance, so on an
          // unresolvable subscriber we take nothing and say so.
          console.error(
            `[Webhook] payment_refunded for unknown Pro sub ${subId}`,
          );
          break;
        }
        await refundGrant(
          supabase,
          ended.userId,
          "pro",
          clawbackCents,
          refundRef,
        );
        console.log(
          `[Webhook] Pro subscription ${subId} refunded (${Math.round(fraction * 100)}% of the period)`,
        );
        break;
      }

      case "subscription_cancelled": {
        const endsAt = data?.ends_at || null;
        const variantId = data?.variant_id?.toString() ?? "";

        // Keep Pro until subscription_ends_at.
        await supabase
          .from("users")
          .update({
            plan: "pro",
            effective_tier: "pro",
            lemon_variant_id: variantId || null,
            subscription_status: "cancelled",
            subscription_ends_at: endsAt,
            updated_at: new Date().toISOString(),
          })
          .eq("lemon_subscription_id", subscriptionId);
        // The grant is deliberately NOT cleared here. They keep Pro to
        // the period end, so they keep the allowance they paid for; it
        // goes on subscription_expired.
        console.log(
          `[Webhook] processed ${eventName}, access until: ${endsAt}`,
        );
        break;
      }

      case "subscription_expired": {
        const variantId = data?.variant_id?.toString() ?? "";

        const expiring = await endProSubscription(
          supabase,
          subscriptionId,
          "expired",
        );
        if (expiring.failed) {
          return jsonResponse({ error: "Database error" }, 500);
        }

        // Pro is over, so the allowance goes with it. Purchased credit is
        // untouched — that is the user's money and it never expires.
        if (expiring.userId) {
          await clearGrant(
            supabase,
            expiring.userId,
            "pro",
            `${subscriptionId}:expired`,
          );
        }
        console.log(`[Webhook] processed ${eventName}`);
        break;
      }

      case "subscription_payment_failed": {
        console.log(
          `[Webhook] payment failed for subscription ${subscriptionId}; grace period`,
        );
        break;
      }

      default:
        console.log(`[Webhook] Ignoring event: ${eventName}`);
    }

    return jsonResponse({ received: true, event: eventName }, 200);
  } catch (error) {
    console.error("[Webhook] Error:", error);
    return jsonResponse(
      { error: "Internal server error", details: String(error) },
      500,
    );
  }
});
