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
    getEffectiveTier,
    getHasDbStudioLegacy,
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

export type UserPlan = 'free' | 'pro' | 'workforce';

export interface UserSession {
    id: string;
    email: string;
    name?: string;
    avatar?: string;
    plan: UserPlan;
    /** v4.0: effective tier (max of own plan or team plan) */
    effectiveTier?: UserPlan;
    /** v4.0: grandfathered Pro users keep DB Studio access */
    hasDbStudioLegacy?: boolean;
}

// ============================================
// CONFIGURATION
// ============================================

/** Free tier limits */
export const PLAN_LIMITS = {
    free: {
        maxWorkspaces: 1,
    },
    pro: {
        maxWorkspaces: Infinity,
    },
    workforce: {
        maxWorkspaces: Infinity,
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

    private static initPromise: Promise<void> | null = null;

    /**
     * Initialize the subscription manager - call on app start (after restoreAuthSessionOnStartup).
     * Idempotent: concurrent callers share one initialization.
     */
    static async initialize(): Promise<void> {
        if (this.initPromise) return this.initPromise;
        this.initPromise = (async () => {
            logger.log('[SubscriptionManager] Initializing...');

            const supabaseSession = await getSession();
            if (supabaseSession?.user) {
                await this.updateSession(supabaseSession);
            }

            if (this.authCleanup) {
                this.authCleanup();
                this.authCleanup = null;
            }
            this.authCleanup = onAuthStateChange(async (session) => {
                if (session) {
                    await this.updateSession(session);
                } else {
                    this.session = null;
                    if (this.realtimeCleanup) {
                        this.realtimeCleanup();
                        this.realtimeCleanup = null;
                    }
                    this.realtimeSubscribedEmail = null;
                    this.lastPlanFingerprint = "";
                    this.lastPlanFingerprintAt = 0;
                    logger.log('[SubscriptionManager] User signed out');
                }
            });

            logger.log('[SubscriptionManager] Initialized');
        })();
        return this.initPromise;
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

        const effectiveTier = await getEffectiveTier(user.id, plan);
        const hasDbStudioLegacy = await getHasDbStudioLegacy(user.id);

        this.session = {
            id: user.id,
            email: user.email || '',
            name,
            avatar,
            plan,
            effectiveTier,
            hasDbStudioLegacy,
        };

        this.cachedWorkspaceCount = null; // Clear cache
        logger.log(`[SubscriptionManager] Session updated: ${user.email} (${plan})`, { avatar: !!avatar, name });

        // v4.0: PostHog tier event (no PII)
        try {
            const { capture } = await import('../main/lib/analytics');
            capture('tier_identified', { tier: effectiveTier });
        } catch { /* non-fatal */ }

        // Subscribe to realtime plan changes for instant Pro activation
        if (user.email) {
            await this.setupRealtimeSubscription(user.email);
        }
    }

    /**
     * Setup realtime subscription for plan changes
     */
    private static realtimeCleanup: (() => void) | null = null;
    private static realtimeSetupPromise: Promise<void> | null = null;
    private static realtimeSubscribedEmail: string | null = null;
    private static lastPlanFingerprint = "";
    private static lastPlanFingerprintAt = 0;

    private static async setupRealtimeSubscription(email: string): Promise<void> {
        if (this.realtimeSubscribedEmail === email && this.realtimeCleanup) {
            return;
        }
        if (this.realtimeSetupPromise) {
            await this.realtimeSetupPromise;
            if (this.realtimeSubscribedEmail === email && this.realtimeCleanup) {
                return;
            }
        }
        this.realtimeSetupPromise = (async () => {
            const { subscribeToPlanChanges } = await import("./auth/supabase-client");
            if (this.realtimeCleanup) {
                this.realtimeCleanup();
                this.realtimeCleanup = null;
            }
            this.realtimeSubscribedEmail = email;
            this.realtimeCleanup = subscribeToPlanChanges(email, async (newData, oldData) => {
                const fp = `${newData.plan}|${newData.subscriptionStatus ?? ""}|${newData.subscriptionEndsAt ?? ""}|${newData.effectiveTier ?? ""}`;
                const now = Date.now();
                if (fp === this.lastPlanFingerprint && now - this.lastPlanFingerprintAt < 2000) {
                    return;
                }
                this.lastPlanFingerprint = fp;
                this.lastPlanFingerprintAt = now;

                logger.log(`[SubscriptionManager] 🎉 Subscription changed via realtime:`, {
                    plan: `${oldData.plan} → ${newData.plan}`,
                    status: `${oldData.subscriptionStatus} → ${newData.subscriptionStatus}`,
                });

                if (this.session) {
                    this.session = {
                        ...this.session,
                        plan: newData.plan,
                        effectiveTier: newData.effectiveTier ?? newData.plan,
                    };

                    try {
                        const { capture } = await import("../main/lib/analytics");
                        capture("tier_identified", { tier: this.session.effectiveTier });
                    } catch {
                        /* non-fatal */
                    }

                    const { BrowserWindow } = require("electron");
                    const windows = BrowserWindow.getAllWindows();
                    windows.forEach((win: { webContents: { send: (c: string, p: unknown) => void } }) => {
                        win.webContents.send("plan-changed", {
                            plan: newData.plan,
                            effectiveTier: newData.effectiveTier ?? newData.plan,
                            previousPlan: oldData.plan,
                            subscriptionStatus: newData.subscriptionStatus,
                            subscriptionEndsAt: newData.subscriptionEndsAt,
                        });
                    });
                }
            });
        })();
        try {
            await this.realtimeSetupPromise;
        } finally {
            this.realtimeSetupPromise = null;
        }
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
     * Check if user has Pro plan (or higher)
     */
    static isPro(): boolean {
        const p = this.getLocalUserPlan();
        return p === 'pro' || p === 'workforce';
    }

    /**
     * v4.0: Check if user has Workforce plan (effective tier)
     */
    static isWorkforce(): boolean {
        return this.getEffectiveTier() === 'workforce';
    }

    /**
     * v4.0: Effective tier (own plan or team plan, whichever is higher)
     */
    static getEffectiveTier(): UserPlan {
        return this.session?.effectiveTier ?? this.session?.plan ?? 'free';
    }

    /**
     * v4.0: Whether user has grandfathered DB Studio access (Pro before move to Workforce)
     */
    static hasDbStudioLegacy(): boolean {
        return this.session?.hasDbStudioLegacy === true;
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
        const effectiveTier = await getEffectiveTier(this.session.id, newPlan);
        const hasDbStudioLegacy = await getHasDbStudioLegacy(this.session.id);

        const changed =
            newPlan !== this.session.plan ||
            effectiveTier !== this.session.effectiveTier ||
            hasDbStudioLegacy !== this.session.hasDbStudioLegacy;

        if (changed) {
            logger.log(`[SubscriptionManager] Plan/effective tier refreshed: ${this.session.plan} → ${newPlan}, effective: ${effectiveTier}`);
            this.session = {
                ...this.session,
                plan: newPlan,
                effectiveTier,
                hasDbStudioLegacy,
            };
        }

        return effectiveTier;
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
        if (this.realtimeCleanup) {
            this.realtimeCleanup();
            this.realtimeCleanup = null;
        }
        this.realtimeSubscribedEmail = null;
        this.lastPlanFingerprint = "";
        this.lastPlanFingerprintAt = 0;
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
     * Free: 1 workspace max; Pro/Workforce: Unlimited
     */
    static async canCreateWorkspace(): Promise<{ allowed: boolean; reason?: string; currentCount: number; maxAllowed: number }> {
        const tier = this.getEffectiveTier();
        const limit = PLAN_LIMITS[tier].maxWorkspaces;

        // Get current workspace count
        const workspaceCount = await this.getWorkspaceCount();

        if (workspaceCount >= limit) {
            return {
                allowed: false,
                reason: tier === 'free'
                    ? 'Free plan allows 1 workspace. Upgrade to Pro for unlimited workspaces.'
                    : `Workspace limit reached (${limit}).`,
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
