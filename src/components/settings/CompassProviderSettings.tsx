import { Progress } from "@/components/ui/progress";
import { useCompassUsage } from "@/hooks/useCompassUsage";
import {
  COMPASS_TIER_ROWS,
  formatCompassSubscriptionTier,
} from "@/shared/compass_product_copy";

export function CompassProviderSettings() {
  const {
    percentRemaining,
    monthlyLimit,
    tokensUsedThisMonth,
    tier,
    loading,
    error,
    needsSignIn,
  } = useCompassUsage();

  const pct =
    typeof percentRemaining === "number" && !Number.isNaN(percentRemaining)
      ? Math.max(0, Math.min(100, percentRemaining))
      : null;

  return (
    <div className="mt-6 space-y-6">
      <p className="text-sm text-muted-foreground">
        No API key needed. The Model Bridge works out of the box with your Atlarix account.
      </p>

      <div className="space-y-4">
        {COMPASS_TIER_ROWS.map((m) => (
          <div
            key={m.id}
            className="rounded-lg border border-border bg-card/50 p-4"
          >
            <h3 className="font-medium text-foreground">{m.title}</h3>
            <p className="text-sm text-muted-foreground mt-1">{m.description}</p>
          </div>
        ))}
      </div>

      <div className="space-y-3 rounded-lg border border-border p-4">
        <p className="text-xs text-muted-foreground leading-relaxed">
          Subscription tier and monthly Model Bridge limits come from your Atlarix account in Supabase
          (updated from Lemon Squeezy). The app only reads and displays them.
        </p>
        <div className="flex items-center justify-between text-sm gap-2">
          <span className="text-muted-foreground shrink-0">Account tier</span>
          {loading ? (
            <span className="text-muted-foreground">…</span>
          ) : error ? (
            <span className="text-muted-foreground text-xs text-right max-w-[min(100%,280px)]">
              {error}
            </span>
          ) : needsSignIn ? (
            <span className="text-muted-foreground text-xs">Sign in to load tier</span>
          ) : tier ? (
            <span className="font-medium text-foreground">
              {formatCompassSubscriptionTier(tier)}
            </span>
          ) : (
            <span className="text-muted-foreground text-xs">—</span>
          )}
        </div>
        <div className="flex flex-col gap-1 text-sm">
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">Model Bridge tokens (this month)</span>
            {loading ? (
              <span className="text-muted-foreground">…</span>
            ) : error || needsSignIn ? (
              <span className="text-muted-foreground text-xs">—</span>
            ) : monthlyLimit != null &&
              tokensUsedThisMonth != null &&
              pct != null ? (
              <span className="font-medium tabular-nums text-right">
                {(monthlyLimit - tokensUsedThisMonth).toLocaleString()} left of{" "}
                {monthlyLimit.toLocaleString()}
              </span>
            ) : (
              <span className="text-muted-foreground text-xs">—</span>
            )}
          </div>
          {monthlyLimit != null &&
          tokensUsedThisMonth != null &&
          !loading &&
          !error &&
          !needsSignIn ? (
            <p className="text-xs text-muted-foreground tabular-nums">
              Used {tokensUsedThisMonth.toLocaleString()} · {pct?.toFixed(1)}% of quota
              remaining
            </p>
          ) : null}
        </div>
        {pct != null ? <Progress value={pct} className="h-2" /> : null}
      </div>

      <p className="text-xs text-muted-foreground text-center pt-2">
        Powered by OpenRouter
      </p>
    </div>
  );
}
