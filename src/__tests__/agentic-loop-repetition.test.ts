/**
 * Verifies repetition detection for both the legacy write/run path and the
 * new read-side wiring (read_file / explore_folder / search). The latter is
 * what the Ask-mode branch now relies on to escape the stream-stall watchdog
 * — the model was looping on identical reads until the provider went silent
 * for 30s and the watchdog aborted.
 */

import { describe, it, expect } from "vitest";
import {
  buildRepetitionKey,
  createAgenticRepetitionState,
} from "../lib/streaming/agentic-loop-repetition";

describe("buildRepetitionKey", () => {
  it("returns null for tools outside the tracked set", () => {
    expect(buildRepetitionKey("get_diagram", { foo: "bar" })).toBeNull();
    expect(buildRepetitionKey("memory", { operation: "recall" })).toBeNull();
  });

  it("keys write_file by normalized path", () => {
    expect(buildRepetitionKey("write_file", { path: "src/foo.ts" })).toBe(
      "write_file:src/foo.ts",
    );
    // Backslashes / mixed separators normalize to forward slashes.
    expect(
      buildRepetitionKey("write_file", { path: "src\\\\foo\\\\bar.ts" }),
    ).toBe("write_file:src/foo/bar.ts");
  });

  it("keys read_file by `path` or `file_path` alias", () => {
    expect(buildRepetitionKey("read_file", { path: "src/foo.ts" })).toBe(
      "read_file:src/foo.ts",
    );
    expect(
      buildRepetitionKey("read_file", { file_path: "./src/foo.ts" }),
    ).toBe("read_file:src/foo.ts");
    expect(buildRepetitionKey("read_file", {})).toBeNull();
  });

  it("keys explore_folder by normalized path", () => {
    expect(
      buildRepetitionKey("explore_folder", { path: "./apps/web/" }),
    ).toBe("explore_folder:apps/web/");
    expect(buildRepetitionKey("explore_folder", {})).toBeNull();
  });

  it("keys search by trimmed query + optional path scope", () => {
    expect(
      buildRepetitionKey("search", { query: "toast notification" }),
    ).toBe("search:toast notification|*");
    expect(
      buildRepetitionKey("search", {
        query: "toast notification",
        path: "apps/web",
      }),
    ).toBe("search:toast notification|apps/web");
    expect(
      buildRepetitionKey("search", {
        query: "toast notification",
        path: "apps/web",
        // mode is intentionally NOT part of the key — model often retries the
        // same query with different modes; we still want that flagged as a loop.
        mode: "semantic",
      }),
    ).toBe("search:toast notification|apps/web");
    expect(buildRepetitionKey("search", {})).toBeNull();
  });
});

describe("createAgenticRepetitionState — write/run threshold (3 of 5)", () => {
  it("does nothing while disabled", () => {
    const s = createAgenticRepetitionState();
    for (let i = 0; i < 10; i++) {
      expect(
        s.record("write_file", { path: "x.ts" }).kind,
      ).toBe("none");
    }
  });

  it("flags loop_detected after 3 identical write_file calls", () => {
    const s = createAgenticRepetitionState();
    s.setEnabled(true);
    expect(s.record("write_file", { path: "x.ts" }).kind).toBe("none");
    expect(s.record("write_file", { path: "x.ts" }).kind).toBe("none");
    const r = s.record("write_file", { path: "x.ts" });
    expect(r.kind).toBe("loop_detected");
    if (r.kind === "loop_detected") {
      expect(r.toolName).toBe("write_file");
      expect(r.target).toBe("x.ts");
    }
    // The pending correction is consumed once and cleared.
    expect(s.takePendingCorrection()).not.toBeNull();
    expect(s.takePendingCorrection()).toBeNull();
  });

  it("escalates to loop_abort after two ignored corrections", () => {
    const s = createAgenticRepetitionState();
    s.setEnabled(true);
    // First trigger.
    for (let i = 0; i < 3; i++) s.record("write_file", { path: "x.ts" });
    s.takePendingCorrection();
    // Second trigger.
    for (let i = 0; i < 3; i++) s.record("write_file", { path: "x.ts" });
    s.takePendingCorrection();
    // Third trigger — abort.
    for (let i = 0; i < 2; i++) s.record("write_file", { path: "x.ts" });
    const r = s.record("write_file", { path: "x.ts" });
    expect(r.kind).toBe("loop_abort");
    expect(s.consumeLoopBreak()).toBe(true);
    expect(s.consumeLoopBreak()).toBe(false);
  });
});

describe("createAgenticRepetitionState — read-side threshold (6 of 10)", () => {
  it("tolerates up to 5 identical read_file calls without firing", () => {
    const s = createAgenticRepetitionState();
    s.setEnabled(true);
    for (let i = 0; i < 5; i++) {
      const r = s.record("read_file", { path: "src/foo.ts" });
      expect(r.kind).toBe("none");
    }
  });

  it("flags loop_detected on the 6th identical read_file call", () => {
    const s = createAgenticRepetitionState();
    s.setEnabled(true);
    for (let i = 0; i < 5; i++) {
      expect(s.record("read_file", { path: "src/foo.ts" }).kind).toBe(
        "none",
      );
    }
    const r = s.record("read_file", { path: "src/foo.ts" });
    expect(r.kind).toBe("loop_detected");
    if (r.kind === "loop_detected") {
      expect(r.toolName).toBe("read_file");
      expect(r.target).toBe("src/foo.ts");
      expect(r.count).toBe(6);
    }
  });

  it("flags loop_detected on the 6th identical explore_folder call", () => {
    const s = createAgenticRepetitionState();
    s.setEnabled(true);
    for (let i = 0; i < 5; i++) {
      s.record("explore_folder", { path: "apps/web" });
    }
    const r = s.record("explore_folder", { path: "apps/web" });
    expect(r.kind).toBe("loop_detected");
  });

  it("flags loop_detected on the 6th identical search call", () => {
    const s = createAgenticRepetitionState();
    s.setEnabled(true);
    const args = { query: "toast notification", path: "apps/web" };
    for (let i = 0; i < 5; i++) {
      s.record("search", args);
    }
    const r = s.record("search", args);
    expect(r.kind).toBe("loop_detected");
  });

  it("does NOT confuse two distinct read paths within the window", () => {
    const s = createAgenticRepetitionState();
    s.setEnabled(true);
    // Interleave 5 reads of A and 5 reads of B — neither key reaches the 6
    // threshold individually, so nothing should fire even after 10 records.
    for (let i = 0; i < 5; i++) {
      expect(s.record("read_file", { path: "a.ts" }).kind).toBe("none");
      expect(s.record("read_file", { path: "b.ts" }).kind).toBe("none");
    }
  });

  it("only fires when a single key dominates the window (6 of 10)", () => {
    const s = createAgenticRepetitionState();
    s.setEnabled(true);
    // Five unrelated `b.ts` reads first, then six `a.ts` reads. After the 6th
    // `a.ts` the sliding window holds [b,b,b,b,a,a,a,a,a,a] (length 10),
    // count of `a` = 6 ≥ threshold ⇒ loop_detected.
    for (let i = 0; i < 5; i++) s.record("read_file", { path: "b.ts" });
    for (let i = 0; i < 5; i++) {
      expect(s.record("read_file", { path: "a.ts" }).kind).toBe("none");
    }
    const r = s.record("read_file", { path: "a.ts" });
    expect(r.kind).toBe("loop_detected");
  });
});
