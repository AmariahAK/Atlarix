/**
 * OAuth Authentication Hook
 * ===========================
 * Handles Google and GitHub OAuth flows via Supabase
 * Uses IPC to communicate with main process
 */

import { useState, useEffect, useCallback } from 'react';
import { subscribeOAuthSuccess, subscribePlanChanged } from './auth-ipc-bridge';

export interface AuthUser {
    id: string;
    email: string;
    name: string;
    avatar?: string;
    provider?: 'google' | 'github';
}

export interface UserStatus {
    plan: 'free' | 'pro' | 'workforce';
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
    const [status, setStatus] = useState<UserStatus | null>(null);

    /** True after Sign in until `oauth-callback-success` or IPC error */
    const [oauthPending, setOauthPending] = useState(false);
    const [oauthProvider, setOauthProvider] = useState<'google' | 'github' | null>(null);
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
                setOauthStatusLabel(
                    oauthProvider === 'google' ? 'Connecting to Google...' : 'Connecting to GitHub...',
                );
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
                    // Enforce workspace limit for Free tier users
                    // This removes any excess workspaces (keeps only oldest)
                    const ipcRenderer = window.electron?.ipcRenderer;
                    if (ipcRenderer?.invoke) {
                        try {
                            const result = (await ipcRenderer.invoke('auth:enforce-workspace-limit')) as { removed?: number } | undefined;
                            if (result?.removed && result.removed > 0) {
                                console.log(`[useAuth] Removed ${result.removed} excess workspaces to meet Free tier limit`);
                            }
                        } catch (e) {
                            console.warn('[useAuth] Could not enforce workspace limit:', e);
                        }
                    }

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
            plan: 'free' | 'pro' | 'workforce';
            /** Effective tier (own or team); prefer over `plan` when present */
            effectiveTier?: 'free' | 'pro' | 'workforce';
            previousPlan?: 'free' | 'pro' | 'workforce';
            subscriptionStatus?: string | null;
            subscriptionEndsAt?: string | null;
        }) => {
            const nextPlan = (data.effectiveTier ?? data.plan) as UserStatus['plan'];

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
            const isWorkforceUpgrade =
                nextPlan === 'workforce' &&
                data.previousPlan !== 'workforce' &&
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
            if (isWorkforceUpgrade) {
                const notification = document.createElement('div');
                notification.className = 'fixed bottom-4 right-4 bg-gradient-to-r from-indigo-600 to-purple-600 text-white px-4 py-3 rounded-lg shadow-lg z-[9999] flex items-center gap-3 animate-in slide-in-from-bottom-5';
                notification.innerHTML = `
                    <div>
                        <div class="font-medium">Welcome to Atlarix Workforce!</div>
                        <div class="text-sm opacity-90">Teams, extensions, and workspace context are now unlocked.</div>
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
                    effectiveTier?: 'free' | 'pro' | 'workforce';
                };
                isPro?: boolean;
            };
            const result = (await ipcRenderer.invoke('auth:get-current-user')) as GetUserResult | undefined;

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
                ) as "free" | "pro" | "workforce";
                setStatus({
                    plan,
                    isLoggedIn: true,
                    workspaceLimit: result.isPro ? Infinity : 1,
                    currentWorkspaceCount: 0,
                    canCreateWorkspace: true,
                });
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

    const signInWithGoogle = useCallback(async () => {
        try {
            const ipcRenderer = window.electron?.ipcRenderer;
            if (!ipcRenderer?.invoke) {
                console.error('IPC not available');
                return;
            }

            setOauthPending(true);
            setOauthProvider('google');

            const result = (await ipcRenderer.invoke('auth:sign-in', { provider: 'google' })) as
                | { error?: string; success?: boolean }
                | undefined;

            if (result?.error) {
                console.error('Google sign in failed', result.error);
                setOauthPending(false);
                setOauthProvider(null);
            }
            // OAuth flow will continue in browser, callback handled by main process
        } catch (error) {
            console.error('Google sign in error:', error);
            setOauthPending(false);
            setOauthProvider(null);
        }
    }, []);

    const signInWithGitHub = useCallback(async () => {
        try {
            const ipcRenderer = window.electron?.ipcRenderer;
            if (!ipcRenderer?.invoke) {
                console.error('IPC not available');
                return;
            }

            setOauthPending(true);
            setOauthProvider('github');

            const result = (await ipcRenderer.invoke('auth:sign-in', { provider: 'github' })) as
                | { error?: string; success?: boolean }
                | undefined;

            if (result?.error) {
                console.error('GitHub sign in failed', result.error);
                setOauthPending(false);
                setOauthProvider(null);
            }
            // OAuth flow will continue in browser, callback handled by main process
        } catch (error) {
            console.error('GitHub sign in error:', error);
            setOauthPending(false);
            setOauthProvider(null);
        }
    }, []);

    const signOut = useCallback(async () => {
        try {
            const ipcRenderer = window.electron?.ipcRenderer;
            if (!ipcRenderer?.invoke) return;

            await ipcRenderer.invoke('auth:sign-out');
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
                const newPlan = (result.plan ?? status.plan) as 'free' | 'pro' | 'workforce';
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
                if (newPlan === 'workforce' && status.plan !== 'workforce') {
                    const notification = document.createElement('div');
                    notification.className = 'fixed bottom-4 right-4 bg-indigo-600 text-white px-4 py-3 rounded-lg shadow-lg z-[9999] flex items-center gap-3 animate-in slide-in-from-bottom-5';
                    notification.innerHTML = `
                        <div>
                            <div class="font-medium">Welcome to Atlarix Workforce!</div>
                            <div class="text-sm opacity-90">Teams and extensions are now unlocked.</div>
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
        oauthPending,
        oauthProvider,
        oauthStatusLabel,
        signInWithGoogle,
        signInWithGitHub,
        signOut,
        refreshStatus: fetchPlanInfo,
        refreshPlan,
    };
}
