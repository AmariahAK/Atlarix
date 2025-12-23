/**
 * OAuth Authentication Hook
 * ===========================
 * Handles Google and GitHub OAuth flows
 */

import { useState, useEffect } from 'react';
import { GOOGLE_OAUTH, GITHUB_OAUTH, OAUTH_URLS, AUTH_ENDPOINTS } from './oauth-config';

export interface AuthUser {
    id: string;
    email: string;
    name: string;
    avatar?: string;
    provider: 'google' | 'github';
}

export interface UserStatus {
    plan: 'free' | 'monthly' | 'annual_sub' | string;
    status: 'active' | 'expired' | 'cancelled';
    versions: string[];
    prompts_remaining: number | null;
    devices: number;
    max_devices: number;
}

export function useAuth() {
    const [user, setUser] = useState<AuthUser | null>(null);
    const [token, setToken] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [status, setStatus] = useState<UserStatus | null>(null);

    useEffect(() => {
        // Load cached auth from localStorage
        const cachedToken = localStorage.getItem('atlarix_auth_token');
        const cachedUser = localStorage.getItem('atlarix_user');

        if (cachedToken && cachedUser) {
            setToken(cachedToken);
            setUser(JSON.parse(cachedUser));
            fetchUserStatus(cachedToken);
        }

        setLoading(false);
    }, []);

    const fetchUserStatus = async (authToken: string) => {
        try {
            const response = await fetch(AUTH_ENDPOINTS.status, {
                headers: {
                    Authorization: `Bearer ${authToken}`,
                },
            });

            if (response.ok) {
                const statusData = await response.json();
                setStatus(statusData);
            }
        } catch (error) {
            console.error('Failed to fetch user status:', error);
        }
    };

    const signInWithGoogle = async () => {
        const state = generateRandomState();
        const authUrl = buildAuthUrl('google', state);

        // Open browser for OAuth
        (window as any).electron?.shell?.openExternal(authUrl);

        // Listen for redirect callback
        listenForOAuthCallback(state, 'google');
    };

    const signInWithGitHub = async () => {
        const state = generateRandomState();
        const authUrl = buildAuthUrl('github', state);

        (window as any).electron?.shell?.openExternal(authUrl);
        listenForOAuthCallback(state, 'github');
    };

    const signOut = () => {
        setUser(null);
        setToken(null);
        setStatus(null);
        localStorage.removeItem('atlarix_auth_token');
        localStorage.removeItem('atlarix_user');
    };

    const buildAuthUrl = (provider: 'google' | 'github', state: string): string => {
        const config = provider === 'google' ? GOOGLE_OAUTH : GITHUB_OAUTH;
        const urls = OAUTH_URLS[provider];

        const params = new URLSearchParams({
            client_id: config.clientId,
            redirect_uri: config.redirectUri,
            response_type: 'code',
            scope: config.scopes.join(' '),
            state,
        });

        return `${urls.authUrl}?${params.toString()}`;
    };

    const listenForOAuthCallback = (state: string, provider: 'google' | 'github') => {
        // This will be handled by the main process via protocol handler
        // Register a one-time listener for the callback
        window.electron?.ipcRenderer.once('oauth-callback', async (_, data: { code: string; state: string }) => {
            if (data.state !== state) {
                console.error('OAuth state mismatch');
                return;
            }

            try {
                // Exchange code for token via backend
                const endpoint = provider === 'google' ? AUTH_ENDPOINTS.google : AUTH_ENDPOINTS.github;
                const response = await fetch(endpoint, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ code: data.code }),
                });

                if (!response.ok) {
                    throw new Error('Failed to exchange code for token');
                }

                const authData = await response.json();

                // Save auth state
                setToken(authData.token);
                setUser(authData.user);
                localStorage.setItem('atlarix_auth_token', authData.token);
                localStorage.setItem('atlarix_user', JSON.stringify(authData.user));

                // Fetch user status
                await fetchUserStatus(authData.token);

                // Register device
                await registerDevice(authData.token);
            } catch (error) {
                console.error('OAuth exchange failed:', error);
            }
        });
    };

    const registerDevice = async (authToken: string) => {
        try {
            const deviceId = getDeviceId();
            const deviceName = getDeviceName();
            const os = getOS();

            await fetch(AUTH_ENDPOINTS.registerDevice, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${authToken}`,
                },
                body: JSON.stringify({
                    device_id: deviceId,
                    device_name: deviceName,
                    os,
                }),
            });
        } catch (error) {
            console.error('Failed to register device:', error);
        }
    };

    return {
        user,
        token,
        status,
        loading,
        isAuthenticated: !!user,
        signInWithGoogle,
        signInWithGitHub,
        signOut,
        refreshStatus: () => token && fetchUserStatus(token),
    };
}

// Helper functions
function generateRandomState(): string {
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

function getDeviceId(): string {
    let deviceId = localStorage.getItem('atlarix_device_id');
    if (!deviceId) {
        deviceId = `device_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
        localStorage.setItem('atlarix_device_id', deviceId);
    }
    return deviceId;
}

function getDeviceName(): string {
    // Try to get computer name (will need to be passed from main process)
    return window.electron?.computerName || 'Unknown Device';
}

function getOS(): string {
    // Detect OS
    const platform = navigator.platform.toLowerCase();
    if (platform.includes('mac')) return 'macOS';
    if (platform.includes('win')) return 'Windows';
    if (platform.includes('linux')) return 'Linux';
    return 'Unknown';
}
