/**
 * The guided tour: sequencing, and the ways it ends.
 *
 * The behaviour worth pinning is that EVERY exit records completion. A tour that only
 * remembers you finished it when you press the final "Done" comes back in full for
 * anyone who dismissed step one, which is the specific thing that makes people stop
 * trusting onboarding.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { Provider, createStore } from "jotai";

const invokeMock = vi.fn();
beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (channel: string) => {
    if (channel === "tour:get-state") return { featureTours: {} };
    return {};
  });
  (window as unknown as { electron: unknown }).electron = {
    ipcRenderer: { invoke: invokeMock },
  };
});

import { useGuidedTour } from "@/hooks/useGuidedTour";
import { GUIDED_TOUR_STEPS, chordForStep } from "@/lib/onboarding/guided-tour";

function wrapper({ children }: { children: React.ReactNode }) {
  return <Provider store={createStore()}>{children}</Provider>;
}

describe("guided tour steps", () => {
  it("teaches the two chords the owner asked for, read from the shortcuts table", () => {
    expect(GUIDED_TOUR_STEPS.map((s) => s.id)).toEqual(["workModes", "model"]);
    // Shift+Tab for modes, Cmd/Ctrl+J for models — never literals in the step defs.
    expect(chordForStep(GUIDED_TOUR_STEPS[0])).toMatch(/^(⇧Tab|Shift\+Tab)$/);
    expect(chordForStep(GUIDED_TOUR_STEPS[1])).toMatch(/^(⌘J|Ctrl\+J)$/);
  });

  it("returns undefined for a step whose shortcut row no longer exists", () => {
    // Degrades to a step with no kbd rather than advertising a dead key.
    expect(chordForStep({ id: "model", shortcutId: "nope" })).toBeUndefined();
  });
});

describe("useGuidedTour", () => {
  it("is inactive until started", async () => {
    const { result } = renderHook(() => useGuidedTour(), { wrapper });
    await waitFor(() => expect(result.current.alreadySeen).toBe(false));
    expect(result.current.stepIndex).toBeNull();
    expect(result.current.isStepActive("workModes")).toBe(false);
  });

  it("advances through the steps and records completion at the end", async () => {
    const { result } = renderHook(() => useGuidedTour(), { wrapper });
    await waitFor(() => expect(result.current.alreadySeen).toBe(false));

    act(() => result.current.start());
    expect(result.current.isStepActive("workModes")).toBe(true);
    expect(result.current.isStepActive("model")).toBe(false);

    act(() => result.current.next());
    expect(result.current.isStepActive("model")).toBe(true);

    act(() => result.current.next()); // past the last step
    expect(result.current.stepIndex).toBeNull();

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "tour:set-state",
        expect.objectContaining({
          featureTours: expect.objectContaining({
            "guided-tour": { completed: true, step: 0 },
          }),
        }),
      );
    });
  });

  it("records completion when abandoned at step one, so it does not come back", async () => {
    const { result } = renderHook(() => useGuidedTour(), { wrapper });
    await waitFor(() => expect(result.current.alreadySeen).toBe(false));

    act(() => result.current.start());
    act(() => result.current.end());

    expect(result.current.stepIndex).toBeNull();
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "tour:set-state",
        expect.objectContaining({
          featureTours: expect.objectContaining({
            "guided-tour": { completed: true, step: 0 },
          }),
        }),
      );
    });
  });

  it("refuses to start for someone who has already been through it", async () => {
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === "tour:get-state")
        return {
          featureTours: { "guided-tour": { completed: true, step: 0 } },
        };
      return {};
    });

    const { result } = renderHook(() => useGuidedTour(), { wrapper });
    await waitFor(() => expect(result.current.alreadySeen).toBe(true));

    act(() => result.current.start());
    expect(result.current.stepIndex).toBeNull();
  });
});
