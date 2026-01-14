/**
 * AuthButton - OAuth Sign-In/Sign-Out Button
 * ===========================================
 * Provides Google and GitHub OAuth sign-in options
 * Shows user info and sign-out when logged in
 * 
 * NOTE: This component is NOT used - auth is in the sidebar (app-sidebar.tsx)
 * Keeping this file as a backup/reference
 */

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LogOut, User, Crown, Github } from "lucide-react";

// Google icon SVG
const GoogleIcon = () => (
    <svg className="h-4 w-4" viewBox="0 0 24 24">
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
);

interface UserSession {
    id: string;
    email: string;
    plan: "free" | "pro";
}

export function AuthButton() {
    const [user, setUser] = useState<UserSession | null>(null);
    const [loading, setLoading] = useState(false);

    // Listen for OAuth callback success
    useEffect(() => {
        const handleCallback = (_event: unknown, data: { user: UserSession }) => {
            if (data?.user) {
                setUser(data.user);
            }
        };

        // Use correct IPC pattern
        const ipcRenderer = window.electron?.ipcRenderer;
        if (ipcRenderer?.on) {
            ipcRenderer.on("oauth-callback-success", handleCallback);
        }

        // Check for existing session on mount
        checkSession();

        return () => {
            if (ipcRenderer?.removeListener) {
                ipcRenderer.removeListener("oauth-callback-success", handleCallback);
            }
        };
    }, []);

    const checkSession = async () => {
        try {
            const ipcRenderer = window.electron?.ipcRenderer;
            if (!ipcRenderer?.invoke) return;

            const result = await ipcRenderer.invoke("auth:get-current-user");
            if (result?.user) {
                setUser(result.user);
            }
        } catch (error) {
            console.error("Failed to check session:", error);
        }
    };

    const handleSignIn = async (provider: "google" | "github") => {
        setLoading(true);
        try {
            const ipcRenderer = window.electron?.ipcRenderer;
            if (!ipcRenderer?.invoke) {
                console.error("IPC not available");
                return;
            }

            await ipcRenderer.invoke("auth:sign-in", { provider });
        } catch (error) {
            console.error("Sign in failed:", error);
        } finally {
            setLoading(false);
        }
    };

    const handleSignOut = async () => {
        setLoading(true);
        try {
            const ipcRenderer = window.electron?.ipcRenderer;
            if (!ipcRenderer?.invoke) return;

            await ipcRenderer.invoke("auth:sign-out");
            setUser(null);
        } catch (error) {
            console.error("Sign out failed:", error);
        } finally {
            setLoading(false);
        }
    };

    // Logged in state
    if (user) {
        return (
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button variant="ghost" className="flex items-center gap-2 px-2">
                        <div className="h-6 w-6 rounded-full bg-primary/10 flex items-center justify-center text-xs font-medium">
                            {user.email.slice(0, 2).toUpperCase()}
                        </div>
                        <span className="text-sm truncate max-w-[150px]">{user.email}</span>
                        {user.plan === "pro" && (
                            <Crown className="h-3 w-3 text-amber-500" />
                        )}
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                    <div className="px-2 py-1.5 text-sm">
                        <p className="font-medium truncate">{user.email}</p>
                        <p className="text-xs text-muted-foreground">
                            {user.plan === "pro" ? "Pro Plan" : "Free Plan"}
                        </p>
                    </div>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={handleSignOut} disabled={loading}>
                        <LogOut className="h-4 w-4 mr-2" />
                        Sign Out
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        );
    }

    // Logged out state - show sign in buttons
    return (
        <div className="flex flex-col gap-2">
            <Button
                variant="outline"
                onClick={() => handleSignIn("google")}
                disabled={loading}
                className="w-full justify-start gap-2"
            >
                <GoogleIcon />
                Continue with Google
            </Button>
            <Button
                variant="outline"
                onClick={() => handleSignIn("github")}
                disabled={loading}
                className="w-full justify-start gap-2"
            >
                <Github className="h-4 w-4" />
                Continue with GitHub
            </Button>
        </div>
    );
}

export default AuthButton;
