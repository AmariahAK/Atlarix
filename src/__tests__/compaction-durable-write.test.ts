import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * The v14.39.0 unification, pinned: `runSteppedCompaction` writes the durable
 * `[COMPACTION MARKER]` itself, for EVERY trigger.
 *
 * WHY THIS FILE EXISTS. Compaction used to be three implementations. Only one of
 * them — the model-initiated `compress_context` path — persisted its summary, and
 * it did so from the TOOL layer. The other two (`enforceContextBudget`
 * pre-dispatch, `compactAgenticMessagesIfNeeded` mid-turn) each paid a real
 * provider call for a summary, wrote a marker string that
 * `sliceFromLastCompactionSummary` does not recognise, and dropped it at end of
 * turn; the next turn rebuilt the full history and paid again.
 *
 * Making durability a property of the compactor rather than an obligation on the
 * caller is the actual fix, so the test has to drive the REAL compactor. Only the
 * provider call is faked (via the `ai` module), which is the same trick the eval
 * harness uses: everything between "history is too big" and "a row reached the
 * session" is the shipping code.
 */

const sessionHandlers = vi.hoisted(() => ({
  persistSpy: vi.fn(
    async (_sessionId: string, _content: string, _opts: object) => {},
  ),
  resolveSpy: vi.fn(async () => "resolved-session" as string | null),
}));

vi.mock("@/ipc/handlers/workspace_session_handlers", () => ({
  resolveOrBindWorkspaceSessionForStream: sessionHandlers.resolveSpy,
  persistWorkspaceSessionUserMessage: sessionHandlers.persistSpy,
}));

const llm = vi.hoisted(() => ({
  generateText: vi.fn(async (_opts: { system?: string }) => ({
    text: "Goal: ship the durable compaction pass. Done: moved the write.",
    usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
  })),
}));

// The ONLY fake below the compactor: the provider call itself.
vi.mock("ai", () => ({ generateText: llm.generateText }));
vi.mock("@/main/settings", () => ({ readSettings: () => ({}) }));
vi.mock("@/lib/summarization_model", () => ({
  getCompactionSummarizationModel: async () => ({
    provider: "test",
    name: "test-model",
  }),
}));
vi.mock("@/ipc/utils/get_model_client", () => ({
  getModelClient: async () => ({ modelClient: { model: {} } }),
}));

// enforceContextBudget resolves the window through this; pin it so the test
// controls the budget instead of the model catalog.
const budget = vi.hoisted(() => ({ tierLimit: { value: 10_000 } }));
vi.mock("@/lib/context/resolve-model-context-limit", () => ({
  resolveModelContextLimit: async () => ({
    tierLimit: budget.tierLimit.value,
    rawContextLength: budget.tierLimit.value,
  }),
}));

import {
  runSteppedCompaction,
  countMessagesTokens,
  COMPACTION_SUMMARY_PREFIX,
  IN_TASK_SUMMARY_PREFIX,
  isCompactionSummaryMessage,
  sliceFromLastCompactionSummary,
} from "@/lib/context/compaction";

/** A history big enough to clear FORCE_COMPACT_MIN_HISTORY_TOKENS (8K). */
function bigHistory(turns = 14) {
  const filler = (n: number) => "word ".repeat(n);
  const msgs: Array<{ id: number; role: string; content: string }> = [];
  for (let i = 0; i < turns; i++) {
    msgs.push({ id: i * 2 + 1, role: "user", content: `ask ${i} ${filler(400)}` });
    msgs.push({
      id: i * 2 + 2,
      role: "assistant",
      content: `reply ${i} ${filler(400)}`,
    });
  }
  return msgs;
}

describe("the marker is a PERSISTED DATA FORMAT, not an internal name", () => {
  it("pins the literal prefix that already sits in users' session rows", () => {
    // Asserted as a literal on purpose. Every other check in this file compares
    // against the imported constant, which means a rename would move both sides
    // of the assertion and stay green — while every `[COMPACTION MARKER]` row
    // already written to session_messages silently stopped being recognised, and
    // every reopened session quietly re-expanded its full history. This row of
    // characters is a storage format shared with past versions; changing it needs
    // a migration, not an edit.
    expect(COMPACTION_SUMMARY_PREFIX).toBe("[COMPACTION MARKER]");
    expect(isCompactionSummaryMessage("[COMPACTION MARKER] gen=3\nbody")).toBe(true);
    // Legacy rows predate `gen=` and must still match.
    expect(isCompactionSummaryMessage("[COMPACTION MARKER]\nbody")).toBe(true);
  });

  it("the mid-turn prefix stays DIFFERENT from the durable one", () => {
    // If these ever converge, a mid-loop summary written to finish a tool
    // iteration becomes the point a reopened session resumes from.
    expect(IN_TASK_SUMMARY_PREFIX).not.toContain(COMPACTION_SUMMARY_PREFIX);
    expect(isCompactionSummaryMessage(`${IN_TASK_SUMMARY_PREFIX}\nbody`)).toBe(false);
  });
});

describe("runSteppedCompaction owns the durable write", () => {
  beforeEach(() => {
    sessionHandlers.persistSpy.mockClear();
    sessionHandlers.resolveSpy.mockClear();
    sessionHandlers.resolveSpy.mockResolvedValue("resolved-session");
    llm.generateText.mockClear();
  });

  it("summarizes and persists a [COMPACTION MARKER] using the supplied session id", async () => {
    const messages = bigHistory();
    const tierLimit = Math.floor(countMessagesTokens(messages) * 0.5);

    const out = await runSteppedCompaction(messages, tierLimit, "test-provider", {
      chatId: -42,
      workspaceSessionId: "stream-session-1",
    });

    expect(out.strategy).toBe("summarized");
    expect(out.summaryPersisted).toBe(true);
    // Prefer the supplied (known-good) id; do NOT re-resolve from chatId.
    expect(sessionHandlers.resolveSpy).not.toHaveBeenCalled();
    expect(sessionHandlers.persistSpy).toHaveBeenCalledTimes(1);
    const [sessionId, content] = sessionHandlers.persistSpy.mock.calls[0]!;
    expect(sessionId).toBe("stream-session-1");
    expect(content).toContain(COMPACTION_SUMMARY_PREFIX);
    expect(content).toContain("ship the durable compaction pass");
  });

  it("falls back to resolving the session from chatId when none was supplied", async () => {
    const messages = bigHistory();
    const tierLimit = Math.floor(countMessagesTokens(messages) * 0.5);

    const out = await runSteppedCompaction(messages, tierLimit, "test-provider", {
      chatId: -7,
    });

    expect(out.summaryPersisted).toBe(true);
    expect(sessionHandlers.resolveSpy).toHaveBeenCalledTimes(1);
    expect(sessionHandlers.persistSpy).toHaveBeenCalledWith(
      "resolved-session",
      expect.stringContaining(COMPACTION_SUMMARY_PREFIX),
      {},
    );
  });

  it("reports summaryPersisted=false when no session can be resolved", async () => {
    sessionHandlers.resolveSpy.mockResolvedValue(null);
    const messages = bigHistory();
    const tierLimit = Math.floor(countMessagesTokens(messages) * 0.5);

    const out = await runSteppedCompaction(messages, tierLimit, "test-provider", {
      chatId: -99,
    });

    // The compaction itself still helped this turn; the caller must simply know
    // it will not survive a reload.
    expect(out.strategy).toBe("summarized");
    expect(out.summaryPersisted).toBe(false);
    expect(sessionHandlers.persistSpy).not.toHaveBeenCalled();
  });

  it("writes NOTHING when the cheap steps were enough (no summary, no marker)", async () => {
    const messages = bigHistory();
    // Comfortably under the summarize threshold: nothing to persist.
    const tierLimit = countMessagesTokens(messages) * 10;

    const out = await runSteppedCompaction(messages, tierLimit, "test-provider", {
      chatId: -42,
      workspaceSessionId: "stream-session-1",
    });

    expect(out.strategy).not.toBe("summarized");
    expect(out.summaryPersisted).toBe(false);
    expect(sessionHandlers.persistSpy).not.toHaveBeenCalled();
    expect(llm.generateText).not.toHaveBeenCalled();
  });

  it("the persisted marker is one the dispatch slice actually recognises", async () => {
    // The bug this closes: two of the three paths wrote markers that
    // `sliceFromLastCompactionSummary` could not see, so a reload re-expanded the
    // full history no matter what had been summarized.
    const messages = bigHistory();
    const tierLimit = Math.floor(countMessagesTokens(messages) * 0.5);

    await runSteppedCompaction(messages, tierLimit, "test-provider", {
      chatId: -42,
      workspaceSessionId: "s1",
    });
    const [, persistedContent] = sessionHandlers.persistSpy.mock.calls[0]!;

    expect(isCompactionSummaryMessage(persistedContent)).toBe(true);

    // Replay a reload: the full session log comes back, marker included.
    const rehydrated = [
      ...messages.map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: persistedContent },
      { role: "user", content: "what were we doing?" },
    ];
    const sliced = sliceFromLastCompactionSummary(rehydrated);
    expect(sliced).toHaveLength(2);
    expect(isCompactionSummaryMessage(sliced[0]!.content)).toBe(true);
  });

  it("bills its own summarization to the chat (the durable path used not to)", async () => {
    const messages = bigHistory();
    const tierLimit = Math.floor(countMessagesTokens(messages) * 0.5);

    await runSteppedCompaction(messages, tierLimit, "test-provider", {
      chatId: -42,
      workspaceSessionId: "s1",
    });

    // Reaching the provider at all is what `recordAuxUsage` needs; before the
    // unification this path called the summarizer copy that took no chatId and
    // recorded nothing, so its cost never appeared on the meter.
    expect(llm.generateText).toHaveBeenCalledTimes(1);
    expect(llm.generateText.mock.calls[0]![0]?.system).toBeTruthy();
  });
});

describe("the recovery hint reaches the agent but not the next summary", () => {
  it("is present in the persisted marker", async () => {
    const messages = bigHistory();
    const tierLimit = Math.floor(countMessagesTokens(messages) * 0.5);
    await runSteppedCompaction(messages, tierLimit, "test-provider", {
      chatId: -42,
      workspaceSessionId: "s1",
    });
    const [, content] = sessionHandlers.persistSpy.mock.calls[0]!;
    expect(content).toContain("session_search");
  });

  it("is NOT folded into generation 2 as though it were session content", async () => {
    const messages = bigHistory();
    const tierLimit = Math.floor(countMessagesTokens(messages) * 0.5);

    const gen1 = await runSteppedCompaction(messages, tierLimit, "test-provider", {
      chatId: -42,
      workspaceSessionId: "s1",
    });
    const marker = gen1.modelContext.find((m) =>
      isCompactionSummaryMessage(m.content),
    )!;
    expect(marker.content).toContain("session_search");

    // What the NEXT pass would hand the summarizer as PRIOR SUMMARY.
    const { extractPriorSummary } = await import("@/lib/context/compaction");
    const { prior } = extractPriorSummary([
      { role: "user", content: marker.content },
    ]);
    // If the hint appeared here it would be re-summarized every generation,
    // growing a harness instruction into the user's session summary.
    expect(prior?.summaryText).toBeTruthy();
    expect(prior!.summaryText).not.toContain("session_search");
  });
});

describe("enforceContextBudget: compact first, drop LAST", () => {
  const enforce = async (
    history: Array<{ role: string; content: string; commitHash?: string }>,
    tierLimit: number,
    extra: Record<string, unknown> = {},
  ) => {
    budget.tierLimit.value = tierLimit;
    const { enforceContextBudget } = await import(
      "@/lib/routing/tier_context_budget"
    );
    return enforceContextBudget({
      settings: {} as never,
      effectiveModel: { provider: "test", name: "m" } as never,
      userPrompt: "go",
      systemPrompt: "SYS",
      contextAssemblerBlob: "",
      limitedMessageHistory: history,
      codebasePrefixMessages: [],
      otherCodebasePrefixMessages: [],
      chatId: -42,
      workspaceSessionId: "s1",
      ...extra,
    });
  };

  beforeEach(() => {
    sessionHandlers.persistSpy.mockClear();
    sessionHandlers.resolveSpy.mockClear();
    sessionHandlers.resolveSpy.mockResolvedValue("resolved-session");
    llm.generateText.mockClear();
  });

  it("is a no-op when already within budget (no call, no write)", async () => {
    const history = [{ role: "user", content: "short" }];
    const out = await enforce(history, 1_000_000);
    expect(out.limitedMessageHistory).toBe(history);
    expect(out.llmCompactionApplied).toBeFalsy();
    expect(llm.generateText).not.toHaveBeenCalled();
    expect(sessionHandlers.persistSpy).not.toHaveBeenCalled();
  });

  it("compacts DURABLY when over budget, and drops nothing it could summarize", async () => {
    const history = bigHistory(14).map((m) => ({
      role: m.role,
      content: m.content,
    }));
    const total = countMessagesTokens(history);
    const out = await enforce(history, Math.floor(total * 0.6));

    expect(out.llmCompactionApplied).toBe(true);
    // THE regression this whole pass is about: the summary reached the session.
    expect(out.summaryPersisted).toBe(true);
    expect(sessionHandlers.persistSpy).toHaveBeenCalledTimes(1);
    const [, persisted] = sessionHandlers.persistSpy.mock.calls[0]!;
    expect(persisted).toContain(COMPACTION_SUMMARY_PREFIX);
    // The surviving history carries a marker the dispatch slice recognises.
    expect(
      out.limitedMessageHistory.some((m) =>
        isCompactionSummaryMessage(m.content),
      ),
    ).toBe(true);
    // Dropping is the last resort — a summary was enough here.
    expect(out.droppedMessageCount ?? 0).toBe(0);
  });

  it("preserves per-message fields (commitHash) through the compactor round-trip", async () => {
    // The compactor speaks {id, role, content}; the budget speaks
    // BudgetHistoryMessage. If the map back loses commitHash, revert-to-turn
    // silently stops working for everything older than the last compaction.
    const history = bigHistory(14).map((m, i) => ({
      role: m.role,
      content: m.content,
      ...(i >= 24 ? { commitHash: `sha-${i}` } : {}),
    }));
    const total = countMessagesTokens(history);
    const out = await enforce(history, Math.floor(total * 0.6));

    const withHashes = out.limitedMessageHistory.filter(
      (m) => (m as { commitHash?: string }).commitHash,
    );
    expect(withHashes.length).toBeGreaterThan(0);
    expect((withHashes[0] as { commitHash?: string }).commitHash).toMatch(/^sha-/);
  });

  it("never drops the protected tail, even when the window cannot fit it", async () => {
    const history = bigHistory(14).map((m) => ({
      role: m.role,
      content: m.content,
    }));
    // A window so small nothing fits. Compaction summarizes what it can and the
    // last exchanges are then ALL protected, so there is nothing left that may be
    // dropped. Overflowing here is the honest outcome — the provider rejects and
    // overflow recovery takes over — and it beats silently deleting the turns the
    // user is mid-conversation about.
    const out = await enforce(history, 200);
    expect(out.llmCompactionApplied).toBe(true);
    expect(out.droppedMessageCount ?? 0).toBe(0);
  });

  it("falls back to dropping — and REPORTS it — when the summarizer is unavailable", async () => {
    // The provider being down must not turn the budget into a silent deleter: the
    // count is what `droppedHistoryNotice` uses to tell the model it lost context,
    // and a model that does not know it lost context guesses instead of looking.
    // mockResolvedValue, not ...Once: the budget loop makes up to 24 rounds, so a
    // one-shot outage would be papered over by round 2 succeeding.
    llm.generateText.mockResolvedValue({
      text: "",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    } as never);

    const history = bigHistory(14).map((m) => ({
      role: m.role,
      content: m.content,
    }));
    const total = countMessagesTokens(history);
    const out = await enforce(history, Math.floor(total * 0.6));

    // No summary was produced, so nothing was persisted...
    expect(sessionHandlers.persistSpy).not.toHaveBeenCalled();
    // ...and the drop path engaged instead, with an honest count.
    expect(out.droppedMessageCount ?? 0).toBeGreaterThan(0);
  });
});

describe("enforceContextBudget compacts ONCE per dispatch", () => {
  beforeEach(() => {
    sessionHandlers.persistSpy.mockClear();
    sessionHandlers.resolveSpy.mockClear();
    sessionHandlers.resolveSpy.mockResolvedValue("resolved-session");
    llm.generateText.mockClear();
    llm.generateText.mockResolvedValue({
      text: "Goal: ship it.",
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    } as never);
  });

  it("summarizes at most once and writes at most one marker, even when still over budget", async () => {
    // A window so small that one summary cannot get under it.
    //
    // WHAT THIS DOES AND DOES NOT PROVE. It pins the user-visible property — one
    // over-budget dispatch costs one summarization and one marker row — which is
    // what matters for cost and for the session log. It does NOT isolate the
    // mechanism: two things currently enforce it, the compaction call sitting
    // outside the round loop AND the compactor's own `headIsOnlyPriorSummary`
    // guard. Moving the call back inside the loop still passes this test, because
    // for this input the guard catches the second attempt. The call is outside the
    // loop anyway, because the guard only covers the case where the head is
    // exactly the prior summary — a long protected tail would leave real messages
    // in the head and re-summarize, and `force: true` bypasses the ratio gate that
    // would otherwise stop it.
    budget.tierLimit.value = 200;
    const { enforceContextBudget } = await import(
      "@/lib/routing/tier_context_budget"
    );
    const history = bigHistory(14).map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const out = await enforceContextBudget({
      settings: {} as never,
      effectiveModel: { provider: "test", name: "m" } as never,
      userPrompt: "go",
      systemPrompt: "SYS",
      contextAssemblerBlob: "",
      limitedMessageHistory: history,
      codebasePrefixMessages: [],
      otherCodebasePrefixMessages: [],
      chatId: -42,
      workspaceSessionId: "s1",
    });

    expect(out.llmCompactionApplied).toBe(true);
    expect(llm.generateText).toHaveBeenCalledTimes(1);
    expect(sessionHandlers.persistSpy).toHaveBeenCalledTimes(1);
  });
});
