import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";

/**
 * W10 (2026-11-07, ai-a1 recording on 15.13.3): every sub-agent stopped after
 * ONE tool call and reported "completed" — one read, ~3k tokens, no proposal —
 * and the main agent redid the work itself. The AI SDK's default `stopWhen` is
 * `stepCountIs(1)`; 0j (8c1690a9) deleted the sub-agent's own `stopWhen`, so the
 * default applied. A sub-agent must keep going until the model stops calling
 * tools, like the main turn.
 */

const execute = vi.fn(async (name: string, args: Record<string, unknown>) =>
  name === "edit_file"
    ? // What edit_file returns with no approval interceptor: a preview to record.
      {
        __permission_required: true,
        operation: "edit_file",
        preview: {
          path: String(args.path),
          content: String(args.content),
          oldContent: "old\n",
          type: "update",
        },
      }
    : { success: true, content: `contents of ${String(args.path)}` },
);

vi.mock("@/lib/analytics/turn-stats", () => ({ noteTurn: vi.fn() }));
vi.mock("@/main/settings", () => ({ readSettings: () => ({}) }));
vi.mock("@/ipc/handlers/chat_stream/stream-state", () => ({
  lastStreamRequest: new Map(),
}));
vi.mock("@/lib/skills/skill-loader", () => ({
  loadSkill: async () => "You are a scout.",
}));
vi.mock("@/lib/usage/turn-usage-aggregator", () => ({
  recordAuxUsage: () => 0,
}));
vi.mock("@/lib/context/resolve-model-context-limit", () => ({
  GENERIC_CONTEXT_FALLBACK: 100_000,
  resolveModelContextLimit: async () => ({
    tierLimit: 100_000,
    rawContextLength: 128_000,
  }),
}));
vi.mock("@/lib/routing/tier_context_budget", () => ({
  compactAgenticMessagesIfNeeded: async ({
    nativeMessages,
  }: {
    nativeMessages: unknown[];
  }) => ({
    compacted: false,
    beforeTokens: 0,
    afterTokens: 0,
    messages: nativeMessages,
  }),
}));
vi.mock("@/lib/context/mid_loop_compaction", () => ({
  runMidLoopCompaction: async ({ messages }: { messages: unknown[] }) => ({
    compacted: false,
    messages,
  }),
}));
vi.mock("@/lib/tools/workspace-file-hints", () => ({
  SMALL_REPO_FILE_THRESHOLD: 200,
  getWorkspaceRelFilePaths: async () => ({ paths: [], count: 0 }),
  formatSmallRepoInventory: () => "",
}));
vi.mock("@/lib/tools/registry", () => ({
  ToolRegistry: {
    getAll: () => [
      {
        name: "read_file",
        description: "Read a file.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
      {
        name: "edit_file",
        description: "Edit a file.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
          required: ["path", "content"],
        },
      },
    ],
    execute: (name: string, args: Record<string, unknown>) =>
      execute(name, args),
  },
}));

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};
/** One scripted model step: what doStream returns. */
type Step = { stream: ReadableStream<LanguageModelV4StreamPart> };
const toolStep = (id: string, path: string): Step => ({
  stream: convertArrayToReadableStream<LanguageModelV4StreamPart>([
    { type: "stream-start", warnings: [] },
    {
      type: "tool-call",
      toolCallId: id,
      toolName: "read_file",
      input: JSON.stringify({ path }),
    },
    {
      type: "finish",
      finishReason: { unified: "tool-calls", raw: "tool_calls" },
      usage,
    },
  ]),
});
const textStep = (text: string): Step => ({
  stream: convertArrayToReadableStream<LanguageModelV4StreamPart>([
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
  ]),
});

let steps: Step[] = [];
const model = new MockLanguageModelV4({
  doStream: async () => {
    const next = steps.shift();
    if (!next)
      throw new Error(
        "the model was asked for more steps than the test scripted",
      );
    return next as never;
  },
});

vi.mock("@/ipc/utils/get_model_client", () => ({
  getEffectiveModel: () => ({ provider: "test", name: "test-model" }),
  getModelClient: async () => ({
    modelClient: { model, builtinProviderId: "test" },
  }),
}));

describe("a sub-agent works until the model stops calling tools (W10)", () => {
  beforeEach(() => {
    execute.mockClear();
  });

  it("two reads, then the answer: both reads run and the answer is the summary", async () => {
    steps = [
      toolStep("c1", "package.json"),
      toolStep("c2", "README.md"),
      textStep("Both files read."),
    ];
    const { runSubagent } = await import("@/lib/agents/run-subagent");
    const result = await runSubagent({
      prompt: "Read package.json and README.md",
      workspace: "",
    });
    expect(result.success).toBe(true);
    expect(execute.mock.calls.map(([, a]) => a.path)).toEqual([
      "package.json",
      "README.md",
    ]);
    expect(result.stepsUsed).toBe(3);
    expect(result.summary).toContain("Both files read.");
    expect(steps).toEqual([]);
  });

  it("a writer reads, then edits: the edit comes back as a proposal", async () => {
    const { createProposalSet, getProposalSet, __clearAllProposalSets } =
      await import("@/lib/agents/subagent-proposals");
    __clearAllProposalSets();
    const ws = path.resolve("/tmp/atlarix-w10-ws");
    const setId = createProposalSet({
      chatId: 1,
      taskId: "t1",
      agentName: "writer",
      workspace: ws,
    });
    steps = [
      toolStep("c1", "README.md"),
      {
        stream: convertArrayToReadableStream<LanguageModelV4StreamPart>([
          { type: "stream-start", warnings: [] },
          {
            type: "tool-call",
            toolCallId: "c2",
            toolName: "edit_file",
            input: JSON.stringify({ path: "README.md", content: "new\n" }),
          },
          {
            type: "finish",
            finishReason: { unified: "tool-calls", raw: "tool_calls" },
            usage,
          },
        ]),
      },
      textStep("README updated."),
    ];
    const { runSubagent } = await import("@/lib/agents/run-subagent");
    const result = await runSubagent({
      prompt: "Update the README",
      workspace: ws,
      mode: "implement",
      proposalSetId: setId,
    });
    expect(result.success).toBe(true);
    expect(execute.mock.calls.map(([n]) => n)).toEqual([
      "read_file",
      "edit_file",
    ]);
    expect(
      [...(getProposalSet(setId)?.files.keys() ?? [])].map((k) =>
        path.basename(String(k)),
      ),
    ).toEqual(["README.md"]);
    expect(result.summary).toContain("README updated.");
  });
});
