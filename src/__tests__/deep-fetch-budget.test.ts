/**
 * A deep search's page budget is ALLOCATED across the pages it is fetching,
 * not spent at a flat per-page rate.
 *
 * Measured 2026-09-07, after the owner saw the model reason around our own
 * truncation marker. Two findings drove this:
 *   - the synthesis step drops nothing (it concatenates fetched content
 *     verbatim), so the cap was the entire cause of the truncation; and
 *   - 20K/page truncates every real documentation page sampled — extracted text
 *     ran 25K-75K chars.
 *
 * The fix had to avoid the obvious one. Raising the cap flat multiplies by the
 * page count, and v13.1 had already raised it once from 5K. Allocating a total
 * instead can only ever help: the worst case is identical to the old behaviour,
 * and the common case of one or two usable results stops leaving most of the
 * budget unspent.
 */
import { describe, expect, it } from "vitest";
import { deepFetchBudget } from "@/lib/tools/web";

describe("deepFetchBudget", () => {
  it("is unchanged from the old flat cap when all five slots are filled", () => {
    // The guarantee that makes this safe to ship: no new worst case.
    expect(deepFetchBudget(5)).toBe(20_000);
  });

  it("gives a single result the whole budget, up to the read_url ceiling", () => {
    // 100K/1 would exceed READ_URL_MAX_CAP; a page arriving through search must
    // not out-read what a user can ask for directly with read_url.
    expect(deepFetchBudget(1)).toBe(50_000);
  });

  it("splits the budget between two results", () => {
    expect(deepFetchBudget(2)).toBe(50_000);
  });

  it("never returns less than the old per-page floor", () => {
    for (const n of [3, 4, 5, 6, 10, 50]) {
      expect(deepFetchBudget(n)).toBeGreaterThanOrEqual(20_000);
    }
  });

  it("survives a zero or negative page count", () => {
    // Promise.allSettled over an empty list is reachable when every search
    // result lacks an http URL, and a division by zero here would be Infinity.
    expect(deepFetchBudget(0)).toBe(20_000);
    expect(deepFetchBudget(-1)).toBe(20_000);
  });
});
