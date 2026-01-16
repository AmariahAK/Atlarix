/**
 * Auth IPC Handlers
 * ==================
 * IPC handlers for OAuth sign-in, sign-out, and session management
 */

import { ipcMain } from "electron";
import { SubscriptionManager } from "../../lib/SubscriptionManager";
import log from "electron-log";

const logger = log.scope("auth-handlers");

export function registerAuthHandlers() {
    logger.log("[AuthHandlers] Registering auth IPC handlers");

    // Initialize SubscriptionManager on startup
    SubscriptionManager.initialize().catch(err => {
        logger.error("[AuthHandlers] Failed to initialize SubscriptionManager:", err);
    });

    // Sign in with OAuth provider
    ipcMain.handle("auth:sign-in", async (_, { provider }: { provider: "google" | "github" }) => {
        logger.log(`[AuthHandlers] Sign in requested with ${provider}`);

        try {
            const result = await SubscriptionManager.signIn(provider);

            if (result.error) {
                logger.error(`[AuthHandlers] Sign in error:`, result.error);
                return { success: false, error: result.error.message };
            }

            // OAuth flow started - browser will open
            // Callback will be handled by deep link in main.ts
            return { success: true, message: "OAuth flow started, check your browser" };
        } catch (error) {
            logger.error(`[AuthHandlers] Sign in exception:`, error);
            return {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error"
            };
        }
    });

    // Sign out
    ipcMain.handle("auth:sign-out", async () => {
        logger.log("[AuthHandlers] Sign out requested");

        try {
            await SubscriptionManager.signOut();
            return { success: true };
        } catch (error) {
            logger.error(`[AuthHandlers] Sign out error:`, error);
            return {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error"
            };
        }
    });

    // Get current user
    ipcMain.handle("auth:get-current-user", async () => {
        try {
            const user = SubscriptionManager.getCurrentUser();
            return {
                success: true,
                user,
                isLoggedIn: SubscriptionManager.isLoggedIn(),
                isPro: SubscriptionManager.isPro(),
            };
        } catch (error) {
            logger.error(`[AuthHandlers] Get current user error:`, error);
            return {
                success: false,
                user: null,
                error: error instanceof Error ? error.message : "Unknown error"
            };
        }
    });

    // Check if user can create workspace
    ipcMain.handle("auth:can-create-workspace", async () => {
        try {
            const result = await SubscriptionManager.canCreateWorkspace();
            return { success: true, ...result };
        } catch (error) {
            logger.error(`[AuthHandlers] Can create workspace error:`, error);
            return {
                success: false,
                allowed: true, // Fail open - allow creation if check fails
                error: error instanceof Error ? error.message : "Unknown error"
            };
        }
    });

    // Check workspace limit (alias for frontend use)
    ipcMain.handle("auth:check-workspace-limit", async () => {
        try {
            const result = await SubscriptionManager.canCreateWorkspace();
            return {
                allowed: result.allowed,
                reason: result.reason,
                currentCount: result.currentCount,
                maxAllowed: result.maxAllowed,
            };
        } catch (error) {
            logger.error(`[AuthHandlers] Check workspace limit error:`, error);
            return { allowed: true }; // Fail open
        }
    });

    // Get workspace limit info
    ipcMain.handle("auth:get-plan-info", async () => {
        try {
            const user = SubscriptionManager.getCurrentUser();
            const canCreate = await SubscriptionManager.canCreateWorkspace();
            const workspaceDetails = await SubscriptionManager.getCurrentWorkspaceDetails();

            // Fetch subscription details from Supabase
            let subscriptionStatus: string | null = null;
            let subscriptionEndsAt: string | null = null;

            if (user?.email) {
                try {
                    const { getSupabaseClient } = await import("../../lib/auth/supabase-client");
                    const supabase = getSupabaseClient();
                    const { data } = await supabase
                        .from('users')
                        .select('subscription_status, subscription_ends_at')
                        .eq('email', user.email)
                        .single();

                    if (data) {
                        subscriptionStatus = data.subscription_status;
                        subscriptionEndsAt = data.subscription_ends_at;
                    }
                } catch (err) {
                    logger.warn("[auth:get-plan-info] Could not fetch subscription details:", err);
                }
            }

            return {
                success: true,
                plan: user?.plan || "free",
                isLoggedIn: SubscriptionManager.isLoggedIn(),
                workspaceLimit: canCreate.maxAllowed,
                currentWorkspaceCount: canCreate.currentCount,
                canCreateWorkspace: canCreate.allowed,
                currentWorkspace: workspaceDetails,
                subscriptionStatus,      // 'active' | 'cancelled' | null
                subscriptionEndsAt,      // ISO date string or null
            };
        } catch (error) {
            logger.error(`[AuthHandlers] Get plan info error:`, error);
            return {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error"
            };
        }
    });

    // Open upgrade checkout (requires OAuth sign-in)
    ipcMain.handle("auth:upgrade", async () => {
        logger.log("[AuthHandlers] Upgrade to Pro requested");

        try {
            const { openUpgradeCheckout } = await import("../../lib/lemonsqueezy");
            const result = await openUpgradeCheckout();

            if (!result.success) {
                return { success: false, error: result.error };
            }

            return { success: true, message: "Checkout opened in browser" };
        } catch (error) {
            logger.error(`[AuthHandlers] Upgrade error:`, error);
            return {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error"
            };
        }
    });

    // Refresh plan from Supabase (call after payment)
    ipcMain.handle("auth:refresh-plan", async () => {
        logger.log("[AuthHandlers] Refreshing plan from Supabase");

        try {
            const plan = await SubscriptionManager.refreshPlan();
            logger.log(`[AuthHandlers] Plan refreshed: ${plan}`);
            return { success: true, plan };
        } catch (error) {
            logger.error(`[AuthHandlers] Refresh plan error:`, error);
            return {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error"
            };
        }
    });

    // Open LemonSqueezy customer portal for subscription management
    ipcMain.handle("auth:manage-subscription", async () => {
        logger.log("[AuthHandlers] Opening subscription management portal");

        try {
            const currentUser = SubscriptionManager.getCurrentUser();
            if (!currentUser?.email) {
                return { success: false, error: "Not signed in" };
            }

            // Get the customer portal URL from the database
            const { getSupabaseClient } = await import("../../lib/auth/supabase-client");
            const supabase = getSupabaseClient();

            const { data, error } = await supabase
                .from('users')
                .select('customer_portal_url')
                .eq('email', currentUser.email)
                .single();

            const { shell } = await import("electron");

            if (error || !data?.customer_portal_url) {
                // Fallback: Open LemonSqueezy billing page with email hint
                logger.warn("[AuthHandlers] No customer portal URL found, using fallback");
                await shell.openExternal("https://app.lemonsqueezy.com/my-orders");
                return { success: true, fallback: true };
            }

            // Open user's specific customer portal (pre-authenticated link)
            logger.log("[AuthHandlers] Opening customer portal:", data.customer_portal_url);
            await shell.openExternal(data.customer_portal_url);

            return { success: true };
        } catch (error) {
            logger.error("[AuthHandlers] Manage subscription error:", error);
            return {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error"
            };
        }
    });

    // Cancel subscription via LemonSqueezy API
    ipcMain.handle("auth:cancel-subscription", async () => {
        logger.log("[AuthHandlers] Cancel subscription requested");

        try {
            const currentUser = SubscriptionManager.getCurrentUser();
            if (!currentUser?.email) {
                return { success: false, error: "Not signed in" };
            }

            // Get the subscription ID from the database
            const { getSupabaseClient } = await import("../../lib/auth/supabase-client");
            const supabase = getSupabaseClient();

            const { data, error } = await supabase
                .from('users')
                .select('lemon_subscription_id')
                .eq('email', currentUser.email)
                .single();

            if (error || !data?.lemon_subscription_id) {
                logger.error("[AuthHandlers] No subscription found to cancel");
                return { success: false, error: "No active subscription found" };
            }

            const subscriptionId = data.lemon_subscription_id;
            logger.log(`[AuthHandlers] Cancelling subscription: ${subscriptionId}`);

            // Call LemonSqueezy API to cancel
            const API_KEY = process.env.LEMONSQUEEZY_API_KEY || 'eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJhdWQiOiI5NGQ1OWNlZi1kYmI4LTRlYTUtYjE3OC1kMjU0MGZjZDY5MTkiLCJqdGkiOiI5ZmY2N2ZhNmNmZjhjNjRmYjM3YjdiMzA4YWVlMWQyN2Q4M2Q1ZmUxZGQxY2IzMGJiYzhhZDlhZTg3MjQyNTNiMGEwN2Q5ZTEyNmYxYWM0OCIsImlhdCI6MTc2ODM3ODUyMS41OTM4NzMsIm5iZiI6MTc2ODM3ODUyMS41OTM4NzUsImV4cCI6MTc4Mzk4NzIwMC4wMzIyNDcsInN1YiI6IjU4NjQyMTciLCJzY29wZXMiOltdfQ.0e8AimmsqG6-52fR9ass8V0Um-rUet-r75CCy7qdyn-oEnnZdvT-llsm6H_HeQ1u0hFPAy55ShjRQoSjUvez8QGbb_xI6QmQCLj4sl84iHjGRo31yFfscZmF0F2_vpcjozNyJ578wC4umQcPqSGS1ogl3bGF9RWZejWjPr8r0JuOoVXm5YFfkkIZCa1FnNWZJjpKCIq3q_aI335-lmbYYakf3LbkMPk_TzvwFKFiffBNgoPu-hIyxR8tEzFbc1q60QeszStLPQesfVI0rdAcwjJOAmxCm1h3FlkMgCR0JVaaaP8IcvSNfPgwYERpYg6O9r2Bez85un7M-SZFWtG6tqrPA3Jk_cdzoihdxOhO8Vx4frPcbtN-abvZpNuiejBtKtMOpcA4a44E138i3xY01Ql41BvsIsmDVUVwzUFZmKSwct4_JA32M-lAQKI7VGNNLKNhGzkOAuyBsET9lzL3T-zF76bA12gJCQIcDJFh-fjJISZ6W28Ct9M55rmyGR0IFsHcC5byYkZLOFinqe63ZV5d6z9DnxXPBioGKyfGYdTyASi86_cW_k28n0x5fbniXBoRMs7F00Ptv8WN-T2gjolzSe95PAr7w8UTwKSEeSpgPeETre_lXTpS-qcS0wSwNKtydyNEiSQKYvW_4vL7OXBJdrjZM1zMhkjT6z3xB64';

            const response = await fetch(`https://api.lemonsqueezy.com/v1/subscriptions/${subscriptionId}`, {
                method: 'DELETE',
                headers: {
                    'Accept': 'application/vnd.api+json',
                    'Content-Type': 'application/vnd.api+json',
                    'Authorization': `Bearer ${API_KEY}`,
                },
            });

            if (!response.ok) {
                const errorText = await response.text();
                logger.error("[AuthHandlers] LemonSqueezy cancel error:", errorText);
                return { success: false, error: "Failed to cancel subscription" };
            }

            const result = await response.json();
            const endsAt = result.data?.attributes?.ends_at;
            logger.log("[AuthHandlers] Subscription cancelled successfully. Ends at:", endsAt);

            // Update local database - keep plan as 'pro' until ends_at, just update status
            await supabase
                .from('users')
                .update({
                    // Keep plan as 'pro' - LemonSqueezy webhook will set to 'free' when it actually expires
                    subscription_status: 'cancelled',
                    subscription_ends_at: endsAt || null,
                    updated_at: new Date().toISOString(),
                })
                .eq('email', currentUser.email);

            // Emit plan-changed event to update UI immediately
            const { BrowserWindow } = await import("electron");
            const windows = BrowserWindow.getAllWindows();
            logger.log(`[AuthHandlers] Emitting plan-changed to ${windows.length} window(s)`);
            for (const win of windows) {
                win.webContents.send('plan-changed', {
                    plan: 'pro', // Still pro until expiry
                    subscriptionStatus: 'cancelled',
                    subscriptionEndsAt: endsAt,
                });
                logger.log(`[AuthHandlers] Sent plan-changed event with status=cancelled, endsAt=${endsAt}`);
            }

            // Format the end date for display
            let endDateDisplay = "the end of your billing period";
            if (endsAt) {
                const endDate = new Date(endsAt);
                endDateDisplay = endDate.toLocaleDateString('en-US', {
                    month: 'long', day: 'numeric', year: 'numeric'
                });
            }

            return {
                success: true,
                endsAt,
                message: `Subscription cancelled. You'll have Pro access until ${endDateDisplay}.`
            };
        } catch (error) {
            logger.error("[AuthHandlers] Cancel subscription error:", error);
            return {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error"
            };
        }
    });

    logger.log("[AuthHandlers] Auth IPC handlers registered");
}
