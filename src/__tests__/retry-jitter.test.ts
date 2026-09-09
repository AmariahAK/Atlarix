import { describe, it, expect } from "vitest";
import {
  RECONNECT_DELAYS_MS,
  jitteredDelay,
} from "@/ipc/handlers/chat_stream/network-retry";

/**
 * The point of jitter here is de-synchronization: every client and every one of
 * the (up to 5) concurrent sub-agents in a turn used to retry on the identical
 * 2s/5s/10s schedule, so one provider blip produced a synchronized stampede —
 * against our own proxy, on the Core path.
 */
describe("jitteredDelay", () => {
  describe("without a Retry-After", () => {
    it("stays within [base/2, base] for every attempt in the schedule", () => {
      for (let attempt = 0; attempt < RECONNECT_DELAYS_MS.length; attempt++) {
        const base = RECONNECT_DELAYS_MS[attempt];
        for (let i = 0; i < 200; i++) {
          const d = jitteredDelay(attempt);
          expect(d).toBeGreaterThanOrEqual(Math.floor(base / 2));
          expect(d).toBeLessThanOrEqual(base);
        }
      }
    });

    it("keeps a floor of base/2 — full jitter's near-zero draws would defeat the backoff", () => {
      const draws = Array.from({ length: 500 }, () => jitteredDelay(0));
      expect(Math.min(...draws)).toBeGreaterThanOrEqual(
        Math.floor(RECONNECT_DELAYS_MS[0] / 2),
      );
    });

    it("spreads simultaneous callers instead of landing them together", () => {
      const draws = new Set(
        Array.from({ length: 100 }, () => jitteredDelay(1)),
      );
      // The whole purpose: N concurrent retries must not all pick one value.
      expect(draws.size).toBeGreaterThan(10);
    });

    it("still grows across attempts", () => {
      const avg = (attempt: number) =>
        Array.from({ length: 300 }, () => jitteredDelay(attempt)).reduce(
          (a, b) => a + b,
          0,
        ) / 300;
      expect(avg(1)).toBeGreaterThan(avg(0));
      expect(avg(2)).toBeGreaterThan(avg(1));
    });

    it("clamps an out-of-range attempt to the last delay rather than returning NaN", () => {
      const last = RECONNECT_DELAYS_MS[RECONNECT_DELAYS_MS.length - 1];
      for (const attempt of [99, -1, Number.NaN]) {
        const d = jitteredDelay(attempt);
        expect(Number.isFinite(d)).toBe(true);
        expect(d).toBeLessThanOrEqual(last);
        expect(d).toBeGreaterThan(0);
      }
    });
  });

  describe("with a Retry-After", () => {
    it("never returns EARLIER than the server asked for", () => {
      for (const retryAfter of [0, 500, 3_000, 30_000]) {
        for (let i = 0; i < 200; i++) {
          expect(jitteredDelay(0, retryAfter)).toBeGreaterThanOrEqual(
            retryAfter,
          );
        }
      }
    });

    it("takes precedence over the base schedule, even when much larger", () => {
      // 30s Retry-After on attempt 0 (base 2s) must win.
      const d = jitteredDelay(0, 30_000);
      expect(d).toBeGreaterThanOrEqual(30_000);
    });

    it("caps a hostile or misconfigured header so it can't hang the turn", () => {
      const d = jitteredDelay(0, 60 * 60_000);
      // 60s cap + up to 1s of additive spread.
      expect(d).toBeLessThanOrEqual(61_000);
    });

    it("still de-synchronizes around the server's time", () => {
      const draws = new Set(
        Array.from({ length: 100 }, () => jitteredDelay(0, 5_000)),
      );
      expect(draws.size).toBeGreaterThan(10);
    });

    it("falls back to the base schedule for null/undefined/negative", () => {
      for (const bad of [null, undefined, -1]) {
        const d = jitteredDelay(0, bad);
        expect(d).toBeGreaterThanOrEqual(
          Math.floor(RECONNECT_DELAYS_MS[0] / 2),
        );
        expect(d).toBeLessThanOrEqual(RECONNECT_DELAYS_MS[0]);
      }
    });
  });
});
