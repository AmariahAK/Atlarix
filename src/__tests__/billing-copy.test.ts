import { describe, expect, it } from "vitest";
import {
  CORE_EXHAUSTED_MARKER,
  CORE_EXHAUSTED_MESSAGE,
  CORE_PAYMENT_SUMMARY,
  COMPASS_REACHABILITY_ERROR,
  CORE_REACHABILITY_MARKER,
  PRO_SUMMARY,
  allowanceUsedUpNudge,
  coreExhaustedUserMessage,
  describeIncludedUsage,
  formatCents,
  lowBalanceNudge,
} from "@/shared/billing_copy";
import { classifyCompassFailure } from "@/lib/chat/compass-failure-classifier";

/**
 * These are not tests of wording. Each one pins a coupling that has already
 * broken silently, or a claim that stopped being true when Pro started including
 * Atlarix Core.
 */

describe("the markers the error box matches on", () => {
  // THE FAILURE THIS PREVENTS: `ChatErrorBox` decides whether to show the "Top up
  // credit" button by searching the streamed error text for a substring. That
  // substring used to be typed out in the component, so rewording the message
  // removed the button from the error that most needs it — silently, with no
  // failing test and nothing logged.
  it("CORE_EXHAUSTED_MARKER actually appears in the exhausted message", () => {
    expect(CORE_EXHAUSTED_MESSAGE).toContain(CORE_EXHAUSTED_MARKER);
  });

  it("CORE_REACHABILITY_MARKER actually appears in the reachability message", () => {
    expect(COMPASS_REACHABILITY_ERROR).toContain(CORE_REACHABILITY_MARKER);
  });

  it("the classifier's 402 output carries the marker end to end", () => {
    // The real path: proxy 402 -> classifier -> streamed string -> error box.
    // Testing the message alone would not catch the classifier being rewired.
    const { message } = classifyCompassFailure(402, "");
    expect(message).toContain(CORE_EXHAUSTED_MARKER);
  });

  it("the classifier's fallback output carries the reachability marker", () => {
    const { message } = classifyCompassFailure(500, "something unrecognised");
    expect(message).toContain(CORE_REACHABILITY_MARKER);
  });
});

describe("no message claims a tier gates AI", () => {
  // Pro stopped being the thing standing between a user and a model on
  // 2026-08-26. A running-out-of-credit message that says "upgrade" sends a
  // paying customer to buy something they already have.
  const balanceMessages = [
    CORE_EXHAUSTED_MESSAGE,
    coreExhaustedUserMessage(),
    lowBalanceNudge(50).title,
    lowBalanceNudge(50).description,
    allowanceUsedUpNudge(500).title,
    allowanceUsedUpNudge(500).description,
  ];

  it("never tells someone to upgrade in order to keep using a model", () => {
    for (const message of balanceMessages) {
      expect(message).not.toMatch(/upgrade/i);
    }
  });

  it("does not name a tier in a message about a balance", () => {
    // A 402 means the SPENDABLE total is zero — both halves gone — so there is
    // no distinction left to draw, and naming Pro would tell a Free user about
    // an allowance they never had.
    expect(CORE_EXHAUSTED_MESSAGE).not.toMatch(/\bPro\b|\bFree\b/);
    expect(lowBalanceNudge(50).description).not.toMatch(/\bPro\b|\bFree\b/);
  });

  it("still tells the user the two things that actually work", () => {
    expect(CORE_EXHAUSTED_MESSAGE).toMatch(/top up/i);
    expect(CORE_EXHAUSTED_MESSAGE).toMatch(/own API key|local model/i);
  });
});

describe("the allowance is never published in dollars", () => {
  // Denominating it prices our own cost structure and invites the "$19 for $10"
  // comparison. The summaries describe what it BUYS.
  it("does not state the monthly grant amount", () => {
    for (const copy of [PRO_SUMMARY, CORE_PAYMENT_SUMMARY]) {
      expect(copy).not.toMatch(/\$\s?\d/);
    }
  });

  it("says Pro includes Core rather than that both plans pay the same way", () => {
    expect(CORE_PAYMENT_SUMMARY).toMatch(/Pro includes Core/i);
    expect(CORE_PAYMENT_SUMMARY).not.toMatch(/same way|every plan is|no plan bundles/i);
  });
});

describe("the nudge that fires when the month's usage runs out", () => {
  it("reports what is left of the purchased half, not the total", () => {
    // The whole point of this message is that the balance has changed character:
    // the user is now spending money they paid rather than usage that resets.
    expect(allowanceUsedUpNudge(742).description).toContain("$7.42");
  });

  it("is not phrased as a failure — nothing has stopped", () => {
    const { title, description } = allowanceUsedUpNudge(742);
    expect(`${title} ${description}`).not.toMatch(/error|failed|cannot|unable/i);
  });
});

describe("describeIncludedUsage gives the bar a scale", () => {
  it("answers 'is that a lot' in turns rather than dollars", () => {
    const text = describeIncludedUsage(1000);
    expect(text).toMatch(/turns/i);
    expect(text).not.toMatch(/\$/);
  });

  it("says used up at zero rather than 'about 0 turns'", () => {
    expect(describeIncludedUsage(0)).toMatch(/used up/i);
    expect(describeIncludedUsage(0)).not.toMatch(/about 0/i);
  });

  it("does not round a nearly-empty allowance up to a turn count", () => {
    expect(describeIncludedUsage(3)).not.toMatch(/about \d+ more turns/i);
  });

  it("stops counting once the number stops being an answer", () => {
    // A comped or internal account carries a balance in the millions of cents.
    // "About 20000000 more turns" does not tell anyone whether that is a lot —
    // it just reads as a bug.
    const text = describeIncludedUsage(100_000_000);
    expect(text).not.toMatch(/\d{5}/);
    expect(text).toMatch(/more than you are likely to use/i);
  });
});

describe("formatCents", () => {
  it("renders a negative balance as negative, because that is a real state", () => {
    // A refund claws back what was credited even when it has been spent, so the
    // wallet genuinely lands below zero.
    expect(formatCents(-420)).toBe("-$4.20");
  });

  it("always shows two decimal places", () => {
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(1900)).toBe("$19.00");
    expect(formatCents(5)).toBe("$0.05");
  });
});
