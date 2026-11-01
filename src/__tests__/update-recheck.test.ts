/**
 * The owner's Mac lost its 15.11.1 download at 17% (net::ERR_NETWORK_CHANGED)
 * and nothing tried again for 4 h. A failure re-checks after 2 min, doubling to
 * 4 h; a good result goes back to every 4 h.
 */
import { describe, expect, it, vi } from "vitest";
import {
  createUpdateRechecker,
  nextUpdateCheckDelayMs,
} from "@/main/update-helpers";

const MIN = 60_000;

describe("nextUpdateCheckDelayMs", () => {
  it("is 4 h while checks work, and 2, 4, 8 … min after failures, capped at 4 h", () => {
    expect(nextUpdateCheckDelayMs(0)).toBe(240 * MIN);
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => nextUpdateCheckDelayMs(n) / MIN)).toEqual([
      2, 4, 8, 16, 32, 64, 128, 240, 240,
    ]);
  });
});

describe("createUpdateRechecker", () => {
  it("re-checks 2 min after a failed download, then backs off, and resets on success", () => {
    vi.useFakeTimers();
    try {
      const check = vi.fn();
      const r = createUpdateRechecker(check);
      r.start();
      r.failed(); // the download died
      vi.advanceTimersByTime(2 * MIN - 1);
      expect(check).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(check).toHaveBeenCalledTimes(1);
      r.failed(); // still offline
      vi.advanceTimersByTime(4 * MIN);
      expect(check).toHaveBeenCalledTimes(2);
      r.succeeded(); // downloaded
      vi.advanceTimersByTime(239 * MIN);
      expect(check).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(1 * MIN);
      expect(check).toHaveBeenCalledTimes(3);
      r.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a check pending when a result never arrives", () => {
    vi.useFakeTimers();
    try {
      const check = vi.fn();
      const r = createUpdateRechecker(check);
      r.start();
      vi.advanceTimersByTime(240 * MIN);
      vi.advanceTimersByTime(240 * MIN);
      expect(check).toHaveBeenCalledTimes(2);
      r.stop();
      vi.advanceTimersByTime(240 * MIN);
      expect(check).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
