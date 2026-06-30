/**
 * Doom-loop detector (Stage 5, opencode-alignment): the sliding-window
 * repetition guard was replaced by opencode's exact doom-loop — three
 * CONSECUTIVE byte-identical tool calls trip ONE graceful force-finish. No
 * windows, no thresholds, no correction nudges.
 */

import { describe, it, expect } from "vitest";
import { createAgenticRepetitionState } from "../lib/streaming/agentic-loop-repetition";

describe("doom-loop detector", () => {
  it("does nothing while disabled", () => {
    const s = createAgenticRepetitionState();
    for (let i = 0; i < 10; i++) {
      expect(s.record("read_file", { path: "x.ts" }).kind).toBe("none");
    }
  });

  it("trips on the 3rd consecutive byte-identical call", () => {
    const s = createAgenticRepetitionState();
    s.setEnabled(true);
    expect(s.record("read_file", { path: "x.ts" }).kind).toBe("none");
    expect(s.record("read_file", { path: "x.ts" }).kind).toBe("none");
    const r = s.record("read_file", { path: "x.ts" });
    expect(r.kind).toBe("loop_abort");
    if (r.kind === "loop_abort") {
      expect(r.toolName).toBe("read_file");
      expect(r.count).toBe(3);
    }
  });

  it("works for ANY tool (not just a tracked subset)", () => {
    const s = createAgenticRepetitionState();
    s.setEnabled(true);
    s.record("some_random_tool", { a: 1 });
    s.record("some_random_tool", { a: 1 });
    expect(s.record("some_random_tool", { a: 1 }).kind).toBe("loop_abort");
  });

  it("does NOT trip when the input differs (legit progress)", () => {
    const s = createAgenticRepetitionState();
    s.setEnabled(true);
    // Same tool, DIFFERENT args each time (e.g. paging) — never a doom loop.
    expect(s.record("read_file", { path: "x.ts", offset: 1 }).kind).toBe("none");
    expect(s.record("read_file", { path: "x.ts", offset: 100 }).kind).toBe("none");
    expect(s.record("read_file", { path: "x.ts", offset: 200 }).kind).toBe("none");
    expect(s.record("read_file", { path: "x.ts", offset: 300 }).kind).toBe("none");
  });

  it("resets the run when a different call interrupts (consecutive only)", () => {
    const s = createAgenticRepetitionState();
    s.setEnabled(true);
    s.record("read_file", { path: "x.ts" });
    s.record("read_file", { path: "x.ts" });
    // A different call breaks the consecutive run.
    expect(s.record("search", { query: "foo" }).kind).toBe("none");
    // Back to x.ts — counter restarted, so 2 more are NOT enough yet.
    expect(s.record("read_file", { path: "x.ts" }).kind).toBe("none");
    expect(s.record("read_file", { path: "x.ts" }).kind).toBe("none");
    expect(s.record("read_file", { path: "x.ts" }).kind).toBe("loop_abort");
  });

  it("fires only ONCE per doom loop (resets after tripping)", () => {
    const s = createAgenticRepetitionState();
    s.setEnabled(true);
    s.record("write_file", { path: "y.ts", content: "a" });
    s.record("write_file", { path: "y.ts", content: "a" });
    expect(s.record("write_file", { path: "y.ts", content: "a" }).kind).toBe("loop_abort");
    // Immediately after tripping, the next identical call starts a fresh run.
    expect(s.record("write_file", { path: "y.ts", content: "a" }).kind).toBe("none");
    expect(s.record("write_file", { path: "y.ts", content: "a" }).kind).toBe("none");
    expect(s.record("write_file", { path: "y.ts", content: "a" }).kind).toBe("loop_abort");
  });

  it("setEnabled(true) clears any prior run", () => {
    const s = createAgenticRepetitionState();
    s.setEnabled(true);
    s.record("read_file", { path: "x.ts" });
    s.record("read_file", { path: "x.ts" });
    s.setEnabled(true); // re-arm clears state
    expect(s.record("read_file", { path: "x.ts" }).kind).toBe("none");
  });

  it("correction/loop-break stubs are inert", () => {
    const s = createAgenticRepetitionState();
    s.setEnabled(true);
    s.record("read_file", { path: "x.ts" });
    s.record("read_file", { path: "x.ts" });
    s.record("read_file", { path: "x.ts" });
    expect(s.takePendingCorrection()).toBeNull();
    expect(s.consumeLoopBreak()).toBe(false);
  });
});
