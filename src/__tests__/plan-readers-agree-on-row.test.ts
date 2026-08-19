/**
 * All three plan readers must select the SAME artifact row.
 *
 * `plan.ts` states the invariant: the row `update_step` writes to has to match the
 * row the in-context ledger is built from, or "the model would be updating one
 * plan while reading another's progress — an unwinnable disagreement".
 *
 * Two of the three obeyed it (`resolvePlanId`, `loadActivePlanSection`: building
 * first, then latest). The third — the completion gate, which produces the "N
 * step(s) you haven't accounted for" nudge — read plain `getLatestPlanArtifact`.
 * In a session holding a `building` plan plus a newer one it therefore nudged
 * about a plan the model could neither see in its ledger nor mark, and no amount
 * of correct marking would silence it.
 *
 * This asserts the behaviour (which row is chosen), not the call shape, so a
 * future refactor cannot satisfy it by coincidence.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = {
  id: string;
  sessionId: string;
  content: string;
  planStatus: "plan" | "building" | "built";
  title: string | null;
  createdAt: Date;
};

/** Newest first, mirroring listPlanArtifactsForSession's ordering. */
let rows: Row[] = [];

vi.mock("@/lib/plans/plan-artifacts", () => ({
  getLatestPlanArtifact: async (_sessionId: string, status?: string) =>
    (status ? rows.find((r) => r.planStatus === status) : rows[0]) ?? null,
}));

const { getPlanCompletionFeedback } = await import("@/lib/tasks/plan-completion-gate");

const row = (
  id: string,
  planStatus: Row["planStatus"],
  content: string,
): Row => ({
  id,
  sessionId: "sess-1",
  content,
  planStatus,
  title: id,
  createdAt: new Date(),
});

beforeEach(() => {
  rows = [];
});

describe("getPlanCompletionFeedback row selection", () => {
  it("nudges about the BUILDING plan, not a newer finished one", () => {
    // The newest row is `built` with everything done; the in-flight plan still has
    // work. Reading plain-latest would return null (nothing actionable) and the
    // model would never be reminded about the plan it is actually executing.
    rows = [
      row("newer-built", "built", "1. [x] shipped\n"),
      row("in-flight", "building", "1. [ ] the real work\n"),
    ];

    return getPlanCompletionFeedback("sess-1").then((out) => {
      expect(out).toContain("the real work");
    });
  });

  it("does not nudge about a plan the ledger cannot show", async () => {
    // Inverse: the building plan is finished, a newer draft has open steps.
    // Plain-latest would nudge about `newer-draft` while the ledger shows
    // `in-flight` — steps the model cannot mark from what it can see.
    rows = [
      row("newer-draft", "plan", "1. [ ] not started yet\n"),
      row("in-flight", "building", "1. [x] done\n"),
    ];

    expect(await getPlanCompletionFeedback("sess-1")).toBeNull();
  });

  it("falls back to latest when no plan is building", async () => {
    rows = [row("only", "built", "1. [ ] still open\n")];
    expect(await getPlanCompletionFeedback("sess-1")).toContain("still open");
  });

  it("counts in_progress as unaccounted for, alongside todo", async () => {
    // The live case: three steps left in_progress by a model that thought it was
    // finished. They must keep the gate open, or the turn ends mid-plan.
    rows = [row("only", "building", "1. [~] started\n2. [ ] todo\n3. [x] done\n")];
    const out = await getPlanCompletionFeedback("sess-1");
    expect(out).toContain("2 step(s) you haven't accounted for");
  });

  it("stays silent with no session", async () => {
    expect(await getPlanCompletionFeedback(null)).toBeNull();
    expect(await getPlanCompletionFeedback(undefined)).toBeNull();
  });
});
