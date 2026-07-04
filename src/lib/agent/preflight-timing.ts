/**
 * v12 S17 — per-turn TTFT pre-flight waterfall.
 *
 * Times every awaited step between `chat:stream` entry and the first model
 * dispatch, then emits ONE greppable line at the dispatch point:
 *
 *   [perf] preflight-breakdown chat=-3 total=512ms auth=41ms model-client=120ms …
 *
 * Measurement only — `time()` WRAPS a step (never reorders it) and rethrows,
 * so control flow is byte-identical to the unwrapped code. S18 (parallelize/
 * defer) is judged against these numbers; until then this module must stay
 * side-effect-free.
 *
 * W10 (v14.8.11): spans now record absolute offsets from t0 so `reportOnce`
 * can ATTRIBUTE the unaccounted gap — live sessions showed up to 60% of TTFT
 * (`unaccounted=1260ms` on a 2102ms turn) between wrapped spans with no name
 * attached. Gaps ≥ 50ms are emitted as `gap-after-<name>=Xms` (plus
 * `pre-first-span`) so the S18 pass knows exactly WHERE to look.
 */

import log from "electron-log";

const logger = log.scope("perf");

export interface PreflightSpan {
  name: string;
  ms: number;
  /** ms offsets from timer start; absent for externally measured `add()` spans. */
  startOffset?: number;
  endOffset?: number;
}

/** Minimum inter-span gap worth naming in the report line. */
const GAP_REPORT_MIN_MS = 50;

/**
 * Pure gap attribution over a span list (exported for tests): sorts wrapped
 * spans by start, walks a coverage frontier, and names every uncovered
 * stretch ≥ minMs after the span that precedes it. Overlapping spans (e.g.
 * a wrapped step that internally `add()`s) never produce phantom gaps.
 */
export function computePreflightGaps(
  spans: readonly PreflightSpan[],
  totalMs: number,
  minMs: number = GAP_REPORT_MIN_MS,
): Array<{ afterSpan: string | null; ms: number }> {
  const positioned = spans
    .filter(
      (s): s is Required<PreflightSpan> =>
        typeof s.startOffset === "number" && typeof s.endOffset === "number",
    )
    .sort((a, b) => a.startOffset - b.startOffset);
  const gaps: Array<{ afterSpan: string | null; ms: number }> = [];
  let frontier = 0;
  let lastName: string | null = null;
  for (const s of positioned) {
    const gap = s.startOffset - frontier;
    if (gap >= minMs) gaps.push({ afterSpan: lastName, ms: gap });
    if (s.endOffset > frontier) {
      frontier = s.endOffset;
      lastName = s.name;
    }
  }
  const tail = totalMs - frontier;
  if (tail >= minMs && positioned.length > 0) {
    gaps.push({ afterSpan: lastName, ms: tail });
  }
  return gaps;
}

export class PreflightTimer {
  private readonly t0 = Date.now();
  private readonly spans: PreflightSpan[] = [];
  private reportedChatIds = new Set<number>();

  /** Wrap an awaited pre-flight step. Rethrows; records even on failure. */
  async time<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    try {
      return await fn();
    } finally {
      const end = Date.now();
      this.spans.push({
        name,
        ms: end - start,
        startOffset: start - this.t0,
        endOffset: end - this.t0,
      });
    }
  }

  /** Record an externally measured span (for steps that can't be wrapped). */
  add(name: string, ms: number): void {
    this.spans.push({ name, ms });
  }

  getSpans(): readonly PreflightSpan[] {
    return this.spans;
  }

  /**
   * Emit the waterfall once per chat per turn — call at the dispatch point
   * (`simpleStreamText` runs per ROUND; only the first dispatch is TTFT).
   */
  reportOnce(chatId: number): void {
    if (this.reportedChatIds.has(chatId)) return;
    this.reportedChatIds.add(chatId);
    const total = Date.now() - this.t0;
    const accounted = this.spans.reduce((sum, s) => sum + s.ms, 0);
    // The unaccounted gap (TTFT overhead not covered by any wrapped step) is the
    // target for the S18 parallelize/defer pass — surface it explicitly so it's
    // greppable and trend-able before any reorder is attempted.
    const unaccounted = Math.max(0, total - accounted);
    const parts = this.spans.map((s) => `${s.name}=${s.ms}ms`).join(" ");
    const gaps = computePreflightGaps(this.spans, total)
      .map((g) =>
        g.afterSpan === null
          ? `pre-first-span=${g.ms}ms`
          : `gap-after-${g.afterSpan}=${g.ms}ms`,
      )
      .join(" ");
    logger.info(
      `[perf] preflight-breakdown chat=${chatId} total=${total}ms accounted=${accounted}ms unaccounted=${unaccounted}ms ${parts}${gaps ? ` ${gaps}` : ""}`,
    );
  }
}
