import { describe, expect, it } from "vitest";
import {
  parsePlanChecklist,
  formatPlanChecklistForPrompt,
  extractPlanChecklistTitle,
} from "@/lib/tasks/plan-checklist";
import { buildContinuationPrompt } from "@/lib/streaming/continuation-handler";
import { createAgenticRepetitionState } from "@/lib/streaming/agentic-loop-repetition";

/**
 * v14.8.7 §A — task-state tracking pure-function coverage.
 * A1 (compact ledger block), A2 (resume re-asserts task), A5 (text loop-guard).
 */

const PLAN = `# Build the auth flow

1. [x] Scaffold routes
2. [~] Wire the login handler
3. [ ] Add session cookies
4. [ ] Write tests
`;

describe("A1 — formatPlanChecklistForPrompt", () => {
  it("emits a compact block with counts, in-progress, and remaining", () => {
    const steps = parsePlanChecklist(PLAN);
    const block = formatPlanChecklistForPrompt(steps, extractPlanChecklistTitle(PLAN));
    expect(block).toBeTruthy();
    expect(block).toContain("[Session plan]");
    expect(block).toContain("Build the auth flow");
    expect(block).toContain("1/4 steps done");
    expect(block).toContain("In progress: 2. Wire the login handler");
    expect(block).toContain("Add session cookies");
    expect(block).toContain("Write tests");
    // Discipline line so the model updates rather than re-derives.
    expect(block!.toLowerCase()).toContain("re-derive");
  });

  it("returns null when there are no steps", () => {
    expect(formatPlanChecklistForPrompt([], "x")).toBeNull();
  });

  it("flags all-done for a finished plan", () => {
    const done = parsePlanChecklist("1. [x] a\n2. [x] b\n");
    const block = formatPlanChecklistForPrompt(done);
    expect(block).toContain("2/2 steps done");
    expect(block!.toLowerCase()).toContain("all steps are marked done");
  });
});

describe("A2 — buildContinuationPrompt re-asserts the task", () => {
  const ctx = {
    chatId: 1,
    turnId: "t",
    attemptCount: 1,
    maxAttempts: 3,
    lastContent: "partial",
  };

  it("falls back to the plain prompt with no ledger (wrapped out-of-band)", () => {
    const out = buildContinuationPrompt(ctx);
    // v14.8.8: wrapped as a system-reminder so it isn't read as a user turn.
    expect(out).toContain("<system-reminder>");
    expect(out).toContain("Continue exactly from where you left off.");
  });

  it("re-asserts the SAME task from the ledger when present, wrapped out-of-band", () => {
    const out = buildContinuationPrompt({ ...ctx, taskLedger: "[Session plan] 1/4 steps done." });
    expect(out).toContain("<system-reminder>");
    expect(out).toContain("SAME task");
    expect(out).toContain("[Session plan] 1/4 steps done.");
    expect(out.toLowerCase()).toContain("do not restart");
  });
});

describe("A5 — recordText semantic loop-guard", () => {
  const statusA =
    "Progress update: 3 of 5 steps complete. The login handler is wired and I am now adding session cookies before writing tests.";
  const statusB =
    "Progress update: 4 of 5 steps complete. The login handler is wired and I am now adding session cookies before writing tests.";

  it("trips after 3 consecutive equivalent status restatements (numbers ignored)", () => {
    const s = createAgenticRepetitionState();
    s.setEnabled(true);
    expect(s.recordText(statusA).kind).toBe("none");
    expect(s.recordText(statusB).kind).toBe("none"); // only the count changed
    expect(s.recordText(statusA).kind).toBe("loop_abort");
  });

  it("does not trip on short text or genuinely different rounds", () => {
    const s = createAgenticRepetitionState();
    s.setEnabled(true);
    expect(s.recordText("done").kind).toBe("none");
    expect(s.recordText("ok").kind).toBe("none");
    expect(s.recordText("Now editing the router configuration for the new endpoint handler.").kind).toBe("none");
    expect(s.recordText("Next I will run the test suite to verify the changes behave correctly.").kind).toBe("none");
  });

  it("is inert when disabled", () => {
    const s = createAgenticRepetitionState();
    expect(s.recordText(statusA).kind).toBe("none");
    expect(s.recordText(statusA).kind).toBe("none");
    expect(s.recordText(statusA).kind).toBe("none");
  });
});
