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
    const PROD_VARIANT_ID = '1216860';
    const PROD_API_KEY = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJhdWQiOiI5NGQ1OWNlZi1kYmI4LTRlYTUtYjE3OC1kMjU0MGZjZDY5MTkiLCJqdGkiOiI5ZmY2N2ZhNmNmZjhjNjRmYjM3YjdiMzA4YWVlMWQyN2Q4M2Q1ZmUxZGQxY2IzMGJiYzhhZDlhZTg3MjQyNTNiMGEwN2Q5ZTEyNmYxYWM0OCIsImlhdCI6MTc2ODM3ODUyMS41OTM4NzMsIm5iZiI6MTc2ODM3ODUyMS41OTM4NzUsImV4cCI6MTc4Mzk4NzIwMC4wMzIyNDcsInN1YiI6IjU4NjQyMTciLCJzY29wZXMiOltdfQ.0e8AimmsqG6-52fR9ass8V0Um-rUet-r75CCy7qdyn-oEnnZdvT-llsm6H_HeQ1u0hFPAy55ShjRQoSjUvez8QGbb_xI6QmQCLj4sl84iHjGRo31yFfscZmF0F2_vpcjozNyJ578wC4umQcPqSGS1ogl3bGF9RWZejWjPr8r0JuOoVXm5YFfkkIZCa1FnNWZJjpKCIq3q_aI335-lmbYYakf3LbkMPk_TzvwFKFiffBNgoPu-hIyxR8tEzFbc1q60QeszStLPQesfVI0rdAcwjJOAmxCm1h3FlkMgCR0JVaaaP8IcvSNfPgwYERpYg6O9r2Bez85un7M-SZFWtG6tqrPA3Jk_cdzoihdxOhO8Vx4frPcbtN-abvZpNuiejBtKtMOpcA4a44E138i3xY01Ql41BvsIsmDVUVwzUFZmKSwct4_JA32M-lAQKI7VGNNLKNhGzkOAuyBsET9lzL3T-zF76bA12gJCQIcDJFh-fjJISZ6W28Ct9M55rmyGR0IFsHcC5byYkZLOFinqe63ZV5d6z9DnxXPBioGKyfGYdTyASi86_cW_k28n0x5fbniXBoRMs7F00Ptv8WN-T2gjolzSe95PAr7w8UTwKSEeSpgPeETre_lXTpS-qcS0wSwNKtydyNEiSQKYvW_4vL7OXBJdrjZM1zMhkjT6z3xB64';

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
