import {
  USAGE_LABELS,
  describeAllowanceUsed,
  describeIncludedUsage,
} from "@/shared/billing_copy";

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
 * A PERCENTAGE, NOT DOLLARS. The first version read "$0.42 of $1,000,000.00
 * used", which broke this file's own rule against printing the allowance in
 * dollars — that publishes our cost structure and invites the "$19 for $10"
 * comparison. A share of the whole tells the reader the same thing and a
 * competitor nothing.
 *
 * PURCHASED CREDIT IS NOT HERE AT ALL. It has no denominator — it is money the
 * user added, not an allotment they are working through — so it belongs beside
 * the card's headline as a plain figure, not inside a meter that would invent a
 * budget nobody agreed to.
 *
 * TWO SUB-NUMBERS, NEVER PER PRODUCT. `spend_from_wallet` deliberately spills
 * allowances across products, so "Reviewer allowance: $10" would not be a
 * statement about what reviews can consume. Same rule as the web account card.
 */
export function CreditSplitBar({
  grantedCents,
  grantedTotalCents,
}: {
  grantedCents: number | null;
  grantedTotalCents: number | null;
}) {
  // Absent is not zero. An older server that reports no split must render as
  // nothing rather than as an empty allowance, which is a different claim.
  if (grantedCents == null || grantedTotalCents == null || grantedTotalCents <= 0) return null;

  const total = Math.max(0, grantedTotalCents);
  // Clamped to the total: a refund keeps the invariant, but a hand-edited row
  // should degrade to a full bar rather than a negative width.
  const remaining = Math.min(Math.max(0, grantedCents), total);
  const used = total - remaining;
  const meter = { used, total, remaining, pct: (used / total) * 100 };

  return (
    <div className="space-y-3">
      {meter ? (
        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between gap-3 text-xs">
            <span className="text-muted-foreground">{USAGE_LABELS.included}</span>
            <span className="font-medium tabular-nums text-foreground">
              {describeAllowanceUsed(meter.used, meter.total)}
            </span>
          </div>

          <div
            className="h-2 w-full overflow-hidden rounded-full border border-border bg-muted/60"
            role="img"
            aria-label={`${USAGE_LABELS.included}: ${describeAllowanceUsed(meter.used, meter.total)}.`}
          >
            {/* A visible minimum. At 0.00004% the fill is sub-pixel and the bar
                reads as an empty gap rather than as a meter that is barely
                touched — which is a different statement. */}
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: meter.pct > 0 ? `${Math.max(meter.pct, 1.5)}%` : "0%" }}
            />
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

    </div>
  );
}

export default CreditSplitBar;
