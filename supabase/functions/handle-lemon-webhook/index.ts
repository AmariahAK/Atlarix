import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

/**
 * LemonSqueezy Webhook Handler
 * ============================
 * Two responsibilities under the PAYG reframe:
 *   1. subscription_* events -> Atlarix Pro entitlement on public.users.
 *   2. order_created / order_refunded for the "Atlarix Core Credit" product ->
 *      credit / claw back the PAYG wallet (public.credit_wallet).
 *
 * IMPORTANT: publicly accessible (LemonSqueezy sends no Supabase auth token); we
 * verify the HMAC signature instead. The account to mutate is always resolved
 * from the TRUSTED supabase_user_id our create-checkout edge function embeds in
 * the checkout custom_data (server-set from the caller's JWT), never the
 * attacker-controlled payload email (SB-07).
 */

const WEBHOOK_SECRET = Deno.env.get('LEMONSQUEEZY_WEBHOOK_SECRET');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
// New API-key system: prefer the secret key; fall back to the auto-injected legacy service_role.
const SUPABASE_SERVICE_KEY =
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('NEXT_PUBLIC_SUPABASE_SECRET_KEY');

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
            // Atlarix Pro subscription lifecycle. Only one paid plan now: 'pro'.
            // -----------------------------------------------------------------
            case 'subscription_created':
            case 'subscription_updated': {
                const status = data?.status ?? '';
                const renewsAt = data?.renews_at || null;
                const endsAt = data?.ends_at || null;
                const variantId = data?.variant_id?.toString() ?? '';
                const isActive = ['active', 'on_trial'].includes(status);

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
                console.log(`[Webhook] processed ${eventName} for ${customerEmail}`);
                break;
            }

            case 'subscription_cancelled': {
                const endsAt = data?.ends_at || null;
                const variantId = data?.variant_id?.toString() ?? '';
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
                console.log(`[Webhook] processed ${eventName}, access until: ${endsAt}`);
                break;
            }

            case 'subscription_expired': {
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
