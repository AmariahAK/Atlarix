/**
 * OAuth Authentication Hook
 * ===========================
 * Handles Google and GitHub OAuth flows via Supabase
 * Uses IPC to communicate with main process
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { subscribeOAuthSuccess, subscribePlanChanged } from './auth-ipc-bridge';

export interface AuthUser {
    id: string;
    email: string;
    name: string;
    avatar?: string;
    provider?: 'google' | 'github' | 'discord';
}

export interface UserStatus {
    plan: 'free' | 'pro';
    isLoggedIn: boolean;
    workspaceLimit: number;
    currentWorkspaceCount: number;
    canCreateWorkspace: boolean;
    /** LemonSqueezy subscription status (e.g. active, on_trial, cancelled, expired) */
    subscriptionStatus?: string | null;
    subscriptionEndsAt?: string | null; // ISO date string
}

export function useAuth() {
    const [user, setUser] = useState<AuthUser | null>(null);
    const [loading, setLoading] = useState(true);
    /**
     * Has MAIN finished its deferred startup session restore?
     *
     * `loading` only covers THIS hook's own round-trip, which resolves quickly
     * with `user: null` while main is still restoring — so consumers that keyed
     * on `!user` rendered a sign-in button on launch and flipped to the account
     * seconds later. This is the difference between "signed out" and "not known
     * yet". Starts false and is only ever set true.
     */
    const [authResolved, setAuthResolved] = useState(false);
    const [status, setStatus] = useState<UserStatus | null>(null);

    /**
     * Latest `checkSession` + whether a session is established yet, for the
     * `plan-changed` listener below. The listener is registered once (`[]` deps)
     * but must act on the CURRENT state, and a ref is the only way to read that
     * without re-subscribing on every render.
     */
    const checkSessionRef = useRef<(() => Promise<void>) | null>(null);
    const hasSessionRef = useRef(false);
    useEffect(() => {
        hasSessionRef.current = !!status?.isLoggedIn;
    }, [status?.isLoggedIn]);

    /** True after Sign in until `oauth-callback-success` or IPC error */
    const [oauthPending, setOauthPending] = useState(false);
    const [oauthProvider, setOauthProvider] = useState<'google' | 'github' | 'discord' | null>(null);
    const [oauthStatusLabel, setOauthStatusLabel] = useState('');

    useEffect(() => {
        if (!oauthPending || !oauthProvider) {
            setOauthStatusLabel('');
            return;
        }
        const started = Date.now();
        const tick = () => {
            const elapsed = Date.now() - started;
            if (elapsed < 2000) {
                const label = { google: 'Google', github: 'GitHub', discord: 'Discord' }[oauthProvider];
                setOauthStatusLabel(`Connecting to ${label}...`);
            } else if (elapsed < 5000) {
                setOauthStatusLabel('Verifying your account...');
            } else {
                setOauthStatusLabel('Setting up Atlarix...');
            }
        };
        tick();
        const id = window.setInterval(tick, 250);
        return () => window.clearInterval(id);
    }, [oauthPending, oauthProvider]);

    // Check for existing session on mount
    useEffect(() => {
        // Keep the ref pointing at the live implementation so the `plan-changed`
        // listener below (registered once) can re-establish a session later.
        checkSessionRef.current = checkSession;
        checkSession();

        // Listen for OAuth callback success
        // Note: preload strips the event, so data is the first parameter
        const handleOAuthSuccess = async (data: { user: AuthUser }) => {
            setOauthPending(false);
            setOauthProvider(null);
            console.log('[useAuth] OAuth success callback received:', data);
            if (data?.user) {
                console.log('[useAuth] Setting user:', data.user.email);
                setUser({
                    id: data.user.id,
                    email: data.user.email,
                    name: data.user.email?.split('@')[0] || 'User',
                    avatar: data.user.avatar,
                });
                fetchPlanInfo();

                // Show success notification - inform user to close the browser tab
                if (typeof window !== 'undefined' && document?.body) {
                    // v14.27.0: signing in no longer deletes workspaces to make a
                    // Free plan fit. The cap is enforced when a workspace is
                    // CREATED (ipc/utils/workspace-quota.ts), like every other
                    // Free limit in the product.

                    // Use a timeout to ensure the UI has updated first
                    setTimeout(() => {
                        // Create a non-blocking notification
                        const notification = document.createElement('div');
                        notification.className = 'fixed bottom-4 right-4 bg-emerald-600 text-white px-4 py-3 rounded-lg shadow-lg z-[9999] flex items-center gap-3 animate-in slide-in-from-bottom-5';
                        notification.innerHTML = `
                            <span class="text-xl">✅</span>
                            <div>
                                <div class="font-medium">Signed in successfully!</div>
                                <div class="text-sm opacity-90">You're ready to continue.</div>
                            </div>
                        `;
                        document.body.appendChild(notification);

                        // Auto-remove after 5 seconds
                        setTimeout(() => notification.remove(), 5000);
                    }, 100);
                }
            }
        };

        // Listen for realtime plan changes (Supabase Realtime → main process → frontend)
        const handlePlanChanged = (data: {
            plan: 'free' | 'pro';
            /** Effective tier (own or team); prefer over `plan` when present */
            effectiveTier?: 'free' | 'pro';
            previousPlan?: 'free' | 'pro';
            subscriptionStatus?: string | null;
            subscriptionEndsAt?: string | null;
        }) => {
            const nextPlan = (data.effectiveTier ?? data.plan) as UserStatus['plan'];

            // No session established yet → this event is ESTABLISHING one, not
            // updating one. Startup restores the Supabase session AFTER the
            // window exists (window creation must never await the network), so
            // the renderer mounts signed-out and `broadcastSessionState()` fires
            // this once the session lands. Dropping it here — which the old
            // `: prev` branch did — left the user staring at a sign-in screen
            // with a perfectly valid session sitting in main, i.e. "it forgets
            // my login every restart". Re-read from main rather than trusting
            // this payload: it carries plan fields only, no user identity.
            if (!hasSessionRef.current) {
                void checkSessionRef.current?.();
                return;
            }

            // Update status with all new fields
            setStatus((prev) => prev ? {
                ...prev,
                plan: nextPlan,
                subscriptionStatus: data.subscriptionStatus ?? prev.subscriptionStatus,
                subscriptionEndsAt: data.subscriptionEndsAt ?? prev.subscriptionEndsAt,
            } : prev);

            // Show upgrade notification when plan upgraded and subscription is active
            const isProUpgrade =
                nextPlan === 'pro' &&
                data.previousPlan === 'free' &&
                data.subscriptionStatus === 'active';
            if (isProUpgrade) {
                const notification = document.createElement('div');
                notification.className = 'fixed bottom-4 right-4 bg-gradient-to-r from-purple-600 to-pink-600 text-white px-4 py-3 rounded-lg shadow-lg z-[9999] flex items-center gap-3 animate-in slide-in-from-bottom-5';
                notification.innerHTML = `
                    <div>
                        <div class="font-medium">Welcome to Atlarix Pro!</div>
                        <div class="text-sm opacity-90">All Pro features are now unlocked.</div>
                    </div>
                `;
                document.body.appendChild(notification);
                setTimeout(() => notification.remove(), 6000);
            }
        };

        const unsubOAuth = subscribeOAuthSuccess(handleOAuthSuccess);
        const unsubPlan = subscribePlanChanged(handlePlanChanged);

        return () => {
            unsubOAuth();
            unsubPlan();
        };
    }, []);

    const checkSession = async () => {
        setLoading(true);
        try {
            const ipcRenderer = window.electron?.ipcRenderer;
            if (!ipcRenderer?.invoke) {
                setLoading(false);
                return;
            }

            type GetUserResult = {
                user?: {
                    id: string;
                    email?: string;
                    name?: string;
                    avatar?: string;
                    plan?: string;
                    effectiveTier?: 'free' | 'pro';
                };
                isPro?: boolean;
                authResolved?: boolean;
            };
            const result = (await ipcRenderer.invoke('auth:get-current-user')) as GetUserResult | undefined;

            // A user in hand is itself proof the restore settled; otherwise trust
            // main's flag. Older handlers omit it — treat that as resolved so a
            // version skew can never leave the account slot blank forever.
            if (result?.user || result?.authResolved !== false) setAuthResolved(true);

            if (result?.user) {
                setUser({
                    id: result.user.id,
                    email: result.user.email ?? "",
                    name: (result.user.name || (result.user.email ?? "").split('@')[0]) || "User",
                    avatar: result.user.avatar,
                });
                const plan = (
                    result.user.effectiveTier ??
                    result.user.plan ??
                    "free"
                ) as "free" | "pro";
                setStatus({
                    plan,
                    isLoggedIn: true,
                    workspaceLimit: result.isPro ? Infinity : 1,
                    currentWorkspaceCount: 0,
                    canCreateWorkspace: true,
                });
                // One-time $1 Atlarix Core trial credit (idempotent server-side —
                // grants once per user, no-op on every subsequent sign-in).
                void ipcRenderer.invoke('auth:claim-signup-credit').catch(() => {});
                // Fetch full plan info (subscriptionEndsAt, etc.) for billing UI
                type PlanResult = { success?: boolean; plan?: string; workspaceLimit?: number; currentWorkspaceCount?: number; canCreateWorkspace?: boolean; subscriptionStatus?: string | null; subscriptionEndsAt?: string | null; isLoggedIn?: boolean };
                const planResult = (await ipcRenderer.invoke('auth:get-plan-info')) as PlanResult | undefined;
                if (planResult?.success) {
                    setStatus((prev) => prev ? {
                        ...prev,
                        plan: (planResult.plan ?? prev.plan) as UserStatus['plan'],
                        workspaceLimit: planResult.workspaceLimit ?? prev.workspaceLimit,
                        currentWorkspaceCount: planResult.currentWorkspaceCount ?? prev.currentWorkspaceCount,
                        canCreateWorkspace: planResult.canCreateWorkspace ?? prev.canCreateWorkspace,
                        subscriptionStatus: planResult.subscriptionStatus ?? prev.subscriptionStatus ?? null,
                        subscriptionEndsAt: planResult.subscriptionEndsAt ?? prev.subscriptionEndsAt,
                    } : prev);
                }
            }
        } catch (error) {
            console.error('Failed to check session:', error);
        } finally {
            setLoading(false);
        }
    };

    const fetchPlanInfo = useCallback(async () => {
        try {
            const ipcRenderer = window.electron?.ipcRenderer;
            if (!ipcRenderer?.invoke) return;

            type PlanResult = { success?: boolean; plan?: string; workspaceLimit?: number; currentWorkspaceCount?: number; canCreateWorkspace?: boolean; subscriptionStatus?: string | null; subscriptionEndsAt?: string | null; isLoggedIn?: boolean };
            const result = (await ipcRenderer.invoke('auth:get-plan-info')) as PlanResult | undefined;

            if (result?.success) {
                setStatus({
                    plan: (result.plan ?? 'free') as UserStatus['plan'],
                    isLoggedIn: result.isLoggedIn ?? true,
                    workspaceLimit: result.workspaceLimit ?? 1,
                    currentWorkspaceCount: result.currentWorkspaceCount ?? 0,
                    canCreateWorkspace: result.canCreateWorkspace ?? true,
                    subscriptionStatus: result.subscriptionStatus ?? null,
                    subscriptionEndsAt: result.subscriptionEndsAt ?? null,
                });
            }
        } catch (error) {
            console.error('Failed to fetch plan info:', error);
        }
    }, []);

    /**
     * Start an OAuth flow. One implementation for every provider — the three
     * wrappers below differed only in a string, and a third copy for Discord
     * would have made that drift-prone for no benefit. The flow continues in the
     * user's browser; the callback is handled in main.
     */
    const startOAuth = useCallback(async (provider: 'google' | 'github' | 'discord') => {
        try {
            const ipcRenderer = window.electron?.ipcRenderer;
            if (!ipcRenderer?.invoke) {
                console.error('IPC not available');
                return;
            }

            setOauthPending(true);
            setOauthProvider(provider);

            const result = (await ipcRenderer.invoke('auth:sign-in', { provider })) as
                | { error?: string; success?: boolean }
                | undefined;

            if (result?.error) {
                console.error(`${provider} sign in failed`, result.error);
                setOauthPending(false);
                setOauthProvider(null);
            }
        } catch (error) {
            console.error(`${provider} sign in error:`, error);
            setOauthPending(false);
            setOauthProvider(null);
        }
    }, []);

    const signInWithGoogle = useCallback(() => startOAuth('google'), [startOAuth]);
    const signInWithGitHub = useCallback(() => startOAuth('github'), [startOAuth]);
    const signInWithDiscord = useCallback(() => startOAuth('discord'), [startOAuth]);

    /**
     * @param removeLocalData Also delete this machine's workspaces and chat
     * history. Defaults to false — signing out clears credentials, and nothing
     * else. The caller (the sign-out dialog) offers it as an unchecked box.
     */
    const signOut = useCallback(async (removeLocalData = false) => {
        try {
            const ipcRenderer = window.electron?.ipcRenderer;
            if (!ipcRenderer?.invoke) return;

            await ipcRenderer.invoke('auth:sign-out', { removeLocalData });
            setUser(null);
            setStatus(null);
        } catch (error) {
            console.error('Sign out error:', error);
        }
    }, []);

    /**
     * Refresh plan from Supabase - call after payment completion
     */
    const refreshPlan = useCallback(async () => {
        try {
            const ipcRenderer = window.electron?.ipcRenderer;
            if (!ipcRenderer?.invoke) return null;

            const result = (await ipcRenderer.invoke('auth:refresh-plan')) as { success?: boolean; plan?: string } | undefined;

            if (result?.success && status) {
                setStatus({
                    ...status,
                    plan: (result.plan ?? status.plan) as UserStatus['plan'],
                });
                console.log('[useAuth] Plan refreshed:', result.plan);

                // Show notification if upgraded
                const newPlan = (result.plan ?? status.plan) as 'free' | 'pro';
                if (newPlan === 'pro' && status.plan !== 'pro') {
                    const notification = document.createElement('div');
                    notification.className = 'fixed bottom-4 right-4 bg-emerald-600 text-white px-4 py-3 rounded-lg shadow-lg z-[9999] flex items-center gap-3 animate-in slide-in-from-bottom-5';
                    notification.innerHTML = `
                        <div>
                            <div class="font-medium">Welcome to Atlarix Pro!</div>
                            <div class="text-sm opacity-90">All Pro features are now unlocked.</div>
                        </div>
                    `;
                    document.body.appendChild(notification);
                    setTimeout(() => notification.remove(), 5000);
                }

                return result.plan;
            }
            return null;
        } catch (error) {
            console.error('Refresh plan error:', error);
            return null;
        }
    }, [status]);

    return {
        user,
        status,
        loading,
        isAuthenticated: !!user,
        /**
         * True only once main's startup restore has settled. Render a neutral
         * placeholder rather than a sign-in affordance while this is false —
         * `!isAuthenticated` alone does not mean signed out during launch.
         */
        authResolved,
        oauthPending,
        oauthProvider,
        oauthStatusLabel,
        signInWithGoogle,
        signInWithGitHub,
        signInWithDiscord,
        signOut,
        refreshStatus: fetchPlanInfo,
        refreshPlan,
    };
}
