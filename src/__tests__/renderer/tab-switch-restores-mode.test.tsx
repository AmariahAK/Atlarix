/**
 * QA (app) #13: switching sessions with the tab strip kept the PREVIOUS
 * session's mode. "CLI top N…" is stored as Plan; switching to "Run tests…"
 * (Explore) and back with the tabs still showed Explore, and the next message
 * ran in it. The tab switch set the active session id and never its mode —
 * the drift activateWorkspaceSession exists to prevent.
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { makeFakeIpc, renderWithProviders } from "./helpers";
import { activeChatIdAtom, chatMessagesByIdAtom, openChatTabsAtom } from "@/atoms/chatAtoms";
import {
  activeSessionWorkModeAtom,
  activeWorkspaceSessionIdAtom,
  chatIdToSessionIdAtom,
} from "@/atoms/sessionAtoms";

const modes: Record<string, string | null> = { "s-plan": "plan", "s-explore": "ask" };
const fakeIpc = Object.assign(makeFakeIpc(), {
  getWorkspaceSession: vi.fn(async (id: string) => ({ session: { id, workMode: modes[id] ?? null }, messages: [] })),
});
vi.mock("@/ipc/ipc_client", () => ({
  IpcClient: { getInstance: () => fakeIpc },
}));

import { ChatTabStrip } from "@/components/chat/ChatTabStrip";

describe("switching sessions with the tabs", () => {
  it("brings back the mode the session is stored with", async () => {
    const { store } = renderWithProviders(<div />);
    store.set(openChatTabsAtom, [
      { chatId: 1, appId: null, title: "CLI top N" },
      { chatId: 2, appId: null, title: "Run tests" },
    ]);
    store.set(chatIdToSessionIdAtom, new Map([[1, "s-plan"], [2, "s-explore"]]));
    // Both already loaded: the switch reads nothing else.
    store.set(chatMessagesByIdAtom, new Map([[1, [{ id: 1 }]], [2, [{ id: 2 }]]] as never));
    store.set(activeChatIdAtom, 2);
    store.set(activeWorkspaceSessionIdAtom, "s-explore");
    store.set(activeSessionWorkModeAtom, "ask");

    renderWithProviders(<ChatTabStrip />);
    await act(async () => {
      fireEvent.click(screen.getByText("CLI top N"));
    });
    await waitFor(() => expect(store.get(activeSessionWorkModeAtom)).toBe("plan"));
    expect(store.get(activeWorkspaceSessionIdAtom)).toBe("s-plan");
  });
});
