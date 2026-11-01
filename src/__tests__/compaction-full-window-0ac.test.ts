import { describe, expect, it, vi } from "vitest";

/**
 * 0ac (2026-11-01): `compress_context` was a dud when actually full — it no-oped
 * on a session whose meter read over 100% capacity, because the compactor sized
 * its protection floors from the model's USABLE budget (≈668k on a 1M window)
 * instead of the WORKING window (256k default). `forceMinHistory` came out at
 * ~334k, so a session with 196k tokens of history — already over its working
 * window — was refused as "too small to compact", every call, forever.
 *
 * The fix: `runSteppedCompaction` sizes `compactionBudgets` and its tail
 * selection from `workingWindowTokens`, while `usable` stays the reply-fit
 * backstop. This file reproduces the 1M-window / 256k-working-window shape and
 * pins the outcome: a history that fills the working window compacts, where the
 * old usable-derived floor refused.
 */

const llm = vi.hoisted(() => ({
  generateText: vi.fn(async () => ({
    text: "## Goal\n- investigate\n## Key facts\n- compacted",
    usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
  })),
}));
vi.mock("ai", () => ({ generateText: llm.generateText }));
vi.mock("@/main/settings", () => ({ readSettings: () => ({}) }));
vi.mock("@/lib/summarization_model", () => ({
  getCompactionSummarizationModel: async () => ({ provider: "t", name: "m" }),
  turnModelForChat: async () => ({ provider: "t", name: "m" }),
}));
vi.mock("@/ipc/utils/get_model_client", () => ({
  getModelClient: async () => ({ modelClient: { model: {} } }),
}));
vi.mock("@/ipc/handlers/workspace_session_handlers", () => ({
  resolveOrBindWorkspaceSessionForStream: async () => "resolved-session",
  persistWorkspaceSessionUserMessage: async () => {},
}));

import {
  runSteppedCompaction,
  countMessagesTokens,
} from "@/lib/context/compaction";
import {
  compactionBudgets,
  usableContextBudget,
} from "@/lib/context/mid-loop-threshold";

/**
 * A tool result the pruner/microcompact recognise, sized in TOKENS via realistic
 * prose (a long run of one character is a couple of BPE tokens however many bytes
 * it is — see compaction-small-window.test.ts).
 */
const toolResult = (label: string, tokens: number) => {
  const body = Array.from(
    { length: tokens },
    (_, i) => `line${i} const value${i} = compute(${i});`,
  ).join("\n");
  return `<atlarix-tool-result tool="read_file">${label}\n${body}</atlarix-tool-result>`;
};

// A 1M-window model with the default 256k working window.
const USABLE_1M = usableContextBudget({
  contextWindow: 1_048_576,
  maxOutputTokens: 32_000,
});
const WORKING = 256_000;

describe("0ac: compress_context compacts a session over its working window", () => {
  it(
    "history between the working-window and usable floors compacts instead of no-oping",
    { timeout: 30_000 },
    async () => {
      // Two tool-heavy turns sized so history clears forceMinHistory(WORKING)=128k
      // but sits well under forceMinHistory(USABLE_1M)≈508k — the exact band the
      // old usable-derived floor refused (0ac's "29% of usable" session).
      const msgs = [
        { id: 1, role: "user", content: "go" },
        { id: 2, role: "assistant", content: toolResult("a", 8_000) },
        { id: 3, role: "user", content: "more" },
        { id: 4, role: "assistant", content: toolResult("b", 8_000) },
      ];
      const before = countMessagesTokens(msgs);
      // The fixture really is the problem shape: over the working-window floor,
      // under the usable floor.
      expect(before).toBeGreaterThan(compactionBudgets(WORKING).forceMinHistory);
      expect(before).toBeLessThan(compactionBudgets(USABLE_1M).forceMinHistory);

      const out = await runSteppedCompaction(msgs, USABLE_1M, "test", {
        force: true,
        workingWindowTokens: WORKING,
        chatId: -42,
        workspaceSessionId: "s1",
      });

      expect(out.compactionApplied).toBe(true);
      expect(countMessagesTokens(out.modelContext)).toBeLessThan(before);
    },
  );
});
