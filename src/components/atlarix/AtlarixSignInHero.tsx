import AtlarixAnimation from "@/components/atlarix/AtlarixAnimation";
import { cn } from "@/lib/utils";

type AtlarixSignInHeroProps = {
  onSignIn: () => void;
  oauthPending?: boolean;
  oauthStatusLabel?: string;
  size?: "sm" | "md" | "lg";
  className?: string;
};

/** Compass intro (plays once, holds on A). Click to start OAuth. */
export function AtlarixSignInHero({
  onSignIn,
  oauthPending = false,
  oauthStatusLabel,
  size = "md",
  className,
}: AtlarixSignInHeroProps) {
  return (
    <div className={cn("flex flex-col items-center gap-3", className)}>
      <button
        type="button"
        onClick={onSignIn}
        disabled={oauthPending}
        className={cn(
          "rounded-xl overflow-hidden border border-border/40 shadow-sm",
          "transition-opacity focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          oauthPending && "opacity-80 cursor-wait",
        )}
        aria-label="Sign in to Atlarix"
      >
        <AtlarixAnimation size={size} playOnce minimalChrome />
      </button>
      {oauthPending && oauthStatusLabel ? (
        <p className="text-sm text-center text-muted-foreground" role="status" aria-live="polite">
          {oauthStatusLabel}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">Click to sign in</p>
      )}
    </div>
  );
}
