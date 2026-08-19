/**
 * v12.10: useWorkspacePlanPanel must not infinite-loop (React #185) while a plan
 * is showing. Pre-fix, a fresh `.map()` of messages every render made the
 * sync-changes effect write a new panel object every render → re-render → loop.
 * This mounts the hook with a plan + a chat message present and asserts the
 * component settles to a bounded render count instead of throwing.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act } from "@testing-library/react";
import { workspacePlanPanelAtom } from "@/atoms/sourceAtoms";
import { chatMessagesByIdAtom } from "@/atoms/chatAtoms";
import { renderWithProviders } from "./helpers";

const CHAT_ID = 42;

// useWorkspacePlanPanel reads the route search id and subscribes to plan-artifact
// IPC — stub both so the hook can mount headlessly.
vi.mock("@tanstack/react-router", () => ({
  useSearch: () => ({ id: CHAT_ID }),
}));
vi.mock("@/ipc/ipc_client", () => ({
  IpcClient: {
    getInstance: () => ({
      onPlanArtifactActivated: () => () => {},
      onPlanArtifactUpdated: () => () => {},
    }),
  },
}));

import { useWorkspacePlanPanel } from "@/hooks/useWorkspacePlanPanel";

let renderCount = 0;
function Probe() {
  useWorkspacePlanPanel();
  renderCount++;
  return null;
}

describe("useWorkspacePlanPanel — no infinite render", () => {
  beforeEach(() => {
    renderCount = 0;
    const { store } = renderWithProviders(<div />);
    // A plan is showing (content truthy) — the condition that armed the loop.
    store.set(workspacePlanPanelAtom, {
      planId: "plan-1",
      content: "# Plan\n\n- step one",
      planStatus: "plan",
      sessionId: "sess-1",
      title: "Test plan",
      changes: null,
      pinnedPlanId: null,
    });
    store.set(
      chatMessagesByIdAtom,
      new Map([
        [
          CHAT_ID,
          [
            {
              id: -1,
              role: "assistant" as const,
              content: "Working on the plan.",
              chatId: CHAT_ID,
              createdAt: new Date(0),
            },
          ],
        ],
      ]),
    );
  });

  it("settles to a bounded render count instead of looping", () => {
    expect(() => {
      act(() => {
        renderWithProviders(<Probe />);
      });
    }).not.toThrow();
    // A loop would blow far past this (React aborts at ~50 with #185).
    expect(renderCount).toBeLessThan(6);
  });
});
