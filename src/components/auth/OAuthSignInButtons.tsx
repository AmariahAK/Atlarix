/**
 * OAuthSignInButtons — Google + GitHub + Discord sign-in (Supabase-backed).
 *
 * Restores the proven logged-out UI from the deleted `AuthButton.tsx` (v9.0.0,
 * commit 3277e7a): two "Continue with …" buttons. Driven by `useAuth()`, whose
 * `signInWithGoogle`/`signInWithGitHub` invoke the `auth:sign-in` IPC →
 * `SubscriptionManager.signIn(provider)` → Supabase OAuth. Replaces the
 * animation-only `AtlarixSignInHero` so users can pick a provider (and so
 * GitHub is actually offered).
 */
import { Button } from "@/components/ui/button";
import { Github, Loader2 } from "lucide-react";
import { useAuth } from "@/lib/auth/useAuth";

/** Discord brand mark (lucide has no Discord icon), same approach as GoogleIcon. */
function DiscordIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden>
      <path
        fill="currentColor"
        d="M20.317 4.369a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.865-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.009c.12.099.246.198.373.292a.077.077 0 0 1-.006.127c-.598.35-1.22.645-1.873.891a.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.056c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.028zM8.02 15.331c-1.183 0-2.157-1.086-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.211 0 2.176 1.096 2.157 2.42 0 1.332-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.086-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.332-.946 2.418-2.157 2.418z"
      />
    </svg>
  );
}

/** Google brand mark (lucide has no Google icon) — ported verbatim from AuthButton@3277e7a. */
function GoogleIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden>
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
}

export function OAuthSignInButtons({
  size = "md",
  onAfterClick,
}: {
  size?: "sm" | "md";
  /** Called after a provider is chosen — e.g. to close the sidebar dropdown. */
  onAfterClick?: () => void;
}) {
  const {
    signInWithGoogle,
    signInWithGitHub,
    signInWithDiscord,
    oauthPending,
    oauthProvider,
    oauthStatusLabel,
  } = useAuth();

  const buttonSize = size === "sm" ? "sm" : "default";

  const start = (provider: "google" | "github" | "discord") => {
    if (oauthPending) return;
    void { google: signInWithGoogle, github: signInWithGitHub, discord: signInWithDiscord }[
      provider
    ]();
    onAfterClick?.();
  };

  return (
    <div className="flex flex-col gap-2 w-full">
      <Button
        variant="outline"
        size={buttonSize}
        onClick={() => start("google")}
        disabled={oauthPending}
        className="w-full justify-start gap-2"
      >
        {oauthPending && oauthProvider === "google" ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <GoogleIcon />
        )}
        Continue with Google
      </Button>
      <Button
        variant="outline"
        size={buttonSize}
        onClick={() => start("github")}
        disabled={oauthPending}
        className="w-full justify-start gap-2"
      >
        {oauthPending && oauthProvider === "github" ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Github className="h-4 w-4" />
        )}
        Continue with GitHub
      </Button>
      <Button
        variant="outline"
        size={buttonSize}
        onClick={() => start("discord")}
        disabled={oauthPending}
        className="w-full justify-start gap-2"
      >
        {oauthPending && oauthProvider === "discord" ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <DiscordIcon />
        )}
        Continue with Discord
      </Button>
      {oauthPending && oauthStatusLabel ? (
        <p
          className="text-xs text-center text-muted-foreground"
          role="status"
          aria-live="polite"
        >
          {oauthStatusLabel}
        </p>
      ) : null}
    </div>
  );
}
