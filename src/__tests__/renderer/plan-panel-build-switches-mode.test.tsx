/**
 * QA (app) #14: Build in the Plan panel ran the build, but the session stayed
 * in Plan: the composer still said "Plan · ws-app" and the session row kept
 * work_mode=plan. The panel wrote only the GLOBAL preference, and a session's
 * own stored mode wins over that. It now switches the session's mode, as the
 * mode picker (and the CLI's "Build it") do.
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { getDefaultStore } from "jotai";
import { workspacePlanPanelAtom } from "@/atoms/sourceAtoms";
import { activeChatIdAtom } from "@/atoms/chatAtoms";
import {
  activeSessionWorkModeAtom,
  activeWorkspaceSessionIdAtom,
} from "@/atoms/sessionAtoms";

const setWorkspaceSessionWorkMode = vi.fn(async () => {});
vi.mock("@/ipc/ipc_client", () => ({
  IpcClient: {
    getInstance: () => ({
      listPlanArtifactsForSession: vi.fn(async () => []),
      listPlanArtifactsForWorkspace: vi.fn(async () => []),
      getPlanArtifact: vi.fn(async () => null),
      updatePlanArtifactContent: vi.fn(),
      setPlanArtifactStatus: vi.fn(async () => ({ planStatus: "building" })),
      setWorkspaceSessionWorkMode,
    }),
  },
}));
const streamMessage = vi.fn();
vi.mock("@/hooks/useStreamChat", () => ({
  useStreamChat: () => ({ streamMessage, isStreaming: false }),
}));
vi.mock("@/hooks/useSettings", () => ({
  useSettings: () => ({ updateSettings: vi.fn(async () => {}), settings: {} }),
}));
vi.mock("react-markdown", () => ({
  default: ({ children }: { children?: unknown }) => <div>{String(children ?? "")}</div>,
}));
vi.mock("remark-gfm", () => ({ default: () => {} }));

const { PlanExecutionPanel } = await import("@/components/preview_panel/PlanExecutionPanel");

describe("Build in the Plan panel", () => {
  it("switches the session to Build, not just this one turn", async () => {
    const store = getDefaultStore();
    store.set(workspacePlanPanelAtom, {
      planId: "p1",
      content: "# Add --top N\n\n- [ ] step",
      planStatus: "plan",
      sessionId: "sess-1",
      title: "Add --top N",
      changes: null,
      pinnedPlanId: null,
    } as never);
    store.set(activeWorkspaceSessionIdAtom, "sess-1");
    store.set(activeSessionWorkModeAtom, "plan");
    store.set(activeChatIdAtom, 7);

    render(<PlanExecutionPanel />);
    fireEvent.click(await screen.findByRole("button", { name: /^Build/ }));

    await waitFor(() => expect(streamMessage).toHaveBeenCalled());
    expect(store.get(activeSessionWorkModeAtom)).toBe("build");
    expect(setWorkspaceSessionWorkMode).toHaveBeenCalledWith("sess-1", "build");
  });
});
