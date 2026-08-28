/**
 * The arithmetic of a refund, with no Deno and no network in it.
 *
 * WHY THIS IS A SEPARATE FILE. Everything else in an edge function is I/O — a
 * signature check, an RPC, a table write — and can only be exercised against a
 * live project. The decisions that are actually easy to get wrong are pure:
 * which product a payload is about, how much of a period was given back, and
 * which id in a payload is the one you meant. Those belong somewhere the unit
 * suite can reach, because the alternative is discovering them on a customer's
 * refund.
 *
 * Deliberately importable from BOTH runtimes: Deno takes it as `./refund-math.ts`
 * from the function, Vitest takes it extensionless from `src/__tests__`. No
 * external imports, no globals — that is the whole constraint that keeps it so.
 */

export type BillingProduct = "pro" | "reviewer";

/**
 * The subscription-invoice fields a refund event carries, as they actually
 * arrive: LemonSqueezy sends numbers, but a payload is untrusted input and a
 * missing field is `undefined`, so the type says so rather than pretending.
 */
export type RefundAmounts = {
  refunded_amount?: unknown;
  total?: unknown;
  subtotal?: unknown;
};

/** A finite, positive number or null. Strings that look numeric do not count. */
function positiveNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

export type RefundFraction = {
  /** 0 < fraction <= 1. */
  fraction: number;
  /**
   * True when the amounts could not be read and the full period was assumed.
   * The caller logs this: silently guessing at a money path is how a wrong
   * number survives.
   */
  assumedFull: boolean;
};

/**
 * How much of a billing period a refund gave back.
 *
 * DEFAULTS TO FULL when the amounts are unreadable, and that direction is
 * chosen rather than fallen into: most refunds are full, and under-clawing an
 * allowance leaves the customer holding credit that has already been paid back
 * to them in cash. Over-clawing is bounded — the grant floors at zero and the
 * customer can be made whole by hand — while under-clawing is invisible.
 *
 * Clamped at 1 because LemonSqueezy's `refunded_amount` is gross while `total`
 * may be read as net in some payloads; a ratio above 1 is a payload we do not
 * understand, not a licence to take more than a period's allowance.
 */
export function refundFraction(amounts: RefundAmounts): RefundFraction {
  const refunded = positiveNumber(amounts.refunded_amount);
  const basis = positiveNumber(amounts.total) ?? positiveNumber(amounts.subtotal);
  if (refunded === null || basis === null) return { fraction: 1, assumedFull: true };
  return { fraction: Math.min(1, refunded / basis), assumedFull: false };
}

/**
 * The allowance to claw back for a refunded period.
 *
 * Rounds rather than truncating so a full refund of a period always returns the
 * whole allowance — `Math.trunc` on `1000 * (999/1000)` would leave a cent
 * behind on every rounding-error refund, and a grant that never quite empties
 * is a grant that keeps a subscription alive after it was refunded.
 */
export function grantClawbackCents(monthlyGrantCents: number, fraction: number): number {
  if (!Number.isFinite(monthlyGrantCents) || monthlyGrantCents <= 0) return 0;
  const clamped = Math.max(0, Math.min(1, fraction));
  return Math.round(monthlyGrantCents * clamped);
}

/**
 * How much purchased credit to take back on a refunded top-up order.
 *
 * `refunded_amount` FIRST, because LemonSqueezy supports partial refunds and
 * `subtotal` is what the order was worth, not what was given back — reading it
 * would claw back $50 on a $10 refund. `subtotal` remains the fallback because
 * it is the correct answer for a full refund and an older payload may not carry
 * the newer field; returning 0 instead would leave a refunded order still
 * spendable, which is the worse failure.
 */
export function creditClawbackCents(amounts: RefundAmounts): number {
  const refunded = positiveNumber(amounts.refunded_amount);
  if (refunded !== null) return Math.round(refunded);
  const subtotal = positiveNumber(amounts.subtotal);
  return subtotal === null ? 0 : Math.round(subtotal);
}

/**
 * Which product a subscription event is about.
 *
 * `kind` (from the checkout's custom_data) is the strong signal but it is only
 * present on events descended from a checkout we created. Renewals, refunds and
 * cancellations arrive with no custom_data at all, so `variant_id` has to carry
 * it — which is why the variant id is compared rather than merely stored.
 *
 * Unknown falls to 'pro', preserving the behaviour every existing Pro subscriber
 * already has: those rows predate REVIEWER_VARIANT_ID being set and their
 * renewals carry no custom_data, so anything else would strand them.
 */
export function productOf(
  kind: string,
  variantId: string,
  reviewerVariantId: string | null | undefined,
): BillingProduct {
  if (kind === "reviewer") return "reviewer";
  if (reviewerVariantId && variantId && variantId === reviewerVariantId) return "reviewer";
  return "pro";
}

/**
 * The two ids on a subscription-invoice payload, named so they cannot be swapped.
 *
 * THIS IS THE TRAP THE WHOLE MODULE EXISTS FOR. On `subscription_payment_success`
 * and `subscription_payment_refunded` the event object is an INVOICE, so
 * `data.id` is the invoice id and the subscription lives at
 * `attributes.subscription_id`. Every other subscription event puts the
 * subscription at `data.id`. Reading the wrong one does not throw — it silently
 * addresses a subscription that does not exist, and the handler logs "unknown
 * subscription" for a customer who is very much known.
 */
export function invoiceIds(event: {
  data?: { id?: unknown; attributes?: { subscription_id?: unknown } };
}): { invoiceId: string; subscriptionId: string } {
  return {
    invoiceId: String(event.data?.id ?? ""),
    subscriptionId: String(event.data?.attributes?.subscription_id ?? ""),
  };
}

/**
 * How much MORE to claw back, given a CUMULATIVE refunded total.
 *
 * THE BUG THIS EXISTS FOR, found auditing the money path 2026-08-28.
 *
 * LemonSqueezy supports partial refunds — a merchant can "issue multiple refunds
 * until the remainder is zero" — and `order_refunded` fires on each one, with
 * `refunded_amount` carrying the RUNNING TOTAL refunded so far, not that
 * refund's own amount.
 *
 * Both clawback paths fed that running total into `credit_wallet_service` /
 * `refund_grant_service` under a ref keyed on the order or invoice, where
 * `ON CONFLICT (kind, ref) DO NOTHING` treats a second arrival as a webhook
 * replay. So only the FIRST partial refund on an order ever moved money. Refund
 * $5 and then $5 more on a $20 top-up and the customer has been paid $10 while
 * keeping $5 of spendable credit.
 *
 * It is the same mistake the grants already carry a warning about — "an
 * allowance is SET, not added, so (kind, ref) idempotency cannot protect it" —
 * arriving from the other direction: a cumulative TOTAL pushed through an
 * ADDITIVE primitive. Replay-dedupe is correct for a delta and wrong for a
 * running total, and the two are indistinguishable at the call site.
 *
 * So the caller reads what it has already taken for that order and passes it in.
 * A replay of the same event yields 0; a genuine second partial refund yields
 * only the new part; a payload that somehow reports LESS than we already took
 * yields 0 rather than handing money back.
 */
export function incrementalClawbackCents(
  cumulativeCents: number,
  alreadyTakenCents: number,
): number {
  if (!Number.isFinite(cumulativeCents) || cumulativeCents <= 0) return 0;
  if (!Number.isFinite(alreadyTakenCents) || alreadyTakenCents < 0) alreadyTakenCents = 0;
  return Math.max(0, Math.round(cumulativeCents) - Math.round(alreadyTakenCents));
}
