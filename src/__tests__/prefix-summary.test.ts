/**
 * A compaction summary written on the turn's own request, so it is read from
 * the prompt cache instead of paid again at full price (owner 2026-11-05;
 * opencode does this). Falls back to the normal summariser whenever it can't.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "ai";

const llm = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  reply: { text: "## Goal\n- ship it", toolCalls: [] as unknown[] } as { text: string; toolCalls: unknown[] } | Error,
}));
vi.mock("ai", async (orig) => ({
  ...(await orig<typeof import("ai")>()),
  generateText: vi.fn(async (opts: Record<string, unknown>) => {
    llm.calls.push(opts);
    if (llm.reply instanceof Error) throw llm.reply;
    return { ...llm.reply, usage: { inputTokens: 100, cachedInputTokens: 90, outputTokens: 10 } };
  }),
}));
vi.mock("@/main/settings", () => ({ readSettings: () => ({}) }));
vi.mock("@/lib/summarization_model", () => ({
  getCompactionSummarizationModel: async () => ({ provider: "test", name: "test-model" }),
  turnModelForChat: async () => ({ provider: "test", name: "test-model" }),
}));
vi.mock("@/ipc/utils/get_model_client", () => ({ getModelClient: async () => ({ modelClient: { model: {} } }) }));

import { PREFIX_SUMMARY_INSTRUCTION, summarizeOnTurnPrefix } from "@/lib/context/prefix-summary";
import { compactAgenticMessagesIfNeeded } from "@/lib/routing/tier_context_budget";

const turn: ModelMessage[] = [
  { role: "system", content: "HEADER" },
  { role: "user", content: "fix the build" },
  { role: "assistant", content: "reading files" },
];

beforeEach(() => {
  llm.calls.length = 0;
  llm.reply = { text: "## Goal\n- ship it", toolCalls: [] };
});

describe("summarizeOnTurnPrefix", () => {
  it("sends the turn's own messages, tools and options, with the instruction last", async () => {
    const execute = vi.fn();
    const out = await summarizeOnTurnPrefix({
      model: {} as never,
      messages: turn,
      tools: { read_file: { description: "Read", inputSchema: {}, execute } } as never,
      providerOptions: { anthropic: { thinking: { type: "enabled" } } },
      headers: { "anthropic-beta": "context-1m-2025-08-07" },
    });
    expect(out).toBe("## Goal\n- ship it");
    const sent = llm.calls[0]!;
    const msgs = sent.messages as ModelMessage[];
    // The cached prefix, untouched, then one instruction.
    expect(msgs.slice(0, 3)).toEqual(turn);
    expect(msgs.at(-1)).toEqual({ role: "user", content: PREFIX_SUMMARY_INSTRUCTION });
    expect(sent.providerOptions).toEqual({ anthropic: { thinking: { type: "enabled" } } });
    expect(sent.headers).toEqual({ "anthropic-beta": "context-1m-2025-08-07" });
    // Tools are there for the cache, but nothing can run.
    expect((sent.tools as Record<string, { execute?: unknown }>).read_file!.execute).toBeUndefined();
    expect(sent.toolChoice).toBeUndefined();
  });

  it("a reply that calls a tool, or fails, is no summary", async () => {
    llm.reply = { text: "", toolCalls: [{ toolName: "read_file" }] };
    expect(await summarizeOnTurnPrefix({ model: {} as never, messages: turn })).toBeNull();
    llm.reply = new Error("rate limited");
    expect(await summarizeOnTurnPrefix({ model: {} as never, messages: turn })).toBeNull();
  });
});

describe("the per-step compactor", () => {
  const big = (): ModelMessage[] => {
    const out: ModelMessage[] = [];
    for (let i = 0; i < 12; i++) {
      out.push({ role: "user", content: `ask ${i} ${"word ".repeat(400)}` });
      out.push({ role: "assistant", content: `reply ${i} ${"word ".repeat(400)}` });
    }
    return out;
  };

  it("uses the prefix summary when it returns one: the normal summariser is never called", async () => {
    const onPrefix = vi.fn(async () => "## Goal\n- from the prefix");
    const r = await compactAgenticMessagesIfNeeded({ messages: big(), systemPromptEstimate: 0, tierLimit: 2_000, summarizeOnPrefix: onPrefix });
    expect(r.compacted).toBe(true);
    expect(onPrefix).toHaveBeenCalledTimes(1);
    expect(llm.calls).toHaveLength(0);
    expect(JSON.stringify(r.messages)).toContain("from the prefix");
  });

  it("falls back to the normal summariser when the prefix summary returns nothing", async () => {
    const r = await compactAgenticMessagesIfNeeded({
      messages: big(),
      systemPromptEstimate: 0,
      tierLimit: 2_000,
      summarizeOnPrefix: async () => null,
    });
    expect(r.compacted).toBe(true);
    expect(llm.calls).toHaveLength(1);
    expect(JSON.stringify(r.messages)).toContain("ship it");
  });
});
