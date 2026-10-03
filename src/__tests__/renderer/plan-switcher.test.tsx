/**
 * The Plan panel names which plan it is showing AND lets you switch.
 *
 * v14.32.0 stopped session restore seizing the panel and gave the tab a badge,
 * then v14.34.0 put the plan's title in the header. What was still missing: the
 * panel rendered only the newest plan, so a session with three presented one as
 * though it were THE plan.
 *
 * The load-bearing part is the PIN. Plan-artifact activation replaces whatever
 * the panel shows, so without it, choosing an older plan and then having the
 * agent touch a different one would yank the panel away mid-read.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { getDefaultStore } from "jotai";
import { workspacePlanPanelAtom } from "@/atoms/sourceAtoms";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import { activeWorkspaceSessionIdAtom } from "@/atoms/sessionAtoms";

const listPlanArtifactsForSession = vi.fn();
const listPlanArtifactsForWorkspace = vi.fn(async () => [] as unknown[]);
const copyPlanArtifactToSession = vi.fn();
const getPlanArtifact = vi.fn();

vi.mock("@/ipc/ipc_client", () => ({
  IpcClient: {
    getInstance: () => ({
      listPlanArtifactsForSession,
      listPlanArtifactsForWorkspace,
      copyPlanArtifactToSession,
      getPlanArtifact,
      updatePlanArtifactContent: vi.fn(),
      setPlanArtifactStatus: vi.fn(),
    }),
  },
}));

vi.mock("@/hooks/useStreamChat", () => ({
  useStreamChat: () => ({ streamMessage: vi.fn(), isStreaming: false }),
}));
vi.mock("@/hooks/useSettings", () => ({
  useSettings: () => ({ updateSettings: vi.fn(), settings: {} }),
}));
vi.mock("react-markdown", () => ({
  default: ({ children }: { children?: unknown }) => (
    <div>{String(children ?? "")}</div>
  ),
}));
vi.mock("remark-gfm", () => ({ default: () => {} }));

const { PlanExecutionPanel } = await import(
  "@/components/preview_panel/PlanExecutionPanel"
);

const plan = (planId: string, title: string, planStatus = "plan") => ({
  planId,
  sessionId: "sess-1",
  content: `# ${title}\n\n- [ ] step`,
  planStatus,
  title,
});

const seedPanel = (over: Record<string, unknown> = {}) =>
  getDefaultStore().set(workspacePlanPanelAtom, {
    planId: "p-new",
    content: "# Ship the release\n\n- [ ] step",
    planStatus: "plan",
    sessionId: "sess-1",
    title: "Ship the release",
    changes: null,
    pinnedPlanId: null,
    ...over,
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  getPlanArtifact.mockImplementation(async (id: string) =>
    id === "p-old" ? plan("p-old", "Fix the sandbox", "built") : null,
  );
});

describe("Plan panel switcher", () => {
  it("is hidden when the session has only one plan", async () => {
    listPlanArtifactsForSession.mockResolvedValue([
      plan("p-new", "Ship the release"),
    ]);
    seedPanel();

    render(<PlanExecutionPanel />);

    await waitFor(() => expect(listPlanArtifactsForSession).toHaveBeenCalled());
    expect(screen.queryByTestId("plan-switcher")).toBeNull();
  });

  it("lists every plan in the session once there is more than one", async () => {
    listPlanArtifactsForSession.mockResolvedValue([
      plan("p-new", "Ship the release"),
      plan("p-old", "Fix the sandbox", "built"),
    ]);
    seedPanel();

    render(<PlanExecutionPanel />);

    const select = await screen.findByTestId("plan-switcher");
    expect(select).toBeTruthy();
    expect(
      screen.getByRole("option", { name: /Fix the sandbox — Built/ }),
    ).toBeTruthy();
    expect(
      screen.getByRole("option", { name: /Latest \(2 plans\)/ }),
    ).toBeTruthy();
  });

  it("PINS the chosen plan, so an activation elsewhere cannot yank the panel", async () => {
    listPlanArtifactsForSession.mockResolvedValue([
      plan("p-new", "Ship the release"),
      plan("p-old", "Fix the sandbox", "built"),
    ]);
    seedPanel();

    render(<PlanExecutionPanel />);
    const select = await screen.findByTestId("plan-switcher");
    fireEvent.change(select, { target: { value: "p-old" } });

    await waitFor(() => {
      const state = getDefaultStore().get(workspacePlanPanelAtom);
      expect(state.planId).toBe("p-old");
      expect(state.pinnedPlanId).toBe("p-old");
      expect(state.title).toBe("Fix the sandbox");
    });
  });

  it("choosing Latest clears the pin so the panel follows activations again", async () => {
    listPlanArtifactsForSession.mockResolvedValue([
      plan("p-new", "Ship the release"),
      plan("p-old", "Fix the sandbox", "built"),
    ]);
    seedPanel({
      planId: "p-old",
      title: "Fix the sandbox",
      pinnedPlanId: "p-old",
    });

    render(<PlanExecutionPanel />);
    const select = await screen.findByTestId("plan-switcher");
    fireEvent.change(select, { target: { value: "" } });

    await waitFor(() =>
      expect(
        getDefaultStore().get(workspacePlanPanelAtom).pinnedPlanId,
      ).toBeNull(),
    );
  });

  it("lists plans from this folder's earlier sessions, and copies one in to build it here", async () => {
    getDefaultStore().set(selectedAppIdAtom, 7);
    getDefaultStore().set(activeWorkspaceSessionIdAtom, "sess-1");
    listPlanArtifactsForSession.mockResolvedValue([plan("p-new", "Ship the release")]);
    listPlanArtifactsForWorkspace.mockResolvedValue([
      { ...plan("p-earlier", "Add billing"), sessionId: "sess-0", sessionTitle: "Billing work" },
    ]);
    getPlanArtifact.mockImplementation(async (id: string) =>
      id === "p-earlier" ? { ...plan("p-earlier", "Add billing"), sessionId: "sess-0" } : null,
    );
    copyPlanArtifactToSession.mockResolvedValue({ ...plan("p-copy", "Add billing"), sessionId: "sess-1" });
    seedPanel();

    render(<PlanExecutionPanel />);
    await waitFor(() => expect(listPlanArtifactsForWorkspace).toHaveBeenCalledWith(7, "sess-1"));
    const select = await screen.findByTestId("plan-switcher");
    expect(screen.getByRole("option", { name: /Add billing — Billing work/ })).toBeTruthy();

    fireEvent.change(select, { target: { value: "p-earlier" } });
    // Another session's plan: not built from here as-is.
    const useHere = await screen.findByTestId("plan-use-here");
    expect(screen.queryByRole("button", { name: /^Build$/ })).toBeNull();
    fireEvent.click(useHere);
    await waitFor(() => {
      expect(copyPlanArtifactToSession).toHaveBeenCalledWith("p-earlier", "sess-1");
      const state = getDefaultStore().get(workspacePlanPanelAtom);
      expect(state.planId).toBe("p-copy");
      expect(state.sessionId).toBe("sess-1");
    });
    getDefaultStore().set(selectedAppIdAtom, null);
    getDefaultStore().set(activeWorkspaceSessionIdAtom, null);
  });
});
