/**
 * A plan can be addressed by TITLE, not only by opaque id or "the newest one".
 *
 * `title` has been a stored column since v14.34.0 but was write-only, so a
 * session with several plans could only be navigated by id — which weak models
 * routinely drop — or by the positional fallback, which silently picks the
 * newest. Reusing `title` rather than adding a parameter is deliberate:
 * `simplifyToolParametersForProfile` keeps only the first THREE optional
 * properties for models on a simplified schema profile, and `title` is already
 * second, so a new field would have been invisible to exactly the models that
 * need it.
 *
 * The ambiguity rule is the point of the feature: titles are NOT unique, so two
 * matches must fail loudly naming both ids rather than quietly picking one. That
 * mirrors `update_step`, which refuses to tick a step it cannot match uniquely.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = {
  id: string;
  sessionId: string;
  content: string;
  planStatus: "plan" | "building" | "built";
  title: string | null;
  createdAt: Date;
};

let rows: Row[] = [];

const row = (
  id: string,
  title: string | null,
  planStatus: Row["planStatus"] = "plan",
): Row => ({
  id,
  sessionId: "sess-1",
  content: `# ${title ?? id}\n\n- [ ] step one`,
  planStatus,
  title,
  createdAt: new Date(),
});

vi.mock("@/lib/plans/plan-artifacts", () => ({
  listPlanArtifactsForSession: async () => rows,
  getPlanArtifact: async (id: string) => rows.find((r) => r.id === id) ?? null,
  getLatestPlanArtifact: async (_s: string, status?: string) =>
    (status ? rows.find((r) => r.planStatus === status) : rows[0]) ?? null,
  createPlanArtifact: vi.fn(),
  updatePlanArtifactContent: vi.fn(async (id: string, content: string) => ({
    ...(rows.find((r) => r.id === id) as Row),
    content,
  })),
  appendStepToPlanArtifact: vi.fn(
    async (id: string) => rows.find((r) => r.id === id) ?? null,
  ),
  setPlanArtifactStatus: vi.fn(
    async (id: string, planStatus: Row["planStatus"]) => {
      const r = rows.find((x) => x.id === id);
      return r ? { ...r, planStatus } : null;
    },
  ),
  planArtifactMarker: (id: string) => `<!-- plan:${id} -->`,
}));

vi.mock("@/ipc/handlers/workspace_session_handlers", () => ({
  resolveOrBindWorkspaceSessionForStream: async () => "sess-1",
}));

vi.mock("@/ipc/utils/emit_plan_artifact", () => ({
  broadcastPlanArtifactUpdated: vi.fn(),
}));

vi.mock("@/lib/tasks/plan-ledger-refresh", () => ({
  markPlanLedgerDirty: vi.fn(),
}));

await import("@/lib/tools/plan");
const { ToolRegistry } = await import("@/lib/tools/registry");

const callPlan = async (args: Record<string, unknown>) => {
  const raw = await ToolRegistry.execute("plan", {
    workspaceSessionId: "sess-1",
    ...args,
  });
  // The registry wraps a successful tool result in { success, result }.
  return (raw?.result ?? raw) as Record<string, unknown>;
};

beforeEach(() => {
  rows = [];
  vi.clearAllMocks();
});

describe("plan({ title }) addresses a plan by name", () => {
  it("reads the plan whose title matches, not the newest one", async () => {
    rows = [row("p-new", "Ship the release"), row("p-old", "Fix the sandbox")];

    const res = await callPlan({ operation: "read", title: "Fix the sandbox" });

    expect(res.planId).toBe("p-old");
    expect(res.title).toBe("Fix the sandbox");
  });

  it("matches case-insensitively and ignores surrounding whitespace", async () => {
    rows = [row("p-1", "Fix the sandbox")];

    const res = await callPlan({
      operation: "read",
      title: "  fix THE sandbox ",
    });

    expect(res.planId).toBe("p-1");
  });

  it("FAILS LOUDLY when two plans share a title, naming both ids", async () => {
    rows = [
      row("p-a", "Fix the sandbox"),
      row("p-b", "Fix the sandbox", "built"),
    ];

    const res = await callPlan({ operation: "read", title: "Fix the sandbox" });

    expect(res.success).toBe(false);
    expect(String(res.error)).toContain("p-a");
    expect(String(res.error)).toContain("p-b");
  });

  it("refuses a mutation on an ambiguous title rather than picking one", async () => {
    rows = [row("p-a", "Fix the sandbox"), row("p-b", "Fix the sandbox")];

    const res = await callPlan({
      operation: "set_status",
      title: "Fix the sandbox",
      plan_status: "building",
    });

    expect(res.success).toBe(false);
    expect(String(res.error)).toContain("p-a");
  });

  it("planId wins when both are given", async () => {
    rows = [row("p-a", "Ship the release"), row("p-b", "Fix the sandbox")];

    const res = await callPlan({
      operation: "read",
      planId: "p-a",
      title: "Fix the sandbox",
    });

    expect(res.planId).toBe("p-a");
  });

  it("lists the session's plans when the title matches nothing", async () => {
    rows = [row("p-a", "Ship the release")];

    const res = await callPlan({ operation: "read", title: "No such plan" });

    expect(res.content).toBeNull();
    expect(String(res.message)).toContain("Ship the release");
  });

  it("a stale title on a MUTATION falls back to the in-flight plan", async () => {
    // Deliberate: a wrong title must not strand the model. Reads tell it the
    // title is unknown; mutations still target the plan it is working on.
    rows = [row("p-building", "Real plan", "building")];

    const res = await callPlan({
      operation: "set_status",
      title: "Stale name",
      plan_status: "built",
    });

    expect(res.success).not.toBe(false);
    expect(res.planId).toBe("p-building");
  });
});
