/**
 * The recall side call: which model, which purpose, what it is allowed to cost a
 * turn, and how its reply is read.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
  WEIGHTS_FILE,
  applyDecay,
  buildRecallPrompt,
  bumpWeights,
  decayWeight,
  localRecallMatch,
  parseRecallReply,
  readWeights,
  selectRelevantMemories,
  type MemoryWeights,
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

describe("localRecallMatch", () => {
  const notes: RecallCandidate[] = [
    { file: "deploy-runbook.md", description: "how to deploy the app to Railway", ageDays: 2, type: "project" },
    { file: "git-commit-identity.md", description: "author name and email for commits", ageDays: 5, type: "project" },
    { file: "video-owner-preferences.md", description: "owner's rules for making videos", ageDays: 9, type: "feedback" },
  ];

  it("matches the message's words against names and descriptions", () => {
    expect(localRecallMatch("how do I deploy to Railway?", notes)).toEqual(["deploy-runbook.md"]);
    expect(localRecallMatch("what identity should commits use", notes)).toEqual(["git-commit-identity.md"]);
  });

  it("scores a name hit above a description-only hit", () => {
    const out = localRecallMatch("deploy", [
      { file: "deploy-runbook.md", description: "misc", ageDays: 1 },
      { file: "other.md", description: "deploy stuff", ageDays: 1 },
    ]);
    expect(out[0]).toBe("deploy-runbook.md");
  });

  it("returns [] when nothing matches or the message is empty", () => {
    expect(localRecallMatch("completely unrelated topic", notes)).toEqual([]);
    expect(localRecallMatch("", notes)).toEqual([]);
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

  it("answers a word-overlap message locally, never calling the model", async () => {
    generateText.mockRejectedValue(new Error("must not be called"));
    const notes: RecallCandidate[] = [
      { file: "deploy-runbook.md", description: "how to deploy to Railway", ageDays: 1, type: "project" },
      { file: "git-commit-identity.md", description: "author name and email for commits", ageDays: 5, type: "project" },
    ];
    expect(await selectRelevantMemories({ message: "how do I deploy to Railway?", candidates: notes }))
      .toEqual(["deploy-runbook.md"]);
    expect(generateText).not.toHaveBeenCalled();
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

  it("uses the model only when the local scorer has no word overlap", async () => {
    const notes: RecallCandidate[] = [
      { file: "alpha.md", description: "bravo charlie", ageDays: 1, type: "project" },
    ];
    // "zulu yankee" shares no token with the note, so the model is asked.
    generateText.mockResolvedValue({ text: '{"files":["alpha.md"]}', usage: { totalTokens: 5 } });
    expect(await selectRelevantMemories({ message: "zulu yankee", candidates: notes })).toEqual(["alpha.md"]);
    expect(generateText).toHaveBeenCalledTimes(1);
  });
});

describe("local-first recall and learned weights", () => {
  it("bumps recalled notes in weights.json and reads them back", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "recall-weights-"));
    try {
      const notes: RecallCandidate[] = [
        { file: "deploy-runbook.md", description: "how to deploy to Railway", ageDays: 1, type: "project" },
        { file: "git-commit-identity.md", description: "author name and email for commits", ageDays: 5, type: "project" },
      ];
      await selectRelevantMemories({ message: "how do I deploy to Railway?", candidates: notes, memoryDir: dir });
      expect(generateText).not.toHaveBeenCalled();
      const raw = JSON.parse(await fs.readFile(path.join(dir, WEIGHTS_FILE), "utf8")) as MemoryWeights;
      expect(raw["deploy-runbook.md"]?.w).toBeGreaterThan(1);
      expect(raw["git-commit-identity.md"]).toBeUndefined();
      expect(await readWeights(dir)).toHaveProperty("deploy-runbook.md");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("decays a weight back toward neutral and drops it at 1", () => {
    expect(decayWeight(2, 0)).toBe(2);
    // One halflife halves the distance to neutral: 1 + (2-1)*0.5 = 1.5.
    expect(decayWeight(2, 14)).toBeCloseTo(1.5, 5);
    const now = 1_700_000_000_000;
    const day = 86_400_000;
    const weights: MemoryWeights = { "a.md": { w: 1.02, lastUsedAt: now - 14 * 4 * day } };
    expect(applyDecay(weights, now)).toEqual({});
  });

  it("caps a weight so a hot note cannot crowd out everything", () => {
    let w: MemoryWeights = {};
    const now = 1_700_000_000_000;
    for (let i = 0; i < 20; i++) w = bumpWeights(w, ["a.md"], now);
    expect(w["a.md"]!.w).toBeLessThanOrEqual(4);
  });

  it("a learned weight flips a tie in the local ranking", () => {
    const notes: RecallCandidate[] = [
      { file: "a.md", description: "deploy", ageDays: 1 },
      { file: "b.md", description: "deploy", ageDays: 1 },
    ];
    // No weights: equal scores break to the first name alphabetically.
    expect(localRecallMatch("deploy", notes)[0]).toBe("a.md");
    // A learned preference for b flips the ranking.
    expect(localRecallMatch("deploy", notes, { "b.md": { w: 2, lastUsedAt: 1 } })[0]).toBe("b.md");
  });
});
