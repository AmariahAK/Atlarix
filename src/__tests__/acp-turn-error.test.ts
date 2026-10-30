/**
 * How an ACP editor hears a failed turn (QA 2026-10-31):
 * - C2: a billing or gate refusal reached Zed as JSON-RPC "Internal error:
 *   Sorry, there was an error from the AI: …" in a red box; it is the turn's
 *   answer and comes as text. Atlarix's own panel still takes it as an error,
 *   which draws its buttons.
 * - B3: a second refusal identical to the first showed nothing at all.
 */
import { describe, expect, it } from "vitest";
import { refusalDelivery, turnErrorSince } from "@/cli/acp/turn-error";
import {
  coreRateLimitedMessage,
  coreRefusalMessage,
  freeAutoBusyMessage,
  freeAutoLimitMessage,
  parseCreditRefusal,
  turnErrorText,
} from "@/shared/billing_copy";

const neverFunded = coreRefusalMessage(parseCreditRefusal({ plan: "free", ever_funded: false }));
const gates = [
  neverFunded,
  coreRefusalMessage(parseCreditRefusal({ plan: "free", ever_funded: true })),
  coreRefusalMessage(parseCreditRefusal({ plan: "pro" })),
  coreRefusalMessage(parseCreditRefusal({})),
  freeAutoLimitMessage(Date.now() + 3_600_000),
  freeAutoBusyMessage(),
  coreRateLimitedMessage(40),
];

describe("a gate refusal is an answer (C2, B1)", () => {
  it("is sent without the AI-error prefix; a real failure keeps it", () => {
    for (const g of gates) expect(turnErrorText(g)).toBe(g);
    expect(turnErrorText("The model returned nothing.")).toBe("Sorry, there was an error from the AI: The model returned nothing.");
  });

  it("reaches Zed and other editors as the reply, and Atlarix's panel as an error", () => {
    for (const g of gates) {
      expect(refusalDelivery(g, false)).toBe("reply");
      expect(refusalDelivery(g, true)).toBe("error");
    }
    expect(refusalDelivery("Sorry, there was an error from the AI: boom", false)).toBe("error");
  });
});

describe("the turn's own error (B3)", () => {
  it("a second refusal identical to the first is still this turn's", () => {
    const before = { error: neverFunded, startedAt: 1000 };
    expect(turnErrorSince(before, { error: neverFunded, startedAt: 2000 })).toBe(neverFunded);
  });

  it("no turn started: only a new text counts", () => {
    const before = { error: "old", startedAt: 1000 };
    expect(turnErrorSince(before, { error: "old", startedAt: 1000 })).toBeNull();
    expect(turnErrorSince(before, { error: "new", startedAt: 1000 })).toBe("new");
    expect(turnErrorSince(before, { error: null, startedAt: 2000 })).toBeNull();
  });
});
