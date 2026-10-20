import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `/compact`, the overflow retry and `compress_context` measure a turn by its
 * TOOL HISTORY too, not only by its text.
 *
 * Seen 2 of 2 times (2026-10-20, Qwen3 Coder 30B and MiniMax M2.5 on Bedrock):
 * five turns with 30+ tool calls each, ~30k input tokens per request, and
 * `/compact` answered "the conversation is still short". The calls and their
 * results live in the assistant row's `modelContent` (the native-history
 * envelope); the forced compactions sized the history from `content` alone, so
 * the compactor's own floor turned them down. The overflow retry compacts the
 * same way, so after a provider's "context too long" it found nothing to do and
 * the turn failed.
 *
 * Drives the REAL compactor; only the provider call is faked.
 */

vi.mock("@/ipc/handlers/workspace_session_handlers", () => ({
  resolveOrBindWorkspaceSessionForStream: async () => "s-1",
  persistWorkspaceSessionUserMessage: async () => {},
}));

const llm = vi.hoisted(() => ({
  prompts: [] as string[],
  generateText: vi.fn(async (opts: { prompt?: string; messages?: Array<{ content: unknown }> }) => {
    llm.prompts.push(opts.prompt ?? JSON.stringify(opts.messages ?? ""));
    return {
      text: "Goal: fix the parser. Done: read src/parser.ts.",
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    };
  }),
}));
vi.mock("ai", () => ({ generateText: llm.generateText }));
vi.mock("@/main/settings", () => ({ readSettings: () => ({}) }));
vi.mock("@/lib/summarization_model", () => ({
  getCompactionSummarizationModel: async () => ({ provider: "test", name: "test-model" }),
  turnModelForChat: async () => ({ provider: "test", name: "test-model" }),
}));
vi.mock("@/ipc/utils/get_model_client", () => ({
  getModelClient: async () => ({ modelClient: { model: {} } }),
}));
vi.mock("@/lib/context/resolve-model-context-limit", () => ({
  resolveModelContextLimit: async () => ({ tierLimit: 200_000, rawContextLength: 200_000 }),
}));

import { createStreamTransport, getStreamTransport, hydrateStreamTransport } from "@/lib/chat/stream-transport";
import { serializeNativeHistory } from "@/lib/ai/native-history";
import { executeCompressContext, forceCompactEphemeralChat } from "@/lib/tools/workspace";

const TOOL_RESULT_CANARY = "PARSER_TOKEN_TABLE_CANARY";

/** One tool-heavy turn: short visible text, 30 read_file calls with big results. */
function toolTurnEnvelope(turn: number): string {
  const messages: unknown[] = [];
  for (let i = 0; i < 30; i++) {
    const id = `call-${turn}-${i}`;
    messages.push({
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: id, toolName: "read_file", input: { path: `src/f${i}.ts` } }],
    });
    messages.push({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: id,
          toolName: "read_file",
          output: { type: "text", value: `${turn === 0 && i === 0 ? TOOL_RESULT_CANARY : ""} ${"const x = 1;\n".repeat(120)}` },
        },
      ],
    });
  }
  messages.push({ role: "assistant", content: [{ type: "text", text: `Done with step ${turn}.` }] });
  return serializeNativeHistory(messages as never);
}

/** Five turns, the shape from the report: tiny `content`, the bulk in `modelContent`. */
function toolHeavySession() {
  const rows: Array<{ id: number; role: string; content: string; modelContent?: string }> = [];
  for (let t = 0; t < 5; t++) {
    rows.push({ id: t * 2 + 1, role: "user", content: `Step ${t}: keep going.` });
    rows.push({ id: t * 2 + 2, role: "assistant", content: `Done with step ${t}.`, modelContent: toolTurnEnvelope(t) });
  }
  return rows;
}

function transportWith(rows: ReturnType<typeof toolHeavySession>): number {
  const chatId = createStreamTransport(1);
  hydrateStreamTransport(chatId, rows);
  return chatId;
}

beforeEach(() => {
  llm.prompts.length = 0;
  llm.generateText.mockClear();
});

describe("a tool-heavy session is not 'still short'", () => {
  it("/compact summarises it, and tokensBefore counts the tool results", async () => {
    const chatId = transportWith(toolHeavySession());

    const done = await forceCompactEphemeralChat(chatId, "test", { workspaceSessionId: "s-1", summarize: true });

    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.strategy).toBe("summarized");
    // 150 read_file results of ~1.6k chars each: far more than the ~60 tokens of text.
    expect(done.tokensBefore).toBeGreaterThan(20_000);
    expect(done.tokensAfter).toBeLessThan(done.tokensBefore);
    // The summary was written from what the tools returned, not only the prose.
    expect(llm.prompts.join("\n")).toContain(TOOL_RESULT_CANARY);
  });

  it("the overflow retry compacts it (and so retries instead of failing the turn)", async () => {
    const chatId = transportWith(toolHeavySession());

    // finalize.ts's call: no summarize flag; `ok` is what reruns the turn.
    const done = await forceCompactEphemeralChat(chatId, "test", { workspaceSessionId: "s-1" });

    expect(done.ok).toBe(true);
  });

  it("turns kept after the summary still carry their native tool history", async () => {
    const chatId = transportWith(toolHeavySession());
    await forceCompactEphemeralChat(chatId, "test", { workspaceSessionId: "s-1", summarize: true });

    const kept = (getStreamTransport(chatId)!.messages as Array<{ id: number; role: string; modelContent?: string }>)
      .filter((m) => m.role === "assistant" && m.id > 0);
    expect(kept.length).toBeGreaterThan(0);
    for (const m of kept) expect(m.modelContent).toMatch(/^\{"v":1,"kind":"native-history"/);
  });

  it("compress_context is not a no-op on it, and keeps the kept turns' tool history", async () => {
    const rows = toolHeavySession();
    let next: Array<{ id: number; role: string; content: string; modelContent?: string | null }> = [];

    const out = await executeCompressContext(
      { reason: "test" },
      {
        chatId: -1,
        messages: rows,
        systemPromptTokens: 0,
        providerId: "test",
        workspaceSessionId: "s-1",
        setMessages: (m) => {
          next = m;
        },
      },
    );

    expect(out.status).toBe("completed");
    expect(out.tokensBefore).toBeGreaterThan(20_000);
    expect(out.tokensAfter).toBeLessThan(out.tokensBefore);
    const answers = next.filter((m) => m.role === "assistant" && m.id > 0);
    // Every turn keeps its own answer. The newest keep their tool calls too; an
    // older one whose tool output was pruned is its text alone.
    expect(answers.map((m) => m.content)).toEqual([0, 1, 2, 3, 4].map((t) => `Done with step ${t}.`));
    expect(answers.at(-1)!.modelContent).toMatch(/^\{"v":1,"kind":"native-history"/);
  });
});
