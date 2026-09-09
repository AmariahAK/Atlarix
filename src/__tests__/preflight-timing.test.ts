import { describe, expect, it } from "vitest";
import {
  computePreflightGaps,
  type PreflightSpan,
} from "@/lib/agent/preflight-timing";

/**
 * W10 (v14.8.11): unaccounted-TTFT attribution. Pure gap math over recorded
 * span offsets — live sessions showed ~60% of preflight time falling between
 * wrapped spans with no name attached.
 */

const span = (name: string, start: number, end: number): PreflightSpan => ({
  name,
  ms: end - start,
  startOffset: start,
  endOffset: end,
});

describe("computePreflightGaps", () => {
  it("adjacent spans produce no gaps", () => {
    const spans = [span("a", 0, 100), span("b", 100, 250)];
    expect(computePreflightGaps(spans, 250)).toEqual([]);
  });

  it("names the gap after the preceding span", () => {
    const spans = [span("auth", 0, 40), span("prompt-bundle", 640, 840)];
    expect(computePreflightGaps(spans, 840)).toEqual([
      { afterSpan: "auth", ms: 600 },
    ]);
  });

  it("reports a head gap before the first span", () => {
    const spans = [span("auth", 300, 340)];
    expect(computePreflightGaps(spans, 340)).toEqual([
      { afterSpan: null, ms: 300 },
    ]);
  });

  it("reports the tail gap between the last span and dispatch", () => {
    const spans = [span("auth", 0, 100)];
    expect(computePreflightGaps(spans, 900)).toEqual([
      { afterSpan: "auth", ms: 800 },
    ]);
  });

  it("overlapping spans never produce phantom gaps", () => {
    // b runs INSIDE a (a wrapped step that internally times a sub-step).
    const spans = [span("a", 0, 500), span("b", 100, 200), span("c", 500, 600)];
    expect(computePreflightGaps(spans, 600)).toEqual([]);
  });

  it("ignores sub-threshold gaps", () => {
    const spans = [span("a", 0, 100), span("b", 130, 200)];
    expect(computePreflightGaps(spans, 200)).toEqual([]);
  });

  it("offset-less add() spans are skipped without crashing", () => {
    const spans: PreflightSpan[] = [
      { name: "external", ms: 50 },
      span("a", 0, 100),
      span("b", 400, 500),
    ];
    expect(computePreflightGaps(spans, 500)).toEqual([
      { afterSpan: "a", ms: 300 },
    ]);
  });

  it("empty span list yields no gaps (nothing to attribute)", () => {
    expect(computePreflightGaps([], 1000)).toEqual([]);
  });
});
