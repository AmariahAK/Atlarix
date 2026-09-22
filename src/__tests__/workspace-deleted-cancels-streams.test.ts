/**
 * Deleting a workspace must stop the turns running inside it — and nothing else.
 *
 * `delete-app` stopped the dev server and cascaded the chat rows, but never
 * touched `activeStreams`. So a Build turn could be mid-`run_command` inside a
 * directory the same handler was about to `rm -rf`, writing its result to a chat
 * row that no longer existed. Nothing reported that; the turn just failed
 * somewhere deep, in a window still showing a working sidebar.
 *
 * The two halves that matter are equally important and pull against each other:
 * every turn in the deleted workspace must stop, and no turn in any OTHER
 * workspace may be touched. A cancel that is too broad kills a second window's
 * unrelated work — which is the exact class of cross-window bug
 * `system-wake-admission.test.ts` exists for.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp", isPackaged: false },
  powerSaveBlocker: {
    start: () => 1,
    stop: () => undefined,
    isStarted: () => false,
  },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {} },
  webContents: { getAllWebContents: () => [] },
}));
vi.mock("electron-log", () => {
  const scope = () => ({
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    log: vi.fn(),
  });
  return { default: { scope, ...scope() } };
});

const killed: number[] = [];
const cancelledSubagents: number[] = [];
vi.mock("@/lib/agent/background-commands", () => ({
  killForegroundCommandsForChat: (id: number) => killed.push(id),
}));
vi.mock("@/lib/tools/spawn-task", () => ({
  cancelAllSubagentTasksForChat: (id: number) => cancelledSubagents.push(id),
}));

const appIdByChat = new Map<number, number>();
vi.mock("@/lib/chat/stream-transport", () => ({
  getStreamTransportAppId: (chatId: number) => appIdByChat.get(chatId),
}));

import { activeStreams } from "@/ipc/handlers/chat_stream/stream-state";
import { cancelStreamsForApp } from "@/ipc/handlers/chat_stream/stream-lifecycle";

const DELETED_APP = 7;
const OTHER_APP = 9;

function liveTurn(chatId: number, appId: number): AbortController {
  const ac = new AbortController();
  activeStreams.set(chatId, ac);
  appIdByChat.set(chatId, appId);
  return ac;
}

beforeEach(() => {
  activeStreams.clear();
  appIdByChat.clear();
  killed.length = 0;
  cancelledSubagents.length = 0;
});

describe("cancelStreamsForApp", () => {
  it("aborts every turn in the deleted workspace", () => {
    const a = liveTurn(-1, DELETED_APP);
    const b = liveTurn(-2, DELETED_APP);

    expect(cancelStreamsForApp(DELETED_APP)).toBe(2);

    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(true);
    expect(activeStreams.has(-1)).toBe(false);
    expect(activeStreams.has(-2)).toBe(false);
  });

  it("leaves another workspace's turn completely alone", () => {
    const mine = liveTurn(-1, DELETED_APP);
    const theirs = liveTurn(-2, OTHER_APP);

    cancelStreamsForApp(DELETED_APP);

    expect(mine.signal.aborted).toBe(true);
    expect(theirs.signal.aborted).toBe(false);
    expect(activeStreams.has(-2)).toBe(true);
    expect(killed).not.toContain(-2);
    expect(cancelledSubagents).not.toContain(-2);
  });

  it("also stops the blocking commands and sub-agents, not just the stream", () => {
    // The abort signal alone does not reach a foreground command already
    // spawned, nor a sub-agent task — which is the whole reason this is built on
    // `cancelStreamForAutomation` rather than calling `.abort()` directly. A
    // workspace deletion has to tear down exactly what an automation timeout
    // does, because the folder is about to disappear from under all of it.
    liveTurn(-1, DELETED_APP);

    cancelStreamsForApp(DELETED_APP);

    expect(killed).toContain(-1);
    expect(cancelledSubagents).toContain(-1);
  });

  it("reports nothing to report when the workspace had no live turn", () => {
    liveTurn(-2, OTHER_APP);
    // The count is what the blocking screen uses to decide whether to tell the
    // user a turn was cancelled, so a wrong zero is a silent lie and a wrong
    // non-zero is an invented one.
    expect(cancelStreamsForApp(DELETED_APP)).toBe(0);
  });

  it("survives iterating a map it is deleting from", () => {
    // `cancelStreamForAutomation` deletes from `activeStreams` as it goes.
    // Iterating the live key set instead of a snapshot silently skips entries —
    // the failure mode is "half the turns kept running", which looks like
    // nothing at all until a command writes into a deleted folder.
    for (let i = 1; i <= 12; i++) liveTurn(-i, DELETED_APP);

    expect(cancelStreamsForApp(DELETED_APP)).toBe(12);
    expect(activeStreams.size).toBe(0);
  });
});
