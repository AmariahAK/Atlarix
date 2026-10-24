/**
 * The recall side call: which model, which purpose, what it is allowed to cost a
 * turn, and how its reply is read.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const generateText = vi.fn();
const getModelClient = vi.fn();
const recordAuxUsage = vi.fn();
const resolveTitleModel = vi.fn();

vi.mock("ai", () => ({ generateText: (...a: unknown[]) => generateText(...a) }));
vi.mock("@/main/settings", () => ({
  readSettings: () => ({ selectedModel: { provider: "compass", name: "auto" } }),
}));
vi.mock("@/ipc/utils/get_model_client", () => ({
  getModelClient: (...a: unknown[]) => getModelClient(...a),
}));
vi.mock("@/lib/session-title/generate-title", () => ({
  resolveTitleModel: (...a: unknown[]) => resolveTitleModel(...a),
}));
vi.mock("@/lib/routing/model-reasoning-profile", () => ({
  catalogSaysReasons: () => true,
}));
vi.mock("@/lib/usage/turn-usage-aggregator", () => ({
  recordAuxUsage: (...a: unknown[]) => recordAuxUsage(...a),
}));

import {
  RECALL_MAX_NOTES,
  buildRecallPrompt,
  parseRecallReply,
  selectRelevantMemories,
  type RecallCandidate,
} from "@/lib/memory/recall";

const candidates: RecallCandidate[] = Array.from({ length: 8 }, (_, i) => ({
  file: `n${i}.md`,
  description: `fact ${i}`,
  type: "project",
  ageDays: i,
}));

beforeEach(() => {
  generateText.mockReset();
  getModelClient.mockReset();
  recordAuxUsage.mockReset();
  resolveTitleModel.mockReset();
  resolveTitleModel.mockResolvedValue({ provider: "compass", name: "auto" });
  getModelClient.mockResolvedValue({ modelClient: { model: "m" }, fellBackToCore: false });
});

describe("parseRecallReply", () => {
  it("reads the {files} form", () => {
    expect(parseRecallReply('{"files": ["n1.md", "n3.md"]}', candidates)).toEqual(["n1.md", "n3.md"]);
  });

  it("tolerates a fence, prose and a bare array", () => {
    expect(parseRecallReply('Sure:\n```json\n{"files":["n2.md"]}\n```', candidates)).toEqual(["n2.md"]);
    expect(parseRecallReply('["n4.md"]', candidates)).toEqual(["n4.md"]);
  });

  it("keeps only real candidates, deduplicated, at most five", () => {
    const reply = JSON.stringify({
      files: ["x.md", "n0.md", "n0.md", "memory/n1.md", "n2.md", "n3.md", "n4.md", "n5.md", "n6.md"],
    });
    const out = parseRecallReply(reply, candidates);
    expect(out).toEqual(["n0.md", "n1.md", "n2.md", "n3.md", "n4.md"]);
    expect(out).toHaveLength(RECALL_MAX_NOTES);
  });

  it("never guesses from a reply it cannot parse", () => {
    expect(parseRecallReply("n1.md seems relevant", candidates)).toEqual([]);
    expect(parseRecallReply("{not json}", candidates)).toEqual([]);
    expect(parseRecallReply('{"files": "n1.md"}', candidates)).toEqual([]);
  });
});

describe("buildRecallPrompt", () => {
  it("shows descriptions, types and ages — never note bodies", () => {
    const p = buildRecallPrompt("deploy?", candidates.slice(0, 2));
    expect(p).toContain("Message:\ndeploy?");
    expect(p).toContain("- n1.md [project, written 1 day ago]: fact 1");
    expect(p).toContain("- n0.md [project, written today]: fact 0");
  });
});

describe("selectRelevantMemories", () => {
  it("asks as purpose=memory with reasoning off, one attempt and a timeout", async () => {
    generateText.mockResolvedValue({ text: '{"files":["n1.md"]}', usage: { totalTokens: 10 } });
    const out = await selectRelevantMemories({ message: "q", candidates, chatId: -5 });
    expect(out).toEqual(["n1.md"]);
    expect(getModelClient).toHaveBeenCalledWith(
      { provider: "compass", name: "auto" },
      expect.anything(),
      { purpose: "memory" },
    );
    const opts = generateText.mock.calls[0]![0] as Record<string, unknown>;
    expect(opts.reasoning).toBe("none");
    expect(opts.maxRetries).toBe(0);
    expect(opts.abortSignal).toBeInstanceOf(AbortSignal);
    // Charged like any other request: the usage is recorded against the chat.
    expect(recordAuxUsage).toHaveBeenCalledWith(-5, { totalTokens: 10 }, "memory");
  });

  it("uses the session's own model when it has one", async () => {
    generateText.mockResolvedValue({ text: "[]", usage: {} });
    const own = { provider: "anthropic", name: "claude-haiku" };
    await selectRelevantMemories({ message: "q", candidates, turnModel: own });
    expect(resolveTitleModel).toHaveBeenCalledWith(expect.anything(), own);
  });

  it("returns [] on a failure, without retrying", async () => {
    generateText.mockRejectedValue(new Error("timeout"));
    expect(await selectRelevantMemories({ message: "q", candidates })).toEqual([]);
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it("never sends a BYOK prompt to Core", async () => {
    resolveTitleModel.mockResolvedValue({ provider: "openai", name: "gpt-mini" });
    // No key for the provider: the model client refuses (it never moves to Core).
    getModelClient.mockRejectedValue(new Error("No key for OpenAI. Add one with /connect (Settings in the app), or pick another model."));
    expect(await selectRelevantMemories({ message: "q", candidates })).toEqual([]);
    expect(generateText).not.toHaveBeenCalled();
  });

  it("makes no call with nothing to choose from", async () => {
    expect(await selectRelevantMemories({ message: "q", candidates: [] })).toEqual([]);
    expect(await selectRelevantMemories({ message: "  ", candidates })).toEqual([]);
    expect(generateText).not.toHaveBeenCalled();
  });
});
