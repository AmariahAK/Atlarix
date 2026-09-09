/**
 * `getLatestPlanArtifact(sessionId, status)` filters. It didn't.
 *
 * THE BUG: it ended `?? rows[0] ?? null`, so passing a status only expressed a
 * preference — callers got the newest plan whatever its status. Three call sites
 * already wrote `?? getLatestPlanArtifact(sessionId)` after it, which is only
 * meaningful if the first call can return null; their authors plainly believed
 * it filtered.
 *
 * The one site that silently depended on the fallback was the turn-end safety
 * net (`finalize.ts`): it asks for the plan that is *building*, and used to get
 * the newest plan regardless — then ticked every step and marked it `built`. A
 * plan the model had just written and not started could be stamped 100%
 * complete, which is how a fabricated "18/18" reaches the card.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type FakeRow = {
  id: string;
  sessionId: string;
  content: string;
  planStatus: string;
  /** Rows written before the title column carry null; mapRow must tolerate it. */
  title: string | null;
  createdAt: Date;
};

/** Newest-first, matching the real `orderBy(desc(createdAt))`. */
let rows: FakeRow[] = [];

// Stub the drizzle chain rather than the module's own exports: the function
// under test calls listPlanArtifactsForSession internally by reference, so a
// partial module mock never intercepts it.
vi.mock("@/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => [...rows].sort((a, b) => +b.createdAt - +a.createdAt),
        }),
      }),
    }),
  },
}));

const { getLatestPlanArtifact } = await import("@/lib/plans/plan-artifacts");

function row(id: string, planStatus: string, at: number): FakeRow {
  return {
    id,
    sessionId: "s",
    content: `# ${id}\n- [ ] step`,
    planStatus,
    title: null,
    createdAt: new Date(at),
  };
}

describe("getLatestPlanArtifact status filtering", () => {
  beforeEach(() => {
    rows = [];
  });

  it("returns the newest plan when no status is given", async () => {
    rows = [row("old", "built", 1), row("new", "plan", 2)];
    expect((await getLatestPlanArtifact("s"))?.id).toBe("new");
  });

  it("REGRESSION: returns null when nothing has the requested status", async () => {
    // Previously returned "new" (the newest, status "plan"), so the safety net
    // treated an unstarted plan as the one it was building.
    rows = [row("old", "built", 1), row("new", "plan", 2)];
    expect(await getLatestPlanArtifact("s", "building")).toBeNull();
  });

  it("returns the matching plan when one has the status", async () => {
    rows = [row("building-one", "building", 1), row("newer", "built", 2)];
    expect((await getLatestPlanArtifact("s", "building"))?.id).toBe(
      "building-one",
    );
  });

  it("prefers the NEWEST row among several with the status", async () => {
    rows = [
      row("older-building", "building", 1),
      row("newer-building", "building", 3),
    ];
    expect((await getLatestPlanArtifact("s", "building"))?.id).toBe(
      "newer-building",
    );
  });

  it("returns null for a session with no plans at all", async () => {
    expect(await getLatestPlanArtifact("s")).toBeNull();
    expect(await getLatestPlanArtifact("s", "building")).toBeNull();
  });
});
