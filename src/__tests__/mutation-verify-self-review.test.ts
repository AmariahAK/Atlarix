/**
 * v13.9.0: end-of-turn self-review. Each write's on-disk re-check records a
 * running true/false state per turn; the task_complete gate consolidates it
 * into a single nudge that fires ONLY when an edit didn't land. A later good
 * write of the same path clears its prior failure ("most recent wins").
 */
import { describe, it, expect } from "vitest";
import {
  recordUnverifiedEdit,
  clearUnverifiedEdit,
  getUnverifiedEditFeedback,
  clearMutationOutcomes,
} from "@/lib/agent/mutation-verify";

describe("self-review unverified-edit accumulation", () => {
  it("returns null when nothing was recorded (zero-cost happy path)", () => {
    expect(getUnverifiedEditFeedback("turn-clean")).toBeNull();
  });

  it("returns null for an unknown / undefined turn", () => {
    expect(getUnverifiedEditFeedback(undefined)).toBeNull();
    expect(getUnverifiedEditFeedback("never-seen")).toBeNull();
  });

  it("consolidates multiple failed edits into one nudge naming each file", () => {
    const t = "turn-fail";
    recordUnverifiedEdit(t, "src/a.ts");
    recordUnverifiedEdit(t, "src/b.ts");
    const fb = getUnverifiedEditFeedback(t);
    expect(fb).toBeTruthy();
    expect(fb).toContain("src/a.ts");
    expect(fb).toContain("src/b.ts");
    clearMutationOutcomes(t);
  });

  it("clears a path's failure when a later write of it lands (most recent wins)", () => {
    const t = "turn-recover";
    recordUnverifiedEdit(t, "src/x.ts");
    expect(getUnverifiedEditFeedback(t)).toContain("src/x.ts");
    clearUnverifiedEdit(t, "src/x.ts");
    expect(getUnverifiedEditFeedback(t)).toBeNull();
    clearMutationOutcomes(t);
  });

  it("clearMutationOutcomes wipes the turn's unverified set", () => {
    const t = "turn-wipe";
    recordUnverifiedEdit(t, "src/y.ts");
    clearMutationOutcomes(t);
    expect(getUnverifiedEditFeedback(t)).toBeNull();
  });
});
