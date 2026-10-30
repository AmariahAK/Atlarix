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
  describeAllowanceUsed,
  describeIncludedUsage,
  formatCents,
  lowBalanceNudge,
  CORE_NEVER_FUNDED_MARKER,
  CREDIT_FIRST_LINE,
  FREE_BUSY_MARKER,
  FREE_LIMIT_MARKER,
  PRO_ALLOWANCE_MARKER,
  RESETS_IN_PATTERN,
  UPGRADE_LINE,
  coreRefusalMessage,
  freeAutoBusyMessage,
  freeAutoLimitMessage,
  parseCreditRefusal,
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
    expect(CORE_PAYMENT_SUMMARY).not.toMatch(
      /same way|every plan is|no plan bundles/i,
    );
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
    expect(`${title} ${description}`).not.toMatch(
      /error|failed|cannot|unable/i,
    );
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

  it("groups thousands, because an ungrouped balance has to be counted", () => {
    // A comped account rendered as `$1000000.67`, which the owner reported as looking
    // wrong — you cannot tell a million from ten million without counting digits.
    expect(formatCents(100_000_067)).toBe("$1,000,000.67");
    expect(formatCents(100_000)).toBe("$1,000.00");
    // The boundary: no separator below a thousand, so ordinary balances are unchanged.
    expect(formatCents(99_999)).toBe("$999.99");
    expect(formatCents(-100_000_067)).toBe("-$1,000,000.67");
  });

  it("pins en-US so the separators cannot invert next to a hard-coded $", () => {
    // The app is translated and the `$` in this helper is not, so a locale that swaps
    // group and decimal separators would render `$1.000.000,67`. Grouping is asserted
    // as a LITERAL rather than by reformatting with the ambient locale, which would
    // agree with the bug.
    expect(formatCents(123_456_789)).toBe("$1,234,567.89");
  });
});

describe("describeAllowanceUsed — a share, never a dollar figure", () => {
  it("never prints the allowance in dollars", () => {
    // This is the rule at the top of billing_copy, and the first usage bar broke
    // it: it read "$0.42 of $1,000,000.00 used", which publishes the very number
    // the module says not to publish.
    for (const [used, total] of [
      [300, 1000],
      [1, 1000],
      [0, 1000],
      [1000, 1000],
    ]) {
      expect(describeAllowanceUsed(used, total)).not.toMatch(/\$/);
    }
  });

  it("rounds to a whole percent", () => {
    expect(describeAllowanceUsed(300, 1000)).toBe("30% used");
    expect(describeAllowanceUsed(1000, 1000)).toBe("100% used");
  });

  it("says <1% rather than 0% once anything has been spent", () => {
    // Rounding real usage down to zero tells someone their metered account is
    // not being metered. The comped account this was found on sits here.
    expect(describeAllowanceUsed(42, 100_000_000)).toBe("<1% used");
    expect(describeAllowanceUsed(0, 1000)).toBe("0% used");
  });

  it("cannot exceed 100% or go negative", () => {
    expect(describeAllowanceUsed(2000, 1000)).toBe("100% used");
    expect(describeAllowanceUsed(-5, 1000)).toBe("0% used");
  });

  it("says nothing at all when there is no allowance to describe", () => {
    expect(describeAllowanceUsed(0, 0)).toBe("");
  });
});

describe("the three refusals of a 402 (owner, 2026-10-27/28)", () => {
  const body = (extra: Record<string, unknown>) =>
    JSON.stringify({ error: "insufficient_credit", required_cents: 125, ...extra });

  it("reads the optional fields from JSON, from JSON inside a wrapper, and never throws on junk", () => {
    expect(parseCreditRefusal(body({ plan: "free", ever_funded: false }))).toEqual({
      requiredCents: 125,
      plan: "free",
      everFunded: false,
      renewsAt: null,
    });
    expect(
      parseCreditRefusal(`Provider error: ${body({ plan: "pro", ever_funded: true, renews_at: "2026-11-05T00:00:00Z" })} (402)`),
    ).toEqual({ requiredCents: 125, plan: "pro", everFunded: true, renewsAt: "2026-11-05T00:00:00Z" });
    for (const junk of ["", "not json", "{", null, undefined, 42, '{"plan":"gold","ever_funded":"yes","renews_at":"soon"}']) {
      expect(parseCreditRefusal(junk)).toMatchObject({ plan: null, everFunded: null, renewsAt: null });
    }
  });

  it("a $0 account that never added credit hears Core runs on credit, and Auto is free", () => {
    const m = coreRefusalMessage(parseCreditRefusal(body({ plan: "free", ever_funded: false })));
    expect(m).toBe(
      "Atlarix Core models run on credit. Add credit or get Pro to use them, or switch to Atlarix Auto, which is free. This model needs at least $1.25 of credit.",
    );
    expect(m).toContain(CORE_NEVER_FUNDED_MARKER);
    expect(m).not.toContain(CORE_EXHAUSTED_MARKER);
  });

  it("an account that had credit and spent it keeps 'balance is used up', with the prices", () => {
    const m = coreRefusalMessage(parseCreditRefusal(body({ plan: "free", ever_funded: true })));
    expect(m).toMatch(/^Your Atlarix Core balance is used up\./);
    expect(m).toContain("from $10");
    expect(m).toContain("Pro ($19/month)");
    expect(m).toContain("This turn needs at least $1.25 available.");
  });

  it("Pro with the allowance spent hears when it resets, and is never told to get Pro", () => {
    const m = coreRefusalMessage(parseCreditRefusal(body({ plan: "pro", ever_funded: true, renews_at: "2026-11-05T12:00:00Z" })), "UTC");
    expect(m).toMatch(/^Your Pro allowance for this month is used up\. It resets on (November 5|5 November)\. Add credit to keep going, or use your own key\.$/);
    expect(m).toContain(PRO_ALLOWANCE_MARKER);
    expect(m).not.toMatch(/get Pro|\$19/);
    // No date known: the sentence is dropped, not filled with a guess.
    expect(coreRefusalMessage(parseCreditRefusal(body({ plan: "pro" })))).toBe(
      "Your Pro allowance for this month is used up. Add credit to keep going, or use your own key.",
    );
  });

  it("an older proxy (no fields) gets exactly today's sentence", () => {
    expect(coreRefusalMessage(parseCreditRefusal(body({})))).toBe(coreExhaustedUserMessage(125));
    expect(coreRefusalMessage(parseCreditRefusal(body({ plan: "free" })))).toBe(coreExhaustedUserMessage(125));
  });

  it("the classifier picks the state from the 402 body", () => {
    expect(classifyCompassFailure(402, body({ plan: "free", ever_funded: false })).message).toContain(CORE_NEVER_FUNDED_MARKER);
    expect(classifyCompassFailure(402, body({ plan: "pro" })).message).toContain(PRO_ALLOWANCE_MARKER);
  });
});

describe("banners name prices, never what a plan includes (owner, 2026-10-28)", () => {
  it("upgrade lines show $10 and Pro ($19/month), and no surface list", () => {
    for (const line of [UPGRADE_LINE, CREDIT_FIRST_LINE, freeAutoLimitMessage(null), freeAutoBusyMessage()]) {
      expect(line).toContain("$10");
      expect(line).toContain("$19/month");
      expect(line).not.toMatch(/Reviewer|Chrome extension|Slack|includes/i);
    }
  });
});

describe("free Auto's limit and busy are different things", () => {
  const now = Date.UTC(2026, 9, 29, 20, 40);

  it("the limit counts down to the reset, rounded up so it never says 0m", () => {
    expect(freeAutoLimitMessage(now + 200 * 60_000, now)).toMatch(/Resets in 3h 20m\./);
    expect(freeAutoLimitMessage(now + 30_000, now)).toMatch(/Resets in 1m\./);
    expect(freeAutoLimitMessage(new Date(now + 120 * 60_000).toISOString(), now)).toMatch(/Resets in 2h\./);
    expect(freeAutoLimitMessage(null, now)).toMatch(/Resets at midnight UTC\./);
    expect(freeAutoLimitMessage(now + 60_000, now)).toContain(FREE_LIMIT_MARKER);
  });

  it("the countdown pattern reads back what the message wrote", () => {
    const m = RESETS_IN_PATTERN.exec(freeAutoLimitMessage(now + 200 * 60_000, now))!;
    expect([m[1], m[2]]).toEqual(["3", "20"]);
  });

  it("busy has no reset time and never carries the limit's marker", () => {
    expect(freeAutoBusyMessage()).toContain(FREE_BUSY_MARKER);
    expect(freeAutoBusyMessage()).not.toContain(FREE_LIMIT_MARKER);
    expect(freeAutoBusyMessage()).not.toMatch(/Resets/);
  });
});
