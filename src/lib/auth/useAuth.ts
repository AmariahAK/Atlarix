/**
 * OAuth Authentication Hook
 * ===========================
 * Handles Google and GitHub OAuth flows via Supabase
 * Uses IPC to communicate with main process
 */

import { useState, useEffect, useCallback } from 'react';

export interface AuthUser {
    id: string;
    email: string;
    name: string;
    avatar?: string;
    provider?: 'google' | 'github';
}

export interface UserStatus {
    plan: 'free' | 'pro';
    isLoggedIn: boolean;
    workspaceLimit: number;
    currentWorkspaceCount: number;
    canCreateWorkspace: boolean;
}

export function useAuth() {
    const [user, setUser] = useState<AuthUser | null>(null);
    const [loading, setLoading] = useState(true);
    const [status, setStatus] = useState<UserStatus | null>(null);

    // Check for existing session on mount
    useEffect(() => {
        checkSession();

        // Listen for OAuth callback success
        // Note: preload strips the event, so data is the first parameter
        const handleOAuthSuccess = (data: { user: AuthUser }) => {
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
                    // Use a timeout to ensure the UI has updated first
                    setTimeout(() => {
                        // Create a non-blocking notification
                        const notification = document.createElement('div');
                        notification.className = 'fixed bottom-4 right-4 bg-emerald-600 text-white px-4 py-3 rounded-lg shadow-lg z-[9999] flex items-center gap-3 animate-in slide-in-from-bottom-5';
                        notification.innerHTML = `
                            <span class="text-xl">✅</span>
                            <div>
                                <div class="font-medium">Signed in successfully!</div>
                                <div class="text-sm opacity-90">You can close the browser tab now.</div>
                            </div>
                        `;
                        document.body.appendChild(notification);

                        // Auto-remove after 5 seconds
                        setTimeout(() => notification.remove(), 5000);
                    }, 100);
                }
            }
        };

        // Use correct IPC pattern for electron
        const ipcRenderer = window.electron?.ipcRenderer;
        if (ipcRenderer?.on) {
            console.log('[useAuth] Registering oauth-callback-success listener');
            ipcRenderer.on('oauth-callback-success', handleOAuthSuccess as any);
        }

        return () => {
            // Cleanup listener if available
            if (ipcRenderer?.removeListener) {
                ipcRenderer.removeListener('oauth-callback-success', handleOAuthSuccess as any);
            }
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

            const result = await ipcRenderer.invoke('auth:get-current-user');

            if (result?.user) {
                setUser({
                    id: result.user.id,
                    email: result.user.email,
                    name: result.user.email.split('@')[0],
                    avatar: undefined,
                });
                setStatus({
                    plan: result.user.plan || 'free',
                    isLoggedIn: true,
                    workspaceLimit: result.isPro ? Infinity : 1,
                    currentWorkspaceCount: 0,
                    canCreateWorkspace: true,
                });
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

            const result = await ipcRenderer.invoke('auth:get-plan-info');

            if (result?.success) {
                setStatus({
                    plan: result.plan,
                    isLoggedIn: result.isLoggedIn,
                    workspaceLimit: result.workspaceLimit,
                    currentWorkspaceCount: result.currentWorkspaceCount,
                    canCreateWorkspace: result.canCreateWorkspace,
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

            const result = await ipcRenderer.invoke('auth:sign-in', { provider: 'google' });

            if (result?.error) {
                console.error('Google sign in failed:', result.error);
            }
            // OAuth flow will continue in browser, callback handled by main process
        } catch (error) {
            console.error('Google sign in error:', error);
        }
    }, []);

    const signInWithGitHub = useCallback(async () => {
        try {
            const ipcRenderer = window.electron?.ipcRenderer;
            if (!ipcRenderer?.invoke) {
                console.error('IPC not available');
                return;
            }

            const result = await ipcRenderer.invoke('auth:sign-in', { provider: 'github' });

            if (result?.error) {
                console.error('GitHub sign in failed:', result.error);
            }
            // OAuth flow will continue in browser, callback handled by main process
        } catch (error) {
            console.error('GitHub sign in error:', error);
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

    return {
        user,
        status,
        loading,
        isAuthenticated: !!user,
        signInWithGoogle,
        signInWithGitHub,
        signOut,
        refreshStatus: fetchPlanInfo,
    };
}
