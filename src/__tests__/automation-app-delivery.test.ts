/**
 * Owner, 2026-10-13: a finished notify-the-agent automation wakes a chat, in
 * the app as in the CLI and editor. The app's side: its chats WITH a
 * conversation claim finished runs for their folders, and the most recently
 * active chat in a folder with a fresh result is woken (once per claim).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { claimFinishedRuns } = vi.hoisted(() => ({
  claimFinishedRuns: vi.fn(async (_ids: number[], _claimer: string) => [] as Array<{ workspaceId: number; wake: boolean }>),
}));
vi.mock("@/lib/automations/agent-delivery", () => ({ claimFinishedRuns }));

import { deliverFinishedRunsToAppChats } from "@/lib/automations/app-delivery";
import { createStreamTransport, getStreamTransport } from "@/lib/chat/stream-transport";

function chatIn(appId: number, messageIds: number[]): number {
  const id = createStreamTransport(appId);
  getStreamTransport(id)!.messages.push(
    ...(messageIds.map((mid) => ({ id: mid, role: "user", content: "x" })) as never[]),
  );
  return id;
}

beforeEach(() => claimFinishedRuns.mockClear());

describe("automation results reach the app's chats", () => {
  it("an empty chat claims nothing", async () => {
    createStreamTransport(901);
    const wake = vi.fn();
    await deliverFinishedRunsToAppChats(wake);
    expect(claimFinishedRuns.mock.calls.every(([ids]) => !ids.includes(901))).toBe(true);
    expect(wake).not.toHaveBeenCalled();
  });

  it("wakes the most recently active chat in the folder with a fresh result", async () => {
    chatIn(902, [10, 11]);
    const recent = chatIn(902, [50]);
    chatIn(903, [60]);
    claimFinishedRuns.mockResolvedValueOnce([{ workspaceId: 902, wake: true }]);
    const wake = vi.fn();
    await deliverFinishedRunsToAppChats(wake);
    expect(claimFinishedRuns.mock.calls[0]![0]).toEqual(expect.arrayContaining([902, 903]));
    expect(claimFinishedRuns.mock.calls[0]![1]).toMatch(/:app$/);
    expect(wake.mock.calls).toEqual([[recent]]);
  });

  it("a stale result wakes no one (it goes into the next message)", async () => {
    chatIn(904, [70]);
    claimFinishedRuns.mockResolvedValueOnce([{ workspaceId: 904, wake: false }]);
    const wake = vi.fn();
    await deliverFinishedRunsToAppChats(wake);
    expect(wake).not.toHaveBeenCalled();
  });
});
