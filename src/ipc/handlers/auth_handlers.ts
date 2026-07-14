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

    // SubscriptionManager.initialize() runs from main after app.ready (see main.ts onReady)

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
                const { chatSessions } = await import("@/db/schema");
                const { inArray } = await import("drizzle-orm");

                if (allWorkspaces.length > 0) {
                    const workspaceIds = allWorkspaces.map(a => a.id);
                    logger.log(`[AuthHandlers] Cleaning up dependent records for workspaces: ${workspaceIds.join(',')}`);
                    try { db.delete(chatSessions).where(inArray(chatSessions.workspaceId, workspaceIds)).run(); } catch (e) { console.error('Error deleting sessions:', e); }

                    // Finally delete apps
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
                // A16/L-1: fail CLOSED — a thrown check must not become a free
                // pass past the free-tier cap. The UI surfaces the reason so the
                // user can retry once the plan check recovers.
                allowed: false,
                reason: "Couldn't verify your plan limit — please try again.",
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
            // A16/L-1: fail CLOSED (was `allowed: true`).
            return {
                allowed: false,
                reason: "Couldn't verify your plan limit — please try again.",
            };
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

            // Subscription details — TTL-cached + invalidated on realtime plan
            // change, so repeated get-plan-info calls don't each hit Supabase.
            let subscriptionStatus: string | null = null;
            let subscriptionEndsAt: string | null = null;

            if (user?.email) {
                const { getSubscriptionDetails } = await import("../../lib/auth/supabase-client");
                const details = await getSubscriptionDetails(user.email);
                subscriptionStatus = details.status;
                subscriptionEndsAt = details.endsAt;
            }

            return {
                success: true,
                plan: user
                    ? SubscriptionManager.getEffectiveTier()
                    : "free",
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

    // PAYG: open a credit top-up checkout ($10 minimum). Amount in cents.
    ipcMain.handle("auth:add-credit", async (_e, amountCents: number) => {
        logger.log("[AuthHandlers] Add credit requested");
        try {
            const { openCreditCheckout } = await import("../../lib/lemonsqueezy");
            const result = await openCreditCheckout(Number(amountCents));
            if (!result.success) return { success: false, error: result.error };
            return { success: true, message: "Credit checkout opened in browser" };
        } catch (error) {
            logger.error(`[AuthHandlers] Add credit error:`, error);
            return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
        }
    });

    // PAYG: read the user's Atlarix Core credit balance (integer cents).
    ipcMain.handle("auth:get-credit-balance", async () => {
        try {
            const { getSupabaseClient } = await import("../../lib/auth/supabase-client");
            const supabase = getSupabaseClient();
            const { data, error } = await supabase.rpc("get_credit_balance");
            if (error) return { ok: false, error: error.message, balanceCents: 0 };
            const row = data as { ok?: boolean; balance_cents?: number } | null;
            return { ok: row?.ok !== false, balanceCents: Number(row?.balance_cents ?? 0) };
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : "Unknown error", balanceCents: 0 };
        }
    });

    // PAYG: claim the one-time $1 signup trial credit (idempotent server-side).
    ipcMain.handle("auth:claim-signup-credit", async () => {
        try {
            const { getSupabaseClient } = await import("../../lib/auth/supabase-client");
            const supabase = getSupabaseClient();
            const { data, error } = await supabase.rpc("claim_signup_credit");
            if (error) return { ok: false, error: error.message };
            const row = data as { ok?: boolean; balance_cents?: number; granted?: boolean } | null;
            return { ok: row?.ok !== false, balanceCents: Number(row?.balance_cents ?? 0), granted: row?.granted === true };
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : "Unknown error" };
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

            // Cancel server-side via the cancel-subscription edge function. The
            // LEMONSQUEEZY_API_KEY no longer lives in the client (A2); the function
            // looks the subscription up by the verified user id and cancels it. The
            // billing webhook then reconciles subscription_status / ends_at on the
            // users row (which the client is not allowed to write directly anyway).
            const { getSupabaseClient } = await import("../../lib/auth/supabase-client");
            const supabase = getSupabaseClient();

            const { data: cancelResult, error: cancelError } = await supabase.functions.invoke(
                "cancel-subscription",
                { body: {} },
            );

            if (cancelError || !(cancelResult as { success?: boolean })?.success) {
                logger.error("[AuthHandlers] cancel-subscription failed:", cancelError?.message);
                const code = (cancelResult as { error?: string })?.error;
                return {
                    success: false,
                    error:
                        code === "no_active_subscription"
                            ? "No active subscription found"
                            : "Failed to cancel subscription",
                };
            }

            const endsAt = (cancelResult as { endsAt?: string | null }).endsAt ?? null;
            logger.log("[AuthHandlers] Subscription cancelled. Ends at:", endsAt);

            await SubscriptionManager.refreshPlan();
            const effectiveTier = SubscriptionManager.getEffectiveTier();
            const sessionPlan = SubscriptionManager.getLocalUserPlan();

            const { BrowserWindow } = await import("electron");
            const windows = BrowserWindow.getAllWindows();
            for (const win of windows) {
                win.webContents.send('plan-changed', {
                    plan: sessionPlan,
                    effectiveTier,
                    subscriptionStatus: 'cancelled',
                    subscriptionEndsAt: endsAt,
                });
            }

            // Delayed verification check (safety net) - re-confirm after 3s
            setTimeout(async () => {
                try {
                    await SubscriptionManager.refreshPlan();
                    const { data: verifyData } = await supabase
                        .from('users')
                        .select('subscription_status, subscription_ends_at')
                        .eq('email', currentUser.email)
                        .single();

                    if (verifyData) {
                        logger.log("[AuthHandlers] Verification check:", verifyData);
                        const { BrowserWindow: BW } = require('electron');
                        BW.getAllWindows().forEach((win: any) => {
                            win.webContents.send('plan-changed', {
                                plan: SubscriptionManager.getLocalUserPlan(),
                                effectiveTier: SubscriptionManager.getEffectiveTier(),
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

            const tierLabel = 'Pro';
            return {
                success: true,
                endsAt,
                message: `Subscription cancelled. You'll have ${tierLabel} access until ${endDateDisplay}.`
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
