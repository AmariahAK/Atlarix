/**
 * Doom-loop detector — staged (v14.8.10 Fix R): byte-identical consecutive
 * calls escalate guide → guide harder → circuit-break instead of aborting on
 * the first trip. 3 → loop_correct#1, 6 → loop_correct#2, 9 → loop_abort; the
 * count keeps accumulating across correction trips and resets only when a
 * different call arrives.
 */

import { describe, it, expect } from "vitest";
import {
  createAgenticRepetitionState,
  buildLoopCorrectionMessage,
} from "../lib/streaming/agentic-loop-repetition";

function repeatRecord(
  s: ReturnType<typeof createAgenticRepetitionState>,
  n: number,
  tool = "read_file",
  args: unknown = { path: "x.ts" },
) {
  let last: ReturnType<typeof s.record> = { kind: "none" };
  for (let i = 0; i < n; i++) last = s.record(tool, args);
  return last;
}

describe("doom-loop detector (staged)", () => {
  it("does nothing while disabled", () => {
    const s = createAgenticRepetitionState();
    for (let i = 0; i < 10; i++) {
      expect(s.record("read_file", { path: "x.ts" }).kind).toBe("none");
    }
  });

  it("corrects on the 3rd consecutive byte-identical call (attempt 1)", () => {
    const s = createAgenticRepetitionState();
    s.setEnabled(true);
    expect(s.record("read_file", { path: "x.ts" }).kind).toBe("none");
    expect(s.record("read_file", { path: "x.ts" }).kind).toBe("none");
    const r = s.record("read_file", { path: "x.ts" });
    expect(r.kind).toBe("loop_correct");
    if (r.kind === "loop_correct") {
      expect(r.attempt).toBe(1);
      expect(r.toolName).toBe("read_file");
      expect(r.count).toBe(3);
    }
  });

  it("escalates: 6th identical → attempt 2, 9th → loop_abort", () => {
    const s = createAgenticRepetitionState();
    s.setEnabled(true);
    expect(repeatRecord(s, 3).kind).toBe("loop_correct"); // 3rd
    expect(repeatRecord(s, 2).kind).toBe("none"); // 4th-5th
    const c2 = repeatRecord(s, 1); // 6th
    expect(c2.kind).toBe("loop_correct");
    if (c2.kind === "loop_correct") expect(c2.attempt).toBe(2);
    expect(repeatRecord(s, 2).kind).toBe("none"); // 7th-8th
    const abort = repeatRecord(s, 1); // 9th
    expect(abort.kind).toBe("loop_abort");
    if (abort.kind === "loop_abort") expect(abort.count).toBe(9);
  });

  it("works for ANY tool (not just a tracked subset)", () => {
    const s = createAgenticRepetitionState();
    s.setEnabled(true);
    s.record("some_random_tool", { a: 1 });
    s.record("some_random_tool", { a: 1 });
    expect(s.record("some_random_tool", { a: 1 }).kind).toBe("loop_correct");
  });

  it("does NOT trip when the input differs (legit progress)", () => {
    const s = createAgenticRepetitionState();
    s.setEnabled(true);
    // Same tool, DIFFERENT args each time (e.g. paging) — never a doom loop.
    expect(s.record("read_file", { path: "x.ts", offset: 1 }).kind).toBe(
      "none",
    );
    expect(s.record("read_file", { path: "x.ts", offset: 100 }).kind).toBe(
      "none",
    );
    expect(s.record("read_file", { path: "x.ts", offset: 200 }).kind).toBe(
      "none",
    );
    expect(s.record("read_file", { path: "x.ts", offset: 300 }).kind).toBe(
      "none",
    );
  });

  it("does NOT trip on consecutive edits to the SAME FILE with different content (the v14.8.9 key bug)", () => {
    const s = createAgenticRepetitionState();
    s.setEnabled(true);
    // Full args are the key — 3 different edits to one file are legit progress.
    expect(s.record("edit_file", { path: "App.tsx", content: "a" }).kind).toBe(
      "none",
    );
    expect(s.record("edit_file", { path: "App.tsx", content: "b" }).kind).toBe(
      "none",
    );
    expect(s.record("edit_file", { path: "App.tsx", content: "c" }).kind).toBe(
      "none",
    );
    expect(s.record("edit_file", { path: "App.tsx", content: "d" }).kind).toBe(
      "none",
    );
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
    expect(s.record("read_file", { path: "x.ts" }).kind).toBe("loop_correct");
  });

  it("a different call after a correction resets the escalation", () => {
    const s = createAgenticRepetitionState();
    s.setEnabled(true);
    expect(repeatRecord(s, 3).kind).toBe("loop_correct");
    // The model took the steer and did something else — escalation resets.
    expect(s.record("read_file", { path: "other.ts" }).kind).toBe("none");
    expect(repeatRecord(s, 2).kind).toBe("none");
    expect(repeatRecord(s, 1).kind).toBe("loop_correct"); // back to attempt 1
  });

  it("abort resets so a fresh doom loop starts over at correction", () => {
    const s = createAgenticRepetitionState();
    s.setEnabled(true);
    expect(
      repeatRecord(s, 9, "write_file", { path: "y.ts", content: "a" }).kind,
    ).toBe("loop_abort");
    // Immediately after the abort, the next identical call starts a fresh run.
    expect(
      repeatRecord(s, 2, "write_file", { path: "y.ts", content: "a" }).kind,
    ).toBe("none");
    expect(
      repeatRecord(s, 1, "write_file", { path: "y.ts", content: "a" }).kind,
    ).toBe("loop_correct");
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
    repeatRecord(s, 3);
    expect(s.takePendingCorrection()).toBeNull();
    expect(s.consumeLoopBreak()).toBe(false);
  });

  it("recordText: first trip corrects, a second full run aborts", () => {
    const s = createAgenticRepetitionState();
    s.setEnabled(true);
    const status =
      "Progress: 3 of 5 steps complete. Remaining: wire the handler and run the tests.";
    expect(s.recordText(status).kind).toBe("none");
    expect(s.recordText(status).kind).toBe("none");
    const c = s.recordText(status);
    expect(c.kind).toBe("loop_correct");
    expect(s.recordText(status).kind).toBe("none"); // 4th
    expect(s.recordText(status).kind).toBe("none"); // 5th
    expect(s.recordText(status).kind).toBe("loop_abort"); // 6th
  });

  it("buildLoopCorrectionMessage tailors the steer and invites stopping on attempt 2", () => {
    const a1 = buildLoopCorrectionMessage({
      attempt: 1,
      toolName: "edit_file",
      count: 3,
    });
    expect(a1).toContain("NOT executed");
    expect(a1).toContain("re-read the file");
    expect(a1).not.toContain("end your turn");
    const a2 = buildLoopCorrectionMessage({
      attempt: 2,
      toolName: "grep",
      count: 6,
    });
    expect(a2).toContain("read the likely file directly");
    expect(a2).toContain("end your turn");
  });
});
