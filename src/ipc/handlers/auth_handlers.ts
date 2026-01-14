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

    // Get workspace limit info
    ipcMain.handle("auth:get-plan-info", async () => {
        try {
            const user = SubscriptionManager.getCurrentUser();
            const canCreate = await SubscriptionManager.canCreateWorkspace();
            const workspaceDetails = await SubscriptionManager.getCurrentWorkspaceDetails();

            return {
                success: true,
                plan: user?.plan || "free",
                isLoggedIn: SubscriptionManager.isLoggedIn(),
                workspaceLimit: canCreate.maxAllowed,
                currentWorkspaceCount: canCreate.currentCount,
                canCreateWorkspace: canCreate.allowed,
                currentWorkspace: workspaceDetails,
            };
        } catch (error) {
            logger.error(`[AuthHandlers] Get plan info error:`, error);
            return {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error"
            };
        }
    });

    logger.log("[AuthHandlers] Auth IPC handlers registered");
}
