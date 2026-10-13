/**
 * Background results injected into a turn (never saved) stay available to the
 * next turns, so a later wake does not redo work an earlier one was shown.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetDeliveredResults,
  rememberDeliveredResults,
  takeEarlierDeliveredResults,
} from "@/lib/agent/delivered-results";

beforeEach(() => __resetDeliveredResults());

describe("delivered background results", () => {
  it("reach the next turns, not the turn that received them, then go", () => {
    rememberDeliveredResults(7, "Sub-agent completed — map src/mini: 12 files, entry index.ts", 1_000);
    // The same turn (started before the delivery) does not get it back.
    expect(takeEarlierDeliveredResults(7, 500)).toBeNull();
    // The next two turns do.
    expect(takeEarlierDeliveredResults(7, 2_000)).toContain("map src/mini: 12 files");
    expect(takeEarlierDeliveredResults(7, 3_000)).toContain("map src/mini: 12 files");
    expect(takeEarlierDeliveredResults(7, 4_000)).toBeNull();
  });

  it("keeps each chat's results to itself and within a budget", () => {
    rememberDeliveredResults(1, "x".repeat(20_000), 1_000);
    rememberDeliveredResults(2, "other chat", 1_000);
    const one = takeEarlierDeliveredResults(1, 2_000)!;
    expect(one.length).toBeLessThan(13_000);
    expect(one).toContain("(cut)");
    expect(one).not.toContain("other chat");
  });

  it("ignores empty deliveries", () => {
    rememberDeliveredResults(3, null);
    rememberDeliveredResults(3, "   ");
    expect(takeEarlierDeliveredResults(3)).toBeNull();
  });
});
