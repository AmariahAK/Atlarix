import { Progress } from "@/components/ui/progress";
import { ATLARIX_CORE_CATEGORY_LABEL } from "@/shared/compass_product_copy";

export function CompassUsageStrip({
  subscriptionTierLabel,
  tokensUsedThisMonth,
  monthlyLimit,
  percentRemaining,
  loading,
}: {
  /** From Supabase usage RPC (billing tier for Compass limits). */
  subscriptionTierLabel: string;
  tokensUsedThisMonth: number | null;
  monthlyLimit: number | null;
  percentRemaining: number | null;
  loading: boolean;
}) {
  if (loading || percentRemaining == null) return null;
  const pct = Math.max(0, Math.min(100, percentRemaining));
  const limit = monthlyLimit ?? 0;
  const used = tokensUsedThisMonth ?? 0;
  const remaining = Math.max(0, limit - used);
  return (
    <div className="px-2 pt-1 space-y-1">
      <div className="flex flex-col gap-0.5 text-[11px] text-muted-foreground">
        <div className="flex justify-between gap-2">
          <span className="truncate" title="Tier from your Atlarix account (Supabase)">
            {ATLARIX_CORE_CATEGORY_LABEL} · {subscriptionTierLabel}
          </span>
          <span className="tabular-nums shrink-0">
            {remaining.toLocaleString()} / {limit.toLocaleString()} tokens left
          </span>
        </div>
        <div className="flex justify-end">
          <span className="tabular-nums text-[10px] opacity-90">
            {pct.toFixed(1)}% of monthly quota
          </span>
        </div>
      </div>
      <Progress value={pct} className="h-1" />
    </div>
  );
}
