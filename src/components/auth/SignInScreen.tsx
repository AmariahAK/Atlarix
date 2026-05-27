/**
 * Atlarix Sign-In Screen
 * ======================
 * Compass intro + click to sign in (Google OAuth).
 */

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/lib/auth/useAuth";
import { LoadingBar } from "@/components/ui/LoadingBar";
import { AtlarixSignInHero } from "@/components/atlarix/AtlarixSignInHero";

export function SignInScreen() {
    const {
        signInWithGoogle,
        oauthPending,
        oauthStatusLabel,
    } = useAuth();

    return (
        <div className="flex items-center justify-center min-h-screen bg-background">
            <Card className="relative w-full max-w-md mx-4 overflow-hidden">
                <LoadingBar isVisible={oauthPending} />
                <CardHeader className="text-center space-y-2">
                    <AtlarixSignInHero
                        size="md"
                        onSignIn={() => void signInWithGoogle()}
                        oauthPending={oauthPending}
                        oauthStatusLabel={oauthStatusLabel}
                    />

                    <CardTitle className="text-2xl font-bold">Welcome to Atlarix</CardTitle>
                    <CardDescription className="text-base">
                        AI-Powered Development, Your Way
                    </CardDescription>
                </CardHeader>

                <CardContent className="space-y-4">
                    <div className="text-center pt-2 space-y-2">
                        <p className="text-xs text-muted-foreground">
                            No credit card required · Resets daily at midnight UTC
                        </p>
                    </div>

                    <p className="text-xs text-center text-muted-foreground pt-2">
                        By continuing, you agree to Atlarix&apos;s{" "}
                        <a href="https://atlarix.dev/terms" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                            Terms of Service
                        </a>{" "}
                        and{" "}
                        <a href="https://atlarix.dev/privacy" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                            Privacy Policy
                        </a>
                    </p>
                </CardContent>
            </Card>
        </div>
    );
}
