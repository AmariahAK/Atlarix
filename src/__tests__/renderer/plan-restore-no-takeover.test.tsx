/**
 * Restoring a plan must not seize the right panel.
 *
 * It used to switch the panel to Plan and force it open whenever a plan was
 * activated (v13.1: "surface the Plan tab once when a session with an active
 * plan loads"). Reopening a session is "let me look at this again", not "resume
 * that plan" — and with several plans in a session only the NEWEST is restored,
 * so one plan was presented as though it were the plan, with nothing saying the
 * others existed.
 *
 * A badge says the same thing without taking the surface. These pin both halves:
 * the panel is left alone, and the plan still loads.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act } from "@testing-library/react";
import {
  workspacePlanPanelAtom,
  previewTabAtom,
  rightPanelVisibleAtom,
  planUnreadAtom,
} from "@/atoms/sourceAtoms";
import { renderWithProviders } from "./helpers";
import type { PlanArtifactPayload } from "@/ipc/utils/emit_plan_artifact";

const CHAT_ID = 42;

vi.mock("@tanstack/react-router", () => ({
  useSearch: () => ({ id: CHAT_ID }),
}));

/** Captured so the test can fire an activation the way main would. */
let fireActivated: ((p: PlanArtifactPayload) => void) | null = null;
vi.mock("@/ipc/ipc_client", () => ({
  IpcClient: {
    getInstance: () => ({
      onPlanArtifactActivated: (fn: (p: PlanArtifactPayload) => void) => {
        fireActivated = fn;
        return () => {
          fireActivated = null;
        };
      },
      onPlanArtifactUpdated: () => () => {},
    }),
  },
}));

const { useWorkspacePlanPanel } = await import("@/hooks/useWorkspacePlanPanel");

function Probe() {
  useWorkspacePlanPanel();
  return null;
}

const PLAN: PlanArtifactPayload = {
  planId: "plan-newest",
  sessionId: "sess-1",
  content: "# Plan\n\n- step one",
  planStatus: "plan",
  title: "Newest plan",
};

function mountAndActivate(payload: PlanArtifactPayload = PLAN) {
  const { store } = renderWithProviders(<Probe />);
  act(() => {
    fireActivated?.(payload);
  });
  return store;
}

describe("plan restore", () => {
  beforeEach(() => {
    const { store } = renderWithProviders(<div />);
    store.set(previewTabAtom, "browser");
    store.set(rightPanelVisibleAtom, false);
    store.set(planUnreadAtom, false);
    store.set(workspacePlanPanelAtom, {
      planId: null,
      content: null,
      planStatus: null,
      sessionId: null,
      title: null,
      changes: null,
    });
  });

  it("does not switch the right panel to Plan", () => {
    const store = mountAndActivate();
    expect(store.get(previewTabAtom)).toBe("browser");
  });

  it("does not force the right panel open", () => {
    const store = mountAndActivate();
    expect(store.get(rightPanelVisibleAtom)).toBe(false);
  });

  /** The point is not to hide the plan — it is to stop taking the surface. */
  it("still loads the plan into the panel state", () => {
    const store = mountAndActivate();
    expect(store.get(workspacePlanPanelAtom).planId).toBe("plan-newest");
    expect(store.get(workspacePlanPanelAtom).content).toContain("step one");
  });

  it("badges the Plan tab so the plan is discoverable", () => {
    const store = mountAndActivate();
    expect(store.get(planUnreadAtom)).toBe(true);
  });

  /** Nothing is "unread" if you are already looking at it. */
  it("does not badge when the Plan tab is already on screen", () => {
    const { store } = renderWithProviders(<Probe />);
    store.set(previewTabAtom, "plan");
    act(() => {
      fireActivated?.(PLAN);
    });
    expect(store.get(planUnreadAtom)).toBe(false);
  });
});
