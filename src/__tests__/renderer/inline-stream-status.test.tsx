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
import { permissionQueueAtom, type QueuedOperation } from "@/atoms/permissionQueueAtom";
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
    store.set(permissionQueueAtom, new Map());
  });

  it("counts only this chat's waiting approvals (15.11.1 QA: another chat's card made it '2 approvals')", () => {
    const card = (id: string, chatId: number): [string, QueuedOperation] => [
      id,
      { id, chatId, operation: "edit_file", path: `${id}.ts`, status: "pending", timestamp: 1 },
    ];
    const { store } = renderWithProviders(<InlineStreamStatus chatId={CHAT_ID} active />);
    act(() => {
      store.set(permissionQueueAtom, new Map([card("mine", CHAT_ID), card("elsewhere", CHAT_ID + 1)]));
    });
    expect(screen.getByText(/Waiting for you/)).toBeInTheDocument();
    expect(screen.queryByText("2 approvals")).not.toBeInTheDocument();
    // Only another chat waiting: this one is not.
    act(() => {
      store.set(permissionQueueAtom, new Map([card("elsewhere", CHAT_ID + 1)]));
    });
    expect(screen.queryByText(/Waiting for you/)).not.toBeInTheDocument();
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
    expect(store.get(toolIndicatorAtom).phaseLabel).toBe(
      "mapping out structure",
    );
    expect(screen.getByText("mapping out structure")).toBeInTheDocument();
  });
});

/**
 * Compaction, mid-turn — the pause the UI never explained.
 *
 * The agent stops for several seconds to summarise its own context and the
 * status line said nothing, which reads as a hang.
 *
 * NOTE WHICH EVENT THIS READS. The main process emits both a `compaction`
 * banner event and a parallel `background` one, and `chat-activity-normalize.ts`
 * drops the `compaction` type DELIBERATELY — admitting it would put two rows in
 * the atom for one event, and `compress-context-persistence.test.ts` pins that
 * drop as the contract. The first attempt here un-dropped it and that test
 * caught it, correctly. So the pill reads the `background` row by label, the
 * same shape `useCompactionTokenVisuals` already uses.
 */
describe("compaction is visible mid-turn", () => {
  const bg = (over: Record<string, unknown>) =>
    [
      {
        id: "c1",
        type: "background",
        label: "Summarizing in-task context",
        status: "running",
        timestamp: Date.now(),
        chatId: CHAT_ID,
        ...over,
      },
    ] as never;

  beforeEach(() => {
    const store = renderWithProviders(<div />).store;
    store.set(toolIndicatorAtom, emptyToolIndicatorState());
    store.set(isStreamingByIdAtom, new Map([[CHAT_ID, true]]));
    store.set(activityStreamItemsAtom, []);
  });

  it("the `compaction` type stays dropped by normalize", async () => {
    // Guarding the decision, not just the behaviour: the obvious "fix" for an
    // invisible compaction is to admit this type, and that is the wrong one.
    const { normalizeChatActivityPayload } = await import(
      "@/lib/chat-activity-normalize"
    );
    expect(
      normalizeChatActivityPayload({
        id: "c1",
        type: "compaction",
        label: "Context compressed",
        status: "done",
        timestamp: 1,
        chatId: CHAT_ID,
      }),
    ).toBeNull();
  });

  it("shows a running pill instead of the ordinary status line", () => {
    const store = renderWithProviders(<div />).store;
    store.set(activityStreamItemsAtom, bg({}));
    renderWithProviders(<InlineStreamStatus chatId={CHAT_ID} active />);
    const pill = screen.getByRole("status");
    // The main process's label is internal wording ("Summarizing in-task
    // context"); the pill says what the USER needs to know.
    expect(pill.textContent).toContain("Compressing context");
    // Announced, because it explains a pause the user is already noticing.
    expect(pill.getAttribute("aria-live")).toBe("polite");
    // The pulse IS the message: the turn has not stalled.
    expect(pill.innerHTML).toContain("animate-pulse");
  });

  it("shows the finished pill briefly, then gets out of the way", () => {
    const store = renderWithProviders(<div />).store;
    store.set(
      activityStreamItemsAtom,
      bg({
        status: "done",
        label: "Context compressed",
        detail: "120000 → 40000 tokens",
      }),
    );
    const { unmount } = renderWithProviders(
      <InlineStreamStatus chatId={CHAT_ID} active />,
    );
    // "It compressed and carried on" is the reassuring half of the story —
    // dropping it leaves the user wondering what the pause was.
    expect(screen.getByRole("status").textContent).toContain(
      "Context compressed",
    );
    expect(screen.getByRole("status").textContent).toContain("120000 → 40000");
    unmount();

    store.set(
      activityStreamItemsAtom,
      bg({
        status: "done",
        label: "Context compressed",
        timestamp: Date.now() - 20_000,
      }),
    );
    renderWithProviders(<InlineStreamStatus chatId={CHAT_ID} active />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("ignores an unrelated background row", () => {
    // The filter is by LABEL, so a background job that is not compaction must
    // not hijack the status line.
    const store = renderWithProviders(<div />).store;
    store.set(activityStreamItemsAtom, bg({ label: "Running dev server" }));
    renderWithProviders(<InlineStreamStatus chatId={CHAT_ID} active />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("ignores an automation's wake line, whatever the automation is called", () => {
    const store = renderWithProviders(<div />).store;
    store.set(
      activityStreamItemsAtom,
      bg({
        id: "wake-automation-3-0",
        status: "done",
        label: 'Automation "Summarize Slack" finished: Summarized 12 threads',
      }),
    );
    renderWithProviders(<InlineStreamStatus chatId={CHAT_ID} active />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("ignores another chat's compaction", () => {
    const store = renderWithProviders(<div />).store;
    store.set(activityStreamItemsAtom, bg({ chatId: CHAT_ID + 1 }));
    renderWithProviders(<InlineStreamStatus chatId={CHAT_ID} active />);
    expect(screen.queryByRole("status")).toBeNull();
  });
});
