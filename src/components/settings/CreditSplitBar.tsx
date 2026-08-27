import { USAGE_LABELS, describeIncludedUsage, formatCents } from "@/shared/billing_copy";

/**
 * How much of this month's included usage has been spent, and what purchased
 * credit is left beside it.
 *
 * WHY IT IS A METER AND NOT A SPLIT. The first version drew the two halves of the
 * balance side by side — allowance remaining next to credit remaining — which is
 * the COMPOSITION of what is left. On a real account that rendered as
 * "$999,999.73 included / $1,000,000.67 credit" and answered nothing anybody
 * asks. The question is "how much of my included usage have I used", and a bar
 * implies consumption whatever you put in it, so the honest fix was to make it
 * mean that.
 *
 * That needed a database change, not a CSS one: `credit_grants` stored only what
 * REMAINS, so the period's original amount did not exist client-side at all.
 * `granted_total_cents` is that number; consumed is the difference.
 *
 * PURCHASED CREDIT IS NOT IN THE BAR. It has no denominator — it is money the
 * user added, not an allotment they are working through — so drawing it as a
 * proportion of anything would invent a budget that does not exist.
 *
 * TWO SUB-NUMBERS, NEVER PER PRODUCT. `spend_from_wallet` deliberately spills
 * allowances across products, so "Reviewer allowance: $10" would not be a
 * statement about what reviews can consume. Same rule as the web account card.
 */
export function CreditSplitBar({
  grantedCents,
  grantedTotalCents,
  purchasedCents,
}: {
  grantedCents: number | null;
  grantedTotalCents: number | null;
  purchasedCents: number | null;
}) {
  // Absent is not zero. An older server that reports no split must render as
  // nothing rather than as an empty allowance, which is a different claim.
  const hasAllowance =
    grantedCents != null && grantedTotalCents != null && grantedTotalCents > 0;
  const hasPurchased = purchasedCents != null;
  if (!hasAllowance && !hasPurchased) return null;

  let meter: { used: number; total: number; remaining: number; pct: number } | null = null;
  if (hasAllowance) {
    const total = Math.max(0, grantedTotalCents);
    // Clamped to the total: a refund keeps the invariant, but a hand-edited row
    // should degrade to a full bar rather than a negative width.
    const remaining = Math.min(Math.max(0, grantedCents), total);
    const used = total - remaining;
    meter = { used, total, remaining, pct: (used / total) * 100 };
  }

  return (
    <div className="space-y-3">
      {meter ? (
        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between gap-3 text-xs">
            <span className="text-muted-foreground">{USAGE_LABELS.included}</span>
            <span className="tabular-nums text-foreground">
              <span className="font-medium">{formatCents(meter.used)}</span>
              <span className="text-muted-foreground"> of {formatCents(meter.total)} used</span>
            </span>
          </div>

          <div
            className="h-2 w-full overflow-hidden rounded-full bg-muted"
            role="img"
            aria-label={`${USAGE_LABELS.included}: ${formatCents(meter.used)} of ${formatCents(meter.total)} used, ${formatCents(meter.remaining)} remaining.`}
          >
            <div className="h-full bg-primary" style={{ width: `${meter.pct}%` }} />
          </div>

          <div className="flex items-baseline justify-between gap-3 text-xs text-muted-foreground">
            <span>{USAGE_LABELS.includedHint}</span>
            {/* Applied to what REMAINS — "is that a lot?" is a question about
                what is left, not about what is gone. Its own cap is what keeps a
                comped account from reading "About 20000000 more turns". */}
            <span>{describeIncludedUsage(meter.remaining)}</span>
          </div>
        </div>
      ) : null}

      {hasPurchased ? (
        <div className="flex items-baseline justify-between gap-3 border-t border-border pt-2 text-xs">
          <span className="text-muted-foreground">
            {USAGE_LABELS.purchased}
            <span className="text-muted-foreground/70"> · {USAGE_LABELS.purchasedHint}</span>
          </span>
          <span className="font-medium tabular-nums text-foreground">
            {formatCents(purchasedCents)}
          </span>
        </div>
      ) : null}
    </div>
  );
}

export default CreditSplitBar;
