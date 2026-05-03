/**
 * Atlarix Sign-In Screen
 * ======================
 * OAuth authentication for Google and GitHub
 */

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/lib/auth/useAuth";
import { LoadingBar } from "@/components/ui/LoadingBar";

export function SignInScreen() {
    const {
        signInWithGoogle,
        signInWithGitHub,
        oauthPending,
        oauthStatusLabel,
    } = useAuth();

    return (
        <div className="flex items-center justify-center min-h-screen bg-background">
            <Card className="relative w-full max-w-md mx-4 overflow-hidden">
                <LoadingBar isVisible={oauthPending} />
                <CardHeader className="text-center space-y-2">
                    {/* Atlarix Logo */}
                    <div className="flex justify-center mb-4">
                        <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-primary to-secondary flex items-center justify-center">
                            <span className="text-3xl font-bold text-white">A</span>
                        </div>
                    </div>

                    <CardTitle className="text-2xl font-bold">Welcome to Atlarix</CardTitle>
                    <CardDescription className="text-base">
                        AI-Powered Development, Your Way
                    </CardDescription>
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
                        className="w-full h-12 text-base font-medium"
                        variant="outline"
                    >
                        <svg className="w-5 h-5 mr-3" viewBox="0 0 24 24">
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
                        Continue with Google
                    </Button>

                    {/* GitHub Sign In */}
                    <Button
                        onClick={signInWithGitHub}
                        disabled={oauthPending}
                        className="w-full h-12 text-base font-medium"
                        variant="outline"
                    >
                        <svg className="w-5 h-5 mr-3" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.17 6.839 9.49.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.603-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.463-1.11-1.463-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.114 2.504.336 1.909-1.294 2.747-1.025 2.747-1.025.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
                        </svg>
                        Continue with GitHub
                    </Button>

                    {/* Free Tier Note */}
                    <div className="text-center pt-4 space-y-2">
                        <p className="text-sm text-muted-foreground">
                            <span className="font-semibold text-primary">5 free prompts per day</span>
                        </p>
                        <p className="text-xs text-muted-foreground">
                            No credit card required • Resets daily at midnight UTC
                        </p>
                    </div>

                    {/* Terms */}
                    <p className="text-xs text-center text-muted-foreground pt-2">
                        By continuing, you agree to Atlarix's{" "}
                        <a href="#" className="text-primary hover:underline">
                            Terms of Service
                        </a>{" "}
                        and{" "}
                        <a href="#" className="text-primary hover:underline">
                            Privacy Policy
                        </a>
                    </p>
                </CardContent>
            </Card>
        </div>
    );
}
