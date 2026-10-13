/**
 * QA (app) #1b: after Revert on a reply, the agent's next turn assumed its fix
 * was still there. The user's next message now carries the CLI's files-only
 * restore note, to the model only.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { getDefaultStore } from "jotai";
import { chatMessagesByIdAtom, turnSnapshotTurnIdByMessageIdAtom } from "@/atoms/chatAtoms";
import type { Message } from "@/ipc/ipc_types";

const takeRevertedFiles = vi.fn<(p: { chatId: number; turnIds: string[] }) => Promise<string[]>>(async () => []);
vi.mock("@/ipc/ipc_client", () => ({
  IpcClient: { getInstance: () => ({ takeRevertedFiles }) },
}));

import { withRevertedFilesNote } from "@/lib/chat/reverted-files-reminder";

const msgs = [
  { id: 10, role: "user", content: "fix both bugs" },
  { id: 11, role: "assistant", content: "Both bugs are fixed." },
] as unknown as Message[];

beforeEach(() => {
  takeRevertedFiles.mockClear();
  const store = getDefaultStore();
  store.set(chatMessagesByIdAtom, new Map([[7, msgs]]));
  store.set(turnSnapshotTurnIdByMessageIdAtom, new Map([[11, "11"]]));
});

describe("the message after a Revert", () => {
  it("tells the model which files went back", async () => {
    takeRevertedFiles.mockResolvedValueOnce(["src/tally.js"]);
    const out = await withRevertedFilesNote(7, "run the tests again");
    expect(takeRevertedFiles).toHaveBeenCalledWith({ chatId: 7, turnIds: ["11"] });
    expect(out).toBe(
      "<system-reminder>The user restored these files to how they were before an earlier message; your edits to them since are gone: src/tally.js. Read a file again before changing it.</system-reminder>\n\nrun the tests again",
    );
  });

  it("is unchanged when nothing was reverted", async () => {
    expect(await withRevertedFilesNote(7, "hi")).toBe("hi");
  });
});
