/**
 * A session another process names or renames (the CLI, an editor's agent)
 * reaches the app's sidebar and tabs, and the panel's Past chats: nothing in
 * this process wrote it, so nothing else would say (item 6, QA 4(b),
 * 2026-10-22).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { watchStoredSessions } from "@/lib/sessions/stored-sessions-watch";

afterEach(() => vi.useRealTimers());

describe("watching the stored sessions", () => {
  it("says so when they change, once per change, and never for the first read", async () => {
    vi.useFakeTimers();
    let sig = "1:aaa";
    const changed = vi.fn();
    const stop = watchStoredSessions(changed, { intervalMs: 1000, signature: async () => sig });
    await vi.advanceTimersByTimeAsync(3000);
    expect(changed).not.toHaveBeenCalled();
    sig = "1:bbb"; // the CLI re-titled a session
    await vi.advanceTimersByTimeAsync(1000);
    expect(changed).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(changed).toHaveBeenCalledTimes(1);
    stop();
    sig = "2:ccc";
    await vi.advanceTimersByTimeAsync(3000);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("a failed read is not a change", async () => {
    vi.useFakeTimers();
    let sig = "1:aaa";
    const changed = vi.fn();
    const stop = watchStoredSessions(changed, { intervalMs: 1000, signature: async () => sig });
    await vi.advanceTimersByTimeAsync(1000);
    sig = "";
    await vi.advanceTimersByTimeAsync(1000);
    sig = "1:aaa";
    await vi.advanceTimersByTimeAsync(1000);
    expect(changed).not.toHaveBeenCalled();
    stop();
  });
});

// ── the app's windows ────────────────────────────────────────────────────────
const listeners: { changed?: () => void } = {};
vi.mock("@/ipc/ipc_client", () => ({
  IpcClient: {
    getInstance: () => ({
      onSessionTitleUpdated: () => () => {},
      onSessionsChanged: (l: () => void) => ((listeners.changed = l), () => {}),
    }),
  },
}));

describe("the app's sidebar", () => {
  it("re-reads its sessions when another process changed them", async () => {
    const { getDefaultStore } = await import("jotai");
    const { workspaceSessionsRefreshAtom } = await import("@/atoms/sessionAtoms");
    const { subscribeToSessionTitleUpdates } = await import("@/lib/workspace-session-title");
    const off = subscribeToSessionTitleUpdates();
    const before = getDefaultStore().get(workspaceSessionsRefreshAtom);
    listeners.changed?.();
    expect(getDefaultStore().get(workspaceSessionsRefreshAtom)).toBe(before + 1);
    off();
  });
});
