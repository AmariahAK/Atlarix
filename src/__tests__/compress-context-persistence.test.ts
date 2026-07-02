import { describe, expect, it, vi, beforeEach } from "vitest";
import { normalizeChatActivityPayload } from "@/lib/chat-activity-normalize";

// ── Bug 1+2: model-initiated compress_context must (a) persist a durable
// [COMPACTION MARKER] for a non-ephemeral workspace chat (so reopen stays
// compacted and the model doesn't re-overflow) and (b) emit a background
// activity that triggers Feed A token-meter invalidation. ──

const sessionHandlers = vi.hoisted(() => ({
  persistSpy: vi.fn(
    async (_sessionId: string, _content: string, _opts: object) => {},
  ),
  resolveSpy: vi.fn(async () => "resolved-session"),
}));

vi.mock("@/ipc/handlers/workspace_session_handlers", () => ({
  resolveOrBindWorkspaceSessionForStream: sessionHandlers.resolveSpy,
  persistWorkspaceSessionUserMessage: sessionHandlers.persistSpy,
}));

vi.mock("@/lib/context/compaction", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/context/compaction")>();
  return {
    ...actual,
    // Non-ephemeral path: pretend the LLM summarize succeeded.
    runCompaction: vi.fn(async () => ({
      status: "completed" as const,
      summaryText: "A concise running summary of the earlier turns.",
      lastMessageId: 3,
      messagesAfterSummary: [{ id: 4, role: "user", content: "latest message" }],
    })),
  };
});

import { executeCompressContext } from "@/lib/tools/workspace";

const COMPACTION_LABEL_FILTER = /summariz|compress|compact/i;

describe("executeCompressContext — durable marker persistence (Bug 1+2)", () => {
  beforeEach(() => {
    sessionHandlers.persistSpy.mockClear();
    sessionHandlers.resolveSpy.mockClear();
  });

  it("persists a [COMPACTION MARKER] for a non-ephemeral chat using the supplied session id", async () => {
    const outcome = await executeCompressContext(
      { reason: "test" },
      {
        chatId: 42, // positive id → non-ephemeral (runCompaction) branch
        messages: [
          { id: 1, role: "user", content: "one" },
          { id: 2, role: "assistant", content: "two" },
          { id: 3, role: "user", content: "three" },
          { id: 4, role: "assistant", content: "four" },
        ],
        systemPromptTokens: 100,
        ephemeral: false,
        workspaceSessionId: "stream-session-1",
      },
    );

    expect(outcome.success).toBe(true);
    expect(outcome.summaryPersisted).toBe(true);
    // Prefer the supplied (known-good) session id; do NOT re-resolve from chatId.
    expect(sessionHandlers.resolveSpy).not.toHaveBeenCalled();
    expect(sessionHandlers.persistSpy).toHaveBeenCalledTimes(1);
    const [sessionId, content] = sessionHandlers.persistSpy.mock.calls[0]!;
    expect(sessionId).toBe("stream-session-1");
    expect(content).toContain("[COMPACTION MARKER]");
    expect(content).toContain("concise running summary");
  });

  it("falls back to resolving the session when none was supplied", async () => {
    const outcome = await executeCompressContext(
      { reason: "test" },
      {
        chatId: 7,
        messages: [
          { id: 1, role: "user", content: "one" },
          { id: 2, role: "assistant", content: "two" },
          { id: 3, role: "user", content: "three" },
          { id: 4, role: "assistant", content: "four" },
        ],
        systemPromptTokens: 100,
        ephemeral: false,
      },
    );
    expect(outcome.summaryPersisted).toBe(true);
    expect(sessionHandlers.resolveSpy).toHaveBeenCalledTimes(1);
    expect(sessionHandlers.persistSpy).toHaveBeenCalledWith(
      "resolved-session",
      expect.stringContaining("[COMPACTION MARKER]"),
      {},
    );
  });

  it("reports summaryPersisted=false when no session can be resolved (the reload-re-summarize risk)", async () => {
    sessionHandlers.resolveSpy.mockResolvedValueOnce(null as unknown as string);
    const outcome = await executeCompressContext(
      { reason: "test" },
      {
        chatId: -99, // no supplied id + unresolvable → marker cannot be written
        messages: [
          { id: 1, role: "user", content: "one" },
          { id: 2, role: "assistant", content: "two" },
          { id: 3, role: "user", content: "three" },
          { id: 4, role: "assistant", content: "four" },
        ],
        systemPromptTokens: 100,
        ephemeral: false,
      },
    );
    // Compaction still "succeeds" for the turn, but the caller must know it
    // won't survive reload (chat_stream_handlers surfaces this to the user).
    expect(outcome.summaryPersisted).toBe(false);
    expect(sessionHandlers.persistSpy).not.toHaveBeenCalled();
  });
});

describe("model compaction activity → Feed A invalidation contract (Bug 1c)", () => {
  it("the background 'Context compressed' activity survives normalize and matches the token-visuals filter", () => {
    const item = normalizeChatActivityPayload({
      id: "compress-context-1-123-bg",
      type: "background",
      label: "Context compressed",
      status: "done",
      timestamp: 1,
      chatId: 1,
    });
    expect(item).not.toBeNull();
    expect(item!.type).toBe("background");
    expect(item!.status).toBe("done");
    expect(COMPACTION_LABEL_FILTER.test(item!.label)).toBe(true);
  });

  it("the legacy 'compaction'-typed banner event is dropped by normalize (why Feed A never refreshed before)", () => {
    const item = normalizeChatActivityPayload({
      id: "compress-context-1-123",
      type: "compaction",
      label: "Context compressed",
      status: "done",
      timestamp: 1,
      chatId: 1,
    });
    expect(item).toBeNull();
  });
});
