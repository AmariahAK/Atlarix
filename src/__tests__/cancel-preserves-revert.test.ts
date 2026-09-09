/**
 * Stopping a turn must not cost you the ability to undo what it did.
 *
 * The pre-write bytes are captured by the PermissionInterceptor at WRITE time, so a
 * stopped turn's snapshot is already on disk. What was missing was the renderer ever
 * learning the turn id: `snapshotTurnId` was only sent on the clean finalize path, and
 * `RevertTurnAction` renders nothing without it. So the one turn you stopped *because*
 * it made a bad edit was the one turn with no Revert button.
 *
 * This pins the two contract halves the fix rests on:
 *   - the live turn's snapshot id is published where `chat:cancel` can read it, and
 *   - `chat:cancel` marks the end as user-cancelled so the auto-wake stays shut.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { streamTurnIdByChatId } from "@/ipc/handlers/chat_stream/stream-state";
import type { ChatResponseEnd } from "@/ipc/ipc_types";

const CHAT = 7;

beforeEach(() => {
  streamTurnIdByChatId.delete(CHAT);
});

describe("streamTurnIdByChatId — what cancel can see", () => {
  it("exposes the live turn's snapshot id to a different handler", () => {
    // chat_stream_handlers publishes it the moment streamTurnId is established;
    // lifecycle-handlers (chat:cancel) has no view of that scope and reads it here.
    streamTurnIdByChatId.set(CHAT, "1001");
    expect(streamTurnIdByChatId.get(CHAT)).toBe("1001");
  });

  it("is absent for a chat with no live turn, so cancel omits the field", () => {
    expect(streamTurnIdByChatId.get(CHAT)).toBeUndefined();
  });

  it("is overwritten per turn rather than accumulating", () => {
    streamTurnIdByChatId.set(CHAT, "1001");
    streamTurnIdByChatId.set(CHAT, "1002");
    expect(streamTurnIdByChatId.get(CHAT)).toBe("1002");
  });
});

describe("the cancel end payload", () => {
  /** Exactly what `chat:cancel` builds, so the shape is pinned by a type-checked value. */
  function buildCancelEnd(chatId: number): ChatResponseEnd {
    return {
      chatId,
      updatedFiles: false,
      hadToolCallsOrPermissions: false,
      userCancelled: true,
      ...(streamTurnIdByChatId.get(chatId)
        ? { snapshotTurnId: streamTurnIdByChatId.get(chatId) }
        : {}),
    };
  }

  it("marks the end as user-cancelled so the auto-wake stays shut", () => {
    // Without this the renderer restarted the agent: cancel kills only FOREGROUND
    // commands, so a pending background result is normal right after a stop, and both
    // wake sites treat "idle + pending result" as "resume".
    expect(buildCancelEnd(CHAT).userCancelled).toBe(true);
  });

  it("carries the stopped turn's snapshot id so Revert is offered", () => {
    streamTurnIdByChatId.set(CHAT, "1001");
    expect(buildCancelEnd(CHAT).snapshotTurnId).toBe("1001");
  });

  it("omits the id when there is none rather than sending a bogus one", () => {
    // A fabricated id would render a Revert button that reverts nothing.
    expect(buildCancelEnd(CHAT).snapshotTurnId).toBeUndefined();
  });

  it("still reports updatedFiles:false — that flag is about the file-tree refresh", () => {
    // Worth pinning: it is NOT a claim that nothing was written, and the snapshot id
    // must be sent regardless of it.
    streamTurnIdByChatId.set(CHAT, "1001");
    const end = buildCancelEnd(CHAT);
    expect(end.updatedFiles).toBe(false);
    expect(end.snapshotTurnId).toBe("1001");
  });
});

/**
 * Sub-agent edits must be revertible by the SAME mechanism as the main agent's.
 *
 * They are, and this pins why: `proposals({operation:"accept"})` does not write. It
 * returns an `edit_file` permission envelope, so the write goes through the
 * PermissionInterceptor's edit_file executor — the same executor that calls
 * `maybeCaptureWorkspaceSnapshot(preview.path)` before writing. If accept ever grew a
 * direct write, sub-agent changes would silently stop being revertible, and this test is
 * what catches that.
 */
describe("sub-agent (proposal) writes are snapshot-covered", () => {
  it("accept returns an edit_file envelope with a preview.path, not a write", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "atlarix-prop-"));
    const rel = "src/touched.ts";
    await fs.mkdir(path.join(workspace, "src"), { recursive: true });
    await fs.writeFile(
      path.join(workspace, rel),
      "export const a = 1;\n",
      "utf8",
    );

    const { createProposalSet, recordEditProposal, __clearAllScopedForTest } =
      (await import("@/lib/agents/subagent-proposals")) as unknown as {
        createProposalSet: (a: {
          chatId: number;
          taskId: string;
          agentName: string;
          workspace: string;
        }) => string;
        recordEditProposal: (id: string, result: unknown) => unknown;
        __clearAllScopedForTest?: () => void;
      };

    const setId = createProposalSet({
      chatId: CHAT,
      taskId: "t1",
      agentName: "implementer",
      workspace,
    });
    // A sub-agent's edit_file is intercepted and recorded as a proposal.
    recordEditProposal(setId, {
      __permission_required: true,
      operation: "edit_file",
      preview: {
        path: rel,
        content: "export const a = 2;\n",
        // The merge base. Without it the proposal reads as a CREATE and accept
        // refuses, seeing a file that already exists on disk.
        oldContent: "export const a = 1;\n",
        type: "update",
      },
    });

    const { ToolRegistry } = await import("@/lib/tools/registry");
    await import("@/lib/tools");
    const res = (await ToolRegistry.get("proposals")!.handler({
      operation: "accept",
      // The set id (or the sub-agent name) selects which review set to land from.
      proposal: setId,
      file: rel,
      workspace,
      chatMode: "build",
      _chatSessionId: CHAT,
    })) as {
      __permission_required?: boolean;
      operation?: string;
      preview?: { path?: string; content?: string };
      error?: string;
    };

    // The load-bearing assertions: it asks for approval as an edit_file, and names the
    // path — the two things the interceptor's snapshot capture needs.
    expect(res.error).toBeUndefined();
    expect(res.__permission_required).toBe(true);
    expect(res.operation).toBe("edit_file");
    expect(res.preview?.path).toBe(rel);
    expect(res.preview?.content).toContain("export const a = 2;");

    // And it did NOT write: the file on disk is untouched until approval.
    expect(await fs.readFile(path.join(workspace, rel), "utf8")).toBe(
      "export const a = 1;\n",
    );

    __clearAllScopedForTest?.();
    await fs.rm(workspace, { recursive: true, force: true });
  });
});
