/**
 * The pacer, driven by a fake clock and a manual scheduler.
 *
 * Every test here is about a property the owner would notice on screen: text
 * arriving smoothly instead of in blocks, a fast model not lagging, and — the
 * one that matters most — the answer never being left half-painted when the
 * frame callback stops firing.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  MIN_REPAINT_MS,
  STARVATION_MS,
  StreamPacer,
  TARGET_DRAIN_MS,
  type PacerScheduler,
} from "./stream-pacer";

/** A clock and a frame queue the test drives by hand. */
function harness() {
  let clock = 1000;
  let pending: (() => void) | null = null;
  const painted: string[] = [];

  const sched: PacerScheduler = {
    now: () => clock,
    frame(fn) {
      pending = fn;
      return () => {
        if (pending === fn) pending = null;
      };
    },
  };

  const pacer = new StreamPacer((t) => painted.push(t), sched);

  /** Advance the clock and run one queued frame, if there is one. */
  const tick = (ms: number) => {
    clock += ms;
    const fn = pending;
    pending = null;
    fn?.();
  };

  return {
    pacer,
    painted,
    tick,
    advance: (ms: number) => {
      clock += ms;
    },
    armed: () => pending !== null,
    last: () => painted[painted.length - 1],
  };
}

let h: ReturnType<typeof harness>;
beforeEach(() => {
  h = harness();
});

describe("what gets stored is never what is painted", () => {
  it("keeps the whole received text from the first delta", () => {
    h.pacer.push("Hello ");
    h.pacer.push("world");
    // Nothing has been painted yet — but the text is complete and available,
    // which is what the transcript and the persisted message read.
    expect(h.pacer.text).toBe("Hello world");
    expect(h.painted).toEqual([]);
  });
});

describe("a slow stream is not held back", () => {
  it("fully reveals a small backlog within the drain window", () => {
    // A stream delivering a few characters at a time never builds a backlog,
    // so the pacer must not add latency a person would notice. It is not one
    // frame — the floor is one character per repaint — but it is bounded by
    // the same window everything else is.
    h.pacer.push("abc");
    let elapsed = 0;
    while (!h.pacer.settled && elapsed < TARGET_DRAIN_MS * 2) {
      h.tick(MIN_REPAINT_MS);
      elapsed += MIN_REPAINT_MS;
    }
    expect(h.last()).toBe("abc");
    expect(elapsed).toBeLessThanOrEqual(TARGET_DRAIN_MS);
  });

  it("stops arming once it has caught up", () => {
    h.pacer.push("abc");
    for (let i = 0; i < 10; i++) h.tick(MIN_REPAINT_MS);
    expect(h.pacer.settled).toBe(true);
    expect(h.armed()).toBe(false);
  });
});

describe("a fast stream is revealed progressively, not in blocks", () => {
  it("does not dump a large burst in one paint", () => {
    // The actual complaint: GLM sends ~40 characters at a time and the panel
    // showed each block whole, which reads as cutting rather than streaming.
    h.pacer.push("x".repeat(400));
    h.tick(MIN_REPAINT_MS);
    expect(h.last()!.length).toBeGreaterThan(0);
    expect(h.last()!.length).toBeLessThan(400);
    expect(h.pacer.settled).toBe(false);
  });

  it("shows most of a burst within the drain window, whatever its size", () => {
    // Not a finish time — the decay is exponential and only `flush` ends it.
    // What is guaranteed is that the bulk lands fast and the reveal does not
    // scale with message length: 400 characters and 20,000 behave the same.
    for (const size of [400, 3000, 20000]) {
      const g = harness();
      g.pacer.push("x".repeat(size));
      for (let t = 0; t < TARGET_DRAIN_MS; t += MIN_REPAINT_MS) {
        g.tick(MIN_REPAINT_MS);
      }
      expect(g.last()!.length / size).toBeGreaterThan(0.6);
    }
  });

  it("BOUNDS how far behind it can fall on a sustained fast stream", () => {
    // The property the owner will actually feel. GLM delivers in bursts; if
    // the backlog grew without limit the panel would drift further behind for
    // the whole answer and finish long after the model did. Simulated at
    // ~1,600 chars/sec, far above anything a provider sends.
    const g = harness();
    let worst = 0;
    for (let i = 0; i < 80; i++) {
      g.pacer.push("x".repeat(40));
      g.tick(MIN_REPAINT_MS);
      worst = Math.max(worst, g.pacer.text.length - (g.last()?.length ?? 0));
    }
    const rate = 40 / MIN_REPAINT_MS; // chars per ms
    expect(worst).toBeLessThan(rate * TARGET_DRAIN_MS * 1.5);
  });

  it("never paints text that was not received", () => {
    h.pacer.push("abcdefghij".repeat(40));
    for (let i = 0; i < 40 && !h.pacer.settled; i++) h.tick(MIN_REPAINT_MS);
    for (const frame of h.painted) {
      expect(h.pacer.text.startsWith(frame)).toBe(true);
    }
    expect(h.last()).toBe(h.pacer.text);
  });

  it("paints monotonically — a frame is never shorter than the one before", () => {
    // A frame that went backwards would read as the answer deleting itself.
    h.pacer.push("x".repeat(600));
    for (let i = 0; i < 40 && !h.pacer.settled; i++) h.tick(MIN_REPAINT_MS);
    for (let i = 1; i < h.painted.length; i++) {
      expect(h.painted[i]!.length).toBeGreaterThanOrEqual(
        h.painted[i - 1]!.length,
      );
    }
  });
});

describe("repaints are throttled without slowing the reveal", () => {
  it("skips a tick that arrives too soon, and keeps it armed", () => {
    h.pacer.push("x".repeat(400));
    h.tick(1);
    expect(h.painted).toEqual([]);
    expect(h.armed()).toBe(true);
  });

  it("reveals what the skipped frames were owed, not just one frame's worth", () => {
    // `lastTick` is not advanced by a skipped tick, so time is never lost. A
    // pacer that reset it would slow down exactly when the browser was busy.
    const fast = harness();
    fast.pacer.push("x".repeat(400));
    fast.tick(MIN_REPAINT_MS * 4);

    const slow = harness();
    slow.pacer.push("x".repeat(400));
    slow.tick(1);
    slow.tick(MIN_REPAINT_MS * 4 - 1);

    expect(slow.last()).toBe(fast.last());
  });
});

describe("it cannot leave an answer half-painted", () => {
  /**
   * The guard that matters. `requestAnimationFrame` does not fire in a
   * background tab — already the cause of one shipped bug, where the page
   * overlay was built at opacity 0 and faded in from a frame callback, so on a
   * tab nobody was looking at it was created invisible and every layer
   * reported success.
   */
  it("paints everything when ticks stop arriving", () => {
    h.pacer.push("x".repeat(400));
    expect(h.armed()).toBe(true);

    // The frame callback never runs. Time passes; more text arrives.
    h.advance(STARVATION_MS + 1);
    h.pacer.push("y");

    expect(h.last()).toBe(h.pacer.text);
    expect(h.pacer.settled).toBe(true);
  });

  it("flushes the remainder on demand", () => {
    h.pacer.push("x".repeat(400));
    h.tick(MIN_REPAINT_MS);
    expect(h.pacer.settled).toBe(false);

    h.pacer.flush();

    expect(h.last()).toBe(h.pacer.text);
    expect(h.pacer.settled).toBe(true);
    expect(h.armed()).toBe(false);
  });

  it("flushing when already settled paints nothing extra", () => {
    h.pacer.push("abc");
    for (let i = 0; i < 10; i++) h.tick(MIN_REPAINT_MS);
    expect(h.pacer.settled).toBe(true);
    const painted = h.painted.length;
    h.pacer.flush();
    expect(h.painted.length).toBe(painted);
  });

  it("flushing an empty pacer does nothing at all", () => {
    h.pacer.flush();
    expect(h.painted).toEqual([]);
  });
});

describe("reset", () => {
  it("drops the buffer WITHOUT painting it", () => {
    // A retried round's text is void — the panel removes the bubble. Painting
    // it on the way out would append the retry's answer to the corpse of the
    // first attempt.
    h.pacer.push("x".repeat(400));
    h.pacer.reset();
    expect(h.painted).toEqual([]);
    expect(h.pacer.text).toBe("");
    expect(h.armed()).toBe(false);
  });

  it("starts clean, so the next round does not inherit the last one", () => {
    h.pacer.push("first");
    h.pacer.reset();
    h.pacer.push("second");
    for (let i = 0; i < 10; i++) h.tick(MIN_REPAINT_MS);
    expect(h.last()).toBe("second");
  });
});
