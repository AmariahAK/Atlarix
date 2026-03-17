/**
 * Auth IPC Handlers
 * ==================
 * IPC handlers for OAuth sign-in, sign-out, and session management
 */

import { ipcMain } from "electron";
import { SubscriptionManager } from "../../lib/SubscriptionManager";
import { getOnboardingCompleted, setOnboardingCompleted } from "../../lib/auth/supabase-client";
import log from "electron-log";
import { db } from "@/db";
import { apps } from "@/db/schema";

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

    // Sign out - also clears all workspaces for fresh start
    ipcMain.handle("auth:sign-out", async () => {
        logger.log("[AuthHandlers] Sign out requested");

        try {
            // Delete ALL workspaces on logout (fresh start)
            // wrap in try check to ensure sign out continues even if db fails
            try {
                const allWorkspaces = db.select().from(apps).all();
                logger.log(`[AuthHandlers] Deleting ${allWorkspaces.length} workspaces on logout`);

                // Manually delete dependent records to avoid FK constraints issues
                // (Prompts specifically might not have cascade set up correctly in all DBs)
                const { prompts, chats, diagrams, diagramVersions } = await import("@/db/schema");
                const { eq, inArray } = await import("drizzle-orm");

                if (allWorkspaces.length > 0) {
                    const workspaceIds = allWorkspaces.map(a => a.id);
                    logger.log(`[AuthHandlers] Cleaning up dependent records for workspaces: ${workspaceIds.join(',')}`);

                    // 1. Delete prompts (often missing FK cascade)
                    try { db.delete(prompts).where(inArray(prompts.workspaceId, workspaceIds)).run(); } catch (e) { console.error('Error deleting prompts:', e); }

                    // 2. Delete diagrams (and versions via cascade hopefully, or leave them as strict orphans)
                    try { db.delete(diagrams).where(inArray(diagrams.workspaceId, workspaceIds)).run(); } catch (e) { console.error('Error deleting diagrams:', e); }

                    // 3. Delete chats 
                    try { db.delete(chats).where(inArray(chats.appId, workspaceIds)).run(); } catch (e) { console.error('Error deleting chats:', e); }

                    // 4. Finally delete apps
                    db.delete(apps).run();
                }
            } catch (dbError) {
                logger.error("[AuthHandlers] Failed to clear workspaces on logout (proceeding with sign out anyway):", dbError);
            }

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

    // Enforce workspace limit for Free tier users
    // Called on login - removes newer workspaces if Free tier user has more than 1
    ipcMain.handle("auth:enforce-workspace-limit", async () => {
        logger.log("[AuthHandlers] Enforcing workspace limit");

        try {
            const isPro = SubscriptionManager.isPro();

            // Pro users have no limit
            if (isPro) {
                return { success: true, removed: 0 };
            }

            // Free tier: only 1 workspace allowed
            const allWorkspaces = db.select().from(apps).all();

            if (allWorkspaces.length <= 1) {
                return { success: true, removed: 0 };
            }

            // Sort by createdAt ascending (oldest first) - keep only the OLDEST one
            const sorted = [...allWorkspaces].sort((a, b) => {
                const aTime = a.createdAt instanceof Date ? a.createdAt.getTime() : 0;
                const bTime = b.createdAt instanceof Date ? b.createdAt.getTime() : 0;
                return aTime - bTime;
            });

            // Keep oldest, delete the rest
            const toKeep = sorted[0];
            const toDelete = sorted.slice(1);

            for (const workspace of toDelete) {
                if (workspace.id) {
                    logger.log(`[AuthHandlers] Deleting excess workspace: ${workspace.name} (id: ${workspace.id})`);
                    const { eq } = await import("drizzle-orm");
                    db.delete(apps).where(eq(apps.id, workspace.id)).run();
                }
            }

            logger.log(`[AuthHandlers] Removed ${toDelete.length} excess workspaces, kept: ${toKeep.name}`);
            return {
                success: true,
                removed: toDelete.length,
                keptWorkspace: toKeep.name
            };
        } catch (error) {
            logger.error(`[AuthHandlers] Enforce workspace limit error:`, error);
            return { success: false, removed: 0 };
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

    // v4.0: Open Workforce checkout ($79/mo, up to 20 seats)
    ipcMain.handle("auth:upgrade-workforce", async () => {
        logger.log("[AuthHandlers] Upgrade to Workforce requested");
        try {
            const { openWorkforceCheckout } = await import("../../lib/lemonsqueezy");
            const result = await openWorkforceCheckout();
            if (!result.success) return { success: false, error: result.error };
            return { success: true, message: "Workforce checkout opened in browser" };
        } catch (error) {
            logger.error(`[AuthHandlers] Workforce upgrade error:`, error);
            return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
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

            // Call LemonSqueezy API to cancel (same prod key as lemonsqueezy.ts)
            const API_KEY = process.env.LEMONSQUEEZY_API_KEY || 'eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJhdWQiOiI5NGQ1OWNlZi1kYmI4LTRlYTUtYjE3OC1kMjU0MGZjZDY5MTkiLCJqdGkiOiI1MDU5NzhjZjk3OTU1Yjg4OGE1ZDJlNTMwYjQ3MzBhOWQxYzU0Y2Q2ODVjZWEyYmY2NWRhYTIyMjI0YTQyYjJmMDk2MWJkYjRhYzAwYjRkZCIsImlhdCI6MTc3MTE2MjU4My40MTc5MDUsIm5iZiI6MTc3MTE2MjU4My40MTc5MDgsImV4cCI6MTc4Njc1MjAwMC4wMjI5MjgsInN1YiI6IjU4NjQyMTciLCJzY29wZXMiOltdfQ.rphiK2zsV3BxJ7IssyRcJoWYcjBggnbFPzmNwNeESveY5iebgKR71titoYscnUw-uI5iVN42OHMs63_dru6J8Y2p-1nEhhdcY01yMnPkU6ZTR-cdOIr1gCvdgLM-PWgRWN37HsOYDPDOhhM7QWNh8y8kyRWlgeaK9cJLGqlfb3-LQ9uli0BJQ742AIvq7NedoNK90YRSH0sD1cY1erupg79oaogUtDl_YOtOlnaEx1oD5EYw3UvrVbCVTYAblOx5jdnimdz81g49VMQYsimaB1Roy_VxRD8WQXxdYdPTkdQ8lbWUymtvmJ8GsfFBImCToPln0LvqvexQNoVnQ3b64atQMl-4qjvHaWSoYRMuIkmlJKFEajxqwRhL-yFoXtnqnBwWBQI90hAI4spR1DBPeyMKcxm7GfTQseT-7JUzQAps2_TODeraG_wx3piuphAYpHL4UYboWGjs6BqHBMOAjEoKvIWZu8WEIf7iW5Axl7VCh8TuBFi2tb7bjwp0kx0RWJHVi0H8wNvB0Ayxw3QIA_AR215kHI327WdaL367kNu14bBHe-dhCdda7fiGmI1sxz8YL452GcWUEZGsaBT18ngyuqlnAij14D4d2-gLmMnCUtr_FBixlCbfyZpXbzYDkaZq0jTYsRwlhAk9G-DzM1il3Su3Z9rkXuufVT09gg4';

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
            logger.log(`[AuthHandlers] Updating Supabase for email: ${currentUser.email}`);
            const { data: updateData, error: updateError, count } = await supabase
                .from('users')
                .update({
                    // Keep plan as 'pro' - LemonSqueezy webhook will set to 'free' when it actually expires
                    subscription_status: 'cancelled',
                    subscription_ends_at: endsAt || null,
                    updated_at: new Date().toISOString(),
                })
                .eq('email', currentUser.email)
                .select(); // Add select() to get the updated row back

            logger.log(`[AuthHandlers] Supabase update result:`, {
                updateData,
                updateError: updateError?.message,
                rowsUpdated: updateData?.length || 0
            });

            // Emit plan-changed event to update UI immediately
            const { BrowserWindow } = await import("electron");
            const windows = BrowserWindow.getAllWindows();
            for (const win of windows) {
                win.webContents.send('plan-changed', {
                    plan: 'pro', // Still pro until expiry
                    subscriptionStatus: 'cancelled',
                    subscriptionEndsAt: endsAt,
                });
            }

            // Delayed verification check (safety net) - re-confirm after 3s
            setTimeout(async () => {
                try {
                    const { data: verifyData } = await supabase
                        .from('users')
                        .select('subscription_status, subscription_ends_at')
                        .eq('email', currentUser.email)
                        .single();

                    if (verifyData) {
                        logger.log("[AuthHandlers] Verification check:", verifyData);
                        // Re-emit to ensure UI is in sync
                        const { BrowserWindow: BW } = require('electron');
                        BW.getAllWindows().forEach((win: any) => {
                            win.webContents.send('plan-changed', {
                                plan: 'pro',
                                subscriptionStatus: verifyData.subscription_status,
                                subscriptionEndsAt: verifyData.subscription_ends_at,
                            });
                        });
                    }
                } catch (err) {
                    logger.warn("[AuthHandlers] Verification check failed:", err);
                }
            }, 3000);

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

    // Onboarding (first-run flow state in Supabase)
    ipcMain.handle("onboarding:get-completed", async () => {
        try {
            const user = SubscriptionManager.getCurrentUser();
            if (!user?.id) return { completed: true }; // Not logged in => no onboarding
            const completed = await getOnboardingCompleted(user.id);
            return { completed };
        } catch (error) {
            logger.error("[AuthHandlers] onboarding:get-completed error:", error);
            return { completed: true }; // Fail open: skip onboarding on error
        }
    });

    ipcMain.handle("onboarding:set-completed", async (_, value: boolean) => {
        try {
            const user = SubscriptionManager.getCurrentUser();
            if (!user?.id) return { success: false };
            await setOnboardingCompleted(user.id, value);
            return { success: true };
        } catch (error) {
            logger.error("[AuthHandlers] onboarding:set-completed error:", error);
            return { success: false };
        }
    });

    logger.log("[AuthHandlers] Auth IPC handlers registered");
}
