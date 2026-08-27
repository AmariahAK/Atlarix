import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

/**
 * LemonSqueezy Webhook Handler
 * ============================
 * Responsibilities:
 *   1. Pro subscription_* events -> entitlement on public.users, plus that
 *      product's monthly Core allowance in public.credit_grants.
 *   2. Reviewer subscription_* events -> entitlement in
 *      public.reviewer_subscriptions, plus its own allowance in
 *      public.credit_grants. A SEPARATE product: it must never touch users.plan.
 *   3. order_created / order_refunded for the "Atlarix Core Credit" product ->
 *      credit / claw back the PAYG wallet (public.credit_wallet).
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
 * TWO PRODUCTS ON ONE WEBHOOK — the trap this file now has to avoid. Every
 * subscription event arrives on the same endpoint and looks alike. Until
 * 2026-08-26 every subscription path hardcoded 'pro' while reading `variant_id`
 * and never comparing it, so a Reviewer payment would have granted Pro. The
 * classification below is therefore the first thing every subscription case does.
 *
 * AND NOTE the `default:` case: an unhandled event is logged and 200-ACKed. That
 * is correct for LemonSqueezy (a 4xx makes it retry forever) but it means a
 * MISSING branch is completely silent. That is exactly how the absence of
 * `subscription_payment_success` went unnoticed — the event was subscribed on the
 * LS side and the monthly grant simply never renewed, with nothing logged as
 * wrong. If a new paid behaviour does not fire, check for a missing case first.
 */

const WEBHOOK_SECRET = Deno.env.get('LEMONSQUEEZY_WEBHOOK_SECRET');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
// New API-key system: prefer the secret key; fall back to the auto-injected legacy service_role.
const SUPABASE_SERVICE_KEY =
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('NEXT_PUBLIC_SUPABASE_SECRET_KEY');

const REVIEWER_VARIANT_ID = Deno.env.get('LEMONSQUEEZY_REVIEWER_VARIANT_ID')?.trim() || null;

/**
 * Cents of Core credit included per paid month, per product.
 *
 * These are the numbers the pricing rests on, so they are worth stating: at the
 * +40% metered rate $10 of allowance costs ~$7.14 of real inference, against
 * ~$17.58 net of LemonSqueezy's fee — about 59% margin if a subscriber spends
 * every cent, and more in practice because most do not. Raising either of these
 * is a direct cut to that margin.
 */
const MONTHLY_GRANT_CENTS: Record<'pro' | 'reviewer', number> = {
    pro: 1000,
    reviewer: 1000,
};

/**
 * Which product is this subscription event about?
 *
 * `kind` (from the checkout's custom_data) is the strong signal but it is only
 * present on events descended from a checkout we created. Renewals and
 * cancellations arrive with no custom_data at all, so `variant_id` has to carry
 * it — which is why the variant id is compared rather than merely stored.
 *
 * Unknown falls to 'pro', preserving the behaviour every existing Pro
 * subscriber already has: those rows predate REVIEWER_VARIANT_ID being set and
 * their renewals carry no custom_data, so anything else would strand them.
 */
function productOf(kind: string, variantId: string): 'pro' | 'reviewer' {
    if (kind === 'reviewer') return 'reviewer';
    if (REVIEWER_VARIANT_ID && variantId && variantId === REVIEWER_VARIANT_ID) return 'reviewer';
    return 'pro';
}

type ServiceClient = ReturnType<typeof createClient>;

/**
 * Write the Reviewer entitlement. Never touches public.users — the reviewer is a
 * separate product, not a tier, so `plan` and `effective_tier` stay out of it.
 */
async function applyReviewerSubscription(
    supabase: ServiceClient,
    args: {
        userId: string | null;
        subscriptionId: string;
        variantId: string;
        status: string;
        periodEnd: string | null;
    },
): Promise<boolean> {
    const { data, error } = await supabase.rpc('upsert_reviewer_subscription_service', {
        p_user_id: args.userId,
        p_lemon_subscription_id: args.subscriptionId,
        p_lemon_variant_id: args.variantId || null,
        p_status: args.status,
        p_current_period_end: args.periodEnd,
    });
    const row = data as { ok?: boolean; error?: string } | null;
    if (error || row?.ok === false) {
        console.error(
            `[Webhook] reviewer upsert failed (sub ${args.subscriptionId}): ${error?.message ?? row?.error}`,
        );
        return false;
    }
    console.log(`[Webhook] reviewer subscription ${args.subscriptionId} -> ${args.status}`);
    return true;
}

/**
 * Apply one paid month's Core allowance for one product.
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
    product: 'pro' | 'reviewer',
    ref: string,
): Promise<void> {
    if (!userId) {
        console.error(`[Webhook] cannot grant ${product} credit without a resolved user id`);
        return;
    }
    const { data, error } = await supabase.rpc('grant_monthly_credit_service', {
        p_user_id: userId,
        p_product: product,
        p_cents: MONTHLY_GRANT_CENTS[product],
        p_ref: ref,
    });
    const row = data as { ok?: boolean; error?: string; duplicate?: boolean } | null;
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
        `[Webhook] ${product} grant ${row?.duplicate ? 'already applied' : 'applied'} ref=${ref}`,
    );
}

/** Drop a product's allowance when its subscription ends. The other product's is untouched. */
async function clearGrant(
    supabase: ServiceClient,
    userId: string,
    product: 'pro' | 'reviewer',
    ref: string,
): Promise<void> {
    const { data, error } = await supabase.rpc('clear_monthly_grant_service', {
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

// HMAC-SHA256 signature verification
async function verifySignature(payload: string, signature: string | null): Promise<boolean> {
    if (!signature || !WEBHOOK_SECRET) {
        console.error('[Webhook] Missing signature or secret');
        return false;
    }

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(WEBHOOK_SECRET),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );

    const signatureBuffer = await crypto.subtle.sign(
        'HMAC',
        key,
        encoder.encode(payload)
    );

    const expectedSignature = Array.from(new Uint8Array(signatureBuffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');

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
        headers: { 'Content-Type': 'application/json' },
    });
}

serve(async (req: Request) => {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        return new Response('ok', {
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, X-Signature',
            },
        });
    }

    if (req.method !== 'POST') {
        return new Response('Method not allowed', { status: 405 });
    }

    try {
        const body = await req.text();
        const signature = req.headers.get('X-Signature');

        const isValid = await verifySignature(body, signature);
        if (!isValid) {
            console.error('[Webhook] Invalid signature');
            return jsonResponse({ error: 'Invalid signature' }, 401);
        }

        const event = JSON.parse(body);
        const eventName = event.meta?.event_name;
        const data = event.data?.attributes;
        const subscriptionId = String(event.data?.id ?? '');

        console.log(`[Webhook] Event type: ${eventName}`);

        // Email is INFORMATIONAL ONLY (attacker-controlled). Never the mutation key.
        const customerEmail = data?.user_email ?? null;

        // SB-07: the account to mutate is resolved from the TRUSTED supabase_user_id
        // our create-checkout edge function embeds in the checkout custom_data
        // (server-set from the caller's JWT), echoed back on every webhook.
        const customData = event.meta?.custom_data ?? {};
        const customUserId = String(customData.supabase_user_id ?? customData.user_id ?? '').trim();
        const kind = String(customData.kind ?? '').trim();

        if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
            console.error('[Webhook] Missing Supabase credentials');
            return jsonResponse({ error: 'Server configuration error' }, 500);
        }

        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

        switch (eventName) {
            // -----------------------------------------------------------------
            // PAYG credit top-up. Only the "Atlarix Core Credit" product carries
            // custom_data.kind === 'credit'. Subscription first-orders also fire
            // order_created but are handled by the subscription_* events, so we
            // skip anything that isn't a credit order.
            // -----------------------------------------------------------------
            case 'order_created': {
                if (kind !== 'credit') {
                    console.log('[Webhook] order_created is not a credit top-up; skipping');
                    break;
                }
                const orderId = String(event.data?.id ?? '');
                // LS money fields are integer cents. Credit the pre-tax subtotal —
                // the amount the buyer chose; MoR tax is added on top and is not credit.
                const subtotalCents = Number(data?.subtotal ?? 0);
                if (!customUserId) {
                    console.error('[Webhook] credit order missing trusted supabase_user_id');
                    return jsonResponse({ error: 'Missing supabase_user_id in custom_data' }, 400);
                }
                if (!orderId || !Number.isFinite(subtotalCents) || subtotalCents <= 0) {
                    console.error('[Webhook] credit order missing order_id/amount');
                    return jsonResponse({ error: 'Invalid credit order' }, 400);
                }
                const { error: creditErr } = await supabase.rpc('credit_wallet_service', {
                    p_user_id: customUserId,
                    p_cents: Math.round(subtotalCents),
                    p_kind: 'topup',
                    p_ref: orderId,
                });
                if (creditErr) {
                    console.error('[Webhook] credit_wallet_service failed:', creditErr);
                    return jsonResponse({ error: 'Wallet credit failed' }, 500);
                }
                console.log(`[Webhook] credited ${subtotalCents}c to ${customUserId} (order ${orderId})`);
                break;
            }

            // Refund of a credit top-up -> claw back the credited amount. Idempotent
            // on ('refund', order_id), distinct from the ('topup', order_id) row.
            case 'order_refunded': {
                if (kind !== 'credit') {
                    console.log('[Webhook] order_refunded is not a credit order; skipping');
                    break;
                }
                const orderId = String(event.data?.id ?? '');
                const subtotalCents = Number(data?.subtotal ?? 0);
                if (!customUserId || !orderId || !Number.isFinite(subtotalCents) || subtotalCents <= 0) {
                    console.log('[Webhook] refund missing user/order/amount; skipping');
                    break;
                }
                const { error: refundErr } = await supabase.rpc('credit_wallet_service', {
                    p_user_id: customUserId,
                    p_cents: -Math.round(subtotalCents),
                    p_kind: 'refund',
                    p_ref: orderId,
                });
                if (refundErr) {
                    console.error('[Webhook] refund clawback failed:', refundErr);
                    return jsonResponse({ error: 'Wallet refund failed' }, 500);
                }
                console.log(`[Webhook] clawed back ${subtotalCents}c from ${customUserId} (order ${orderId})`);
                break;
            }

            // -----------------------------------------------------------------
            // Subscription lifecycle — Pro on public.users, Reviewer on
            // public.reviewer_subscriptions. Classify FIRST; the two products
            // arrive on this same endpoint looking almost identical.
            // -----------------------------------------------------------------
            case 'subscription_created':
            case 'subscription_updated': {
                const status = data?.status ?? '';
                const renewsAt = data?.renews_at || null;
                const endsAt = data?.ends_at || null;
                const variantId = data?.variant_id?.toString() ?? '';
                const isActive = ['active', 'on_trial'].includes(status);

                if (productOf(kind, variantId) === 'reviewer') {
                    const ok = await applyReviewerSubscription(supabase, {
                        userId: customUserId || null,
                        subscriptionId,
                        variantId,
                        status,
                        periodEnd: isActive ? renewsAt : (endsAt || renewsAt),
                    });
                    // A 500 here is deliberate: unlike the allowance, this write IS
                    // the entitlement, so letting LemonSqueezy retry is the only
                    // thing standing between a paying customer and a dead bot.
                    if (!ok) return jsonResponse({ error: 'Reviewer entitlement write failed' }, 500);

                    // The subscription entitles; the allowance PAYS. Without this
                    // a subscriber with an empty wallet would be told to top up —
                    // having just paid $19 for reviews.
                    if (isActive && customUserId) {
                        await grantMonth(
                            supabase,
                            customUserId,
                            'reviewer',
                            `${subscriptionId}:${renewsAt ?? endsAt ?? 'initial'}`,
                        );
                    }
                    break;
                }

                // Resolve target by trusted id, else by existing subscription link.
                let existingUser: { id: string } | null = null;
                if (customUserId) {
                    const { data: u } = await supabase.from('users').select('id').eq('id', customUserId).maybeSingle();
                    existingUser = u;
                }
                if (!existingUser && subscriptionId) {
                    const { data: u } = await supabase.from('users').select('id').eq('lemon_subscription_id', subscriptionId).maybeSingle();
                    existingUser = u;
                }

                // Cancelled but still in paid period: keep Pro until period end.
                if (status === 'cancelled') {
                    if (!existingUser) {
                        console.log('[Webhook] cancelled but no user row; skipping');
                        break;
                    }
                    const periodEnd = endsAt || renewsAt;
                    const { error } = await supabase
                        .from('users')
                        .update({
                            plan: 'pro',
                            effective_tier: 'pro',
                            lemon_variant_id: variantId || null,
                            subscription_status: 'cancelled',
                            subscription_ends_at: periodEnd,
                            lemon_subscription_id: subscriptionId,
                            lemon_customer_id: String(data?.customer_id),
                            customer_portal_url: data?.urls?.customer_portal || null,
                            updated_at: new Date().toISOString(),
                        })
                        .eq('id', existingUser.id);
                    if (error) {
                        console.error('[Webhook] cancelled update error:', error);
                        return jsonResponse({ error: 'Database update error' }, 500);
                    }
                    break;
                }

                // Definitive expiry: downgrade to free immediately.
                if (status === 'expired') {
                    const { error } = await supabase
                        .from('users')
                        .update({
                            plan: 'free',
                            effective_tier: 'free',
                            subscription_status: 'expired',
                            subscription_ends_at: null,
                            updated_at: new Date().toISOString(),
                        })
                        .eq('lemon_subscription_id', subscriptionId);
                    if (error) console.error('[Webhook] expired update error:', error);
                    // Same reasoning as the subscription_expired case: Pro ended,
                    // so the allowance ends. `existingUser` was resolved above,
                    // before the update wiped the link.
                    if (existingUser?.id) {
                        await clearGrant(supabase, existingUser.id, 'pro', `${subscriptionId}:expired`);
                    }
                    break;
                }

                if (!existingUser) {
                    if (!customUserId) {
                        console.error('[Webhook] no trusted supabase_user_id and no subscription link; refusing to provision by email');
                        return jsonResponse({ error: 'Missing supabase_user_id in checkout custom_data' }, 400);
                    }
                    const { error: insertError } = await supabase
                        .from('users')
                        .insert({
                            id: customUserId,
                            email: customerEmail,
                            plan: isActive ? 'pro' : 'free',
                            effective_tier: isActive ? 'pro' : 'free',
                            lemon_variant_id: variantId || null,
                            lemon_subscription_id: subscriptionId,
                            lemon_customer_id: String(data?.customer_id),
                            subscription_status: status,
                            subscription_ends_at: renewsAt || endsAt,
                            customer_portal_url: data?.urls?.customer_portal || null,
                        });
                    if (insertError) {
                        console.error('[Webhook] insert error:', insertError);
                        return jsonResponse({ error: 'Database insert error' }, 500);
                    }
                } else {
                    // Active/trial -> Pro. Other non-terminal states (past_due, paused):
                    // update status/period hints but do NOT downgrade to free.
                    const updateRow: Record<string, unknown> = {
                        lemon_variant_id: variantId || null,
                        lemon_subscription_id: subscriptionId,
                        lemon_customer_id: String(data?.customer_id),
                        subscription_status: status,
                        subscription_ends_at: isActive ? renewsAt : (endsAt || renewsAt),
                        customer_portal_url: data?.urls?.customer_portal || null,
                        updated_at: new Date().toISOString(),
                    };
                    if (isActive) {
                        updateRow.plan = 'pro';
                        updateRow.effective_tier = 'pro';
                    }
                    const { error: updateError } = await supabase
                        .from('users')
                        .update(updateRow)
                        .eq('id', existingUser.id);
                    if (updateError) {
                        console.error('[Webhook] update error:', updateError);
                        return jsonResponse({ error: 'Database update error' }, 500);
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
                        'pro',
                        `${subscriptionId}:${renewsAt ?? endsAt ?? 'initial'}`,
                    );
                }
                console.log(`[Webhook] processed ${eventName} for ${customerEmail}`);
                break;
            }

            // -----------------------------------------------------------------
            // The monthly heartbeat. THIS is what renews the Pro Core grant and
            // extends the Reviewer period; without it a subscriber is credited
            // once at signup and never again.
            //
            // PAYLOAD SHAPE DIFFERS FROM EVERY OTHER CASE. This event's object is
            // a subscription INVOICE, so `event.data.id` is the invoice id, not
            // the subscription id — the `subscriptionId` computed at the top of
            // this handler is the wrong value here and must not be used. The
            // subscription comes from `attributes.subscription_id`, and the
            // invoice id is exactly the stable per-period grant reference we
            // need.
            // -----------------------------------------------------------------
            case 'subscription_payment_success': {
                const invoiceId = String(event.data?.id ?? '');
                const subId = String(data?.subscription_id ?? '');
                const variantId = data?.variant_id?.toString() ?? '';
                if (!subId) {
                    console.error('[Webhook] payment_success without subscription_id; ignoring');
                    break;
                }

                if (productOf(kind, variantId) === 'reviewer') {
                    const { data: row } = await supabase
                        .from('reviewer_subscriptions')
                        .select('user_id, current_period_end')
                        .eq('lemon_subscription_id', subId)
                        .maybeSingle();
                    if (!row) {
                        console.error(`[Webhook] payment_success for unknown reviewer sub ${subId}`);
                        break;
                    }
                    // Renewal payment: the row stays active. The authoritative
                    // period end arrives on the subscription_updated that
                    // accompanies a renewal, so this only refreshes the status.
                    await applyReviewerSubscription(supabase, {
                        userId: row.user_id as string,
                        subscriptionId: subId,
                        variantId,
                        status: 'active',
                        periodEnd: null,
                    });
                    await grantMonth(
                        supabase,
                        row.user_id as string,
                        'reviewer',
                        invoiceId || `${subId}:unknown-invoice`,
                    );
                    break;
                }

                const { data: u } = await supabase
                    .from('users')
                    .select('id')
                    .eq('lemon_subscription_id', subId)
                    .maybeSingle();
                const targetId = u?.id ?? customUserId;
                if (!targetId) {
                    console.error(`[Webhook] payment_success for unknown Pro sub ${subId}`);
                    break;
                }
                // Invoice id as the ref: one invoice per billing period, stable
                // across redeliveries of that invoice, distinct across periods.
                await grantMonth(supabase, targetId, 'pro', invoiceId || `${subId}:unknown-invoice`);
                break;
            }

            case 'subscription_cancelled': {
                const endsAt = data?.ends_at || null;
                const variantId = data?.variant_id?.toString() ?? '';

                if (productOf(kind, variantId) === 'reviewer') {
                    // Cancelled, not gone: reviewer_entitlement_service treats
                    // 'cancelled' as entitled until current_period_end, because
                    // the customer paid for the rest of the period.
                    await applyReviewerSubscription(supabase, {
                        userId: customUserId || null,
                        subscriptionId,
                        variantId,
                        status: 'cancelled',
                        periodEnd: endsAt,
                    });
                    console.log(`[Webhook] reviewer cancelled, access until: ${endsAt}`);
                    break;
                }

                // Keep Pro until subscription_ends_at.
                await supabase
                    .from('users')
                    .update({
                        plan: 'pro',
                        effective_tier: 'pro',
                        lemon_variant_id: variantId || null,
                        subscription_status: 'cancelled',
                        subscription_ends_at: endsAt,
                        updated_at: new Date().toISOString(),
                    })
                    .eq('lemon_subscription_id', subscriptionId);
                // The grant is deliberately NOT cleared here. They keep Pro to
                // the period end, so they keep the allowance they paid for; it
                // goes on subscription_expired.
                console.log(`[Webhook] processed ${eventName}, access until: ${endsAt}`);
                break;
            }

            case 'subscription_expired': {
                const variantId = data?.variant_id?.toString() ?? '';

                if (productOf(kind, variantId) === 'reviewer') {
                    // Read the account BEFORE marking expired, so the allowance
                    // can still be cleared afterwards.
                    const { data: revRow } = await supabase
                        .from('reviewer_subscriptions')
                        .select('user_id')
                        .eq('lemon_subscription_id', subscriptionId)
                        .maybeSingle();
                    await applyReviewerSubscription(supabase, {
                        userId: customUserId || null,
                        subscriptionId,
                        variantId,
                        status: 'expired',
                        periodEnd: null,
                    });
                    const revUser = (revRow?.user_id as string | undefined) ?? customUserId;
                    if (revUser) {
                        await clearGrant(supabase, revUser, 'reviewer', `${subscriptionId}:expired`);
                    }
                    console.log(`[Webhook] reviewer subscription expired`);
                    break;
                }

                // Read the id BEFORE the update: afterwards the row no longer
                // carries a way back from this subscription to the account.
                const { data: expiring } = await supabase
                    .from('users')
                    .select('id')
                    .eq('lemon_subscription_id', subscriptionId)
                    .maybeSingle();

                const { error } = await supabase
                    .from('users')
                    .update({
                        plan: 'free',
                        effective_tier: 'free',
                        subscription_status: 'expired',
                        subscription_ends_at: null,
                        updated_at: new Date().toISOString(),
                    })
                    .eq('lemon_subscription_id', subscriptionId);
                if (error) {
                    console.error('[Webhook] update error:', error);
                    return jsonResponse({ error: 'Database error' }, 500);
                }

                // Pro is over, so the allowance goes with it. Purchased credit is
                // untouched — that is the user's money and it never expires.
                if (expiring?.id) {
                    await clearGrant(supabase, expiring.id, 'pro', `${subscriptionId}:expired`);
                }
                console.log(`[Webhook] processed ${eventName}`);
                break;
            }

            case 'subscription_payment_failed': {
                console.log(`[Webhook] payment failed for subscription ${subscriptionId}; grace period`);
                break;
            }

            default:
                console.log(`[Webhook] Ignoring event: ${eventName}`);
        }

        return jsonResponse({ received: true, event: eventName }, 200);
    } catch (error) {
        console.error('[Webhook] Error:', error);
        return jsonResponse({ error: 'Internal server error', details: String(error) }, 500);
    }
});
