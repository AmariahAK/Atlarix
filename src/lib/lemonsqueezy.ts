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
    const storeId = process.env.LEMONSQUEEZY_STORE_ID || '236920';
    const variantId = process.env.LEMONSQUEEZY_VARIANT_ID || '1226325';
    const apiKey = process.env.LEMONSQUEEZY_API_KEY;

    if (!apiKey) {
        logger.error('Missing LEMONSQUEEZY_API_KEY; set it in .env or GitHub Actions secrets');
        return null;
    }
    if (!storeId || !variantId) {
        logger.error('Missing LemonSqueezy store or variant ID');
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
