import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

/**
 * LemonSqueezy Webhook Handler
 * ============================
 * Receives subscription events from LemonSqueezy and updates user plans.
 * 
 * IMPORTANT: This function must be publicly accessible (no auth required)
 * because LemonSqueezy sends webhooks without Supabase auth tokens.
 * We verify the request using LemonSqueezy's HMAC signature instead.
 */

const WEBHOOK_SECRET = Deno.env.get('LEMONSQUEEZY_WEBHOOK_SECRET');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

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

    // Only accept POST requests
    if (req.method !== 'POST') {
        return new Response('Method not allowed', { status: 405 });
    }

    try {
        // Get the raw body for signature verification
        const body = await req.text();
        const signature = req.headers.get('X-Signature');

        console.log('[Webhook] Received request');
        console.log('[Webhook] Has signature:', !!signature);
        console.log('[Webhook] Has webhook secret:', !!WEBHOOK_SECRET);

        // Verify webhook signature
        const isValid = await verifySignature(body, signature);
        if (!isValid) {
            console.error('[Webhook] Invalid signature');
            return new Response(JSON.stringify({ error: 'Invalid signature' }), {
                status: 401,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        console.log('[Webhook] Signature verified successfully');

        // Parse the event
        const event = JSON.parse(body);
        const eventName = event.meta?.event_name;
        const data = event.data?.attributes;
        const subscriptionId = String(event.data?.id ?? '');

        console.log(`[Webhook] Event type: ${eventName}`);

        // Email is INFORMATIONAL ONLY now (audit trail / team-name default). It is
        // attacker-controlled (it comes from the subscriber's own checkout), so it
        // must NEVER be the key we mutate accounts by (SB-07).
        const customerEmail = data?.user_email ?? null;

        // SB-07: the account to mutate is resolved from a TRUSTED id — the
        // supabase_user_id our own create-checkout edge function embeds in the
        // checkout custom_data (server-set from the caller's JWT), echoed back on
        // every webhook as event.meta.custom_data. `user_id` is accepted as a
        // legacy alias for in-flight checkouts created before the rename.
        const customData = event.meta?.custom_data ?? {};
        const customUserId = String(customData.supabase_user_id ?? customData.user_id ?? '').trim();

        if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
            console.error('[Webhook] Missing Supabase credentials');
            return new Response(JSON.stringify({ error: 'Server configuration error' }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

        // Infer tier from variant_id (Workforce = monthly variant only; no annual)
        const variantId = data?.variant_id?.toString() ?? '';
        const workforceVariantId = Deno.env.get('LEMONSQUEEZY_WORKFORCE_VARIANT_ID') ?? '';
        // v10.1 guard: an unset variant env would silently classify every
        // Workforce subscriber as Pro (and '' === '' would do the inverse).
        // Fail loudly so Lemon retries after the env is fixed.
        if (!workforceVariantId) {
            console.error('[Webhook] LEMONSQUEEZY_WORKFORCE_VARIANT_ID is not configured');
            return new Response(
                JSON.stringify({ error: 'LEMONSQUEEZY_WORKFORCE_VARIANT_ID not configured' }),
                { status: 500, headers: { 'Content-Type': 'application/json' } },
            );
        }
        const isWorkforce = variantId === workforceVariantId;

        switch (eventName) {
            case 'subscription_created':
            case 'subscription_updated': {
                const status = data?.status ?? '';
                const renewsAt = data?.renews_at || null;
                const endsAt = data?.ends_at || null;
                const isActive = ['active', 'on_trial'].includes(status);

                // Resolve target by trusted id, else by the existing subscription
                // link (covers renewals/updates on already-provisioned subs). Never
                // by the payload email.
                let existingUser: { id: string } | null = null;
                if (customUserId) {
                    const { data } = await supabase.from('users').select('id').eq('id', customUserId).maybeSingle();
                    existingUser = data;
                }
                if (!existingUser && subscriptionId) {
                    const { data } = await supabase.from('users').select('id').eq('lemon_subscription_id', subscriptionId).maybeSingle();
                    existingUser = data;
                }

                // Cancelled but still in paid period: set tier from variant so plan is not left as free if active events were missed.
                if (status === 'cancelled') {
                    if (!existingUser) {
                        console.log('[Webhook] subscription_updated cancelled but no user row; skipping');
                        break;
                    }
                    const periodEnd = endsAt || renewsAt;
                    const paidPlan = isWorkforce ? 'workforce' : 'pro';
                    const { error: cancelErr } = await supabase
                        .from('users')
                        .update({
                            plan: paidPlan,
                            effective_tier: paidPlan,
                            lemon_variant_id: variantId || null,
                            subscription_status: 'cancelled',
                            subscription_ends_at: periodEnd,
                            lemon_subscription_id: subscriptionId,
                            lemon_customer_id: String(data?.customer_id),
                            customer_portal_url: data?.urls?.customer_portal || null,
                            updated_at: new Date().toISOString(),
                        })
                        .eq('id', existingUser.id);
                    if (cancelErr) {
                        console.error('[Webhook] Cancelled update error:', cancelErr);
                        return new Response(JSON.stringify({ error: 'Database update error' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
                    }
                    console.log(`[Webhook] Cancelled (access until ${periodEnd}) for ${customerEmail}`);
                    break;
                }

                // Definitive expiry in payload (some billing events): downgrade immediately
                if (status === 'expired') {
                    const { data: team } = await supabase.from('teams').select('id').eq('lemonsqueezy_subscription_id', subscriptionId).maybeSingle();
                    if (team) {
                        await supabase.from('team_members').update({ status: 'removed' }).eq('team_id', team.id);
                        await supabase.from('teams').update({ active: false, updated_at: new Date().toISOString() }).eq('id', team.id);
                        const { data: members } = await supabase.from('team_members').select('user_id').eq('team_id', team.id);
                        for (const m of members ?? []) {
                            if (m.user_id) {
                                const { data: u } = await supabase.from('users').select('plan').eq('id', m.user_id).single();
                                await supabase.from('users').update({ team_id: null, effective_tier: u?.plan ?? 'free', updated_at: new Date().toISOString() }).eq('id', m.user_id);
                            }
                        }
                    }
                    const { error: expErr } = await supabase
                        .from('users')
                        .update({
                            plan: 'free',
                            effective_tier: 'free',
                            subscription_status: 'expired',
                            subscription_ends_at: null,
                            team_id: null,
                            updated_at: new Date().toISOString(),
                        })
                        .eq('lemon_subscription_id', subscriptionId);
                    if (expErr) console.error('[Webhook] Expired status update error:', expErr);
                    break;
                }

                if (!existingUser) {
                    // No trusted target. We only ever provision a row keyed by the
                    // trusted supabase_user_id — never by the payload email (SB-07).
                    if (!customUserId) {
                        console.error('[Webhook] No trusted supabase_user_id in custom_data and no subscription link; refusing to provision by email');
                        return new Response(JSON.stringify({ error: 'Missing supabase_user_id in checkout custom_data' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
                    }
                    const { error: insertError } = await supabase
                        .from('users')
                        .insert({
                            id: customUserId,
                            email: customerEmail,
                            plan: isActive ? (isWorkforce ? 'workforce' : 'pro') : 'free',
                            effective_tier: isActive ? (isWorkforce ? 'workforce' : 'pro') : 'free',
                            lemon_variant_id: variantId || null,
                            lemon_subscription_id: subscriptionId,
                            lemon_customer_id: String(data?.customer_id),
                            subscription_status: status,
                            subscription_ends_at: renewsAt || endsAt,
                            customer_portal_url: data?.urls?.customer_portal || null,
                        });
                    if (insertError) {
                        console.error('[Webhook] Insert error:', insertError);
                        return new Response(JSON.stringify({ error: 'Database insert error' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
                    }
                    if (isActive && isWorkforce) {
                        const newUserId = customUserId;
                        {
                            const { data: existingTeam } = await supabase.from('teams').select('id').eq('lemonsqueezy_subscription_id', subscriptionId).maybeSingle();
                            if (!existingTeam) {
                                const { error: teamErr } = await supabase.from('teams').insert({
                                    owner_user_id: newUserId,
                                    lemonsqueezy_subscription_id: subscriptionId,
                                    name: `Team ${(customerEmail || 'workspace').split('@')[0]}`,
                                    tier: 'workforce',
                                    seat_limit: 5,
                                    extra_seats: 0,
                                    active: true,
                                });
                                if (teamErr) console.error('[Webhook] Team insert error:', teamErr);
                            }
                        }
                    }
                } else {
                    // Active / trial: set paid tier. Other non-terminal states (e.g. past_due, paused): update status and period hints but do NOT downgrade to free.
                    const paidPlan = isWorkforce ? 'workforce' : 'pro';
                    const plan = isActive ? paidPlan : undefined;
                    const effectiveTier = isActive ? paidPlan : undefined;

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
                        updateRow.plan = plan;
                        updateRow.effective_tier = effectiveTier;
                    }

                    const { error: updateError } = await supabase
                        .from('users')
                        .update(updateRow)
                        .eq('id', existingUser.id);
                    if (updateError) {
                        console.error('[Webhook] Update error:', updateError);
                        return new Response(JSON.stringify({ error: 'Database update error' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
                    }
                    if (isActive && isWorkforce) {
                        const { data: existingTeam } = await supabase.from('teams').select('id').eq('lemonsqueezy_subscription_id', subscriptionId).maybeSingle();
                        if (!existingTeam) {
                            const { error: teamInsErr } = await supabase.from('teams').insert({
                                owner_user_id: existingUser.id,
                                lemonsqueezy_subscription_id: subscriptionId,
                                name: `Team ${(customerEmail || 'workspace').split('@')[0]}`,
                                tier: 'workforce',
                                seat_limit: 5,
                                extra_seats: 0,
                                active: true,
                            });
                            if (teamInsErr) console.error('[Webhook] Team insert error:', teamInsErr);
                        } else {
                            const { error: teamUpd } = await supabase.from('teams').update({ active: true, updated_at: new Date().toISOString() }).eq('id', existingTeam.id);
                            if (teamUpd) console.error('[Webhook] Team update error:', teamUpd);
                        }
                    }
                }
                console.log(`[Webhook] Successfully processed ${eventName} for ${customerEmail}`);
                break;
            }

            case 'subscription_cancelled': {
                const endsAt = data?.ends_at || null;
                const variantIdCancelled = data?.variant_id?.toString() ?? '';
                const workforceVariantCancelled = Deno.env.get('LEMONSQUEEZY_WORKFORCE_VARIANT_ID') ?? '';
                const isWorkforceCancelled = variantIdCancelled === workforceVariantCancelled;
                const paidPlanCancelled = isWorkforceCancelled ? 'workforce' : 'pro';
                // User keeps paid features until subscription_ends_at; align plan with variant if DB was never updated on active.
                await supabase
                    .from('users')
                    .update({
                        plan: paidPlanCancelled,
                        effective_tier: paidPlanCancelled,
                        lemon_variant_id: variantIdCancelled || null,
                        subscription_status: 'cancelled',
                        subscription_ends_at: endsAt,
                        updated_at: new Date().toISOString(),
                    })
                    .eq('lemon_subscription_id', subscriptionId);
                console.log(`[Webhook] Processed ${eventName}, access until: ${endsAt}`);
                break;
            }

            case 'subscription_expired': {
                const { data: team } = await supabase.from('teams').select('id').eq('lemonsqueezy_subscription_id', subscriptionId).maybeSingle();
                if (team) {
                    await supabase.from('team_members').update({ status: 'removed' }).eq('team_id', team.id);
                    await supabase.from('teams').update({ active: false, updated_at: new Date().toISOString() }).eq('id', team.id);
                    const { data: members } = await supabase.from('team_members').select('user_id').eq('team_id', team.id);
                    for (const m of members ?? []) {
                        if (m.user_id) {
                            const { data: u } = await supabase.from('users').select('plan').eq('id', m.user_id).single();
                            await supabase.from('users').update({ team_id: null, effective_tier: u?.plan ?? 'free', updated_at: new Date().toISOString() }).eq('id', m.user_id);
                        }
                    }
                }
                const { error } = await supabase
                    .from('users')
                    .update({
                        plan: 'free',
                        effective_tier: 'free',
                        subscription_status: 'expired',
                        subscription_ends_at: null,
                        team_id: null,
                        updated_at: new Date().toISOString(),
                    })
                    .eq('lemon_subscription_id', subscriptionId);
                if (error) {
                    console.error('[Webhook] Update error:', error);
                    return new Response(JSON.stringify({ error: 'Database error' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
                }
                console.log(`[Webhook] Successfully processed ${eventName}`);
                break;
            }

            case 'subscription_payment_failed': {
                console.log(`[Webhook] Payment failed for subscription ${subscriptionId}; notify owner and grace period`);
                const { data: team } = await supabase.from('teams').select('owner_user_id').eq('lemonsqueezy_subscription_id', subscriptionId).maybeSingle();
                if (team) {
                    const { data: owner } = await supabase.from('users').select('email').eq('id', team.owner_user_id).single();
                    if (owner?.email) console.log(`[Webhook] Notify owner: ${owner.email}`);
                }
                break;
            }

            default:
                console.log(`[Webhook] Ignoring event: ${eventName}`);
        }

        return new Response(
            JSON.stringify({ received: true, event: eventName }),
            {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            }
        );

    } catch (error) {
        console.error('[Webhook] Error:', error);
        return new Response(
            JSON.stringify({ error: 'Internal server error', details: String(error) }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    }
});
