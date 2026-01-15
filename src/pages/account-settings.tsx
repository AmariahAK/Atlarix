/**
 * Account Settings Page
 * =======================
 * User profile, subscription, and device management
 */

import { useAuth } from '@/lib/auth/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';

export function AccountSettings() {
    const { user, status, loading, signOut, refreshStatus } = useAuth();
    const navigate = useNavigate();
    const [devices, setDevices] = useState<any[]>([]);

    useEffect(() => {
        if (!user) {
            navigate({ to: '/sign-in' });
        } else {
            refreshStatus?.();
        }
    }, [user, navigate, refreshStatus]);

    if (loading) {
        return (
            <div className="flex items-center justify-center min-h-screen bg-background">
                <div className="text-center space-y-4">
                    <div className="w-16 h-16 mx-auto rounded-full border-4 border-border border-t-primary animate-spin" />
                    <p className="text-muted-foreground">Loading...</p>
                </div>
            </div>
        );
    }

    if (!user || !status) {
        return null;
    }

    const handleUpgrade = async () => {
        // Open LemonSqueezy checkout (requires sign-in)
        const { triggerUpgrade } = await import('@/hooks/useUpgrade');
        triggerUpgrade();
    };

    const handleManageSubscription = async () => {
        // Open LemonSqueezy customer portal
        await window.electron?.ipcRenderer?.invoke('auth:manage-subscription');
    };

    return (
        <div className="min-h-screen bg-background p-8">
            <div className="max-w-4xl mx-auto space-y-8">
                {/* Header */}
                <div className="flex items-center justify-between">
                    <div>
                        <h1 className="text-3xl font-bold">Account Settings</h1>
                        <p className="text-muted-foreground mt-1">
                            Manage your profile, subscription, and devices
                        </p>
                    </div>
                    <Button onClick={() => navigate({ to: '/' })} variant="outline">
                        Back to Home
                    </Button>
                </div>

                {/* Profile Card */}
                <Card>
                    <CardHeader>
                        <CardTitle>Profile</CardTitle>
                        <CardDescription>Your Atlarix account information</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <div className="flex items-center gap-4">
                            {user.avatar ? (
                                <img
                                    src={user.avatar}
                                    alt={user.name}
                                    className="w-20 h-20 rounded-full border-2 border-primary"
                                />
                            ) : (
                                <div className="w-20 h-20 rounded-full border-2 border-primary bg-primary/10 flex items-center justify-center text-2xl font-bold">
                                    {user.name.charAt(0).toUpperCase()}
                                </div>
                            )}
                            <div>
                                <h3 className="text-xl font-semibold">{user.name}</h3>
                                <p className="text-muted-foreground">{user.email}</p>
                                <Badge variant="secondary" className="mt-2">
                                    {user.provider === 'google' ? 'Google' : 'GitHub'}
                                </Badge>
                            </div>
                        </div>

                        <div className="pt-4 border-t flex justify-end">
                            <Button onClick={signOut} variant="outline" size="sm">
                                Sign Out
                            </Button>
                        </div>
                    </CardContent>
                </Card>

                {/* Subscription Card */}
                <Card>
                    <CardHeader>
                        <CardTitle>Subscription</CardTitle>
                        <CardDescription>Your current plan and usage</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <div className="flex items-center justify-between">
                            <div>
                                <h4 className="font-semibold">Current Plan</h4>
                                <p className="text-2xl font-bold text-primary capitalize">{status.plan}</p>
                            </div>
                            <Badge
                                variant={status.status === 'active' ? 'default' : 'destructive'}
                                className="text-sm"
                            >
                                {status.status}
                            </Badge>
                        </div>

                        {/* Free tier usage */}
                        {status.plan === 'free' && status.prompts_remaining !== null && (
                            <div className="rounded-lg border border-border bg-card p-4">
                                <div className="flex items-center justify-between mb-2">
                                    <span className="text-sm font-medium">Daily Prompts</span>
                                    <span className="text-sm text-muted-foreground">
                                        {status.prompts_remaining}/5 remaining
                                    </span>
                                </div>
                                <div className="w-full bg-border rounded-full h-2">
                                    <div
                                        className="bg-primary rounded-full h-2 transition-all"
                                        style={{ width: `${(status.prompts_remaining / 5) * 100}%` }}
                                    />
                                </div>
                                <p className="text-xs text-muted-foreground mt-2">
                                    Resets daily at midnight UTC
                                </p>
                            </div>
                        )}

                        {/* Version access */}
                        {status.versions.length > 0 && (
                            <div className="space-y-2">
                                <h4 className="text-sm font-medium">Version Access</h4>
                                <div className="flex gap-2 flex-wrap">
                                    {status.versions.map((version) => (
                                        <Badge key={version} variant="secondary">
                                            {version.toUpperCase()}
                                        </Badge>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* Upgrade button for free tier */}
                        {status.plan === 'free' && (
                            <div className="pt-4 border-t">
                                <Button onClick={handleUpgrade} className="w-full atlarix-glow">
                                    <svg
                                        className="w-4 h-4 mr-2"
                                        fill="none"
                                        stroke="currentColor"
                                        viewBox="0 0 24 24"
                                    >
                                        <path
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            strokeWidth={2}
                                            d="M5 10l7-7m0 0l7 7m-7-7v18"
                                        />
                                    </svg>
                                    Upgrade to Pro - $19/month
                                </Button>
                            </div>
                        )}

                        {/* Cancel subscription for paid users */}
                        {status.plan !== 'free' && (
                            <div className="pt-4 border-t">
                                <Button
                                    onClick={async () => {
                                        const confirmed = window.confirm(
                                            'Are you sure you want to cancel your Atlarix Pro subscription?\n\nYou will retain access until the end of your billing period.'
                                        );
                                        if (!confirmed) return;

                                        const result = await window.electron?.ipcRenderer?.invoke('auth:cancel-subscription');
                                        if (result?.success) {
                                            alert('Subscription cancelled. You will have access until the end of your billing period.');
                                            window.location.href = window.location.href;
                                        } else {
                                            alert(result?.error || 'Failed to cancel subscription');
                                        }
                                    }}
                                    variant="outline"
                                    className="w-full text-destructive border-destructive/30 hover:bg-destructive/10"
                                >
                                    Cancel Subscription
                                </Button>
                            </div>
                        )}
                    </CardContent>
                </Card>

                {/* Devices Card */}
                <Card>
                    <CardHeader>
                        <CardTitle>Devices</CardTitle>
                        <CardDescription>
                            Devices connected to your account ({status.devices}/{status.max_devices})
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        {status.devices === 0 ? (
                            <p className="text-muted-foreground text-center py-4">
                                No devices registered yet
                            </p>
                        ) : (
                            <div className="space-y-2">
                                <div className="flex items-center justify-between p-3 rounded-lg border border-border bg-card">
                                    <div className="flex items-center gap-3">
                                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path
                                                strokeLinecap="round"
                                                strokeLinejoin="round"
                                                strokeWidth={2}
                                                d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                                            />
                                        </svg>
                                        <div>
                                            <p className="font-medium">This Device</p>
                                            <p className="text-sm text-muted-foreground">Last active: Just now</p>
                                        </div>
                                    </div>
                                    <Badge variant="secondary">Current</Badge>
                                </div>
                            </div>
                        )}

                        {status.devices >= status.max_devices && (
                            <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/5 p-3 text-sm text-yellow-600 dark:text-yellow-400">
                                <p>
                                    You've reached the maximum number of devices ({status.max_devices}). Remove a
                                    device to add a new one.
                                </p>
                            </div>
                        )}
                    </CardContent>
                </Card>

                {/* Footer */}
                <div className="text-center text-xs text-muted-foreground">
                    <p>
                        Need help? Visit{' '}
                        <a
                            href="https://atlarix.dev/support"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-primary hover:underline"
                        >
                            atlarix.dev/support
                        </a>
                    </p>
                    <p className="mt-2">© 2024-2025 NorahLabs. All Rights Reserved.</p>
                </div>
            </div>
        </div>
    );
}
