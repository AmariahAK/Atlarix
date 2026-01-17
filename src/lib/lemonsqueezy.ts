/**
 * LemonSqueezy Integration
 * ========================
 * Handles checkout URL generation for Atlarix Pro upgrades.
 * Uses the LemonSqueezy Checkout API to dynamically create checkout sessions.
 */

import log from 'electron-log';
import { SubscriptionManager } from './SubscriptionManager';

const logger = log.scope('lemonsqueezy');

/**
 * Create a LemonSqueezy checkout session using the Checkout API
 * @param userEmail - User's email to prefill in checkout
 * @param userId - User's Supabase ID for custom data
 * @returns The checkout URL from LemonSqueezy API
 */
async function createCheckoutSession(userEmail: string, userId?: string): Promise<string | null> {
    // Production fallback values (safe to embed - these only create checkout sessions)
    const PROD_STORE_ID = '236920';
    const PROD_VARIANT_ID = '1226325';
    const PROD_API_KEY = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJhdWQiOiI5NGQ1OWNlZi1kYmI4LTRlYTUtYjE3OC1kMjU0MGZjZDY5MTkiLCJqdGkiOiJmNjk5MzEzMTcyZWM0Y2Y4MGNkOGMzM2M5YWNmN2M4MGMzMjk1OTNmMmVmMmJhOWIyZDM2NGI1Y2M2Mjk0NTM3NTI1MGE0YTRjZjcyODIwOCIsImlhdCI6MTc2ODYzMjI0Ny43MjIzNiwibmJmIjoxNzY4NjMyMjQ3LjcyMjM2MywiZXhwIjoxODk0ODM4NDAwLjAzMjkwNSwic3ViIjoiNTg2NDIxNyIsInNjb3BlcyI6W119.rBbAoHYBMUQuX7-_Ez55idtw7yV1KROP1EbrxGc3HmfWWP5wY3yW_1_PQBOubtgWApOOldGA1w-CgraLiGPEiRhaFE28d71XM8cPS6Am4_8Gls9RQYAT4aD5mue1_NmrbZg5qd1YUsEfFziIG-RjsXb3gYkXenZzFZcMUXhRa3-6U6y66p65SI8HK9TT_O6NsHTpcP129dZu6fdG1j_oSaOQLve_gA72k1cRtOnz3LheVk3nSzGxHtUffGUmC03DLj6jS71vs7S0SNZPpviyGVG8TiIxGgU_CjFOX7DbAeotXuStJOPEAYxEfvuE3Yr42O99VDvexTmrDMaH6sshbQpdqejwe6w61J0PVvSXQ6_yGO1eOUug6sVKoPL0o9coc1lKKl9QNf6Rp5ZQ3UqGJ0cdwdZVeJ4KkvEx9N9WoiSY6CgdAzC5mV46SQb1F_dXVpuxOnF4DKX2a9tqbCklu9ySQc6cqpnayITyXXXxf6ip7mUPgLi_l4y_ZdsTZLuLWlwCYoo8Y62K8XQy2UwoXD6HLL02E6dgCnytFnjGvBWNzjd9-THf62U-RRBEcwxFjD-sMPetH1MsIvmdtkQXWl7ANbvbxql3dv1dYihW4GeyOt0U-paFfzJNnMwK3qNqmYt7cP5Zlqgx7corsmiF-Q4TepTWgCAM4OcSC-uc2GE';

    const storeId = process.env.LEMONSQUEEZY_STORE_ID || PROD_STORE_ID;
    const variantId = process.env.LEMONSQUEEZY_VARIANT_ID || PROD_VARIANT_ID;
    const apiKey = process.env.LEMONSQUEEZY_API_KEY || PROD_API_KEY;

    if (!storeId || !variantId || !apiKey) {
        logger.error('Missing LemonSqueezy credentials');
        return null;
    }

    try {
        const checkoutData = {
            data: {
                type: 'checkouts',
                attributes: {
                    checkout_data: {
                        email: userEmail,
                        custom: {
                            user_id: userId || '',
                            source: 'atlarix-app',
                        },
                    },
                },
                relationships: {
                    store: {
                        data: {
                            type: 'stores',
                            id: storeId,
                        },
                    },
                    variant: {
                        data: {
                            type: 'variants',
                            id: variantId,
                        },
                    },
                },
            },
        };

        logger.info('Creating LemonSqueezy checkout session...');

        const response = await fetch('https://api.lemonsqueezy.com/v1/checkouts', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Accept': 'application/vnd.api+json',
                'Content-Type': 'application/vnd.api+json',
            },
            body: JSON.stringify(checkoutData),
        });

        if (response.status === 201) {
            const data = await response.json();
            const checkoutUrl = data?.data?.attributes?.url;

            if (checkoutUrl) {
                logger.info('Checkout session created successfully');
                return checkoutUrl;
            }
        }

        logger.error(`LemonSqueezy API error: ${response.status} - ${await response.text()}`);
        return null;
    } catch (error) {
        logger.error('Failed to create checkout session:', error);
        return null;
    }
}

/**
 * Open the upgrade checkout page
 * Returns an error message if user is not logged in
 */
export async function openUpgradeCheckout(): Promise<{ success: boolean; error?: string }> {
    const currentUser = SubscriptionManager.getCurrentUser();

    if (!currentUser) {
        logger.warn('Attempted to upgrade without being signed in');
        return {
            success: false,
            error: 'Please sign in with Google first to upgrade to Atlarix Pro.',
        };
    }

    if (!currentUser.email) {
        logger.warn('User signed in but no email available');
        return {
            success: false,
            error: 'Unable to get your email. Please sign in again.',
        };
    }

    // Create checkout session via LemonSqueezy API
    const checkoutUrl = await createCheckoutSession(currentUser.email, currentUser.id);

    if (!checkoutUrl) {
        logger.error('Failed to create checkout session');
        return {
            success: false,
            error: 'Unable to create checkout. Please try again or contact support.',
        };
    }

    logger.info(`Opening checkout for user: ${currentUser.email}`);
    logger.info(`Checkout URL: ${checkoutUrl}`);

    // Open in external browser
    const { shell } = await import('electron');
    await shell.openExternal(checkoutUrl);

    return { success: true };
}

/**
 * Check if user can access upgrade flow
 */
export function canUpgrade(): { canUpgrade: boolean; reason?: string } {
    const currentUser = SubscriptionManager.getCurrentUser();

    if (!currentUser) {
        return {
            canUpgrade: false,
            reason: 'Sign in with Google to upgrade to Atlarix Pro',
        };
    }

    const plan = SubscriptionManager.getLocalUserPlan();
    if (plan === 'pro') {
        return {
            canUpgrade: false,
            reason: 'You already have Atlarix Pro!',
        };
    }

    return { canUpgrade: true };
}
