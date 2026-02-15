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
    // Production API key (prefer LEMONSQUEEZY_API_KEY env in deployment)
    const PROD_API_KEY = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJhdWQiOiI5NGQ1OWNlZi1kYmI4LTRlYTUtYjE3OC1kMjU0MGZjZDY5MTkiLCJqdGkiOiI1MDU5NzhjZjk3OTU1Yjg4OGE1ZDJlNTMwYjQ3MzBhOWQxYzU0Y2Q2ODVjZWEyYmY2NWRhYTIyMjI0YTQyYjJmMDk2MWJkYjRhYzAwYjRkZCIsImlhdCI6MTc3MTE2MjU4My40MTc5MDUsIm5iZiI6MTc3MTE2MjU4My40MTc5MDgsImV4cCI6MTc4Njc1MjAwMC4wMjI5MjgsInN1YiI6IjU4NjQyMTciLCJzY29wZXMiOltdfQ.rphiK2zsV3BxJ7IssyRcJoWYcjBggnbFPzmNwNeESveY5iebgKR71titoYscnUw-uI5iVN42OHMs63_dru6J8Y2p-1nEhhdcY01yMnPkU6ZTR-cdOIr1gCvdgLM-PWgRWN37HsOYDPDOhhM7QWNh8y8kyRWlgeaK9cJLGqlfb3-LQ9uli0BJQ742AIvq7NedoNK90YRSH0sD1cY1erupg79oaogUtDl_YOtOlnaEx1oD5EYw3UvrVbCVTYAblOx5jdnimdz81g49VMQYsimaB1Roy_VxRD8WQXxdYdPTkdQ8lbWUymtvmJ8GsfFBImCToPln0LvqvexQNoVnQ3b64atQMl-4qjvHaWSoYRMuIkmlJKFEajxqwRhL-yFoXtnqnBwWBQI90hAI4spR1DBPeyMKcxm7GfTQseT-7JUzQAps2_TODeraG_wx3piuphAYpHL4UYboWGjs6BqHBMOAjEoKvIWZu8WEIf7iW5Axl7VCh8TuBFi2tb7bjwp0kx0RWJHVi0H8wNvB0Ayxw3QIA_AR215kHI327WdaL367kNu14bBHe-dhCdda7fiGmI1sxz8YL452GcWUEZGsaBT18ngyuqlnAij14D4d2-gLmMnCUtr_FBixlCbfyZpXbzYDkaZq0jTYsRwlhAk9G-DzM1il3Su3Z9rkXuufVT09gg4';

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
