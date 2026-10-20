/**
 * The app following a turn another Atlarix runs (live sessions): the window
 * shows that turn as it grows, sends what you type to it, and stops it, then
 * carries on itself once it ends.
 */
import React from "react";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatInputValueAtom, followingByChatIdAtom, isStreamingByIdAtom } from "@/atoms/chatAtoms";
import { chatIdToSessionIdAtom } from "@/atoms/sessionAtoms";
import { renderWithProviders } from "./helpers";

const CHAT_ID = 9;
const SESSION = "sess-follow";

vi.mock("@/hooks/useSettings", () => ({
  useSettings: () => ({ settings: { selectedModel: { name: "m", provider: "p" } } }),
}));
vi.mock("@/lib/auth/useAuth", () => ({ useAuth: () => ({ isAuthenticated: true, loading: false }) }));
vi.mock("@/hooks/useAttachments", () => ({
  useAttachments: () => ({
    attachments: [],
    fileInputRef: { current: null },
    isDraggingOver: false,
    handleFileSelect: vi.fn(),
    removeAttachment: vi.fn(),
    handleDragOver: vi.fn(),
    handleDragLeave: vi.fn(),
    handleDrop: vi.fn(),
    clearAttachments: vi.fn(),
    handlePaste: vi.fn(),
  }),
}));
vi.mock("@/components/ChatInputControls", () => ({ ChatInputControls: () => null }));
vi.mock("@/components/chat/TokenBar", () => ({ TokenBar: () => null }));
vi.mock("@/components/chat/AttachmentsList", () => ({ AttachmentsList: () => null }));
vi.mock("@/components/chat/SignInToChatNotice", () => ({ SignInToChatNotice: () => null }));

const hydrated: string[] = [];
vi.mock("@/lib/chat/hydrate-session-into-chat", () => ({
  hydrateSessionIntoChat: async ({ sessionId }: { sessionId: string }) => {
    hydrated.push(sessionId);
    return {};
  },
}));

const ipc = vi.hoisted(() => ({
  elsewhere: null as { surface: "cli"; name: string } | null,
  revision: "1",
  steerOk: true,
  steer: [] as Array<[string, string]>,
  stops: [] as string[],
}));
vi.mock("@/ipc/ipc_client", () => ({
  IpcClient: {
    getInstance: () => ({
      cancelChatStream: vi.fn(),
      onTokenUsage: () => () => {},
      interjectUserMessage: vi.fn(),
      cancelUserInterjection: vi.fn(),
      listUserInterjections: async () => [],
      listMcpSuggestions: async () => [],
      onMcpSuggestion: () => () => {},
      onUserInterjections: () => () => {},
      sessionRunningElsewhere: async () => ipc.elsewhere,
      sessionRevision: async () => ipc.revision,
      steerRemoteSession: async (sessionId: string, text: string) => {
        ipc.steer.push([sessionId, text]);
        return ipc.steerOk ? { ok: true } : { ok: false, error: "not running" };
      },
      stopRemoteSession: async (sessionId: string) => {
        ipc.stops.push(sessionId);
        return { ok: true };
      },
    }),
  },
}));

import { SimpleChatInput } from "@/components/SimpleChatInput";
import { useFollowRunningSession } from "@/hooks/useFollowRunningSession";

function Follower() {
  useFollowRunningSession(CHAT_ID);
  return null;
}

beforeEach(() => {
  hydrated.length = 0;
  ipc.elsewhere = null;
  ipc.revision = "1";
  ipc.steerOk = true;
  ipc.steer.length = 0;
  ipc.stops.length = 0;
  const { store } = renderWithProviders(<div />);
  store.set(chatIdToSessionIdAtom, new Map([[CHAT_ID, SESSION]]));
  store.set(isStreamingByIdAtom, new Map());
  store.set(followingByChatIdAtom, new Map());
  store.set(chatInputValueAtom, "");
});

describe("following a turn another Atlarix runs", () => {
  it("re-reads the session as it changes, and once more when the turn ends", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      ipc.elsewhere = { surface: "cli", name: "Fix the parser" };
      const { store } = renderWithProviders(<Follower />);
      await waitFor(() => expect(store.get(followingByChatIdAtom).get(CHAT_ID)).toMatchObject({ surface: "cli" }));
      await waitFor(() => expect(hydrated).toHaveLength(1));

      // Nothing changed: no re-read.
      await act(async () => void (await vi.advanceTimersByTimeAsync(1_600)));
      expect(hydrated).toHaveLength(1);

      // The draft grew.
      ipc.revision = "2";
      await act(async () => void (await vi.advanceTimersByTimeAsync(1_600)));
      expect(hydrated).toHaveLength(2);

      // The turn ended: one last read (it rebuilds the transport), and no longer following.
      ipc.elsewhere = null;
      await act(async () => void (await vi.advanceTimersByTimeAsync(1_600)));
      expect(hydrated).toHaveLength(3);
      expect(store.get(followingByChatIdAtom).has(CHAT_ID)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the composer sends what you type to that turn, and Stop stops it there", async () => {
    const onSubmit = vi.fn();
    const { store } = renderWithProviders(<SimpleChatInput chatId={CHAT_ID} onSubmit={onSubmit} />);
    act(() => store.set(followingByChatIdAtom, new Map([[CHAT_ID, { surface: "cli" as const, name: "x" }]])));
    expect(screen.getByText(/Running in the CLI · following/)).toBeInTheDocument();

    const textarea = screen.getByRole("textbox");
    act(() => void fireEvent.change(textarea, { target: { value: "also the empty file" } }));
    act(() => void fireEvent.keyDown(textarea, { key: "Enter" }));
    await waitFor(() => expect(ipc.steer).toEqual([[SESSION, "also the empty file"]]));
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTitle(/Stop generation/));
    await waitFor(() => expect(ipc.stops).toEqual([SESSION]));
  });

  it("a turn that just ended: the message runs here instead, after one last read", async () => {
    ipc.steerOk = false;
    const onSubmit = vi.fn();
    const { store } = renderWithProviders(<SimpleChatInput chatId={CHAT_ID} onSubmit={onSubmit} />);
    act(() => store.set(followingByChatIdAtom, new Map([[CHAT_ID, { surface: "cli" as const, name: "x" }]])));
    const textarea = screen.getByRole("textbox");
    act(() => void fireEvent.change(textarea, { target: { value: "too late?" } }));
    act(() => void fireEvent.keyDown(textarea, { key: "Enter" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("too late?", []));
    expect(hydrated).toEqual([SESSION]);
  });
});
