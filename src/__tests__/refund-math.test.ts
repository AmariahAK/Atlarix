import { describe, expect, it } from "vitest";
import {
  creditClawbackCents,
  incrementalClawbackCents,
  grantClawbackCents,
  invoiceIds,
  productOf,
  refundFraction,
} from "../../supabase/functions/_shared/refund-math";

/**
 * The pure half of the LemonSqueezy refund path.
 *
 * Everything else in that edge function is I/O and can only be exercised against
 * a live project. These are the decisions that are actually easy to get wrong,
 * and each test below corresponds to a specific way money moves incorrectly —
 * not to a line of code.
 */

const REVIEWER_VARIANT = "999111";

describe("invoiceIds — the id trap", () => {
  it("takes the SUBSCRIPTION from attributes, not from data.id", () => {
    // data.id is the INVOICE on a payment_success/payment_refunded event. Reading
    // it as the subscription does not throw; it addresses a subscription that
    // does not exist and logs "unknown subscription" for a known customer.
    const event = {
      data: { id: "inv_500", attributes: { subscription_id: "sub_42" } },
    };
    expect(invoiceIds(event)).toEqual({ invoiceId: "inv_500", subscriptionId: "sub_42" });
  });

  it("stringifies numeric ids — LemonSqueezy sends both shapes", () => {
    const event = { data: { id: 500, attributes: { subscription_id: 42 } } };
    expect(invoiceIds(event)).toEqual({ invoiceId: "500", subscriptionId: "42" });
  });

  it("returns empty strings rather than undefined when the payload is unrecognised", () => {
    // The caller guards on falsiness; `String(undefined)` would produce the
    // string "undefined", which is truthy and would sail past that guard.
    expect(invoiceIds({})).toEqual({ invoiceId: "", subscriptionId: "" });
    expect(invoiceIds({ data: {} })).toEqual({ invoiceId: "", subscriptionId: "" });
  });
});

describe("productOf", () => {
  it("trusts custom_data.kind when it is there", () => {
    expect(productOf("reviewer", "", REVIEWER_VARIANT)).toBe("reviewer");
  });

  it("falls back to the variant id, which is the only signal a refund carries", () => {
    // Refunds, renewals and cancellations arrive with NO custom_data.
    expect(productOf("", REVIEWER_VARIANT, REVIEWER_VARIANT)).toBe("reviewer");
  });

  it("does not classify as reviewer when the variant is unconfigured", () => {
    // An unset REVIEWER_VARIANT_ID must not make every event match on "".
    expect(productOf("", "", null)).toBe("pro");
    expect(productOf("", "", "")).toBe("pro");
  });

  it("defaults to pro, so pre-existing subscribers are never stranded", () => {
    expect(productOf("", "someone-elses-variant", REVIEWER_VARIANT)).toBe("pro");
  });
});

describe("refundFraction", () => {
  it("reads a full refund as the whole period", () => {
    expect(refundFraction({ refunded_amount: 1900, total: 1900 })).toEqual({
      fraction: 1,
      assumedFull: false,
    });
  });

  it("reads a partial refund as its share", () => {
    const { fraction, assumedFull } = refundFraction({ refunded_amount: 950, total: 1900 });
    expect(fraction).toBeCloseTo(0.5);
    expect(assumedFull).toBe(false);
  });

  it("falls back to subtotal when total is absent", () => {
    const { fraction } = refundFraction({ refunded_amount: 475, subtotal: 1900 });
    expect(fraction).toBeCloseTo(0.25);
  });

  it("clamps above 1 — a ratio over the basis is a payload we do not understand", () => {
    // refunded_amount is gross while some payloads report total as net, so this
    // is reachable. It must not license taking more than one period's allowance.
    expect(refundFraction({ refunded_amount: 2200, total: 1900 }).fraction).toBe(1);
  });

  it("assumes a FULL refund when the amounts are unreadable, and says so", () => {
    // The direction is chosen, not fallen into: under-clawing leaves the customer
    // holding credit already paid back to them in cash, and is invisible.
    // Over-clawing is bounded by the grant's floor at zero.
    for (const amounts of [{}, { refunded_amount: 0, total: 1900 }, { refunded_amount: 950 }]) {
      expect(refundFraction(amounts)).toEqual({ fraction: 1, assumedFull: true });
    }
  });

  it("refuses numeric STRINGS rather than coercing them", () => {
    // A payload that starts sending "1900" should surface as assumedFull and a
    // warning line, not as a silently wrong ratio from string arithmetic.
    expect(refundFraction({ refunded_amount: "950", total: "1900" }).assumedFull).toBe(true);
  });
});

describe("grantClawbackCents", () => {
  it("returns the whole allowance on a full refund", () => {
    expect(grantClawbackCents(1000, 1)).toBe(1000);
  });

  it("scales with the refunded fraction", () => {
    expect(grantClawbackCents(1000, 0.5)).toBe(500);
  });

  it("ROUNDS rather than truncating, so a full refund never leaves a cent behind", () => {
    // A grant that never quite empties is a grant that keeps a refunded
    // subscription's allowance alive.
    expect(grantClawbackCents(1000, 999 / 1000)).toBe(999);
    expect(grantClawbackCents(1000, 0.9999)).toBe(1000);
  });

  it("clamps the fraction and refuses a nonsense allowance", () => {
    expect(grantClawbackCents(1000, 2)).toBe(1000);
    expect(grantClawbackCents(1000, -1)).toBe(0);
    expect(grantClawbackCents(0, 1)).toBe(0);
    expect(grantClawbackCents(Number.NaN, 1)).toBe(0);
  });
});

describe("creditClawbackCents", () => {
  it("takes back exactly what was refunded on a PARTIAL refund", () => {
    // The bug this replaces: reading `subtotal` clawed back $50 on a $10 refund.
    expect(creditClawbackCents({ refunded_amount: 1000, subtotal: 5000 })).toBe(1000);
  });

  it("falls back to subtotal, which is right for a full refund on an older payload", () => {
    expect(creditClawbackCents({ subtotal: 5000 })).toBe(5000);
  });

  it("returns 0 only when there is genuinely nothing to read", () => {
    expect(creditClawbackCents({})).toBe(0);
    expect(creditClawbackCents({ refunded_amount: 0, subtotal: 0 })).toBe(0);
  });

  it("never returns a negative — the caller negates it, and two negations pay the refund out", () => {
    expect(creditClawbackCents({ refunded_amount: -500 })).toBe(0);
    expect(creditClawbackCents({ refunded_amount: -500, subtotal: 5000 })).toBe(5000);
  });
});

/**
 * Partial refunds. LemonSqueezy sends `refunded_amount` as a RUNNING TOTAL and
 * fires `order_refunded` on every partial refund — so the clawback has to be the
 * difference, not the total, or the `(kind, ref)` replay dedupe silently drops
 * every refund after the first.
 */
describe("incrementalClawbackCents", () => {
  it("takes the whole amount when nothing has been taken yet", () => {
    expect(incrementalClawbackCents(500, 0)).toBe(500);
  });

  it("takes only the NEW part of a second partial refund", () => {
    // $5 refunded, then $5 more: the event says 1000 cumulative and 500 is gone.
    expect(incrementalClawbackCents(1000, 500)).toBe(500);
  });

  it("takes nothing when the same event is replayed", () => {
    // This is what makes the fix safe: replay protection now comes from the
    // arithmetic, not only from the unique index.
    expect(incrementalClawbackCents(1000, 1000)).toBe(0);
  });

  it("never hands money BACK when the payload reports less than we took", () => {
    // A corrected or out-of-order payload must not become a credit.
    expect(incrementalClawbackCents(500, 1000)).toBe(0);
  });

  it("treats junk as nothing to do", () => {
    expect(incrementalClawbackCents(Number.NaN, 0)).toBe(0);
    expect(incrementalClawbackCents(-100, 0)).toBe(0);
    expect(incrementalClawbackCents(500, Number.NaN)).toBe(500);
  });
});
