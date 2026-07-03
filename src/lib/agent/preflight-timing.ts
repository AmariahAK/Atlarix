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
 */

import log from "electron-log";

const logger = log.scope("perf");

export interface PreflightSpan {
  name: string;
  ms: number;
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
      this.spans.push({ name, ms: Date.now() - start });
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
    logger.info(
      `[perf] preflight-breakdown chat=${chatId} total=${total}ms accounted=${accounted}ms unaccounted=${unaccounted}ms ${parts}`,
    );
  }
}
