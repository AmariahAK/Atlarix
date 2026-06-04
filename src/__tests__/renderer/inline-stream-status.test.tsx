/**
 * v10.1 streaming indicator: inline compass + one-line status under the
 * CURRENT assistant response only; settles into a stagnant "A" when done.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, screen } from "@testing-library/react";
import {
  isStreamingByIdAtom,
  toolIndicatorAtom,
  emptyToolIndicatorState,
} from "@/atoms/chatAtoms";
import { activityStreamItemsAtom } from "@/atoms/sourceAtoms";
import { makeFakeIpc, renderWithProviders } from "./helpers";

const fakeIpc = makeFakeIpc();

vi.mock("@/ipc/ipc_client", () => ({
  IpcClient: { getInstance: () => fakeIpc },
}));

vi.mock("@/hooks/useSettings", () => ({
  useSettings: () => ({
    settings: { workModePreference: "build" },
    updateSettings: vi.fn(),
  }),
}));

import { InlineStreamStatus } from "@/components/chat/InlineStreamStatus";

const CHAT_ID = 42;

describe("InlineStreamStatus", () => {
  beforeEach(() => {
    const store = renderWithProviders(<div />).store;
    store.set(toolIndicatorAtom, emptyToolIndicatorState());
    store.set(isStreamingByIdAtom, new Map([[CHAT_ID, true]]));
    store.set(activityStreamItemsAtom, []);
  });

  it("shows the looping compass + idle work-mode label while streaming", () => {
    renderWithProviders(<InlineStreamStatus chatId={CHAT_ID} active />);
    const compass = screen.getAllByTestId("atlarix-animation")[0];
    expect(compass).toHaveAttribute("data-phase", "thinking");
    expect(compass).toHaveAttribute("data-size", "inline");
    expect(screen.getByText("Building…")).toBeInTheDocument();
  });

  it("names the tool subject from args — 'Writing src/auth.ts…'", () => {
    const { store } = renderWithProviders(
      <InlineStreamStatus chatId={CHAT_ID} active />,
    );
    act(() => {
      store.set(toolIndicatorAtom, {
        ...emptyToolIndicatorState(),
        active: true,
        count: 1,
        toolId: "write_file",
        toolName: "Writing code…",
        toolArgs: { path: "src/auth.ts" },
        activeChatId: CHAT_ID,
      });
    });
    expect(screen.getByText("Writing src/auth.ts…")).toBeInTheDocument();
  });

  it("settles into the stagnant 'A' when the turn completes (active=false)", () => {
    renderWithProviders(<InlineStreamStatus chatId={CHAT_ID} active={false} />);
    const compass = screen.getAllByTestId("atlarix-animation")[0];
    expect(compass).toHaveAttribute("data-phase", "done");
    // No status line once the turn is over.
    expect(screen.queryByText("Building…")).not.toBeInTheDocument();
  });

  it("stream phase 'thinking' label takes over when no tool is running", () => {
    const { store } = renderWithProviders(
      <InlineStreamStatus chatId={CHAT_ID} active />,
    );
    act(() => {
      fakeIpc.emitStreamPhase({
        chatId: CHAT_ID,
        phase: "thinking",
        label: "mapping out structure",
      });
    });
    expect(store.get(toolIndicatorAtom).phaseLabel).toBe("mapping out structure");
    expect(screen.getByText("mapping out structure")).toBeInTheDocument();
  });
});
