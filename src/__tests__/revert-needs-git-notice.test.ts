/**
 * Revert works off a git snapshot taken before each write. Without Git
 * (a fresh Windows) the capture failed into a log line and Revert was simply
 * never offered, with nothing saying why (Windows VM, 2026-10-14). Once per
 * run, the chat now says so.
 *
 * The capture RESOLVES on a missing Git, as the real one does: it swallows its
 * own failures so a write is never blocked. The first version of this test
 * mocked it to throw, and so passed while the notice could never fire (QA
 * 15.7.1 #3).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const sent: Array<{ channel: string; payload: any }> = [];
vi.mock("electron", () => ({
  app: { getPath: () => "/tmp", isPackaged: false },
  BrowserWindow: {
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (channel: string, payload: unknown) => sent.push({ channel, payload }) } },
    ],
  },
}));
const gitAvailable = { value: false };
vi.mock("@/ipc/utils/system_git_exec", async (orig) => ({
  ...(await orig<object>()),
  isGitAvailable: async () => gitAvailable.value,
}));
const captureThrows = { value: false };
vi.mock("@/lib/snapshot/snapshot-manager", async (orig) => ({
  ...(await orig<object>()),
  captureSnapshotAcrossRoots: async () => {
    if (captureThrows.value) throw new Error("Git is not installed (or not on PATH).");
  },
}));

import { PermissionInterceptor, _resetRevertNeedsGitNoticeForTests } from "@/ipc/handlers/permissions/interceptor";

const capture = (it: PermissionInterceptor) =>
  (it as unknown as { maybeCaptureWorkspaceSnapshot(p: string[]): Promise<void> }).maybeCaptureWorkspaceSnapshot(["a.ts"]);
const notices = () => sent.filter((s) => s.channel === "chat:activity" && s.payload.type === "background");

describe("Revert without Git", () => {
  beforeEach(() => {
    sent.length = 0;
    captureThrows.value = false;
    _resetRevertNeedsGitNoticeForTests();
  });

  it("says once that Revert is off, in the chat that wrote", async () => {
    gitAvailable.value = false;
    const it = new PermissionInterceptor("/tmp/ws-nogit", undefined, "turn:1", 7);
    await capture(it);
    await capture(it);
    await vi.waitFor(() => expect(notices()).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(notices()).toHaveLength(1);
    expect(notices()[0]!.payload).toMatchObject({ chatId: 7, label: "Revert is off: Git isn't installed." });
  });

  it("says so too if a capture ever does throw", async () => {
    gitAvailable.value = false;
    captureThrows.value = true;
    const it = new PermissionInterceptor("/tmp/ws-nogit", undefined, "turn:1", 7);
    await capture(it);
    await vi.waitFor(() => expect(notices()).toHaveLength(1));
  });

  it("says nothing when Git is there and the capture failed for another reason (control)", async () => {
    gitAvailable.value = true;
    const it = new PermissionInterceptor("/tmp/ws-nogit", undefined, "turn:1", 7);
    await capture(it);
    await new Promise((r) => setTimeout(r, 50));
    expect(notices()).toHaveLength(0);
  });
});
