import { USAGE_LABELS, describeIncludedUsage, formatCents } from "@/shared/billing_copy";

/**
 * The Atlarix Core balance, split into the half that expires and the half that
 * does not.
 *
 * WHY TWO SUB-NUMBERS AND NOT PER PRODUCT. The obvious design — "Pro allowance
 * $8, Reviewer allowance $10" — would be misleading rather than merely
 * incomplete, because `spend_from_wallet` deliberately spills allowances across
 * products: a review may be paid for out of the Pro allowance once the Reviewer
 * one is gone. So "Reviewer allowance: $10" is not a statement about what
 * reviews can consume. What IS true, and what matters to the reader, is which
 * part expires. Identical reasoning, and identical labels, to the web account
 * page's card — the two are the same fact shown to the same person.
 *
 * WHY NOT `components/ui/progress.tsx`. That one is single-segment: one track,
 * one fill. A stacked bar with two meanings is not a value it can express, and
 * bending it into one would leave a shared primitive owning a billing concept.
 *
 * RENDERS NOTHING when the server reported no split. Absent is not zero — an
 * older server that returns only a total must not be drawn as an empty
 * allowance, which is a different and alarming claim.
 */
export function CreditSplitBar({
  grantedCents,
  purchasedCents,
}: {
  grantedCents: number | null;
  purchasedCents: number | null;
}) {
  if (grantedCents == null || purchasedCents == null) return null;

  // A negative wallet (a refund clawed back after the credit was spent) has no
  // sensible bar: the fill would be a negative width. The card's own
  // negative-balance explainer is the right surface for that state.
  const granted = Math.max(0, grantedCents);
  const purchased = Math.max(0, purchasedCents);
  const total = granted + purchased;
  if (total <= 0) return null;

  const grantedPct = (granted / total) * 100;

  return (
    <div className="space-y-2">
      <div
        className="flex h-2 w-full overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={`${USAGE_LABELS.included}: ${formatCents(granted)}. ${USAGE_LABELS.purchased}: ${formatCents(purchased)}.`}
      >
        {/* Two segments of one bar, not two bars: the point is that they are one
            spendable balance, and that only one of them survives the month. */}
        <div className="h-full bg-primary" style={{ width: `${grantedPct}%` }} />
        <div className="h-full bg-primary/35" style={{ width: `${100 - grantedPct}%` }} />
      </div>

      <div className="flex justify-between gap-4 text-xs">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-2 shrink-0 rounded-full bg-primary" aria-hidden />
            <span className="text-foreground font-medium tabular-nums">
              {formatCents(granted)}
            </span>
          </div>
          <div className="text-muted-foreground">{USAGE_LABELS.included}</div>
          {/* A bar with no scale invites "is that a lot?". */}
          <div className="text-muted-foreground/80">{describeIncludedUsage(granted)}</div>
        </div>
        <div className="min-w-0 text-right">
          <div className="flex items-center justify-end gap-1.5">
            <span className="text-foreground font-medium tabular-nums">
              {formatCents(purchased)}
            </span>
            <span className="h-2 w-2 shrink-0 rounded-full bg-primary/35" aria-hidden />
          </div>
          <div className="text-muted-foreground">{USAGE_LABELS.purchased}</div>
          <div className="text-muted-foreground/80">{USAGE_LABELS.purchasedHint}</div>
        </div>
      </div>
    </div>
  );
}

export default CreditSplitBar;
