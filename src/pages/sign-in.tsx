/**
 * OAuth Sign-In Page
 * ====================
 * Compass intro + click to sign in (Google OAuth).
 */

import { useAuth } from '@/lib/auth/useAuth';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useEffect } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { LoadingBar } from '@/components/ui/LoadingBar';
import { OAuthSignInButtons } from '@/components/auth/OAuthSignInButtons';
import AtlarixAnimation from '@/components/atlarix/AtlarixAnimation';

export function SignInPage() {
    const {
        user,
        loading,
        oauthPending,
    } = useAuth();
    const navigate = useNavigate();

    useEffect(() => {
        if (user) {
            navigate({ to: '/' });
        }
    }, [user, navigate]);

    if (loading) {
        return (
            <div className="flex items-center justify-center min-h-screen bg-background">
                <AtlarixAnimation size="md" phase="thinking" minimalChrome />
            </div>
        );
    }

    return (
        <div className="flex items-center justify-center min-h-screen bg-background p-4">
            <div className="axis-line fixed left-1/2 top-0 bottom-0 w-px opacity-30" />
            <div className="axis-line-horizontal fixed top-1/2 left-0 right-0 h-px opacity-30" />

            <Card className="relative w-full max-w-md border-border/50 bg-card/80 backdrop-blur-sm overflow-hidden">
                <LoadingBar isVisible={oauthPending} />
                <CardHeader className="text-center space-y-4">
                    <div className="flex justify-center">
                        <AtlarixAnimation size="lg" phase="done" minimalChrome />
                    </div>
                    <OAuthSignInButtons size="md" />

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
                    <div className="relative">
                        <div className="absolute inset-0 flex items-center">
                            <div className="w-full border-t border-border" />
                        </div>
                        <div className="relative flex justify-center text-xs uppercase">
                            <span className="bg-card px-2 text-muted-foreground">Free tier available</span>
                        </div>
                    </div>

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
                                <span>$1 free Atlarix Core credit to start — pay-as-you-go after</span>
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
