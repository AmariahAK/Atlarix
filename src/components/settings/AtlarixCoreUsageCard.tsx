import { Progress } from "@/components/ui/progress";
import { useCompassUsage } from "@/hooks/useCompassUsage";
import {
  ATLARIX_CORE_CATEGORY_LABEL,
  formatCompassSubscriptionTier,
} from "@/shared/compass_product_copy";

type AtlarixCoreUsageCardProps = {
  className?: string;
  showIntro?: boolean;
};

export function AtlarixCoreUsageCard({
  className = "",
  showIntro = true,
}: AtlarixCoreUsageCardProps) {
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
    <div className={`space-y-3 rounded-lg border border-border p-4 ${className}`}>
      {showIntro ? (
        <p className="text-xs text-muted-foreground leading-relaxed">
          Monthly {ATLARIX_CORE_CATEGORY_LABEL} token limits are tied to your Atlarix
          subscription (synced from billing). Usage refreshes each billing month.
        </p>
      ) : null}
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
          <span className="text-muted-foreground">
            {ATLARIX_CORE_CATEGORY_LABEL} tokens (this month)
          </span>
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
  );
}
