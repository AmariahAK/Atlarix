/**
 * OAuth Sign-In Page
 * ====================
 * User authentication with Google and GitHub
 */

import { useAuth } from '@/lib/auth/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useEffect } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { LoadingBar } from '@/components/ui/LoadingBar';
import atlarixLogo from '../../assets/logo.svg?url';

export function SignInPage() {
    const {
        user,
        loading,
        signInWithGoogle,
        signInWithGitHub,
        oauthPending,
        oauthStatusLabel,
    } = useAuth();
    const navigate = useNavigate();
    const logoSrc = atlarixLogo;

    useEffect(() => {
        // Redirect to home if already signed in
        if (user) {
            navigate({ to: '/' });
        }
    }, [user, navigate]);

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

    return (
        <div className="flex items-center justify-center min-h-screen bg-background p-4">
            {/* Background effects */}
            <div className="axis-line fixed left-1/2 top-0 bottom-0 w-px opacity-30" />
            <div className="axis-line-horizontal fixed top-1/2 left-0 right-0 h-px opacity-30" />

            <Card className="relative w-full max-w-md border-border/50 bg-card/80 backdrop-blur-sm overflow-hidden">
                <LoadingBar isVisible={oauthPending} />
                <CardHeader className="text-center space-y-4">
                    {/* Atlarix logo (theme-aware) */}
                    <div className="flex justify-center">
                        <div className="relative w-20 h-20 rounded-full border-4 border-primary/20 bg-primary/10 flex items-center justify-center overflow-hidden">
                            <div className="absolute inset-0 bg-gradient-to-br from-[#10B981]/20 to-[#F59E0B]/10 blur-md" aria-hidden="true" />
                            <img
                                src={logoSrc}
                                alt="Atlarix"
                                className="relative w-12 h-12 object-contain contrast-125 dark:contrast-100"
                                draggable={false}
                                onError={(e) => {
                                    e.currentTarget.style.display = 'none';
                                }}
                            />
                        </div>
                    </div>

                    <div>
                        <CardTitle className="text-3xl font-bold bg-gradient-to-r from-primary via-secondary to-primary bg-clip-text text-transparent">
                            Welcome to Atlarix
                        </CardTitle>
                        <CardDescription className="mt-2">
                            Sign in to sync your workspace and unlock every feature
                        </CardDescription>
                    </div>
                </CardHeader>

                <CardContent className="space-y-4">
                    {oauthPending && oauthStatusLabel && (
                        <p className="text-sm text-center text-muted-foreground" role="status" aria-live="polite">
                            {oauthStatusLabel}
                        </p>
                    )}
                    {/* Google Sign In */}
                    <Button
                        onClick={signInWithGoogle}
                        disabled={oauthPending}
                        variant="outline"
                        className="w-full h-12 gap-3 hover:bg-accent hover:border-primary transition-all"
                    >
                        <svg className="w-5 h-5" viewBox="0 0 24 24">
                            <path
                                fill="currentColor"
                                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                            />
                            <path
                                fill="currentColor"
                                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                            />
                            <path
                                fill="currentColor"
                                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                            />
                            <path
                                fill="currentColor"
                                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                            />
                        </svg>
                        <span className="font-medium">Continue with Google</span>
                    </Button>

                    {/* GitHub Sign In */}
                    <Button
                        onClick={signInWithGitHub}
                        disabled={oauthPending}
                        variant="outline"
                        className="w-full h-12 gap-3 hover:bg-accent hover:border-primary transition-all"
                    >
                        <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
                        </svg>
                        <span className="font-medium">Continue with GitHub</span>
                    </Button>

                    {/* Divider */}
                    <div className="relative">
                        <div className="absolute inset-0 flex items-center">
                            <div className="w-full border-t border-border" />
                        </div>
                        <div className="relative flex justify-center text-xs uppercase">
                            <span className="bg-card px-2 text-muted-foreground">Free tier available</span>
                        </div>
                    </div>

                    {/* Free tier — aligned with atlarix-launchpad /pricing (Free plan) */}
                    <div className="rounded-lg border border-primary/20 bg-primary/5 p-4">
                        <div className="space-y-2 text-sm">
                            <div className="flex items-center gap-2">
                                <svg className="w-4 h-4 text-primary shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                </svg>
                                <span>One workspace</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <svg className="w-4 h-4 text-primary shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                </svg>
                                <span>Starter included AI usage (monthly allowance)</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <svg className="w-4 h-4 text-primary shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                </svg>
                                <span>All core tools; optional BYOK and local models (e.g. Ollama)</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <svg className="w-4 h-4 text-primary shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                </svg>
                                <span>No credit card required</span>
                            </div>
                        </div>
                    </div>

                    {/* Footer */}
                    <div className="text-center text-xs text-muted-foreground space-y-1">
                        <p>
                            By signing in, you agree to our{' '}
                            <a href="https://atlarix.dev/terms" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                                Terms of Service
                            </a>
                            {' '}and{' '}
                            <a href="https://atlarix.dev/privacy" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                                Privacy Policy
                            </a>
                        </p>
                        <p className="text-muted-foreground/60">Atlarix · by NorahLabs · © 2024-2026</p>
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}
