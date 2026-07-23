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
    getUserPlan,
    getEffectiveTier,
    invalidatePlanCaches,
    signInWithOAuth,
    signOut,
    onAuthStateChange,
    handleAuthCallback,
    type OAuthProvider,
} from './auth/supabase-client';
import type { Session } from '@supabase/supabase-js';

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
    /** Effective tier — always equals `plan` since the Team tier was removed. */
    effectiveTier?: UserPlan;
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
            this.authCleanup = onAuthStateChange(async (session, event) => {
                if (session) {
                    // A routine hourly TOKEN_REFRESHED for the SAME already-loaded
                    // user changes nothing about the plan — skip the users-table
                    // re-reads it would otherwise trigger (the realtime sub catches
                    // real plan changes). Only the token rotated, which supabase-js
                    // manages internally.
                    if (event === 'TOKEN_REFRESHED' && this.session?.id === session.user.id) {
                        return;
                    }
                    await this.updateSession(session);
                } else {
                    this.session = null;
                    invalidatePlanCaches();
                    if (this.realtimeCleanup) {
                        this.realtimeCleanup();
                        this.realtimeCleanup = null;
                    }
                    this.realtimeSubscribedEmail = null;
                    this.lastPlanFingerprint = "";
                    this.lastPlanFingerprintAt = 0;
                    // Drop the offline entitlement too — a signed-out machine must
                    // not keep honouring the previous account's plan.
                    void import('../main/settings')
                        .then((m) => m.writeSettings({ lastKnownEntitlement: undefined }))
                        .catch(() => { /* non-fatal */ });
                    // Stop attributing events to the signed-out user; fall back
                    // to this install's anonymous id.
                    void import('../main/lib/analytics')
                        .then((m) => m.clearIdentifiedUser())
                        .catch(() => { /* non-fatal */ });
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

        // Extract avatar from user_metadata (Google provides it as avatar_url or picture)
        const userMeta = user.user_metadata || {};
        const avatar = userMeta.avatar_url || userMeta.picture || undefined;
        const name = userMeta.full_name || userMeta.name || user.email?.split('@')[0] || 'User';

        // WHO the user is must not depend on resolving WHAT they're entitled to.
        // These two lookups sat above the `this.session` assignment, so a throw
        // from either (offline, a transient Supabase error) left the session null
        // — and `broadcastSessionState()` early-returns on a null session, so the
        // renderer never learned it was signed in. `getUserPlan` already degrades
        // to 'free'/last-known-entitlement internally rather than throwing; this
        // guard covers the rest so identity always survives.
        let plan: UserPlan = 'free';
        let effectiveTier: UserPlan = 'free';
        try {
            plan = await getUserPlan(user.id);
            effectiveTier = await getEffectiveTier(user.id, plan);
        } catch (err) {
            logger.warn(
                '[SubscriptionManager] Plan lookup failed — keeping the session, defaulting to free:',
                err instanceof Error ? err.message : err,
            );
        }

        this.session = {
            id: user.id,
            email: user.email || '',
            name,
            avatar,
            plan,
            effectiveTier,
        };

        this.cachedWorkspaceCount = null; // Clear cache
        logger.log(`[SubscriptionManager] Session updated: ${user.email} (${plan})`, { avatar: !!avatar, name });

        // Remember what the SERVER just confirmed, so a later launch without a
        // network doesn't silently downgrade a paying user to free. Written only
        // on this authoritative path; read only when a request fails.
        await this.persistEntitlement(user.id, plan, effectiveTier, user.email ?? undefined);

        // Analytics identity. This MUST run before the tier event so the event
        // is attributed to the user rather than to this install's anonymous id.
        //
        // `user.id` (not the email) stays the identity KEY — emails change, and
        // keying on one would fork the person on every address change. Email and
        // name ride along as person PROPERTIES so accounts are recognisable in
        // the PostHog UI, and so internal accounts can be filtered there by
        // email rather than hardcoding addresses into a shipped binary.
        try {
            const { identifyUser, capture } = await import('../main/lib/analytics');
            identifyUser(user.id, {
                email: user.email,
                name,
                tier: effectiveTier,
                plan,
            });
            capture('tier_identified', { tier: effectiveTier });
        } catch { /* non-fatal */ }

        // Subscribe to realtime plan changes for instant Pro activation
        if (user.email) {
            await this.setupRealtimeSubscription(user.email);
        }
    }

    /**
     * Push the current session's plan to every window over the EXISTING
     * `plan-changed` channel.
     *
     * Needed because auth init now runs AFTER `createWindow()` (so the network
     * can never delay the window). The renderer therefore mounts signed-out and
     * has nothing to re-trigger on; this is what corrects it once the session
     * actually resolves. No-op when signed out — the renderer's initial
     * signed-out state is already right.
     */
    static broadcastSessionState(): void {
        const s = this.session;
        if (!s) return;
        this.broadcastPlanChanged({
            plan: s.plan,
            effectiveTier: s.effectiveTier ?? s.plan,
            previousPlan: undefined,
            subscriptionStatus: undefined,
            subscriptionEndsAt: undefined,
        });
    }

    /** Single place that emits `plan-changed`, so the payload can't drift. */
    private static broadcastPlanChanged(payload: {
        plan: UserPlan;
        effectiveTier: UserPlan;
        previousPlan?: UserPlan;
        subscriptionStatus?: string | null;
        subscriptionEndsAt?: string | null;
    }): void {
        try {
            const { BrowserWindow } = require("electron");
            for (const win of BrowserWindow.getAllWindows()) {
                (win as { webContents: { send: (c: string, p: unknown) => void } })
                    .webContents.send("plan-changed", payload);
            }
        } catch (e) {
            logger.warn('[SubscriptionManager] plan-changed broadcast failed', e);
        }
    }

    /**
     * Store the server-confirmed entitlement for offline use. The expiry date
     * comes from the same `users` row the plan does; without one the record is
     * deliberately un-honourable (see resolveOfflineEntitlement).
     */
    private static async persistEntitlement(
        userId: string,
        plan: UserPlan,
        effectiveTier: UserPlan,
        email?: string,
    ): Promise<void> {
        try {
            const { readSettings, writeSettings } = await import('../main/settings');
            let subscriptionEndsAt: string | null = null;
            if (email) {
                const { getSubscriptionDetails } = await import('./auth/supabase-client');
                subscriptionEndsAt = (await getSubscriptionDetails(email)).endsAt;
            }
            void readSettings; // (read not needed — this key is written wholesale)
            writeSettings({
                lastKnownEntitlement: {
                    userId,
                    plan,
                    effectiveTier,
                    subscriptionEndsAt,
                    cachedAt: Date.now(),
                },
            });
        } catch (e) {
            // Bookkeeping must never break sign-in.
            logger.warn('[SubscriptionManager] persistEntitlement failed (non-fatal)', e);
        }
    }

    /**
     * Setup realtime subscription for plan changes
     */
    private static realtimeCleanup: (() => void) | null = null;
    private static realtimeSetupPromise: Promise<void> | null = null;
    private static realtimeSubscribedEmail: string | null = null;
    private static realtimePausedEmail: string | null = null;
    private static lastPlanFingerprint = "";
    private static lastPlanFingerprintAt = 0;

    /**
     * Idle-pause: close the always-open plan-change realtime channel when the
     * main window is hidden/blurred so its keepalive stops pinging Supabase. The
     * subscribed email is remembered for resume. No-op if already closed.
     */
    static pauseRealtime(): void {
        if (this.realtimeCleanup) {
            this.realtimePausedEmail = this.realtimeSubscribedEmail;
            this.realtimeCleanup();
            this.realtimeCleanup = null;
            this.realtimeSubscribedEmail = null;
            logger.log('[SubscriptionManager] Realtime paused (window idle)');
        }
    }

    /**
     * Resume on window focus: reopen the channel and drop cached plan state so a
     * plan change that happened while idle (and thus missed the closed channel) is
     * picked up on the next read. No-op if not signed in or already open.
     */
    static async resumeRealtime(): Promise<void> {
        const email = this.realtimePausedEmail ?? this.session?.email ?? null;
        this.realtimePausedEmail = null;
        if (email && !this.realtimeCleanup) {
            invalidatePlanCaches();
            await this.setupRealtimeSubscription(email);
            logger.log('[SubscriptionManager] Realtime resumed (window focus)');
        }
    }

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
                // Plan changed upstream — drop the cached tier so any later
                // getEffectiveTier reads the new value rather than the stale one.
                invalidatePlanCaches();

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

                    this.broadcastPlanChanged({
                        plan: newData.plan,
                        effectiveTier: newData.effectiveTier ?? newData.plan,
                        previousPlan: oldData.plan,
                        subscriptionStatus: newData.subscriptionStatus,
                        subscriptionEndsAt: newData.subscriptionEndsAt,
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
        return this.getLocalUserPlan() === 'pro';
    }

    /**
     * Effective tier — equals `plan` (kept for API compatibility; Team removed).
     */
    static getEffectiveTier(): UserPlan {
        return this.session?.effectiveTier ?? this.session?.plan ?? 'free';
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

        // Explicit refresh (e.g. after payment) must bypass the tier cache.
        invalidatePlanCaches();
        const newPlan = await getUserPlan(this.session.id);
        const effectiveTier = await getEffectiveTier(this.session.id, newPlan);

        const changed =
            newPlan !== this.session.plan ||
            effectiveTier !== this.session.effectiveTier;

        if (changed) {
            logger.log(`[SubscriptionManager] Plan/effective tier refreshed: ${this.session.plan} → ${newPlan}, effective: ${effectiveTier}`);
            this.session = {
                ...this.session,
                plan: newPlan,
                effectiveTier,
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
        invalidatePlanCaches();
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
    } | null> {
        try {
            const workspace = await db.query.apps.findFirst();

            if (!workspace) return null;

            return {
                id: workspace.id,
                name: workspace.name,
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
     * Incognito chats are always allowed and free.
     * They have limited tools: web_search, read_url.
     */
    static canStartIncognitoChat(): boolean {
        return true; // Always allowed, no limits
    }

    /**
     * Get tools available for incognito chat (no workspace).
     * These are free and unlimited for all users.
     */
    static getIncognitoTools(): string[] {
        return [
            'web_search',
            'read_url',
        ];
    }
}
