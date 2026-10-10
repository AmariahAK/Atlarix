import { describe, expect, it } from "vitest";
import {
  clampRecap,
  nearFreeLimit,
  recapDecision,
  RECAP_AWAY_MS,
  RECAP_MAX_CHARS,
  type RecapInputs,
} from "@/lib/recap/rules";

const base = (over: Partial<RecapInputs> = {}): RecapInputs => ({
  enabled: true,
  present: false,
  busy: false,
  completedTurns: 3,
  lastTurnEndedAt: 0,
  recappedAfterTurn: -1,
  now: RECAP_AWAY_MS,
  ...over,
});

describe("recapDecision", () => {
  it("is due three minutes after the last turn, while the user is away", () => {
    expect(recapDecision(base())).toEqual({ kind: "now" });
  });

  it("waits out the rest of the three minutes", () => {
    expect(recapDecision(base({ now: 60_000 }))).toEqual({ kind: "wait", ms: RECAP_AWAY_MS - 60_000 });
  });

  it("never while the user is here, a turn runs, or it is switched off", () => {
    expect(recapDecision(base({ present: true })).kind).toBe("never");
    expect(recapDecision(base({ busy: true })).kind).toBe("never");
    expect(recapDecision(base({ enabled: false })).kind).toBe("never");
  });

  it("needs three finished turns", () => {
    expect(recapDecision(base({ completedTurns: 2 })).kind).toBe("never");
  });

  it("never twice in a row: a new turn has to finish first", () => {
    expect(recapDecision(base({ recappedAfterTurn: 3 })).kind).toBe("never");
    expect(recapDecision(base({ recappedAfterTurn: 3, completedTurns: 4 })).kind).toBe("now");
  });

  it("stops on free Auto when today's share is nearly used", () => {
    expect(recapDecision(base({ nearFreeLimit: true })).kind).toBe("never");
    expect(nearFreeLimit({ billing: "free", freeRemaining: 12 })).toBe(true);
    expect(nearFreeLimit({ billing: "free", freeRemaining: 60 })).toBe(false);
    expect(nearFreeLimit({ billing: "paid", freeRemaining: 0 })).toBe(false);
    expect(nearFreeLimit(null)).toBe(false);
  });
});

describe("clampRecap", () => {
  it("makes one plain line", () => {
    expect(clampRecap("Recap: **Fixing** the `login` test.\n\nNext: run it.")).toBe("Fixing the login test. Next: run it.");
  });

  it("drops a model's thinking", () => {
    expect(clampRecap("<think>let me see</think>Adding a /health route.")).toBe("Adding a /health route.");
  });

  it("caps at 400 characters on a word", () => {
    const out = clampRecap("word ".repeat(200));
    expect(out.length).toBeLessThanOrEqual(RECAP_MAX_CHARS);
    expect(out.endsWith("…")).toBe(true);
  });
});
