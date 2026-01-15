/**
 * SubscriptionManager - User Plan & Workspace Gating
 * ===================================================
 * Manages user authentication state and subscription limits.
 * Integrates with Supabase Auth for OAuth.
 * 
 * Created: v1.0.0 (2026-01-14)
 */

import { db } from '../db';
import { apps } from '../db/schema';
import log from 'electron-log';
import {
    getSession,
    getUser,
    getUserPlan,
    signInWithOAuth,
    signOut,
    onAuthStateChange,
    handleAuthCallback,
    type OAuthProvider,
} from './auth/supabase-client';
import type { Session, User } from '@supabase/supabase-js';

const logger = log.scope('subscription');

// ============================================
// TYPES
// ============================================

export type UserPlan = 'free' | 'pro';

export interface UserSession {
    id: string;
    email: string;
    name?: string;
    avatar?: string;
    plan: UserPlan;
}

// ============================================
// CONFIGURATION
// ============================================

/** Free tier limits */
export const PLAN_LIMITS = {
    free: {
        maxWorkspaces: 1,
        // Incognito chats: unlimited (no workspace context)
        // All tools available for one workspace
    },
    pro: {
        maxWorkspaces: Infinity,
        // All features unlimited
    },
};

// ============================================
// SUBSCRIPTION MANAGER
// ============================================

export class SubscriptionManager {
    /** Current cached session */
    private static session: UserSession | null = null;

    /** Cached workspace count */
    private static cachedWorkspaceCount: number | null = null;

    /** Auth state listener cleanup function */
    private static authCleanup: (() => void) | null = null;

    // ========================================
    // INITIALIZATION
    // ========================================

    /**
     * Initialize the subscription manager - call on app start
     */
    static async initialize(): Promise<void> {
        logger.log('[SubscriptionManager] Initializing...');

        // Check for existing session
        const supabaseSession = await getSession();
        if (supabaseSession?.user) {
            await this.updateSession(supabaseSession);
        }

        // Listen for auth state changes
        this.authCleanup = onAuthStateChange(async (session) => {
            if (session) {
                await this.updateSession(session);
            } else {
                this.session = null;
                logger.log('[SubscriptionManager] User signed out');
            }
        });

        logger.log('[SubscriptionManager] Initialized');
    }

    /**
     * Update local session from Supabase session
     */
    private static async updateSession(supabaseSession: Session): Promise<void> {
        const user = supabaseSession.user;
        const plan = await getUserPlan(user.id);

        // Extract avatar from user_metadata (Google provides it as avatar_url or picture)
        const userMeta = user.user_metadata || {};
        const avatar = userMeta.avatar_url || userMeta.picture || undefined;
        const name = userMeta.full_name || userMeta.name || user.email?.split('@')[0] || 'User';

        this.session = {
            id: user.id,
            email: user.email || '',
            name,
            avatar,
            plan,
        };

        this.cachedWorkspaceCount = null; // Clear cache
        logger.log(`[SubscriptionManager] Session updated: ${user.email} (${plan})`, { avatar: !!avatar, name });

        // Subscribe to realtime plan changes for instant Pro activation
        if (user.email) {
            this.setupRealtimeSubscription(user.email);
        }
    }

    /**
     * Setup realtime subscription for plan changes
     */
    private static realtimeCleanup: (() => void) | null = null;

    private static setupRealtimeSubscription(email: string): void {
        // Import dynamically to avoid circular deps
        import('./auth/supabase-client').then(({ subscribeToPlanChanges }) => {
            // Cleanup any existing subscription
            if (this.realtimeCleanup) {
                this.realtimeCleanup();
            }

            this.realtimeCleanup = subscribeToPlanChanges(email, (newPlan, oldPlan) => {
                logger.log(`[SubscriptionManager] 🎉 Plan changed via realtime: ${oldPlan} → ${newPlan}`);

                if (this.session) {
                    this.session = { ...this.session, plan: newPlan };

                    // Notify the frontend about the plan change
                    const { BrowserWindow } = require('electron');
                    const windows = BrowserWindow.getAllWindows();
                    windows.forEach((win: any) => {
                        win.webContents.send('plan-changed', { plan: newPlan, previousPlan: oldPlan });
                    });
                }
            });
        });
    }

    // ========================================
    // AUTHENTICATION
    // ========================================

    /**
     * Get current user session
     */
    static getCurrentUser(): UserSession | null {
        return this.session;
    }

    /**
     * Check if user is logged in
     */
    static isLoggedIn(): boolean {
        return this.session !== null;
    }

    /**
     * Get current user's plan
     * Defaults to 'free' if not logged in
     */
    static getLocalUserPlan(): UserPlan {
        return this.session?.plan || 'free';
    }

    /**
     * Check if user has Pro plan
     */
    static isPro(): boolean {
        return this.getLocalUserPlan() === 'pro';
    }

    /**
     * Refresh user plan from Supabase
     * Call this after payment to detect plan upgrades
     */
    static async refreshPlan(): Promise<UserPlan> {
        if (!this.session) {
            logger.log('[SubscriptionManager] Cannot refresh plan - not logged in');
            return 'free';
        }

        const newPlan = await getUserPlan(this.session.id);

        if (newPlan !== this.session.plan) {
            logger.log(`[SubscriptionManager] Plan changed: ${this.session.plan} → ${newPlan}`);
            this.session = { ...this.session, plan: newPlan };
        }

        return newPlan;
    }

    /**
     * Start OAuth flow with Google or GitHub
     */
    static async signIn(provider: OAuthProvider): Promise<{ error: Error | null }> {
        return signInWithOAuth(provider);
    }

    /**
     * Sign out current user
     */
    static async signOut(): Promise<void> {
        await signOut();
        this.session = null;
    }

    /**
     * Handle OAuth callback from deep link
     */
    static async handleOAuthCallback(url: string): Promise<{
        success: boolean;
        user: UserSession | null;
        error: Error | null;
    }> {
        const result = await handleAuthCallback(url);

        if (result.error) {
            return { success: false, user: null, error: result.error };
        }

        if (result.session) {
            await this.updateSession(result.session);
        }

        return { success: true, user: this.session, error: null };
    }

    // ========================================
    // WORKSPACE GATING
    // ========================================

    /**
     * Check if user can create a new workspace
     * Free: 1 workspace max
     * Pro: Unlimited
     */
    static async canCreateWorkspace(): Promise<{ allowed: boolean; reason?: string; currentCount: number; maxAllowed: number }> {
        const plan = this.getLocalUserPlan();
        const limit = PLAN_LIMITS[plan].maxWorkspaces;

        // Get current workspace count
        const workspaceCount = await this.getWorkspaceCount();

        if (workspaceCount >= limit) {
            return {
                allowed: false,
                reason: `Free plan allows ${limit} workspace. Upgrade to Pro for unlimited workspaces.`,
                currentCount: workspaceCount,
                maxAllowed: limit,
            };
        }

        return {
            allowed: true,
            currentCount: workspaceCount,
            maxAllowed: limit,
        };
    }

    /**
     * Get current workspace count from database
     */
    static async getWorkspaceCount(): Promise<number> {
        // Use cache if available
        if (this.cachedWorkspaceCount !== null) {
            return this.cachedWorkspaceCount;
        }

        try {
            const allWorkspaces = await db.select().from(apps);
            this.cachedWorkspaceCount = allWorkspaces.length;
            return this.cachedWorkspaceCount;
        } catch (error) {
            logger.error('[SubscriptionManager] Failed to get workspace count:', error);
            return 0;
        }
    }

    /**
     * Clear workspace count cache (call after create/delete workspace)
     */
    static clearWorkspaceCache(): void {
        this.cachedWorkspaceCount = null;
    }

    /**
     * Get details about current workspace for upgrade modal
     */
    static async getCurrentWorkspaceDetails(): Promise<{
        id: number;
        name: string;
        diagramCount: number;
    } | null> {
        try {
            const workspace = await db.query.apps.findFirst({
                with: {
                    workspaceDiagrams: true,
                },
            });

            if (!workspace) return null;

            return {
                id: workspace.id,
                name: workspace.name,
                diagramCount: (workspace as any).workspaceDiagrams?.length || 0,
            };
        } catch (error) {
            logger.error('[SubscriptionManager] Failed to get workspace details:', error);
            return null;
        }
    }

    // ========================================
    // INCOGNITO CHAT (NO GATING)
    // ========================================

    /**
     * Incognito chats are always allowed and free
     * They have limited tools: web_search, read_url, get_current_time
     */
    static canStartIncognitoChat(): boolean {
        return true; // Always allowed, no limits
    }

    /**
     * Get tools available for incognito chat (no workspace)
     * These are free and unlimited for all users
     */
    static getIncognitoTools(): string[] {
        return [
            'web_search',
            'read_url',
            'get_current_time',
            'get_current_date',
        ];
    }
}

export default SubscriptionManager;
