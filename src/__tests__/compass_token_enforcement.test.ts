import { describe, expect, it } from "vitest";
import {
  COMPASS_LIMIT_STREAM_STOP,
  shouldStopForCompassLimit,
} from "@/lib/auth/compass_enforcement";

describe("compass_enforcement — strict mid-task stop decision", () => {
  it("stops when the RPC authoritatively reports limit_exceeded", () => {
    expect(
      shouldStopForCompassLimit(
        { remainingBudget: 1_000_000, usedThisTurn: 10 },
        { ok: false, error: "limit_exceeded" },
      ),
    ).toBe(true);
  });

  it("stops when the local tally crosses the pre-flight budget", () => {
    expect(
      shouldStopForCompassLimit(
        { remainingBudget: 5_000, usedThisTurn: 5_000 },
        { ok: true },
      ),
    ).toBe(true);
    expect(
      shouldStopForCompassLimit(
        { remainingBudget: 5_000, usedThisTurn: 6_200 },
        null,
      ),
    ).toBe(true);
  });

  it("continues while under budget with a healthy RPC", () => {
    expect(
      shouldStopForCompassLimit(
        { remainingBudget: 5_000, usedThisTurn: 4_999 },
        { ok: true },
      ),
    ).toBe(false);
  });

  it("does not stop on transient RPC/network errors (server stays authoritative)", () => {
    expect(
      shouldStopForCompassLimit(
        { remainingBudget: 5_000, usedThisTurn: 100 },
        { ok: false, error: "rpc_error", message: "fetch failed" },
      ),
    ).toBe(false);
    expect(
      shouldStopForCompassLimit(
        { remainingBudget: 5_000, usedThisTurn: 100 },
        { ok: false, error: "not_authenticated" },
      ),
    ).toBe(false);
  });

  it("relies on RPC only when pre-flight could not verify the budget", () => {
    expect(
      shouldStopForCompassLimit({ remainingBudget: null, usedThisTurn: 999_999 }, { ok: true }),
    ).toBe(false);
    expect(
      shouldStopForCompassLimit(
        { remainingBudget: null, usedThisTurn: 10 },
        { ok: false, error: "limit_exceeded" },
      ),
    ).toBe(true);
  });

  it("exports a distinct abort reason for limit stops", () => {
    expect(COMPASS_LIMIT_STREAM_STOP).toBe("compass-token-limit-reached");
  });
});
