import { describe, expect, it } from "vitest";
import {
  nextRevealCount,
  revealRateCps,
  safeRevealLength,
  SMOOTH_STREAM_BASE_CPS,
  SMOOTH_STREAM_MAX_CPS,
} from "@/hooks/useSmoothStreamedContent";

describe("revealRateCps", () => {
  it("is zero with nothing pending", () => {
    expect(revealRateCps(0, true)).toBe(0);
    expect(revealRateCps(-5, true)).toBe(0);
  });

  it("never reveals slower than the floor", () => {
    expect(revealRateCps(1, true)).toBeGreaterThanOrEqual(
      SMOOTH_STREAM_BASE_CPS,
    );
  });

  it("never exceeds the ceiling, however large the backlog", () => {
    expect(revealRateCps(1_000_000, true)).toBe(SMOOTH_STREAM_MAX_CPS);
  });

  it("speeds up as the backlog grows — this is what bounds the lag", () => {
    expect(revealRateCps(500, true)).toBeGreaterThan(revealRateCps(100, true));
  });

  it("drains faster once the stream has ended", () => {
    expect(revealRateCps(400, false)).toBeGreaterThan(revealRateCps(400, true));
  });
});

describe("nextRevealCount", () => {
  it("stops exactly at the total and never overshoots", () => {
    expect(nextRevealCount(100, 100, true, 1000)).toBe(100);
    expect(nextRevealCount(95, 100, true, 10_000)).toBe(100);
  });

  it("always advances at least one character, so it cannot stall", () => {
    expect(nextRevealCount(0, 500, true, 1)).toBeGreaterThan(0);
  });

  it("a provider AT the floor rate is revealed with no backlog left behind", () => {
    // 320 chars/sec arriving, sampled every 40ms = ~12.8 chars per tick. The reveal
    // keeps up, which is why a comfortably-paced provider feels unchanged.
    const perTick = (SMOOTH_STREAM_BASE_CPS * 40) / 1000;
    let revealed = 0;
    let total = 0;
    for (let tick = 0; tick < 50; tick += 1) {
      total += perTick;
      revealed = nextRevealCount(revealed, Math.floor(total), true, 40);
    }
    expect(Math.floor(total) - revealed).toBeLessThanOrEqual(1);
  });

  it("caps a provider that dumps a whole answer at once, instead of jumping", () => {
    // 4000 chars land in a single tick. One tick must NOT reveal them all.
    expect(nextRevealCount(0, 4000, true, 40)).toBeLessThan(4000);
  });

  it("bounds how far behind it can fall on a very fast provider", () => {
    // 3000 chars/sec sustained — far above the floor. The backlog settles rather than
    // growing without limit, so the text stays under about a second behind.
    const cps = 3000;
    let revealed = 0;
    let total = 0;
    for (let tick = 0; tick < 200; tick += 1) {
      total += (cps * 40) / 1000;
      revealed = nextRevealCount(revealed, Math.floor(total), true, 40);
    }
    const lagSeconds = (Math.floor(total) - revealed) / cps;
    expect(lagSeconds).toBeLessThan(1);
  });

  it("finishes a large backlog promptly after the stream ends", () => {
    let revealed = 0;
    const total = 5000;
    let ticks = 0;
    while (revealed < total && ticks < 1000) {
      revealed = nextRevealCount(revealed, total, false, 40);
      ticks += 1;
    }
    expect(revealed).toBe(total);
    expect(ticks * 40).toBeLessThan(1200); // under ~1.2s to drain 5000 chars
  });
});

describe("safeRevealLength", () => {
  it("passes through when the cut is not inside a tag", () => {
    const s = "hello world";
    expect(safeRevealLength(s, 5)).toBe(5);
  });

  it("holds back a half-written tag rather than flashing it as text", () => {
    const s = "answer <atlarix-tool name=";
    expect(safeRevealLength(s, s.length)).toBe("answer ".length);
  });

  it("reveals the tag once it is complete", () => {
    const s = "answer <atlarix-tool name=x>body";
    expect(safeRevealLength(s, s.length)).toBe(s.length);
  });

  it("does not hold back prose containing a comparison", () => {
    // A stray `<` must not stall the reveal waiting for a `>` that never arrives.
    const s = "if a < b then";
    expect(safeRevealLength(s, s.length)).toBe(s.length);
  });

  it("gives up on an over-long pseudo-tag so text cannot stall forever", () => {
    const s = "x <" + "y".repeat(400);
    expect(safeRevealLength(s, s.length)).toBe(s.length);
  });

  it("handles a cut at the very start", () => {
    expect(safeRevealLength("<think>", 0)).toBe(0);
  });

  it("clamps a reveal index past the end", () => {
    expect(safeRevealLength("abc", 99)).toBe(3);
  });
});
