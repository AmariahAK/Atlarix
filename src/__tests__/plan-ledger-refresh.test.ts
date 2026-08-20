/**
 * Mid-turn plan-ledger refresh.
 *
 * Regression cover for a real session in which the agent spent a whole turn
 * fighting its own plan: it marked 25 of 31 steps done, but the ledger injected
 * at step 0 kept asserting "2/31 steps done" (the turn-START counts) for every
 * later step. Reading that as a broken tracker, it rewrote the plan and re-marked
 * every step in a loop instead of working.
 *
 * The two guarantees below are what make that unwinnable contradiction
 * impossible: the ledger follows mid-turn mutations, and an already-done step
 * still reports the real counts.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  markPlanLedgerDirty,
  takeRefreshedPlanLedger,
  currentPlanLedger,
  clearPlanLedgerRefresh,
} from "@/lib/tasks/plan-ledger-refresh";
import { parsePlanChecklist, setStepStateInPlanMarkdown } from "@/lib/tasks/plan-checklist";

const CHAT = 4242;

// Mirrors the shape of the plan from the real session: two numbered checkboxes
// describing the bugs, then the actual work as BULLET checkboxes. That mix is
// why the frozen snapshot read "2/31" — only the two numbered lines were done.
const PLAN = [
  "# Fix: lockfile + process reaping",
  "",
  "1. [x] **Silent lockfile mutations**: hash changes between identical installs",
  "2. [x] **Ghost processes**: children survive Ctrl+C",
  "",
  "- [ ] Read arborist/reify.js",
  "- [ ] Compare npm ci vs npm install options",
  "- [ ] Trace buildIdealTree()",
  "- [ ] Apply the minimal fix",
].join("\n");

beforeEach(() => clearPlanLedgerRefresh(CHAT));

describe("takeRefreshedPlanLedger", () => {
  it("returns nothing when the plan hasn't changed", () => {
    expect(takeRefreshedPlanLedger(CHAT)).toBeNull();
  });

  it("reflects the CURRENT counts after a mid-turn mutation", () => {
    expect(parsePlanChecklist(PLAN).filter((s) => s.state === "done")).toHaveLength(2);

    let content = PLAN;
    for (const text of ["Read arborist", "Compare npm ci", "Trace buildIdealTree"]) {
      content = setStepStateInPlanMarkdown(content, { stepText: text }, "done").content;
    }
    markPlanLedgerDirty(CHAT, content);

    const block = takeRefreshedPlanLedger(CHAT);
    // The frozen step-0 snapshot would still say 2/6 here.
    expect(block).toContain("5/6 steps done");
    expect(block).not.toContain("2/6 steps done");
  });

  it("is take-once, so a quiet step doesn't re-inject the same block", () => {
    markPlanLedgerDirty(CHAT, PLAN);
    expect(takeRefreshedPlanLedger(CHAT)).toContain("steps done");
    expect(takeRefreshedPlanLedger(CHAT)).toBeNull();
  });

  it("collapses a burst of mutations to the newest state", () => {
    let content = setStepStateInPlanMarkdown(PLAN, { stepText: "Read arborist" }, "done").content;
    markPlanLedgerDirty(CHAT, content);
    content = setStepStateInPlanMarkdown(content, { stepText: "Compare npm ci" }, "done").content;
    markPlanLedgerDirty(CHAT, content);

    expect(takeRefreshedPlanLedger(CHAT)).toContain("4/6 steps done");
    expect(takeRefreshedPlanLedger(CHAT)).toBeNull();
  });

  it("keeps chats isolated", () => {
    markPlanLedgerDirty(CHAT, PLAN);
    expect(takeRefreshedPlanLedger(CHAT + 1)).toBeNull();
    expect(takeRefreshedPlanLedger(CHAT)).not.toBeNull();
  });

  it("ignores a null chatId and never throws on unparseable content", () => {
    expect(() => markPlanLedgerDirty(null, PLAN)).not.toThrow();
    expect(takeRefreshedPlanLedger(null)).toBeNull();
    expect(() => markPlanLedgerDirty(CHAT, "")).not.toThrow();
  });
});

/**
 * The ROUND boundary, which the take-once queue above did not cover.
 *
 * run-agent-turn re-enters the stream once per agentic round (completion-gate
 * nudge, stall resume, stream continuation). Each round is a fresh `streamText`,
 * so `prepareStep` sees `stepNumber === 0` again — and that branch used the
 * frozen turn-start block unconditionally, with the take-once queue already
 * drained by an earlier step.
 *
 * Observed 2026-08-19: a turn that began at 1/6 marked steps 1-3 done, hit the
 * gate, and was handed "1/6 steps done" again on the next round. The model
 * concluded the plan had been reset and rewrote it wholesale.
 */
describe("currentPlanLedger (round boundaries)", () => {
  const stepZero = (turnStartBlock: string | null) =>
    currentPlanLedger(CHAT) ?? turnStartBlock;

  it("returns null before any mutation, so round 1 keeps the turn-start block", () => {
    expect(currentPlanLedger(CHAT)).toBeNull();
    expect(stepZero("[Session plan] 2/6 steps done.")).toBe(
      "[Session plan] 2/6 steps done.",
    );
  });

  it("outranks the frozen turn-start block on a LATER round", () => {
    let content = PLAN;
    for (const text of ["Read arborist", "Compare npm ci", "Trace buildIdealTree"]) {
      content = setStepStateInPlanMarkdown(content, { stepText: text }, "done").content;
    }
    markPlanLedgerDirty(CHAT, content);
    // Round 1 already drained the mid-round queue...
    expect(takeRefreshedPlanLedger(CHAT)).toContain("5/6 steps done");
    // ...and round 2's step 0 must STILL see the real counts, not 2/6.
    const roundTwo = stepZero("[Session plan] 2/6 steps done.");
    expect(roundTwo).toContain("5/6 steps done");
    expect(roundTwo).not.toContain("2/6 steps done");
  });

  it("survives every round of a turn, not just the next one", () => {
    markPlanLedgerDirty(
      CHAT,
      setStepStateInPlanMarkdown(PLAN, { stepText: "Read arborist" }, "done").content,
    );
    for (let round = 0; round < 4; round++) {
      expect(stepZero("[Session plan] 2/6 steps done.")).toContain("3/6 steps done");
    }
  });

  it("stops repeating on the mid-round queue once served at a boundary", () => {
    markPlanLedgerDirty(CHAT, PLAN);
    expect(currentPlanLedger(CHAT)).toContain("steps done");
    // Serving it at step 0 counts as the injection, so step 1 stays quiet.
    expect(takeRefreshedPlanLedger(CHAT)).toBeNull();
  });

  it("does NOT leak into the next turn (preflight clears it)", () => {
    markPlanLedgerDirty(
      CHAT,
      setStepStateInPlanMarkdown(PLAN, { stepText: "Read arborist" }, "done").content,
    );
    expect(currentPlanLedger(CHAT)).toContain("3/6 steps done");
    // chat_stream_handlers preflight calls this once per turn.
    clearPlanLedgerRefresh(CHAT);
    expect(currentPlanLedger(CHAT)).toBeNull();
    expect(stepZero("[Session plan] 3/6 steps done.")).toBe(
      "[Session plan] 3/6 steps done.",
    );
  });

  it("keeps chats isolated", () => {
    markPlanLedgerDirty(CHAT, PLAN);
    expect(currentPlanLedger(CHAT + 1)).toBeNull();
    expect(currentPlanLedger(CHAT)).not.toBeNull();
    expect(currentPlanLedger(null)).toBeNull();
  });
});
