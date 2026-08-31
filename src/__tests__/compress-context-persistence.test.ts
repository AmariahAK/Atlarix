import { describe, expect, it, vi, beforeEach } from "vitest";
import { normalizeChatActivityPayload } from "@/lib/chat-activity-normalize";

// These drive the real compaction path (sqlite + a stepped summarize turn), so
// they run in seconds, not milliseconds — the slowest sits ~3.3s against the
// default 5s budget and tips over under full-suite parallel load. Same reason
// the eval project sets testTimeout: 30_000 (vitest.config.ts) and
// Real git I/O needs a real budget — the default 5s test timeout flakes here.
const COMPACTION_IO_TIMEOUT_MS = 30_000;

// ── What compress_context still owns after the v14.39.0 unification.
//
// The durable write MOVED into `runSteppedCompaction` (see
// compaction-durable-write.test.ts, which drives the real thing against a fake
// LLM). Persistence stopped being this tool's job precisely because being a
// caller's job is how the other two compaction paths never got it. So the tool's
// remaining contract is narrower and is what this file pins:
//   (a) it FORWARDS chatId + workspaceSessionId to the compactor — drop either and
//       compaction silently stops surviving a reload, with nothing failing;
//   (b) it relays `summaryPersisted` back to the caller rather than inventing it;
//   (c) it replaces the live transport via setMessages;
//   (d) it emits a background activity that triggers Feed A meter invalidation.
// Since W9 (v14.8.11) every chat is an ephemeral (negative-id) stream-transport
// chat — the stepped compaction path is the ONLY path. ──

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

const compactorSpy = vi.hoisted(() => ({
  // Records the opts the tool hands the compactor, so the forwarding of
  // chatId/workspaceSessionId is asserted rather than assumed.
  lastOpts: { value: undefined as Record<string, unknown> | undefined },
  summaryPersisted: { value: true },
}));

vi.mock("@/lib/context/compaction", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/context/compaction")>();
  return {
    ...actual,
    // Pretend the stepped path's LLM summarize succeeded. The compactor's own
    // durable write is covered in compaction-durable-write.test.ts.
    runSteppedCompaction: vi.fn(
      async (
        _messages: unknown,
        _tierLimit: number,
        _providerId?: string,
        opts?: Record<string, unknown>,
      ) => {
        compactorSpy.lastOpts.value = opts;
        return {
          compactionApplied: true,
          strategy: "summarized" as const,
          tokensFreed: 500,
          summaryText: "A concise running summary of the earlier turns.",
          usageRatio: 0.95,
          summaryPersisted: compactorSpy.summaryPersisted.value,
          modelContext: [
            { id: -1, role: "user", content: SUMMARY_MARKER_CONTENT },
            { id: 4, role: "user", content: "latest message" },
          ],
        };
      },
    ),
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

describe("executeCompressContext — what the tool still owns", () => {
  beforeEach(() => {
    sessionHandlers.persistSpy.mockClear();
    sessionHandlers.resolveSpy.mockClear();
    compactorSpy.lastOpts.value = undefined;
    compactorSpy.summaryPersisted.value = true;
  });

  it("forwards the supplied session id and chatId to the compactor, and updates the live transport", { timeout: COMPACTION_IO_TIMEOUT_MS }, async () => {
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
    // Forwarding is the whole contract: the compactor cannot write a durable
    // marker for a session it was never told about.
    expect(compactorSpy.lastOpts.value?.chatId).toBe(-42);
    expect(compactorSpy.lastOpts.value?.workspaceSessionId).toBe("stream-session-1");
    // And it must still ask for a real summary, not just the cheap steps.
    expect(compactorSpy.lastOpts.value?.force).toBe(true);
    // The live transport is replaced with the compacted list.
    expect(setMessages).toHaveBeenCalledTimes(1);
    const nextList = setMessages.mock.calls[0]![0] as Array<{ content: string }>;
    expect(nextList[0]!.content).toContain("[COMPACTION MARKER]");
  });

  it("relays summaryPersisted from the compactor instead of deciding it locally", { timeout: COMPACTION_IO_TIMEOUT_MS }, async () => {
    compactorSpy.summaryPersisted.value = true;
    const persisted = await executeCompressContext(
      { reason: "test" },
      { chatId: -7, messages: FOUR_MESSAGES, systemPromptTokens: 100, setMessages: vi.fn() },
    );
    expect(persisted.summaryPersisted).toBe(true);

    // The reload-re-summarize risk: compaction still "succeeds" for the turn, but
    // the caller must learn it will not survive a reload.
    compactorSpy.summaryPersisted.value = false;
    const notPersisted = await executeCompressContext(
      { reason: "test" },
      { chatId: -99, messages: FOUR_MESSAGES, systemPromptTokens: 100, setMessages: vi.fn() },
    );
    expect(notPersisted.success).toBe(true);
    expect(notPersisted.summaryPersisted).toBe(false);
  });

  it("does not write the marker itself — that moved into the compactor", { timeout: COMPACTION_IO_TIMEOUT_MS }, async () => {
    await executeCompressContext(
      { reason: "test" },
      {
        chatId: -42,
        messages: FOUR_MESSAGES,
        systemPromptTokens: 100,
        workspaceSessionId: "stream-session-1",
        setMessages: vi.fn(),
      },
    );
    // With the compactor mocked out, nothing in the tool layer may reach the
    // session. A regression that re-adds a local persist call fails here.
    expect(sessionHandlers.persistSpy).not.toHaveBeenCalled();
    expect(sessionHandlers.resolveSpy).not.toHaveBeenCalled();
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
