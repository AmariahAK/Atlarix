/**
 * v13.1: the Plan panel is a coexisting TAB, not a takeover. When a plan is
 * active in a workspace (code-preview) context, `useRightPanelContext` must
 * surface a 'plan' tab alongside preview/code/terminal — so the user can switch
 * plan ↔ terminal while the agent builds — and drop it when the plan clears.
 */

import React from "react";
import { describe, it, expect, beforeEach } from "vitest";
import { mapIntentToView, workspacePlanPanelAtom } from "@/atoms/sourceAtoms";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import { renderWithProviders } from "./helpers";
import type { PanelContext } from "@/atoms/sourceAtoms";

// useRightPanelContext reads the route search id — stub it.
import { vi } from "vitest";
vi.mock("@tanstack/react-router", () => ({
  useSearch: () => ({ id: 7 }),
}));

import { useRightPanelContext } from "@/hooks/useRightPanelContext";

let captured: PanelContext | null = null;
function Probe() {
  captured = useRightPanelContext().context;
  return null;
}

describe("right panel — plan as a coexisting tab", () => {
  beforeEach(() => {
    captured = null;
    const { store } = renderWithProviders(<div />);
    // A bound workspace makes the heuristic resolve to 'code-preview'.
    store.set(selectedAppIdAtom, 7);
    store.set(workspacePlanPanelAtom, {
      planId: null,
      content: null,
      planStatus: null,
      sessionId: null,
      changes: null,
    });
  });

  it("mapIntentToView('show-plan') maps to the workspace panel (not its own type)", () => {
    expect(mapIntentToView("show-plan")).toBe("code-preview");
  });

  it("appends a 'plan' tab to the workspace tabs when a plan is active", () => {
    const { store } = renderWithProviders(<Probe />);
    expect(captured?.type).toBe("code-preview");
    // No plan yet → no plan tab.
    expect(captured?.tabs).not.toContain("plan");

    store.set(workspacePlanPanelAtom, {
      planId: "plan-1",
      content: "# Plan",
      planStatus: "building",
      sessionId: "s1",
      changes: null,
    });
    renderWithProviders(<Probe />);
    expect(captured?.tabs).toContain("plan");
    // The normal workspace tabs remain — no takeover.
    expect(captured?.tabs).toEqual(
      expect.arrayContaining(["preview", "code", "terminal"]),
    );
  });

  it("drops the 'plan' tab when the plan clears", () => {
    const { store } = renderWithProviders(<Probe />);
    store.set(workspacePlanPanelAtom, {
      planId: "plan-1",
      content: "# Plan",
      planStatus: "building",
      sessionId: "s1",
      changes: null,
    });
    renderWithProviders(<Probe />);
    expect(captured?.tabs).toContain("plan");

    store.set(workspacePlanPanelAtom, {
      planId: null,
      content: null,
      planStatus: null,
      sessionId: null,
      changes: null,
    });
    renderWithProviders(<Probe />);
    expect(captured?.tabs).not.toContain("plan");
  });
});
