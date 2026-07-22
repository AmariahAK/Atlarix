import { describe, expect, it, vi, beforeEach } from "vitest";
import { normalizeChatActivityPayload } from "@/lib/chat-activity-normalize";

// These drive the real compaction path (sqlite + a stepped summarize turn), so
// they run in seconds, not milliseconds — the slowest sits ~3.3s against the
// default 5s budget and tips over under full-suite parallel load. Same reason
// the eval project sets testTimeout: 30_000 (vitest.config.ts) and
// subagent-worktree.test.ts pins GIT_IO_TIMEOUT_MS: real I/O needs real budget.
const COMPACTION_IO_TIMEOUT_MS = 30_000;

// ── Model-initiated compress_context must (a) persist a durable
// [COMPACTION MARKER] to the bound workspace session (so reopen stays
// compacted and the model doesn't re-overflow), (b) replace the live
// transport via setMessages, and (c) emit a background activity that
// triggers Feed A token-meter invalidation. Since W9 (v14.8.11) every chat
// is an ephemeral (negative-id) stream-transport chat — the stepped
// compaction path is the ONLY path. ──

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

const SUMMARY_MARKER_CONTENT =
  "[COMPACTION MARKER]\nA concise running summary of the earlier turns.\n[END COMPACTION]";

vi.mock("@/lib/context/compaction", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/context/compaction")>();
  return {
    ...actual,
    // Pretend the stepped path's LLM summarize succeeded.
    runSteppedCompaction: vi.fn(async () => ({
      compactionApplied: true,
      strategy: "summarized" as const,
      tokensFreed: 500,
      summaryText: "A concise running summary of the earlier turns.",
      modelContext: [
        { id: -1, role: "user", content: SUMMARY_MARKER_CONTENT },
        { id: 4, role: "user", content: "latest message" },
      ],
    })),
  };
});

import { executeCompressContext } from "@/lib/tools/workspace";

const COMPACTION_LABEL_FILTER = /summariz|compress|compact/i;

const FOUR_MESSAGES = [
  { id: 1, role: "user", content: "one" },
  { id: 2, role: "assistant", content: "two" },
  { id: 3, role: "user", content: "three" },
  { id: 4, role: "assistant", content: "four" },
];

describe("executeCompressContext — durable marker persistence", () => {
  beforeEach(() => {
    sessionHandlers.persistSpy.mockClear();
    sessionHandlers.resolveSpy.mockClear();
  });

  it("persists a [COMPACTION MARKER] using the supplied session id and updates the live transport", { timeout: COMPACTION_IO_TIMEOUT_MS }, async () => {
    const setMessages = vi.fn();
    const outcome = await executeCompressContext(
      { reason: "test" },
      {
        chatId: -42,
        messages: FOUR_MESSAGES,
        systemPromptTokens: 100,
        workspaceSessionId: "stream-session-1",
        setMessages,
      },
    );

    expect(outcome.success).toBe(true);
    expect(outcome.summaryPersisted).toBe(true);
    // The live transport is replaced with the compacted list.
    expect(setMessages).toHaveBeenCalledTimes(1);
    const nextList = setMessages.mock.calls[0]![0] as Array<{ content: string }>;
    expect(nextList[0]!.content).toContain("[COMPACTION MARKER]");
    // Prefer the supplied (known-good) session id; do NOT re-resolve from chatId.
    expect(sessionHandlers.resolveSpy).not.toHaveBeenCalled();
    expect(sessionHandlers.persistSpy).toHaveBeenCalledTimes(1);
    const [sessionId, content] = sessionHandlers.persistSpy.mock.calls[0]!;
    expect(sessionId).toBe("stream-session-1");
    expect(content).toContain("[COMPACTION MARKER]");
    expect(content).toContain("concise running summary");
  });

  it("falls back to resolving the session when none was supplied", { timeout: COMPACTION_IO_TIMEOUT_MS }, async () => {
    const outcome = await executeCompressContext(
      { reason: "test" },
      {
        chatId: -7,
        messages: FOUR_MESSAGES,
        systemPromptTokens: 100,
        setMessages: vi.fn(),
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

  it("reports summaryPersisted=false when no session can be resolved (the reload-re-summarize risk)", { timeout: COMPACTION_IO_TIMEOUT_MS }, async () => {
    sessionHandlers.resolveSpy.mockResolvedValueOnce(null as unknown as string);
    const outcome = await executeCompressContext(
      { reason: "test" },
      {
        chatId: -99, // no supplied id + unresolvable → marker cannot be written
        messages: FOUR_MESSAGES,
        systemPromptTokens: 100,
        setMessages: vi.fn(),
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
