/**
 * Concurrent update_step calls must not lose each other's marks.
 *
 * OBSERVED LIVE (2026-08-19/20). A model emitted three update_step calls in one
 * step — steps 1, 2 and 3 all → done. Every one reported success:
 *
 *   step 1 → done … 1/6 steps done
 *   step 2 → done … 1/6 steps done
 *   step 3 → done … 1/6 steps done
 *
 * All three computed 0 + 1 from the SAME snapshot. The plan afterwards had step 3
 * `[x]` and steps 1-2 back at `[ ]` — they lost their `done` AND the earlier
 * `in_progress`, because the winning snapshot predated those too.
 *
 * Cause: every mutation is read-whole-document → transform in JS → write whole
 * document, and updatePlanArtifactContent is a blind `SET content = ?` with no
 * version check. Last write wins, so N concurrent calls mean N-1 lost updates.
 * That is why marking several steps "went one by one" — only the last survived.
 *
 * These tests drive the artifact layer the tool uses, with a store that has the
 * same last-write-wins behaviour as the real UPDATE, so removing the lock brings
 * the failure straight back.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Stands in for the row: whole-document reads and writes, no version check. */
let stored = "";
let writes = 0;

vi.mock("@/db", () => ({ db: {} }));

vi.mock("@/lib/plans/plan-artifacts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/plans/plan-artifacts")>();
  return {
    ...actual,
    getPlanArtifact: async (planId: string) => {
      // A tick of latency is what opens the window; without it the interleave
      // cannot happen and the test would pass even unlocked.
      await new Promise((r) => setTimeout(r, 1));
      return {
        id: planId,
        sessionId: "sess-1",
        content: stored,
        planStatus: "building" as const,
        title: "t",
        createdAt: new Date(),
      };
    },
    updatePlanArtifactContent: async (planId: string, content: string) => {
      await new Promise((r) => setTimeout(r, 1));
      writes += 1;
      stored = content;
      return {
        id: planId,
        sessionId: "sess-1",
        content,
        planStatus: "building" as const,
        title: "t",
        createdAt: new Date(),
      };
    },
  };
});

const { withPlanArtifactLock } = await import("@/lib/plans/plan-artifacts");
const { getPlanArtifact, updatePlanArtifactContent } = await import(
  "@/lib/plans/plan-artifacts"
);
const { setStepStateInPlanMarkdown, parsePlanChecklist } = await import(
  "@/lib/tasks/plan-checklist"
);

/** The same read → transform → write shape update_step performs. */
async function markDone(planId: string, stepIndex: number): Promise<void> {
  await withPlanArtifactLock(planId, async () => {
    const row = await getPlanArtifact(planId);
    const result = setStepStateInPlanMarkdown(row!.content, { stepIndex }, "done");
    if (result.changed) await updatePlanArtifactContent(planId, result.content);
  });
}

const doneCount = () =>
  parsePlanChecklist(stored).filter((s) => s.state === "done").length;

beforeEach(() => {
  writes = 0;
  stored =
    "- [ ] 1. Append quotes\n- [ ] 2. Update badges\n- [ ] 3. Update About\n" +
    "- [ ] 4. Dedup repeats\n- [ ] 5. Dedup sweep\n- [ ] 6. Memory notes\n";
});

describe("concurrent update_step", () => {
  it("lands ALL THREE marks fired in one step — the live failure", async () => {
    await Promise.all([markDone("p1", 1), markDone("p1", 2), markDone("p1", 3)]);

    expect(doneCount()).toBe(3);
    expect(stored).toContain("[x] 1. Append quotes");
    expect(stored).toContain("[x] 2. Update badges");
    expect(stored).toContain("[x] 3. Update About");
  });

  it("does not revert steps to todo", async () => {
    // The sharpest symptom: losers came back as `[ ]`, not merely unticked.
    await Promise.all([markDone("p1", 1), markDone("p1", 2), markDone("p1", 3)]);
    expect(parsePlanChecklist(stored).slice(0, 3).map((s) => s.state)).toEqual([
      "done",
      "done",
      "done",
    ]);
  });

  it("serialises rather than dropping writes", async () => {
    await Promise.all([markDone("p1", 1), markDone("p1", 2), markDone("p1", 3)]);
    // One write per mark. Fewer would mean a transform saw a body already
    // containing another's change and decided it had nothing to do.
    expect(writes).toBe(3);
  });

  it("survives six at once", async () => {
    await Promise.all([1, 2, 3, 4, 5, 6].map((i) => markDone("p1", i)));
    expect(doneCount()).toBe(6);
  });

  it("keeps separate plans independent", async () => {
    // The lock is per-plan; two plans must not queue behind each other.
    const order: string[] = [];
    await Promise.all([
      withPlanArtifactLock("a", async () => {
        await new Promise((r) => setTimeout(r, 20));
        order.push("a");
      }),
      withPlanArtifactLock("b", async () => {
        order.push("b");
      }),
    ]);
    expect(order).toEqual(["b", "a"]);
  });

  it("a rejection does not strand the queue", async () => {
    const failing = withPlanArtifactLock("p1", async () => {
      throw new Error("boom");
    });
    await expect(failing).rejects.toThrow("boom");
    // The next writer must still run.
    await markDone("p1", 1);
    expect(doneCount()).toBe(1);
  });
});
