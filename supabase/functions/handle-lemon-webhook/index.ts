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

    return signature === expectedSignature;
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

        console.log(`[Webhook] Event type: ${eventName}`);

        // Get user email from event
        const customerEmail = data?.user_email;
        if (!customerEmail) {
            console.error('[Webhook] No user email in event');
            return new Response(JSON.stringify({ error: 'No user email' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        console.log(`[Webhook] Customer email: ${customerEmail}`);

        // Initialize Supabase client with service role key
        if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
            console.error('[Webhook] Missing Supabase credentials');
            return new Response(JSON.stringify({ error: 'Server configuration error' }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

        // Handle different event types
        switch (eventName) {
            case 'subscription_created':
            case 'subscription_updated': {
                const status = data?.status; // active, cancelled, expired, on_trial, paused, past_due
                const isActive = ['active', 'on_trial'].includes(status);
                const renewsAt = data?.renews_at || null; // Next billing date for active subscriptions

                console.log(`[Webhook] Status: ${status}, isActive: ${isActive}, renewsAt: ${renewsAt}`);

                // First, check if user exists
                const { data: existingUser, error: fetchError } = await supabase
                    .from('users')
                    .select('id')
                    .eq('email', customerEmail)
                    .single();

                if (fetchError && fetchError.code !== 'PGRST116') {
                    console.error('[Webhook] Error fetching user:', fetchError);
                }

                if (!existingUser) {
                    // User doesn't exist, create them
                    console.log(`[Webhook] Creating new user: ${customerEmail}`);
                    const { error: insertError } = await supabase
                        .from('users')
                        .insert({
                            email: customerEmail,
                            plan: isActive ? 'pro' : 'free',
                            lemon_subscription_id: String(event.data.id),
                            lemon_customer_id: String(data?.customer_id),
                            subscription_status: status,
                            subscription_ends_at: renewsAt, // Store renewal date
                            customer_portal_url: data?.urls?.customer_portal || null,
                        });

                    if (insertError) {
                        console.error('[Webhook] Insert error:', insertError);
                        return new Response(JSON.stringify({ error: 'Database insert error' }), {
                            status: 500,
                            headers: { 'Content-Type': 'application/json' }
                        });
                    }
                } else {
                    // Update existing user
                    console.log(`[Webhook] Updating user: ${customerEmail} to ${isActive ? 'pro' : 'free'}`);
                    const { error: updateError } = await supabase
                        .from('users')
                        .update({
                            plan: isActive ? 'pro' : 'free',
                            lemon_subscription_id: String(event.data.id),
                            lemon_customer_id: String(data?.customer_id),
                            subscription_status: status,
                            subscription_ends_at: renewsAt, // Store renewal date
                            customer_portal_url: data?.urls?.customer_portal || null,
                            updated_at: new Date().toISOString(),
                        })
                        .eq('email', customerEmail);

                    if (updateError) {
                        console.error('[Webhook] Update error:', updateError);
                        return new Response(JSON.stringify({ error: 'Database update error' }), {
                            status: 500,
                            headers: { 'Content-Type': 'application/json' }
                        });
                    }
                }

                console.log(`[Webhook] Successfully processed ${eventName} for ${customerEmail}`);
                break;
            }

            case 'subscription_cancelled': {
                // Cancelled = user cancelled but still has access until ends_at
                console.log(`[Webhook] Subscription ${event.data.id} cancelled (retains access until ends_at)`);

                const endsAt = data?.ends_at || null;

                const { error } = await supabase
                    .from('users')
                    .update({
                        // Keep plan as 'pro' until it actually expires
                        subscription_status: 'cancelled',
                        subscription_ends_at: endsAt,
                        updated_at: new Date().toISOString(),
                    })
                    .eq('lemon_subscription_id', String(event.data.id));

                if (error) {
                    console.error('[Webhook] Update error:', error);
                }

                console.log(`[Webhook] Successfully processed ${eventName}, ends_at: ${endsAt}`);
                break;
            }

            case 'subscription_expired': {
                // Expired = subscription has actually ended, now revoke access
                console.log(`[Webhook] Subscription ${event.data.id} expired - downgrading to free`);

                const { error } = await supabase
                    .from('users')
                    .update({
                        plan: 'free',
                        subscription_status: 'expired',
                        subscription_ends_at: null,
                        updated_at: new Date().toISOString(),
                    })
                    .eq('lemon_subscription_id', String(event.data.id));

                if (error) {
                    console.error('[Webhook] Update error:', error);
                    return new Response(JSON.stringify({ error: 'Database error' }), {
                        status: 500,
                        headers: { 'Content-Type': 'application/json' }
                    });
                }

                console.log(`[Webhook] Successfully processed ${eventName}`);
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
